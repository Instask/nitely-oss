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
