# Issue 490 Spec: Bounded Agent Repository Reads

## Background

#473 covers write, sandbox, and read-only stage constraints. This issue is read
*volume*.

Dogfood implement attempts ran `danger-full-access` against the full promptaas
worktree. `controlPlane.ts` is 17,220 lines and `controlPlane.test.ts` is
20,494 lines. One `rg` over the gateway migrations returned 365,809 characters
into a single Codex session. Nitely declared no maximum file size, no path
denylist, and no "summarize, do not dump" rule.

Bounding what Nitely puts in the prompt (#489) does not touch this: it is the
agent's own reads, made after the prompt is delivered.

## User Stories

- **US-001:** As a flow author, every agent and review-gate stage carries a
  declared, finite read bound with a sensible default.
- **US-002:** As a flow author, a review stage gets a stricter default than an
  implement stage, without my having to write either down.
- **US-003:** As an operator, run evidence shows the read bound each stage ran
  under.
- **US-004:** As a flow author, if I declare that a stage must not exceed its
  bound, the stage stops rather than running unbounded while claiming a bound.

## Acceptance Scenarios

- **US-001 / SC-001:** Given an agent stage with no `reads`, then the prompt
  contains a `Repository Read Policy` section naming a 262144-byte cap and the
  default deny globs.
- **US-002 / SC-001:** Given a review gate with no `reads`, then its resolved
  cap is 32768 bytes.
- **US-001 / SC-002:** Given `reads` at both flow and stage level, then the
  stage value wins for that stage and the flow value applies to the others.
- **US-003 / SC-001:** Run evidence contains a `Stage Read Policies` section
  with the cap, enforcement mode, and deny list per stage.
- **US-004 / SC-001:** Given `reads.enforcement: "required"`, then the stage
  fails with a message stating that no execution backend enforces a byte-level
  read bound yet.

## Functional Requirements

- **FR-001:** Add a `reads` policy at flow and stage level with `maxFileBytes`,
  `deny`, and `enforcement`. Stage overrides flow.
- **FR-002:** Default `maxFileBytes` is 262144 for agent stages and 32768 for
  review gates.
- **FR-003:** Default `deny` covers `**/node_modules/**`, `**/.git/**`,
  `**/dist/**`, `**/*.lock`, `**/pnpm-lock.yaml`, `**/package-lock.json`.
- **FR-004:** Render the resolved policy into the agent prompt, including an
  explicit instruction to search and summarize rather than dump.
- **FR-005:** Record the resolved policy per stage in run evidence.
- **FR-006:** `enforcement: "required"` fails the stage, because no backend
  enforces a byte-level bound yet.
- **FR-007:** Document that `advisory` is advisory, and why a `PATH` shim over
  `cat` / `rg` is not shipped as enforcement.

## Non-Functional Requirements

- **NFR-001:** No behavior change for a flow that declares nothing beyond the
  new prompt section and evidence.

## Out Of Scope

- Byte-level enforcement inside the execution sandbox, which needs the OCI work
  in #476. A fixture-file test that proves a read over the cap is refused
  belongs with that enforcement, not with this slice.
- Replacing the write and sandbox constraints in #473.
- Full OCI tenant isolation (#319 / #476).

## Assumptions

- A cooperative agent honors a stated bound often enough to remove the
  accidental floods, and a flow that cannot tolerate an uncooperative one
  prefers to stop.

## Rejected Alternative

A `PATH` shim that wraps `cat`, `head`, `tail`, `grep`, and `rg` to truncate
output at the cap. Rejected because truncating those commands silently corrupts
ordinary work — `cat big.json > out.json` in the agent's own shell would write a
truncated file — and because `node -e` or `python -c` bypasses the shim
entirely. Shipping it as "enforcement" would be a false guarantee.
