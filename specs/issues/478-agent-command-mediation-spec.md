# Issue 478 Spec: Agent Command Allow/Deny Mediation

## Background

The flow schema already lets an agent stage declare
`capabilities.commands` with a `mode`, an `allow` list, a `deny` list, and an
`advisory` flag. Nothing consumed it. The OCI backend refused to run any stage
whose mode was not `unrestricted`, which is fail-closed but makes the field
unusable; the local and mise backends ignored it entirely and ran the agent
anyway. Container isolation bounds the filesystem and the network. It does not
mediate which binaries an agent spawns inside the image.

## User Stories

- **US-001:** As a flow author, I can declare which commands a stage's agent may
  run, in a form that matches how the runtime registry launches processes.
- **US-002:** As an operator, a stage that demands enforcement I cannot provide
  refuses to run instead of running unmediated.
- **US-003:** As a flow author, I can state a policy the agent must respect
  without demanding sandbox enforcement that does not exist yet.
- **US-004:** As an auditor, evidence tells me the policy that applied and how
  it was applied, without carrying argv or values.

## Acceptance Scenarios

- **US-001 / SC-001:** A bare rule (`git`) matches the program by name whether
  the agent invoked `git` or `/usr/bin/git`; an explicit path rule matches only
  that path; a pattern rule (`pnpm test*`) matches the whole command line with
  and without the resolved directory.
- **US-001 / SC-002:** A `deny` match always wins over an `allow` match.
- **US-001 / SC-003:** `none` denies every command, `allow-list` denies anything
  no allow rule names, `deny-list` allows anything no deny rule names, and
  `unrestricted` skips mediation entirely.
- **US-002 / SC-001:** Under OCI, a stage with a restrictive mode and
  `advisory: false` fails preflight with a reason naming the missing mechanism,
  and no container is launched.
- **US-002 / SC-002:** The local backend, and mise through it, fails the same
  way before spawning the agent.
- **US-003 / SC-001:** Under OCI, a restrictive mode with `advisory: true` runs,
  and the agent's prompt carries the allow and deny rule names plus a statement
  that the policy is stated, not enforced.
- **US-003 / SC-002:** A backend that registers a mediation mechanism reports
  the policy as enforced and does not append the prompt section.
- **US-004 / SC-001:** The backend description and the run evidence carry the
  mode, the advisory flag, the rule names, and the mechanism id when one exists.
  No argv and no environment values appear.

## Functional Requirements

- **FR-001:** Add a command mediation module that normalizes
  `capabilities.commands` into a policy with a stable, value-free `policyId`.
- **FR-002:** Support three rule forms: bare program name, explicit path, and
  argv glob with `*` and `?`. Escape every other regular-expression character so
  a rule cannot match more than it names.
- **FR-003:** Decide a command as allow or deny with the reason and the matched
  rule, applying deny before mode.
- **FR-004:** Resolve a policy at a named boundary into `unmediated`,
  `enforced`, `stated`, or `unenforceable`.
- **FR-005:** The OCI backend fails closed on `unenforceable`, at preflight and
  at `runAgent`, before any container starts.
- **FR-006:** The OCI backend appends the stated policy to the agent prompt when
  the outcome is `stated`.
- **FR-007:** The OCI backend accepts an optional `commandMediation` mechanism.
  When it supports the policy, the outcome is `enforced` and the prompt is left
  alone.
- **FR-008:** The local backend fails closed on `unenforceable`. Mise inherits
  this through the local backend.
- **FR-009:** The runtime CLI Nitely launches is the agent, not one of its
  commands, and is never matched against the policy.
- **FR-010:** `ExecutionBackendDescription` carries a `commands` section, and
  the execution evidence renders it.
- **FR-011:** Document the model, the three outcomes, and local/mise behavior in
  the README.

## Non-Functional Requirements

- **NFR-001:** Evidence carries policy id, mode, advisory flag, rule names, and
  mechanism id only.
- **NFR-002:** Failure text names the boundary that could not honor the demand
  and the ways out, so an operator does not have to read the source.
- **NFR-003:** No behavior change for stages that do not declare capabilities:
  the implicit policy stays `unrestricted`.

## Out Of Scope

- An eBPF, AppArmor, or seccomp mediation mechanism. The mechanism interface is
  the seam one would register through.
- Mediating command stages, which declare no capability policy.
- Mapping the policy onto runtime-native tool permission flags.

## Assumptions

- `advisory` means the same thing for commands as it already does for network
  policy in this codebase: `true` states the intent, `false` demands
  enforcement.
