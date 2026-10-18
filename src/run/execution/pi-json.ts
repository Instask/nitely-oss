import type { AgentRuntimeCall, AgentRuntimeUsage } from "./types.js";

/**
 * Runtimes that launch the Pi coding agent. They run Pi in JSON mode
 * (`--mode json`), whose stdout is a JSONL event stream carrying per-call
 * token usage and cost, instead of text mode, which prints only the final
 * answer.
 */
export const PI_JSON_RUNTIMES: ReadonlySet<string> = new Set(["pi", "openrouter", "together"]);

export const PI_JSON_MODE_ARGS = ["--mode", "json"] as const;

export function isPiJsonRuntime(runtime: string): boolean {
  return PI_JSON_RUNTIMES.has(runtime);
}

/**
 * Most model and tool calls one attempt keeps in its call log; later calls
 * are counted in `callLogDropped` but still summed into the totals.
 */
export const MAX_CALL_LOG_ENTRIES = 1_000;
/** Longest content string a call log entry keeps when content is captured. */
export const MAX_CALL_CONTENT_CHARS = 4_096;

/**
 * Whether the operator opted into keeping prompt, completion, and tool
 * content in call logs (and in exported traces). Off unless set to `true`.
 */
export function captureCallContent(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NITELY_OTEL_CAPTURE_CONTENT?.trim().toLowerCase() === "true";
}

export interface PiJsonOutcome {
  /** Whether stdout held at least one Pi JSON record. */
  isJsonStream: boolean;
  /**
   * What text mode would have printed: the final assistant message's text
   * blocks, each followed by a newline, once the agent finished. Empty when
   * the run was cut off or ended in an error.
   */
  text: string;
  /** Usage summed over every completed (and the in-flight) model call. */
  usage?: AgentRuntimeUsage;
  /**
   * Set when the final assistant message stopped with `error` or `aborted`.
   * Text mode prints this to stderr and exits 1; JSON mode exits 0, so the
   * caller has to turn it back into a failure.
   */
  error?: string;
}

interface PiUsageTotals {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
  costReported: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

interface PiCallUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd?: number;
}

function addUsage(totals: PiUsageTotals, value: unknown): PiCallUsage | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const input = count(usage.input);
  const output = count(usage.output);
  const cacheRead = count(usage.cacheRead);
  const cacheWrite = count(usage.cacheWrite);
  totals.input += input;
  totals.output += output;
  totals.cacheRead += cacheRead;
  totals.cacheWrite += cacheWrite;
  const totalTokens = count(usage.totalTokens) || input + output + cacheRead + cacheWrite;
  totals.totalTokens += totalTokens;
  const cost = record(usage.cost);
  let costUsd: number | undefined;
  if (cost && typeof cost.total === "number" && Number.isFinite(cost.total) && cost.total >= 0) {
    totals.costUsd += cost.total;
    totals.costReported = true;
    costUsd = cost.total;
  }
  return { input, output, cacheRead, cacheWrite, totalTokens, ...(costUsd !== undefined ? { costUsd } : {}) };
}

function observedTime(event: Record<string, unknown>): string | undefined {
  const value = event.observedAt;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : undefined;
}

function clip(value: string): string {
  return value.length > MAX_CALL_CONTENT_CHARS
    ? `${value.slice(0, MAX_CALL_CONTENT_CHARS)}…[truncated ${value.length - MAX_CALL_CONTENT_CHARS} chars]`
    : value;
}

function toolCallsOf(message: Record<string, unknown>, withArguments: boolean) {
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .map(record)
    .filter((block): block is Record<string, unknown> => block?.type === "toolCall")
    .map((block) => ({
      ...(typeof block.id === "string" ? { id: block.id } : {}),
      ...(typeof block.name === "string" ? { name: block.name } : {}),
      ...(withArguments && block.arguments !== undefined
        ? { arguments: clip(typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments)) }
        : {}),
    }));
}

function llmCall(input: {
  usage: PiCallUsage;
  startedAt?: string;
  endedAt?: string;
  message?: Record<string, unknown>;
  provider?: string;
  model?: string;
  captureContent: boolean;
  extra?: Partial<Extract<AgentRuntimeCall, { kind: "llm" }>>;
}): AgentRuntimeCall {
  const message = input.message;
  const requestModel = typeof message?.model === "string" ? message.model : input.model;
  const responseModel = typeof message?.responseModel === "string" ? message.responseModel : undefined;
  const stopReason = typeof message?.stopReason === "string" ? message.stopReason : undefined;
  const error = stopReason === "error" || stopReason === "aborted"
    ? (typeof message?.errorMessage === "string" && message.errorMessage.trim()
      ? message.errorMessage.trim()
      : `Request ${stopReason}`)
    : undefined;
  const toolCalls = message ? toolCallsOf(message, input.captureContent) : [];
  const output = input.captureContent && message ? assistantText(message) : "";
  return {
    kind: "llm",
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    ...(input.endedAt ? { endedAt: input.endedAt } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(requestModel ? { model: requestModel } : {}),
    ...(responseModel ? { responseModel } : {}),
    inputTokens: input.usage.input + input.usage.cacheRead + input.usage.cacheWrite,
    outputTokens: input.usage.output,
    totalTokens: input.usage.totalTokens,
    cacheReadInputTokens: input.usage.cacheRead,
    cacheWriteInputTokens: input.usage.cacheWrite,
    ...(input.usage.costUsd !== undefined ? { costUsd: input.usage.costUsd } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(error ? { error } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(output ? { output: clip(output) } : {}),
    ...input.extra,
  };
}

function assistantText(message: Record<string, unknown>): string {
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .map(record)
    .filter((block): block is Record<string, unknown> =>
      block?.type === "text" && typeof block.text === "string")
    .map((block) => `${block.text as string}\n`)
    .join("");
}

/**
 * Read a Pi `--mode json` stdout capture. Records are split on LF only (the
 * framing Pi documents); a record that does not parse, such as a line cut off
 * by a timeout, is skipped.
 *
 * Besides the totals, the outcome's usage carries a call log in
 * `callLog`: one entry per model call and per tool execution, in order,
 * with the times {@link createPiJsonCapture} observed (absent when reading a
 * raw stream). Content (completion text, tool arguments) is kept only with
 * `captureContent`.
 */
export function readPiJsonStream(
  stdout: string,
  options: { provider?: string; model?: string; observedAt?: Date; captureContent?: boolean } = {},
): PiJsonOutcome {
  const totals: PiUsageTotals = {
    calls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costUsd: 0,
    costReported: false,
  };
  const captureContent = options.captureContent === true;
  const callLog: AgentRuntimeCall[] = [];
  let callLogDropped = 0;
  const log = (call: AgentRuntimeCall) => {
    if (callLog.length < MAX_CALL_LOG_ENTRIES) callLog.push(call);
    else callLogDropped += 1;
  };
  const openTools = new Map<string, Extract<AgentRuntimeCall, { kind: "tool" }>>();
  let isJsonStream = false;
  let lastAssistant: Record<string, unknown> | undefined;
  let inFlightUsage: unknown;
  let inFlightStartedAt: string | undefined;
  let inFlightModel: string | undefined;
  let lastObservedAt: string | undefined;
  let finished = false;
  let responseModel: string | undefined;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) continue;
    let event: Record<string, unknown> | undefined;
    try {
      event = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (!event || typeof event.type !== "string") continue;
    isJsonStream = true;
    const message = record(event.message);
    const observedAt = observedTime(event);
    if (observedAt) lastObservedAt = observedAt;
    switch (event.type) {
      case "message_start":
        if (message?.role === "assistant") {
          inFlightUsage = undefined;
          inFlightStartedAt = observedAt;
          inFlightModel = typeof message.model === "string" ? message.model : undefined;
          finished = false;
        }
        break;
      case "message_update":
        // Cumulative usage of the assistant message still streaming.
        inFlightUsage = event.usage;
        break;
      case "message_end":
        if (message?.role === "assistant") {
          inFlightUsage = undefined;
          const usage = addUsage(totals, message.usage);
          if (usage) {
            totals.calls += 1;
            log(llmCall({
              usage,
              ...(inFlightStartedAt ? { startedAt: inFlightStartedAt } : {}),
              ...(observedAt ? { endedAt: observedAt } : {}),
              message,
              ...(options.provider ? { provider: options.provider } : {}),
              ...(options.model ? { model: options.model } : {}),
              captureContent,
            }));
          }
          inFlightStartedAt = undefined;
          lastAssistant = message;
          finished = false;
          if (typeof message.responseModel === "string") responseModel = message.responseModel;
          else if (typeof message.model === "string") responseModel = message.model;
        }
        break;
      case "compaction_end": {
        // Summarizing the context is a model call of its own.
        const usage = addUsage(totals, record(event.result)?.usage);
        if (usage) {
          totals.calls += 1;
          log(llmCall({
            usage,
            ...(observedAt ? { endedAt: observedAt } : {}),
            ...(options.provider ? { provider: options.provider } : {}),
            ...(options.model ? { model: options.model } : {}),
            captureContent,
            extra: { operation: "compaction" },
          }));
        }
        break;
      }
      case "tool_execution_start": {
        const call: Extract<AgentRuntimeCall, { kind: "tool" }> = {
          kind: "tool",
          ...(typeof event.toolCallId === "string" ? { toolCallId: event.toolCallId } : {}),
          ...(typeof event.toolName === "string" ? { toolName: event.toolName } : {}),
          ...(observedAt ? { startedAt: observedAt } : {}),
        };
        log(call);
        if (call.toolCallId) openTools.set(call.toolCallId, call);
        break;
      }
      case "tool_execution_end": {
        const id = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
        const open = id ? openTools.get(id) : undefined;
        const call = open ?? {
          kind: "tool" as const,
          ...(id ? { toolCallId: id } : {}),
          ...(typeof event.toolName === "string" ? { toolName: event.toolName } : {}),
        };
        if (!open) log(call);
        if (id) openTools.delete(id);
        if (observedAt) call.endedAt = observedAt;
        call.isError = event.isError === true;
        break;
      }
      case "agent_end":
        finished = event.willRetry !== true;
        break;
      case "agent_settled":
        finished = true;
        break;
      default:
        break;
    }
  }
  // A call cut off mid-stream (timeout, cancel, usage limit) still spent
  // what the provider reported so far.
  if (inFlightUsage !== undefined) {
    const usage = addUsage(totals, inFlightUsage);
    if (usage) {
      totals.calls += 1;
      log(llmCall({
        usage,
        ...(inFlightStartedAt ? { startedAt: inFlightStartedAt } : {}),
        ...(lastObservedAt ? { endedAt: lastObservedAt } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
        ...((inFlightModel ?? options.model) ? { model: inFlightModel ?? options.model } : {}),
        captureContent,
        extra: { incomplete: true },
      }));
    }
  }

  const stopReason = lastAssistant?.stopReason;
  const error = stopReason === "error" || stopReason === "aborted"
    ? (typeof lastAssistant?.errorMessage === "string" && lastAssistant.errorMessage.trim()
      ? lastAssistant.errorMessage.trim()
      : `Request ${stopReason}`)
    : undefined;
  const text = finished && lastAssistant && !error ? assistantText(lastAssistant) : "";

  const usage: AgentRuntimeUsage | undefined = totals.calls > 0
    ? {
      inputTokens: totals.input + totals.cacheRead + totals.cacheWrite,
      outputTokens: totals.output,
      totalTokens: totals.totalTokens,
      cachedInputTokens: totals.cacheRead,
      ...(totals.costReported
        ? {
          cost: {
            classification: "estimated" as const,
            usd: totals.costUsd,
            method: "pi-model-pricing",
          },
        }
        : {}),
      provenance: {
        provider: options.provider ?? "pi",
        ...(responseModel ?? options.model ? { model: responseModel ?? options.model } : {}),
        observedAt: (options.observedAt ?? new Date()).toISOString(),
        // Token counts come from the provider; the cost is Pi's own estimate
        // from its model pricing, which persistence accepts only as
        // calculated provenance.
        source: {
          kind: totals.costReported ? "calculated" : "provider-reported",
          reference: "pi.json.message_end.usage",
        },
      },
      raw: {
        calls: totals.calls,
        uncachedInputTokens: totals.input,
        cacheReadInputTokens: totals.cacheRead,
        cacheWriteInputTokens: totals.cacheWrite,
      },
      callLog,
      ...(callLogDropped > 0 ? { callLogDropped } : {}),
    }
    : undefined;
  return { isJsonStream, text, ...(usage ? { usage } : {}), ...(error ? { error } : {}) };
}

/**
 * Turn a Pi JSON-mode process result back into what text mode produced: the
 * final answer on stdout, a final-message error on stderr with exit code 1,
 * plus the usage the stream reported. A capture that holds no JSON records
 * (an older Pi, or a stub) is returned unchanged.
 */
export function normalizePiJsonResult(input: {
  runtime: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  model?: string;
  captureContent?: boolean;
}): { stdout: string; stderr: string; exitCode: number; usage?: AgentRuntimeUsage } {
  const outcome = readPiJsonStream(input.stdout, {
    provider: input.runtime,
    ...(input.model ? { model: input.model } : {}),
    ...(input.captureContent ? { captureContent: true } : {}),
  });
  if (!outcome.isJsonStream) {
    return { stdout: input.stdout, stderr: input.stderr, exitCode: input.exitCode };
  }
  const failed = outcome.error !== undefined;
  return {
    stdout: outcome.text,
    stderr: failed
      ? `${input.stderr}${input.stderr && !input.stderr.endsWith("\n") ? "\n" : ""}${outcome.error}\n`
      : input.stderr,
    exitCode: failed && input.exitCode === 0 ? 1 : input.exitCode,
    ...(outcome.usage ? { usage: outcome.usage } : {}),
  };
}

/** Receives a process's stdout and holds what the caller will read back. */
export interface PiJsonCapture {
  write(chunk: Buffer | string): void;
  /** Bytes held in memory now, for output caps. */
  size(): number;
  /** The captured stdout, finished: compact Pi JSONL (or raw text). */
  text(): string;
}

/** Event types whose records are dropped without being buffered. */
const DROPPED_EVENT_PREFIXES = [
  '{"type":"tool_execution_update"',
  '{"type":"turn_end"',
  '{"type":"turn_start"',
  '{"type":"queue_update"',
  '{"type":"entry_appended"',
  '{"type":"auto_retry_',
  '{"type":"summarization_retry_',
];
const AGENT_END_PREFIX = '{"type":"agent_end"';
/**
 * Tool records carry the tool's whole input or output; only their identity
 * (near the start) and error flag (near the end) are read.
 */
const TOOL_EVENT_PREFIXES = ['{"type":"tool_execution_start"', '{"type":"tool_execution_end"'];
const PREFIX_PROBE_BYTES = 48;
const WINDOW_CHARS = 256;

function compactPiEvent(
  event: Record<string, unknown>,
  observedAt: number,
  captureContent: boolean,
): Record<string, unknown> | undefined {
  const message = record(event.message);
  switch (event.type) {
    case "session":
    case "agent_start":
    case "agent_settled":
      return { type: event.type };
    case "message_start":
      return message?.role === "assistant"
        ? {
          type: event.type,
          message: { role: "assistant", ...(typeof message.model === "string" ? { model: message.model } : {}) },
          observedAt,
        }
        : undefined;
    case "message_end": {
      if (message?.role !== "assistant") return undefined;
      const content = Array.isArray(message.content)
        ? message.content.map(record).flatMap((block) => {
          if (block?.type === "text") return [block];
          if (block?.type !== "toolCall") return [];
          return [{
            type: "toolCall",
            ...(typeof block.id === "string" ? { id: block.id } : {}),
            ...(typeof block.name === "string" ? { name: block.name } : {}),
            ...(captureContent && block.arguments !== undefined ? { arguments: block.arguments } : {}),
          }];
        })
        : [];
      const kept: Record<string, unknown> = { role: "assistant", content };
      for (const key of ["usage", "stopReason", "errorMessage", "model", "responseModel"]) {
        if (message[key] !== undefined) kept[key] = message[key];
      }
      return { type: event.type, message: kept, observedAt };
    }
    case "compaction_end":
      return { type: event.type, result: { usage: record(event.result)?.usage }, observedAt };
    case "agent_end":
      return { type: event.type, willRetry: event.willRetry === true };
    default:
      return undefined;
  }
}

function stringField(window: string, name: string): string | undefined {
  const match = new RegExp(`"${name}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(window);
  if (!match?.[1]) return undefined;
  try {
    const value: unknown = JSON.parse(match[1]);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function compactToolEvent(head: string, tail: string, observedAt: number): Record<string, unknown> {
  const type = head.startsWith(TOOL_EVENT_PREFIXES[1] as string) ? "tool_execution_end" : "tool_execution_start";
  const toolCallId = stringField(head, "toolCallId");
  const toolName = stringField(head, "toolName");
  return {
    type,
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(type === "tool_execution_end" ? { isError: /"isError"\s*:\s*true\s*}?\s*$/.test(tail) } : {}),
    observedAt,
  };
}

/**
 * Capture Pi `--mode json` stdout in bounded memory. Pi streams one record per
 * token and per tool-output snapshot, and `agent_end` repeats the whole
 * conversation, so a long run's raw stream can reach tens of megabytes. This
 * keeps only what {@link readPiJsonStream} reads: assistant message starts and
 * ends (text blocks, tool-call names, usage, stop reason), the latest
 * cumulative `message_update` usage of the call in flight, compaction usage,
 * tool execution starts and ends (call id, tool name, error flag), and the
 * agent end and settle markers. Each kept call record is stamped with the time
 * it was observed (`observedAt`, epoch milliseconds). Tool-call arguments are
 * kept only with `captureContent`. Records it drops are recognized from their
 * first bytes and never buffered. Output that is not Pi JSON passes through.
 */
export function createPiJsonCapture(
  options: { captureContent?: boolean; now?: () => number } = {},
): PiJsonCapture {
  const now = options.now ?? Date.now;
  const captureContent = options.captureContent === true;
  const decoder = new TextDecoder("utf-8");
  const out: string[] = [];
  let outBytes = 0;
  let line = "";
  // "keep": buffering a record; "drop": skipping one; "agent_end": skipping
  // one while watching for willRetry; "tool": skipping one while keeping its
  // head and tail.
  let mode: "keep" | "drop" | "agent_end" | "tool" | undefined;
  let head = "";
  let tail = "";
  let pendingUpdate: string | undefined;

  const emit = (text: string) => {
    out.push(`${text}\n`);
    outBytes += Buffer.byteLength(text) + 1;
  };
  const flushUpdate = () => {
    if (pendingUpdate !== undefined) {
      emit(pendingUpdate);
      pendingUpdate = undefined;
    }
  };
  const finishLine = () => {
    if (mode === "agent_end") {
      const willRetry = /"willRetry"\s*:\s*true/.test(head) || /"willRetry"\s*:\s*true/.test(tail);
      flushUpdate();
      emit(JSON.stringify({ type: "agent_end", willRetry }));
    } else if (mode === "tool") {
      flushUpdate();
      emit(JSON.stringify(compactToolEvent(head, tail, now())));
    } else if (mode === "keep" || mode === undefined) {
      const text = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (text.trim()) {
        let event: Record<string, unknown> | undefined;
        try {
          event = record(JSON.parse(text));
        } catch {
          event = undefined;
        }
        if (!event || typeof event.type !== "string") {
          flushUpdate();
          emit(text);
        } else if (event.type === "message_update") {
          // Cumulative: only the latest one of a call matters.
          pendingUpdate = JSON.stringify({ type: "message_update", usage: event.usage });
        } else {
          const compact = compactPiEvent(event, now(), captureContent);
          if (compact) {
            flushUpdate();
            emit(JSON.stringify(compact));
          }
        }
      }
    }
    line = "";
    head = "";
    tail = "";
    mode = undefined;
  };
  const classify = () => {
    if (mode !== undefined || line.length < PREFIX_PROBE_BYTES) return;
    if (line.startsWith(AGENT_END_PREFIX)) {
      mode = "agent_end";
      head = line.slice(0, WINDOW_CHARS);
      tail = line.slice(-WINDOW_CHARS);
      line = "";
    } else if (TOOL_EVENT_PREFIXES.some((prefix) => line.startsWith(prefix))) {
      mode = "tool";
      head = line.slice(0, WINDOW_CHARS);
      tail = line.slice(-WINDOW_CHARS);
      line = "";
    } else if (DROPPED_EVENT_PREFIXES.some((prefix) => line.startsWith(prefix))) {
      mode = "drop";
      line = "";
    } else {
      mode = "keep";
    }
  };
  const append = (text: string) => {
    let rest = text;
    while (rest.length > 0) {
      const newline = rest.indexOf("\n");
      const piece = newline === -1 ? rest : rest.slice(0, newline);
      if (mode === "drop") {
        // Skip without buffering.
      } else if (mode === "agent_end" || mode === "tool") {
        if (head.length < WINDOW_CHARS) head += piece.slice(0, WINDOW_CHARS - head.length);
        tail = (tail + piece).slice(-WINDOW_CHARS);
      } else {
        line += piece;
        classify();
      }
      if (newline === -1) break;
      if (mode === undefined) classify();
      finishLine();
      rest = rest.slice(newline + 1);
    }
  };
  return {
    write(chunk) {
      append(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
    },
    size() {
      return outBytes + Buffer.byteLength(line) + (pendingUpdate ? Buffer.byteLength(pendingUpdate) : 0);
    },
    text() {
      append(decoder.decode());
      // A final record without a newline: keep it only if it is complete.
      if (line || mode === "agent_end" || mode === "tool") {
        const unterminated = mode === "keep" || mode === undefined ? line : "";
        if (mode === "agent_end" || mode === "tool") {
          mode = undefined;
          line = "";
        } else if (unterminated) {
          const candidate = unterminated.endsWith("\r") ? unterminated.slice(0, -1) : unterminated;
          let complete = !candidate.trimStart().startsWith("{");
          if (!complete) {
            try {
              JSON.parse(candidate);
              complete = true;
            } catch {
              // A record cut off by a kill or an output cap.
            }
          }
          if (complete) {
            finishLine();
          } else {
            line = "";
            mode = undefined;
          }
        }
      }
      flushUpdate();
      return out.join("");
    },
  };
}
