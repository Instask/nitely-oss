import type { TaskDetail, TaskRecord } from "./tasks.js";
import { getTaskDetail, listTasks } from "./tasks.js";
import { getRunDetail, listRuns, type WebRunSummary } from "./runs.js";
import type { PublicOrganizationMembership } from "./organizations.js";

export interface TaskRunSummary extends WebRunSummary {
  currentStage?: string;
  recentLogSummary?: string;
}

export interface TaskWorkItem extends TaskRecord {
  latestRun?: TaskRunSummary;
  runCount: number;
  currentStage?: string;
  recentLogSummary?: string;
  latestChangeRequestUrl?: string;
}

export interface TaskWorkItemDetail extends TaskDetail {
  runs: TaskRunSummary[];
}

export interface WebAccessContext {
  id: string;
  role: "admin" | "user";
  authMode: "local" | "required";
  memberships?: PublicOrganizationMembership[];
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

function inputSourceUri(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  return typeof record.sourceUri === "string" ? record.sourceUri : undefined;
}

function runMatchesTask(run: WebRunSummary, task: TaskRecord): boolean {
  if (run.workItemId === task.id) {
    return true;
  }
  if (task.latestRunId === run.runId) {
    return true;
  }
  return (
    inputSourceUri(run.inputs.spec) === task.specPath ||
    inputSourceUri(run.inputs["tech-design"]) === task.techDesignPath
  );
}

function currentStage(run: WebRunSummary): string | undefined {
  if (run.completedStages.length === 0) {
    return undefined;
  }
  return run.completedStages[run.completedStages.length - 1];
}

function compactLogLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 160);
}

async function recentLogSummary(
  repoPath: string,
  runId: string,
): Promise<string | undefined> {
  try {
    const detail = await getRunDetail(repoPath, runId);
    for (const log of [...detail.logs].reverse()) {
      const lines = [log.stderr, log.stdout]
        .filter((value): value is string => typeof value === "string")
        .flatMap((value) => value.split(/\r?\n/))
        .map(compactLogLine)
        .filter(Boolean);
      const line = lines.at(-1);
      if (line) {
        return line;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function enrichRun(
  repoPath: string,
  run: WebRunSummary,
): Promise<TaskRunSummary> {
  const stage = currentStage(run);
  const summary = await recentLogSummary(repoPath, run.runId);
  return {
    ...run,
    ...(stage ? { currentStage: stage } : {}),
    ...(summary ? { recentLogSummary: summary } : {}),
  };
}

export async function listRunsForTask(
  repoPath: string,
  task: TaskRecord,
  user?: WebAccessContext,
): Promise<TaskRunSummary[]> {
  const runs = await listRuns(repoPath);
  const associated = runs.filter(
    (run) => ownedRecordVisibleToUser(run, user) && runMatchesTask(run, task),
  );
  const deduped = Array.from(
    new Map(associated.map((run) => [run.runId, run])).values(),
  );
  return await Promise.all(deduped.map((run) => enrichRun(repoPath, run)));
}

export async function listTaskWorkItems(
  repoPath: string,
  user?: WebAccessContext,
): Promise<TaskWorkItem[]> {
  const tasks = await listTasks(repoPath);
  return await Promise.all(
    tasks.filter((task) => ownedRecordVisibleToUser(task, user)).map(async (task) => {
      const runs = await listRunsForTask(repoPath, task, user);
      const latestRun = runs[0];
      return {
        ...task,
        ...(latestRun ? { latestRun } : {}),
        runCount: runs.length,
        ...(latestRun?.currentStage ? { currentStage: latestRun.currentStage } : {}),
        ...(latestRun?.recentLogSummary
          ? { recentLogSummary: latestRun.recentLogSummary }
          : {}),
        ...(latestRun?.changeRequestUrl
          ? { latestChangeRequestUrl: latestRun.changeRequestUrl }
          : {}),
      };
    }),
  );
}

export async function getTaskWorkItemDetail(
  repoPath: string,
  taskId: string,
  user?: WebAccessContext,
): Promise<TaskWorkItemDetail> {
  const detail = await getTaskDetail(repoPath, taskId);
  return {
    ...detail,
    runs: await listRunsForTask(repoPath, detail.task, user),
  };
}
