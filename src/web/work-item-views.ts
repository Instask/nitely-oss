import { readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import type { RunArtifact } from "../artifacts/types.js";
import {
  DEV_PR_WORK_ITEM_TYPE,
  getUnifiedWorkItem,
  listUnifiedWorkItems,
} from "../work-items/access.js";
import type { ResourceReference } from "../connectors/types.js";
import type { WorkItemRecord } from "../work-items/types.js";
import { WebNotFoundError } from "./errors.js";
import { getRunDetail, listRuns, type WebRunSummary } from "./runs.js";
import type { TaskRunSummary, WebAccessContext } from "./work-items.js";

export interface WorkItemArtifactGroup {
  type: string;
  artifacts: RunArtifact[];
}

export interface WorkItemView extends WorkItemRecord {
  source?: "persisted" | "inferred";
  inferred?: boolean;
  runCount: number;
  latestRunStatus?: WebRunSummary["status"];
  displayStatus?: WebRunSummary["status"] | WorkItemRecord["status"];
  latestRun?: TaskRunSummary;
  currentStage?: string;
  recentLogSummary?: string;
  latestOutputSummary?: string;
  latestChangeRequestUrl?: string;
  specPath?: string;
  techDesignPath?: string;
  artifacts: RunArtifact[];
  artifactsByType: WorkItemArtifactGroup[];
}

export interface WorkItemDetailView extends WorkItemView {
  runs: TaskRunSummary[];
  inputContents: Record<string, string>;
  spec?: string;
  techDesign?: string;
  readOnly?: boolean;
}

function ownedRecordVisibleToUser(
  record: { ownerId?: string; organizationId?: string },
  user?: WebAccessContext,
): boolean {
  if (!user || user.authMode === "local" || user.role === "admin") {
    return true;
  }
  if (record.organizationId) {
    return (user.memberships ?? []).some(
      (membership) => membership.organizationId === record.organizationId,
    );
  }
  return record.ownerId === user.id;
}

function inputSourceUris(workItem: WorkItemRecord): Set<string> {
  return new Set(
    Object.values(workItem.inputs).map((reference) => reference.uri),
  );
}

function runInputSourceUris(run: WebRunSummary): string[] {
  return runInputSourceEntries(run).map((entry) => entry.uri);
}

function runInputSourceEntries(run: WebRunSummary): { id: string; uri: string }[] {
  const uris: { id: string; uri: string }[] = [];
  for (const [id, value] of Object.entries(run.inputs)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const uri = record.sourceUri ?? record.uri;
      if (typeof uri === "string") {
        uris.push({ id, uri });
      }
    }
  }
  return uris;
}

function runMatchesWorkItem(
  run: WebRunSummary,
  workItem: WorkItemRecord,
): boolean {
  if (run.workItemId === workItem.id || run.taskId === workItem.id) {
    return true;
  }
  if (workItem.latestRunId === run.runId) {
    return true;
  }
  const declared = inputSourceUris(workItem);
  return runInputSourceUris(run).some((uri) => declared.has(uri));
}

function currentStage(run: WebRunSummary): string | undefined {
  return run.currentStage ?? run.completedStages.at(-1);
}

function groupArtifactsByType(artifacts: RunArtifact[]): WorkItemArtifactGroup[] {
  const groups = new Map<string, RunArtifact[]>();
  for (const artifact of artifacts) {
    const type = artifact.type ?? "untyped";
    const bucket = groups.get(type);
    if (bucket) {
      bucket.push(artifact);
    } else {
      groups.set(type, [artifact]);
    }
  }
  return [...groups.entries()]
    .map(([type, grouped]) => ({ type, artifacts: grouped }))
    .sort((left, right) => left.type.localeCompare(right.type));
}

async function runsForWorkItem(
  repoPath: string,
  workItem: WorkItemRecord,
  user?: WebAccessContext,
): Promise<WebRunSummary[]> {
  return runsForWorkItemFromList(await listRuns(repoPath), workItem, user);
}

function runsForWorkItemFromList(
  runs: WebRunSummary[],
  workItem: WorkItemRecord,
  user?: WebAccessContext,
): WebRunSummary[] {
  const matched = runs.filter(
    (run) =>
      ownedRecordVisibleToUser(run, user) && runMatchesWorkItem(run, workItem),
  );
  return Array.from(new Map(matched.map((run) => [run.runId, run])).values());
}

async function aggregateArtifacts(
  repoPath: string,
  runs: WebRunSummary[],
): Promise<RunArtifact[]> {
  const seen = new Set<string>();
  const aggregated: RunArtifact[] = [];
  for (const run of runs) {
    let artifacts: RunArtifact[] = [];
    try {
      artifacts = (await getRunDetail(repoPath, run.runId)).artifacts;
    } catch {
      artifacts = [];
    }
    for (const artifact of artifacts) {
      const key = `${run.runId}\0${artifact.producer}\0${artifact.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      aggregated.push(artifact);
    }
  }
  return aggregated;
}

async function buildView(
  repoPath: string,
  workItem: WorkItemRecord,
  user?: WebAccessContext,
  options: { includeArtifacts: boolean } = { includeArtifacts: false },
): Promise<{ view: WorkItemView; runs: WebRunSummary[] }> {
  return await buildViewFromRuns(
    repoPath,
    workItem,
    await runsForWorkItem(repoPath, workItem, user),
    "persisted",
    options,
  );
}

async function buildViewFromRuns(
  repoPath: string,
  workItem: WorkItemRecord,
  runs: WebRunSummary[],
  source: "persisted" | "inferred",
  options: { includeArtifacts: boolean } = { includeArtifacts: false },
): Promise<{ view: WorkItemView; runs: WebRunSummary[] }> {
  const enrichedRuns = runs.map((run) => {
    const enriched = { ...run } as TaskRunSummary;
    const stage = currentStage(enriched);
    if (stage) {
      enriched.currentStage = stage;
    }
    if (enriched.latestOutputSummary) {
      enriched.recentLogSummary = enriched.latestOutputSummary;
    }
    return enriched;
  });
  const artifacts = options.includeArtifacts ? await aggregateArtifacts(repoPath, enrichedRuns) : [];
  const latestRun = enrichedRuns[0] ? ({ ...enrichedRuns[0] } as TaskRunSummary) : undefined;
  const view: WorkItemView = {
    ...workItem,
    source,
    ...(source === "inferred" ? { inferred: true } : {}),
    runCount: enrichedRuns.length,
    artifacts,
    artifactsByType: groupArtifactsByType(artifacts),
  };
  if (latestRun) {
    view.latestRun = latestRun;
    view.latestRunStatus = latestRun.status;
    view.displayStatus = latestRun.status;
    if (latestRun.changeRequestUrl) {
      view.latestChangeRequestUrl = latestRun.changeRequestUrl;
    }
    if (latestRun.latestOutputSummary) {
      latestRun.recentLogSummary = latestRun.latestOutputSummary;
      view.latestOutputSummary = latestRun.latestOutputSummary;
      view.recentLogSummary = latestRun.latestOutputSummary;
    }
    const stage = currentStage(latestRun);
    if (stage) {
      latestRun.currentStage = stage;
      view.currentStage = stage;
    }
  }
  if (workItem.specPath) {
    view.specPath = workItem.specPath;
  } else if (workItem.inputs.spec?.connector === "local-file") {
    view.specPath = workItem.inputs.spec.uri;
  }
  if (workItem.techDesignPath) {
    view.techDesignPath = workItem.techDesignPath;
  } else if (workItem.inputs["tech-design"]?.connector === "local-file") {
    view.techDesignPath = workItem.inputs["tech-design"].uri;
  }
  return { view, runs: enrichedRuns };
}

function workItemStatusFromRun(run: WebRunSummary | undefined): WorkItemRecord["status"] {
  if (!run) return "ready";
  if (run.status === "completed" || run.status === "running" || run.status === "failed") {
    return run.status;
  }
  if (run.status === "blocked") {
    return "failed";
  }
  return "ready";
}

function pathInsideRepo(repoPath: string, candidatePath: string): string | undefined {
  const repo = resolve(repoPath);
  const candidate = resolve(repo, candidatePath);
  const fromRepo = relative(repo, candidate);
  if (fromRepo === "" || fromRepo.startsWith("..") || fromRepo.includes(`..${sep}`)) {
    return undefined;
  }
  return candidate;
}

async function readLocalInputContent(
  repoPath: string,
  reference: ResourceReference,
): Promise<string | undefined> {
  if (reference.connector !== "local-file" || /^https?:\/\//i.test(reference.uri)) {
    return undefined;
  }
  const path = pathInsideRepo(repoPath, reference.uri);
  if (!path) {
    return undefined;
  }
  try {
    const [repoRealPath, fileRealPath] = await Promise.all([
      realpath(resolve(repoPath)),
      realpath(path),
    ]);
    const fromRepo = relative(repoRealPath, fileRealPath);
    if (fromRepo === "" || fromRepo.startsWith("..") || fromRepo.includes(`..${sep}`)) {
      return undefined;
    }
    return await readFile(fileRealPath, "utf8");
  } catch {
    return undefined;
  }
}

async function inputContentsForWorkItem(
  repoPath: string,
  workItem: WorkItemRecord,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    Object.entries(workItem.inputs).map(async ([key, reference]) => [
      key,
      await readLocalInputContent(repoPath, reference),
    ] as const),
  );
  return Object.fromEntries(
    entries.filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  );
}

function prNumberFromRun(run: WebRunSummary): string | undefined {
  if (typeof run.prNumber === "number" && Number.isFinite(run.prNumber)) {
    return String(run.prNumber);
  }
  const url = run.prUrl ?? run.changeRequestUrl;
  return url?.match(/\/pull\/(\d+)(?:\b|$|[/?#])/)?.[1];
}

function issueNumberFromUri(uri: string): string | undefined {
  return (
    uri.match(/(?:^|\/)specs\/issues\/(\d+)[^/]*$/)?.[1] ??
    uri.match(/(?:^|\/)\.nitely\/task-inputs\/(\d+)[^/]*$/)?.[1]
  );
}

function stripKnownExtension(value: string): string {
  return value.replace(/\.(md|markdown|txt|json)$/i, "");
}

function stableIdPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unknown";
}

function basename(value: string): string {
  return value.split("/").filter(Boolean).at(-1) ?? value;
}

function inferredGroupForRun(run: WebRunSummary): { id: string; title: string } {
  const explicitId = run.workItemId ?? run.taskId;
  if (explicitId) {
    return { id: explicitId, title: run.flowName || explicitId };
  }

  const prNumber = prNumberFromRun(run);
  if (prNumber) {
    return { id: `inferred-pr-${prNumber}`, title: `Historical PR #${prNumber}` };
  }

  const inputUris = runInputSourceUris(run);
  for (const uri of inputUris) {
    const issueNumber = issueNumberFromUri(uri);
    if (issueNumber) {
      return {
        id: `inferred-issue-${issueNumber}`,
        title: `Historical issue #${issueNumber}`,
      };
    }
  }

  const reworkInput = inputUris.find((uri) =>
    /(?:^|\/)\.nitely\/rework-inputs\//.test(uri),
  );
  if (reworkInput) {
    const name = stripKnownExtension(basename(reworkInput));
    return {
      id: `inferred-rework-${stableIdPart(name)}`,
      title: `Historical rework: ${name}`,
    };
  }

  const planInput = inputUris.find((uri) => /(?:^|\/)docs\/plans\//.test(uri));
  if (planInput) {
    const name = stripKnownExtension(basename(planInput));
    return {
      id: `inferred-plan-${stableIdPart(name)}`,
      title: `Historical plan: ${name}`,
    };
  }

  return { id: `inferred-run-${run.runId}`, title: `Historical run ${run.runId}` };
}

function runTimestamp(run: WebRunSummary | undefined): string {
  return run?.completedAt ?? run?.startedAt ?? run?.runId ?? new Date(0).toISOString();
}

function flowPathFromRun(run: WebRunSummary | undefined): string {
  if (run?.flowPath) return run.flowPath;
  if (run?.flowName) return `flows/${run.flowName}.json`;
  return "flows/implement-spec-bootstrap.json";
}

function inputReferencesFromRuns(runs: WebRunSummary[]): WorkItemRecord["inputs"] {
  const inputs: WorkItemRecord["inputs"] = {};
  for (const run of runs) {
    for (const entry of runInputSourceEntries(run)) {
      const inputId = inputs[entry.id] ? `${entry.id}-${stableIdPart(run.runId)}` : entry.id;
      inputs[inputId] = { connector: "local-file", uri: entry.uri };
    }
  }
  return inputs;
}

function inferredWorkItemFromRuns(group: {
  id: string;
  title: string;
  runs: WebRunSummary[];
}): WorkItemRecord {
  const latest = group.runs[0];
  const oldest = group.runs.at(-1);
  return {
    id: group.id,
    title: group.title,
    status: workItemStatusFromRun(latest),
    workItemType: latest?.workItemType ?? (latest?.taskId ? DEV_PR_WORK_ITEM_TYPE : "dev.pr"),
    flowPath: flowPathFromRun(latest),
    inputs: inputReferencesFromRuns(group.runs),
    latestRunId: latest?.runId,
    changeRequestUrl: latest?.changeRequestUrl ?? latest?.prUrl,
    ...(latest?.ownerId ? { ownerId: latest.ownerId } : {}),
    ...(latest?.organizationId ? { organizationId: latest.organizationId } : {}),
    createdAt: runTimestamp(oldest),
    updatedAt: runTimestamp(latest),
  };
}

function inferredWorkItemGroups(
  persistedItems: WorkItemRecord[],
  runs: WebRunSummary[],
  user?: WebAccessContext,
): { item: WorkItemRecord; runs: WebRunSummary[] }[] {
  const matchedRunIds = new Set<string>();
  for (const item of persistedItems) {
    for (const run of runsForWorkItemFromList(runs, item, user)) {
      matchedRunIds.add(run.runId);
    }
  }

  const groups = new Map<string, { id: string; title: string; runs: WebRunSummary[] }>();
  const knownIds = new Set(persistedItems.map((item) => item.id));
  for (const run of runs) {
    if (!ownedRecordVisibleToUser(run, user) || matchedRunIds.has(run.runId)) {
      continue;
    }
    const key = inferredGroupForRun(run);
    if (knownIds.has(key.id)) {
      continue;
    }
    const group = groups.get(key.id) ?? { ...key, runs: [] };
    group.runs.push(run);
    groups.set(key.id, group);
  }

  return [...groups.values()].map((group) => ({
    item: inferredWorkItemFromRuns(group),
    runs: group.runs,
  }));
}

export async function listWorkItemViews(
  repoPath: string,
  user?: WebAccessContext,
  workItemsSnapshot?: readonly WorkItemRecord[],
): Promise<WorkItemView[]> {
  const items = workItemsSnapshot ?? (await listUnifiedWorkItems(repoPath));
  const runs = (await listRuns(repoPath)).filter((run) =>
    ownedRecordVisibleToUser(run, user),
  );
  const visible = items.filter((item) => ownedRecordVisibleToUser(item, user));
  const persistedViews = await Promise.all(
    visible.map(async (item) =>
      (
        await buildViewFromRuns(
          repoPath,
          item,
          runsForWorkItemFromList(runs, item, user),
          "persisted",
        )
      ).view,
    ),
  );
  const inferredViews = await Promise.all(
    inferredWorkItemGroups(visible, runs, user).map(async (group) =>
      (await buildViewFromRuns(repoPath, group.item, group.runs, "inferred")).view,
    ),
  );
  return [...persistedViews, ...inferredViews].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

export async function getWorkItemView(
  repoPath: string,
  id: string,
  user?: WebAccessContext,
  workItemsSnapshot?: readonly WorkItemRecord[],
): Promise<WorkItemDetailView> {
  let persistedItems = workItemsSnapshot;
  let workItem = persistedItems?.find((item) => item.id === id);
  if (!persistedItems) {
    try {
      workItem = await getUnifiedWorkItem(repoPath, id);
      persistedItems = [workItem];
    } catch (error) {
      if (!(error instanceof WebNotFoundError)) {
        throw error;
      }
      persistedItems = await listUnifiedWorkItems(repoPath);
      workItem = persistedItems.find((item) => item.id === id);
    }
  }
  const readOnly = workItem === undefined;
  const inferredGroup = readOnly
    ? inferredWorkItemGroups(
        persistedItems.filter((item) => ownedRecordVisibleToUser(item, user)),
        (await listRuns(repoPath)).filter((run) =>
          ownedRecordVisibleToUser(run, user),
        ),
        user,
      ).find((group) => group.item.id === id)
    : undefined;
  if (!workItem) {
    workItem = inferredGroup?.item;
  }
  if (!workItem) {
    throw new WebNotFoundError("task not found");
  }
  const { view, runs } = inferredGroup
    ? await buildViewFromRuns(repoPath, inferredGroup.item, inferredGroup.runs, "inferred", {
        includeArtifacts: true,
      })
    : await buildView(repoPath, workItem, user, { includeArtifacts: true });
  const inputContents = await inputContentsForWorkItem(repoPath, workItem);
  return {
    ...view,
    runs: runs as TaskRunSummary[],
    inputContents,
    ...(inputContents.spec !== undefined ? { spec: inputContents.spec } : {}),
    ...(inputContents["tech-design"] !== undefined
      ? { techDesign: inputContents["tech-design"] }
      : {}),
    ...(readOnly ? { readOnly } : {}),
  };
}
