/**
 * Versioned provider/runtime compatibility matrix.
 *
 * Each entry states what Nitely knows about one agent runtime: how it is
 * launched, which credentials it needs, what its output carries, how cost is
 * classified, and whether any real CLI has been verified against it. A row is
 * "contract-tested" when deterministic fixtures cover it and "live-verified"
 * only when a recorded live smoke run passed for a named CLI version. Nothing
 * in this file is evidence of a live run by itself.
 */

export const PROVIDER_COMPATIBILITY_SCHEMA = "nitely.provider-compatibility.v1";

export type ProviderSupportStatus =
  /** Covered by deterministic contract fixtures; no recorded live run. */
  | "contract-tested"
  /** Contract-tested and a live smoke run passed for `liveVerified`. */
  | "live-verified"
  /** Launchable but without contract fixtures; use at your own risk. */
  | "experimental"
  /** Known broken; preflight should refuse it. See `degradation`. */
  | "disabled";

export type ProviderCostClassification = "actual" | "estimated" | "unknown";

export interface ProviderCompatibilityEntry {
  runtime: string;
  /** CLI the runtime launches, and the env var that overrides it. */
  cli: { command: string; overrideEnv: string };
  /** Credential sources; any one name in an inner list satisfies it. */
  auth: {
    kind: "api-key-env" | "cli-login" | "api-key-or-oauth-env";
    requiredEnv: string[][];
  };
  output: {
    format: "codex-jsonl" | "claude-json" | "pi-jsonl" | "text";
    tokenUsage: "provider-reported" | "none";
    cost: ProviderCostClassification;
    /**
     * True only when an "estimated" cost is a reliable upper bound on what the
     * provider bills (for example, priced at the maximum published rate). Live
     * smoke treats an estimate without this flag as not proving the USD cap.
     */
    estimatedCostIsUpperBound?: boolean;
    /** Where usage provenance points, when usage is reported. */
    usageReference?: string;
  };
  capabilities: {
    sessionReuse: boolean;
    failureExplanation: boolean;
    modelValidation: boolean;
  };
  status: ProviderSupportStatus;
  /** Set only from a recorded, passing live smoke run. */
  liveVerified?: { cliVersion: string; verifiedAt: string; evidenceSha256: string };
  /** What happens to stages on this runtime when the provider breaks. */
  degradation: string;
}

export interface ProviderCompatibilityMatrix {
  schemaVersion: typeof PROVIDER_COMPATIBILITY_SCHEMA;
  revision: number;
  entries: ProviderCompatibilityEntry[];
}

const BLOCK_ON_PROVIDER_FAILURE =
  "Credential and quota failures block the run for the operator instead of retrying; other failures follow the stage retry and fallback policy. Mark the row disabled to make preflight refuse it.";

export const PROVIDER_COMPATIBILITY_MATRIX: ProviderCompatibilityMatrix = {
  schemaVersion: PROVIDER_COMPATIBILITY_SCHEMA,
  revision: 1,
  entries: [
    {
      runtime: "claude",
      cli: { command: "claude", overrideEnv: "NITELY_CLAUDE_COMMAND" },
      auth: {
        kind: "api-key-or-oauth-env",
        requiredEnv: [["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]],
      },
      output: {
        format: "claude-json",
        tokenUsage: "provider-reported",
        cost: "actual",
        usageReference: "claude.print.json.usage",
      },
      capabilities: { sessionReuse: false, failureExplanation: false, modelValidation: false },
      status: "contract-tested",
      degradation: BLOCK_ON_PROVIDER_FAILURE,
    },
    {
      runtime: "codex",
      cli: { command: "codex", overrideEnv: "NITELY_CODEX_COMMAND" },
      auth: { kind: "cli-login", requiredEnv: [] },
      output: {
        format: "codex-jsonl",
        tokenUsage: "provider-reported",
        cost: "unknown",
        usageReference: "codex.exec.turn.completed.usage",
      },
      capabilities: { sessionReuse: true, failureExplanation: true, modelValidation: false },
      status: "contract-tested",
      degradation: BLOCK_ON_PROVIDER_FAILURE,
    },
    {
      runtime: "glm",
      cli: { command: "glm", overrideEnv: "NITELY_GLM_COMMAND" },
      auth: {
        kind: "api-key-env",
        requiredEnv: [["NITELY_GLM_API_KEY", "GLM_API_KEY", "ZHIPUAI_API_KEY"]],
      },
      output: { format: "text", tokenUsage: "none", cost: "unknown" },
      capabilities: { sessionReuse: false, failureExplanation: false, modelValidation: false },
      status: "experimental",
      degradation: BLOCK_ON_PROVIDER_FAILURE,
    },
    {
      runtime: "grok",
      cli: { command: "grok", overrideEnv: "NITELY_GROK_COMMAND" },
      auth: { kind: "cli-login", requiredEnv: [] },
      output: { format: "text", tokenUsage: "none", cost: "unknown" },
      capabilities: { sessionReuse: false, failureExplanation: false, modelValidation: false },
      status: "experimental",
      degradation: BLOCK_ON_PROVIDER_FAILURE,
    },
    {
      runtime: "openrouter",
      cli: { command: "pi", overrideEnv: "NITELY_PI_COMMAND" },
      auth: { kind: "api-key-env", requiredEnv: [["OPENROUTER_API_KEY"]] },
      output: {
        format: "pi-jsonl",
        tokenUsage: "provider-reported",
        cost: "estimated",
        usageReference: "pi.json.message_end.usage",
      },
      capabilities: { sessionReuse: false, failureExplanation: true, modelValidation: true },
      status: "contract-tested",
      degradation: BLOCK_ON_PROVIDER_FAILURE,
    },
    {
      runtime: "pi",
      cli: { command: "pi", overrideEnv: "NITELY_PI_COMMAND" },
      auth: { kind: "cli-login", requiredEnv: [] },
      output: {
        format: "pi-jsonl",
        tokenUsage: "provider-reported",
        cost: "estimated",
        usageReference: "pi.json.message_end.usage",
      },
      capabilities: { sessionReuse: false, failureExplanation: false, modelValidation: false },
      status: "contract-tested",
      degradation: BLOCK_ON_PROVIDER_FAILURE,
    },
    {
      runtime: "together",
      cli: { command: "pi", overrideEnv: "NITELY_PI_COMMAND" },
      auth: { kind: "api-key-env", requiredEnv: [["TOGETHER_API_KEY"]] },
      output: {
        format: "pi-jsonl",
        tokenUsage: "provider-reported",
        cost: "estimated",
        usageReference: "pi.json.message_end.usage",
      },
      capabilities: { sessionReuse: false, failureExplanation: true, modelValidation: true },
      status: "contract-tested",
      degradation: BLOCK_ON_PROVIDER_FAILURE,
    },
  ],
};

export function providerCompatibilityEntry(
  runtime: string,
  matrix: ProviderCompatibilityMatrix = PROVIDER_COMPATIBILITY_MATRIX,
): ProviderCompatibilityEntry | undefined {
  return matrix.entries.find((entry) => entry.runtime === runtime);
}

/** Checks internal consistency; returns problems instead of throwing. */
export function validateProviderCompatibilityMatrix(
  matrix: ProviderCompatibilityMatrix,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of matrix.entries) {
    if (seen.has(entry.runtime)) problems.push(`duplicate runtime ${entry.runtime}`);
    seen.add(entry.runtime);
    if (entry.status === "live-verified" && !entry.liveVerified) {
      problems.push(`${entry.runtime} is live-verified without live evidence`);
    }
    if (entry.status !== "live-verified" && entry.liveVerified) {
      problems.push(`${entry.runtime} records live evidence but is not live-verified`);
    }
    if (entry.output.estimatedCostIsUpperBound && entry.output.cost !== "estimated") {
      problems.push(`${entry.runtime} marks a cost upper bound without estimated cost`);
    }
    if (entry.output.tokenUsage === "none" && entry.output.cost !== "unknown") {
      problems.push(`${entry.runtime} claims ${entry.output.cost} cost without usage`);
    }
    if (entry.output.tokenUsage === "provider-reported" && !entry.output.usageReference) {
      problems.push(`${entry.runtime} reports usage without a provenance reference`);
    }
  }
  return problems;
}
