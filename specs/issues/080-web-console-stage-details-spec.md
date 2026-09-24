# Issue 80 Spec: Expandable Web Console Stage Details

## Background

The Web Console run detail pipeline currently expands only stages with captured
stdout or stderr. Agent, review, publish, and other stages often have useful
metadata but no terminal logs, so clicking completed rows can do nothing.

## User Stories

- **US-001:** As a user auditing a run, I can open every pipeline stage row and see
  what Nitely knows about that stage.
- **US-002:** As a user inspecting agent work, I can see the rendered prompt,
  runtime/model, attempt metadata, artifacts, and usage data when available.
- **US-003:** As a user inspecting command or publish stages, I can see command
  output or change request metadata without hunting through raw evidence files.

## Acceptance Scenarios

- **US-001 / SC-001:** Given a run detail timeline includes a stage with no
  stdout/stderr, when I click the stage row, then the row opens and displays
  available structured metadata rather than doing nothing.
- **US-002 / SC-001:** Given an agent attempt directory contains `prompt.md`, when
  the run detail API is requested, then the stage timeline item includes the
  redacted rendered prompt.
- **US-002 / SC-002:** Given an agent stage has runtime/model and attempt paths, when
  the UI renders the open detail panel, then those values appear in labeled fields.
- **US-003 / SC-001:** Given a command stage has command logs, when opened, then the
  existing stdout/stderr view still appears.
- **US-003 / SC-002:** Given a publish/update stage records a change event, when
  opened, then the detail panel includes change request URL and publication fields.

## Functional Requirements

- **FR-001:** Every timeline stage item returned by `getRunDetail` must indicate
  that it has expandable details.
- **FR-002:** The Web API must include structured detail fields for common stage
  metadata: id, type, status, attempts, timestamps, duration, paths, runtime/model,
  outputs, gates, blockers, and usage data when available.
- **FR-003:** The Web API must read `prompt.md` from the latest attempt directory
  when present and redact it before returning it.
- **FR-004:** The Web API must include stage-scoped event summaries for useful
  events such as command completion, gates, orchestrator decisions, and change
  publication/update.
- **FR-005:** The Web UI must allow toggling every pipeline row, not only rows with
  stdout/stderr.
- **FR-006:** Large prompt/log/detail text must render in scrollable blocks.
- **FR-007:** Existing runs with partial data must still render using available
  fields and omit missing fields.

## Non-Functional Requirements

- **NFR-001:** Tests must cover an agent stage without stdout/stderr still returning
  expandable detail data.
- **NFR-002:** Existing log rendering and run detail behavior must remain compatible.

## Out Of Scope

- Per-event drilldown modals.
- New persistence format for run events or attempts.
- Editing or rerunning individual stages from the detail panel.
