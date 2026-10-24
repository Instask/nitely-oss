import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Synthetic Codex rollout lines, shaped like codex-cli 0.162.0 writes them.
 * Every content field carries a marker so tests can prove none of it leaks.
 */
export const ROLLOUT_THREAD = "019bffff-2222-7222-8222-222222222222";
export const CONTENT_MARKER = "SEEDED-CONTENT-sk-proj-0123456789abcdef";
export const PATH_MARKER = "/home/operator/private/checkout";

export interface Usage {
  input: number;
  cached: number;
  output: number;
  reasoning?: number;
}

function usageJson(usage: Usage) {
  return {
    input_tokens: usage.input,
    cached_input_tokens: usage.cached,
    cache_write_input_tokens: 0,
    output_tokens: usage.output,
    reasoning_output_tokens: usage.reasoning ?? 0,
    total_tokens: usage.input + usage.output,
  };
}

export class RolloutBuilder {
  private readonly lines: string[] = [];
  private total: Usage = { input: 0, cached: 0, output: 0, reasoning: 0 };
  private ordinal = 0;

  constructor(private at: number, private readonly threadId = ROLLOUT_THREAD) {}

  private push(type: string, payload: unknown, stepMs = 10): this {
    this.at += stepMs;
    this.lines.push(JSON.stringify({
      timestamp: new Date(this.at).toISOString(),
      ordinal: this.ordinal++,
      type,
      payload,
    }));
    return this;
  }

  meta(id = this.threadId): this {
    return this.push("session_meta", {
      id,
      session_id: id,
      cwd: PATH_MARKER,
      cli_version: "0.162.0",
      source: "exec",
      base_instructions: { text: `instructions ${CONTENT_MARKER}` },
      git: { repository_url: `https://example.invalid/${CONTENT_MARKER}` },
    });
  }

  turn(model = "gpt-5.5-codex"): this {
    this.push("event_msg", { type: "task_started", turn_id: "turn-1" });
    this.push("response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `prompt ${CONTENT_MARKER}` }],
    });
    return this.push("turn_context", {
      cwd: PATH_MARKER,
      model,
      collaboration_mode: { settings: { developer_instructions: CONTENT_MARKER } },
    });
  }

  reasoning(): this {
    return this.push("response_item", {
      type: "reasoning",
      summary: [{ type: "summary_text", text: CONTENT_MARKER }],
      encrypted_content: CONTENT_MARKER,
    });
  }

  /** One model call: its own usage, and the running total after it. */
  call(usage: Usage, options: { repeat?: boolean; nullInfo?: boolean } = {}): this {
    this.total = {
      input: this.total.input + usage.input,
      cached: this.total.cached + usage.cached,
      output: this.total.output + usage.output,
      reasoning: (this.total.reasoning ?? 0) + (usage.reasoning ?? 0),
    };
    this.push("token_usage_record", { usage: usageJson(usage) });
    const tokenCount = () =>
      this.push("event_msg", {
        type: "token_count",
        info: {
          total_token_usage: usageJson(this.total),
          last_token_usage: usageJson(usage),
          model_context_window: 400_000,
        },
        rate_limits: { primary: { used_percent: 1 } },
      }, 500);
    if (options.nullInfo) this.push("event_msg", { type: "token_count", info: null, rate_limits: {} });
    tokenCount();
    // Codex re-sends a token_count without a new call; the total stays put.
    if (options.repeat) tokenCount();
    return this;
  }

  tool(
    callId: string,
    output: unknown,
    options: { name?: string; custom?: boolean; durationMs?: number } = {},
  ): this {
    const custom = options.custom ?? true;
    this.push("response_item", custom
      ? { type: "custom_tool_call", call_id: callId, name: options.name ?? "exec", status: "completed", input: `cat ${PATH_MARKER}/.env # ${CONTENT_MARKER}` }
      : { type: "function_call", call_id: callId, name: options.name ?? "shell", arguments: JSON.stringify({ command: ["cat", `${PATH_MARKER}/${CONTENT_MARKER}`] }) });
    return this.push("response_item", {
      type: custom ? "custom_tool_call_output" : "function_call_output",
      call_id: callId,
      output,
    }, options.durationMs ?? 200);
  }

  raw(line: string): this {
    this.lines.push(line);
    return this;
  }

  compacted(): this {
    return this.push("compacted", { message: CONTENT_MARKER, replacement_history: [] });
  }

  /** Move the clock forward, as if the next lines were written later. */
  advanceTo(at: number): this {
    this.at = Math.max(this.at, at);
    return this;
  }

  get now(): number {
    return this.at;
  }

  get runningTotal(): Usage {
    return { ...this.total };
  }

  text(): string {
    return `${this.lines.join("\n")}\n`;
  }

  async write(codexHome: string, day = "2026/10/19"): Promise<string> {
    const directory = join(codexHome, "sessions", ...day.split("/"));
    await mkdir(directory, { recursive: true });
    const path = join(directory, `rollout-2026-10-19T07-30-24-${this.threadId}.jsonl`);
    await writeFile(path, this.text());
    return path;
  }
}

/** A tool output of exactly `bytes` UTF-8 bytes, all of it marked content. */
export function outputOf(bytes: number): string {
  const marker = `${CONTENT_MARKER} `;
  return (marker.repeat(Math.ceil(bytes / marker.length))).slice(0, bytes);
}
