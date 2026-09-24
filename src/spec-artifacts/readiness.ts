import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseStructuredSpec, type StructuredSpecItem } from "./parse.js";
import {
  derivePlanningExecutionState,
  type PlanningApprovalStatus,
} from "../work-items/planning.js";
import type { WorkItemRecord } from "../work-items/types.js";

export interface SourceSpecificSpecReadinessIssue {
  code:
    | "generic-functional-requirement"
    | "generic-success-criterion"
    | "default-open-question"
    | "missing-source-specific-functional-requirement"
    | "missing-source-specific-success-criterion"
    | "invalid-structured-spec";
  message: string;
  line?: number;
  id?: string;
}

export interface SourceSpecificSpecReadinessResult {
  ready: boolean;
  issues: SourceSpecificSpecReadinessIssue[];
}

export type SpecReadinessGateStatus = "PASS" | "WARN" | "BLOCK";

export interface SpecReadinessGateIssue {
  severity: "warning" | "blocking";
  code:
    | "planning-not-approved"
    | "source-drift"
    | "missing-spec-artifact"
    | "missing-planning-source"
    | "missing-source-snapshot"
    | "spec-read-error"
    | SourceSpecificSpecReadinessIssue["code"];
  message: string;
  remediation: string;
  line?: number;
  id?: string;
  changedFields?: string[];
}

export interface SpecReadinessGateResult {
  status: SpecReadinessGateStatus;
  summary: string;
  issues: SpecReadinessGateIssue[];
}

const GENERIC_FUNCTIONAL_REQUIREMENT_PATTERNS = [
  /requested behavior described by the source intake/i,
  /preserve a traceable link back to the source intake/i,
  /draft must not be implemented until/i,
];

const GENERIC_SUCCESS_CRITERION_PATTERNS = [
  /verified against the final refined requirements/i,
  /task record links the source intake/i,
  /draft specs are blocked from implementation runs/i,
];

const DEFAULT_OPEN_QUESTION_PATTERNS = [
  /which user-visible behavior should be considered the minimum acceptable slice/i,
  /which compatibility, migration, or failure-mode constraints should be added before approval/i,
  /which tests should be required for final acceptance/i,
];

function itemMatches(item: StructuredSpecItem, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(item.text));
}

function genericItemIssue(
  item: StructuredSpecItem,
  code: SourceSpecificSpecReadinessIssue["code"],
  message: string,
): SourceSpecificSpecReadinessIssue {
  return {
    code,
    id: item.id,
    line: item.line,
    message,
  };
}

export function evaluateSourceSpecificSpecReadiness(
  markdown: string,
): SourceSpecificSpecReadinessResult {
  const parsed = parseStructuredSpec(markdown);
  const issues: SourceSpecificSpecReadinessIssue[] = [];

  for (const diagnostic of parsed.diagnostics) {
    if (diagnostic.severity !== "error") continue;
    issues.push({
      code: "invalid-structured-spec",
      line: diagnostic.line,
      id: diagnostic.id,
      message: diagnostic.message,
    });
  }

  const genericRequirements = parsed.requirements.filter((item) =>
    itemMatches(item, GENERIC_FUNCTIONAL_REQUIREMENT_PATTERNS),
  );
  const genericSuccessCriteria = parsed.successCriteria.filter((item) =>
    itemMatches(item, GENERIC_SUCCESS_CRITERION_PATTERNS),
  );

  issues.push(
    ...genericRequirements.map((item) =>
      genericItemIssue(
        item,
        "generic-functional-requirement",
        `${item.id} still describes the source intake instead of a concrete requirement`,
      ),
    ),
  );
  issues.push(
    ...genericSuccessCriteria.map((item) =>
      genericItemIssue(
        item,
        "generic-success-criterion",
        `${item.id} still depends on final refined requirements instead of a concrete check`,
      ),
    ),
  );

  const sourceSpecificRequirements = parsed.requirements.filter(
    (item) => !genericRequirements.includes(item),
  );
  const sourceSpecificSuccessCriteria = parsed.successCriteria.filter(
    (item) => !genericSuccessCriteria.includes(item),
  );

  if (sourceSpecificRequirements.length === 0) {
    issues.push({
      code: "missing-source-specific-functional-requirement",
      message: "at least one source-specific FR is required before approval",
    });
  }
  if (sourceSpecificSuccessCriteria.length === 0) {
    issues.push({
      code: "missing-source-specific-success-criterion",
      message: "at least one source-specific SC is required before approval",
    });
  }

  markdown.split(/\r?\n/).forEach((line, index) => {
    if (!DEFAULT_OPEN_QUESTION_PATTERNS.some((pattern) => pattern.test(line))) return;
    issues.push({
      code: "default-open-question",
      line: index + 1,
      message: "generated open question must be answered, removed, or replaced",
    });
  });

  return {
    ready: issues.length === 0,
    issues,
  };
}

export function formatSourceSpecificSpecReadinessError(
  result: SourceSpecificSpecReadinessResult,
): string {
  const details = result.issues
    .slice(0, 3)
    .map((issue) => {
      const location = issue.line ? `line ${issue.line}: ` : "";
      return `${location}${issue.message}`;
    })
    .join("; ");
  return [
    "source-specific requirements are required before approving this generated spec",
    details,
  ]
    .filter(Boolean)
    .join(": ");
}

function gateIssue(
  severity: SpecReadinessGateIssue["severity"],
  code: SpecReadinessGateIssue["code"],
  message: string,
  remediation: string,
  extra: Omit<
    SpecReadinessGateIssue,
    "severity" | "code" | "message" | "remediation"
  > = {},
): SpecReadinessGateIssue {
  return { severity, code, message, remediation, ...extra };
}

function sourceForTask(task: WorkItemRecord) {
  return task.planningSource;
}

function localFileInputUri(task: WorkItemRecord, inputId: string): string | undefined {
  const input = task.inputs[inputId];
  return input?.connector === "local-file" ? input.uri : undefined;
}

function specPathForTask(task: WorkItemRecord): string | undefined {
  return (
    task.planning?.artifacts.spec?.path ??
    task.specPath ??
    localFileInputUri(task, "spec")
  );
}

function planningStatusForTask(task: WorkItemRecord): PlanningApprovalStatus | undefined {
  return task.planning;
}

function summarizeGate(issues: SpecReadinessGateIssue[]): SpecReadinessGateResult {
  if (issues.some((issue) => issue.severity === "blocking")) {
    return {
      status: "BLOCK",
      summary: "spec readiness blocks execution",
      issues,
    };
  }
  if (issues.length > 0) {
    return {
      status: "WARN",
      summary: "spec readiness has warnings",
      issues,
    };
  }
  return {
    status: "PASS",
    summary: "spec readiness passed",
    issues: [],
  };
}

async function readSpecForTask(
  repoPath: string,
  task: WorkItemRecord,
): Promise<{ path: string; markdown: string } | SpecReadinessGateIssue> {
  const specPath = specPathForTask(task);
  if (!specPath) {
    return gateIssue(
      "warning",
      "missing-spec-artifact",
      "no spec artifact is recorded for this work item",
      "Attach an approved spec artifact or run a flow that provides one explicitly.",
    );
  }
  try {
    return {
      path: specPath,
      markdown: await readFile(resolve(repoPath, specPath), "utf8"),
    };
  } catch {
    return gateIssue(
      "blocking",
      "spec-read-error",
      `spec artifact could not be read: ${specPath}`,
      "Regenerate or reattach the spec artifact before scheduling implementation.",
    );
  }
}

export async function evaluateWorkItemSpecReadiness(
  repoPath: string,
  task: WorkItemRecord,
): Promise<SpecReadinessGateResult> {
  const issues: SpecReadinessGateIssue[] = [];
  const planning = planningStatusForTask(task);
  const planningState = derivePlanningExecutionState(planning);
  if (planningState !== "ready_for_execution") {
    issues.push(
      gateIssue(
        "blocking",
        "planning-not-approved",
        `planning state "${planningState}" is not ready for execution`,
        "Approve the spec and technical design before scheduling implementation.",
      ),
    );
  }

  const source = sourceForTask(task);
  if (source?.drift?.status === "changed") {
    issues.push(
      gateIssue(
        "blocking",
        "source-drift",
        "source issue changed since planning",
        "Refresh planning or start manually with an explicit override reason.",
        { changedFields: source.drift.changedFields },
      ),
    );
  }

  const spec = await readSpecForTask(repoPath, task);
  if ("severity" in spec) {
    issues.push(spec);
    return summarizeGate(issues);
  }

  if (!source) {
    issues.push(
      gateIssue(
        "warning",
        "missing-planning-source",
        "no source snapshot is recorded for this work item",
        "Use source-backed planning for tasks that should be scheduler-gated against changing requirements.",
      ),
    );
    return summarizeGate(issues);
  }

  if (!source.snapshot) {
    issues.push(
      gateIssue(
        "warning",
        "missing-source-snapshot",
        "planning source has no fetched snapshot",
        "Refresh or recreate planning from the source ticket so drift can be checked before execution.",
      ),
    );
  }

  const sourceSpecific = evaluateSourceSpecificSpecReadiness(spec.markdown);
  if (!sourceSpecific.ready) {
    issues.push(
      ...sourceSpecific.issues.map((issue) =>
        gateIssue(
          "blocking",
          issue.code,
          issue.message,
          "Refine the spec with concrete source-specific behavior, edge cases, and verification before scheduling.",
          {
            ...(issue.line ? { line: issue.line } : {}),
            ...(issue.id ? { id: issue.id } : {}),
          },
        ),
      ),
    );
  }

  return summarizeGate(issues);
}

export function formatSpecReadinessGateError(
  result: SpecReadinessGateResult,
): string {
  const details = result.issues
    .filter((issue) => issue.severity === "blocking")
    .slice(0, 3)
    .map((issue) => {
      const location = issue.line ? `line ${issue.line}: ` : "";
      return `${location}${issue.message}`;
    })
    .join("; ");
  return ["spec readiness blocks execution", details]
    .filter(Boolean)
    .join(": ");
}
