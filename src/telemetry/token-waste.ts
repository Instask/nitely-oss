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
