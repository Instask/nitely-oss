# Spec Plan Task Analysis Gate Tech Design

## Goal

Fail fast on inconsistent spec/plan/task artifacts before an implementation agent starts consuming prompt context.

## Design

### Schema

Add `gate.mode = "analysis"` with:

- `inputs`: spec, tech-design, tasks, and optional extra artifacts.
- `outputs`: one report artifact.
- `blocking?: boolean`, default `true`.

Analysis gates do not accept command, runtime, skills, MCP servers, connector requirements, `maxInputTokens`, or `maxToolOutputTokens`.

### Analyzer

Add `src/analysis/spec-plan-task.ts`.

The analyzer is deterministic and read-only. It consumes named text artifacts and optional constitution text. It emits:

- `findings[]`: severity, code, message, artifact IDs, related IDs.
- `summary`: critical/warning/info counts.
- Markdown report for evidence and PR bodies.

Initial checks are intentionally conservative:

- FR/SC coverage by task text or out-of-scope note.
- Task artifact parser diagnostics.
- Task-to-requirement/story/decision/maintenance mapping.
- Placeholder detection.
- Dependency ordering.
- Constitution “must not …” conflicts.
- Verification task coverage for SC IDs.

### RunFlow

Extend `executeGateStage()`:

- deterministic gates keep command behavior.
- review gates keep agent-review behavior.
- analysis gates call the analyzer, write `analysis-report.md`, record it as a gate artifact, append `gate.completed`, and return pass/fail.

Blocking gates fail on critical findings. Advisory gates always pass but record the same report and finding counts.

### Evidence

Existing `writeEvidence()` already lists gate results and gate result artifacts. The analysis gate report path is attached through `reviewOutput` so evidence can point to the report.

## Rollback

Revert the PR. Existing flows are unaffected because analysis gates are opt-in.
