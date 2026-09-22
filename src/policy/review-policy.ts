import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { WebInputError } from "../web/errors.js";
import {
  DEFAULT_RISK_SIGNAL_POLICY,
  RISK_CLASSES,
  type ProtectedDomainPatterns,
  type RiskClass,
  type RiskClassification,
  type RiskSignalPolicy,
} from "./risk.js";

export const REVIEW_POLICY_RELATIVE_PATH = ".nitely/review-policy.json";

export interface ReviewRequirement {
  riskClass: RiskClass;
  /** Human approvals the change request needs before it may merge. */
  requiredApprovals: number;
  /** Whether a CODEOWNER of the changed paths must be among them. */
  requireCodeOwner: boolean;
  /** Publish as a draft change request only. */
  draftOnly: boolean;
  /** Whether verification alone may merge the change. */
  autoMergeEligible: boolean;
  /** Whether the change may merge with no human in the loop at all. */
  allowUnattendedMerge: boolean;
  /**
   * Whether the run itself must carry an approved approval gate before a
   * protected stage may publish. This is the only part of the requirement the
   * run can enforce on its own; the rest is stated on the change request for
   * the humans and for branch protection.
   */
  requireRunApproval: boolean;
}

export type ReviewPolicyClasses = Record<RiskClass, ReviewRequirement>;

export interface ReviewPolicy {
  /** Risk baseline per work item type, before any diff signal. */
  baselineByWorkItemType: Record<string, RiskClass>;
  signals: RiskSignalPolicy;
  classes: ReviewPolicyClasses;
  /** Whether a policy file was found; false means built-in defaults. */
  configured: boolean;
}

/**
 * Conservative defaults. Only `protected` blocks the run itself, because a
 * published change request is a draft pull request, not a merge: the approval
 * counts below are requirements on that pull request. A protected diff is the
 * case where publishing unattended is itself the thing to prevent.
 */
export const DEFAULT_REVIEW_POLICY_CLASSES: ReviewPolicyClasses = {
  mechanical: {
    riskClass: "mechanical",
    requiredApprovals: 0,
    requireCodeOwner: false,
    draftOnly: false,
    autoMergeEligible: true,
    allowUnattendedMerge: true,
    requireRunApproval: false,
  },
  normal: {
    riskClass: "normal",
    requiredApprovals: 1,
    requireCodeOwner: false,
    draftOnly: false,
    autoMergeEligible: false,
    allowUnattendedMerge: false,
    requireRunApproval: false,
  },
  high: {
    riskClass: "high",
    requiredApprovals: 2,
    requireCodeOwner: true,
    draftOnly: true,
    autoMergeEligible: false,
    allowUnattendedMerge: false,
    requireRunApproval: false,
  },
  protected: {
    riskClass: "protected",
    requiredApprovals: 2,
    requireCodeOwner: true,
    draftOnly: true,
    autoMergeEligible: false,
    allowUnattendedMerge: false,
    requireRunApproval: true,
  },
};

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  baselineByWorkItemType: {},
  signals: DEFAULT_RISK_SIGNAL_POLICY,
  classes: DEFAULT_REVIEW_POLICY_CLASSES,
  configured: false,
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new WebInputError(
      `${REVIEW_POLICY_RELATIVE_PATH} ${path} must be an array of non-empty strings`,
    );
  }
  return value as string[];
}

export function parseRiskClass(value: unknown, path: string): RiskClass {
  if (
    typeof value === "string" &&
    (RISK_CLASSES as readonly string[]).includes(value)
  ) {
    return value as RiskClass;
  }
  throw new WebInputError(
    `${REVIEW_POLICY_RELATIVE_PATH} ${path} must be one of: ${RISK_CLASSES.join(", ")}`,
  );
}

function parseBoolean(
  value: unknown,
  path: string,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new WebInputError(
      `${REVIEW_POLICY_RELATIVE_PATH} ${path} must be a boolean`,
    );
  }
  return value;
}

function parseCount(value: unknown, path: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new WebInputError(
      `${REVIEW_POLICY_RELATIVE_PATH} ${path} must be a non-negative integer`,
    );
  }
  return value;
}

function parseClasses(value: unknown): ReviewPolicyClasses {
  const record = asRecord(value);
  if (!record) return DEFAULT_REVIEW_POLICY_CLASSES;
  const classes = {} as ReviewPolicyClasses;
  for (const riskClass of RISK_CLASSES) {
    const base = DEFAULT_REVIEW_POLICY_CLASSES[riskClass];
    const override = asRecord(record[riskClass]);
    if (record[riskClass] !== undefined && !override) {
      throw new WebInputError(
        `${REVIEW_POLICY_RELATIVE_PATH} classes.${riskClass} must be an object`,
      );
    }
    classes[riskClass] = {
      riskClass,
      requiredApprovals: parseCount(
        override?.requiredApprovals,
        `classes.${riskClass}.requiredApprovals`,
        base.requiredApprovals,
      ),
      requireCodeOwner: parseBoolean(
        override?.requireCodeOwner,
        `classes.${riskClass}.requireCodeOwner`,
        base.requireCodeOwner,
      ),
      draftOnly: parseBoolean(
        override?.draftOnly,
        `classes.${riskClass}.draftOnly`,
        base.draftOnly,
      ),
      autoMergeEligible: parseBoolean(
        override?.autoMergeEligible,
        `classes.${riskClass}.autoMergeEligible`,
        base.autoMergeEligible,
      ),
      allowUnattendedMerge: parseBoolean(
        override?.allowUnattendedMerge,
        `classes.${riskClass}.allowUnattendedMerge`,
        base.allowUnattendedMerge,
      ),
      requireRunApproval: parseBoolean(
        override?.requireRunApproval,
        `classes.${riskClass}.requireRunApproval`,
        base.requireRunApproval,
      ),
    };
  }
  return classes;
}

function parseProtectedPaths(
  value: unknown,
): ProtectedDomainPatterns[] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return Object.entries(record).map(([domain, patterns]) => ({
    domain,
    patterns: stringArray(patterns, `signals.protectedPaths.${domain}`) ?? [],
  }));
}

function parseSignals(value: unknown): RiskSignalPolicy {
  const record = asRecord(value);
  if (!record) return DEFAULT_RISK_SIGNAL_POLICY;
  const diffSize = asRecord(record.diffSize);
  return {
    protectedPaths:
      parseProtectedPaths(record.protectedPaths) ??
      DEFAULT_RISK_SIGNAL_POLICY.protectedPaths,
    migrations:
      stringArray(record.migrations, "signals.migrations") ??
      DEFAULT_RISK_SIGNAL_POLICY.migrations,
    dependencyManifests:
      stringArray(record.dependencyManifests, "signals.dependencyManifests") ??
      DEFAULT_RISK_SIGNAL_POLICY.dependencyManifests,
    diffSize: {
      files: parseCount(
        diffSize?.files,
        "signals.diffSize.files",
        DEFAULT_RISK_SIGNAL_POLICY.diffSize.files,
      ),
      lines: parseCount(
        diffSize?.lines,
        "signals.diffSize.lines",
        DEFAULT_RISK_SIGNAL_POLICY.diffSize.lines,
      ),
    },
  };
}

function parseBaselines(value: unknown): Record<string, RiskClass> {
  const record = asRecord(value);
  if (!record) return {};
  const baselines: Record<string, RiskClass> = {};
  for (const [type, riskClass] of Object.entries(record)) {
    baselines[type] = parseRiskClass(
      riskClass,
      `baselineByWorkItemType.${type}`,
    );
  }
  return baselines;
}

/**
 * Load `.nitely/review-policy.json`. A missing file keeps the built-in
 * conservative defaults, so a repository gets diff-derived escalation without
 * having to configure anything first.
 */
export async function loadReviewPolicy(
  repoPath: string,
): Promise<ReviewPolicy> {
  const path = join(resolve(repoPath), REVIEW_POLICY_RELATIVE_PATH);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_REVIEW_POLICY;
    }
    if (error instanceof SyntaxError) {
      throw new WebInputError(
        `${REVIEW_POLICY_RELATIVE_PATH} is not valid JSON: ${error.message}`,
      );
    }
    throw error;
  }
  const record = asRecord(parsed);
  if (!record) {
    throw new WebInputError(
      `${REVIEW_POLICY_RELATIVE_PATH} must be a JSON object`,
    );
  }
  return {
    baselineByWorkItemType: parseBaselines(record.baselineByWorkItemType),
    signals: parseSignals(record.signals),
    classes: parseClasses(record.classes),
    configured: true,
  };
}

/**
 * The declared baseline for a work item, before the diff is consulted.
 * Repository policy wins; otherwise a high-risk work item type starts at
 * `high` and everything else at `normal`. Nothing starts at `mechanical`
 * without the repository saying so.
 */
export function declaredRiskBaseline(input: {
  policy: ReviewPolicy;
  workItemType?: string;
  highRiskWorkItemType?: boolean;
}): RiskClass {
  const configured = input.workItemType
    ? input.policy.baselineByWorkItemType[input.workItemType]
    : undefined;
  if (configured) return configured;
  return input.highRiskWorkItemType ? "high" : "normal";
}

export function resolveReviewRequirement(input: {
  policy: ReviewPolicy;
  classification: Pick<RiskClassification, "effective">;
}): ReviewRequirement {
  return input.policy.classes[input.classification.effective];
}

export function renderRiskClassificationMarkdown(input: {
  classification: RiskClassification;
  requirement: ReviewRequirement;
}): string {
  const { classification, requirement } = input;
  const lines = [
    `Declared risk: ${classification.declared}`,
    `Effective risk: ${classification.effective}`,
    `Escalated: ${classification.escalated ? "yes" : "no"}`,
    `Why: ${classification.explanation}`,
    `Changed files: ${classification.changedFileCount}`,
    ...(classification.changedLines !== undefined
      ? [`Changed lines: ${classification.changedLines}`]
      : []),
    `Diff digest: ${classification.diffDigest}`,
    "",
    "Signals:",
    ...(classification.signals.length > 0
      ? classification.signals.map(
          (signal) =>
            `- ${signal.id}${signal.domain ? `/${signal.domain}` : ""} (${signal.riskClass}): ${signal.detail}`,
        )
      : ["- none"]),
    "",
    "Required review:",
    `- Human approvals: ${requirement.requiredApprovals}`,
    `- Code owner approval: ${requirement.requireCodeOwner ? "required" : "not required"}`,
    ...(classification.requiredOwners.length > 0
      ? [`- Code owners: ${classification.requiredOwners.join(", ")}`]
      : []),
    `- Draft only: ${requirement.draftOnly ? "yes" : "no"}`,
    `- Auto-merge after verification: ${requirement.autoMergeEligible ? "eligible" : "not eligible"}`,
    `- Unattended merge: ${requirement.allowUnattendedMerge ? "allowed" : "prohibited"}`,
    `- Approved run gate before publish: ${requirement.requireRunApproval ? "required" : "not required"}`,
  ];
  return lines.join("\n");
}
