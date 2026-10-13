# Provider compatibility matrix and live smoke

Mocked runtimes prove that Nitely behaves deterministically; they do not prove
that an installed CLI, its authentication, or its output format still match
what Nitely parses. This page describes the three layers Nitely uses to close
that gap.

## 1. Compatibility matrix

`src/providers/compatibility/matrix.ts` holds a versioned matrix
(`nitely.provider-compatibility.v1`) with one row per agent runtime: the CLI it
launches and its override variable, the credential sources it requires, its
output format, how token usage and cost are reported, its capabilities, its
support status, and its degradation policy.

| Runtime | CLI | Credentials | Usage | Cost | Status |
| --- | --- | --- | --- | --- | --- |
| claude | `claude` | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | provider-reported | actual | contract-tested |
| codex | `codex` | CLI login | provider-reported | unknown | contract-tested |
| openrouter | `pi` | `OPENROUTER_API_KEY` | provider-reported | estimated (Pi pricing) | contract-tested |
| pi | `pi` | CLI login | provider-reported | estimated (Pi pricing) | contract-tested |
| together | `pi` | `TOGETHER_API_KEY` | provider-reported | estimated (Pi pricing) | contract-tested |
| glm | `glm` | `NITELY_GLM_API_KEY`, `GLM_API_KEY` or `ZHIPUAI_API_KEY` | none | unknown | experimental |
| grok | `grok` | CLI login | none | unknown | experimental |

Statuses:

- `contract-tested`: deterministic fixtures cover the row.
- `live-verified`: additionally, a recorded live smoke passed for a named CLI
  version. The row must carry that CLI version, a timestamp and an evidence
  digest; the matrix validator rejects `live-verified` without them. No row is
  live-verified yet.
- `experimental`: launchable, no contract fixtures.
- `disabled`: known broken. Live smoke refuses it, and the degradation text
  explains what operators should do.

A test keeps the matrix in step with the runtime registry: every launchable
runtime has a row, and each row's credentials and capabilities match what the
launcher enforces.

## 2. Contract fixtures

`test/providers/compatibility/contract.test.ts` replays synthetic CLI output
through the production parsers and classifiers:

- usage parsing for Codex JSONL, the Claude result envelope and the Pi JSON
  stream, including truncated output, failed turns and cancellation;
- cost semantics: Claude cost is actual, Pi-family cost is estimated from Pi's
  pricing table and must never be reported as actual, and missing cost stays
  unknown instead of zero;
- failure classification: rejected credentials and usage or rate limits block
  the run for the operator, a missing CLI is reported as unavailable, and
  ordinary failures stay ordinary;
- OpenRouter and Together failure explanations route to the right blocker.

These run in normal CI and never call a provider.

## 3. Opt-in live smoke

`src/providers/compatibility/live-smoke.ts` decides whether a live smoke may
run and how to report it. It does not launch anything itself.

`planLiveSmoke` skips a provider, with a recorded reason, unless all of these
hold: the provider is in the matrix and not disabled, it was named explicitly,
the context is trusted (never a pull request from a fork), an explicit token,
currency and timeout cap is set, and its credential is present.

`evaluateLiveSmoke` produces a `nitely.provider-live-smoke.v1` report. A
provider is `verified` only when it was planned, exited 0 within the timeout,
reported token usage and stayed within the token and (when known) currency
cap. Exceeding a cap is `blocked-budget`; missing usage, a non-zero exit, a
timeout or a missing observation is `failed`; everything not run is
`skipped`. Each result keeps the CLI version, source SHA, stage ids, latency,
tokens and cost provenance, and stderr is redacted before it is stored.

Running live smoke in CI needs provider secrets that are available only to
trusted, manually dispatched or scheduled workflows, plus a small synthetic
repository. That wiring is operational setup and is not part of this change.
