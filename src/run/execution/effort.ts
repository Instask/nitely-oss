import type { Effort } from "../../flow/schema.js";

export interface RuntimeEffortSelection {
  effort?: Effort;
  requestedEffort?: Effort;
  effortStatus: "configured" | "default" | "not-applicable";
}

/** Explicit capability metadata from https://openrouter.ai/api/v1/models,
 * inspected 2026-10-07. Unknown models keep the requested setting; they are
 * never guessed from names. Variant suffixes refer to the same model.
 */
export function runtimeEffortSelection(input: {
  runtime?: string;
  model?: string;
  effort?: Effort;
}): RuntimeEffortSelection {
  const requested = input.effort ? { requestedEffort: input.effort } : {};
  if (input.runtime?.trim() === "openrouter" &&
      input.model?.trim().replace(/^openrouter\//, "").split(":")[0] === "qwen/qwen3-coder-next") {
    return { ...requested, effortStatus: "not-applicable" };
  }
  return input.effort
    ? { effort: input.effort, ...requested, effortStatus: "configured" }
    : { effortStatus: "default" };
}

