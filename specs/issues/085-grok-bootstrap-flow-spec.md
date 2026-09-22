# Issue 85: Grok Bootstrap Flow

## Objective

Add a first-class Grok Build bootstrap flow so Nitely can dogfood implementation
and review work with `runtime: "grok"`.

## Problem

Nitely's local execution backend and provider status layer support Grok Build,
but the checked-in bootstrap flows only include Codex and GLM variants. A user
who wants to submit a spec to Nitely and have Grok implement it must hand-edit a
flow file or create a local copy, which makes the Grok path less discoverable
and less consistently validated.

## User-Visible Behavior

- Users can run `flows/implement-spec-bootstrap-grok.json` with the same `spec`
  and `tech-design` inputs as the standard implementation bootstrap flow.
- The `implement` and `review` stages use the Grok Build runtime.
- The flow leaves the Grok model unset so the local `grok` CLI default remains
  authoritative unless a later issue pins a supported model.
- README usage notes identify the Grok bootstrap variant and its local
  authentication requirement.

## In Scope

- Add the Grok implementation bootstrap flow.
- Add validation coverage that loads the Grok flow and checks agent runtime
  metadata.
- Document the run command and local Grok CLI requirement.
- Keep the existing Codex and GLM flows compatible.

## Out of Scope

- Installing or authenticating the Grok Build CLI.
- Adding hosted Grok credentials or API-key management.
- Adding Grok variants for every specialized bootstrap flow.
- Changing runtime dispatch semantics.

## Acceptance Checks

1. `node dist/index.js validate flows/implement-spec-bootstrap-grok.json --external-input spec --external-input tech-design` succeeds after build.
2. Flow loader tests verify that `flows/implement-spec-bootstrap-grok.json` loads and that all agent stages declare `runtime: "grok"`.
3. The README explains how to select the Grok bootstrap flow.
4. Existing flow loader tests continue to pass.
5. A real Grok run fails clearly when the local `grok` CLI is missing or not authenticated.

## Edge Cases

- If `grok` is absent from `PATH`, the runtime should fail with the existing
  actionable command-not-found error.
- If a user wants a specific Grok model, they can add a `model` field locally
  without changing the schema.
- The flow must preserve the normal `publish-change` behavior and should not
  bypass existing tests.

## Likely Files

- `flows/implement-spec-bootstrap-grok.json`
- `test/flow/load.test.ts`
- `README.md`
- `README.zh-CN.md`
