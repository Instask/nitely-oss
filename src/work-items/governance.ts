import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { WebInputError } from "../web/errors.js";
import type { Flow } from "../flow/schema.js";
import { resolveWorkItemTypePolicy } from "./policy.js";

export { resolveWorkItemTypePolicy } from "./policy.js";

export interface WorkItemPolicyConfig {
  allowedTypes: string[];
}

/**
 * Load the optional `.nitely/work-item-policy.json` allow-list. A missing file
 * means no high-risk types are allowed.
 */
export async function loadWorkItemPolicy(
  repoPath: string,
): Promise<WorkItemPolicyConfig> {
  const path = join(resolve(repoPath), ".nitely", "work-item-policy.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    const allowedTypes =
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { allowedTypes?: unknown }).allowedTypes)
        ? (parsed as { allowedTypes: unknown[] }).allowedTypes.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
    return { allowedTypes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { allowedTypes: [] };
    }
    throw error;
  }
}

function approvalStageIds(flow: Pick<Flow, "spec">): Set<string> {
  return new Set(
    flow.spec.stages
      .filter((stage) => stage.type === "approval")
      .map((stage) => stage.id),
  );
}

/**
 * Enforce governance for a work item type. Non-high-risk and unknown types are
 * accepted. High-risk types must be allow-listed and the flow must declare every
 * required gate stage.
 */
export async function assertWorkItemTypeAllowed(input: {
  repoPath: string;
  workItemType: string;
  flow: Pick<Flow, "spec">;
}): Promise<void> {
  const policy = resolveWorkItemTypePolicy(input.workItemType);
  if (!policy || !policy.highRisk) {
    return;
  }

  const { allowedTypes } = await loadWorkItemPolicy(input.repoPath);
  if (!allowedTypes.includes(input.workItemType)) {
    throw new WebInputError(
      `work item type "${input.workItemType}" is high-risk and must be added to .nitely/work-item-policy.json allowedTypes`,
    );
  }

  const gates = approvalStageIds(input.flow);
  const missing = policy.requiredGates.filter((gate) => !gates.has(gate));
  if (missing.length > 0) {
    throw new WebInputError(
      `work item type "${input.workItemType}" requires approval gate stage(s): ${missing.join(", ")}`,
    );
  }

  assertProtectedStagesGated(input.workItemType, policy, input.flow);
}

/**
 * A protected action stage (publish/update/deploy) in a high-risk flow must be
 * preceded by an approval gate stage. Otherwise the stage could mutate an
 * external system without review.
 */
function assertProtectedStagesGated(
  workItemType: string,
  policy: { protectedStages?: string[] },
  flow: Pick<Flow, "spec">,
): void {
  const protectedStages = policy.protectedStages ?? [];
  if (protectedStages.length === 0) {
    return;
  }
  let seenApproval = false;
  for (const stage of flow.spec.stages) {
    if (stage.type === "approval") {
      seenApproval = true;
      continue;
    }
    if (protectedStages.includes(stage.type) && !seenApproval) {
      throw new WebInputError(
        `work item type "${workItemType}" requires an approval gate before protected stage "${stage.id}" (${stage.type})`,
      );
    }
  }
}
