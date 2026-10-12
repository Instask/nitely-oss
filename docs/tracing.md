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
      ├─ chat <model>           one per model call: gen_ai.usage.* tokens, gen_ai.usage.cost,
      │                         gen_ai.response.finish_reasons, error status
      └─ execute_tool <name>    one per tool execution: gen_ai.tool.name, error status
```

Model-call spans use the OpenTelemetry GenAI names (`gen_ai.usage.input_tokens`,
`gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`,
`gen_ai.usage.cache_creation.input_tokens`) and also carry the OpenLLMetry names
(`gen_ai.usage.prompt_tokens`, `gen_ai.usage.completion_tokens`,
`llm.usage.total_tokens`) for backends that read those. Spans also carry
`langsmith.span.kind`. `input_tokens` includes cached tokens, the same way the
attempt's `stage.runtime.usage` counts them, so the model-call spans of an
attempt add up to the attempt's usage totals.

Model-call and tool spans come from the per-call log that Pi-based runtimes
(`pi`, `openrouter`, `together`) record in each attempt's `stage.runtime.calls`
event. Other runtimes report only attempt totals, so their attempts have no
child spans yet. An attempt keeps at most 1,000 call log entries; the count of
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
