import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { WebInputError } from "../web/errors.js";
import { stagesMissingCapabilityPolicy } from "../flow/capabilities.js";
import type { LoadedFlow } from "../flow/load.js";
import { flowWorkItemType, type Flow } from "../flow/schema.js";
import {
  DEFAULT_PROTECTED_STAGES,
  resolveWorkItemTypePolicy,
  type WorkItemTypePolicy,
} from "./policy.js";

export { resolveWorkItemTypePolicy } from "./policy.js";

export type WorkItemPolicyDecision = "allow" | "require-approval" | "deny";
export type WorkItemRiskLevel = "low" | "high";

export interface RepoWorkItemTypePolicy {
  decision?: WorkItemPolicyDecision;
  risk?: WorkItemRiskLevel;
  requiredGates?: string[];
  protectedStages?: string[];
  paperOnly?: boolean;
}

export interface WorkItemPolicyConfig {
  allowedTypes: string[];
  unknownTypeDefault: WorkItemPolicyDecision;
  unknownTypeDefaultConfigured: boolean;
  customTypes: Record<string, RepoWorkItemTypePolicy>;
}

export interface EffectiveWorkItemTypePolicy extends WorkItemTypePolicy {
  decision: WorkItemPolicyDecision;
  source: "built-in" | "repo" | "unknown";
  matchedType: string;
  explicitlyLowRisk: boolean;
}

export type WorkItemGovernanceReasonCode =
  | "governance.policy-denied"
  | "governance.work-item-type-mismatch"
  | "governance.approval-stage-required"
  | "governance.required-gates-missing"
  | "governance.capability-policy-missing"
  | "governance.protected-stage-ungated";

export interface WorkItemGovernanceReason {
  code: WorkItemGovernanceReasonCode;
  message: string;
}

export type WorkItemTypeGovernanceDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: WorkItemGovernanceReason };

export interface EvaluateWorkItemTypeGovernanceInput {
  repoPath: string;
  workItemType: string;
  loaded: LoadedFlow;
}

const WORK_ITEM_POLICY_RELATIVE_PATH = ".nitely/work-item-policy.json";
const WORK_ITEM_POLICY_DECISIONS = new Set<WorkItemPolicyDecision>([
  "allow",
  "require-approval",
  "deny",
]);
const WORK_ITEM_RISK_LEVELS = new Set<WorkItemRiskLevel>(["low", "high"]);

/**
 * Load the optional `.nitely/work-item-policy.json` policy. A missing file
 * keeps unknown non-protected types open for local extension, while high-risk
 * and protected workflows still fail closed unless explicitly allowed or gated.
 */
export async function loadWorkItemPolicy(
  repoPath: string,
): Promise<WorkItemPolicyConfig> {
  const path = join(resolve(repoPath), WORK_ITEM_POLICY_RELATIVE_PATH);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    const record = asRecord(parsed);
    const allowedTypes =
      record && Array.isArray(record.allowedTypes)
        ? record.allowedTypes.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
    const unknownTypeDefault = parseOptionalDecision(
      record?.unknownTypeDefault,
      "unknownTypeDefault",
    );
    return {
      allowedTypes,
      unknownTypeDefault: unknownTypeDefault ?? "allow",
      unknownTypeDefaultConfigured: unknownTypeDefault !== undefined,
      customTypes: parseCustomTypes(record),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        allowedTypes: [],
        unknownTypeDefault: "allow",
        unknownTypeDefaultConfigured: false,
        customTypes: {},
      };
    }
    throw error;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseOptionalDecision(
  value: unknown,
  path: string,
): WorkItemPolicyDecision | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value === "string" &&
    WORK_ITEM_POLICY_DECISIONS.has(value as WorkItemPolicyDecision)
  ) {
    return value as WorkItemPolicyDecision;
  }
  throw new WebInputError(
    `${WORK_ITEM_POLICY_RELATIVE_PATH} ${path} must be one of: allow, require-approval, deny`,
  );
}

function parseOptionalRisk(
  value: unknown,
  path: string,
): WorkItemRiskLevel | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value === "string" &&
    WORK_ITEM_RISK_LEVELS.has(value as WorkItemRiskLevel)
  ) {
    return value as WorkItemRiskLevel;
  }
  throw new WebInputError(
    `${WORK_ITEM_POLICY_RELATIVE_PATH} ${path} must be one of: low, high`,
  );
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}

function parseCustomTypes(
  record: Record<string, unknown> | undefined,
): Record<string, RepoWorkItemTypePolicy> {
  const raw = asRecord(record?.customTypes) ?? asRecord(record?.types);
  if (!raw) return {};
  const customTypes: Record<string, RepoWorkItemTypePolicy> = {};
  for (const [type, value] of Object.entries(raw)) {
    const policy = asRecord(value);
    if (!policy) {
      throw new WebInputError(
        `${WORK_ITEM_POLICY_RELATIVE_PATH} customTypes.${type} must be an object`,
      );
    }
    const decision = parseOptionalDecision(
      policy.decision,
      `customTypes.${type}.decision`,
    );
    const risk = parseOptionalRisk(policy.risk, `customTypes.${type}.risk`);
    const requiredGates = stringArray(policy.requiredGates);
    const protectedStages = stringArray(policy.protectedStages);
    customTypes[type] = {
      ...(decision ? { decision } : {}),
      ...(risk ? { risk } : {}),
      ...(requiredGates ? { requiredGates } : {}),
      ...(protectedStages ? { protectedStages } : {}),
      ...(typeof policy.paperOnly === "boolean"
        ? { paperOnly: policy.paperOnly }
        : {}),
    };
  }
  return customTypes;
}

function policyMatches(typePattern: string, workItemType: string): boolean {
  if (typePattern.endsWith(".*")) {
    const prefix = typePattern.slice(0, -1); // keep the trailing dot
    return workItemType.startsWith(prefix);
  }
  return typePattern === workItemType;
}

function resolveRepoPolicy(
  config: WorkItemPolicyConfig,
  workItemType: string,
): { matchedType: string; policy: RepoWorkItemTypePolicy } | undefined {
  const exact = config.customTypes[workItemType];
  if (exact) {
    return { matchedType: workItemType, policy: exact };
  }
  for (const [type, policy] of Object.entries(config.customTypes)) {
    if (policyMatches(type, workItemType)) {
      return { matchedType: type, policy };
    }
  }
  return undefined;
}

function flowHasProtectedStage(flow: Pick<Flow, "spec">): boolean {
  return flow.spec.stages.some((stage) =>
    DEFAULT_PROTECTED_STAGES.includes(stage.type),
  );
}

function effectiveBuiltinPolicy(
  builtIn: WorkItemTypePolicy,
  input: { workItemType: string; config: WorkItemPolicyConfig },
): EffectiveWorkItemTypePolicy {
  const allowed =
    !builtIn.highRisk || input.config.allowedTypes.includes(input.workItemType);
  return {
    ...builtIn,
    protectedStages: builtIn.protectedStages ?? [],
    decision: allowed ? "allow" : "deny",
    source: "built-in",
    matchedType: builtIn.type,
    explicitlyLowRisk: !builtIn.highRisk,
  };
}

function effectiveRepoPolicy(input: {
  workItemType: string;
  matchedType: string;
  policy: RepoWorkItemTypePolicy;
  hasProtectedStage: boolean;
}): EffectiveWorkItemTypePolicy {
  const risk = input.policy.risk ?? (input.hasProtectedStage ? "high" : "low");
  const decision = input.policy.decision ?? "allow";
  const highRisk = risk === "high" || decision === "require-approval";
  return {
    type: input.matchedType,
    highRisk,
    requiredGates: input.policy.requiredGates ?? [],
    protectedStages:
      input.policy.protectedStages ?? (highRisk ? DEFAULT_PROTECTED_STAGES : []),
    ...(input.policy.paperOnly !== undefined
      ? { paperOnly: input.policy.paperOnly }
      : {}),
    decision,
    source: "repo",
    matchedType: input.matchedType,
    explicitlyLowRisk: risk === "low",
  };
}

function effectiveUnknownPolicy(input: {
  workItemType: string;
  config: WorkItemPolicyConfig;
  hasProtectedStage: boolean;
}): EffectiveWorkItemTypePolicy {
  const decision =
    input.hasProtectedStage && !input.config.unknownTypeDefaultConfigured
      ? "require-approval"
      : input.config.unknownTypeDefault;
  const highRisk = decision === "require-approval" || decision === "deny";
  return {
    type: input.workItemType,
    highRisk,
    requiredGates: [],
    protectedStages: highRisk ? DEFAULT_PROTECTED_STAGES : [],
    decision,
    source: "unknown",
    matchedType: input.workItemType,
    explicitlyLowRisk: false,
  };
}

export async function resolveEffectiveWorkItemTypePolicy(input: {
  repoPath: string;
  workItemType: string;
  flow?: Pick<Flow, "spec">;
  hasProtectedStage?: boolean;
}): Promise<EffectiveWorkItemTypePolicy> {
  const config = await loadWorkItemPolicy(input.repoPath);
  const hasProtectedStage =
    input.hasProtectedStage ??
    (input.flow ? flowHasProtectedStage(input.flow) : false);
  const builtIn = resolveWorkItemTypePolicy(input.workItemType);
  if (builtIn) {
    return effectiveBuiltinPolicy(builtIn, {
      workItemType: input.workItemType,
      config,
    });
  }
  const repoPolicy = resolveRepoPolicy(config, input.workItemType);
  if (repoPolicy) {
    return effectiveRepoPolicy({
      workItemType: input.workItemType,
      matchedType: repoPolicy.matchedType,
      policy: repoPolicy.policy,
      hasProtectedStage,
    });
  }
  return effectiveUnknownPolicy({
    workItemType: input.workItemType,
    config,
    hasProtectedStage,
  });
}

function approvalStageIds(flow: Pick<Flow, "spec">): Set<string> {
  return new Set(
    flow.spec.stages
      .filter((stage) => stage.type === "approval")
      .map((stage) => stage.id),
  );
}

export async function evaluateWorkItemTypeGovernance(
  input: EvaluateWorkItemTypeGovernanceInput,
): Promise<WorkItemTypeGovernanceDecision> {
  const canonicalWorkItemType = flowWorkItemType(input.loaded.flow);
  if (canonicalWorkItemType !== input.workItemType) {
    return {
      decision: "deny",
      reason: {
        code: "governance.work-item-type-mismatch",
        message: `work item type "${input.workItemType}" does not match Flow metadata workItemType "${canonicalWorkItemType}"`,
      },
    };
  }
  const policy = await resolveEffectiveWorkItemTypePolicy({
    repoPath: input.repoPath,
    workItemType: input.workItemType,
    flow: input.loaded.flow,
  });
  if (policy.decision === "deny") {
    return {
      decision: "deny",
      reason: {
        code: "governance.policy-denied",
        message: policyDeniedMessage(input.workItemType, policy),
      },
    };
  }
  if (!policy.highRisk) {
    return { decision: "allow" };
  }

  const gates = approvalStageIds(input.loaded.flow);
  if (policy.decision === "require-approval" && gates.size === 0) {
    return {
      decision: "deny",
      reason: {
        code: "governance.approval-stage-required",
        message: `work item type "${input.workItemType}" requires an approval stage by ${WORK_ITEM_POLICY_RELATIVE_PATH} policy`,
      },
    };
  }

  const missing = policy.requiredGates.filter((gate) => !gates.has(gate));
  if (missing.length > 0) {
    return {
      decision: "deny",
      reason: {
        code: "governance.required-gates-missing",
        message: `work item type "${input.workItemType}" requires approval gate stage(s): ${missing.join(", ")}`,
      },
    };
  }

  const missingCapabilities = stagesMissingCapabilityPolicy(input.loaded.flow);
  if (missingCapabilities.length > 0) {
    return {
      decision: "deny",
      reason: {
        code: "governance.capability-policy-missing",
        message: `work item type "${input.workItemType}" is high-risk and requires capability policy on agent/review stage(s): ${missingCapabilities.join(", ")}`,
      },
    };
  }

  const protectedStageReason = protectedStageGovernanceReason(
    input.workItemType,
    policy,
    input.loaded,
  );
  return protectedStageReason
    ? { decision: "deny", reason: protectedStageReason }
    : { decision: "allow" };
}

/**
 * Enforce governance for a work item type. Built-in high-risk types must be
 * allow-listed, custom types can be controlled from the repository policy, and
 * unknown protected workflows require an approval gate by default.
 */
export async function assertWorkItemTypeAllowed(
  input: EvaluateWorkItemTypeGovernanceInput,
): Promise<void> {
  const result = await evaluateWorkItemTypeGovernance(input);
  if (result.decision === "deny") {
    throw new WebInputError(result.reason.message);
  }
}

export function policyDeniedMessage(
  workItemType: string,
  policy: Pick<EffectiveWorkItemTypePolicy, "source" | "matchedType">,
): string {
  if (policy.source === "built-in") {
    return `work item type "${workItemType}" is high-risk and must be added to ${WORK_ITEM_POLICY_RELATIVE_PATH} allowedTypes`;
  }
  if (policy.source === "repo") {
    return `work item type "${workItemType}" is denied by ${WORK_ITEM_POLICY_RELATIVE_PATH} customTypes.${policy.matchedType}.decision`;
  }
  return `work item type "${workItemType}" is denied by ${WORK_ITEM_POLICY_RELATIVE_PATH} unknownTypeDefault`;
}

/**
 * A protected action stage (publish/update/deploy) in a high-risk or approval-
 * required flow must be preceded by an approval gate stage. Otherwise the stage
 * could mutate an external system without review.
 */
function protectedStageGovernanceReason(
  workItemType: string,
  policy: { protectedStages?: string[] },
  loaded: LoadedFlow,
): WorkItemGovernanceReason | undefined {
  const protectedStages = policy.protectedStages ?? [];
  if (protectedStages.length === 0) {
    return undefined;
  }
  const approvalIds = approvalStageIds(loaded.flow);
  for (const stage of loaded.flow.spec.stages) {
    if (
      protectedStages.includes(stage.type) &&
      !hasGraphAncestor(stage.id, approvalIds, loaded)
    ) {
      return {
        code: "governance.protected-stage-ungated",
        message: `work item type "${workItemType}" requires an approval gate before protected stage "${stage.id}" (${stage.type})`,
      };
    }
  }
  return undefined;
}

function hasGraphAncestor(
  stageId: string,
  candidates: ReadonlySet<string>,
  loaded: LoadedFlow,
): boolean {
  const pending = [...(loaded.graph.predecessors.get(stageId) ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const predecessor = pending.pop();
    if (!predecessor || visited.has(predecessor)) continue;
    if (candidates.has(predecessor)) return true;
    visited.add(predecessor);
    pending.push(...(loaded.graph.predecessors.get(predecessor) ?? []));
  }
  return false;
}
