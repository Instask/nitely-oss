# Technical Design: Grok Bootstrap Flow

## Goal

Add a checked-in implementation bootstrap flow that routes both agent stages to
Grok Build while preserving the existing `spec` and `tech-design` contract.

## Design

Create `flows/implement-spec-bootstrap-grok.json` by following the existing
`implement-spec-bootstrap.json` shape:

- `metadata.name`: `implement-spec-bootstrap-grok`
- `spec.maxAttempts`: `2`
- `implement`: `agent`, `runtime: "grok"`, inputs `spec` and `tech-design`,
  output `implementation`
- `test`: same verification command as the default bootstrap flow
- `review`: `agent`, `runtime: "grok"`, inputs `spec`, `tech-design`,
  `implementation`, and `test-report`, output `review`
- `publish`: existing GitHub CLI publish stage

Do not set a `model` field in the first Grok flow. The local Grok Build CLI owns
the default model choice, and pinning a model should happen only after a
separate compatibility decision.

## Tests

Extend `test/flow/load.test.ts` with a runtime-variant bootstrap test:

- load `flows/implement-spec-bootstrap-grok.json` with `spec` and
  `tech-design` as external inputs;
- assert all agent stages use `runtime: "grok"`;
- assert non-agent stages do not carry runtime/model fields;
- keep GLM variant validation in the same test so runtime-specific bootstrap
  flows have one regression check.

## Documentation

Add a short README note after the standard bootstrap run command showing how to
use the Grok variant:

```bash
node dist/index.js run flows/implement-spec-bootstrap-grok.json \
  --repo . \
  --input spec=specs/issues/085-grok-bootstrap-flow-spec.md \
  --input tech-design=docs/plans/2026-08-02-grok-bootstrap-flow-tech-design.md
```

Mention that a real run requires `grok login` or `XAI_API_KEY`, matching the
existing runtime configuration section.

## Verification

Run:

```bash
pnpm exec vitest run test/flow/load.test.ts
pnpm run build
node dist/index.js validate flows/implement-spec-bootstrap-grok.json \
  --external-input spec \
  --external-input tech-design
```

Do not attempt a real Grok execution unless the local `grok` CLI is installed
and authenticated.
