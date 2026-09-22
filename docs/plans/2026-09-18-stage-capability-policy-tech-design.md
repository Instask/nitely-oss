# Stage capability policy technical design

## Scope

Issue #473 uses the capability policy already present in the flow schema and
run evidence. This change makes the bootstrap contracts explicit and maps the
existing broad write field to local runtime controls. OCI enforcement stays in
the linked follow-up issue.

## Design

1. Add explicit policies to all checked-in spec-driven bootstrap flows and the
   plan/implement editor template.
2. Use `write.scope: "none"` plus `commands.mode: "none"` for stages that only
   inspect inputs or produce artifacts; allow `test/` for `write-tests`; allow
   `worktree` for `implement`.
3. In the local backend, derive Codex's sandbox mode from an explicit stage
   policy, never loosening a stricter run-level sandbox. Use Claude's existing
   permission-mode mapping. Reject required read-only stages on runtimes with
   no local enforcement mechanism.
4. Keep path allowlists and advisory controls visible in evidence; #482 owns
   strict OCI path and mount enforcement.

## Verification

- Flow loader tests cover explicit declarations in every bootstrap variant.
- Local execution tests cover Codex mapping and fail-closed behavior.
- Run targeted flow/execution tests, typecheck, and diff validation.
