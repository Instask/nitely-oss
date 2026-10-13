import { redactText } from "../../context/redaction.js";
import {
  PROVIDER_COMPATIBILITY_MATRIX,
  providerCompatibilityEntry,
  type ProviderCompatibilityMatrix,
} from "./matrix.js";

/**
 * Planning and verdicts for opt-in live provider smoke runs.
 *
 * A live smoke spends real money, so it only runs when explicitly enabled, in
 * a trusted context (never a fork pull request), with a credential present and
 * an explicit per-run token and currency cap. Every provider that does not run
 * gets a recorded skip reason, and only a provider whose run completed inside
 * its token and proven USD budget with usage provenance is reported as verified.
 */

export const LIVE_SMOKE_REPORT_SCHEMA = "nitely.provider-live-smoke.v1";

export interface LiveSmokeBudget {
  maxTotalTokens: number;
  maxCostUsd: number;
  timeoutMs: number;
}

export interface LiveSmokeContext {
  /** Providers the operator named for this run. Empty means none. */
  enabledProviders: readonly string[];
  /** False for pull requests from forks or any untrusted trigger. */
  trusted: boolean;
  env: Readonly<Record<string, string | undefined>>;
  budget?: Partial<LiveSmokeBudget>;
}

export type LiveSmokeSkipReason =
  | "not-enabled"
  | "untrusted-context"
  | "unsupported-provider"
  | "provider-disabled"
  | "missing-secret"
  | "missing-budget";

export type LiveSmokePlanEntry =
  | { provider: string; action: "run"; budget: LiveSmokeBudget }
  | { provider: string; action: "skip"; reason: LiveSmokeSkipReason; detail: string };

function validBudget(budget: Partial<LiveSmokeBudget> | undefined): LiveSmokeBudget | undefined {
  if (!budget) return undefined;
  const { maxTotalTokens, maxCostUsd, timeoutMs } = budget;
  if (
    typeof maxTotalTokens !== "number" || !Number.isSafeInteger(maxTotalTokens) || maxTotalTokens <= 0 ||
    typeof maxCostUsd !== "number" || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0 ||
    typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
  ) {
    return undefined;
  }
  return { maxTotalTokens, maxCostUsd, timeoutMs };
}

/** Decides, per provider, whether a live smoke may run and why not. */
export function planLiveSmoke(
  providers: readonly string[],
  context: LiveSmokeContext,
  matrix: ProviderCompatibilityMatrix = PROVIDER_COMPATIBILITY_MATRIX,
): LiveSmokePlanEntry[] {
  const budget = validBudget(context.budget);
  return providers.map((provider): LiveSmokePlanEntry => {
    const skip = (reason: LiveSmokeSkipReason, detail: string): LiveSmokePlanEntry =>
      ({ provider, action: "skip", reason, detail });
    const entry = providerCompatibilityEntry(provider, matrix);
    if (!entry) return skip("unsupported-provider", `${provider} is not in the compatibility matrix`);
    if (entry.status === "disabled") return skip("provider-disabled", entry.degradation);
    if (!context.enabledProviders.includes(provider)) {
      return skip("not-enabled", "live smoke for this provider was not requested");
    }
    if (!context.trusted) {
      return skip("untrusted-context", "live smoke never runs with provider secrets in an untrusted context");
    }
    if (!budget) {
      return skip("missing-budget", "an explicit token, currency and timeout cap is required");
    }
    const missing = entry.auth.requiredEnv.filter(
      (alternatives) => !alternatives.some((name) => Boolean(context.env[name]?.trim())),
    );
    if (missing.length > 0) {
      return skip(
        "missing-secret",
        `missing ${missing.map((names) => names.join(" or ")).join("; ")}`,
      );
    }
    return { provider, action: "run", budget };
  });
}

export interface LiveSmokeObservation {
  provider: string;
  cliVersion?: string;
  sourceSha: string;
  exitCode: number | null;
  timedOut?: boolean;
  latencyMs: number;
  stageIds: string[];
  usage?: {
    totalTokens?: number;
    cost?: { classification: "actual" | "estimated"; usd: number } | { classification: "unknown" };
  };
  /** Runtime output; only a redacted excerpt is kept in the report. */
  stderr?: string;
}

export type LiveSmokeOutcome =
  | "verified"
  | "failed"
  | "blocked-budget"
  /**
   * Ran within the token cap, but the USD cap cannot be shown to hold: cost
   * was unknown, or only an estimate that is not a reliable upper bound.
   * Never counted as verified.
   */
  | "unverified-budget"
  | "skipped";

export interface LiveSmokeResult {
  provider: string;
  outcome: LiveSmokeOutcome;
  reason: string;
  cliVersion?: string;
  sourceSha?: string;
  latencyMs?: number;
  stageIds?: string[];
  totalTokens?: number;
  costUsd?: number;
  costProvenance?: "actual" | "estimated" | "unknown";
  stderrExcerpt?: string;
}

export interface LiveSmokeReport {
  schemaVersion: typeof LIVE_SMOKE_REPORT_SCHEMA;
  matrixRevision: number;
  results: LiveSmokeResult[];
  summary: Record<LiveSmokeOutcome, number>;
}

const STDERR_EXCERPT_CHARACTERS = 2_000;

/**
 * Turns a plan and the observed runs into a report. A provider is verified only
 * when it was planned to run, ran to exit 0 without timing out, reported token
 * usage, and stayed within the token and (when known) currency cap. Unknown
 * cost is reported as unknown, never as zero.
 */
export function evaluateLiveSmoke(input: {
  plan: readonly LiveSmokePlanEntry[];
  observations: readonly LiveSmokeObservation[];
  secrets?: readonly string[];
  matrix?: ProviderCompatibilityMatrix;
}): LiveSmokeReport {
  const matrix = input.matrix ?? PROVIDER_COMPATIBILITY_MATRIX;
  const secrets = (input.secrets ?? []).filter((entry) => entry.length > 0);
  const results = input.plan.map((entry): LiveSmokeResult => {
    if (entry.action === "skip") {
      return { provider: entry.provider, outcome: "skipped", reason: `${entry.reason}: ${entry.detail}` };
    }
    const observation = input.observations.find((candidate) => candidate.provider === entry.provider);
    if (!observation) {
      return { provider: entry.provider, outcome: "failed", reason: "planned run produced no observation" };
    }
    const costProvenance = observation.usage?.cost?.classification ?? "unknown";
    const costUsd = observation.usage?.cost && observation.usage.cost.classification !== "unknown"
      ? observation.usage.cost.usd
      : undefined;
    const base = {
      provider: entry.provider,
      ...(observation.cliVersion ? { cliVersion: observation.cliVersion } : {}),
      sourceSha: observation.sourceSha,
      latencyMs: observation.latencyMs,
      stageIds: observation.stageIds,
      ...(observation.usage?.totalTokens !== undefined ? { totalTokens: observation.usage.totalTokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      costProvenance,
      ...(observation.stderr
        ? { stderrExcerpt: redactSecrets(observation.stderr, secrets).slice(-STDERR_EXCERPT_CHARACTERS) }
        : {}),
    } satisfies Omit<LiveSmokeResult, "outcome" | "reason">;
    const tokens = observation.usage?.totalTokens;
    if (tokens !== undefined && tokens > entry.budget.maxTotalTokens) {
      return { ...base, outcome: "blocked-budget", reason: `used ${tokens} tokens; cap is ${entry.budget.maxTotalTokens}` };
    }
    if (costUsd !== undefined && costUsd > entry.budget.maxCostUsd) {
      return { ...base, outcome: "blocked-budget", reason: `cost ${costUsd} USD exceeds cap ${entry.budget.maxCostUsd} USD` };
    }
    if (observation.timedOut || observation.latencyMs > entry.budget.timeoutMs) {
      return { ...base, outcome: "failed", reason: `exceeded the ${entry.budget.timeoutMs} ms timeout` };
    }
    if (observation.exitCode !== 0) {
      return { ...base, outcome: "failed", reason: `runtime exited with code ${observation.exitCode}` };
    }
    if (tokens === undefined) {
      const expected = providerCompatibilityEntry(entry.provider, matrix)?.output.tokenUsage;
      if (expected === "provider-reported") {
        return { ...base, outcome: "failed", reason: "runtime reported no token usage; usage parsing may have regressed" };
      }
      return { ...base, outcome: "failed", reason: "token usage is unknown, so the token cap cannot be shown to hold" };
    }
    if (costProvenance === "unknown" || costUsd === undefined) {
      return { ...base, outcome: "unverified-budget", reason: `cost is unknown, so the ${entry.budget.maxCostUsd} USD cap cannot be shown to hold` };
    }
    if (costProvenance === "estimated" && !providerCompatibilityEntry(entry.provider, matrix)?.output.estimatedCostIsUpperBound) {
      return { ...base, outcome: "unverified-budget", reason: `cost ${costUsd} USD is an estimate that is not a reliable upper bound, so the ${entry.budget.maxCostUsd} USD cap cannot be shown to hold` };
    }
    return { ...base, outcome: "verified", reason: "completed within budget" };
  });
  const summary: Record<LiveSmokeOutcome, number> = {
    verified: 0,
    failed: 0,
    "blocked-budget": 0,
    "unverified-budget": 0,
    skipped: 0,
  };
  for (const result of results) summary[result.outcome] += 1;
  return { schemaVersion: LIVE_SMOKE_REPORT_SCHEMA, matrixRevision: matrix.revision, results, summary };
}

function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = redactText(text, [...secrets]) ?? text;
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}
