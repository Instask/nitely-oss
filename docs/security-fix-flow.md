# Security Fix Flow

`flows/security-fix-pr.json` is a bounded security-fix workflow for findings
that Nitely can classify before any agent edits code.

## Supported Classes

The initial deterministic classifier supports:

- `path-traversal`
- `command-injection`
- `xss`
- `secret-exposure`
- `weak-credential-handling`
- `unsafe-temp-file`

Unsupported findings fail at the `triage` gate before the fix agent runs. The
run records a `security-assessment` gate artifact with the unsupported reason so
the operator can triage manually or add a new supported class.

## Inputs

- `finding`: GitHub issue text, static-analysis output, or Web Console task
  content describing the security finding.
- `repo-notes`: repository-specific test commands, affected modules, branch
  policy, or reviewer constraints.

## Stages

1. `triage`: deterministic `mode: "security"` gate classifies the finding,
   extracts affected file paths, and writes `security-assessment`.
2. `fix`: agent applies the minimal supported fix and writes `implementation`
   plus `pr-title`.
3. `verify`: runs `pnpm exec vitest run && pnpm run check`.
4. `review`: review gate checks supported class, scope, tests/evidence, and
   security regressions.
5. `publish`: creates a draft PR through `github-cli`.
6. `reflect`: finalizer records assumptions, unsupported classes, follow-ups, or
   clean result.

## Evidence

Run evidence includes the security gate result under `## Gates`, with a
Markdown review output containing:

- validation result;
- supported class;
- confidence;
- affected files;
- unsupported reason when applicable;
- assumptions.

Generated PR evidence includes the same gate artifact, verification report,
review output, and implementation summary.

## Example

```bash
node dist/index.js run flows/security-fix-pr.json \
  --repo . \
  --input finding=security/finding.md \
  --input repo-notes=docs/examples/sample-repo-notes.md
```
