# Issue 102: Nitely Project Constitution

## Background / Problem

Nitely already relies on implicit execution principles: source code and secrets stay in the customer's environment, runs are durable, evidence is reviewable, failures are explicit, and human approval gates are not silently bypassed. These principles should be a first-class repo-scoped artifact that future spec, plan, task, analysis, and implementation stages can reference consistently.

## Goal

Add an optional repo-scoped constitution artifact that Nitely can load during runs, inject into agent/review prompts, and record in run evidence.

## User Stories

- **US-001:** As an operator, I can add `.nitely/constitution.md` to a repository so Nitely agents see non-negotiable project principles during execution.
- **US-002:** As a reviewer, I can inspect run evidence and see whether a constitution was loaded, where it came from, and which content hash was used.
- **US-003:** As an existing user, my current flows keep working when no constitution file exists.

## Functional Requirements

- **FR-001:** Nitely must look for a Markdown constitution at `.nitely/constitution.md` under the run repository.
- **FR-002:** The constitution must be optional. Missing files must not fail a run.
- **FR-003:** When present, Nitely must inject the constitution into agent-stage and review-gate prompts as a dedicated governing-principles section.
- **FR-004:** The injected content must be redacted through the existing runtime redaction path before it is written to `prompt.md` or sent to an agent.
- **FR-005:** Run evidence must record whether a constitution was loaded.
- **FR-006:** When loaded, evidence must include the constitution repo-relative path and a deterministic content hash.
- **FR-007:** Nitely must provide a starter constitution template for this repository.
- **FR-008:** The loader must be reusable by future analysis/plan validation work without depending on Web Console code.

## Success Criteria

- **SC-001:** A run with `.nitely/constitution.md` includes `## Governing Principles` in the agent prompt.
- **SC-002:** A run without `.nitely/constitution.md` produces no governing-principles prompt section and still completes.
- **SC-003:** Evidence for a constitution-backed run contains the path `.nitely/constitution.md` and a `sha256:` hash.
- **SC-004:** Existing run-flow tests continue to pass.

## Assumptions

- Markdown is sufficient for the first increment.
- The constitution lives under `.nitely/` even though `.nitely/` is gitignored in this repo; operators may still manage it locally or copy the starter template.
- Validation of constitution conflicts is deferred to later analysis work.

## Out Of Scope

- Blocking runs on constitution violations.
- JSON/YAML constitution schema.
- Web Console editing UI for the constitution.
- Organization-level policy inheritance.
- Uploading constitution content to any control plane.

## Edge Cases

- Missing constitution: run proceeds and evidence records `Loaded: no`.
- Empty constitution: treated as missing to avoid injecting a blank section.
- Secret-like content in constitution: redacted by the existing runtime redaction machinery.
- Resume run: constitution is reloaded from the current repository state and injected into resumed agent/review prompts.
