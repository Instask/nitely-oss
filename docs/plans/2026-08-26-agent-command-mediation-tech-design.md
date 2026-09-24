# Tech Design: Agent Command Allow/Deny Mediation

Issue: #478
Parent: #476
Spec: `specs/issues/478-agent-command-mediation-spec.md`

## Summary

Give `capabilities.commands` a consumer. A new
`src/run/execution/command-mediation.ts` normalizes the declared policy, decides
individual argv against it, and resolves what a named boundary can do with it.
The OCI and local backends consult that resolution before any workload starts.

## Rule Model

A rule is one of:

- a bare program name (`git`): matches `argv[0]` or its basename, so it holds
  whether the agent invoked `git` or `/usr/bin/git`;
- an explicit path (`/usr/bin/git`): matches `argv[0]` exactly;
- an argv pattern (`pnpm test*`, `git commit -m ?`): a glob over the joined
  command line, tested both as invoked and with `argv[0]` reduced to its
  basename.

`*` and `?` are the only metacharacters; everything else is escaped, so
`pnpm t.st*` does not match `pnpm test`. `deny` is evaluated before `mode`, so a
deny rule always wins.

This matches how the runtime registry describes launches (`{ command, args }`),
which is why the model is argv-shaped rather than shell-string-shaped.

## Outcomes

`resolveCommandMediation({ policy, boundary, mechanism })` returns one of:

| Outcome | When | Backend behavior |
| --- | --- | --- |
| `unmediated` | `mode: "unrestricted"` | Run, no change |
| `enforced` | a mechanism supports the policy | Run; report the mechanism id |
| `stated` | restrictive mode, `advisory: true` | Run; append the rules to the prompt |
| `unenforceable` | restrictive mode, `advisory: false` | Refuse before launch |

`advisory` carries the same meaning it already carries for network policy in
this codebase: `true` states intent, `false` demands enforcement.

## Why No Mechanism Ships Here

Mediating the binaries an agent spawns inside a container needs something that
sits below the process: an eBPF or AppArmor policy, or a runtime that exposes
per-command permissions. A PATH-scoped shim directory was considered and
rejected: an absolute-path invocation walks straight past it, so shipping it
would mean calling something enforcement that is not. The issue's non-goals
exclude eBPF productization, so the honest first slice is a real policy model, a
real refusal, and a registered seam (`CommandMediationMechanism`) for whatever
enforces it later.

What ships is therefore load-bearing in two ways: a demanded policy now stops a
run that previously proceeded unmediated on local and mise, and an advisory
policy now reaches the agent instead of being silently discarded.

## Exemption

The runtime CLI Nitely launches (`codex exec …`) is the agent, not a command the
agent chose. It is never matched against the policy. Without that exemption an
`allow-list` naming the commands an operator wants the agent to run would deny
the agent itself.

## Evidence

`ExecutionBackendDescription` gains
`commands: { mediation: "mechanism" | "stated" | "none"; mechanism?: string }`,
rendered by `formatExecutionBackendEvidence` as one line. The stage-level
capability policy line in `run-flow` already prints mode, advisory flag, and
rule names. Nothing carries argv or environment values.

## Verification

- `test/run/execution/command-mediation.test.ts`: normalization and policy id,
  each rule form, regular-expression escaping, allow, deny-beats-allow, each
  mode, empty argv, all four outcomes, prompt text, evidence text.
- `test/run/execution/oci.test.ts`: advisory policy reaches the prompt and runs;
  a registered mechanism enforces and leaves the prompt alone; a demanded policy
  fails preflight and `runAgent` with no container launched.
- `test/run/execution/local.test.ts`: a demanded policy refuses before spawn; an
  advisory policy runs.
