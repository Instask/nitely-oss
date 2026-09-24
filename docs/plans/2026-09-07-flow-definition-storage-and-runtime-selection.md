# Flow definition storage and runtime selection

Status: proposal, not scheduled. Recorded 2026-09-07 while adding
`flows/implement-spec-bootstrap-claude.json`.

Adding a Claude variant of the implement-spec bootstrap flow surfaced two
structural problems. Neither blocked that change, so the variant landed as a
fourth JSON file. Both problems make the next variant worse, so they are
written down here.

## Problem A: a flow definition has three homes

| Source | Location | Writable | Consumers |
| --- | --- | --- | --- |
| `builtin` | 17 files under `flows/*.json` | No — the console reports `editable: false` | CLI `nitely run flows/<name>.json`; the console lists them read-only |
| `template` | A hardcoded array in `src/flows/templates.ts`, each entry carrying an inline JSON document literal | No — changing one means changing TypeScript | The console's "create flow from template" path, which copies the document into the database |
| `user` | The SQLite `flows` table, `src/flows/store.ts` | Yes — owner/organization scoped, carries template lineage | Console-authored flows and work-item runs |

Only the third is a record. The first two are code.

`src/flows/paths.ts` already calls the first one legacy: `resolveRepositoryFlowPath`
is documented as resolving "a legacy repository-backed Flow".

### The duplication has already drifted

Eight template definitions declare a `flowPath` pointing at a `flows/*.json`
file. That field is a lineage label only — nothing reconciles the two documents.
Comparing stage id, stage type, runtime, and provider across the pair, three of
the eight have diverged structurally:

- `plan-approve-implement` → `flows/plan-approve-implement-bootstrap.json`:
  the file has `review` and `reflect` stages the template lacks.
- `dev-pr` → `flows/implement-spec-bootstrap.json`: the file has `review` and
  `reflect`; the template publishes through provider `github` while the file
  uses `github-cli`. The template's `test` stage runs `pnpm exec vitest run`,
  the file runs `pnpm exec vitest run && pnpm run check && pnpm run build`.
- `rework-pr` → `flows/rework-pr-bootstrap.json`: the stage ids do not even
  match (`rework` versus `implement`), and the file adds `test`, `review`, and
  `reflect`.

The remaining five (`converge-feature-artifacts`, `pilot-approved-spec-pr`,
`pilot-issue-to-production`, `pilot-bug-ticket-fix-pr`, `pilot-pr-review-rework`)
still agree. There is no test holding them there.

### Direction

Collapse `builtin` and `template` into seeded database records: ship the
canonical documents in the repository for version control and audit, seed them
into the `flows` table on first start, and serve every consumer from the store.
Repository files become the seed source, not a parallel runtime source.

Open questions:

- Reseeding semantics when a shipped document changes and an operator has
  edited the seeded record.
- Whether the CLI keeps accepting a file path, and whether that path stays a
  first-class entry point or becomes an import.
- Whether a test should pin template/file agreement in the interim, or whether
  that is wasted work if the merge happens.

## Problem B: runtime is baked into the flow document

`runtime` is a plain string on each agent and review-gate stage
(`src/flow/schema.ts`). That is the only reason the variant family exists:
`implement-spec-bootstrap`, `-grok`, `-pi`, and now `-claude` are near-identical
documents differing in the `runtime` value and in the product name inside each
prompt.

The existing `configurables` mechanism cannot express this. Configurable values
are substituted into prompt text only — `applyFlowConfigurationTemplate` has a
single call site, `src/run/run-flow.ts:6372`, which renders `stage.prompt`. No
other stage field participates.

So moving flows into the database (Problem A) does not fix this on its own. It
converts "copy a file per runtime" into "copy a row per runtime". The drift is
the same drift.

### Direction

Let the runtime be chosen when a run starts rather than when a flow is authored:
either extend configurables to cover stage `runtime`, or add an explicit
run-level override on the CLI and in the console. The flow document then
declares a default, and `-grok`, `-pi`, and `-claude` can be deleted.

Open questions:

- Whether the override is flow-wide or per stage. Mixed-runtime flows are
  plausible — a cheap runtime for `write-tests`, a stronger one for `review`.
- How this interacts with the existing `runtimes` candidate list on a stage,
  which today expresses fallback rather than operator choice.
- Whether prompts that name the runtime ("with Grok Build") should be
  templated, rewritten to be runtime-neutral, or left alone.
- Whether an override must be rejected when the target runtime's provider
  credentials are missing, or whether preflight already covers it
  (`src/run/preflight.ts`).

## Sequencing

B first. It is the smaller change, it directly removes the reason variants get
copied, and it shrinks the surface A has to migrate. A is the larger cleanup and
should not block it.
