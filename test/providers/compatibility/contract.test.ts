/**
 * Deterministic provider contract fixtures.
 *
 * Each fixture is a synthetic but representative capture of what a runtime's
 * CLI prints. They run against the same parsers and classifiers production
 * uses, so a parser change that breaks a provider contract fails here without
 * any live provider being called.
 */
import { describe, expect, it } from "vitest";

import {
  PROVIDER_COMPATIBILITY_MATRIX,
  providerCompatibilityEntry,
  validateProviderCompatibilityMatrix,
} from "../../../src/providers/compatibility/index.js";
import { classifyAgentRuntimeBlocker } from "../../../src/run/blockers.js";
import {
  createDefaultAgentRuntimeRegistry,
  parseRuntimeUsage,
} from "../../../src/run/execution/local.js";
import { describeOpenRouterFailure } from "../../../src/run/execution/openrouter.js";
import { readPiJsonStream } from "../../../src/run/execution/pi-json.js";
import { describeTogetherFailure } from "../../../src/run/execution/together.js";

const THREAD = "11111111-1111-4111-8111-111111111111";

function jsonl(events: unknown[]): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

const codexSuccess = jsonl([
  { type: "thread.started", thread_id: THREAD },
  { type: "turn.started" },
  { type: "item.completed", item: { type: "agent_message", text: "done" } },
  { type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 } },
]);

const claudeSuccess = `${JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  session_id: THREAD,
  usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 5, output_tokens: 4 },
  total_cost_usd: 0.01,
})}\n`;

function piStream(options: { cost?: number; stopReason?: string; settled?: boolean; tail?: string } = {}): string {
  const usage = {
    input: 100,
    output: 20,
    cacheRead: 10,
    cacheWrite: 0,
    totalTokens: 130,
    ...(options.cost !== undefined ? { cost: { total: options.cost } } : {}),
  };
  return jsonl([
    { type: "agent_start" },
    { type: "message_start", message: { role: "assistant" } },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        usage,
        stopReason: options.stopReason ?? "stop",
        ...(options.stopReason === "aborted" ? { errorMessage: "Request was aborted" } : {}),
        model: "m",
      },
    },
    ...(options.settled === false ? [] : [{ type: "agent_end" }, { type: "agent_settled" }]),
  ]) + (options.tail ?? "");
}

describe("provider compatibility matrix", () => {
  it("is internally consistent", () => {
    expect(validateProviderCompatibilityMatrix(PROVIDER_COMPATIBILITY_MATRIX)).toEqual([]);
  });

  it("covers exactly the runtimes the default registry can launch", () => {
    const registry = createDefaultAgentRuntimeRegistry();
    expect(PROVIDER_COMPATIBILITY_MATRIX.entries.map((entry) => entry.runtime).sort())
      .toEqual([...registry.supportedIds()].sort());
  });

  it("records the same credential requirements and capabilities the launcher enforces", () => {
    const registry = createDefaultAgentRuntimeRegistry();
    for (const entry of PROVIDER_COMPATIBILITY_MATRIX.entries) {
      const launcher = registry.resolve(entry.runtime);
      expect(launcher.requiredEnv ?? [], entry.runtime).toEqual(entry.auth.requiredEnv);
      expect(Boolean(launcher.sessionReuse), entry.runtime).toBe(entry.capabilities.sessionReuse);
      expect(Boolean(launcher.describeFailure), entry.runtime).toBe(entry.capabilities.failureExplanation);
      expect(Boolean(launcher.validateModel), entry.runtime).toBe(entry.capabilities.modelValidation);
    }
  });

  it("never claims live verification without recorded evidence", () => {
    const broken = structuredClone(PROVIDER_COMPATIBILITY_MATRIX);
    broken.entries[0]!.status = "live-verified";
    expect(validateProviderCompatibilityMatrix(broken)).toEqual([
      "claude is live-verified without live evidence",
    ]);
  });
});

describe("usage and cost contracts", () => {
  it("codex: provider-reported tokens with unknown cost", () => {
    const usage = parseRuntimeUsage("codex", codexSuccess)!;
    expect(usage).toMatchObject({ inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedInputTokens: 20 });
    expect(usage.cost).toBeUndefined();
    expect(usage.provenance?.source.reference).toBe(providerCompatibilityEntry("codex")!.output.usageReference);
  });

  it("codex: a failed turn or truncated JSON yields no usage instead of a guess", () => {
    expect(parseRuntimeUsage("codex", codexSuccess.replace("turn.completed", "turn.failed"))).toBeUndefined();
    expect(parseRuntimeUsage("codex", codexSuccess.slice(0, -20))).toBeUndefined();
  });

  it("claude: total_cost_usd is actual provider-reported cost", () => {
    const usage = parseRuntimeUsage("claude", claudeSuccess)!;
    expect(usage.cost).toEqual({ classification: "actual", usd: 0.01 });
    expect(providerCompatibilityEntry("claude")!.output.cost).toBe("actual");
  });

  it("claude: partial JSON yields no usage", () => {
    expect(parseRuntimeUsage("claude", claudeSuccess.slice(0, 40))).toBeUndefined();
  });

  it("pi family: cost from Pi's model pricing is estimated, never actual", () => {
    // Regression guard: Pi computes cost from its own pricing table, so it
    // must not be reported as provider-billed actual cost.
    for (const runtime of ["pi", "openrouter", "together"]) {
      const outcome = readPiJsonStream(piStream({ cost: 0.002 }), { provider: runtime });
      expect(outcome.usage?.cost, runtime).toEqual({
        classification: "estimated",
        usd: 0.002,
        method: "pi-model-pricing",
      });
      expect(providerCompatibilityEntry(runtime)!.output.cost).toBe("estimated");
    }
  });

  it("pi family: missing cost stays unknown instead of zero", () => {
    const outcome = readPiJsonStream(piStream());
    expect(outcome.usage?.totalTokens).toBe(130);
    expect(outcome.usage?.cost).toBeUndefined();
  });

  it("pi family: a cut-off trailing record is skipped and usage still counted", () => {
    const outcome = readPiJsonStream(piStream({ tail: '{"type":"message_upd' }));
    expect(outcome.text).toBe("done\n");
    expect(outcome.usage?.totalTokens).toBe(130);
  });

  it("pi family: cancellation surfaces an error and keeps the spent usage", () => {
    const outcome = readPiJsonStream(piStream({ stopReason: "aborted", settled: false }));
    expect(outcome.error).toBe("Request was aborted");
    expect(outcome.text).toBe("");
    expect(outcome.usage?.totalTokens).toBe(130);
  });
});

describe("failure classification contracts", () => {
  const cases: Array<{ runtime: string; stderr: string; reason: string | undefined }> = [
    { runtime: "claude", stderr: "Invalid API key · Please run /login", reason: "agent_credentials_invalid" },
    { runtime: "claude", stderr: "Claude AI usage limit reached|1760000000. You've hit your limit", reason: "agent_usage_limit" },
    { runtime: "codex", stderr: "401 Unauthorized: token expired", reason: "agent_credentials_invalid" },
    { runtime: "codex", stderr: "stream error: You've hit your usage limit. Try again in 3 hours.", reason: "agent_usage_limit" },
    { runtime: "codex", stderr: "spawn codex ENOENT", reason: "agent_runtime_unavailable" },
    { runtime: "codex", stderr: "error: tests failed", reason: undefined },
  ];
  for (const fixture of cases) {
    it(`${fixture.runtime}: ${fixture.reason ?? "ordinary failure"} for "${fixture.stderr.slice(0, 32)}"`, () => {
      const blocker = classifyAgentRuntimeBlocker({
        stageId: "implement",
        runtime: fixture.runtime,
        error: Object.assign(new Error("agent exited"), { stderr: fixture.stderr }),
      });
      expect(blocker?.reason).toBe(fixture.reason);
    });
  }

  it("openrouter: explanations route credential and quota failures to blockers", () => {
    const explain = (stderr: string) => describeOpenRouterFailure({ model: "x/y", stderr })!;
    const blockerFor = (stderr: string) => classifyAgentRuntimeBlocker({
      stageId: "implement",
      runtime: "openrouter",
      error: new Error(`openrouter exited with code 1: ${explain(stderr)}`),
    })?.reason;
    expect(blockerFor("401 User not found.")).toBe("agent_credentials_invalid");
    expect(blockerFor("402 Insufficient credits")).toBe("agent_usage_limit");
    expect(blockerFor("429 Rate limit exceeded")).toBe("agent_usage_limit");
    expect(blockerFor("503 Provider returned error")).toBeUndefined();
  });

  it("together: a missing provider and a rejected key have distinct explanations", () => {
    const providerMissing = describeTogetherFailure({ stderr: 'Unknown provider "together"' });
    const rejected = describeTogetherFailure({ stderr: "401 Invalid API key provided" });
    expect(providerMissing).toMatch(/no built-in Together AI provider/);
    expect(rejected).toMatch(/rejected the API key/);
  });
});
