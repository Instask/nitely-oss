# Issue 507 Spec: CLI Command Registry

## Background

`src/cli.ts` dispatched 36 top-level commands through one chain of
`if (argv[0] === "...")` blocks inside `runCli`, and `HELP` was a separate string
literal maintained by hand. Nothing tied the two together, which is how the
`--backend` usage text in #504 drifted from `normalizeExecutionBackendName`.

## User Stories

- **US-001:** As a maintainer adding a command, I attach it to a registry entry
  that carries its own help lines, instead of appending another branch to one
  long function.
- **US-002:** As a maintainer, I cannot ship a command whose help text is missing,
  because the help output is generated from the registry.
- **US-003:** As an operator, nothing about the CLI's behavior or help output
  changes.

## Acceptance Scenarios

- **US-001 / SC-001:** Given the registry, when `runCli` receives a command name,
  then it selects the matching entry rather than falling through an ordered chain,
  and an unknown name still prints `Unknown command: <name>`.
- **US-001 / SC-002:** Given two entries share a name, such as `run watch` and
  `run <flow>`, when the more specific entry's guard matches, then it is selected
  ahead of the general entry regardless of registry order.
- **US-002 / SC-001:** Given the registry, when the CLI prints help, then the
  output equals the header followed by every entry's usage lines in registry
  order.
- **US-002 / SC-002:** Given an entry with no usage lines, when the registry test
  runs, then it fails.
- **US-003 / SC-001:** Given the same arguments, when any existing command runs,
  then its stdout, stderr, and exit code are unchanged.
- **US-003 / SC-002:** Given `nitely help`, when the CLI prints help, then the
  output is byte-identical to the previous `HELP` literal.

## Functional Requirements

- **FR-001:** Add a `CliCommand` descriptor with `name`, `usage` lines, an
  optional `matches` guard, and a `run` handler.
- **FR-002:** Add `buildCliHelp` and `selectCliCommand` in a module that does not
  depend on `src/cli.ts`.
- **FR-003:** `selectCliCommand` prefers a guarded entry over an unguarded entry
  of the same name, so registry order can follow the help text.
- **FR-004:** Convert every existing command in `runCli` into a registry entry
  whose handler body is the previous branch body.
- **FR-005:** Generate the help text from the registry.
- **FR-006:** Export the registry so tests can assert the help derivation and the
  absence of undocumented commands.
- **FR-007:** Move the shared CLI IO types and the remote HTTP helpers into
  `src/cli/`, leaving `src/cli.ts` importing them.
- **FR-008:** Change no command's options, output, or exit codes.

## Non-Functional Requirements

- **NFR-001:** The existing CLI test suite must pass unchanged, apart from tests
  added for the registry itself.
- **NFR-002:** Help output must be byte-identical to the previous literal.
- **NFR-003:** Remaining command groups may move out of `src/cli.ts` later; a
  partially migrated layout must keep working.
