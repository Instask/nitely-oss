import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FileRunnerControlPlane,
  FileRunnerEventOutbox,
} from "../../src/runner-control-plane/file-stub.js";
import {
  createRunnerEvent,
  runnerEventForAssignmentDecision,
  type RunnerPolicySnapshot,
  type RunnerTaskAssignment,
} from "../../src/runner-control-plane/protocol.js";

const fixedNow = () => new Date("2026-07-08T00:00:00.000Z");

async function controlPlaneFixture() {
  const dir = await mkdtemp(join(tmpdir(), "nitely-runner-control-plane-"));
  const policy: RunnerPolicySnapshot = {
    tenantId: "tenant-1",
    runnerId: "runner-1",
    policyVersion: "policy-1",
    allowedRepositories: ["repo-1"],
  };
  const controlPlane = new FileRunnerControlPlane({
    path: join(dir, "control-plane.json"),
    now: fixedNow,
  });
  await controlPlane.registerRunner(policy, {
    now: fixedNow,
    createId: () => "register-1",
  });
  return { dir, policy, controlPlane };
}

function assignment(
  input: Partial<RunnerTaskAssignment> = {},
): RunnerTaskAssignment {
  return {
    taskId: input.taskId ?? "task-1",
    repoId: input.repoId ?? "repo-1",
    repository: input.repository ?? {
      repoId: input.repoId ?? "repo-1",
      name: "Instask/example",
      cloneUrl: "https://github.com/Instask/example.git",
      defaultBranch: "main",
    },
    sourceRevision: input.sourceRevision ?? "abc1234",
    flowId: input.flowId ?? "flow-approved-pr",
    flowPath: input.flowPath ?? "flows/approved-pr.json",
    policyVersion: input.policyVersion ?? "policy-1",
    inputs: input.inputs ?? { issue: { type: "github-issue", id: "275" } },
  };
}

describe("FileRunnerControlPlane", () => {
  it("polls one task assignment and records runner acceptance", async () => {
    const { controlPlane, policy } = await controlPlaneFixture();
    const task = assignment();

    await controlPlane.assignTask(
      { tenantId: policy.tenantId, runnerId: policy.runnerId, ...task },
      { now: fixedNow, createId: () => "assign-1" },
    );

    expect(await controlPlane.pollAssignments(policy)).toMatchObject([
      {
        kind: "task.assigned",
        taskId: "task-1",
        payload: {
          taskId: "task-1",
          repoId: "repo-1",
          repository: {
            repoId: "repo-1",
            name: "Instask/example",
            cloneUrl: "https://github.com/Instask/example.git",
            defaultBranch: "main",
          },
          sourceRevision: "abc1234",
          flowId: "flow-approved-pr",
          flowPath: "flows/approved-pr.json",
          policyVersion: "policy-1",
        },
        redactionStatus: "metadata_only",
      },
    ]);

    const accepted = runnerEventForAssignmentDecision({
      policy,
      assignment: task,
      now: fixedNow,
      createId: () => "accepted-1",
    });
    const report = await controlPlane.reportRunnerEvents([accepted]);

    expect(report).toEqual({
      acceptedEventIds: ["accepted-1"],
      duplicateEventIds: [],
      rejectedEvents: [],
    });
    await expect(
      controlPlane.getAssignment({ tenantId: policy.tenantId, taskId: "task-1" }),
    ).resolves.toMatchObject({
      status: "accepted",
      repoId: "repo-1",
      sourceRevision: "abc1234",
      flowId: "flow-approved-pr",
      flowPath: "flows/approved-pr.json",
    });
  });

  it("rejects assignments outside the runner repository set or policy version", async () => {
    const { controlPlane, policy } = await controlPlaneFixture();
    const wrongRepo = assignment({ taskId: "task-2", repoId: "repo-2" });
    const stalePolicy = assignment({
      taskId: "task-3",
      policyVersion: "policy-0",
    });

    await controlPlane.assignTask({
      tenantId: policy.tenantId,
      runnerId: policy.runnerId,
      ...wrongRepo,
    });
    await controlPlane.assignTask({
      tenantId: policy.tenantId,
      runnerId: policy.runnerId,
      ...stalePolicy,
    });

    const report = await controlPlane.reportRunnerEvents([
      runnerEventForAssignmentDecision({
        policy,
        assignment: wrongRepo,
        createId: () => "reject-repo",
        now: fixedNow,
      }),
      runnerEventForAssignmentDecision({
        policy,
        assignment: stalePolicy,
        createId: () => "reject-policy",
        now: fixedNow,
      }),
    ]);

    expect(report.rejectedEvents).toEqual([]);
    await expect(
      controlPlane.getAssignment({ tenantId: policy.tenantId, taskId: "task-2" }),
    ).resolves.toMatchObject({
      status: "rejected",
      rejection: { reason: "repository_not_allowed" },
    });
    await expect(
      controlPlane.getAssignment({ tenantId: policy.tenantId, taskId: "task-3" }),
    ).resolves.toMatchObject({
      status: "rejected",
      rejection: { reason: "policy_version_mismatch" },
    });
  });

  it("records runner heartbeat metadata without source or log upload", async () => {
    const { controlPlane, policy } = await controlPlaneFixture();
    const heartbeat = createRunnerEvent({
      kind: "runner.heartbeat",
      tenantId: policy.tenantId,
      runnerId: policy.runnerId,
      policyVersion: policy.policyVersion,
      now: fixedNow,
      createId: () => "heartbeat-1",
      payload: {
        status: "idle",
        activeRunIds: ["run-1"],
        version: "0.1.0-dev",
      },
    });

    await expect(controlPlane.reportRunnerEvents([heartbeat])).resolves.toMatchObject({
      acceptedEventIds: ["heartbeat-1"],
      rejectedEvents: [],
    });
    await expect(controlPlane.getRunner(policy)).resolves.toMatchObject({
      status: "idle",
      activeRunIds: ["run-1"],
      version: "0.1.0-dev",
      lastSeenAt: "2026-07-08T00:00:00.000Z",
    });
  });

  it("records blocked run status as safe metadata on the assignment", async () => {
    const { controlPlane, policy } = await controlPlaneFixture();
    const task = assignment();
    await controlPlane.assignTask({
      tenantId: policy.tenantId,
      runnerId: policy.runnerId,
      ...task,
    });

    const events = [
      runnerEventForAssignmentDecision({
        policy,
        assignment: task,
        createId: () => "accepted-1",
        now: fixedNow,
      }),
      createRunnerEvent({
        kind: "run.started",
        tenantId: policy.tenantId,
        runnerId: policy.runnerId,
        taskId: task.taskId,
        runId: "run-1",
        sequence: 1,
        policyVersion: policy.policyVersion,
        now: fixedNow,
        createId: () => "run-started-1",
        payload: {
          runId: "run-1",
          taskId: task.taskId,
          repoId: task.repoId,
          flowId: task.flowId,
        },
      }),
      createRunnerEvent({
        kind: "run.blocked",
        tenantId: policy.tenantId,
        runnerId: policy.runnerId,
        taskId: task.taskId,
        runId: "run-1",
        sequence: 2,
        policyVersion: policy.policyVersion,
        now: fixedNow,
        createId: () => "run-blocked-1",
        payload: {
          runId: "run-1",
          stageId: "implement",
          blockerCategory: "agent_usage_limit",
          safeMessage: "agent usage limit; retry later",
        },
      }),
    ];

    await expect(controlPlane.reportRunnerEvents(events)).resolves.toMatchObject({
      acceptedEventIds: ["accepted-1", "run-started-1", "run-blocked-1"],
      rejectedEvents: [],
    });
    await expect(
      controlPlane.getAssignment({ tenantId: policy.tenantId, taskId: task.taskId }),
    ).resolves.toMatchObject({
      status: "blocked",
      latestRunId: "run-1",
      blocker: {
        runId: "run-1",
        stageId: "implement",
        category: "agent_usage_limit",
        safeMessage: "agent usage limit; retry later",
      },
    });
  });

  it("records preparing and cancelled run status on the assignment", async () => {
    const { controlPlane, policy } = await controlPlaneFixture();
    const task = assignment();
    await controlPlane.assignTask({
      tenantId: policy.tenantId,
      runnerId: policy.runnerId,
      ...task,
    });

    const events = [
      runnerEventForAssignmentDecision({
        policy,
        assignment: task,
        createId: () => "accepted-1",
        now: fixedNow,
      }),
      createRunnerEvent({
        kind: "run.preparing",
        tenantId: policy.tenantId,
        runnerId: policy.runnerId,
        taskId: task.taskId,
        runId: "run-1",
        sequence: 1,
        policyVersion: policy.policyVersion,
        now: fixedNow,
        createId: () => "run-preparing-1",
        payload: {
          runId: "run-1",
          taskId: task.taskId,
          repoId: task.repoId,
          flowId: task.flowId,
        },
      }),
      createRunnerEvent({
        kind: "run.started",
        tenantId: policy.tenantId,
        runnerId: policy.runnerId,
        taskId: task.taskId,
        runId: "run-1",
        sequence: 2,
        policyVersion: policy.policyVersion,
        now: fixedNow,
        createId: () => "run-started-1",
        payload: {
          runId: "run-1",
          taskId: task.taskId,
          repoId: task.repoId,
          flowId: task.flowId,
        },
      }),
      createRunnerEvent({
        kind: "run.cancelled",
        tenantId: policy.tenantId,
        runnerId: policy.runnerId,
        taskId: task.taskId,
        runId: "run-1",
        sequence: 3,
        policyVersion: policy.policyVersion,
        now: fixedNow,
        createId: () => "run-cancelled-1",
        payload: {
          runId: "run-1",
          taskId: task.taskId,
          safeMessage: "cancelled by operator request",
        },
      }),
    ];

    await expect(controlPlane.reportRunnerEvents(events)).resolves.toMatchObject({
      acceptedEventIds: [
        "accepted-1",
        "run-preparing-1",
        "run-started-1",
        "run-cancelled-1",
      ],
      rejectedEvents: [],
    });
    await expect(
      controlPlane.getAssignment({ tenantId: policy.tenantId, taskId: task.taskId }),
    ).resolves.toMatchObject({
      status: "cancelled",
      latestRunId: "run-1",
      cancellation: {
        runId: "run-1",
        safeMessage: "cancelled by operator request",
      },
    });
  });

  it("enforces metadata-only upload boundaries by default", async () => {
    const { controlPlane, policy } = await controlPlaneFixture();
    const task = assignment();
    await controlPlane.assignTask({
      tenantId: policy.tenantId,
      runnerId: policy.runnerId,
      ...task,
    });

    const safeEvidence = createRunnerEvent({
      kind: "evidence.reported",
      tenantId: policy.tenantId,
      runnerId: policy.runnerId,
      taskId: task.taskId,
      runId: "run-1",
      policyVersion: policy.policyVersion,
      createId: () => "safe-evidence",
      payload: {
        runId: "run-1",
        artifacts: [
          {
            id: "run-evidence",
            mediaType: "text/markdown",
            bytes: 380,
            redactionStatus: "metadata_only",
          },
        ],
      },
    });
    const rawPrompt = createRunnerEvent({
      kind: "evidence.reported",
      tenantId: policy.tenantId,
      runnerId: policy.runnerId,
      taskId: task.taskId,
      runId: "run-1",
      policyVersion: policy.policyVersion,
      createId: () => "raw-prompt",
      payload: {
        runId: "run-1",
        rawPrompt: "Please inspect src/secret.ts",
      },
    });
    const explicitRaw = createRunnerEvent({
      kind: "evidence.reported",
      tenantId: policy.tenantId,
      runnerId: policy.runnerId,
      taskId: task.taskId,
      runId: "run-1",
      policyVersion: policy.policyVersion,
      createId: () => "explicit-raw",
      redactionStatus: "explicit_raw_upload",
      payload: {
        runId: "run-1",
        artifactContent: "raw artifact body",
      },
    });

    const report = await controlPlane.reportRunnerEvents([
      safeEvidence,
      rawPrompt,
      explicitRaw,
    ]);

    expect(report.acceptedEventIds).toEqual(["safe-evidence"]);
    expect(report.rejectedEvents).toMatchObject([
      {
        eventId: "raw-prompt",
        reason: expect.stringContaining("raw fields"),
      },
      {
        eventId: "explicit-raw",
        reason: expect.stringContaining("explicit_raw_upload"),
      },
    ]);
    await expect(controlPlane.listRunnerEvents()).resolves.toHaveLength(1);
  });

  it("allows explicit raw evidence only when runner policy opts in", async () => {
    const { dir } = await controlPlaneFixture();
    const policy: RunnerPolicySnapshot = {
      tenantId: "tenant-raw",
      runnerId: "runner-raw",
      policyVersion: "policy-raw",
      allowedRepositories: ["repo-1"],
      allowedUploadRedactionStatuses: [
        "metadata_only",
        "sanitized",
        "explicit_raw_upload",
      ],
    };
    const controlPlane = new FileRunnerControlPlane({
      path: join(dir, "raw-control-plane.json"),
      now: fixedNow,
    });
    await controlPlane.registerRunner(policy);
    const task = assignment({ policyVersion: policy.policyVersion });
    await controlPlane.assignTask({
      tenantId: policy.tenantId,
      runnerId: policy.runnerId,
      ...task,
    });

    const rawEvidence = createRunnerEvent({
      kind: "evidence.reported",
      tenantId: policy.tenantId,
      runnerId: policy.runnerId,
      taskId: task.taskId,
      runId: "run-raw",
      policyVersion: policy.policyVersion,
      createId: () => "raw-allowed",
      redactionStatus: "explicit_raw_upload",
      payload: {
        runId: "run-raw",
        rawPrompt: "operator explicitly allowed this upload",
      },
    });

    await expect(controlPlane.reportRunnerEvents([rawEvidence])).resolves.toEqual({
      acceptedEventIds: ["raw-allowed"],
      duplicateEventIds: [],
      rejectedEvents: [],
    });
  });

  it("replays buffered events with idempotent event ids", async () => {
    const { controlPlane, policy, dir } = await controlPlaneFixture();
    const outbox = new FileRunnerEventOutbox({
      path: join(dir, "runner-outbox.json"),
    });
    const heartbeat = createRunnerEvent({
      kind: "runner.heartbeat",
      tenantId: policy.tenantId,
      runnerId: policy.runnerId,
      policyVersion: policy.policyVersion,
      createId: () => "heartbeat-offline",
      payload: { status: "busy", activeRunIds: ["run-offline"], version: "0.1.0" },
    });

    await outbox.enqueue([heartbeat, heartbeat]);
    await expect(outbox.listEvents()).resolves.toHaveLength(1);

    const firstReport = await outbox.replay((events) =>
      controlPlane.reportRunnerEvents(events),
    );
    expect(firstReport).toEqual({
      acceptedEventIds: ["heartbeat-offline"],
      duplicateEventIds: [],
      rejectedEvents: [],
    });
    await expect(outbox.listEvents()).resolves.toHaveLength(0);

    await outbox.enqueue(heartbeat);
    const duplicateReport = await outbox.replay((events) =>
      controlPlane.reportRunnerEvents(events),
    );
    expect(duplicateReport).toEqual({
      acceptedEventIds: ["heartbeat-offline"],
      duplicateEventIds: ["heartbeat-offline"],
      rejectedEvents: [],
    });
    await expect(controlPlane.listRunnerEvents()).resolves.toHaveLength(1);
    await expect(outbox.listEvents()).resolves.toHaveLength(0);
  });
});
