import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { MAX_CALL_LOG_ENTRIES } from "./pi-json.js";
import type { AgentRuntimeCall, AgentRuntimeUsage } from "./types.js";

/**
 * Per-model-call records for a Codex attempt, read from Codex's rollout file.
 *
 * `codex exec --json` reports one cumulative `turn.completed` usage per turn,
 * so an implement turn that ran fifty commands is one record. Codex also
 * writes a rollout under `<CODEX_HOME>/sessions/YYYY/MM/DD/
 * rollout-<timestamp>-<thread-id>.jsonl`, and that file has an
 * `event_msg`/`token_count` entry after every model call, carrying the call's
 * own usage (`info.last_token_usage`) and the thread's running total
 * (`info.total_token_usage`). Tool calls and their outputs are
 * `response_item` entries that share a `call_id`.
 *
 * Only numbers and identifiers leave this module: per-call token counts, the
 * model name from `turn_context`, tool names and call ids, the byte length of
 * each tool output, and line timestamps. Prompts, reasoning, tool inputs and
 * outputs, and paths are never copied. The file is streamed; a line longer
 * than MAX_LINE_BYTES is measured without being buffered.
 *
 * `codex exec resume` appends to the same file (measured on codex-cli
 * 0.162.0: one `session_meta`, a second `task_started`, and a running total
 * that continues from the earlier turn). Calls whose `token_count` was written
 * before this attempt started belong to earlier attempts; the last running
 * total before the attempt is its baseline.
 *
 * The `turn.completed` snapshot stays the authoritative attempt total. The
 * per-call records replace the turn records only when they add up to it: the
 * last running total must equal the snapshot, and the calls in this attempt
 * must add up to that total minus the baseline. Otherwise the turn records
 * stay and the reason is recorded. Reading the rollout never fails the attempt.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODEX_TURN_USAGE_REFERENCE = "codex.exec.turn.completed.usage";
export const CODEX_ROLLOUT_CALL_SOURCE = "codex.rollout.token_count";
/** Lines longer than this are measured, not parsed. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** Bytes kept from the start of a long line to classify it. */
const LONG_LINE_HEAD_BYTES = 4 * 1024;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_PENDING_TOOLS = 10_000;
const MAX_DAY_DIRECTORIES = 3_660;

const TOOL_CALL_TYPES = new Set(["function_call", "custom_tool_call", "local_shell_call"]);
const TOOL_OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);

interface Counts {
  input: number;
  cached: number;
  output: number;
  cacheWrite: number;
  reasoning: number;
}

export type CodexRolloutFallback =
  | "no-codex-home"
  | "no-thread-id"
  | "no-turn-usage"
  | "missing"
  | "unreadable"
  | "too-large"
  | "thread-mismatch"
  | "no-calls"
  | "total-mismatch"
  | "sum-mismatch";

export type CodexRolloutRead =
  | {
    ok: true;
    calls: AgentRuntimeCall[];
    dropped: number;
    llmCalls: number;
    toolOutputs: number;
    baseline: Counts;
    total: Counts;
    sum: Counts;
  }
  | { ok: false; fallback: CodexRolloutFallback; detail: string };

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
  if (!trimmed || trimmed.length > 80 || !/^[A-Za-z0-9_.:/@-]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function parseCounts(value: unknown): Counts | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const input = count(usage.input_tokens);
  const cached = count(usage.cached_input_tokens) ?? 0;
  const output = count(usage.output_tokens);
  if (input === undefined || output === undefined || cached > input) return undefined;
  return {
    input,
    cached,
    output,
    cacheWrite: count(usage.cache_write_input_tokens) ?? 0,
    reasoning: count(usage.reasoning_output_tokens) ?? 0,
  };
}

const ZERO: Counts = { input: 0, cached: 0, output: 0, cacheWrite: 0, reasoning: 0 };

function sameCounts(left: Counts, right: Counts): boolean {
  return left.input === right.input &&
    left.cached === right.cached &&
    left.output === right.output;
}

function addCounts(left: Counts, right: Counts): Counts {
  return {
    input: left.input + right.input,
    cached: left.cached + right.cached,
    output: left.output + right.output,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    reasoning: left.reasoning + right.reasoning,
  };
}

function timestampOf(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length > 40) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * UTF-8 bytes of what a tool returned to the model: the output string, or the
 * text and image payloads of its content items. Nothing of the content is kept.
 */
export function toolOutputBytes(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value);
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) {
      const entry = record(item);
      if (!entry) {
        total += toolOutputBytes(item);
        continue;
      }
      for (const key of ["text", "image_url", "output"] as const) {
        if (typeof entry[key] === "string") total += Buffer.byteLength(entry[key] as string);
      }
    }
    return total;
  }
  const object = record(value);
  if (object) {
    if (object.content !== undefined) return toolOutputBytes(object.content);
    if (object.output !== undefined) return toolOutputBytes(object.output);
  }
  return 0;
}

function toolOutputFailed(value: unknown): boolean {
  const object = record(value);
  return object?.success === false;
}

/** Find `rollout-*-<threadId>.jsonl` under `<codexHome>/sessions`, newest day first. */
export async function locateCodexRollout(
  codexHome: string,
  threadId: string,
): Promise<string | undefined> {
  if (!UUID_PATTERN.test(threadId)) return undefined;
  const suffix = `-${threadId.toLowerCase()}.jsonl`;
  const sessions = join(codexHome, "sessions");
  const numericDirs = async (path: string, digits: number): Promise<string[]> => {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && new RegExp(`^\\d{${digits}}$`).test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .reverse();
    } catch {
      return [];
    }
  };
  let scanned = 0;
  for (const year of await numericDirs(sessions, 4)) {
    for (const month of await numericDirs(join(sessions, year), 2)) {
      for (const day of await numericDirs(join(sessions, year, month), 2)) {
        scanned += 1;
        if (scanned > MAX_DAY_DIRECTORIES) return undefined;
        const directory = join(sessions, year, month, day);
        let names: string[];
        try {
          names = await readdir(directory);
        } catch {
          continue;
        }
        const match = names.find(
          (name) => name.startsWith("rollout-") && name.toLowerCase().endsWith(suffix),
        );
        if (match) return join(directory, match);
      }
    }
  }
  return undefined;
}

interface PendingTool {
  name: string;
  startedAt?: number;
}

/**
 * Stream a rollout and return this attempt's per-call records. `expected` is
 * the attempt's last `turn.completed` snapshot, which is the thread's running
 * total for both a fresh and a resumed attempt.
 */
export async function readCodexRollout(input: {
  path: string;
  threadId: string;
  attemptStartedAtMs: number;
  expected: Counts;
  maxFileBytes?: number;
}): Promise<CodexRolloutRead> {
  let handle;
  try {
    // A rollout is a regular file Codex wrote; never follow a link out of it.
    handle = await open(input.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { ok: false, fallback: "missing", detail: "the rollout file disappeared before it was read" }
      : { ok: false, fallback: "unreadable", detail: `the rollout file could not be opened (${code ?? "error"})` };
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return { ok: false, fallback: "unreadable", detail: "the rollout path is not a regular file" };
    }
    const maxFileBytes = input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (stats.size > maxFileBytes) {
      return {
        ok: false,
        fallback: "too-large",
        detail: `the rollout is ${stats.size} bytes, above the ${maxFileBytes}-byte read limit`,
      };
    }
    const parser = createRolloutParser({
      threadId: input.threadId.toLowerCase(),
      attemptStartedAtMs: input.attemptStartedAtMs,
    });
    const stream = handle.createReadStream({ highWaterMark: 64 * 1024, autoClose: false });
    for await (const chunk of stream) parser.write(chunk as Buffer);
    return parser.finish(input.expected);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, fallback: "unreadable", detail: `the rollout could not be read (${code ?? "error"})` };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function createRolloutParser(options: { threadId: string; attemptStartedAtMs: number }) {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let longLine: { head: Buffer; bytes: number } | undefined;

  let threadMismatch = false;
  let model: string | undefined;
  let previousTotal: Counts | undefined;
  let baseline: Counts = ZERO;
  let sum: Counts = ZERO;
  let lastTotal: Counts | undefined;
  let lastInputAt: number | undefined;
  let lastCallEndedAt: number | undefined;
  let llmCalls = 0;
  let toolOutputs = 0;
  const tools = new Map<string, PendingTool>();
  const ordered: AgentRuntimeCall[] = [];

  const inAttempt = (at: number | undefined) =>
    at !== undefined && at >= options.attemptStartedAtMs;
  const iso = (at: number | undefined) =>
    at === undefined ? undefined : new Date(at).toISOString();

  const rememberTool = (callId: string, tool: PendingTool) => {
    if (tools.size >= MAX_PENDING_TOOLS) {
      const oldest = tools.keys().next().value;
      if (oldest !== undefined) tools.delete(oldest);
    }
    tools.set(callId, tool);
  };

  const toolOutput = (
    callId: string | undefined,
    at: number | undefined,
    bytes: number,
    extra: { failed?: boolean; estimated?: boolean },
  ) => {
    if (!inAttempt(at)) return;
    const started = callId ? tools.get(callId) : undefined;
    if (callId) tools.delete(callId);
    toolOutputs += 1;
    lastInputAt = at;
    const startedAt = started?.startedAt !== undefined && at !== undefined && started.startedAt <= at
      ? started.startedAt
      : undefined;
    ordered.push({
      kind: "tool",
      toolName: started?.name ?? "unknown",
      ...(callId ? { toolCallId: callId } : {}),
      ...(startedAt !== undefined ? { startedAt: iso(startedAt), endedAt: iso(at) } : {}),
      ...(extra.failed ? { isError: true } : {}),
      outputBytes: bytes,
      ...(extra.estimated ? { outputBytesEstimated: true } : {}),
    });
  };

  const handleEvent = (event: Record<string, unknown>) => {
    const at = timestampOf(event.timestamp);
    const payload = record(event.payload);
    if (!payload) return;
    if (event.type === "session_meta") {
      const id = typeof payload.id === "string" ? payload.id.toLowerCase() : undefined;
      if (id && id !== options.threadId) threadMismatch = true;
      return;
    }
    if (event.type === "turn_context") {
      model = identifier(payload.model) ?? model;
      return;
    }
    if (event.type === "response_item") {
      const type = payload.type;
      if (typeof type !== "string") return;
      if (TOOL_CALL_TYPES.has(type)) {
        const callId = identifier(payload.call_id) ?? identifier(payload.id);
        const name = type === "local_shell_call" ? "local_shell" : identifier(payload.name) ?? "unknown";
        if (callId && inAttempt(at)) rememberTool(callId, { name, ...(at !== undefined ? { startedAt: at } : {}) });
        return;
      }
      if (TOOL_OUTPUT_TYPES.has(type)) {
        toolOutput(identifier(payload.call_id), at, toolOutputBytes(payload.output), {
          failed: toolOutputFailed(payload.output),
        });
        return;
      }
      if (type === "web_search_call") {
        if (!inAttempt(at)) return;
        ordered.push({
          kind: "tool",
          toolName: "web_search",
          ...(identifier(payload.id) ? { toolCallId: identifier(payload.id) } : {}),
        });
        return;
      }
      if (type === "message" && payload.role === "user" && inAttempt(at)) lastInputAt = at;
      return;
    }
    if (event.type !== "event_msg" || payload.type !== "token_count") return;
    const info = record(payload.info);
    if (!info) return;
    const total = parseCounts(info.total_token_usage);
    const last = parseCounts(info.last_token_usage);
    if (!total || !last) return;
    // Codex repeats a token_count without a new model call (a rate-limit
    // refresh, for one); the running total does not move.
    if (previousTotal && sameCounts(previousTotal, total)) return;
    previousTotal = total;
    if (!inAttempt(at)) {
      baseline = total;
      return;
    }
    lastTotal = total;
    sum = addCounts(sum, last);
    llmCalls += 1;
    const startedAt = lastInputAt ?? lastCallEndedAt;
    const timed = startedAt !== undefined && at !== undefined && startedAt <= at;
    ordered.push({
      kind: "llm",
      granularity: "call",
      accounting: "delta",
      provider: "openai",
      ...(model ? { model } : {}),
      ...(timed ? { startedAt: iso(startedAt), endedAt: iso(at) } : {}),
      inputTokens: last.input,
      outputTokens: last.output,
      totalTokens: last.input + last.output,
      cacheReadInputTokens: last.cached,
      cacheWriteInputTokens: last.cacheWrite,
      ...(last.reasoning > 0 ? { reasoningOutputTokens: last.reasoning } : {}),
    });
    lastCallEndedAt = at;
    lastInputAt = undefined;
  };

  // A line too long to buffer is a tool output (or a large prompt item). Its
  // type and call id come first in Codex's serialization; the size is the
  // whole line, an upper bound on the output.
  const handleLongLine = (head: string, bytes: number) => {
    const outer = /^\{"timestamp":"([^"]{1,40})"(?:,"ordinal":\d+)?,"type":"([a-z_]{1,40})","payload":\{"type":"([a-z_]{1,40})"/.exec(head);
    if (!outer || outer[2] !== "response_item" || !TOOL_OUTPUT_TYPES.has(outer[3] ?? "")) return;
    const callId = /"call_id":"([A-Za-z0-9_.:@-]{1,80})"/.exec(head)?.[1];
    toolOutput(callId, timestampOf(outer[1]), bytes, { estimated: true });
  };

  const finishLine = (line: Buffer) => {
    if (line.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.toString("utf8"));
    } catch {
      return;
    }
    const event = record(parsed);
    if (event) handleEvent(event);
  };

  const append = (piece: Buffer) => {
    if (piece.length === 0) return;
    if (longLine) {
      if (longLine.head.length < LONG_LINE_HEAD_BYTES) {
        longLine.head = Buffer.concat([longLine.head, piece.subarray(0, LONG_LINE_HEAD_BYTES - longLine.head.length)]);
      }
      longLine.bytes += piece.length;
      return;
    }
    pending.push(piece);
    pendingBytes += piece.length;
    if (pendingBytes > MAX_LINE_BYTES) {
      const joined = Buffer.concat(pending);
      longLine = { head: joined.subarray(0, LONG_LINE_HEAD_BYTES), bytes: joined.length };
      pending = [];
      pendingBytes = 0;
    }
  };

  const endLine = () => {
    if (longLine) {
      handleLongLine(longLine.head.toString("utf8"), longLine.bytes);
      longLine = undefined;
      return;
    }
    const line = pending.length === 1 ? pending[0] as Buffer : Buffer.concat(pending);
    pending = [];
    pendingBytes = 0;
    finishLine(line);
  };

  return {
    write(chunk: Buffer) {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(0x0a, start);
        if (newline === -1) {
          append(chunk.subarray(start));
          return;
        }
        append(chunk.subarray(start, newline));
        endLine();
        start = newline + 1;
      }
    },
    finish(expected: Counts): CodexRolloutRead {
      // A line still being written when the attempt ended is not complete.
      pending = [];
      longLine = undefined;
      if (threadMismatch) {
        return { ok: false, fallback: "thread-mismatch", detail: "the rollout's session id is not the attempt's thread id" };
      }
      if (llmCalls === 0 || !lastTotal) {
        return { ok: false, fallback: "no-calls", detail: "the rollout has no model calls after the attempt started" };
      }
      if (!sameCounts(lastTotal, expected)) {
        return {
          ok: false,
          fallback: "total-mismatch",
          detail: `the rollout's running total (input ${lastTotal.input}, cached ${lastTotal.cached}, output ${lastTotal.output}) is not the turn.completed snapshot (input ${expected.input}, cached ${expected.cached}, output ${expected.output})`,
        };
      }
      const share = {
        input: lastTotal.input - baseline.input,
        cached: lastTotal.cached - baseline.cached,
        output: lastTotal.output - baseline.output,
      };
      if (sum.input !== share.input || sum.cached !== share.cached || sum.output !== share.output) {
        return {
          ok: false,
          fallback: "sum-mismatch",
          detail: `the ${llmCalls} model calls add up to input ${sum.input}, cached ${sum.cached}, output ${sum.output}, not the attempt's input ${share.input}, cached ${share.cached}, output ${share.output}`,
        };
      }
      // Model calls carry the tokens; drop tool records first when the log is full.
      const overflow = Math.max(0, ordered.length - MAX_CALL_LOG_ENTRIES);
      let toolsToDrop = overflow;
      const calls: AgentRuntimeCall[] = [];
      let dropped = 0;
      for (const call of ordered) {
        if (call.kind === "tool" && toolsToDrop > 0) {
          toolsToDrop -= 1;
          dropped += 1;
          continue;
        }
        if (calls.length < MAX_CALL_LOG_ENTRIES) calls.push(call);
        else dropped += 1;
      }
      return {
        ok: true,
        calls,
        dropped,
        llmCalls,
        toolOutputs,
        baseline,
        total: lastTotal,
        sum,
      };
    },
  };
}

function snapshotOf(usage: AgentRuntimeUsage): Counts | undefined {
  const input = count(usage.inputTokens);
  const output = count(usage.outputTokens);
  if (input === undefined || output === undefined) return undefined;
  const raw = record(usage.raw);
  return {
    input,
    cached: count(usage.cachedInputTokens) ?? 0,
    output,
    cacheWrite: count(raw?.cacheWriteInputTokens) ?? 0,
    reasoning: count(raw?.reasoningOutputTokens) ?? 0,
  };
}

function withFallback(
  usage: AgentRuntimeUsage,
  fallback: CodexRolloutFallback,
  detail: string,
): AgentRuntimeUsage {
  return {
    ...usage,
    callLogSource: "codex.exec.json",
    callLogFallback: { reason: fallback, detail },
    raw: { ...(record(usage.raw) ?? {}), rolloutFallback: fallback },
  };
}

/**
 * Replace a Codex attempt's turn records with per-call records from its
 * rollout, or keep them and say why. `codexHome` is the attempt's effective
 * CODEX_HOME as this process sees it. Never throws.
 */
export async function applyCodexRolloutCalls(
  usage: AgentRuntimeUsage | undefined,
  input: { codexHome?: string; unavailableReason?: string; attemptStartedAtMs: number; maxFileBytes?: number },
): Promise<AgentRuntimeUsage | undefined> {
  if (!usage || usage.provenance?.source.reference !== CODEX_TURN_USAGE_REFERENCE) return usage;
  try {
    const raw = record(usage.raw);
    const threadId = typeof raw?.threadId === "string" ? raw.threadId : undefined;
    if (!input.codexHome) {
      return withFallback(usage, "no-codex-home", input.unavailableReason ?? "the attempt's CODEX_HOME is not visible to Nitely");
    }
    if (!threadId || !UUID_PATTERN.test(threadId)) {
      return withFallback(usage, "no-thread-id", "codex exec reported no thread id");
    }
    const expected = snapshotOf(usage);
    if (!expected) {
      return withFallback(usage, "no-turn-usage", "codex exec reported no turn.completed usage to check the calls against");
    }
    const path = await locateCodexRollout(input.codexHome, threadId);
    if (!path) {
      return withFallback(usage, "missing", "no rollout file for the attempt's thread under CODEX_HOME/sessions");
    }
    const read = await readCodexRollout({
      path,
      threadId,
      attemptStartedAtMs: input.attemptStartedAtMs,
      expected,
      ...(input.maxFileBytes !== undefined ? { maxFileBytes: input.maxFileBytes } : {}),
    });
    if (!read.ok) return withFallback(usage, read.fallback, read.detail);
    const { callLogDropped: _dropped, callLogFallback: _fallback, ...rest } = usage;
    return {
      ...rest,
      raw: {
        ...(raw ?? {}),
        calls: read.llmCalls,
        usageGranularity: "call",
        usageAccounting: "delta",
        callSource: CODEX_ROLLOUT_CALL_SOURCE,
        toolOutputs: read.toolOutputs,
      },
      callLog: read.calls,
      callLogSource: CODEX_ROLLOUT_CALL_SOURCE,
      ...(read.dropped > 0 ? { callLogDropped: read.dropped } : {}),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return withFallback(usage, "unreadable", `the rollout could not be read (${code ?? "error"})`);
  }
}

/**
 * Await an agent attempt and give its Codex usage per-call records. A
 * rejected attempt carries its partial usage on the error; that is enriched
 * too, and the original error is rethrown.
 */
export async function withCodexRolloutCalls<T extends { usage?: AgentRuntimeUsage }>(
  pending: Promise<T>,
  input: { codexHome?: string; unavailableReason?: string; attemptStartedAtMs: number } | undefined,
): Promise<T> {
  if (!input) return await pending;
  let result: T;
  try {
    result = await pending;
  } catch (error) {
    const carrier = record(error);
    if (carrier && record(carrier.usage)) {
      const usage = await applyCodexRolloutCalls(carrier.usage as AgentRuntimeUsage, input);
      if (usage) carrier.usage = usage;
    }
    throw error;
  }
  if (!result.usage) return result;
  const usage = await applyCodexRolloutCalls(result.usage, input);
  return usage ? { ...result, usage } : result;
}
