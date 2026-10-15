import type { AgentRuntimeCall, AgentRuntimeUsage } from "./types.js";
import { MAX_CALL_LOG_ENTRIES } from "./pi-json.js";

/**
 * Read a `codex exec --json` stdout capture.
 *
 * `turn.completed.usage` is a cumulative session total, not one model call
 * and not a delta. Each turn becomes a call-log record whose tokens are the
 * increase since the previous snapshot, so the records add up to the last
 * snapshot. That last snapshot is the attempt total. A later snapshot that
 * is smaller than an earlier one is not split; the attempt keeps the last
 * snapshot as one cumulative record.
 *
 * Tool records are identity and error flag only. Command lines, paths,
 * arguments, and message text stay out of the log.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TOOL_ITEM_TYPES = new Set([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
]);

interface UsageSnapshot {
  input: number;
  cached: number;
  output: number;
  cacheWrite?: number;
  reasoning?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function identifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80 || /[\s\r\n]/.test(trimmed)) return undefined;
  return trimmed;
}

function parseSnapshot(value: unknown): UsageSnapshot | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const input = count(usage.input_tokens);
  const cached = count(usage.cached_input_tokens);
  const output = count(usage.output_tokens);
  if (
    input === undefined ||
    cached === undefined ||
    output === undefined ||
    cached > input
  ) {
    return undefined;
  }
  const cacheWrite = usage.cache_write_input_tokens === undefined
    ? undefined
    : count(usage.cache_write_input_tokens);
  const reasoning = usage.reasoning_output_tokens === undefined
    ? undefined
    : count(usage.reasoning_output_tokens);
  if (
    (usage.cache_write_input_tokens !== undefined && cacheWrite === undefined) ||
    (usage.reasoning_output_tokens !== undefined && reasoning === undefined) ||
    (reasoning !== undefined && reasoning > output)
  ) {
    return undefined;
  }
  const total = input + output;
  if (!Number.isSafeInteger(total)) return undefined;
  return {
    input,
    cached,
    output,
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}

function snapshotDelta(
  previous: UsageSnapshot,
  next: UsageSnapshot,
): UsageSnapshot | undefined {
  const input = next.input - previous.input;
  const cached = next.cached - previous.cached;
  const output = next.output - previous.output;
  if (input < 0 || cached < 0 || output < 0 || cached > input) return undefined;
  let cacheWrite: number | undefined;
  if (next.cacheWrite !== undefined || previous.cacheWrite !== undefined) {
    const delta = (next.cacheWrite ?? 0) - (previous.cacheWrite ?? 0);
    if (delta < 0) return undefined;
    cacheWrite = delta;
  }
  let reasoning: number | undefined;
  if (next.reasoning !== undefined || previous.reasoning !== undefined) {
    const delta = (next.reasoning ?? 0) - (previous.reasoning ?? 0);
    if (delta < 0 || delta > output) return undefined;
    reasoning = delta;
  }
  return {
    input,
    cached,
    output,
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}

function llmRecord(
  snapshot: UsageSnapshot,
  accounting: "delta" | "cumulative",
): AgentRuntimeCall {
  return {
    kind: "llm",
    granularity: "turn",
    accounting,
    provider: "openai",
    inputTokens: snapshot.input,
    outputTokens: snapshot.output,
    totalTokens: snapshot.input + snapshot.output,
    cacheReadInputTokens: snapshot.cached,
    cacheWriteInputTokens: snapshot.cacheWrite ?? 0,
    ...(snapshot.reasoning !== undefined
      ? { reasoningOutputTokens: snapshot.reasoning }
      : {}),
  };
}

function toolRecord(item: Record<string, unknown>): AgentRuntimeCall | undefined {
  const type = item.type;
  if (typeof type !== "string" || !TOOL_ITEM_TYPES.has(type)) return undefined;
  let toolName = type;
  if (type === "mcp_tool_call") {
    const server = identifier(item.server);
    const tool = identifier(item.tool);
    if (server && tool) toolName = `${server}/${tool}`;
  }
  const id = identifier(item.id);
  const status = item.status;
  return {
    kind: "tool",
    toolName,
    ...(id ? { toolCallId: id } : {}),
    ...(status === "failed" ? { isError: true } : {}),
  };
}

function pushCall(
  calls: AgentRuntimeCall[],
  call: AgentRuntimeCall,
): number {
  if (calls.length < MAX_CALL_LOG_ENTRIES) {
    calls.push(call);
    return 0;
  }
  return 1;
}

export function readCodexExecActivity(stdout: string): AgentRuntimeUsage | undefined {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return undefined;
  const events: Record<string, unknown>[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const event = record(JSON.parse(lines[index] ?? ""));
      if (!event || typeof event.type !== "string") return undefined;
      events.push(event);
    } catch {
      // A capture cut off on the last line still has the turns before it.
      if (index === lines.length - 1) break;
      return undefined;
    }
  }
  const first = events[0];
  if (
    !first ||
    first.type !== "thread.started" ||
    typeof first.thread_id !== "string" ||
    !UUID_PATTERN.test(first.thread_id) ||
    events.filter((event) => event.type === "thread.started").length !== 1
  ) {
    return undefined;
  }

  const turns: UsageSnapshot[] = [];
  const timeline: Array<{ kind: "tool"; call: AgentRuntimeCall } | { kind: "turn" }> = [];
  let started = 0;
  for (const event of events) {
    if (event.type === "turn.started") {
      started += 1;
      continue;
    }
    if (event.type === "turn.failed" || event.type === "error") {
      continue;
    }
    if (event.type === "turn.completed") {
      const snapshot = parseSnapshot(event.usage);
      if (!snapshot || started <= turns.length) return undefined;
      turns.push(snapshot);
      timeline.push({ kind: "turn" });
      continue;
    }
    if (event.type === "item.completed") {
      const item = record(event.item);
      const tool = item ? toolRecord(item) : undefined;
      if (tool) timeline.push({ kind: "tool", call: tool });
    }
  }
  if (turns.length === 0 || started < turns.length) return undefined;

  const last = turns[turns.length - 1];
  if (!last) return undefined;
  const deltas: UsageSnapshot[] = [];
  let previous: UsageSnapshot = {
    input: 0,
    cached: 0,
    output: 0,
  };
  let monotonic = true;
  for (const turn of turns) {
    const delta = snapshotDelta(previous, turn);
    if (!delta) {
      monotonic = false;
      break;
    }
    deltas.push(delta);
    previous = {
      input: turn.input,
      cached: turn.cached,
      output: turn.output,
      ...(turn.cacheWrite !== undefined || previous.cacheWrite !== undefined
        ? { cacheWrite: turn.cacheWrite ?? previous.cacheWrite ?? 0 }
        : {}),
      ...(turn.reasoning !== undefined || previous.reasoning !== undefined
        ? { reasoning: turn.reasoning ?? previous.reasoning ?? 0 }
        : {}),
    };
  }

  const llmRecords = monotonic
    ? deltas.map((delta) => llmRecord(delta, "delta"))
    : [llmRecord(last, "cumulative")];
  const ordered: AgentRuntimeCall[] = [];
  if (monotonic) {
    let turnIndex = 0;
    for (const entry of timeline) {
      if (entry.kind === "turn") {
        const llm = llmRecords[turnIndex];
        turnIndex += 1;
        if (llm) ordered.push(llm);
      } else {
        ordered.push(entry.call);
      }
    }
  } else {
    ordered.push(llmRecords[0] as AgentRuntimeCall);
    for (const entry of timeline) {
      if (entry.kind === "tool") ordered.push(entry.call);
    }
  }
  // Turn records carry the tokens. Drop tool records first when the log is full.
  const kept: AgentRuntimeCall[] = [];
  let dropped = 0;
  const overflow = Math.max(0, ordered.length - MAX_CALL_LOG_ENTRIES);
  let toolsLeftToDrop = overflow;
  for (const call of ordered) {
    if (call.kind === "tool" && toolsLeftToDrop > 0) {
      toolsLeftToDrop -= 1;
      dropped += 1;
      continue;
    }
    dropped += pushCall(kept, call);
  }

  const raw: Record<string, number | string> = {
    cachedInputTokens: last.cached,
    calls: turns.length,
    usageGranularity: "turn",
    usageAccounting: monotonic ? "cumulative-delta" : "cumulative",
  };
  if (last.cacheWrite !== undefined) raw.cacheWriteInputTokens = last.cacheWrite;
  if (last.reasoning !== undefined) raw.reasoningOutputTokens = last.reasoning;

  return {
    inputTokens: last.input,
    outputTokens: last.output,
    totalTokens: last.input + last.output,
    cachedInputTokens: last.cached,
    provenance: {
      provider: "openai",
      observedAt: new Date().toISOString(),
      source: {
        kind: "provider-reported",
        reference: "codex.exec.turn.completed.usage",
      },
    },
    raw,
    callLog: kept,
    ...(dropped > 0 ? { callLogDropped: dropped } : {}),
  };
}
