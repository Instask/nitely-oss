# Rich PR Evidence Reports Tech Design

Issue: https://github.com/Instask/nitely/issues/6

## Design

Extract evidence generation from `src/run/run-flow.ts` into
`src/run/evidence.ts`.

```ts
interface EvidenceInput {
  runId: string;
  flowName: string;
  repoPath: string;
  worktreePath: string;
  baseBranch: string;
  branchName: string;
  inputs: InputArtifactSummary[];
  stages: StageEvidence[];
}
```

Use Git commands without a shell:

- `git diff --stat <base>...HEAD`
- `git diff --name-status <base>...HEAD`
- `git log --oneline <base>..HEAD`

Keep evidence Markdown deterministic so tests can snapshot meaningful sections.

## Integration

`publish-change` should call `writeEvidence` before `gh pr create` and pass the
file through `--body-file`.

## Verification

Run:

```bash
pnpm exec vitest run test/run/evidence.test.ts test/run/run-flow.test.ts
pnpm exec vitest run
pnpm run check
pnpm run build
```

