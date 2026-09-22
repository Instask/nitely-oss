import { readFile } from "node:fs/promises";

import type { ProviderConnectionStore } from "../providers/types.js";
import { FlowValidationError, parseFlowDocument } from "../flow/load.js";
import type { LoadedFlow } from "../flow/load.js";
import { createScmProvider } from "../scm/registry.js";
import type { ChangeRequestStatus } from "../scm/types.js";
import { createCompletionPredicate } from "../scheduler/completion.js";
import {
  evaluateWorkItemSpecReadiness,
  formatSpecReadinessGateError,
  type SpecReadinessGateResult,
} from "../spec-artifacts/readiness.js";
import { derivePlanningExecutionState } from "../work-items/planning.js";
import type { WorkItemRecord } from "../work-items/types.js";
import { evaluateWorkItemTypeGovernance } from "../work-items/governance.js";
import { openFlowStore } from "../flows/store.js";
import { getFlowTemplate } from "../flows/templates.js";
import { resolveRepositoryFlowPath } from "../flows/paths.js";
import type { RunFlowInput } from "./run-flow.js";
import {
  evaluateRunPreflight,
  formatRunPreflightError,
  type RunPreflightReport,
} from "./preflight.js";

export type RunEligibilityReasonKind =
  | "status"
  | "planning"
  | "missing"
  | "failed"
  | "incomplete"
  | "source-drift"
  | "spec-readiness"
  | "governance"
  | "preflight";

export interface RunEligibilityReason {
  code: string;
  kind: RunEligibilityReasonKind;
  message: string;
  remediation?: string;
  overridePolicy: "never" | "manual";
  upstreamId?: string;
  changedFields?: string[];
}

export type RunEligibilityIntent =
  | { kind: "automatic" }
  | {
      kind: "manual";
      override?: { actor: string; reason: string };
    };

export interface RunEligibilityDecision {
  workItemId: string;
  decision: "eligible" | "blocked";
  blockers: RunEligibilityReason[];
  warnings: RunEligibilityReason[];
  overridden: RunEligibilityReason[];
  override?: RunEligibilityOverrideEvidence;
  checks: {
    specReadiness?: SpecReadinessGateResult;
    preflight?: RunPreflightReport;
  };
}

export interface RunEligibilityOverrideEvidence {
  actor: string;
  reason: string;
  acceptedReasonCodes: string[];
}

export interface EvaluateWorkItemRunStartsInput {
  repoPath: string;
  repoId?: string;
  repoName?: string;
  workItems: WorkItemRecord[];
  candidateIds?: readonly string[];
  intent: RunEligibilityIntent;
  providerStore?: ProviderConnectionStore;
  getChangeRequestStatus?: (
    url: string,
  ) => Promise<ChangeRequestStatus>;
}

export interface EvaluatedWorkItemRunStarts {
  eligibility: Record<string, RunEligibilityDecision>;
  runInputs: Record<string, RunFlowInput>;
}

interface ResolvedWorkItemRunFlow {
  flowPath: string;
  flowDocument: string;
  loaded: LoadedFlow;
}

type WorkItemRunFlowResolution =
  | { resolved: ResolvedWorkItemRunFlow }
  | { reason: RunEligibilityReason };

async function resolveWorkItemRunFlow(
  repoPath: string,
  workItem: WorkItemRecord,
): Promise<WorkItemRunFlowResolution> {
  let flowPath = workItem.flowPath;
  let flowDocument: string;
  try {
    if (workItem.flowId) {
      const store = openFlowStore(repoPath);
      try {
        flowDocument = store.getFlow(workItem.flowId).document;
      } finally {
        store.close();
      }
      flowPath = workItem.flowId;
    } else if (workItem.template) {
      const template = getFlowTemplate(workItem.template.templateId);
      if (!template) {
        throw new Error(`flow template not found: ${workItem.template.templateId}`);
      }
      flowDocument = template.document;
    } else {
      flowPath = (
        await resolveRepositoryFlowPath(repoPath, workItem.flowPath)
      ).absolutePath;
      flowDocument = await readFile(flowPath, "utf8");
    }
    const loaded = parseFlowDocument(flowDocument, {
      externalInputs: Object.keys(workItem.inputs),
    });
    return {
      resolved: {
        flowPath,
        flowDocument,
        loaded,
      },
    };
  } catch (error) {
    const invalid = error instanceof FlowValidationError;
    const message = invalid
      ? error.errors[0] ?? error.message
      : error instanceof Error
        ? error.message
        : `flow could not be read: ${flowPath}`;
    return {
      reason: {
        code: invalid ? "preflight.flow-invalid" : "preflight.flow-unreadable",
        kind: "preflight",
        message,
        remediation: invalid
          ? "Fix the Flow JSON, schema, or dependency graph before starting a Run."
          : "Ensure the Work item references an available Flow inside the repository.",
        overridePolicy: "never",
      },
    };
  }
}

function statusReason(
  workItem: WorkItemRecord,
  intent: RunEligibilityIntent,
): RunEligibilityReason | undefined {
  if (intent.kind === "automatic") {
    if (workItem.status === "ready") return undefined;
    return {
      code: `status.${workItem.status}`,
      kind: "status",
      message: `work item status "${workItem.status}" is not ready for automatic execution`,
      overridePolicy: "never",
    };
  }
  if (workItem.status === "draft") {
    const planning = planningReason(workItem);
    if (planning) return planning;
    return {
      code: "status.draft",
      kind: "status",
      message: "draft work item must be approved before starting a run",
      overridePolicy: "never",
    };
  }
  if (workItem.status === "running") {
    return {
      code: "status.running",
      kind: "status",
      message:
        workItem.workItemType === "dev.pr"
          ? "task is already running"
          : "work item is already running",
      overridePolicy: "never",
    };
  }
  return undefined;
}

function planningReason(workItem: WorkItemRecord): RunEligibilityReason | undefined {
  if (workItem.specStatus === "draft") {
    return {
      code: "planning.draft_spec",
      kind: "planning",
      message: "draft spec must be approved before starting a run",
      overridePolicy: "never",
    };
  }
  if (
    workItem.specStatus === "approved" &&
    workItem.techDesignStatus === undefined
  ) {
    return {
      code: "planning.draft_tech_design",
      kind: "planning",
      message: "draft technical design is required before starting a run",
      overridePolicy: "never",
    };
  }
  if (workItem.techDesignStatus === "draft") {
    return {
      code: "planning.draft_tech_design",
      kind: "planning",
      message: "draft technical design must be approved before starting a run",
      overridePolicy: "never",
    };
  }
  const state = derivePlanningExecutionState(workItem.planning);
  if (state === "ready_for_execution") return undefined;
  let message = `planning state "${state}" blocks execution`;
  if (state === "draft_spec" || state === "spec_needs_clarification") {
    message = "spec must be approved before starting a run";
  } else if (state === "draft_tech_design") {
    message = workItem.planning?.artifacts.techDesign
      ? "tech design must be approved before starting a run"
      : "draft technical design is required before starting a run";
  } else if (state === "tasks_generated") {
    message = "tasks must be approved before starting a run";
  }
  return {
    code: `planning.${state}`,
    kind: "planning",
    message,
    overridePolicy: "never",
  };
}

function dependencyReason(input: {
  workItem: WorkItemRecord;
  byId: Map<string, WorkItemRecord>;
  isComplete: (id: string) => boolean;
}): RunEligibilityReason[] {
  const reasons: RunEligibilityReason[] = [];
  const dependencies = [...new Set(input.workItem.dependsOn ?? [])].filter(
    (id) => id && id !== input.workItem.id,
  );
  for (const upstreamId of dependencies) {
    const upstream = input.byId.get(upstreamId);
    if (!upstream) {
      reasons.push({
        code: `dependency.missing:${upstreamId}`,
        kind: "missing",
        upstreamId,
        message: `${upstreamId} is missing`,
        overridePolicy: "manual",
      });
    } else if (upstream.status === "failed") {
      reasons.push({
        code: `dependency.failed:${upstreamId}`,
        kind: "failed",
        upstreamId,
        message: `${upstreamId} is failed`,
        overridePolicy: "manual",
      });
    } else if (!input.isComplete(upstreamId)) {
      reasons.push({
        code: `dependency.incomplete:${upstreamId}`,
        kind: "incomplete",
        upstreamId,
        message: `${upstreamId} is incomplete`,
        overridePolicy: "manual",
      });
    }
  }
  return reasons;
}

function readinessReasons(
  readiness: SpecReadinessGateResult,
): { blockers: RunEligibilityReason[]; warnings: RunEligibilityReason[] } {
  const blockers: RunEligibilityReason[] = [];
  const warnings: RunEligibilityReason[] = [];
  for (const issue of readiness.issues) {
    if (issue.code === "planning-not-approved") continue;
    const reason: RunEligibilityReason = {
      code: `spec-readiness.${issue.code}`,
      kind: issue.code === "source-drift" ? "source-drift" : "spec-readiness",
      message: issue.message,
      remediation: issue.remediation,
      overridePolicy: issue.severity === "blocking" ? "manual" : "never",
      ...(issue.changedFields ? { changedFields: issue.changedFields } : {}),
    };
    (issue.severity === "blocking" ? blockers : warnings).push(reason);
  }
  return { blockers, warnings };
}

function preflightReasons(
  report: RunPreflightReport,
): { blockers: RunEligibilityReason[]; warnings: RunEligibilityReason[] } {
  const blockers: RunEligibilityReason[] = [];
  const warnings: RunEligibilityReason[] = [];
  for (const issue of report.issues) {
    const reason: RunEligibilityReason = {
      code: `preflight.${issue.code}`,
      kind: "preflight",
      message: issue.message,
      remediation: issue.remediation,
      overridePolicy: "never",
    };
    (issue.severity === "blocking" ? blockers : warnings).push(reason);
  }
  return { blockers, warnings };
}

async function changeRequestCompletion(
  input: EvaluateWorkItemRunStartsInput,
  dependencies: WorkItemRecord[],
) {
  const provider = createScmProvider("github", {
    ...(input.providerStore ? { store: input.providerStore } : {}),
  });
  const getStatus =
    input.getChangeRequestStatus ??
    (async (target: string): Promise<ChangeRequestStatus> => {
      if (!provider.getChangeRequestStatus) {
        return { provider: "unknown", state: "unknown", merged: false };
      }
      return provider.getChangeRequestStatus({ target });
    });
  return createCompletionPredicate(
    dependencies as Parameters<typeof createCompletionPredicate>[0],
    getStatus,
  );
}

function applyOverride(input: {
  blockers: RunEligibilityReason[];
  intent: RunEligibilityIntent;
}): {
  blockers: RunEligibilityReason[];
  overridden: RunEligibilityReason[];
  override?: RunEligibilityOverrideEvidence;
} {
  if (input.intent.kind !== "manual" || !input.intent.override) {
    return { blockers: input.blockers, overridden: [] };
  }
  const overridden = input.blockers.filter(
    (reason) => reason.overridePolicy === "manual",
  );
  return {
    blockers: input.blockers.filter(
      (reason) => reason.overridePolicy !== "manual",
    ),
    overridden,
    ...(overridden.length > 0
      ? {
          override: {
            actor: input.intent.override.actor,
            reason: input.intent.override.reason,
            acceptedReasonCodes: overridden.map((reason) => reason.code),
          },
        }
      : {}),
  };
}

export async function evaluateWorkItemRunStarts(
  input: EvaluateWorkItemRunStartsInput,
): Promise<EvaluatedWorkItemRunStarts> {
  const byId = new Map(input.workItems.map((item) => [item.id, item]));
  const candidateIds = input.candidateIds ?? input.workItems.map((item) => item.id);
  const candidates = candidateIds.map((workItemId) => {
    const workItem = byId.get(workItemId);
    if (!workItem) {
      throw new Error(`run eligibility candidate not found: ${workItemId}`);
    }
    return workItem;
  });
  const dependencyIds = new Set(
    candidates
      .filter((workItem) =>
        input.intent.kind === "automatic"
          ? workItem.status === "ready"
          : workItem.status !== "draft" && workItem.status !== "running",
      )
      .flatMap((workItem) => workItem.dependsOn ?? []),
  );
  const dependencies = input.workItems.filter((workItem) =>
    dependencyIds.has(workItem.id),
  );
  const isComplete =
    dependencies.length > 0
      ? await changeRequestCompletion(input, dependencies)
      : () => false;
  const entries = await Promise.all(
    candidates.map(async (workItem) => {
      const workItemId = workItem.id;
      const status = statusReason(workItem, input.intent);
      if (status) {
        return {
          workItemId,
          decision: {
            workItemId,
            decision: "blocked" as const,
            blockers: [status],
            warnings: [],
            overridden: [],
            checks: {},
          },
        };
      }
      const planning = planningReason(workItem);
      if (planning) {
        return {
          workItemId,
          decision: {
            workItemId,
            decision: "blocked" as const,
            blockers: [planning],
            warnings: [],
            overridden: [],
            checks: {},
          },
        };
      }
      const flowResolution = await resolveWorkItemRunFlow(input.repoPath, workItem);
      if ("reason" in flowResolution) {
        return {
          workItemId,
          decision: {
            workItemId,
            decision: "blocked" as const,
            blockers: [flowResolution.reason],
            warnings: [],
            overridden: [],
            checks: {},
          },
        };
      }
      const resolvedFlow = flowResolution.resolved;
      const governance = await evaluateWorkItemTypeGovernance({
        repoPath: input.repoPath,
        workItemType: workItem.workItemType,
        loaded: resolvedFlow.loaded,
      });
      if (governance.decision === "deny") {
        return {
          workItemId,
          decision: {
            workItemId,
            decision: "blocked" as const,
            blockers: [
              {
                code: governance.reason.code,
                kind: "governance" as const,
                message: governance.reason.message,
                overridePolicy: "never" as const,
              },
            ],
            warnings: [],
            overridden: [],
            checks: {},
          },
        };
      }
      const [specReadiness, preflight] = await Promise.all([
        evaluateWorkItemSpecReadiness(input.repoPath, workItem),
        evaluateRunPreflight({
          repoPath: input.repoPath,
          flowPath: resolvedFlow.flowPath,
          flowDocument: resolvedFlow.flowDocument,
          inputs: workItem.inputs,
          ...(input.providerStore ? { providerStore: input.providerStore } : {}),
        }),
      ]);
      const readiness = readinessReasons(specReadiness);
      const runPreflight = preflightReasons(preflight);
      const rawBlockers = [
        ...runPreflight.blockers,
        ...readiness.blockers,
        ...dependencyReason({ workItem, byId, isComplete }),
      ];
      const resolved = applyOverride({ blockers: rawBlockers, intent: input.intent });
      const decision: RunEligibilityDecision = {
        workItemId,
        decision: resolved.blockers.length === 0 ? "eligible" : "blocked",
        blockers: resolved.blockers,
        warnings: [...runPreflight.warnings, ...readiness.warnings],
        overridden: resolved.overridden,
        ...(resolved.override ? { override: resolved.override } : {}),
        checks: { specReadiness, preflight },
      };
      const runInput: RunFlowInput | undefined =
        decision.decision === "eligible"
          ? {
              flowPath: resolvedFlow.flowPath,
              flowDocument: resolvedFlow.flowDocument,
              repoPath: input.repoPath,
              ...(workItem.repoId ?? input.repoId
                ? { repoId: workItem.repoId ?? input.repoId }
                : {}),
              ...(input.repoName ? { repoName: input.repoName } : {}),
              inputs: workItem.inputs,
              ...(workItem.configuration
                ? { configuration: workItem.configuration }
                : {}),
              workItemId: workItem.id,
              workItemType: workItem.workItemType,
              ...(workItem.planning
                ? { planningApproval: workItem.planning }
                : {}),
              ...(decision.override
                ? { runEligibilityOverride: decision.override }
                : {}),
              ...(workItem.ownerId ? { ownerId: workItem.ownerId } : {}),
              ...(workItem.organizationId
                ? { organizationId: workItem.organizationId }
                : {}),
            }
          : undefined;
      return { workItemId, decision, runInput };
    }),
  );
  const eligibility: Record<string, RunEligibilityDecision> = {};
  const runInputs: Record<string, RunFlowInput> = {};
  for (const entry of entries) {
    eligibility[entry.workItemId] = entry.decision;
    if (entry.runInput) runInputs[entry.workItemId] = entry.runInput;
  }
  return { eligibility, runInputs };
}

export function formatRunEligibilityError(
  decision: RunEligibilityDecision,
): string {
  const first = decision.blockers[0];
  if (!first) return "work item is eligible to start";
  if (first.kind === "status" || first.kind === "planning") {
    return first.message;
  }
  const preflight = decision.checks.preflight;
  if (first.kind === "preflight" && preflight) {
    return formatRunPreflightError(preflight);
  }
  if (first.kind === "source-drift") {
    return "source issue changed since planning; refresh planning or start with override=true";
  }
  const readiness = decision.checks.specReadiness;
  if (first.kind === "spec-readiness" && readiness) {
    return formatSpecReadinessGateError(readiness);
  }
  const dependencies = decision.blockers.filter((reason) =>
    reason.kind === "missing" ||
    reason.kind === "failed" ||
    reason.kind === "incomplete",
  );
  if (dependencies.length > 0) {
    return `task is blocked by dependencies: ${dependencies
      .map((reason) => reason.message)
      .join("; ")}`;
  }
  return first.message;
}
