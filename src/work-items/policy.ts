export interface WorkItemTypePolicy {
  /** Exact type id, or a prefix ending in ".*" matching a family of types. */
  type: string;
  highRisk: boolean;
  /** Approval stage ids the flow must declare for this type. */
  requiredGates: string[];
  /**
   * Stage types that perform a high-risk external action and must be preceded
   * by an approval gate stage. Enforced at flow load/creation and again at
   * runtime, so the protected stage cannot run without a passed gate.
   */
  protectedStages?: string[];
  /** True when executable artifacts must default to a paper / dry-run mode. */
  paperOnly?: boolean;
}

/** Stage types that mutate external systems and are gated for high-risk types. */
export const DEFAULT_PROTECTED_STAGES = [
  "publish-change",
  "update-change",
  "deploy",
];

/**
 * Built-in policy table. `dev.pr` is the safe built-in. High-risk families must
 * declare the listed gate stages and be allow-listed before they can run.
 */
export const WORK_ITEM_TYPE_POLICIES: WorkItemTypePolicy[] = [
  { type: "dev.pr", highRisk: false, requiredGates: [] },
  {
    type: "autofarm.site",
    highRisk: true,
    requiredGates: ["approve-plan", "approve-preview"],
    protectedStages: DEFAULT_PROTECTED_STAGES,
  },
  {
    type: "capital-autopilot.*",
    highRisk: true,
    requiredGates: ["risk-manager"],
    protectedStages: DEFAULT_PROTECTED_STAGES,
    paperOnly: true,
  },
];

function policyMatches(policy: WorkItemTypePolicy, workItemType: string): boolean {
  if (policy.type.endsWith(".*")) {
    const prefix = policy.type.slice(0, -1); // keep the trailing dot
    return workItemType.startsWith(prefix);
  }
  return policy.type === workItemType;
}

export function resolveWorkItemTypePolicy(
  workItemType: string,
): WorkItemTypePolicy | undefined {
  // Exact matches win over prefix families.
  const exact = WORK_ITEM_TYPE_POLICIES.find(
    (policy) => policy.type === workItemType,
  );
  if (exact) {
    return exact;
  }
  return WORK_ITEM_TYPE_POLICIES.find((policy) =>
    policyMatches(policy, workItemType),
  );
}
