import { createHash } from "node:crypto";

import { SpanKind, SpanStatusCode, TraceFlags, type Attributes, type HrTime } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace";

import { redactUnknown } from "../context/redaction.js";
import type { StoredRunEvent } from "../events/types.js";
import type { AgentRuntimeCall } from "../run/execution/types.js";

/**
 * OpenTelemetry trace export for runs.
 *
 * A run's event log is turned into one trace: `run` → `stage` → `attempt` →
 * one span per model call and per tool execution (from the attempt's
 * `stage.runtime.calls` event). Export happens after the run returns, not
 * while it executes, so a slow or unreachable collector can only add the
 * bounded flush time and never changes the run's outcome.
 *
 * Trace and span ids are derived from the run id and the span's position in
 * the tree, so exporting a run again after a resume re-sends the same spans
 * with their updated end times instead of starting a second trace.
 *
 * Content (completions, tool arguments) is exported only when
 * `NITELY_OTEL_CAPTURE_CONTENT=true`, and passes through redaction again.
 */

export const DEFAULT_OTEL_EXPORT_TIMEOUT_MS = 10_000;
export const DEFAULT_OTEL_MAX_SPANS = 5_000;
const EXPORT_BATCH_SIZE = 256;
const INSTRUMENTATION_SCOPE = { name: "nitely.run" } as const;

export interface OtlpTraceConfig {
  url: string;
  headers: Record<string, string>;
  serviceName: string;
  timeoutMillis: number;
  maxSpans: number;
  captureContent: boolean;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** `k1=v1,k2=v2`, percent-decoded, as the OTLP exporter spec defines. */
export function parseOtlpHeaders(value: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of (value ?? "").split(",")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    try {
      const key = decodeURIComponent(entry.slice(0, separator).trim());
      const headerValue = decodeURIComponent(entry.slice(separator + 1).trim());
      if (key) headers[key] = headerValue;
    } catch {
      // A malformed escape: skip the header rather than fail the export.
    }
  }
  return headers;
}

/**
 * The OTLP trace exporter configuration from the standard environment
 * variables, or `undefined` when no endpoint is set (export is off).
 */
export function otlpTraceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OtlpTraceConfig | undefined {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return undefined;
  if (env.OTEL_TRACES_EXPORTER?.trim().toLowerCase() === "none") return undefined;
  const tracesEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const url = tracesEndpoint || (endpoint ? `${endpoint.replace(/\/+$/, "")}/v1/traces` : undefined);
  if (!url) return undefined;
  return {
    url,
    headers: {
      ...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
      ...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
    },
    serviceName: env.OTEL_SERVICE_NAME?.trim() || "nitely",
    timeoutMillis: positiveInteger(env.NITELY_OTEL_EXPORT_TIMEOUT_MS, DEFAULT_OTEL_EXPORT_TIMEOUT_MS),
    maxSpans: positiveInteger(env.NITELY_OTEL_MAX_SPANS, DEFAULT_OTEL_MAX_SPANS),
    captureContent: env.NITELY_OTEL_CAPTURE_CONTENT?.trim().toLowerCase() === "true",
  };
}

export type TraceSpanStatus = "ok" | "error" | "unset";

/** A span before ids and OTel types: what the tests assert on. */
export interface TraceSpanSpec {
  key: string;
  parentKey?: string;
  name: string;
  kind: "run" | "stage" | "attempt" | "llm" | "tool";
  startTime: string;
  endTime: string;
  status: TraceSpanStatus;
  statusMessage?: string;
  attributes: Attributes;
}

export interface RunTraceSpans {
  runId: string;
  spans: TraceSpanSpec[];
  droppedSpans: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function defined(attributes: Record<string, unknown>): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      out[key] = value as string[];
    }
  }
  return out;
}

function millis(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : undefined;
}

interface Window {
  start: string;
  end: string;
}

function widen(window: Window | undefined, at: string): Window {
  if (!window) return { start: at, end: at };
  return {
    start: (millis(at) ?? 0) < (millis(window.start) ?? 0) ? at : window.start,
    end: (millis(at) ?? 0) > (millis(window.end) ?? 0) ? at : window.end,
  };
}

/** Keep a child's times inside its parent; a missing time falls back to the parent's end. */
function clamp(window: Window, startedAt: string | undefined, endedAt: string | undefined): Window {
  const lower = millis(window.start) ?? 0;
  const upper = millis(window.end) ?? lower;
  const pick = (value: string | undefined, fallback: number) => {
    const parsed = millis(value);
    return Math.min(Math.max(parsed ?? fallback, lower), upper);
  };
  const end = pick(endedAt, upper);
  const start = Math.min(pick(startedAt, end), end);
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

function terminalOutcome(type: string): string | undefined {
  switch (type) {
    case "run.completed":
    case "stage.completed":
      return "completed";
    case "run.failed":
    case "stage.failed":
      return "failed";
    case "run.blocked":
    case "stage.blocked":
      return "blocked";
    case "run.cancelled":
      return "cancelled";
    default:
      return undefined;
  }
}

function statusFor(outcome: string | undefined): TraceSpanStatus {
  if (outcome === "completed") return "ok";
  if (outcome === "failed" || outcome === "blocked") return "error";
  return "unset";
}

function terminalMessage(payload: Record<string, unknown>): string | undefined {
  return asString(payload.message) ?? asString(payload.error) ?? asString(payload.reason);
}

function callLogOf(payload: Record<string, unknown>): AgentRuntimeCall[] {
  const log = payload.calls;
  if (!Array.isArray(log)) return [];
  return log.filter((entry): entry is AgentRuntimeCall => {
    const kind = asRecord(entry).kind;
    return kind === "llm" || kind === "tool";
  });
}

interface AttemptState {
  stageId: string;
  attempt: number;
  window: Window;
  outcome?: string;
  outcomeMessage?: string;
  blockedReason?: string;
  runtime?: string;
  model?: string;
  requestedEffort?: string;
  nativeEffort?: string;
  usage?: Record<string, unknown>;
  calls?: Record<string, unknown>;
}

/**
 * Turn a run's events into span specs. Pure: no ids, no I/O.
 */
export function buildRunTraceSpans(
  events: StoredRunEvent[],
  options: { captureContent?: boolean; maxSpans?: number } = {},
): RunTraceSpans | undefined {
  if (events.length === 0) return undefined;
  const sorted = [...events].sort((left, right) => left.sequence - right.sequence);
  const runId = (sorted[0] as StoredRunEvent).runId;
  const maxSpans = options.maxSpans ?? DEFAULT_OTEL_MAX_SPANS;
  const captureContent = options.captureContent === true;

  let runWindow: Window | undefined;
  let runOutcome: string | undefined;
  let runOutcomeMessage: string | undefined;
  let flowName: string | undefined;
  let flowSha256: string | undefined;
  let workItemId: string | undefined;
  let repoId: string | undefined;
  let repoName: string | undefined;
  const stageWindows = new Map<string, Window>();
  const stageOutcomes = new Map<string, string>();
  const attempts = new Map<string, AttemptState>();

  for (const event of sorted) {
    const payload = asRecord(event.payload);
    runWindow = widen(runWindow, event.createdAt);
    if (event.type === "run.created") {
      flowName = asString(payload.flowName) ?? flowName;
      flowSha256 = asString(payload.flowDocumentSha256) ?? flowSha256;
      workItemId = asString(payload.workItemId) ?? workItemId;
      repoId = asString(payload.repoId) ?? repoId;
      repoName = asString(payload.repoName) ?? repoName;
    }
    if (event.type.startsWith("run.")) {
      const outcome = terminalOutcome(event.type);
      if (outcome) {
        runOutcome = outcome;
        runOutcomeMessage = terminalMessage(payload);
      } else if (event.type === "run.resumed") {
        runOutcome = undefined;
        runOutcomeMessage = undefined;
      }
    }
    if (!event.stageId) continue;
    stageWindows.set(event.stageId, widen(stageWindows.get(event.stageId), event.createdAt));
    const stageOutcome = terminalOutcome(event.type);
    if (stageOutcome && event.type.startsWith("stage.")) stageOutcomes.set(event.stageId, stageOutcome);
    if (typeof event.attempt !== "number") continue;
    const key = `${event.stageId}:${event.attempt}`;
    const existing = attempts.get(key);
    const state: AttemptState = existing ?? {
      stageId: event.stageId,
      attempt: event.attempt,
      window: { start: event.createdAt, end: event.createdAt },
    };
    state.window = widen(state.window, event.createdAt);
    attempts.set(key, state);
    if (event.type === "stage.runtime.selected") {
      state.runtime = asString(payload.runtime) ?? state.runtime;
      state.model = asString(payload.model) ?? state.model;
      state.requestedEffort = asString(payload.requestedEffort) ?? state.requestedEffort;
      state.nativeEffort = asString(payload.nativeEffort) ?? state.nativeEffort;
    } else if (event.type === "stage.runtime.usage") {
      state.usage = payload;
    } else if (event.type === "stage.runtime.calls") {
      state.calls = payload;
    } else if (event.type.startsWith("stage.") && stageOutcome) {
      state.outcome = stageOutcome;
      state.outcomeMessage = terminalMessage(payload);
      if (stageOutcome === "blocked") state.blockedReason = asString(payload.reason);
    }
  }

  const window = runWindow as Window;
  const common = defined({
    "nitely.run.id": runId,
    "nitely.work_item.id": workItemId,
    "nitely.repo.id": repoId,
    "nitely.repo.name": repoName,
    "nitely.flow.name": flowName,
    "nitely.flow.sha256": flowSha256,
  });
  const spans: TraceSpanSpec[] = [];
  let droppedSpans = 0;
  const push = (span: TraceSpanSpec, essential: boolean) => {
    if (!essential && spans.length >= maxSpans) {
      droppedSpans += 1;
      return;
    }
    spans.push(span);
  };

  const runSpan: TraceSpanSpec = {
    key: "run",
    name: flowName ? `run ${flowName}` : "run",
    kind: "run",
    startTime: window.start,
    endTime: window.end,
    status: statusFor(runOutcome),
    ...(runOutcome && statusFor(runOutcome) === "error" && runOutcomeMessage
      ? { statusMessage: runOutcomeMessage }
      : {}),
    attributes: defined({
      ...common,
      "nitely.span.kind": "run",
      "langsmith.span.kind": "chain",
      "nitely.outcome": runOutcome ?? "open",
    }),
  };
  push(runSpan, true);

  for (const [stageId, stageWindow] of stageWindows) {
    const outcome = stageOutcomes.get(stageId);
    push({
      key: `stage:${stageId}`,
      parentKey: "run",
      name: `stage ${stageId}`,
      kind: "stage",
      startTime: stageWindow.start,
      endTime: stageWindow.end,
      status: statusFor(outcome),
      attributes: defined({
        ...common,
        "nitely.span.kind": "stage",
        "langsmith.span.kind": "chain",
        "nitely.stage.id": stageId,
        "nitely.outcome": outcome ?? "open",
      }),
    }, true);
  }

  const callSpans: TraceSpanSpec[] = [];
  for (const state of attempts.values()) {
    const attemptKey = `attempt:${state.stageId}:${state.attempt}`;
    const usage = state.usage ?? {};
    const raw = asRecord(usage.raw);
    const cost = asRecord(usage.cost);
    const costUsd = asNumber(cost.usd) ?? asNumber(usage.estimatedCostUsd);
    const provenance = asRecord(usage.provenance);
    const stageCommon = { ...common, "nitely.stage.id": state.stageId, "nitely.attempt": state.attempt };
    push({
      key: attemptKey,
      parentKey: `stage:${state.stageId}`,
      name: `attempt ${state.stageId}#${state.attempt}`,
      kind: "attempt",
      startTime: state.window.start,
      endTime: state.window.end,
      status: statusFor(state.outcome),
      ...(state.outcome && statusFor(state.outcome) === "error" && state.outcomeMessage
        ? { statusMessage: state.outcomeMessage }
        : {}),
      attributes: defined({
        ...stageCommon,
        "nitely.span.kind": "attempt",
        "langsmith.span.kind": "chain",
        "nitely.runtime": state.runtime,
        "gen_ai.request.model": state.model,
        "gen_ai.response.model": asString(provenance.model),
        "nitely.effort.requested": state.requestedEffort,
        "nitely.effort.native": state.nativeEffort,
        "nitely.outcome": state.outcome ?? "open",
        "nitely.blocked.reason": state.blockedReason,
        "gen_ai.usage.input_tokens": asNumber(usage.inputTokens),
        "gen_ai.usage.output_tokens": asNumber(usage.outputTokens),
        "gen_ai.usage.cache_read.input_tokens": asNumber(usage.cachedInputTokens),
        "gen_ai.usage.cache_creation.input_tokens": asNumber(raw.cacheWriteInputTokens),
        "nitely.usage.total_tokens": asNumber(usage.totalTokens),
        "nitely.usage.cost_usd": costUsd,
        "nitely.usage.cost_classification": asString(cost.classification),
        "nitely.usage.calls": asNumber(raw.calls),
        "nitely.usage.call_log_dropped": asNumber(state.calls?.dropped),
      }),
    }, true);

    const calls = callLogOf(state.calls ?? {});
    calls.forEach((call, index) => {
      const times = clamp(state.window, call.startedAt, call.endedAt);
      if (call.kind === "llm") {
        const model = call.responseModel ?? call.model ?? state.model;
        const toolCalls = call.toolCalls ?? [];
        const content: Record<string, unknown> = {};
        if (captureContent) {
          const redacted = asRecord(redactUnknown({ output: call.output, toolCalls }));
          const redactedCalls = Array.isArray(redacted.toolCalls) ? redacted.toolCalls.map(asRecord) : [];
          if (asString(redacted.output)) {
            content["gen_ai.completion.0.role"] = "assistant";
            content["gen_ai.completion.0.content"] = redacted.output;
          }
          redactedCalls.forEach((toolCall, toolIndex) => {
            content[`gen_ai.completion.0.tool_calls.${toolIndex}.id`] = asString(toolCall.id);
            content[`gen_ai.completion.0.tool_calls.${toolIndex}.name`] = asString(toolCall.name);
            content[`gen_ai.completion.0.tool_calls.${toolIndex}.arguments`] = asString(toolCall.arguments);
          });
        }
        callSpans.push({
          key: `${attemptKey}:call:${index}`,
          parentKey: attemptKey,
          name: call.operation === "compaction" ? `compaction ${model ?? ""}`.trim() : `chat ${model ?? ""}`.trim(),
          kind: "llm",
          startTime: times.start,
          endTime: times.end,
          status: call.error ? "error" : "ok",
          ...(call.error ? { statusMessage: call.error } : {}),
          attributes: defined({
            ...stageCommon,
            "nitely.span.kind": "llm",
            "langsmith.span.kind": "llm",
            "gen_ai.operation.name": "chat",
            "gen_ai.system": call.provider ?? state.runtime,
            "gen_ai.provider.name": call.provider ?? state.runtime,
            "gen_ai.request.model": call.model ?? state.model,
            "gen_ai.response.model": call.responseModel,
            "gen_ai.response.finish_reasons": call.stopReason ? [call.stopReason] : undefined,
            "gen_ai.usage.input_tokens": call.inputTokens,
            "gen_ai.usage.output_tokens": call.outputTokens,
            "gen_ai.usage.cache_read.input_tokens": call.cacheReadInputTokens,
            "gen_ai.usage.cache_creation.input_tokens": call.cacheWriteInputTokens,
            "gen_ai.usage.cost": call.costUsd,
            // OpenLLMetry names, for backends that predate the gen_ai.usage.* names.
            "gen_ai.usage.prompt_tokens": call.inputTokens,
            "gen_ai.usage.completion_tokens": call.outputTokens,
            "llm.usage.total_tokens": call.totalTokens,
            "nitely.usage.cost_usd": call.costUsd,
            "nitely.call.incomplete": call.incomplete,
            "nitely.call.operation": call.operation,
            "nitely.call.tool_call_names": toolCalls.length > 0
              ? toolCalls.map((toolCall) => toolCall.name ?? "unknown")
              : undefined,
            ...content,
          }),
        });
      } else {
        callSpans.push({
          key: `${attemptKey}:call:${index}`,
          parentKey: attemptKey,
          name: `execute_tool ${call.toolName ?? "unknown"}`,
          kind: "tool",
          startTime: times.start,
          endTime: times.end,
          status: call.isError ? "error" : call.endedAt ? "ok" : "unset",
          attributes: defined({
            ...stageCommon,
            "nitely.span.kind": "tool",
            "langsmith.span.kind": "tool",
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": call.toolName,
            "gen_ai.tool.call.id": call.toolCallId,
            "nitely.tool.is_error": call.isError,
          }),
        });
      }
    });
  }
  for (const span of callSpans) push(span, false);
  if (droppedSpans > 0) runSpan.attributes["nitely.trace.dropped_spans"] = droppedSpans;
  return { runId, spans, droppedSpans };
}

function hexId(seed: string, length: number): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, length);
  // All-zero ids are invalid in OTLP.
  return /^0+$/.test(hex) ? `${"0".repeat(length - 1)}1` : hex;
}

export function traceIdForRun(runId: string): string {
  return hexId(`nitely.trace:${runId}`, 32);
}

export function spanIdFor(runId: string, key: string): string {
  return hexId(`nitely.span:${runId}:${key}`, 16);
}

function hrTime(iso: string): HrTime {
  const ms = millis(iso) ?? 0;
  const seconds = Math.floor(ms / 1000);
  return [seconds, (ms - seconds * 1000) * 1_000_000];
}

function hrDuration(start: string, end: string): HrTime {
  const ms = Math.max(0, (millis(end) ?? 0) - (millis(start) ?? 0));
  const seconds = Math.floor(ms / 1000);
  return [seconds, (ms - seconds * 1000) * 1_000_000];
}

/** Give span specs their deterministic ids and the OTel SDK's export shape. */
export function toReadableSpans(trace: RunTraceSpans, serviceName: string): ReadableSpan[] {
  const resource = resourceFromAttributes({ "service.name": serviceName });
  const traceId = traceIdForRun(trace.runId);
  const context = (key: string) => ({
    traceId,
    spanId: spanIdFor(trace.runId, key),
    traceFlags: TraceFlags.SAMPLED,
  });
  return trace.spans.map((span) => {
    const spanContext = context(span.key);
    return {
      name: span.name,
      kind: span.kind === "llm" ? SpanKind.CLIENT : SpanKind.INTERNAL,
      spanContext: () => spanContext,
      ...(span.parentKey ? { parentSpanContext: context(span.parentKey) } : {}),
      startTime: hrTime(span.startTime),
      endTime: hrTime(span.endTime),
      duration: hrDuration(span.startTime, span.endTime),
      status: span.status === "error"
        ? { code: SpanStatusCode.ERROR, ...(span.statusMessage ? { message: span.statusMessage } : {}) }
        : { code: span.status === "ok" ? SpanStatusCode.OK : SpanStatusCode.UNSET },
      attributes: span.attributes,
      links: [],
      events: [],
      ended: true,
      resource,
      instrumentationScope: INSTRUMENTATION_SCOPE,
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    };
  });
}

export type RunTraceExportResult =
  | { status: "disabled" }
  | { status: "empty" }
  | { status: "exported"; spans: number; droppedSpans: number }
  | { status: "failed"; spans: number; droppedSpans: number; error: string };

export interface ExportRunTraceInput {
  runId: string;
  listEvents: () => StoredRunEvent[];
  env?: NodeJS.ProcessEnv;
  createExporter?: (config: OtlpTraceConfig) => SpanExporter;
  log?: (message: string) => void;
}

async function defaultExporter(config: OtlpTraceConfig): Promise<SpanExporter> {
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-proto");
  return new OTLPTraceExporter({
    url: config.url,
    headers: config.headers,
    timeoutMillis: config.timeoutMillis,
  });
}

function exportBatch(exporter: SpanExporter, spans: ReadableSpan[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    exporter.export(spans, (result) => {
      // ExportResultCode.SUCCESS is 0.
      if (result.code === 0) resolvePromise();
      else rejectPromise(result.error ?? new Error("OTLP export failed"));
    });
  });
}

/**
 * Export one run's trace if an OTLP endpoint is configured. Never throws, and
 * returns within the configured timeout whatever the collector does.
 */
export async function exportRunTrace(input: ExportRunTraceInput): Promise<RunTraceExportResult> {
  const log = input.log ?? ((message: string) => console.error(message));
  const config = otlpTraceConfigFromEnv(input.env ?? process.env);
  if (!config) return { status: "disabled" };
  let trace: RunTraceSpans | undefined;
  try {
    trace = buildRunTraceSpans(input.listEvents(), {
      captureContent: config.captureContent,
      maxSpans: config.maxSpans,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Nitely trace export skipped for ${input.runId}: ${message}`);
    return { status: "failed", spans: 0, droppedSpans: 0, error: message };
  }
  if (!trace) return { status: "empty" };
  const spans = toReadableSpans(trace, config.serviceName);
  if (trace.droppedSpans > 0) {
    log(`Nitely trace export for ${input.runId} dropped ${trace.droppedSpans} call spans over NITELY_OTEL_MAX_SPANS=${config.maxSpans}`);
  }
  let exporter: SpanExporter | undefined;
  let timer: NodeJS.Timeout | undefined;
  const work = (async () => {
    exporter = input.createExporter ? input.createExporter(config) : await defaultExporter(config);
    for (let offset = 0; offset < spans.length; offset += EXPORT_BATCH_SIZE) {
      await exportBatch(exporter, spans.slice(offset, offset + EXPORT_BATCH_SIZE));
    }
  })();
  const deadline = new Promise<never>((_resolve, rejectPromise) => {
    timer = setTimeout(
      () => rejectPromise(new Error(`timed out after ${config.timeoutMillis}ms`)),
      config.timeoutMillis,
    );
    timer.unref?.();
  });
  try {
    await Promise.race([work, deadline]);
    return { status: "exported", spans: spans.length, droppedSpans: trace.droppedSpans };
  } catch (error) {
    // Keep a late rejection from the abandoned export from surfacing.
    work.catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    log(`Nitely trace export failed for ${input.runId}: ${message}`);
    return { status: "failed", spans: spans.length, droppedSpans: trace.droppedSpans, error: message };
  } finally {
    if (timer) clearTimeout(timer);
    void exporter?.shutdown().catch(() => undefined);
  }
}
