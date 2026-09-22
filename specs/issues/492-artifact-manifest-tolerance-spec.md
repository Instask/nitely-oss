# Issue 492 Spec: Tolerate Incomplete artifact.json

## Background

`src/run/attempt-outputs.ts` rejects an attempt whose `artifact.json` omits
`attempt` or `stageId`, and default output discovery only looks for `<id>.md`
and `<id>.txt`. A dogfood run wrote a valid 16-task `task-plan.json` plus a
manifest that carried `stageId` and `outputs` but no `attempt`, and the whole
attempt failed with `artifact.json attempt must be an integer` after 2.38M
input tokens. The plan file was already on disk.

The runner always knows the stage id and the attempt number: the attempt
directory is `<run>/stages/<stage-id>/<attempt>`. Requiring the agent to copy
those two values into JSON by hand buys no safety.

## User Stories

- **US-001:** As an operator, an attempt that produced every declared output
  file is accepted even when the agent's `artifact.json` omits or mistypes
  `attempt` and `stageId`.
- **US-002:** As a flow author, a JSON output is discovered from `<id>.json`
  without requiring the agent to write a manifest at all.

## Acceptance Scenarios

- **US-001 / SC-001:** Given `artifact.json` with `version`, `stageId`, and
  `outputs` but no `attempt`, when the declared output files exist, then the
  attempt is accepted and the runner's attempt number is used.
- **US-001 / SC-002:** Given `artifact.json` without `stageId`, when the
  declared output files exist, then the attempt is accepted and the runner's
  stage id is used.
- **US-001 / SC-003:** Given `artifact.json` whose `stageId` or `attempt`
  disagrees with the runner, then the runner's values win and the attempt is
  still accepted.
- **US-002 / SC-001:** Given a stage that declares an `application/json`
  output and an attempt directory containing `<id>.json` with no
  `artifact.json`, then the output is discovered with media type
  `application/json`.
- **US-001 / SC-004:** Given `artifact.json` with an output path that escapes
  the attempt directory, then the attempt still fails.

## Functional Requirements

- **FR-001:** `artifact.json` `stageId` and `attempt` are optional. When
  present they must still be a string and an integer respectively.
- **FR-002:** The runner's stage id and attempt number are authoritative. A
  manifest that omits or contradicts them does not fail the attempt.
- **FR-003:** Default output discovery also matches `<id>.json` with media
  type `application/json`, after `<id>.md` and `<id>.txt`.
- **FR-004:** Path escape, `version` other than `1`, malformed JSON, missing
  output files, empty output files, undeclared output ids, duplicate output
  ids, and reserved `output.md` references continue to fail the attempt.
- **FR-005:** The prompt stops telling agents that a JSON output must be
  declared in `artifact.json`.
- **FR-006:** Document the tolerated manifest in the flow authoring guide.

## Non-Functional Requirements

- **NFR-001:** No new failure mode for manifests that are already complete and
  correct.

## Out Of Scope

- Allowing absolute paths or outputs outside the attempt directory.
- Weakening review or publish evidence once outputs are accepted.
- Changing how the normalized manifest is written for discovered outputs.

## Assumptions

- The attempt directory name is the authoritative attempt integer, and the
  caller already passes both it and the stage id.
