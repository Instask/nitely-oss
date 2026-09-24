# Tasks

## Canonical Inputs

- Spec: `path/to/spec.md` (trace: US-001, FR-001, SC-001)
- Technical design: `path/to/tech-design.md` (trace: PD-001)

## Phase 1: Setup

- [ ] T001 FR-001 SC-001 Create or update tests in `test/path/to/file.test.ts`
- [ ] T002 [P] FR-001 PD-001 Add supporting types in `src/path/to/module.ts` (depends: T001)

## Phase 2: User Story US-001 - Primary workflow

- [ ] T003 [US-001] FR-001 PD-001 Implement the workflow in `src/path/to/module.ts` (depends: T002)
- [ ] T004 [P] [US-001] SC-001 Add focused verification in `test/path/to/file.test.ts` (depends: T003)

## Phase 3: Verification

- [ ] T005 Run full checks and update task completion state (depends: T003,T004)

## Downstream Evidence

- Run evidence should cite consumed artifact paths plus relevant US-001,
  FR-001, SC-001, PD-001, and T001-style task IDs.
- PR evidence should cite the same IDs when summarizing scope, verification, and
  follow-up review findings.
