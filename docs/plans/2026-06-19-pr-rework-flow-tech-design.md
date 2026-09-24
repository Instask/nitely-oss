# PR Rework Flow Technical Design

## Summary

Introduce a rework execution path that starts from an existing GitHub PR head
branch and updates that same branch at the end of the run. Keep the existing
new-PR bootstrap flow intact.

## Proposed Design

### SCM Provider

Extend the SCM abstraction with GitHub PR target operations:

- `resolveChangeRequestTarget(input)`:
  - accepts PR URL or number,
  - returns owner, repository, number, URL, base branch, head branch, head SHA,
    head repository, and fork/cross-repo status.
- `checkoutChangeRequest(input)`:
  - fetches the PR head branch,
  - creates the run worktree from that branch,
  - returns the previous head SHA.
- `updateChangeRequest(input)`:
  - commits pending changes when needed,
  - pushes to the existing head branch,
  - returns the same PR URL/number plus updated head SHA.

For the first version, fail closed when `headRepository` differs from the
configured repository. Do not push to forks.

### Run Input

Add an optional rework target to run input, for example:

```ts
interface RunFlowInput {
  flowPath: string;
  repoPath: string;
  inputs: Record<string, ResourceReference>;
  changeRequestTarget?: {
    provider: "github" | "github-cli";
    target: string;
  };
}
```

When `changeRequestTarget` is present:

- resolve it before creating the worktree,
- use the target head branch as the run branch,
- write target metadata into `run.created`,
- create the worktree from the PR head instead of current `HEAD`.

### Stage Model

Prefer adding an `update-change` stage type over overloading `publish-change`.

```json
{
  "id": "update",
  "type": "update-change",
  "provider": "github-cli",
  "inputs": ["implementation", "test-report", "review"],
  "outputs": ["change-request"]
}
```

`publish-change` continues to create new PRs. `update-change` requires a resolved
`changeRequestTarget` and fails clearly if a run does not have one.

### CLI

Add a command shaped like:

```bash
node dist/index.js rework-pr <pr-url-or-number> \
  --repo . \
  --flow flows/rework-pr-bootstrap.json \
  --input spec=specs/issues/022-pr-rework-flow-spec.md \
  --input tech-design=docs/plans/2026-06-19-pr-rework-flow-tech-design.md
```

The command should reuse existing `--input name=path` parsing and call
`runFlow()` with `changeRequestTarget`.

### Bootstrap Flow

Add `flows/rework-pr-bootstrap.json`:

1. `implement`: agent stage consuming `spec` and `tech-design`.
2. `test`: command stage running the full verification command.
3. `review`: agent stage reviewing the updated PR branch.
4. `update`: `update-change` stage pushing to the existing PR.

Set `spec.maxAttempts` to `2`, matching the implement-spec bootstrap flow.

### Evidence and Events

Extend run evidence with a `Change Request Target` section:

- provider,
- PR URL and number,
- base branch,
- head branch,
- previous head SHA,
- updated head SHA.

Add or reuse events so projections can show rework metadata:

- `change.target.resolved`,
- `change.updated`.

The event payloads should be structured and should not require parsing evidence
Markdown.

## Tests

Add focused unit tests for:

- PR URL and number parsing in the GitHub provider.
- Same-repository target acceptance and fork target rejection.
- `runFlow` creating a worktree from a resolved PR target.
- `update-change` pushing to the existing branch and returning the existing PR.
- Evidence containing target PR metadata and old/new SHAs.
- Existing `publish-change` tests continuing to create a new PR.

Use injected SCM providers in unit tests to avoid network calls.

## Rollout

1. Implement provider target/update operations behind the existing GitHub provider
   boundary.
2. Add run input and `update-change` stage schema.
3. Add CLI command and bootstrap flow.
4. Add evidence/events.
5. Document the new rework command in both READMEs.

