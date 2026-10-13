import { describe, expect, it } from "vitest";

import {
  evaluateLiveSmoke,
  planLiveSmoke,
  PROVIDER_COMPATIBILITY_MATRIX,
  type LiveSmokeContext,
} from "../../../src/providers/compatibility/index.js";

const budget = { maxTotalTokens: 5_000, maxCostUsd: 0.05, timeoutMs: 120_000 };
const trusted: LiveSmokeContext = {
  enabledProviders: ["claude", "openrouter"],
  trusted: true,
  env: { ANTHROPIC_API_KEY: "sk-ant-secret", OPENROUTER_API_KEY: "sk-or-secret" },
  budget,
};

describe("live smoke planning", () => {
  it("runs only enabled providers that have a secret and a budget", () => {
    const plan = planLiveSmoke(["claude", "openrouter", "together", "nope"], trusted);
    expect(plan.map((entry) => [entry.provider, entry.action === "run" ? "run" : entry.reason])).toEqual([
      ["claude", "run"],
      ["openrouter", "run"],
      ["together", "not-enabled"],
      ["nope", "unsupported-provider"],
    ]);
  });

  it("never runs in an untrusted context", () => {
    const plan = planLiveSmoke(["claude"], { ...trusted, trusted: false });
    expect(plan).toEqual([expect.objectContaining({ action: "skip", reason: "untrusted-context" })]);
  });

  it("skips a missing secret and a missing or invalid budget explicitly", () => {
    expect(planLiveSmoke(["claude"], { ...trusted, env: {} })[0])
      .toMatchObject({ action: "skip", reason: "missing-secret" });
    expect(planLiveSmoke(["claude"], { ...trusted, budget: undefined })[0])
      .toMatchObject({ action: "skip", reason: "missing-budget" });
    expect(planLiveSmoke(["claude"], { ...trusted, budget: { ...budget, maxCostUsd: 0 } })[0])
      .toMatchObject({ action: "skip", reason: "missing-budget" });
  });

  it("refuses a provider the matrix marks disabled", () => {
    const matrix = structuredClone(PROVIDER_COMPATIBILITY_MATRIX);
    matrix.entries.find((entry) => entry.runtime === "claude")!.status = "disabled";
    expect(planLiveSmoke(["claude"], trusted, matrix)[0])
      .toMatchObject({ action: "skip", reason: "provider-disabled" });
  });
});

describe("live smoke verdicts", () => {
  const plan = planLiveSmoke(["claude", "openrouter", "together"], trusted);
  const observation = {
    sourceSha: "c".repeat(40),
    exitCode: 0,
    latencyMs: 3_000,
    stageIds: ["implement", "verify"],
  };

  it("verifies only completed in-budget runs and keeps skips as skips", () => {
    const report = evaluateLiveSmoke({
      plan,
      observations: [
        { ...observation, provider: "claude", cliVersion: "2.0.0", usage: { totalTokens: 900, cost: { classification: "actual", usd: 0.01 } } },
        { ...observation, provider: "openrouter", usage: { totalTokens: 800, cost: { classification: "estimated", usd: 0.001 } } },
      ],
    });
    expect(report.results.map((result) => [result.provider, result.outcome])).toEqual([
      ["claude", "verified"],
      ["openrouter", "verified"],
      ["together", "skipped"],
    ]);
    expect(report.results[0]).toMatchObject({ cliVersion: "2.0.0", costProvenance: "actual", costUsd: 0.01, sourceSha: "c".repeat(40) });
    expect(report.results[1]).toMatchObject({ costProvenance: "estimated" });
    expect(report.summary).toEqual({ verified: 2, failed: 0, "blocked-budget": 0, skipped: 1 });
  });

  it("blocks a run that exceeds its token or currency cap", () => {
    const report = evaluateLiveSmoke({
      plan,
      observations: [
        { ...observation, provider: "claude", usage: { totalTokens: 9_000 } },
        { ...observation, provider: "openrouter", usage: { totalTokens: 10, cost: { classification: "estimated", usd: 1 } } },
      ],
    });
    expect(report.results.slice(0, 2).map((result) => result.outcome)).toEqual(["blocked-budget", "blocked-budget"]);
  });

  it("fails a planned run with no observation, no usage, a timeout or a non-zero exit", () => {
    const report = evaluateLiveSmoke({
      plan,
      observations: [{ ...observation, provider: "claude", exitCode: 1, stderr: "401 bad key sk-ant-secret" }],
      secrets: ["sk-ant-secret"],
    });
    expect(report.results[0]).toMatchObject({ outcome: "failed", reason: "runtime exited with code 1" });
    expect(report.results[0]!.stderrExcerpt).not.toContain("sk-ant-secret");
    expect(report.results[1]).toMatchObject({ outcome: "failed", reason: "planned run produced no observation" });

    const noUsage = evaluateLiveSmoke({ plan, observations: [{ ...observation, provider: "claude" }] });
    expect(noUsage.results[0]).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/no token usage/) });
    expect(noUsage.results[0]!.costProvenance).toBe("unknown");

    const timedOut = evaluateLiveSmoke({
      plan,
      observations: [{ ...observation, provider: "claude", timedOut: true, usage: { totalTokens: 1 } }],
    });
    expect(timedOut.results[0]!.outcome).toBe("failed");
  });
});
