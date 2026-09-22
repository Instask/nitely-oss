import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import { getFlowTemplate } from "../../src/flows/templates.js";
import type { ProviderConnectionStore } from "../../src/providers/types.js";
import { RunAdmissionStore } from "../../src/run/admission-store.js";
import { eventStorePath, projectRun } from "../../src/run/project.js";
import { runSchedulerOnce } from "../../src/scheduler/run.js";
import {
  ResumeClaimStore,
  resumeClaimStorePath,
} from "../../src/scheduler/resume-claim.js";
import { generateDraftSpec } from "../../src/spec-artifacts/draft.js";
import {
  createTask,
  getTask,
  updateTaskRunState,
} from "../../src/web/tasks.js";
import { createWorkItem, getWorkItem } from "../../src/work-items/store.js";
import type { ChangeRequestStatusFetcher } from "../../src/scheduler/completion.js";
import type {
  RunFlowDependencies,
  RunFlowInput,
  RunFlowResult,
} from "../../src/run/run-flow.js";

async function createRepo() {
  const repo = await mkdtemp(join(tmpdir(), "nitely-scheduler-run-"));
  await mkdir(join(repo, "flows"), { recursive: true });
  await writeFile(
    join(repo, "flows/implement-spec-bootstrap.json"),
    JSON.stringify(
      {
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "implement-spec-bootstrap" },
        spec: {
          stages: [
            {
              id: "implement",
              type: "agent",
              runtime: "mock",
              prompt: "Implement.",
              inputs: ["spec", "tech-design"],
              outputs: ["implementation"],
            },
          ],
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return repo;
}

async function writeValidFlow(
  repoPath: string,
  flowPath = "flows/generic.json",
  runtime = "mock",
) {
  await writeFile(
    join(repoPath, flowPath),
    JSON.stringify(
      {
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: {
          name: "generic",
          workItemType: "dev.pr",
          inputs: [{ id: "intake" }],
        },
        spec: {
          stages: [
            {
              id: "implement",
              type: "agent",
              runtime,
              prompt: "Implement from intake.",
              inputs: ["intake"],
              outputs: ["implementation"],
            },
          ],
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function result(id: string): RunFlowResult {
  return {
    runId: `run-${id}`,
    branchName: `nitely/run-${id}`,
    worktreePath: `/tmp/run-${id}`,
    changeRequestUrl: `https://github.com/Instask/nitely/pull/${id}`,
  };
}

function admittedResult(
  id: string,
  dependencies: RunFlowDependencies | undefined,
): RunFlowResult {
  const runId = dependencies?.createRunId?.() ?? `run-${id}`;
  return {
    ...result(id),
    runId,
    branchName: `nitely/${runId}`,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function refinedSpec(title = "Approved source") {
  return `# Feature Spec: ${title}

Status: approved
Source: github-issue https://github.com/Instask/nitely/issues/228

## Background

Operators need approved planning artifacts before scheduled implementation.

## User Stories

- **US-001:** As an operator, I can schedule implementation after approving a concrete spec and technical design.

## Acceptance Scenarios

- **US-001 / SC-001:** Given approved planning artifacts, when the scheduler runs, then it starts the task and passes planning metadata to the runner.

## Functional Requirements

- **FR-001:** Nitely must persist approved spec and technical design artifacts before scheduler execution.
- **FR-002:** Nitely must pass approved planning metadata to the runner input.

## Success Criteria

- **SC-001:** The scheduler starts the task only after the task is ready.
- **SC-002:** The runner input includes planning approval metadata for the approved artifacts.

## Edge Cases And Failure Behavior

- Source drift must block automatic scheduler execution.

## Assumptions

- The GitHub issue source has not changed since planning.

## Out Of Scope

- Automatically approving planning artifacts.

## Open Questions

- None.
`;
}

function writeUsageLimitBlockedRun(repoPath: string, input: {
  runId: string;
  taskId: string;
  retryAfter: string;
  runtime?: string;
}) {
  const store = new EventStore(eventStorePath(repoPath));
  const blocker = {
    reason: "agent_usage_limit",
    stageId: "implement",
    runtime: input.runtime ?? "codex",
    message: "You've hit your usage limit.",
    retryAfter: input.retryAfter,
  };
  store.append({
    runId: input.runId,
    type: "run.created",
    payload: {
      flowName: "generic",
      flowPath: "flows/implement-spec-bootstrap.json",
      workItemId: input.taskId,
    },
  });
  store.append({
    runId: input.runId,
    stageId: "implement",
    attempt: 1,
    type: "stage.started",
    payload: { type: "agent", runtime: input.runtime ?? "codex" },
  });
  store.append({
    runId: input.runId,
    stageId: "implement",
    attempt: 1,
    type: "stage.blocked",
    payload: blocker,
  });
  store.append({
    runId: input.runId,
    type: "run.blocked",
    payload: blocker,
  });
}

describe("scheduler runner", () => {
  it("runs independent Work items concurrently up to an explicit limit", async () => {
    const repoPath = await createRepo();
    for (const [index, id] of ["a", "b", "c", "d"].entries()) {
      await createTask(
        repoPath,
        { title: id.toUpperCase(), spec: "spec", techDesign: "td" },
        {
          createId: () => id,
          now: () => new Date(`2026-06-26T00:0${index}:00.000Z`),
        },
      );
    }

    let inFlight = 0;
    let maximumInFlight = 0;
    let firstPairStarted!: () => void;
    const firstPair = new Promise<void>((resolve) => {
      firstPairStarted = resolve;
    });
    let releaseRuns!: () => void;
    const runsReleased = new Promise<void>((resolve) => {
      releaseRuns = resolve;
    });

    const cycle = runSchedulerOnce({
      repoPath,
      maxConcurrentTasks: 2,
      runFlow: async (input, dependencies) => {
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        if (inFlight === 2) firstPairStarted();
        await runsReleased;
        inFlight -= 1;
        return admittedResult(input.workItemId ?? "missing", dependencies);
      },
    });

    const overlapped = await Promise.race([
      firstPair.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 10_000)),
    ]);
    releaseRuns();
    const summary = await cycle;

    expect(overlapped).toBe(true);
    expect(maximumInFlight).toBe(2);
    expect(summary.startedTaskIds).toEqual(["a", "b", "c", "d"]);
    expect(summary.completedTaskIds).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps summary order deterministic when Runs complete in exact reverse order", async () => {
    const repoPath = await createRepo();
    const taskIds = ["a", "b", "c", "d"] as const;
    for (const [index, id] of taskIds.entries()) {
      await createTask(
        repoPath,
        { title: id.toUpperCase(), spec: "spec", techDesign: "td" },
        {
          createId: () => id,
          now: () => new Date(`2026-06-26T00:0${index}:00.000Z`),
        },
      );
    }

    const release = Object.fromEntries(
      taskIds.map((id) => [id, deferred()]),
    ) as Record<(typeof taskIds)[number], ReturnType<typeof deferred>>;
    const completed = Object.fromEntries(
      taskIds.map((id) => [id, deferred()]),
    ) as Record<(typeof taskIds)[number], ReturnType<typeof deferred>>;
    const completionOrder: string[] = [];
    const allStarted = deferred();
    const started = new Set<string>();

    const cycle = runSchedulerOnce({
      repoPath,
      maxConcurrentTasks: 4,
      runFlow: async (input, dependencies) => {
        const id = input.workItemId as (typeof taskIds)[number];
        started.add(id);
        if (started.size === taskIds.length) allStarted.resolve();
        await release[id].promise;
        completionOrder.push(id);
        completed[id].resolve();
        return admittedResult(id, dependencies);
      },
    });

    await expect(
      Promise.race([
        allStarted.promise.then(() => true),
        new Promise<false>((resolve) =>
          setTimeout(() => resolve(false), 10_000),
        ),
      ]),
    ).resolves.toBe(true);
    for (const id of ["d", "c", "b", "a"] as const) {
      release[id].resolve();
      await completed[id].promise;
    }

    const summary = await cycle;
    expect(completionOrder).toEqual(["d", "c", "b", "a"]);
    expect(summary.startedTaskIds).toEqual(["a", "b", "c", "d"]);
    expect(summary.completedTaskIds).toEqual(["a", "b", "c", "d"]);
  });

  it("rejects invalid concurrency before admitting a Run", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "A", spec: "spec", techDesign: "td" },
      { createId: () => "a" },
    );
    const originalTask = await getTask(repoPath, "a");
    let runnerCalls = 0;

    for (const maxConcurrentTasks of [0, -1, 1.5, 65]) {
      await expect(
        runSchedulerOnce({
          repoPath,
          maxConcurrentTasks,
          runFlow: async (input, dependencies) => {
            runnerCalls += 1;
            return admittedResult(input.workItemId ?? "missing", dependencies);
          },
        }),
      ).rejects.toThrow(/maxConcurrentTasks/);
    }
    expect(runnerCalls).toBe(0);
    await expect(getTask(repoPath, "a")).resolves.toEqual(originalTask);
    await expect(
      access(join(repoPath, ".nitely", "run-admissions.db")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(eventStorePath(repoPath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps existing scheduler cycles serial by default", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "A", spec: "spec", techDesign: "td" },
      { createId: () => "a" },
    );
    await createTask(
      repoPath,
      { title: "B", spec: "spec", techDesign: "td" },
      { createId: () => "b" },
    );
    let inFlight = 0;
    let maximumInFlight = 0;

    await runSchedulerOnce({
      repoPath,
      runFlow: async (input, dependencies) => {
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return admittedResult(input.workItemId ?? "missing", dependencies);
      },
    });

    expect(maximumInFlight).toBe(1);
  });

  it("runs only currently unblocked tasks and reloads graph state between runs", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "A", spec: "spec", techDesign: "td" },
      { createId: () => "a", now: () => new Date("2026-06-26T00:00:00.000Z") },
    );
    await createTask(
      repoPath,
      { title: "B", spec: "spec", techDesign: "td" },
      { createId: () => "b", now: () => new Date("2026-06-26T00:01:00.000Z") },
    );
    await updateTaskRunState(repoPath, "b", { status: "ready" });

    const b = await import("../../src/web/tasks.js").then((module) =>
      module.getTask(repoPath, "b"),
    );
    await writeFile(
      join(repoPath, ".nitely/tasks/b/task.json"),
      JSON.stringify({ ...b, dependsOn: ["a"] }, null, 2),
      "utf8",
    );

    const calls: RunFlowInput[] = [];
    const mergedPulls = new Set<string>();
    const getStatus: ChangeRequestStatusFetcher = async (url) => ({
      provider: "github",
      state: "closed",
      merged: mergedPulls.has(url),
    });

    const summary = await runSchedulerOnce({
      repoPath,
      maxConcurrentTasks: 2,
      getChangeRequestStatus: getStatus,
      runFlow: async (input, dependencies) => {
        calls.push(input);
        const id = input.workItemId ?? "missing";
        const runResult = admittedResult(id, dependencies);
        if (id === "a") {
          mergedPulls.add(runResult.changeRequestUrl ?? "");
        }
        return runResult;
      },
    });

    expect(calls.map((call) => call.workItemId)).toEqual(["a", "b"]);
    expect(summary.startedTaskIds).toEqual(["a", "b"]);
  });

  it("materializes approved legacy task execution metadata for scheduler starts", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      {
        title: "Approved task",
        spec: refinedSpec(),
        techDesign: "td",
        issueUrl: "https://github.com/Instask/nitely/issues/228",
      },
      {
        createId: () => "approved-task",
        source: {
          type: "github-issue",
          uri: "https://github.com/Instask/nitely/issues/228",
          title: "Issue 228",
          snapshot: {
            uri: "https://github.com/Instask/nitely/issues/228",
            title: "Issue 228",
            body: "Approved source",
            fetchedAt: "2026-06-28T00:00:00.000Z",
          },
        },
      },
    );

    const providerStore: ProviderConnectionStore = {
      getConnection: async (providerId) => ({
        providerId,
        getAccessToken: async () => "test-token",
      }),
      resolveEnv: async () => ({}),
      listStatuses: async () => [],
    };
    const calls: RunFlowInput[] = [];
    const summary = await runSchedulerOnce({
      repoPath,
      providerStore,
      getChangeRequestStatus: async () => ({
        provider: "github",
        state: "closed",
        merged: true,
      }),
      runFlow: async (input, dependencies) => {
        calls.push(input);
        return admittedResult(input.workItemId ?? "missing", dependencies);
      },
    });

    expect(summary.startedTaskIds).toEqual(["approved-task"]);
    expect(summary.specReadiness?.["approved-task"]?.status).toBe("PASS");
    expect(calls[0]).toMatchObject({
      workItemId: "approved-task",
      inputs: {
        source: {
          connector: "local-file",
          uri: expect.stringMatching(
            /^\.nitely\/tasks\/approved-task\/execution\/candidates\/[a-f0-9]{64}\/source\.json$/,
          ),
        },
        "workflow-metadata": {
          connector: "local-file",
          uri: expect.stringMatching(
            /^\.nitely\/tasks\/approved-task\/execution\/candidates\/[a-f0-9]{64}\/workflow-metadata\.json$/,
          ),
        },
      },
      planningApproval: {
        artifacts: {
          spec: { versionId: "spec-r1" },
          techDesign: { versionId: "tech-design-r1" },
        },
      },
    });
    const candidateSourceUri = calls[0]?.inputs.source?.uri;
    const candidateWorkflowMetadataUri = calls[0]?.inputs["workflow-metadata"]?.uri;
    expect(candidateSourceUri).toBeTypeOf("string");
    expect(candidateWorkflowMetadataUri).toBeTypeOf("string");
    await expect(
      readFile(join(repoPath, candidateSourceUri!), "utf8"),
    ).resolves.toContain("Approved source");
    await expect(
      readFile(join(repoPath, candidateWorkflowMetadataUri!), "utf8").then(
        (document) => JSON.parse(document),
      ),
    ).resolves.toMatchObject({
      status: "running",
      planningBaseline: {
        specVersionId: "spec-r1",
        techDesignVersionId: "tech-design-r1",
      },
    });
    await expect(
      readFile(
        join(repoPath, ".nitely/tasks/approved-task/execution/source.json"),
        "utf8",
      ),
    ).resolves.toContain("Approved source");
    await expect(
      readFile(
        join(repoPath, ".nitely/tasks/approved-task/execution/workflow-metadata.json"),
        "utf8",
      ).then((document) => JSON.parse(document)),
    ).resolves.toMatchObject({
      status: "running",
      planningArtifacts: {
        spec: { approvedVersionId: "spec-r1" },
        techDesign: { approvedVersionId: "tech-design-r1" },
      },
      planningBaseline: {
        specVersionId: "spec-r1",
        techDesignVersionId: "tech-design-r1",
      },
    });
    await expect(getTask(repoPath, "approved-task")).resolves.toMatchObject({
      planningArtifacts: {
        spec: { approvedVersionId: "spec-r1" },
      },
      activePlanningBaseline: {
        specVersionId: "spec-r1",
        techDesignVersionId: "tech-design-r1",
      },
    });
  });

  it("does not auto-start scheduler tasks when their source has drifted", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "Stale task", spec: "spec", techDesign: "td" },
      {
        createId: () => "stale-task",
        source: {
          type: "github-issue",
          uri: "https://github.com/Instask/nitely/issues/228",
          title: "Issue 228",
          snapshot: {
            uri: "https://github.com/Instask/nitely/issues/228",
            title: "Issue 228",
            body: "Old source",
            fetchedAt: "2026-06-28T00:00:00.000Z",
          },
          drift: {
            status: "changed",
            checkedAt: "2026-06-28T01:00:00.000Z",
            changedFields: ["body"],
          },
        },
      },
    );

    const calls: RunFlowInput[] = [];
    const summary = await runSchedulerOnce({
      repoPath,
      maxConcurrentTasks: 2,
      getChangeRequestStatus: async () => ({
        provider: "github",
        state: "closed",
        merged: true,
      }),
      runFlow: async (input) => {
        calls.push(input);
        return result(input.workItemId ?? "missing");
      },
    });

    expect(calls).toEqual([]);
    expect(summary.startedTaskIds).toEqual([]);
    expect(summary.blockedTaskIds).toEqual(["stale-task"]);
  });

  it("does not auto-start scheduler tasks when preflight blocks execution", async () => {
    const repoPath = await createRepo();
    await writeFile(
      join(repoPath, "flows/preflight-block.json"),
      JSON.stringify(
        {
          apiVersion: "nitely.dev/v1alpha1",
          kind: "Flow",
          metadata: { name: "preflight-block", inputs: [{ id: "intake" }] },
          spec: {
            stages: [
              {
                id: "implement",
                type: "agent",
                runtime: "mock",
                prompt: "Implement.",
                inputs: ["intake"],
                outputs: ["implementation"],
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await createWorkItem(
      repoPath,
      {
        title: "Missing intake",
        workItemType: "dev.pr",
        flowPath: "flows/preflight-block.json",
        inputs: {},
      },
      { createId: () => "missing-intake" },
    );

    const calls: RunFlowInput[] = [];
    const summary = await runSchedulerOnce({
      repoPath,
      getChangeRequestStatus: async () => ({
        provider: "github",
        state: "closed",
        merged: true,
      }),
      runFlow: async (input) => {
        calls.push(input);
        return result(input.workItemId ?? "missing");
      },
    });

    expect(calls).toEqual([]);
    expect(summary.startedTaskIds).toEqual([]);
    expect(summary.blockedTaskIds).toEqual(["missing-intake"]);
    expect(summary.preflight?.["missing-intake"]).toMatchObject({
      status: "BLOCK",
      issues: [
        expect.objectContaining({
          code: "missing-input",
          inputId: "intake",
        }),
      ],
    });
    expect(summary.eligibility?.["missing-intake"]).toMatchObject({
      workItemId: "missing-intake",
      decision: "blocked",
      blockers: [
        expect.objectContaining({
          code: "preflight.missing-input",
          kind: "preflight",
          overridePolicy: "never",
        }),
      ],
    });
  });

  it("does not auto-start scheduler tasks when spec readiness blocks execution", async () => {
    const repoPath = await createRepo();
    const draft = generateDraftSpec({
      type: "github-issue",
      uri: "https://github.com/Instask/nitely/issues/228",
      title: "Scheduler readiness",
      body: "Block generic generated specs before automatic implementation.",
    });
    await createTask(
      repoPath,
      {
        title: "Unready spec task",
        spec: draft.markdown,
        techDesign: "td",
        issueUrl: "https://github.com/Instask/nitely/issues/228",
      },
      {
        createId: () => "unready-spec",
        source: {
          type: "github-issue",
          uri: "https://github.com/Instask/nitely/issues/228",
          title: "Scheduler readiness",
          snapshot: {
            uri: "https://github.com/Instask/nitely/issues/228",
            title: "Scheduler readiness",
            body: "Block generic generated specs before automatic implementation.",
            fetchedAt: "2026-06-28T00:00:00.000Z",
          },
        },
      },
    );

    const calls: RunFlowInput[] = [];
    const summary = await runSchedulerOnce({
      repoPath,
      getChangeRequestStatus: async () => ({
        provider: "github",
        state: "closed",
        merged: true,
      }),
      runFlow: async (input) => {
        calls.push(input);
        return result(input.workItemId ?? "missing");
      },
    });

    expect(calls).toEqual([]);
    expect(summary.startedTaskIds).toEqual([]);
    expect(summary.blockedTaskIds).toEqual(["unready-spec"]);
    expect(summary.specReadiness?.["unready-spec"]?.status).toBe("BLOCK");
    expect(summary.specReadiness?.["unready-spec"]?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "blocking",
          code: "generic-functional-requirement",
        }),
      ]),
    );
  });

  it("marks a failed task and continues independent branches", async () => {
    const repoPath = await createRepo();
    await createTask(repoPath, { title: "A", spec: "spec", techDesign: "td" }, { createId: () => "a" });
    await createTask(repoPath, { title: "B", spec: "spec", techDesign: "td" }, { createId: () => "b" });

    const summary = await runSchedulerOnce({
      repoPath,
      maxConcurrentTasks: 2,
      getChangeRequestStatus: async () => ({
        provider: "github",
        state: "closed",
        merged: true,
      }),
      runFlow: async (input, dependencies) => {
        if (input.workItemId === "a") {
          throw new Error("boom");
        }
        return admittedResult(input.workItemId ?? "b", dependencies);
      },
    });

    expect(summary.startedTaskIds).toEqual(["a", "b"]);
    expect(summary.completedTaskIds).toEqual(["b"]);
    expect(summary.failedTaskIds).toEqual(["a"]);
    const completedTask = await getTask(repoPath, "b");
    expect(completedTask).toMatchObject({
      status: "completed",
      latestRunId: expect.any(String),
    });
    const admissions = new RunAdmissionStore(
      join(repoPath, ".nitely", "run-admissions.db"),
    );
    try {
      expect(admissions.get(completedTask.latestRunId!)).toMatchObject({
        state: "settled",
        settlementStatus: "completed",
      });
    } finally {
      admissions.close();
    }
  });

  it("attributes a task-local scheduler exception and continues later runnable work", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "A", spec: "spec", techDesign: "td" },
      { createId: () => "a", now: () => new Date("2026-06-26T00:00:00.000Z") },
    );
    await createTask(
      repoPath,
      { title: "B", spec: "spec", techDesign: "td" },
      { createId: () => "b", now: () => new Date("2026-06-26T00:01:00.000Z") },
    );
    let runIdCalls = 0;
    const runnerCalls: string[] = [];

    const summary = await runSchedulerOnce({
      repoPath,
      maxConcurrentTasks: 1,
      createRunId: () => {
        runIdCalls += 1;
        if (runIdCalls === 1) {
          throw new Error("run id allocator unavailable: secret diagnostic");
        }
        return `run-${runIdCalls}`;
      },
      runFlow: async (input, dependencies) => {
        const id = input.workItemId ?? "missing";
        runnerCalls.push(id);
        return admittedResult(id, dependencies);
      },
    });

    expect(runnerCalls).toEqual(["b"]);
    expect(summary.startedTaskIds).toEqual(["b"]);
    expect(summary.completedTaskIds).toEqual(["b"]);
    expect(summary.taskErrors).toEqual({
      a: {
        code: "scheduler_task_processing_failed",
        message: "Scheduler could not process this Work item",
      },
    });
    expect(JSON.stringify(summary.taskErrors)).not.toContain("secret diagnostic");
    const erroredTask = await getTask(repoPath, "a");
    expect(erroredTask.status).toBe("ready");
    expect(erroredTask).not.toHaveProperty("latestRunId");
    await expect(getTask(repoPath, "b")).resolves.toMatchObject({
      status: "completed",
      latestRunId: "run-2",
    });
  });

  it("runs generic flow work items from the same scheduler queue", async () => {
    const repoPath = await createRepo();
    await writeValidFlow(repoPath);
    await writeFile(join(repoPath, "intake.md"), "Issue intake", "utf8");
    await createWorkItem(
      repoPath,
      {
        title: "Generic workflow",
        workItemType: "dev.pr",
        flowPath: "flows/generic.json",
        inputs: {
          intake: { connector: "local-file", uri: "intake.md" },
        },
      },
      { createId: () => "wi-generic" },
    );

    const calls: RunFlowInput[] = [];
    const summary = await runSchedulerOnce({
      repoPath,
      getChangeRequestStatus: async () => ({
        provider: "github",
        state: "closed",
        merged: true,
      }),
      runFlow: async (input, dependencies) => {
        calls.push(input);
        return admittedResult(input.workItemId ?? "missing", dependencies);
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      workItemId: "wi-generic",
      flowPath: join(repoPath, "flows/generic.json"),
      inputs: { intake: { connector: "local-file", uri: "intake.md" } },
    });
    expect(summary.startedTaskIds).toEqual(["wi-generic"]);
    expect(summary.completedTaskIds).toEqual(["wi-generic"]);
    expect(summary.specReadiness?.["wi-generic"]).toMatchObject({
      status: "WARN",
      issues: [
        expect.objectContaining({
          code: "missing-spec-artifact",
        }),
      ],
    });
  });

  it("does not admit an evaluated Work item after its persisted candidate changes", async () => {
    const repoPath = await createRepo();
    await writeValidFlow(repoPath);
    await writeFile(join(repoPath, "intake-a.md"), "Issue intake A", "utf8");
    await writeFile(join(repoPath, "intake-b.md"), "Issue intake B", "utf8");
    await createWorkItem(
      repoPath,
      {
        title: "Stable evaluated snapshot",
        workItemType: "dev.pr",
        flowPath: "flows/generic.json",
        inputs: {
          intake: { connector: "local-file", uri: "intake-a.md" },
        },
        configuration: { revision: "A" },
      },
      { createId: () => "wi-snapshot" },
    );

    let mutated = false;
    const providerStore: ProviderConnectionStore = {
      getConnection: async (providerId) => ({
        providerId,
        getAccessToken: async () => "test-token",
      }),
      resolveEnv: async () => ({}),
      listStatuses: async () => {
        if (!mutated) {
          mutated = true;
          const path = join(
            repoPath,
            ".nitely/work-items/wi-snapshot/work-item.json",
          );
          const persisted = JSON.parse(await readFile(path, "utf8"));
          await writeFile(
            path,
            JSON.stringify(
              {
                ...persisted,
                inputs: {
                  intake: { connector: "local-file", uri: "intake-b.md" },
                },
                configuration: { revision: "B" },
              },
              null,
              2,
            ),
            "utf8",
          );
        }
        return [];
      },
    };
    const calls: RunFlowInput[] = [];

    await runSchedulerOnce({
      repoPath,
      providerStore,
      getChangeRequestStatus: async () => ({
        provider: "github",
        state: "closed",
        merged: true,
      }),
      runFlow: async (input, dependencies) => {
        calls.push(input);
        return admittedResult(input.workItemId ?? "missing", dependencies);
      },
    });

    expect(calls).toEqual([]);
    await expect(getWorkItem(repoPath, "wi-snapshot")).resolves.toMatchObject({
      status: "ready",
      inputs: {
        intake: { connector: "local-file", uri: "intake-b.md" },
      },
      configuration: { revision: "B" },
    });
  });

  it("runs template-backed work items with the evaluated Flow snapshot", async () => {
    const repoPath = await createRepo();
    await writeFile(join(repoPath, "research.md"), "Research Nitely.", "utf8");
    const template = getFlowTemplate("research-pipeline")!;
    await createWorkItem(
      repoPath,
      {
        title: "Template research",
        workItemType: "dev.pr",
        flowPath: "template:research-pipeline",
        template: {
          templateId: template.id,
          templateVersion: template.version,
          source: "builtin",
        },
        inputs: {
          "research-task": { connector: "local-file", uri: "research.md" },
        },
      },
      { createId: () => "wi-template" },
    );
    const providerStore: ProviderConnectionStore = {
      getConnection: async (providerId) => ({
        providerId,
        getAccessToken: async () => "test-token",
      }),
      resolveEnv: async () => ({}),
      listStatuses: async () => [
        {
          id: "codex",
          name: "Codex",
          configured: true,
          message: "configured",
          hints: [],
          reconnectRequired: false,
          authMethods: [],
        },
      ],
    };
    const calls: RunFlowInput[] = [];

    const summary = await runSchedulerOnce({
      repoPath,
      providerStore,
      runFlow: async (input, dependencies) => {
        calls.push(input);
        return admittedResult(input.workItemId ?? "missing", dependencies);
      },
    });

    expect(calls).toEqual([
      expect.objectContaining({
        workItemId: "wi-template",
        flowPath: "template:research-pipeline",
        flowDocument: template.document,
      }),
    ]);
    expect(summary.completedTaskIds).toEqual(["wi-template"]);
    await expect(getWorkItem(repoPath, "wi-template")).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("keeps generic flow work items running when they pause for approval", async () => {
    const repoPath = await createRepo();
    await writeValidFlow(repoPath);
    await writeFile(join(repoPath, "intake.md"), "Issue intake", "utf8");
    await createWorkItem(
      repoPath,
      {
        title: "Approval workflow",
        workItemType: "dev.pr",
        flowPath: "flows/generic.json",
        inputs: {
          intake: { connector: "local-file", uri: "intake.md" },
        },
      },
      { createId: () => "wi-approval" },
    );

    const summary = await runSchedulerOnce({
      repoPath,
      getChangeRequestStatus: async () => ({
        provider: "github",
        state: "closed",
        merged: true,
      }),
      runFlow: async (_input, dependencies) => {
        const runId = dependencies?.createRunId?.() ?? "run-approval";
        return {
          runId,
          branchName: `nitely/${runId}`,
          worktreePath: `/tmp/${runId}`,
          status: "awaiting-approval",
          approvalId: "approve-spec-1",
        };
      },
    });

    expect(summary.awaitingApprovalTaskIds).toEqual(["wi-approval"]);
    expect(summary.completedTaskIds).toEqual([]);
    await expect(getWorkItem(repoPath, "wi-approval")).resolves.toMatchObject({
      status: "running",
      latestRunId: expect.any(String),
    });
  });

  it("admits a ready Work item only once across concurrent scheduler instances", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      {
        title: "Single scheduler owner",
        spec: refinedSpec(),
        techDesign: "Approved design",
      },
      {
        createId: () => "single-scheduler-owner",
        initialStatus: "ready",
        specStatus: "approved",
        techDesignStatus: "approved",
      },
    );
    let releaseRunner!: () => void;
    const runnerGate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    let reportRunnerStarted!: () => void;
    const runnerStarted = new Promise<void>((resolve) => {
      reportRunnerStarted = resolve;
    });
    let runnerCalls = 0;
    const runFlow = async (
      input: RunFlowInput,
      dependencies?: RunFlowDependencies,
    ): Promise<RunFlowResult> => {
      runnerCalls += 1;
      reportRunnerStarted();
      await runnerGate;
      return admittedResult(input.workItemId ?? "missing", dependencies);
    };

    const firstCycle = runSchedulerOnce({ repoPath, runFlow });
    await runnerStarted;
    const secondSummary = await runSchedulerOnce({ repoPath, runFlow });
    releaseRunner();
    const firstSummary = await firstCycle;

    expect(runnerCalls).toBe(1);
    expect([
      ...firstSummary.startedTaskIds,
      ...secondSummary.startedTaskIds,
    ]).toEqual(["single-scheduler-owner"]);
    expect(secondSummary.failedTaskIds).toEqual([]);
  });

  it("resumes one usage-limit blocked Run only once across concurrent schedulers", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "Single resume owner", spec: "spec", techDesign: "td" },
      { createId: () => "single-resume-owner" },
    );
    await updateTaskRunState(repoPath, "single-resume-owner", {
      status: "failed",
      latestRunId: "run-single-resume-owner",
    });
    writeUsageLimitBlockedRun(repoPath, {
      taskId: "single-resume-owner",
      runId: "run-single-resume-owner",
      retryAfter: "2026-06-26T06:00:00.000Z",
    });

    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    let reportResumeStarted!: () => void;
    const resumeStarted = new Promise<void>((resolve) => {
      reportResumeStarted = resolve;
    });
    let reportSecondResumeStarted!: () => void;
    const secondResumeStarted = new Promise<void>((resolve) => {
      reportSecondResumeStarted = resolve;
    });
    let resumeCalls = 0;
    const resumeRun = async (input: { runId: string }): Promise<RunFlowResult> => {
      resumeCalls += 1;
      reportResumeStarted();
      if (resumeCalls === 2) reportSecondResumeStarted();
      await resumeGate;
      return { ...result("single-resume-owner"), runId: input.runId };
    };

    const firstCycle = runSchedulerOnce({
      repoPath,
      now: () => new Date("2026-06-26T06:00:01.000Z"),
      resumeRun,
    });
    await resumeStarted;
    const secondCycle = runSchedulerOnce({
      repoPath,
      now: () => new Date("2026-06-26T06:00:01.000Z"),
      resumeRun,
    });
    await Promise.race([secondCycle.then(() => undefined), secondResumeStarted]);
    releaseResume();
    const [firstSummary, secondSummary] = await Promise.all([
      firstCycle,
      secondCycle,
    ]);

    expect(resumeCalls).toBe(1);
    expect([
      ...firstSummary.startedTaskIds,
      ...secondSummary.startedTaskIds,
    ]).toEqual(["single-resume-owner"]);
  });

  it("fails a resumed Run when it throws before recording a new terminal event", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "Resume failure", spec: "spec", techDesign: "td" },
      { createId: () => "resume-failure" },
    );
    await updateTaskRunState(repoPath, "resume-failure", {
      status: "failed",
      latestRunId: "run-resume-failure",
    });
    writeUsageLimitBlockedRun(repoPath, {
      taskId: "resume-failure",
      runId: "run-resume-failure",
      retryAfter: "2026-06-26T06:00:00.000Z",
    });

    const summary = await runSchedulerOnce({
      repoPath,
      now: () => new Date("2026-06-26T06:00:01.000Z"),
      resumeRun: async () => {
        throw new Error("resume workspace disappeared");
      },
    });

    expect(summary.failedTaskIds).toEqual(["resume-failure"]);
    expect(summary.blockedTaskIds).toEqual([]);
    await expect(getTask(repoPath, "resume-failure")).resolves.toMatchObject({
      status: "failed",
      latestRunId: "run-resume-failure",
    });
    const events = new EventStore(eventStorePath(repoPath));
    try {
      expect(events.latest("run-resume-failure")).toMatchObject({
        type: "run.failed",
        payload: { error: "resume workspace disappeared" },
      });
    } finally {
      events.close();
    }
  });

  it("keeps a crashed scheduler claim fail-closed until explicit recovery", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "Recover resume claim", spec: "spec", techDesign: "td" },
      { createId: () => "recover-resume-claim" },
    );
    await updateTaskRunState(repoPath, "recover-resume-claim", {
      status: "failed",
      latestRunId: "run-recover-resume-claim",
    });
    writeUsageLimitBlockedRun(repoPath, {
      taskId: "recover-resume-claim",
      runId: "run-recover-resume-claim",
      retryAfter: "2026-06-26T06:00:00.000Z",
    });
    const claimsPath = resumeClaimStorePath(repoPath);
    const claims = new ResumeClaimStore(claimsPath);
    try {
      expect(
        claims.claim({
          runId: "run-recover-resume-claim",
          token: "crashed-scheduler",
          now: new Date("2020-01-01T00:00:00.000Z"),
        }),
      ).toBe(true);
    } finally {
      claims.close();
    }

    const resumed: string[] = [];
    const blockedSummary = await runSchedulerOnce({
      repoPath,
      now: () => new Date("2026-06-26T06:00:01.000Z"),
      resumeRun: async (input) => {
        resumed.push(input.runId);
        return { ...result("recover-resume-claim"), runId: input.runId };
      },
    });

    expect(resumed).toEqual([]);
    expect(blockedSummary.startedTaskIds).toEqual([]);
    const recovery = new ResumeClaimStore(claimsPath);
    try {
      expect(recovery.get("run-recover-resume-claim")).toMatchObject({
        token: "crashed-scheduler",
        acquiredAt: "2020-01-01T00:00:00.000Z",
      });
      expect(
        recovery.release("run-recover-resume-claim", "crashed-scheduler"),
      ).toBe(true);
    } finally {
      recovery.close();
    }

    const recoveredSummary = await runSchedulerOnce({
      repoPath,
      now: () => new Date("2026-06-26T06:00:02.000Z"),
      resumeRun: async (input) => {
        resumed.push(input.runId);
        return { ...result("recover-resume-claim"), runId: input.runId };
      },
    });
    expect(resumed).toEqual(["run-recover-resume-claim"]);
    expect(recoveredSummary.completedTaskIds).toEqual(["recover-resume-claim"]);
  });

  it("revalidates queued resume candidates after another owner releases its claim", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "Resume first", spec: "spec", techDesign: "td" },
      {
        createId: () => "resume-first",
        now: () => new Date("2026-06-26T00:01:00.000Z"),
      },
    );
    await createTask(
      repoPath,
      { title: "Resume second", spec: "spec", techDesign: "td" },
      {
        createId: () => "resume-second",
        now: () => new Date("2026-06-26T00:00:00.000Z"),
      },
    );
    await updateTaskRunState(repoPath, "resume-first", {
      status: "failed",
      latestRunId: "run-resume-first",
    });
    await updateTaskRunState(repoPath, "resume-second", {
      status: "failed",
      latestRunId: "run-resume-second",
    });
    writeUsageLimitBlockedRun(repoPath, {
      taskId: "resume-first",
      runId: "run-resume-first",
      retryAfter: "2026-06-26T06:00:00.000Z",
    });
    writeUsageLimitBlockedRun(repoPath, {
      taskId: "resume-second",
      runId: "run-resume-second",
      retryAfter: "2026-06-26T06:00:00.000Z",
    });

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let reportFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      reportFirstStarted = resolve;
    });
    const resumeCalls: string[] = [];
    let secondCalls = 0;
    const resumeRun = async (input: { runId: string }): Promise<RunFlowResult> => {
      resumeCalls.push(input.runId);
      if (input.runId === "run-resume-first") {
        reportFirstStarted();
        await firstGate;
      } else {
        secondCalls += 1;
        if (secondCalls > 1) {
          throw new Error("completed Run was resumed from a stale snapshot");
        }
      }
      const events = new EventStore(eventStorePath(repoPath));
      try {
        events.append({ runId: input.runId, type: "run.completed", payload: {} });
      } finally {
        events.close();
      }
      return {
        ...result(
          input.runId === "run-resume-first" ? "resume-first" : "resume-second",
        ),
        runId: input.runId,
      };
    };

    const firstCycle = runSchedulerOnce({
      repoPath,
      now: () => new Date("2026-06-26T06:00:01.000Z"),
      resumeRun,
    });
    await firstStarted;
    const secondSummary = await runSchedulerOnce({
      repoPath,
      now: () => new Date("2026-06-26T06:00:01.000Z"),
      resumeRun,
    });
    expect(secondCalls).toBe(1);
    expect(secondSummary.completedTaskIds).toEqual(["resume-second"]);

    releaseFirst();
    const firstSummary = await firstCycle;
    expect(resumeCalls).toEqual(["run-resume-first", "run-resume-second"]);
    expect(firstSummary.completedTaskIds).toEqual(["resume-first"]);
    await expect(getTask(repoPath, "resume-second")).resolves.toMatchObject({
      status: "completed",
      latestRunId: "run-resume-second",
    });

    const events = new EventStore(eventStorePath(repoPath));
    try {
      expect(projectRun(events.list("run-resume-second")).status).toBe("completed");
      expect(
        events
          .list("run-resume-second")
          .some((event) => event.type === "run.failed"),
      ).toBe(false);
    } finally {
      events.close();
    }
    const claims = new ResumeClaimStore(resumeClaimStorePath(repoPath));
    try {
      expect(claims.get("run-resume-first")).toBeUndefined();
      expect(claims.get("run-resume-second")).toBeUndefined();
    } finally {
      claims.close();
    }
  });

  it("preserves a new blocker recorded by the resumed attempt", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "Resume blocked again", spec: "spec", techDesign: "td" },
      { createId: () => "resume-blocked-again" },
    );
    await updateTaskRunState(repoPath, "resume-blocked-again", {
      status: "failed",
      latestRunId: "run-resume-blocked-again",
    });
    writeUsageLimitBlockedRun(repoPath, {
      taskId: "resume-blocked-again",
      runId: "run-resume-blocked-again",
      retryAfter: "2026-06-26T06:00:00.000Z",
    });

    const summary = await runSchedulerOnce({
      repoPath,
      now: () => new Date("2026-06-26T06:00:01.000Z"),
      resumeRun: async (input) => {
        const events = new EventStore(eventStorePath(repoPath));
        try {
          events.append({
            runId: input.runId,
            type: "run.blocked",
            payload: {
              reason: "agent_usage_limit",
              message: "usage limit reached again",
              retryAfter: "2026-06-26T07:00:00.000Z",
            },
          });
        } finally {
          events.close();
        }
        throw new Error("runner reported the renewed blocker");
      },
    });

    expect(summary.blockedTaskIds).toEqual(["resume-blocked-again"]);
    expect(summary.failedTaskIds).toEqual([]);
    const events = new EventStore(eventStorePath(repoPath));
    try {
      expect(projectRun(events.list("run-resume-blocked-again"))).toMatchObject({
        status: "blocked",
        blocker: { message: "usage limit reached again" },
      });
      expect(
        events
          .list("run-resume-blocked-again")
          .some((event) => event.type === "run.failed"),
      ).toBe(false);
    } finally {
      events.close();
    }
  });

  it("preserves an admitted usage-limit blocker and settles it after resume", async () => {
    const repoPath = await createRepo();
    await writeValidFlow(repoPath);
    await writeFile(join(repoPath, "intake.md"), "Issue intake", "utf8");
    await createWorkItem(
      repoPath,
      {
        title: "Resume admitted quota blocker",
        workItemType: "dev.pr",
        flowPath: "flows/generic.json",
        inputs: {
          intake: { connector: "local-file", uri: "intake.md" },
        },
      },
      { createId: () => "admitted-quota-blocker" },
    );
    const retryAfter = "2026-07-15T02:00:00.000Z";
    const first = await runSchedulerOnce({
      repoPath,
      now: () => new Date("2026-07-15T01:00:00.000Z"),
      createRunId: () => "run-admitted-quota-blocker",
      runFlow: async (_input, dependencies) => {
        const runId = dependencies?.createRunId?.() ?? "missing-run-id";
        const events = new EventStore(eventStorePath(repoPath));
        const blocker = {
          reason: "agent_usage_limit",
          stageId: "implement",
          runtime: "codex",
          message: "You've hit your usage limit.",
          retryAfter,
        };
        try {
          events.append({
            runId,
            stageId: "implement",
            attempt: 1,
            type: "stage.started",
            payload: { type: "agent", runtime: "codex" },
          });
          events.append({
            runId,
            stageId: "implement",
            attempt: 1,
            type: "stage.blocked",
            payload: blocker,
          });
          events.append({ runId, type: "run.blocked", payload: blocker });
        } finally {
          events.close();
        }
        throw new Error("run blocked by agent_usage_limit");
      },
    });

    expect(first.failedTaskIds).toEqual([]);
    expect(first.blockedTaskIds).toEqual(["admitted-quota-blocker"]);
    await expect(getWorkItem(repoPath, "admitted-quota-blocker")).resolves.toMatchObject({
      status: "running",
      latestRunId: "run-admitted-quota-blocker",
    });
    const blockedEvents = new EventStore(eventStorePath(repoPath));
    try {
      expect(projectRun(blockedEvents.list("run-admitted-quota-blocker")).status).toBe(
        "blocked",
      );
      expect(
        blockedEvents
          .list("run-admitted-quota-blocker")
          .some((event) => event.type === "run.failed"),
      ).toBe(false);
    } finally {
      blockedEvents.close();
    }

    const resumed: string[] = [];
    const second = await runSchedulerOnce({
      repoPath,
      now: () => new Date("2026-07-15T02:00:01.000Z"),
      resumeRun: async (input) => {
        resumed.push(input.runId);
        return {
          ...result("admitted-quota-blocker"),
          runId: input.runId,
          changeRequestUrl: "https://github.com/Instask/nitely/pull/1001",
        };
      },
      getChangeRequestStatus: async () => ({
        provider: "github",
        state: "closed",
        merged: true,
      }),
    });

    expect(resumed).toEqual(["run-admitted-quota-blocker"]);
    expect(second.completedTaskIds).toEqual(["admitted-quota-blocker"]);
    await expect(getWorkItem(repoPath, "admitted-quota-blocker")).resolves.toMatchObject({
      status: "completed",
      latestRunId: "run-admitted-quota-blocker",
    });
    const admissions = new RunAdmissionStore(
      join(repoPath, ".nitely", "run-admissions.db"),
    );
    try {
      expect(admissions.get("run-admitted-quota-blocker")).toMatchObject({
        state: "settled",
      });
    } finally {
      admissions.close();
    }
  });

  it("does not resume usage-limit blocked runs before their retry time", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "Quota wait", spec: "spec", techDesign: "td" },
      { createId: () => "quota-wait" },
    );
    await updateTaskRunState(repoPath, "quota-wait", {
      status: "failed",
      latestRunId: "run-quota-wait",
    });
    writeUsageLimitBlockedRun(repoPath, {
      taskId: "quota-wait",
      runId: "run-quota-wait",
      retryAfter: "2026-06-26T06:00:00.000Z",
    });

    const resumed: string[] = [];
    await runSchedulerOnce({
      repoPath,
      now: () => new Date("2026-06-26T05:59:00.000Z"),
      resumeRun: async (input) => {
        resumed.push(input.runId);
        return result("quota-wait");
      },
      getChangeRequestStatus: async () => ({
        provider: "github",
        state: "closed",
        merged: true,
      }),
    });

    expect(resumed).toEqual([]);
    await expect(import("../../src/web/tasks.js").then((module) =>
      module.getTask(repoPath, "quota-wait"),
    )).resolves.toMatchObject({
      status: "failed",
      latestRunId: "run-quota-wait",
    });
  });

  it("resumes usage-limit blocked runs after their retry time", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "Quota resume", spec: "spec", techDesign: "td" },
      { createId: () => "quota-resume" },
    );
    await updateTaskRunState(repoPath, "quota-resume", {
      status: "failed",
      latestRunId: "run-quota-resume",
    });
    writeUsageLimitBlockedRun(repoPath, {
      taskId: "quota-resume",
      runId: "run-quota-resume",
      retryAfter: "2026-06-26T06:00:00.000Z",
    });

    const resumed: string[] = [];
    const summary = await runSchedulerOnce({
      repoPath,
      now: () => new Date("2026-06-26T06:00:01.000Z"),
      resumeRun: async (input) => {
        resumed.push(input.runId);
        return {
          ...result("quota-resume"),
          runId: input.runId,
          changeRequestUrl: "https://github.com/Instask/nitely/pull/999",
        };
      },
      getChangeRequestStatus: async () => ({
        provider: "github",
        state: "closed",
        merged: true,
      }),
    });

    expect(resumed).toEqual(["run-quota-resume"]);
    expect(summary.completedTaskIds).toEqual(["quota-resume"]);
    await expect(import("../../src/web/tasks.js").then((module) =>
      module.getTask(repoPath, "quota-resume"),
    )).resolves.toMatchObject({
      status: "completed",
      latestRunId: "run-quota-resume",
      changeRequestUrl: "https://github.com/Instask/nitely/pull/999",
    });
  });

  it("resumes Claude reset blockers using the reset timezone", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "Claude quota resume", spec: "spec", techDesign: "td" },
      { createId: () => "claude-quota-resume" },
    );
    await updateTaskRunState(repoPath, "claude-quota-resume", {
      status: "failed",
      latestRunId: "run-claude-quota-resume",
    });
    writeUsageLimitBlockedRun(repoPath, {
      taskId: "claude-quota-resume",
      runId: "run-claude-quota-resume",
      retryAfter: "12:50am (Asia/Singapore)",
    });

    const resumed: string[] = [];
    const resumeRun = async (input: { runId: string }): Promise<RunFlowResult> => {
      resumed.push(input.runId);
      return { ...result("claude-quota-resume"), runId: input.runId };
    };
    await runSchedulerOnce({
      repoPath,
      now: () => new Date("2026-06-25T16:49:00.000Z"),
      resumeRun,
    });
    expect(resumed).toEqual([]);

    await runSchedulerOnce({
      repoPath,
      now: () => new Date("2026-06-25T16:50:00.000Z"),
      resumeRun,
    });
    expect(resumed).toEqual(["run-claude-quota-resume"]);
  });

  // The persisted row is only cleared by a successful resume, so a window that
  // has already passed must stop gating on its own.
  it("releases ready work once a persisted usage cooldown window has passed", async () => {
    const repoPath = await createRepo();
    await writeValidFlow(repoPath, "flows/mock.json", "mock");
    await writeFile(join(repoPath, "intake.md"), "Issue intake", "utf8");

    await createTask(
      repoPath,
      { title: "Mock quota blocker", spec: "spec", techDesign: "td" },
      { createId: () => "mock-quota-blocker" },
    );
    await updateTaskRunState(repoPath, "mock-quota-blocker", {
      status: "failed",
      latestRunId: "run-mock-quota-blocker",
    });
    writeUsageLimitBlockedRun(repoPath, {
      taskId: "mock-quota-blocker",
      runId: "run-mock-quota-blocker",
      runtime: "mock",
      retryAfter: "2026-07-15T02:00:00.000Z",
    });

    await createWorkItem(
      repoPath,
      {
        title: "Wait for mock reset",
        workItemType: "dev.pr",
        flowPath: "flows/mock.json",
        inputs: { intake: { connector: "local-file", uri: "intake.md" } },
      },
      { createId: () => "mock-waiting" },
    );

    const started: string[] = [];
    const summary = await runSchedulerOnce({
      repoPath,
      now: () => new Date("2026-07-15T03:00:00.000Z"),
      runFlow: async (input, dependencies) => {
        started.push(input.workItemId ?? "missing");
        return admittedResult(input.workItemId ?? "missing", dependencies);
      },
    });

    expect(started).toContain("mock-waiting");
    expect(summary.cooldownTaskIds).toEqual([]);
  });

  it("holds ready work for a runtime with a persisted future usage cooldown", async () => {
    const repoPath = await createRepo();
    await writeValidFlow(repoPath, "flows/mock.json", "mock");
    await writeValidFlow(repoPath, "flows/other.json", "other-runtime");
    await writeFile(join(repoPath, "intake.md"), "Issue intake", "utf8");

    await createTask(
      repoPath,
      { title: "Mock quota blocker", spec: "spec", techDesign: "td" },
      { createId: () => "mock-quota-blocker" },
    );
    await updateTaskRunState(repoPath, "mock-quota-blocker", {
      status: "failed",
      latestRunId: "run-mock-quota-blocker",
    });
    writeUsageLimitBlockedRun(repoPath, {
      taskId: "mock-quota-blocker",
      runId: "run-mock-quota-blocker",
      runtime: "mock",
      retryAfter: "2026-07-15T02:00:00.000Z",
    });

    await createWorkItem(
      repoPath,
      {
        title: "Wait for mock reset",
        workItemType: "dev.pr",
        flowPath: "flows/mock.json",
        inputs: { intake: { connector: "local-file", uri: "intake.md" } },
      },
      { createId: () => "mock-waiting" },
    );
    await createWorkItem(
      repoPath,
      {
        title: "Run other runtime",
        workItemType: "dev.pr",
        flowPath: "flows/other.json",
        inputs: { intake: { connector: "local-file", uri: "intake.md" } },
      },
      { createId: () => "other-runtime" },
    );

    const started: string[] = [];
    const summary = await runSchedulerOnce({
      repoPath,
      now: () => new Date("2026-07-15T01:00:00.000Z"),
      runFlow: async (input, dependencies) => {
        started.push(input.workItemId ?? "missing");
        return admittedResult(input.workItemId ?? "missing", dependencies);
      },
    });

    expect(started).toEqual(["other-runtime"]);
    expect(summary.cooldownTaskIds).toEqual(["mock-waiting"]);
    expect(summary.cooldownUntil).toEqual({
      "mock-waiting": "2026-07-15T02:00:00.000Z",
    });
    await expect(getWorkItem(repoPath, "mock-waiting")).resolves.toMatchObject({
      status: "ready",
    });
  });
});
