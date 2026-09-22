# GitHub Connector Tech Design

Issue: https://github.com/Instask/nitely/issues/8

## Design

Introduce an SCM provider boundary for publishing generated changes. The first
provider is GitHub.

Suggested modules:

- `src/scm/types.ts`
- `src/scm/github.ts`
- `src/scm/registry.ts`

Core types:

```ts
export interface PublishChangeRequest {
  repoPath: string;
  worktreePath: string;
  remoteName: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
}

export interface ChangeRequest {
  provider: "github";
  url: string;
  number: number;
  owner: string;
  repository: string;
  baseBranch: string;
  headBranch: string;
  draft: boolean;
}

export interface ScmProvider {
  readonly type: string;
  publishChange(input: PublishChangeRequest): Promise<ChangeRequest>;
}
```

## GitHub Provider

The provider should:

1. Resolve `owner/repo` from `git remote get-url origin`.
2. Push the branch with `git push -u origin <headBranch>`.
3. Call GitHub's REST API to create a draft pull request:
   - `POST /repos/{owner}/{repo}/pulls`
   - body: `title`, `head`, `base`, `body`, `draft: true`
4. Normalize the response into `ChangeRequest`.

Credential lookup:

```ts
process.env.NITELY_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN
```

If no token is configured, fail with:

```text
Missing GitHub token. Set NITELY_GITHUB_TOKEN or configure a GitHub provider connection.
```

## runFlow Changes

Replace direct `gh pr create` usage in `defaultPublishChange` with the SCM
provider. Keep dependency injection for tests:

```ts
publishChange?: (input: PublishChangeInput) => Promise<PublishChangeResult>
scmProvider?: ScmProvider
```

The publish stage should still write evidence before publishing and should
persist the returned metadata in the publish result.

## Testing

Add tests for:

- Git remote URL parsing for SSH and HTTPS remotes.
- Missing token error.
- GitHub create-PR request body and headers using a stubbed `fetch`.
- `publish-change` uses the provider abstraction rather than shelling out to
  `gh`.
- Legacy `gh` fallback only works when explicitly selected.

## Verification

Run:

```bash
pnpm exec vitest run test/scm test/run test/cli.test.ts
pnpm exec vitest run
pnpm run check
pnpm run build
```
