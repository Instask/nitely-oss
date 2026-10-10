import type { AgentRuntimeUsage } from "./types.js";

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

function addUsage(totals: PiUsageTotals, value: unknown): boolean {
  const usage = record(value);
  if (!usage) return false;
  const input = count(usage.input);
  const output = count(usage.output);
  const cacheRead = count(usage.cacheRead);
  const cacheWrite = count(usage.cacheWrite);
  totals.input += input;
  totals.output += output;
  totals.cacheRead += cacheRead;
  totals.cacheWrite += cacheWrite;
  totals.totalTokens += count(usage.totalTokens) || input + output + cacheRead + cacheWrite;
  const cost = record(usage.cost);
  if (cost && typeof cost.total === "number" && Number.isFinite(cost.total) && cost.total >= 0) {
    totals.costUsd += cost.total;
    totals.costReported = true;
  }
  return true;
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
 */
export function readPiJsonStream(
  stdout: string,
  options: { provider?: string; model?: string; observedAt?: Date } = {},
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
  let isJsonStream = false;
  let lastAssistant: Record<string, unknown> | undefined;
  let inFlightUsage: unknown;
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
    switch (event.type) {
      case "message_start":
        if (message?.role === "assistant") {
          inFlightUsage = undefined;
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
          if (addUsage(totals, message.usage)) totals.calls += 1;
          lastAssistant = message;
          finished = false;
          if (typeof message.responseModel === "string") responseModel = message.responseModel;
          else if (typeof message.model === "string") responseModel = message.model;
        }
        break;
      case "compaction_end": {
        // Summarizing the context is a model call of its own.
        if (addUsage(totals, record(event.result)?.usage)) totals.calls += 1;
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
  if (inFlightUsage !== undefined && addUsage(totals, inFlightUsage)) totals.calls += 1;

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
        source: { kind: "provider-reported", reference: "pi.json.message_end.usage" },
      },
      raw: {
        calls: totals.calls,
        uncachedInputTokens: totals.input,
        cacheReadInputTokens: totals.cacheRead,
        cacheWriteInputTokens: totals.cacheWrite,
      },
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
}): { stdout: string; stderr: string; exitCode: number; usage?: AgentRuntimeUsage } {
  const outcome = readPiJsonStream(input.stdout, {
    provider: input.runtime,
    ...(input.model ? { model: input.model } : {}),
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
  '{"type":"tool_execution_',
  '{"type":"turn_end"',
  '{"type":"turn_start"',
  '{"type":"queue_update"',
  '{"type":"entry_appended"',
  '{"type":"auto_retry_',
  '{"type":"summarization_retry_',
];
const AGENT_END_PREFIX = '{"type":"agent_end"';
const PREFIX_PROBE_BYTES = 48;
const WINDOW_CHARS = 256;

function compactPiEvent(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const message = record(event.message);
  switch (event.type) {
    case "session":
    case "agent_start":
    case "agent_settled":
      return { type: event.type };
    case "message_start":
      return message?.role === "assistant" ? { type: event.type, message: { role: "assistant" } } : undefined;
    case "message_end": {
      if (message?.role !== "assistant") return undefined;
      const content = Array.isArray(message.content)
        ? message.content.map(record).filter((block) => block?.type === "text")
        : [];
      const kept: Record<string, unknown> = { role: "assistant", content };
      for (const key of ["usage", "stopReason", "errorMessage", "model", "responseModel"]) {
        if (message[key] !== undefined) kept[key] = message[key];
      }
      return { type: event.type, message: kept };
    }
    case "compaction_end":
      return { type: event.type, result: { usage: record(event.result)?.usage } };
    case "agent_end":
      return { type: event.type, willRetry: event.willRetry === true };
    default:
      return undefined;
  }
}

/**
 * Capture Pi `--mode json` stdout in bounded memory. Pi streams one record per
 * token and per tool-output snapshot, and `agent_end` repeats the whole
 * conversation, so a long run's raw stream can reach tens of megabytes. This
 * keeps only what {@link readPiJsonStream} reads: assistant message starts and
 * ends (text blocks, usage, stop reason), the latest cumulative
 * `message_update` usage of the call in flight, compaction usage, and the
 * agent end and settle markers. Records it drops are recognized from their
 * first bytes and never buffered. Output that is not Pi JSON passes through.
 */
export function createPiJsonCapture(): PiJsonCapture {
  const decoder = new TextDecoder("utf-8");
  const out: string[] = [];
  let outBytes = 0;
  let line = "";
  // "keep": buffering a record; "drop": skipping one; "agent_end": skipping
  // one while watching for willRetry.
  let mode: "keep" | "drop" | "agent_end" | undefined;
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
          const compact = compactPiEvent(event);
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
      } else if (mode === "agent_end") {
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
      if (line || mode === "agent_end") {
        const unterminated = mode === "keep" || mode === undefined ? line : "";
        if (mode === "agent_end") {
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
