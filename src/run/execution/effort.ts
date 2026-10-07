import type { Effort } from "../../flow/schema.js";

export type RuntimeEffortStatus = "configured" | "default" | "not-applicable";

/** Requested Nitely effort, the token actually placed in argv, and the outcome. */
export interface ResolvedRuntimeEffort {
  requestedEffort?: Effort;
  nativeEffort?: string;
  effortStatus: RuntimeEffortStatus;
}

/**
 * Maps one Nitely effort onto a runtime CLI. `undefined` means that runtime
 * cannot represent the level, which preflight rejects before spawn.
 */
export interface RuntimeEffortContract {
  toNative(effort: Effort): string | undefined;
}

/**
 * Pi 1.0.4 `--thinking` accepts the Nitely enum verbatim. OpenRouter and
 * Together launch through Pi and share this contract. Inspected 2026-10-07.
 */
const nitelyEffortLevels = [
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
] as const satisfies readonly Effort[];

export function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && (nitelyEffortLevels as readonly string[]).includes(value);
}

const piEffort: RuntimeEffortContract = {
  toNative(effort) {
    return (nitelyEffortLevels as readonly string[]).includes(effort) ? effort : undefined;
  },
};

/**
 * Codex CLI 0.156.1 `model_reasoning_effort` is
 * `none | minimal | low | medium | high | xhigh | max`.
 * Nitely `off` is Codex `none`. Inspected 2026-10-07.
 */
const codexEffort: RuntimeEffortContract = {
  toNative(effort) {
    if (effort === "off") return "none";
    if (effort === "minimal" || effort === "low" || effort === "medium" ||
        effort === "high" || effort === "xhigh" || effort === "max") {
      return effort;
    }
    return undefined;
  },
};

/**
 * Claude Code 2.1.284 `--effort` accepts `low | medium | high | xhigh | max`.
 * Inspected 2026-10-07. `off` and `minimal` have no Claude token.
 */
const claudeEffort: RuntimeEffortContract = {
  toNative(effort) {
    if (effort === "low" || effort === "medium" || effort === "high" ||
        effort === "xhigh" || effort === "max") {
      return effort;
    }
    return undefined;
  },
};

const contracts = new Map<string, RuntimeEffortContract>([
  ["codex", codexEffort],
  ["claude", claudeEffort],
  ["pi", piEffort],
  ["openrouter", piEffort],
  ["together", piEffort],
]);

export function effortContractFor(runtimeId: string): RuntimeEffortContract | undefined {
  return contracts.get(runtimeId.trim());
}

/**
 * OpenRouter ids whose bundled catalog entry reports no reasoning support.
 * Snapshot of https://openrouter.ai/api/v1/models inspected 2026-10-07.
 * Unknown models are not guessed from their names.
 */
const openRouterModelsWithoutReasoning = new Set(["qwen/qwen3-coder-next"]);

/**
 * Identity used only to match bundled reasoning capability. The model string
 * passed to Pi stays unchanged.
 *
 * `openrouter/qwen/qwen3-coder-next:free`, `~qwen/qwen3-coder-next:free`, and
 * `qwen/qwen3-coder-next` all become `qwen/qwen3-coder-next`.
 */
export function canonicalOpenRouterModelId(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  let id = trimmed;
  if (id.toLowerCase().startsWith("openrouter/")) id = id.slice("openrouter/".length);
  if (id.startsWith("~")) id = id.slice(1);
  const variant = id.indexOf(":");
  if (variant >= 0) id = id.slice(0, variant);
  return id;
}

function openRouterOmitsReasoning(model: string | undefined): boolean {
  const id = canonicalOpenRouterModelId(model);
  return id !== undefined && openRouterModelsWithoutReasoning.has(id);
}

/**
 * One decision for preflight, local and OCI launch, events, and evidence.
 * A model that cannot reason records the request and sends no native token.
 */
export function resolveRuntimeEffort(input: {
  runtime?: string;
  model?: string;
  effort?: Effort;
}): { problem?: string; selection: ResolvedRuntimeEffort } {
  if (!input.effort) return { selection: { effortStatus: "default" } };
  const requestedEffort = input.effort;
  const runtimeId = input.runtime?.trim() ?? "";
  if (runtimeId === "openrouter" && openRouterOmitsReasoning(input.model)) {
    return { selection: { requestedEffort, effortStatus: "not-applicable" } };
  }
  const contract = effortContractFor(runtimeId);
  if (!contract) {
    return {
      problem: `runtime-effort-unsupported: agent runtime ${runtimeId || "unknown"} has no effort mapping for ${requestedEffort}`,
      selection: { requestedEffort, effortStatus: "configured" },
    };
  }
  const nativeEffort = contract.toNative(requestedEffort);
  if (!nativeEffort) {
    return {
      problem: `runtime-effort-unsupported: agent runtime ${runtimeId} cannot represent effort ${requestedEffort}`,
      selection: { requestedEffort, effortStatus: "configured" },
    };
  }
  return { selection: { requestedEffort, nativeEffort, effortStatus: "configured" } };
}

export function formatRuntimeEffort(selection: ResolvedRuntimeEffort): string {
  if (selection.effortStatus === "not-applicable") {
    return `not-applicable, requested ${selection.requestedEffort ?? "unset"}`;
  }
  if (selection.effortStatus === "default") return "default";
  return `native ${selection.nativeEffort}, requested ${selection.requestedEffort}, status configured`;
}
