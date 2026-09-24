import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import { EventStore } from "./events/store.js";
import type { RunEventType } from "./events/types.js";
import { eventStorePath } from "./run/project.js";
import type { TaskSourceSnapshot } from "./web/tasks.js";
import type { WorkItemRecord } from "./work-items/types.js";

export type FactoryCandidateStatus =
  | "candidate"
  | "evaluating"
  | "rejected"
  | "duplicate"
  | "needs_human"
  | "eligible"
  | "queued"
  | "running"
  | "blocked"
  | "completed";
export type FactoryEligibilityDecision =
  | "eligible"
  | "rejected"
  | "duplicate"
  | "needs_human";
export type FactoryRiskClass = "low" | "medium" | "high" | "critical";

export interface FactoryQueuePolicy {
  schemaVersion: "nitely.factory-queue-policy.v1";
  autoQueue: boolean;
  requiredLabels: string[];
  forbiddenLabels: string[];
  allowedWorkItemTypes: string[];
  allowedStates: string[];
  allowedAssignees: string[];
  maxEstimatedChangeSize?: number;
  allowedPathPrefixes: string[];
  forbiddenPathPrefixes: string[];
  requireSpecApproved: boolean;
  requireTechDesignApproved: boolean;
  maxRiskClass: FactoryRiskClass;
  maxConcurrentRuns: number;
}

export interface FactoryCandidateSource {
  type: "github-issue" | "explicit" | "schedule";
  identity: string;
  uri?: string;
  snapshot?: TaskSourceSnapshot;
}

export interface FactoryCandidate {
  schemaVersion: "nitely.factory-candidate.v1";
  id: string;
  title: string;
  status: FactoryCandidateStatus;
  workItemId?: string;
  issueUrl?: string;
  source: FactoryCandidateSource;
  labels: string[];
  assignees: string[];
  state?: string;
  workItemType: string;
  estimatedChangeSize?: number;
  pathFamilies: string[];
  riskClass: FactoryRiskClass;
  planning: { specApproved: boolean; techDesignApproved: boolean };
  eligibility?: {
    decision: FactoryEligibilityDecision;
    reasons: string[];
    evaluatedAt: string;
  };
  createdAt: string;
  updatedAt: string;
  lastDispatchAt?: string;
}

export interface FactoryQueueDocument {
  schemaVersion: "nitely.factory-queue.v1";
  paused: boolean;
  candidates: FactoryCandidate[];
  updatedAt: string;
}

export interface FactoryQueueSnapshot {
  policy: FactoryQueuePolicy;
  queue: FactoryQueueDocument;
}

const riskRank: Record<FactoryRiskClass, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const policySchema = z.object({
  schemaVersion: z.literal("nitely.factory-queue-policy.v1").default("nitely.factory-queue-policy.v1"),
  autoQueue: z.boolean().default(true),
  requiredLabels: z.array(z.string().trim().min(1)).default([]),
  forbiddenLabels: z.array(z.string().trim().min(1)).default([]),
  allowedWorkItemTypes: z.array(z.string().trim().min(1)).default([]),
  allowedStates: z.array(z.string().trim().min(1)).default(["open"]),
  allowedAssignees: z.array(z.string().trim().min(1)).default([]),
  maxEstimatedChangeSize: z.number().finite().nonnegative().optional(),
  allowedPathPrefixes: z.array(z.string().trim().min(1)).default([]),
  forbiddenPathPrefixes: z.array(z.string().trim().min(1)).default([]),
  requireSpecApproved: z.boolean().default(true),
  requireTechDesignApproved: z.boolean().default(true),
  maxRiskClass: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  maxConcurrentRuns: z.number().int().positive().max(64).default(1),
}).strict();

const candidateSchema = z.object({
  schemaVersion: z.literal("nitely.factory-candidate.v1"),
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(["candidate", "evaluating", "rejected", "duplicate", "needs_human", "eligible", "queued", "running", "blocked", "completed"]),
  workItemId: z.string().optional(),
  issueUrl: z.string().optional(),
  source: z.object({
    type: z.enum(["github-issue", "explicit", "schedule"]),
    identity: z.string().min(1),
    uri: z.string().optional(),
    snapshot: z.unknown().optional(),
  }).strict(),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  state: z.string().optional(),
  workItemType: z.string().min(1),
  estimatedChangeSize: z.number().finite().nonnegative().optional(),
  pathFamilies: z.array(z.string()),
  riskClass: z.enum(["low", "medium", "high", "critical"]),
  planning: z.object({ specApproved: z.boolean(), techDesignApproved: z.boolean() }).strict(),
  eligibility: z.object({
    decision: z.enum(["eligible", "rejected", "duplicate", "needs_human"]),
    reasons: z.array(z.string()),
    evaluatedAt: z.string(),
  }).strict().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastDispatchAt: z.string().optional(),
}).strict();

const queueSchema = z.object({
  schemaVersion: z.literal("nitely.factory-queue.v1"),
  paused: z.boolean(),
  candidates: z.array(candidateSchema),
  updatedAt: z.string(),
}).strict();

function queuePath(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "factory-queue", "queue.json");
}

function policyPath(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "factory-queue-policy.json");
}

function nowIso(now?: () => Date): string {
  return (now?.() ?? new Date()).toISOString();
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + process.pid + "." + Date.now() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export const defaultFactoryQueuePolicy: FactoryQueuePolicy = {
  schemaVersion: "nitely.factory-queue-policy.v1",
  autoQueue: true,
  requiredLabels: [],
  forbiddenLabels: [],
  allowedWorkItemTypes: [],
  allowedStates: ["open"],
  allowedAssignees: [],
  allowedPathPrefixes: [],
  forbiddenPathPrefixes: [],
  requireSpecApproved: true,
  requireTechDesignApproved: true,
  maxRiskClass: "medium",
  maxConcurrentRuns: 1,
};

export async function loadFactoryQueuePolicy(repoPath: string): Promise<FactoryQueuePolicy> {
  try {
    const document = await readFile(policyPath(repoPath), "utf8");
    return policySchema.parse(JSON.parse(document) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultFactoryQueuePolicy;
    throw error;
  }
}

export async function loadFactoryQueue(repoPath: string): Promise<FactoryQueueDocument> {
  try {
    return queueSchema.parse(JSON.parse(await readFile(queuePath(repoPath), "utf8")) as unknown) as unknown as FactoryQueueDocument;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        schemaVersion: "nitely.factory-queue.v1",
        paused: false,
        candidates: [],
        updatedAt: new Date(0).toISOString(),
      };
    }
    throw error;
  }
}

async function saveFactoryQueue(repoPath: string, queue: FactoryQueueDocument): Promise<void> {
  await writeJsonAtomic(queuePath(repoPath), queue);
}

function sourceIdentity(input: Pick<FactoryCandidateSource, "type" | "identity">): string {
  return input.type + ":" + input.identity.trim().toLowerCase();
}

function candidateId(identity: string): string {
  return "candidate-" + createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 32);
}

function normalizedValues(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
}

function hasPrefix(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value === prefix || value.startsWith(prefix + "/"));
}

async function auditCandidate(repoPath: string, candidate: FactoryCandidate, type: RunEventType, payload: unknown): Promise<void> {
  try {
    await mkdir(dirname(eventStorePath(repoPath)), { recursive: true });
    const store = new EventStore(eventStorePath(repoPath));
    try {
      store.append({ runId: candidate.id, type, payload });
    } finally {
      store.close();
    }
  } catch {
    // Queue state remains authoritative when audit storage is unavailable.
  }
}

function evaluateCandidate(candidate: FactoryCandidate, policy: FactoryQueuePolicy): {
  decision: FactoryEligibilityDecision;
  reasons: string[];
} {
  const labels = new Set(normalizedValues(candidate.labels));
  const reasons: string[] = [];
  for (const label of policy.requiredLabels) {
    if (!labels.has(label.trim().toLowerCase())) reasons.push("required label missing: " + label);
  }
  for (const label of policy.forbiddenLabels) {
    if (labels.has(label.trim().toLowerCase())) reasons.push("forbidden label present: " + label);
  }
  if (policy.allowedWorkItemTypes.length > 0 && !policy.allowedWorkItemTypes.includes(candidate.workItemType)) {
    reasons.push("work item type not allowed: " + candidate.workItemType);
  }
  if (candidate.state && policy.allowedStates.length > 0 && !policy.allowedStates.includes(candidate.state.toLowerCase())) {
    reasons.push("upstream state not allowed: " + candidate.state);
  }
  if (policy.allowedAssignees.length > 0 && !candidate.assignees.some((assignee) => policy.allowedAssignees.includes(assignee))) {
    reasons.push("assignee is not allowed");
  }
  if (candidate.estimatedChangeSize !== undefined && policy.maxEstimatedChangeSize !== undefined && candidate.estimatedChangeSize > policy.maxEstimatedChangeSize) {
    reasons.push("estimated change size exceeds policy");
  }
  if (policy.allowedPathPrefixes.length > 0 && candidate.pathFamilies.some((path) => !hasPrefix(path, policy.allowedPathPrefixes))) {
    reasons.push("path family is outside the allowlist");
  }
  if (candidate.pathFamilies.some((path) => hasPrefix(path, policy.forbiddenPathPrefixes))) {
    reasons.push("path family is forbidden");
  }
  const needsHuman: string[] = [];
  if (riskRank[candidate.riskClass] > riskRank[policy.maxRiskClass]) needsHuman.push("risk class exceeds unattended ceiling");
  if (policy.requireSpecApproved && !candidate.planning.specApproved) needsHuman.push("spec approval is required");
  if (policy.requireTechDesignApproved && !candidate.planning.techDesignApproved) needsHuman.push("technical design approval is required");
  if (reasons.length > 0) return { decision: "rejected", reasons };
  if (needsHuman.length > 0) return { decision: "needs_human", reasons: needsHuman };
  return { decision: "eligible", reasons: [] };
}

export async function upsertFactoryCandidate(input: {
  repoPath: string;
  title: string;
  source: FactoryCandidateSource;
  workItemId?: string;
  issueUrl?: string;
  labels?: string[];
  assignees?: string[];
  state?: string;
  workItemType?: string;
  estimatedChangeSize?: number;
  pathFamilies?: string[];
  riskClass?: FactoryRiskClass;
  planning?: Partial<FactoryCandidate["planning"]>;
  duplicateReason?: string;
  now?: () => Date;
}): Promise<FactoryCandidate> {
  const policy = await loadFactoryQueuePolicy(input.repoPath);
  const queue = await loadFactoryQueue(input.repoPath);
  const timestamp = nowIso(input.now);
  const identity = sourceIdentity(input.source);
  const id = candidateId(identity);
  const prior = queue.candidates.find((candidate) => candidate.id === id);
  const candidate: FactoryCandidate = {
    schemaVersion: "nitely.factory-candidate.v1",
    id,
    title: input.title.trim() || "Untitled candidate",
    status: prior?.status ?? "candidate",
    ...(input.workItemId ? { workItemId: input.workItemId } : prior?.workItemId ? { workItemId: prior.workItemId } : {}),
    ...(input.issueUrl ? { issueUrl: input.issueUrl } : prior?.issueUrl ? { issueUrl: prior.issueUrl } : {}),
    source: { ...input.source, identity },
    labels: normalizedValues(input.labels ?? prior?.labels),
    assignees: normalizedValues(input.assignees ?? prior?.assignees),
    ...(input.state ? { state: input.state.toLowerCase() } : prior?.state ? { state: prior.state } : {}),
    workItemType: input.workItemType ?? prior?.workItemType ?? "dev.pr",
    ...(input.estimatedChangeSize !== undefined ? { estimatedChangeSize: input.estimatedChangeSize } : prior?.estimatedChangeSize !== undefined ? { estimatedChangeSize: prior.estimatedChangeSize } : {}),
    pathFamilies: input.pathFamilies ?? prior?.pathFamilies ?? [],
    riskClass: input.riskClass ?? prior?.riskClass ?? "medium",
    planning: {
      specApproved: input.planning?.specApproved ?? prior?.planning.specApproved ?? false,
      techDesignApproved: input.planning?.techDesignApproved ?? prior?.planning.techDesignApproved ?? false,
    },
    ...(prior?.createdAt ? { createdAt: prior.createdAt } : { createdAt: timestamp }),
    updatedAt: timestamp,
  };
  if (input.source.snapshot) candidate.source.snapshot = input.source.snapshot;

  if (input.duplicateReason) {
    candidate.status = "duplicate";
    candidate.eligibility = {
      decision: "duplicate",
      reasons: [input.duplicateReason],
      evaluatedAt: timestamp,
    };
  } else if (candidate.workItemId && (prior?.status === "running" || prior?.status === "completed")) {
    candidate.status = prior.status;
  } else {
    candidate.status = "evaluating";
    const duplicate = Boolean(input.issueUrl && prior?.status === "completed");
    const result = duplicate
      ? { decision: "duplicate" as const, reasons: ["source already has a completed candidate"] }
      : evaluateCandidate(candidate, policy);
    candidate.status = result.decision === "eligible" ? (policy.autoQueue ? "queued" : "eligible") : result.decision;
    candidate.eligibility = { ...result, evaluatedAt: timestamp };
  }
  queue.candidates = [
    ...queue.candidates.filter((entry) => entry.id !== id),
    candidate,
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  queue.updatedAt = timestamp;
  await saveFactoryQueue(input.repoPath, queue);
  await auditCandidate(input.repoPath, candidate, "factory.candidate.evaluated", {
    status: candidate.status,
    eligibility: candidate.eligibility,
  });
  return candidate;
}

export async function upsertFactoryCandidateForWorkItem(
  repoPath: string,
  workItem: WorkItemRecord,
  now?: () => Date,
): Promise<FactoryCandidate | undefined> {
  const source = workItem.planningSource;
  if (!source?.snapshot || source.type !== "github-issue") return undefined;
  return upsertFactoryCandidate({
    repoPath,
    title: workItem.title,
    workItemId: workItem.id,
    issueUrl: workItem.issueUrl ?? source.snapshot.uri,
    source: {
      type: "github-issue",
      identity: source.snapshot.externalId ?? source.snapshot.uri,
      uri: source.snapshot.uri,
      snapshot: source.snapshot,
    },
    labels: source.snapshot.labels,
    assignees: source.snapshot.assignees,
    state: source.snapshot.state,
    workItemType: workItem.workItemType,
    planning: {
      specApproved: workItem.specStatus === "approved",
      techDesignApproved: workItem.techDesignStatus === "approved",
    },
    ...(workItem.changeRequestUrl
      ? { duplicateReason: "source already has an open change request" }
      : workItem.status === "running"
        ? { duplicateReason: "source already has a running task" }
        : {}),
    now,
  });
}

export async function setFactoryQueuePaused(repoPath: string, paused: boolean, now?: () => Date): Promise<FactoryQueueDocument> {
  const queue = await loadFactoryQueue(repoPath);
  queue.paused = paused;
  queue.updatedAt = nowIso(now);
  await saveFactoryQueue(repoPath, queue);
  return queue;
}

export async function getFactoryQueueSnapshot(repoPath: string): Promise<FactoryQueueSnapshot> {
  const [policy, queue] = await Promise.all([
    loadFactoryQueuePolicy(repoPath),
    loadFactoryQueue(repoPath),
  ]);
  return { policy, queue };
}

export async function dispatchFactoryQueue(input: {
  repoPath: string;
  runScheduler: (candidateIds: string[], maxConcurrentTasks: number) => Promise<{
    startedTaskIds: string[];
    completedTaskIds: string[];
    failedTaskIds: string[];
    blockedTaskIds: string[];
    awaitingApprovalTaskIds: string[];
  }>;
  now?: () => Date;
}): Promise<{
  queue: FactoryQueueDocument;
  scheduler: Awaited<ReturnType<typeof input.runScheduler>>;
}> {
  const policy = await loadFactoryQueuePolicy(input.repoPath);
  const queue = await loadFactoryQueue(input.repoPath);
  if (queue.paused) {
    return { queue, scheduler: await input.runScheduler([], policy.maxConcurrentRuns) };
  }
  const timestamp = nowIso(input.now);
  const candidates = queue.candidates.filter(
    (candidate) => candidate.status === "queued" && candidate.workItemId,
  );
  const ids = candidates.map((candidate) => candidate.workItemId!);
  for (const candidate of candidates) {
    candidate.status = "running";
    candidate.lastDispatchAt = timestamp;
  }
  queue.updatedAt = timestamp;
  await saveFactoryQueue(input.repoPath, queue);
  let scheduler: Awaited<ReturnType<typeof input.runScheduler>>;
  try {
    scheduler = await input.runScheduler(ids, policy.maxConcurrentRuns);
  } catch (error) {
    for (const candidate of queue.candidates) {
      if (ids.includes(candidate.workItemId ?? "")) candidate.status = "queued";
    }
    queue.updatedAt = nowIso(input.now);
    await saveFactoryQueue(input.repoPath, queue);
    throw error;
  }
  const started = new Set(scheduler.startedTaskIds);
  const completed = new Set(scheduler.completedTaskIds);
  const failed = new Set(scheduler.failedTaskIds);
  const blocked = new Set(scheduler.blockedTaskIds);
  const awaiting = new Set(scheduler.awaitingApprovalTaskIds);
  for (const candidate of queue.candidates) {
    if (!candidate.workItemId || !ids.includes(candidate.workItemId)) continue;
    candidate.status = completed.has(candidate.workItemId)
      ? "completed"
      : awaiting.has(candidate.workItemId)
        ? "needs_human"
        : failed.has(candidate.workItemId) || blocked.has(candidate.workItemId)
          ? "blocked"
          : started.has(candidate.workItemId)
            ? "running"
            : "queued";
    candidate.updatedAt = timestamp;
  }
  queue.updatedAt = timestamp;
  await saveFactoryQueue(input.repoPath, queue);
  await Promise.all(candidates.map((candidate) => auditCandidate(
    input.repoPath,
    candidate,
    "factory.queue.dispatched",
    { status: candidate.status, scheduler },
  )));
  return { queue, scheduler };
}
