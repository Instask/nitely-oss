# Run Traces (OpenTelemetry)

Nitely can export each run as an OpenTelemetry trace over OTLP, so operators can
see what agent stages actually did (every model call and tool execution, with
tokens, cost, latency, and errors) in an external tracing UI. The export is
vendor-neutral: anything that accepts OTLP traces works, including Langfuse and
LangSmith.

Export is off unless an OTLP endpoint is configured.

## Configuration

Set the standard OpenTelemetry variables in the environment of the process that
runs flows (the Web service, the CLI, or the scheduler):

| Variable | Meaning |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector base URL; Nitely posts to `<endpoint>/v1/traces`. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Full traces URL, used as is. Overrides the base endpoint. |
| `OTEL_EXPORTER_OTLP_HEADERS` | `key=value` pairs, comma-separated and percent-encoded, sent with every export (API keys, project). |
| `OTEL_SERVICE_NAME` | `service.name` resource attribute. Default `nitely`. |
| `OTEL_TRACES_EXPORTER=none` or `OTEL_SDK_DISABLED=true` | Turn export off even with an endpoint set. |
| `NITELY_OTEL_CAPTURE_CONTENT` | `true` to include completion text and tool arguments. Default off; see [Content](#content). |
| `NITELY_OTEL_EXPORT_TIMEOUT_MS` | Longest time one export may take. Default `10000`. |
| `NITELY_OTEL_MAX_SPANS` | Most spans per run trace. Default `5000`. |

Traces are sent as OTLP/HTTP protobuf. Only traces are exported; Nitely sends no
metrics or logs to the endpoint.

### Langfuse

Langfuse is open source and can run on the same host as Nitely, which keeps
traces of private repositories on your own machine. Use its OTLP endpoint with
Basic auth built from the project's public and secret keys:

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://langfuse.example.com/api/public/otel/v1/traces
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic%20$(printf '%s' "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" | base64)"
```

### LangSmith

LangSmith accepts OTLP traces with an API key, and the target project is chosen
with a header. For self-hosted LangSmith the endpoint is `<base>/api/v1/otel`.

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=https://api.smith.langchain.com/otel
export OTEL_EXPORTER_OTLP_HEADERS="x-api-key=$LANGSMITH_API_KEY,Langsmith-Project=nitely"
```

A local OTLP/HTTP collector accepts these traces. A live Langfuse or LangSmith
project has not been checked yet, so whether either product recognizes
`gen_ai.*` is still unverified. LangSmith should receive traces only.

## What a trace contains

One trace per run. Its trace id is derived from the run id, so a resumed run
re-exports the same trace with the same span ids and updated end times instead
of starting a new one.

```text
run <flow>                      nitely.run.id, nitely.work_item.id, nitely.repo.id,
│                               nitely.flow.name, nitely.flow.sha256, nitely.outcome
└─ stage <stage-id>             nitely.stage.id, nitely.outcome
   └─ attempt <stage-id>#<n>    nitely.runtime, gen_ai.request.model, nitely.effort.*,
      │                         nitely.outcome, nitely.blocked.reason, attempt usage totals
      ├─ chat <model>           Pi, and Codex when its rollout is readable: one per model call
      ├─ turn <model>           Codex otherwise: one per turn, tokens are the increase since the previous snapshot
      ├─ attempt-usage <model>  Claude: one span for the JSON result
      └─ execute_tool <name>    one per tool execution: gen_ai.tool.name, error status,
                                nitely.tool.output_bytes (Codex rollout)
```

Model-call spans use the OpenTelemetry GenAI names (`gen_ai.usage.input_tokens`,
`gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`,
`gen_ai.usage.cache_creation.input_tokens`) and also carry the OpenLLMetry names
(`gen_ai.usage.prompt_tokens`, `gen_ai.usage.completion_tokens`,
`llm.usage.total_tokens`) for backends that read those. Spans also carry
`langsmith.span.kind`. `input_tokens` includes cached tokens, the same way the
attempt's `stage.runtime.usage` counts them. Delta records on an attempt add up
to that attempt's usage totals. A record with `nitely.usage.accounting=cumulative`
is a snapshot and must not be added to its siblings.

Where the child spans come from:

- **Pi** (`pi`, `openrouter`, `together`) records one model call per
  `message_end`, plus tool executions. `nitely.usage.granularity` is omitted,
  which means `call`.
- **Codex** `exec --json` reports `turn.completed.usage` as the thread's
  cumulative total. Nitely stores one turn record per snapshot. Its token
  attributes are the increase since the previous snapshot in the same attempt
  (`nitely.usage.accounting=delta`), so the turns add up to the attempt's last
  snapshot. If a later snapshot is smaller, Nitely keeps that last snapshot as
  one cumulative record and does not invent a per-turn split.
  `codex exec resume` keeps the thread's total, so on an attempt that resumed
  an earlier session the last snapshot also includes the earlier attempts on
  that thread. The usage record keeps the thread id (`raw.threadId`), and the
  trace, run projection, and `nitely diagnose` subtract the latest snapshot
  recorded earlier on the same thread. The resumed attempt's span and its
  first turn record then carry only its own share, so resumed attempts add up
  to the session total. The stored event is not rewritten. If a snapshot is
  below that baseline, the attempt's tokens are reported as unknown and its
  turn records are marked `cumulative`. Tool spans are the item type
  (`command_execution`, `file_change`, `mcp_tool_call`, `web_search`) and an
  error flag. Command lines, paths, and arguments are not recorded. Codex does
  not emit per-model-call usage on this stream.
- **Codex rollout.** After the attempt ends, Nitely looks for the thread's
  rollout, `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl`,
  in the attempt's effective `CODEX_HOME`. Codex writes an
  `event_msg`/`token_count` entry after every model call with that call's own
  usage (`info.last_token_usage`) and the thread's running total. When the file
  is readable, each model call becomes a `chat <model>` span
  (`nitely.usage.granularity=call`, `nitely.usage.accounting=delta`) and each
  tool output becomes an `execute_tool` span with `nitely.tool.output_bytes`,
  the UTF-8 size of what the tool returned to the model. A `chat` span also
  carries `nitely.call.new_tool_output_bytes`: the tool output bytes that
  arrived since the previous call. The rest of that call's input is context it
  resends. Spans are in the rollout's order, timed from its line timestamps.
  The attempt span carries `nitely.usage.call_source=codex.rollout.token_count`.

  The `turn.completed` total stays authoritative. The per-call records replace
  the turn records only when the rollout's last running total equals that
  snapshot and the attempt's calls add up to it. A resumed attempt's calls are
  the ones `codex exec resume` appended after the attempt started; the running
  total before that is the baseline. Otherwise the turn records stay, and the
  attempt span's `nitely.usage.call_fallback` says why: `missing`,
  `unreadable`, `too-large`, `thread-mismatch`, `no-calls`, `total-mismatch`,
  `sum-mismatch`, `no-thread-id`, `no-turn-usage`, or `no-codex-home`. Reading
  the rollout never fails an attempt.

  Only numbers and identifiers are read out of the rollout: token counts, the
  model name, tool names and call ids, output sizes, and timestamps. Prompts,
  reasoning, tool inputs and outputs, and paths are not copied into events,
  logs, or traces. The file is streamed; a line over 4 MiB is measured without
  being parsed, and its tool output size is marked
  `nitely.tool.output_bytes_estimated`. A rollout path that is a symlink is not
  followed, and a rollout over 1 GiB is skipped.

  On the local backend the effective `CODEX_HOME` is the isolated home Nitely
  prepared for the attempt, or the operator's. On the OCI backend the rollout
  is written inside the container, so it survives only when `CODEX_HOME` is a
  host directory bind-mounted into the runner. Nitely reads it at the host path
  in `NITELY_OCI_CODEX_HOME_HOST_PATH`, or at the value of an allowlisted
  `CODEX_HOME` when it is mounted at the same path. Without either, the
  attempt records `no-codex-home`.
- **Claude** `--output-format json` is one result for the attempt, so there is
  one `attempt-usage` span. The CLI invocation does not stream per-message usage.

`stage.runtime.calls` holds these records, with `source` and, after a
fallback, `fallback: { reason, detail }`. `nitely diagnose` reads them for
uncached input, reasoning share, and tool volume. On per-call Codex records it
also reports `resent-tool-output`, an **upper-bound heuristic estimate** of how
much of the attempt's cached input tool outputs of at least 8 KB could account
for. The rollout does not say what each call's cached prefix contained, so the
figure bounds the effect; it does not measure it. Each large output is taken as
`ceil(bytes / 4)` tokens. On every model call after the one that first read it,
the output counts only while that call's input is at least the input of the
call before the output plus the output's estimated tokens. The first call below
that ends the output's attribution, since it may have been dropped, truncated,
or compacted. Each call is credited with at most its own cache-read tokens,
shared among the outputs still counted on it in arrival order, so a call with
no cache reads adds nothing. The finding's impact carries
`estimatedUpperBoundResentCachedTokens` and
`estimatedUpperBoundResentCachedShare`. It also counts the later calls that
added under 1 KB of new tool output, with the cached tokens they read. The
OTel attributes and the Web "Model calls" line carry only measured values
(token counts and output bytes), not this estimate. An attempt keeps at most
1,000 call log entries; the count of
any it left out is on the attempt span as `nitely.usage.call_log_dropped`.
Tool start and end times are the times Nitely observed the events in the
runtime's output stream.

## Content

By default a trace holds metadata only: no prompts, completions, tool inputs, or
tool outputs, because these contain repository code and can contain secrets.

With `NITELY_OTEL_CAPTURE_CONTENT=true`, Pi-based runtimes also keep each model
call's completion text and its tool-call arguments (each truncated to 4,096
characters), and the export adds them as `gen_ai.completion.0.content` and
`gen_ai.completion.0.tool_calls.<i>.{id,name,arguments}`. The setting has to be
on both while the run executes (that is when content is recorded) and when it is
exported. Content is redacted when it is written to the event log and again
before export, with the same redaction Nitely applies to every run event (the
run's secret values, `*_API_KEY=`/`token=` pairs, bearer tokens, private keys).

Prompts and tool outputs are not exported, even with content capture on.

## Failure behavior

Nitely exports a run's trace after the run returns (completed, failed, blocked,
cancelled, or waiting for approval), never while it executes. A slow or
unreachable collector cannot change a run's outcome: an export that fails or
exceeds `NITELY_OTEL_EXPORT_TIMEOUT_MS` is abandoned and logged as
`Nitely trace export failed for <run-id>: ...`. The CLI waits at most that long
before it exits. When a run has more spans than `NITELY_OTEL_MAX_SPANS`, the
extra model-call and tool spans are dropped. The run span records how many in
`nitely.trace.dropped_spans`, and the drop is logged.

Cancelling a run that is not executing (for example a blocked run) from the Web
Console, API, or `nitely run cancel --server` re-exports its trace in the
background with the `cancelled` outcome.
