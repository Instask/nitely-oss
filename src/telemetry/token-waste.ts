import type { AgentRuntimeCall } from "../run/execution/types.js";

export interface RuntimeActivitySummary {
  llmRecords: number;
  granularities: Array<"call" | "turn" | "attempt">;
  /** True when every model record is a delta that can be added. */
  summable: boolean;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  cacheWriteInputTokens: number;
  toolCount: number;
  toolErrors: number;
  toolNames: Array<{ name: string; count: number }>;
}

function llmCalls(calls: readonly AgentRuntimeCall[]) {
  return calls.filter((call) => call.kind === "llm");
}

/**
 * Add model records that are safe to add. A cumulative snapshot is the whole
 * attempt only when it is the sole model record; otherwise it is left out so
 * sibling snapshots are not counted twice.
 */
export function summarizeRuntimeCalls(
  calls: readonly AgentRuntimeCall[],
): RuntimeActivitySummary | undefined {
  const models = llmCalls(calls);
  if (models.length === 0) return undefined;
  const cumulative = models.filter((call) => call.accounting === "cumulative");
  const summable = cumulative.length === 0 ||
    (cumulative.length === 1 && models.length === 1);
  const counted = summable
    ? models
    : models.filter((call) => call.accounting !== "cumulative");
  const totals = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    cacheWriteInputTokens: 0,
  };
  const granularities = new Set<"call" | "turn" | "attempt">();
  for (const call of counted) {
    totals.inputTokens += call.inputTokens;
    totals.cachedInputTokens += call.cacheReadInputTokens;
    totals.outputTokens += call.outputTokens;
    totals.reasoningOutputTokens += call.reasoningOutputTokens ?? 0;
    totals.cacheWriteInputTokens += call.cacheWriteInputTokens;
    granularities.add(call.granularity ?? "call");
  }
  const names = new Map<string, number>();
  let toolCount = 0;
  let toolErrors = 0;
  for (const call of calls) {
    if (call.kind !== "tool") continue;
    toolCount += 1;
    if (call.isError) toolErrors += 1;
    const name = call.toolName ?? "unknown";
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  return {
    llmRecords: models.length,
    granularities: [...granularities],
    summable,
    ...totals,
    toolCount,
    toolErrors,
    toolNames: [...names.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
  };
}

/** A rough byte-to-token ratio for tool output text; English and code land near it. */
export const APPROX_BYTES_PER_TOKEN = 4;

export interface ResentToolOutput {
  toolName: string;
  outputBytes: number;
  /** `ceil(outputBytes / APPROX_BYTES_PER_TOKEN)`. */
  approxTokens: number;
  /** Later model calls this output was still attributed to. */
  laterCalls: number;
  /** Upper-bound cache-read tokens attributed to this output across those calls. */
  estimatedUpperBoundTokens: number;
}

export interface ResentToolOutputSummary {
  modelCalls: number;
  cachedInputTokens: number;
  inputTokens: number;
  largeOutputs: ResentToolOutput[];
  /**
   * Upper bound on the cache-read tokens that large tool outputs account for.
   * Never more than the cache-read tokens of the calls it is drawn from.
   */
  estimatedUpperBoundResentCachedTokens: number;
  /** Model calls after the first whose new tool output was below the tiny threshold. */
  tinyNewInputCalls: number;
  /** Cache-read tokens those calls read. */
  tinyNewInputCallCachedTokens: number;
}

/**
 * An upper-bound, heuristic attribution of a call-level attempt's cached input
 * to the large tool outputs it may have resent.
 *
 * The rollout does not say what each call's cached prefix contained, so this
 * only bounds it. A large output is estimated at `ceil(bytes / 4)` tokens. On
 * every model call after the one that first read it, the output stays
 * attributable only while the call's input is at least the input of the call
 * before the output plus the output's estimated tokens; the first call below
 * that ends its attribution for good, since the output may have been dropped,
 * truncated, or compacted. Each call contributes at most its own cache-read
 * tokens, shared among the outputs still attributable to it in the order they
 * arrived, so a call with no cache reads contributes nothing.
 *
 * Needs records with `granularity: "call"` and tool records with
 * `outputBytes`; returns undefined otherwise.
 */
export function summarizeResentToolOutputs(
  calls: readonly AgentRuntimeCall[],
  options: { largeOutputBytes: number; tinyNewInputBytes: number },
): ResentToolOutputSummary | undefined {
  const models = llmCalls(calls);
  if (
    models.length === 0 ||
    models.some((call) => call.granularity !== "call" || call.accounting === "cumulative") ||
    !calls.some((call) => call.kind === "tool" && call.outputBytes !== undefined)
  ) {
    return undefined;
  }
  interface Tracked {
    entry: ResentToolOutput;
    /** Input of the model call before this output arrived. */
    baseInput: number;
    /** False until the call that reads it first has passed. */
    read: boolean;
  }
  let live: Tracked[] = [];
  const large: ResentToolOutput[] = [];
  let newBytes = 0;
  let previousInput = 0;
  let modelIndex = 0;
  let tinyNewInputCalls = 0;
  let tinyNewInputCallCachedTokens = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let attributed = 0;
  for (const call of calls) {
    if (call.kind === "tool") {
      const bytes = call.outputBytes ?? 0;
      newBytes += bytes;
      if (bytes >= options.largeOutputBytes) {
        const entry: ResentToolOutput = {
          toolName: call.toolName ?? "unknown",
          outputBytes: bytes,
          approxTokens: Math.ceil(bytes / APPROX_BYTES_PER_TOKEN),
          laterCalls: 0,
          estimatedUpperBoundTokens: 0,
        };
        large.push(entry);
        live.push({ entry, baseInput: previousInput, read: false });
      }
      continue;
    }
    inputTokens += call.inputTokens;
    cachedInputTokens += call.cacheReadInputTokens;
    let cacheLeft = call.cacheReadInputTokens;
    const still: Tracked[] = [];
    for (const tracked of live) {
      if (call.inputTokens < tracked.baseInput + tracked.entry.approxTokens) continue;
      still.push(tracked);
      if (!tracked.read) {
        tracked.read = true;
        continue;
      }
      const share = Math.min(tracked.entry.approxTokens, cacheLeft);
      cacheLeft -= share;
      attributed += share;
      tracked.entry.estimatedUpperBoundTokens += share;
      if (share > 0) tracked.entry.laterCalls += 1;
    }
    live = still;
    if (modelIndex > 0 && newBytes < options.tinyNewInputBytes) {
      tinyNewInputCalls += 1;
      tinyNewInputCallCachedTokens += call.cacheReadInputTokens;
    }
    newBytes = 0;
    previousInput = call.inputTokens;
    modelIndex += 1;
  }
  return {
    modelCalls: models.length,
    inputTokens,
    cachedInputTokens,
    largeOutputs: large,
    estimatedUpperBoundResentCachedTokens: attributed,
    tinyNewInputCalls,
    tinyNewInputCallCachedTokens,
  };
}

function compactTokens(value: number): string {
  return value >= 1000 ? `${Math.round(value / 100) / 10}k` : String(value);
}

/**
 * One line describing an attempt's `stage.runtime.calls` payload: per-call
 * input curve and tool output sizes when the records are per call, or the
 * reason they are not. Numbers and tool counts only.
 */
export function formatModelCallCurve(payload: Record<string, unknown>): string | undefined {
  const raw = Array.isArray(payload.calls) ? payload.calls : [];
  const calls = raw.filter((entry): entry is AgentRuntimeCall => {
    const kind = typeof entry === "object" && entry !== null ? (entry as { kind?: unknown }).kind : undefined;
    return kind === "llm" || kind === "tool";
  });
  const models = llmCalls(calls);
  const fallback = typeof payload.fallback === "object" && payload.fallback !== null
    ? (payload.fallback as { reason?: unknown }).reason
    : undefined;
  if (models.length === 0) return undefined;
  if (models.some((call) => call.granularity !== "call")) {
    const granularity = models[0]?.granularity ?? "call";
    return `${models.length} ${granularity} record${models.length === 1 ? "" : "s"}, no per-call split` +
      (typeof fallback === "string" ? ` (rollout: ${fallback})` : "");
  }
  const inputs = models.map((call) => call.inputTokens);
  const first = inputs[0] ?? 0;
  const last = inputs[inputs.length - 1] ?? 0;
  const peak = Math.max(...inputs);
  const tools = calls.filter((call) => call.kind === "tool");
  const measured = tools.filter((call) => call.outputBytes !== undefined);
  const outputBytes = measured.reduce((total, call) => total + (call.outputBytes ?? 0), 0);
  const large = measured.filter((call) => (call.outputBytes ?? 0) >= 8 * 1024).length;
  const step = Math.max(1, Math.ceil(inputs.length / 24));
  const sampled = inputs.filter((_, index) => index % step === 0).map(compactTokens).join(" ");
  const parts = [
    `${models.length} model call${models.length === 1 ? "" : "s"}`,
    `input per call ${compactTokens(first)} → ${compactTokens(last)} (peak ${compactTokens(peak)})`,
    measured.length > 0
      ? `${measured.length} tool outputs, ${Math.round(outputBytes / 1024)} KB (${large} ≥ 8 KB)`
      : `${tools.length} tool records`,
    `curve${step > 1 ? ` (1 in ${step})` : ""}: ${sampled}`,
  ];
  return parts.join(" · ");
}
