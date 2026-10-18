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
 * Tool records keep identity, the error flag, and the times the start and
 * end lines were observed. Command lines, paths, arguments, and message text
 * stay out of the log. A line with no observation time does not get a
 * duration filled in.
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

function observedAtOf(event: Record<string, unknown>): string | undefined {
  const value = event.observedAt;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
}

function withTimes(
  call: AgentRuntimeCall,
  startedAt: string | undefined,
  endedAt: string | undefined,
): AgentRuntimeCall {
  if (!startedAt || !endedAt) return call;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return call;
  return { ...call, startedAt, endedAt };
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
  const timeline: Array<
    | { kind: "tool"; call: AgentRuntimeCall }
    | { kind: "turn"; startedAt?: string; endedAt?: string }
  > = [];
  const toolStarts = new Map<string, string>();
  let started = 0;
  let turnStartedAt: string | undefined;
  for (const event of events) {
    if (event.type === "turn.started") {
      started += 1;
      turnStartedAt = observedAtOf(event);
      continue;
    }
    if (event.type === "turn.failed" || event.type === "error") {
      continue;
    }
    if (event.type === "turn.completed") {
      const snapshot = parseSnapshot(event.usage);
      if (!snapshot || started <= turns.length) return undefined;
      turns.push(snapshot);
      timeline.push({
        kind: "turn",
        startedAt: turnStartedAt,
        endedAt: observedAtOf(event),
      });
      turnStartedAt = undefined;
      continue;
    }
    if (event.type === "item.started") {
      const item = record(event.item);
      const id = item ? identifier(item.id) : undefined;
      const at = observedAtOf(event);
      if (
        item &&
        id &&
        at &&
        typeof item.type === "string" &&
        TOOL_ITEM_TYPES.has(item.type) &&
        !toolStarts.has(id)
      ) {
        toolStarts.set(id, at);
      }
      continue;
    }
    if (event.type === "item.completed") {
      const item = record(event.item);
      const tool = item ? toolRecord(item) : undefined;
      if (tool?.kind === "tool") {
        timeline.push({
          kind: "tool",
          call: withTimes(
            tool,
            tool.toolCallId ? toolStarts.get(tool.toolCallId) : undefined,
            observedAtOf(event),
          ),
        });
      }
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
        if (llm) ordered.push(withTimes(llm, entry.startedAt, entry.endedAt));
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

const USAGE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "cache_write_input_tokens",
  "reasoning_output_tokens",
] as const;
const ITEM_EVENT_TYPES = new Set(["item.started", "item.completed"]);
const SMALL_LINE_CHARS = 8_192;
const HEAD_CHARS = 512;
const TAIL_CHARS = 256;

function pickUsage(value: unknown): Record<string, number> {
  const usage = record(value);
  if (!usage) return {};
  const kept: Record<string, number> = {};
  for (const key of USAGE_FIELDS) {
    const parsed = count(usage[key]);
    if (parsed !== undefined) kept[key] = parsed;
  }
  return kept;
}

function itemStatus(value: unknown): "completed" | "failed" | "in_progress" | undefined {
  return value === "completed" || value === "failed" || value === "in_progress"
    ? value
    : undefined;
}

function compactItem(type: string, item: unknown): Record<string, unknown> {
  const source = record(item);
  const id = source ? identifier(source.id) : undefined;
  const itemType = source ? identifier(source.type) : undefined;
  const server = source ? identifier(source.server) : undefined;
  const tool = source ? identifier(source.tool) : undefined;
  const status = source ? itemStatus(source.status) : undefined;
  return {
    type,
    item: {
      ...(id ? { id } : {}),
      ...(itemType ? { type: itemType } : {}),
      ...(server ? { server } : {}),
      ...(tool ? { tool } : {}),
      ...(status ? { status } : {}),
    },
  };
}

function compactKeptEvent(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const type = event.type;
  if (type === "thread.started") {
    const threadId = typeof event.thread_id === "string" && UUID_PATTERN.test(event.thread_id)
      ? event.thread_id
      : undefined;
    return { type, ...(threadId ? { thread_id: threadId } : {}) };
  }
  if (type === "turn.started" || type === "turn.failed" || type === "error") {
    return { type };
  }
  if (type === "turn.completed") {
    return { type, usage: pickUsage(event.usage) };
  }
  if (type === "item.started" || type === "item.completed") {
    return compactItem(type, event.item);
  }
  if (type === "item.updated") return undefined;
  if (typeof type === "string") return { type };
  return undefined;
}

function eventTypeOf(prefix: string): string | undefined {
  const match = /^\{"type"\s*:\s*"([^"]{1,80})"/.exec(prefix);
  return match?.[1];
}

function quotedField(window: string, name: string): string | undefined {
  const match = new RegExp(`"${name}"\\s*:\\s*"([^"\\\\]{1,80})"`).exec(window);
  return match?.[1] ? identifier(match[1]) : undefined;
}

function itemField(head: string, name: string): string | undefined {
  const itemAt = head.indexOf('"item"');
  return quotedField(itemAt === -1 ? head : head.slice(itemAt), name);
}

function terminalStatus(tail: string): "completed" | "failed" | "in_progress" | undefined {
  const match = /"status"\s*:\s*"(completed|failed|in_progress)"\s*}+\s*$/.exec(tail);
  return itemStatus(match?.[1]);
}

function compactItemWindows(type: string, head: string, tail: string): Record<string, unknown> {
  const id = itemField(head, "id");
  const itemType = itemField(head, "type");
  const server = itemField(head, "server");
  const tool = itemField(head, "tool");
  const status = terminalStatus(tail);
  return {
    type,
    item: {
      ...(id ? { id } : {}),
      ...(itemType ? { type: itemType } : {}),
      ...(server ? { server } : {}),
      ...(tool ? { tool } : {}),
      ...(status ? { status } : {}),
    },
  };
}

/**
 * Capture `codex exec --json` stdout in bounded memory.
 *
 * A command result is one JSON line that can carry the whole command and its
 * output. This keeps the thread, turn, and tool identity, plus turn usage,
 * and stamps `observedAt` (epoch milliseconds) when each kept line finishes.
 * A line cut off at the end is dropped, so a later `turn.completed` is not
 * lost behind it, and a turn that never completed contributes no token counts.
 */
export function createCodexExecCapture(
  options: { now?: () => number; onLine?: (line: string) => void } = {},
): { write(chunk: Buffer | string): void; size(): number; text(): string } {
  const now = options.now ?? Date.now;
  const decoder = new TextDecoder("utf-8");
  const out: string[] = [];
  let outBytes = 0;
  let mode: "buffer" | "item" | "drop" = "buffer";
  let line = "";
  let head = "";
  let tail = "";
  let itemType = "";
  let finished = false;

  const emitLine = (text: string) => {
    out.push(`${text}\n`);
    outBytes += Buffer.byteLength(text) + 1;
    options.onLine?.(text);
  };
  const emitEvent = (value: Record<string, unknown>) => {
    emitLine(JSON.stringify({ ...value, observedAt: now() }));
  };
  const reset = () => {
    mode = "buffer";
    line = "";
    head = "";
    tail = "";
    itemType = "";
  };
  const promote = () => {
    if (mode !== "buffer" || line.length <= SMALL_LINE_CHARS) return;
    const type = eventTypeOf(line);
    if (type && ITEM_EVENT_TYPES.has(type)) {
      mode = "item";
      itemType = type;
      head = line.slice(0, HEAD_CHARS);
      tail = line.slice(-TAIL_CHARS);
      line = "";
      return;
    }
    mode = "drop";
    line = "";
  };
  const keepOverflow = (extra: string) => {
    if (mode !== "item" || extra.length === 0) return;
    if (head.length < HEAD_CHARS) head += extra.slice(0, HEAD_CHARS - head.length);
    tail = (tail + extra).slice(-TAIL_CHARS);
  };
  const finishBuffered = (text: string) => {
    if (!text.startsWith("{")) {
      emitLine(text);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      emitLine(text);
      return;
    }
    const event = record(parsed);
    const compact = event && typeof event.type === "string"
      ? compactKeptEvent(event)
      : undefined;
    if (compact) emitEvent(compact);
    else if (!event || typeof event.type !== "string") emitLine(text);
  };
  const finish = () => {
    if (mode === "item") {
      emitEvent(compactItemWindows(itemType, head, tail));
    } else if (mode === "buffer") {
      const text = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (text.trim()) finishBuffered(text);
    }
    reset();
  };
  const appendPiece = (piece: string) => {
    if (mode === "drop" || piece.length === 0) return;
    if (mode === "item") {
      if (head.length < HEAD_CHARS) head += piece.slice(0, HEAD_CHARS - head.length);
      tail = (tail + piece).slice(-TAIL_CHARS);
      return;
    }
    const room = SMALL_LINE_CHARS + 1 - line.length;
    if (piece.length <= room) {
      line += piece;
      promote();
      return;
    }
    line += piece.slice(0, Math.max(0, room));
    const extra = piece.slice(Math.max(0, room));
    promote();
    keepOverflow(extra);
  };
  const append = (text: string) => {
    let rest = text;
    while (rest.length > 0) {
      const newline = rest.indexOf("\n");
      const piece = newline === -1 ? rest : rest.slice(0, newline);
      appendPiece(piece);
      if (newline === -1) break;
      finish();
      rest = rest.slice(newline + 1);
    }
  };
  return {
    write(chunk) {
      if (finished) return;
      append(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
    },
    size() {
      return outBytes + Buffer.byteLength(line) + Buffer.byteLength(head) + Buffer.byteLength(tail);
    },
    text() {
      if (!finished) {
        finished = true;
        append(decoder.decode());
        if (mode === "buffer" && line.trim()) {
          const text = line.endsWith("\r") ? line.slice(0, -1) : line;
          if (!text.startsWith("{")) {
            emitLine(text);
            reset();
          } else {
            try {
              JSON.parse(text);
              finish();
            } catch {
              reset();
            }
          }
        } else {
          reset();
        }
      }
      return out.join("");
    },
  };
}
