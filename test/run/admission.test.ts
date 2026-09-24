import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import {
  admitWorkItemRun,
  reconcileTerminalWorkItemRun,
  settleWorkItemRun,
} from "../../src/run/admission.js";
import { RunAdmissionStore } from "../../src/run/admission-store.js";
import { workItemDependencyGuards } from "../../src/work-items/candidate-version.js";
import { eventStorePath } from "../../src/run/project.js";
import { taskRecordToWorkItem } from "../../src/work-items/adapters/dev-pr.js";
import {
  createTask,
  freezeTaskPlanningBaseline,
  getTask,
  getTaskSnapshot,
  taskWorkflowMetadataInputUri,
  updateTaskRunState,
} from "../../src/web/tasks.js";
import {
  createWorkItem,
  getWorkItem,
  getWorkItemSnapshot,
  updateWorkItem,
} from "../../src/work-items/store.js";

async function createRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-run-admission-"));
  await mkdir(join(repoPath, "flows"), { recursive: true });
  await writeFile(join(repoPath, "flows", "generic.json"), "{}\n", "utf8");
  return repoPath;
}

describe("Run admission", () => {
  it("admits exactly one Run for concurrent attempts on one generic Work item snapshot", async () => {
    const repoPath = await createRepo();
    const expectedWorkItem = await createWorkItem(
      repoPath,
      {
        title: "Publish the site",
        workItemType: "autofarm.site",
        flowPath: "flows/generic.json",
        inputs: {},
      },
      { createId: () => "site" },
    );
    const candidate = await getWorkItemSnapshot(repoPath, expectedWorkItem.id);
    const runInput = {
      repoPath,
      flowPath: expectedWorkItem.flowPath,
      inputs: expectedWorkItem.inputs,
      workItemId: expectedWorkItem.id,
      workItemType: expectedWorkItem.workItemType,
    };

    const results = await Promise.all([
      admitWorkItemRun({
        repoPath,
        candidate: { workItem: candidate.record, version: candidate.version },
        runInput,
        createRunId: () => "run-first",
      }),
      admitWorkItemRun({
        repoPath,
        candidate: { workItem: candidate.record, version: candidate.version },
        runInput,
        createRunId: () => "run-second",
      }),
    ]);

    const admitted = results.filter((result) => result.decision === "admitted");
    const conflicted = results.filter((result) => result.decision === "conflict");
    expect(admitted).toHaveLength(1);
    expect(conflicted).toHaveLength(1);
    expect(conflicted[0]?.runId).toBe(admitted[0]?.runId);

    await expect(getWorkItem(repoPath, "site")).resolves.toMatchObject({
      status: "running",
      latestRunId: admitted[0]?.runId,
    });
    const store = new EventStore(eventStorePath(repoPath));
    try {
      expect(store.list(admitted[0]!.runId).filter((event) => event.type === "run.admitted"))
        .toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("admits exactly one Run for a legacy Task and persists the winner's planning baseline", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      {
        title: "Implement the approved spec",
        spec: "# Approved spec\n",
        techDesign: "# Approved design\n",
        flowPath: "flows/generic.json",
      },
      {
        createId: () => "legacy-task",
        now: () => new Date("2026-07-15T00:00:00.000Z"),
        initialStatus: "ready",
        specStatus: "approved",
        techDesignStatus: "approved",
      },
    );
    const snapshot = await getTaskSnapshot(repoPath, "legacy-task");
    const expectedWorkItem = taskRecordToWorkItem(snapshot.record);
    const activePlanningBaseline = freezeTaskPlanningBaseline(
      snapshot.record,
      "2026-07-15T00:01:00.000Z",
    );
    const runInput = {
      repoPath,
      flowPath: expectedWorkItem.flowPath,
      inputs: expectedWorkItem.inputs,
      workItemId: expectedWorkItem.id,
      workItemType: expectedWorkItem.workItemType,
    };
    const candidate = { workItem: expectedWorkItem, version: snapshot.version };

    const results = await Promise.all([
      admitWorkItemRun({
        repoPath,
        candidate,
        runInput,
        legacyState: { activePlanningBaseline },
        createRunId: () => "run-legacy-first",
      }),
      admitWorkItemRun({
        repoPath,
        candidate,
        runInput,
        legacyState: { activePlanningBaseline },
        createRunId: () => "run-legacy-second",
      }),
    ]);

    const admitted = results.find((result) => result.decision === "admitted");
    expect(results.filter((result) => result.decision === "admitted")).toHaveLength(1);
    expect(results.find((result) => result.decision === "conflict")?.runId).toBe(
      admitted?.runId,
    );
    await expect(getTask(repoPath, "legacy-task")).resolves.toMatchObject({
      status: "running",
      latestRunId: admitted?.runId,
      activePlanningBaseline,
    });
    const workflowMetadata = JSON.parse(
      await readFile(
        join(repoPath, taskWorkflowMetadataInputUri(snapshot.record)),
        "utf8",
      ),
    ) as { planningBaseline?: unknown };
    expect(workflowMetadata.planningBaseline).toEqual(activePlanningBaseline);
  });

  it("admits different Work items independently", async () => {
    const repoPath = await createRepo();
    const records = await Promise.all(
      ["site-a", "site-b"].map((id) =>
        createWorkItem(
          repoPath,
          {
            title: id,
            workItemType: "autofarm.site",
            flowPath: "flows/generic.json",
            inputs: {},
          },
          { createId: () => id },
        ),
      ),
    );
    const snapshots = await Promise.all(
      records.map((record) => getWorkItemSnapshot(repoPath, record.id)),
    );

    const results = await Promise.all(
      snapshots.map((snapshot, index) =>
        admitWorkItemRun({
          repoPath,
          candidate: {
            workItem: snapshot.record,
            version: snapshot.version,
          },
          runInput: {
            repoPath,
            flowPath: snapshot.record.flowPath,
            inputs: snapshot.record.inputs,
            workItemId: snapshot.record.id,
            workItemType: snapshot.record.workItemType,
          },
          createRunId: () => `run-site-${index + 1}`,
        }),
      ),
    );

    expect(results.map((result) => result.decision)).toEqual([
      "admitted",
      "admitted",
    ]);
  });

  it("lets only one terminal settlement update the admitted Work item", async () => {
    const repoPath = await createRepo();
    const record = await createWorkItem(
      repoPath,
      {
        title: "Settle once",
        workItemType: "autofarm.site",
        flowPath: "flows/generic.json",
        inputs: {},
      },
      { createId: () => "settle-once" },
    );
    const snapshot = await getWorkItemSnapshot(repoPath, record.id);
    const admission = await admitWorkItemRun({
      repoPath,
      candidate: { workItem: snapshot.record, version: snapshot.version },
      runInput: {
        repoPath,
        flowPath: record.flowPath,
        inputs: record.inputs,
        workItemId: record.id,
        workItemType: record.workItemType,
      },
      createRunId: () => "run-settle-once",
    });
    expect(admission.decision).toBe("admitted");

    const settlements = await Promise.all([
      settleWorkItemRun({
        repoPath,
        workItemId: record.id,
        runId: "run-settle-once",
        status: "completed",
      }),
      settleWorkItemRun({
        repoPath,
        workItemId: record.id,
        runId: "run-settle-once",
        status: "failed",
      }),
    ]);

    const winner = settlements.find((result) => result.settled);
    expect(settlements.filter((result) => result.settled)).toHaveLength(1);
    await expect(getWorkItem(repoPath, record.id)).resolves.toMatchObject({
      status: winner?.workItem.status,
      latestRunId: "run-settle-once",
    });
  });

  it("does not let a Run settlement mutate a different Work item", async () => {
    const repoPath = await createRepo();
    const [owner, other] = await Promise.all(
      ["settlement-owner", "settlement-other"].map((id) =>
        createWorkItem(
          repoPath,
          {
            title: id,
            workItemType: "autofarm.site",
            flowPath: "flows/generic.json",
            inputs: {},
          },
          { createId: () => id },
        ),
      ),
    );
    const snapshot = await getWorkItemSnapshot(repoPath, owner.id);
    await expect(
      admitWorkItemRun({
        repoPath,
        candidate: { workItem: snapshot.record, version: snapshot.version },
        runInput: {
          repoPath,
          flowPath: owner.flowPath,
          inputs: owner.inputs,
          workItemId: owner.id,
          workItemType: owner.workItemType,
        },
        createRunId: () => "run-bound-to-owner",
      }),
    ).resolves.toMatchObject({ decision: "admitted" });

    await expect(
      settleWorkItemRun({
        repoPath,
        workItemId: other.id,
        runId: "run-bound-to-owner",
        status: "completed",
      }),
    ).resolves.toMatchObject({
      settled: false,
      reason: "work-item-mismatch",
      workItem: { id: owner.id, status: "running" },
    });
    const admissions = new RunAdmissionStore(
      join(repoPath, ".nitely", "run-admissions.db"),
    );
    try {
      expect(admissions.get("run-bound-to-owner")).toMatchObject({
        state: "active",
        workItemId: owner.id,
      });
    } finally {
      admissions.close();
    }
    await expect(getWorkItem(repoPath, other.id)).resolves.toMatchObject({
      status: "ready",
    });
    await expect(
      settleWorkItemRun({
        repoPath,
        workItemId: owner.id,
        runId: "run-bound-to-owner",
        status: "completed",
      }),
    ).resolves.toMatchObject({ settled: true });
  });

  it("settles the admitted store when legacy and generic Work items share an id", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      {
        title: "Legacy same id",
        spec: "Approved spec",
        techDesign: "Approved design",
        flowPath: "flows/generic.json",
      },
      {
        createId: () => "same-store-id",
        initialStatus: "ready",
        specStatus: "approved",
        techDesignStatus: "approved",
      },
    );
    await createWorkItem(
      repoPath,
      {
        title: "Generic same id",
        workItemType: "autofarm.site",
        flowPath: "flows/generic.json",
        inputs: {},
      },
      { createId: () => "same-store-id" },
    );
    const legacySnapshot = await getTaskSnapshot(repoPath, "same-store-id");
    const legacyWorkItem = taskRecordToWorkItem(legacySnapshot.record);
    await expect(
      admitWorkItemRun({
        repoPath,
        candidate: {
          workItem: legacyWorkItem,
          version: legacySnapshot.version,
        },
        runInput: {
          repoPath,
          flowPath: legacyWorkItem.flowPath,
          inputs: legacyWorkItem.inputs,
          workItemId: legacyWorkItem.id,
          workItemType: legacyWorkItem.workItemType,
        },
        createRunId: () => "run-legacy-same-store-id",
      }),
    ).resolves.toMatchObject({ decision: "admitted" });

    await expect(
      settleWorkItemRun({
        repoPath,
        workItemId: "same-store-id",
        runId: "run-legacy-same-store-id",
        status: "completed",
      }),
    ).resolves.toMatchObject({ settled: true });
    await expect(getTask(repoPath, "same-store-id")).resolves.toMatchObject({
      status: "completed",
      latestRunId: "run-legacy-same-store-id",
    });
    await expect(getWorkItem(repoPath, "same-store-id")).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("reconciles a pre-ledger legacy Run when a generic Work item shares its id", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      {
        title: "Legacy pre-ledger Run",
        spec: "Approved spec",
        techDesign: "Approved design",
        flowPath: "flows/generic.json",
      },
      {
        createId: () => "same-history-id",
        initialStatus: "ready",
        specStatus: "approved",
        techDesignStatus: "approved",
      },
    );
    await updateTaskRunState(repoPath, "same-history-id", {
      status: "running",
      latestRunId: "run-before-admission-ledger",
    });
    await createWorkItem(
      repoPath,
      {
        title: "Generic collision",
        workItemType: "autofarm.site",
        flowPath: "flows/generic.json",
        inputs: {},
      },
      { createId: () => "same-history-id" },
    );
    const events = new EventStore(eventStorePath(repoPath));
    try {
      events.append({
        runId: "run-before-admission-ledger",
        type: "run.completed",
        payload: {},
      });
    } finally {
      events.close();
    }

    await expect(
      reconcileTerminalWorkItemRun({
        repoPath,
        workItemId: "same-history-id",
        runId: "run-before-admission-ledger",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      latestRunId: "run-before-admission-ledger",
    });
    await expect(getTask(repoPath, "same-history-id")).resolves.toMatchObject({
      status: "completed",
      latestRunId: "run-before-admission-ledger",
    });
    await expect(getWorkItem(repoPath, "same-history-id")).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("rejects an eligibility snapshot when a dependency changes before admission", async () => {
    const repoPath = await createRepo();
    const upstream = await createWorkItem(
      repoPath,
      {
        title: "Upstream",
        workItemType: "autofarm.site",
        flowPath: "flows/generic.json",
        inputs: {},
      },
      { createId: () => "upstream" },
    );
    const downstream = await createWorkItem(
      repoPath,
      {
        title: "Downstream",
        workItemType: "autofarm.site",
        flowPath: "flows/generic.json",
        inputs: {},
        dependsOn: [upstream.id],
      },
      { createId: () => "downstream" },
    );
    const snapshot = await getWorkItemSnapshot(repoPath, downstream.id);
    const version = {
      ...snapshot.version,
      dependencyGuards: workItemDependencyGuards(downstream, [
        downstream,
        upstream,
      ]),
    };
    await updateWorkItem(repoPath, upstream.id, { status: "completed" });

    await expect(
      admitWorkItemRun({
        repoPath,
        candidate: { workItem: snapshot.record, version },
        runInput: {
          repoPath,
          flowPath: downstream.flowPath,
          inputs: downstream.inputs,
          workItemId: downstream.id,
          workItemType: downstream.workItemType,
        },
        createRunId: () => "run-stale-dependency",
      }),
    ).resolves.toMatchObject({
      decision: "conflict",
      reason: "stale-dependency",
      changedWorkItemIds: ["upstream"],
    });
    const admissions = new RunAdmissionStore(
      join(repoPath, ".nitely", "run-admissions.db"),
    );
    try {
      expect(admissions.get("run-stale-dependency")).toBeUndefined();
    } finally {
      admissions.close();
    }
  });

  it("reconciles a terminal Run event left behind before ledger settlement", async () => {
    const repoPath = await createRepo();
    const record = await createWorkItem(
      repoPath,
      {
        title: "Crash reconciliation",
        workItemType: "autofarm.site",
        flowPath: "flows/generic.json",
        inputs: {},
      },
      { createId: () => "crash-reconciliation" },
    );
    const snapshot = await getWorkItemSnapshot(repoPath, record.id);
    const admission = await admitWorkItemRun({
      repoPath,
      candidate: { workItem: snapshot.record, version: snapshot.version },
      runInput: {
        repoPath,
        flowPath: record.flowPath,
        inputs: record.inputs,
        workItemId: record.id,
        workItemType: record.workItemType,
      },
      createRunId: () => "run-crash-reconciliation",
    });
    expect(admission.decision).toBe("admitted");
    const events = new EventStore(eventStorePath(repoPath));
    try {
      events.append({
        runId: "run-crash-reconciliation",
        type: "run.completed",
        payload: {},
      });
    } finally {
      events.close();
    }

    await expect(
      reconcileTerminalWorkItemRun({
        repoPath,
        workItemId: record.id,
        runId: "run-crash-reconciliation",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      latestRunId: "run-crash-reconciliation",
    });
    const admissions = new RunAdmissionStore(
      join(repoPath, ".nitely", "run-admissions.db"),
    );
    try {
      expect(admissions.get("run-crash-reconciliation")).toMatchObject({
        state: "settled",
      });
    } finally {
      admissions.close();
    }
  });

  it("allows a rejected candidate claim to be retried without a phantom event", async () => {
    const repoPath = await createRepo();
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const store = new RunAdmissionStore(
      join(repoPath, ".nitely", "run-admissions.db"),
    );
    const runInput = {
      repoPath,
      flowPath: "flows/generic.json",
      inputs: {},
      workItemId: "retryable",
      workItemType: "autofarm.site",
    };
    try {
      expect(
        store.claim({
          runId: "run-rejected",
          workItemId: "retryable",
          candidateFingerprint: "candidate-a",
          candidateVersion: {
            store: "generic",
            fingerprint: "candidate-a",
          },
          state: "active",
          admittedAt: "2026-07-15T00:00:00.000Z",
          branchName: "nitely/run-rejected",
          runInput,
          storeKind: "generic",
        }).claimed,
      ).toBe(true);
      expect(
        store.reject(
          "run-rejected",
          "candidate changed",
          "2026-07-15T00:00:01.000Z",
        ),
      ).toBe(true);
      expect(
        store.claim({
          runId: "run-retry",
          workItemId: "retryable",
          candidateFingerprint: "candidate-a",
          candidateVersion: {
            store: "generic",
            fingerprint: "candidate-a",
          },
          state: "active",
          admittedAt: "2026-07-15T00:00:02.000Z",
          branchName: "nitely/run-retry",
          runInput,
          storeKind: "generic",
        }),
      ).toMatchObject({ claimed: true });
    } finally {
      store.close();
    }
    const events = new EventStore(eventStorePath(repoPath));
    try {
      expect(events.list("run-rejected")).toEqual([]);
    } finally {
      events.close();
    }
  });

  it("rejects a claimed Run when initialization fails and lets the candidate retry", async () => {
    const repoPath = await createRepo();
    const record = await createWorkItem(
      repoPath,
      {
        title: "Retry failed initialization",
        workItemType: "autofarm.site",
        flowPath: "flows/generic.json",
        inputs: {},
      },
      { createId: () => "retry-initialization" },
    );
    const snapshot = await getWorkItemSnapshot(repoPath, record.id);
    const runInput = {
      repoPath,
      flowPath: record.flowPath,
      inputs: record.inputs,
      workItemId: record.id,
      workItemType: record.workItemType,
    };
    const eventsPath = eventStorePath(repoPath);
    await mkdir(eventsPath, { recursive: true });

    await expect(
      admitWorkItemRun({
        repoPath,
        candidate: { workItem: snapshot.record, version: snapshot.version },
        runInput,
        createRunId: () => "run-initialization-failed",
      }),
    ).rejects.toThrow();

    const admissions = new RunAdmissionStore(
      join(repoPath, ".nitely", "run-admissions.db"),
    );
    try {
      expect(admissions.get("run-initialization-failed")).toMatchObject({
        state: "rejected",
      });
      expect(admissions.activeForWorkItem(record.id)).toBeUndefined();
    } finally {
      admissions.close();
    }
    const afterInitializationFailure = await getWorkItem(repoPath, record.id);
    expect(afterInitializationFailure).toMatchObject({ status: "ready" });
    expect(afterInitializationFailure).not.toHaveProperty("latestRunId");

    await rm(eventsPath, { recursive: true, force: true });
    await expect(
      admitWorkItemRun({
        repoPath,
        candidate: { workItem: snapshot.record, version: snapshot.version },
        runInput,
        createRunId: () => "run-initialization-retry",
      }),
    ).resolves.toMatchObject({ decision: "admitted" });
  });

  it("rejects a claimed Run when projection fails and records a terminal event", async () => {
    const repoPath = await createRepo();
    const record = await createWorkItem(
      repoPath,
      {
        title: "Projection failure",
        workItemType: "autofarm.site",
        flowPath: "flows/generic.json",
        inputs: {},
      },
      { createId: () => "projection-failure" },
    );
    const snapshot = await getWorkItemSnapshot(repoPath, record.id);
    const runInput = {
      repoPath,
      flowPath: record.flowPath,
      inputs: record.inputs,
      workItemId: record.id,
      workItemType: record.workItemType,
    };

    await expect(
      admitWorkItemRun(
        {
          repoPath,
          candidate: { workItem: snapshot.record, version: snapshot.version },
          runInput,
          createRunId: () => "run-projection-failed",
        },
        {
          beforeProjection: async () => {
            throw new Error("injected projection failure");
          },
        },
      ),
    ).rejects.toThrow("injected projection failure");

    const admissions = new RunAdmissionStore(
      join(repoPath, ".nitely", "run-admissions.db"),
    );
    try {
      expect(admissions.get("run-projection-failed")).toMatchObject({
        state: "rejected",
      });
      expect(admissions.activeForWorkItem(record.id)).toBeUndefined();
    } finally {
      admissions.close();
    }
    const events = new EventStore(eventStorePath(repoPath));
    try {
      expect(events.list("run-projection-failed").map((event) => event.type)).toEqual([
        "run.admitted",
        "run.failed",
      ]);
    } finally {
      events.close();
    }
    const afterProjectionFailure = await getWorkItem(repoPath, record.id);
    expect(afterProjectionFailure).toMatchObject({ status: "ready" });
    expect(afterProjectionFailure).not.toHaveProperty("latestRunId");
    await expect(
      admitWorkItemRun({
        repoPath,
        candidate: { workItem: snapshot.record, version: snapshot.version },
        runInput,
        createRunId: () => "run-projection-retry",
      }),
    ).resolves.toMatchObject({ decision: "admitted" });
  });

  it("preserves the durable owner when initialization fails after projection", async () => {
    const repoPath = await createRepo();
    const record = await createWorkItem(
      repoPath,
      {
        title: "Post-projection failure",
        workItemType: "autofarm.site",
        flowPath: "flows/generic.json",
        inputs: {},
      },
      { createId: () => "post-projection-failure" },
    );
    const snapshot = await getWorkItemSnapshot(repoPath, record.id);
    const runInput = {
      repoPath,
      flowPath: record.flowPath,
      inputs: record.inputs,
      workItemId: record.id,
      workItemType: record.workItemType,
    };

    await expect(
      admitWorkItemRun(
        {
          repoPath,
          candidate: { workItem: snapshot.record, version: snapshot.version },
          runInput,
          createRunId: () => "run-post-projection-failure",
        },
        {
          afterWorkItemProjection: async () => {
            throw new Error("injected post-projection failure");
          },
        },
      ),
    ).rejects.toThrow("injected post-projection failure");

    await expect(getWorkItem(repoPath, record.id)).resolves.toMatchObject({
      status: "running",
      latestRunId: "run-post-projection-failure",
    });
    const admissions = new RunAdmissionStore(
      join(repoPath, ".nitely", "run-admissions.db"),
    );
    try {
      expect(admissions.get("run-post-projection-failure")).toMatchObject({
        state: "active",
        initializationToken: expect.any(String),
      });
      expect(
        admissions.get("run-post-projection-failure")?.projectedAt,
      ).toBeUndefined();
    } finally {
      admissions.close();
    }
    const events = new EventStore(eventStorePath(repoPath));
    try {
      expect(events.list("run-post-projection-failure").map((event) => event.type))
        .toEqual(["run.admitted"]);
    } finally {
      events.close();
    }
    await expect(
      settleWorkItemRun({
        repoPath,
        workItemId: record.id,
        runId: "run-post-projection-failure",
        status: "failed",
      }),
    ).resolves.toMatchObject({
      settled: false,
      reason: "admission-in-progress",
    });
  });

  it("does not settle a Run before its admission projection is durable", async () => {
    const repoPath = await createRepo();
    const record = await createWorkItem(
      repoPath,
      {
        title: "Admission projection gate",
        workItemType: "autofarm.site",
        flowPath: "flows/generic.json",
        inputs: {},
      },
      { createId: () => "admission-projection-gate" },
    );
    const snapshot = await getWorkItemSnapshot(repoPath, record.id);
    const runInput = {
      repoPath,
      flowPath: record.flowPath,
      inputs: record.inputs,
      workItemId: record.id,
      workItemType: record.workItemType,
    };
    let releaseProjection!: () => void;
    const projectionGate = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    let reportAdmissionStarted!: () => void;
    const admissionStarted = new Promise<void>((resolve) => {
      reportAdmissionStarted = resolve;
    });
    const admission = admitWorkItemRun(
      {
        repoPath,
        candidate: { workItem: snapshot.record, version: snapshot.version },
        runInput,
        createRunId: () => "run-admission-projection-gate",
      },
      {
        beforeProjection: async () => {
          reportAdmissionStarted();
          await projectionGate;
        },
      },
    );
    await admissionStarted;

    await expect(
      settleWorkItemRun({
        repoPath,
        workItemId: record.id,
        runId: "run-admission-projection-gate",
        status: "completed",
      }),
    ).resolves.toMatchObject({
      settled: false,
      reason: "admission-in-progress",
      workItem: { status: "ready" },
    });
    const admissions = new RunAdmissionStore(
      join(repoPath, ".nitely", "run-admissions.db"),
    );
    try {
      expect(admissions.get("run-admission-projection-gate")).toMatchObject({
        state: "active",
      });
      expect(
        admissions.get("run-admission-projection-gate")?.projectedAt,
      ).toBeUndefined();
    } finally {
      admissions.close();
    }

    releaseProjection();
    await expect(admission).resolves.toMatchObject({ decision: "admitted" });
    await expect(
      settleWorkItemRun({
        repoPath,
        workItemId: record.id,
        runId: "run-admission-projection-gate",
        status: "completed",
      }),
    ).resolves.toMatchObject({ settled: true });
  });

  it("does not settle between Work item projection and admission completion", async () => {
    const repoPath = await createRepo();
    const record = await createWorkItem(
      repoPath,
      {
        title: "Admission initialization owner",
        workItemType: "autofarm.site",
        flowPath: "flows/generic.json",
        inputs: {},
      },
      { createId: () => "admission-initialization-owner" },
    );
    const snapshot = await getWorkItemSnapshot(repoPath, record.id);
    let releaseAdmission!: () => void;
    const admissionGate = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let reportProjectionPersisted!: () => void;
    const projectionPersisted = new Promise<void>((resolve) => {
      reportProjectionPersisted = resolve;
    });
    const admission = admitWorkItemRun(
      {
        repoPath,
        candidate: { workItem: snapshot.record, version: snapshot.version },
        runInput: {
          repoPath,
          flowPath: record.flowPath,
          inputs: record.inputs,
          workItemId: record.id,
          workItemType: record.workItemType,
        },
        createRunId: () => "run-admission-initialization-owner",
      },
      {
        afterWorkItemProjection: async () => {
          reportProjectionPersisted();
          await admissionGate;
        },
      },
    );
    await projectionPersisted;
    await expect(getWorkItem(repoPath, record.id)).resolves.toMatchObject({
      status: "running",
      latestRunId: "run-admission-initialization-owner",
    });
    await expect(
      settleWorkItemRun({
        repoPath,
        workItemId: record.id,
        runId: "run-admission-initialization-owner",
        status: "failed",
      }),
    ).resolves.toMatchObject({
      settled: false,
      reason: "admission-in-progress",
    });

    releaseAdmission();
    await expect(admission).resolves.toMatchObject({
      decision: "admitted",
      workItem: { status: "running" },
    });
    await expect(
      settleWorkItemRun({
        repoPath,
        workItemId: record.id,
        runId: "run-admission-initialization-owner",
        status: "completed",
      }),
    ).resolves.toMatchObject({ settled: true });
  });

  it("recovers a stale settlement only after its terminal projection is durable", async () => {
    const repoPath = await createRepo();
    const record = await createWorkItem(
      repoPath,
      {
        title: "Recover projected settlement",
        workItemType: "autofarm.site",
        flowPath: "flows/generic.json",
        inputs: {},
      },
      { createId: () => "recover-projected-settlement" },
    );
    const snapshot = await getWorkItemSnapshot(repoPath, record.id);
    await expect(
      admitWorkItemRun({
        repoPath,
        candidate: { workItem: snapshot.record, version: snapshot.version },
        runInput: {
          repoPath,
          flowPath: record.flowPath,
          inputs: record.inputs,
          workItemId: record.id,
          workItemType: record.workItemType,
        },
        createRunId: () => "run-recover-projected-settlement",
      }),
    ).resolves.toMatchObject({ decision: "admitted" });

    const admissionsPath = join(repoPath, ".nitely", "run-admissions.db");
    const crashedOwner = new RunAdmissionStore(admissionsPath);
    try {
      expect(
        crashedOwner.beginSettlement({
          runId: "run-recover-projected-settlement",
          token: "crashed-settlement-owner",
          startedAt: "2000-01-01T00:00:00.000Z",
          status: "completed",
          changeRequestUrl: "https://example.test/pull/1",
        }),
      ).toBe(true);
    } finally {
      crashedOwner.close();
    }

    let projectionAttempts = 0;
    const recoveryDependencies = {
      beforeProjection: async () => {
        projectionAttempts += 1;
      },
    };
    await expect(
      settleWorkItemRun(
        {
          repoPath,
          workItemId: record.id,
          runId: "run-recover-projected-settlement",
          status: "completed",
          changeRequestUrl: "https://example.test/pull/1",
          now: () => new Date("2026-07-15T00:00:00.000Z"),
        },
        recoveryDependencies,
      ),
    ).resolves.toMatchObject({
      settled: false,
      reason: "settlement-in-progress",
      workItem: { status: "running" },
    });
    expect(projectionAttempts).toBe(0);

    await updateWorkItem(repoPath, record.id, {
      status: "completed",
      latestRunId: "run-recover-projected-settlement",
      changeRequestUrl: "https://example.test/pull/1",
    });
    await expect(
      settleWorkItemRun(
        {
          repoPath,
          workItemId: record.id,
          runId: "run-recover-projected-settlement",
          status: "completed",
          changeRequestUrl: "https://example.test/pull/1",
          now: () => new Date("2000-01-01T00:00:10.000Z"),
        },
        recoveryDependencies,
      ),
    ).resolves.toMatchObject({
      settled: false,
      reason: "settlement-in-progress",
    });
    await expect(
      settleWorkItemRun(
        {
          repoPath,
          workItemId: record.id,
          runId: "run-recover-projected-settlement",
          status: "failed",
          changeRequestUrl: "https://example.test/pull/1",
          now: () => new Date("2026-07-15T00:00:01.000Z"),
        },
        recoveryDependencies,
      ),
    ).resolves.toMatchObject({
      settled: false,
      reason: "settlement-in-progress",
    });
    await expect(
      settleWorkItemRun(
        {
          repoPath,
          workItemId: record.id,
          runId: "run-recover-projected-settlement",
          status: "completed",
          changeRequestUrl: "https://example.test/pull/1",
          now: () => new Date("2026-07-15T00:00:02.000Z"),
        },
        recoveryDependencies,
      ),
    ).resolves.toMatchObject({
      settled: true,
      workItem: {
        status: "completed",
        latestRunId: "run-recover-projected-settlement",
      },
    });
    expect(projectionAttempts).toBe(0);

    const recovered = new RunAdmissionStore(admissionsPath);
    try {
      expect(recovered.get("run-recover-projected-settlement")).toMatchObject({
        state: "settled",
        settlementStartedAt: "2000-01-01T00:00:00.000Z",
        settlementStatus: "completed",
      });
      expect(
        recovered.get("run-recover-projected-settlement")?.settlementToken,
      ).toBeUndefined();
    } finally {
      recovered.close();
    }
  });

  it("preserves terminal intent when ledger completion fails after projection", async () => {
    const repoPath = await createRepo();
    const record = await createWorkItem(
      repoPath,
      {
        title: "Post-settlement projection failure",
        workItemType: "autofarm.site",
        flowPath: "flows/generic.json",
        inputs: {},
      },
      { createId: () => "post-settlement-projection-failure" },
    );
    const snapshot = await getWorkItemSnapshot(repoPath, record.id);
    await expect(
      admitWorkItemRun({
        repoPath,
        candidate: { workItem: snapshot.record, version: snapshot.version },
        runInput: {
          repoPath,
          flowPath: record.flowPath,
          inputs: record.inputs,
          workItemId: record.id,
          workItemType: record.workItemType,
        },
        createRunId: () => "run-post-settlement-projection-failure",
      }),
    ).resolves.toMatchObject({ decision: "admitted" });

    await expect(
      settleWorkItemRun(
        {
          repoPath,
          workItemId: record.id,
          runId: "run-post-settlement-projection-failure",
          status: "completed",
          now: () => new Date("2026-07-15T00:00:00.000Z"),
        },
        {
          afterWorkItemProjection: async () => {
            throw new Error("injected ledger completion failure");
          },
        },
      ),
    ).rejects.toThrow("injected ledger completion failure");
    await expect(getWorkItem(repoPath, record.id)).resolves.toMatchObject({
      status: "completed",
      latestRunId: "run-post-settlement-projection-failure",
    });
    const admissionsPath = join(repoPath, ".nitely", "run-admissions.db");
    const pending = new RunAdmissionStore(admissionsPath);
    try {
      expect(
        pending.get("run-post-settlement-projection-failure"),
      ).toMatchObject({
        state: "active",
        settlementStatus: "completed",
        settlementToken: expect.any(String),
      });
    } finally {
      pending.close();
    }

    await expect(
      settleWorkItemRun({
        repoPath,
        workItemId: record.id,
        runId: "run-post-settlement-projection-failure",
        status: "failed",
        now: () => new Date("2026-07-15T00:01:00.000Z"),
      }),
    ).resolves.toMatchObject({
      settled: false,
      reason: "settlement-in-progress",
    });
    const next = await getWorkItemSnapshot(repoPath, record.id);
    await expect(
      admitWorkItemRun({
        repoPath,
        candidate: { workItem: next.record, version: next.version },
        runInput: {
          repoPath,
          flowPath: record.flowPath,
          inputs: record.inputs,
          workItemId: record.id,
          workItemType: record.workItemType,
        },
        createRunId: () => "run-after-recovered-settlement",
        now: () => new Date("2026-07-15T00:01:01.000Z"),
      }),
    ).resolves.toMatchObject({
      decision: "admitted",
      runId: "run-after-recovered-settlement",
    });
    const recovered = new RunAdmissionStore(admissionsPath);
    try {
      expect(
        recovered.get("run-post-settlement-projection-failure"),
      ).toMatchObject({
        state: "settled",
        settlementStatus: "completed",
      });
      expect(recovered.get("run-after-recovered-settlement")).toMatchObject({
        state: "active",
      });
    } finally {
      recovered.close();
    }
    await expect(
      settleWorkItemRun({
        repoPath,
        workItemId: record.id,
        runId: "run-after-recovered-settlement",
        status: "completed",
      }),
    ).resolves.toMatchObject({ settled: true });
  });

  it("does not recover a stale settlement solely from supersession", async () => {
    const repoPath = await createRepo();
    const record = await createWorkItem(
      repoPath,
      {
        title: "Recover superseded settlement",
        workItemType: "autofarm.site",
        flowPath: "flows/generic.json",
        inputs: {},
      },
      { createId: () => "recover-superseded-settlement" },
    );
    const snapshot = await getWorkItemSnapshot(repoPath, record.id);
    await expect(
      admitWorkItemRun({
        repoPath,
        candidate: { workItem: snapshot.record, version: snapshot.version },
        runInput: {
          repoPath,
          flowPath: record.flowPath,
          inputs: record.inputs,
          workItemId: record.id,
          workItemType: record.workItemType,
        },
        createRunId: () => "run-recover-superseded-settlement",
      }),
    ).resolves.toMatchObject({ decision: "admitted" });

    const admissionsPath = join(repoPath, ".nitely", "run-admissions.db");
    const crashedOwner = new RunAdmissionStore(admissionsPath);
    try {
      expect(
        crashedOwner.beginSettlement({
          runId: "run-recover-superseded-settlement",
          token: "crashed-superseded-owner",
          startedAt: "2000-01-01T00:00:00.000Z",
          status: "completed",
        }),
      ).toBe(true);
    } finally {
      crashedOwner.close();
    }
    await updateWorkItem(repoPath, record.id, {
      status: "running",
      latestRunId: "a-newer-run",
    });

    let projectionAttempts = 0;
    await expect(
      settleWorkItemRun(
        {
          repoPath,
          workItemId: record.id,
          runId: "run-recover-superseded-settlement",
          status: "failed",
          now: () => new Date("2026-07-15T00:00:00.000Z"),
        },
        {
          beforeProjection: async () => {
            projectionAttempts += 1;
          },
        },
      ),
    ).resolves.toMatchObject({
      settled: false,
      reason: "settlement-in-progress",
      workItem: { latestRunId: "a-newer-run", status: "running" },
    });
    expect(projectionAttempts).toBe(0);

    const recovered = new RunAdmissionStore(admissionsPath);
    try {
      expect(recovered.get("run-recover-superseded-settlement")).toMatchObject({
        state: "active",
        settlementToken: "crashed-superseded-owner",
      });
    } finally {
      recovered.close();
    }
  });

  it("migrates an old active admission and clears an intent-less token", async () => {
    const repoPath = await createRepo();
    const record = await createWorkItem(
      repoPath,
      {
        title: "Legacy admission schema",
        workItemType: "autofarm.site",
        flowPath: "flows/generic.json",
        inputs: {},
      },
      { createId: () => "legacy-admission-schema" },
    );
    await updateWorkItem(repoPath, record.id, {
      status: "running",
      latestRunId: "run-legacy-admission-schema",
    });
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const admissionsPath = join(repoPath, ".nitely", "run-admissions.db");
    const legacy = new DatabaseSync(admissionsPath);
    try {
      legacy.exec(`
        CREATE TABLE run_admissions (
          run_id TEXT PRIMARY KEY,
          work_item_id TEXT NOT NULL,
          candidate_fingerprint TEXT NOT NULL,
          candidate_version_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('active', 'settled', 'rejected')),
          admitted_at TEXT NOT NULL,
          settled_at TEXT,
          settlement_token TEXT,
          rejection_reason TEXT,
          branch_name TEXT NOT NULL,
          run_input_json TEXT NOT NULL,
          store_kind TEXT NOT NULL CHECK (store_kind IN ('generic', 'legacy-dev-pr')),
          legacy_state_json TEXT
        ) STRICT;
      `);
      legacy.prepare(`
        INSERT INTO run_admissions (
          run_id,
          work_item_id,
          candidate_fingerprint,
          candidate_version_json,
          state,
          admitted_at,
          settlement_token,
          branch_name,
          run_input_json,
          store_kind
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, 'generic')
      `).run(
        "run-legacy-admission-schema",
        record.id,
        "legacy-candidate",
        JSON.stringify({ store: "generic", fingerprint: "legacy-candidate" }),
        "2026-07-14T00:00:00.000Z",
        "legacy-intent-less-owner",
        "nitely/run-legacy-admission-schema",
        JSON.stringify({
          repoPath,
          flowPath: record.flowPath,
          inputs: record.inputs,
          workItemId: record.id,
          workItemType: record.workItemType,
        }),
      );
    } finally {
      legacy.close();
    }

    const migrated = new RunAdmissionStore(admissionsPath);
    try {
      expect(migrated.get("run-legacy-admission-schema")).toMatchObject({
        state: "active",
      });
      expect(
        migrated.get("run-legacy-admission-schema")?.settlementToken,
      ).toBeUndefined();
    } finally {
      migrated.close();
    }
    await expect(
      settleWorkItemRun({
        repoPath,
        workItemId: record.id,
        runId: "run-legacy-admission-schema",
        status: "completed",
      }),
    ).resolves.toMatchObject({ settled: true });
  });

  it("keeps settlement ownership until its Work item projection is durable", async () => {
    const repoPath = await createRepo();
    const record = await createWorkItem(
      repoPath,
      {
        title: "Settlement owner",
        workItemType: "autofarm.site",
        flowPath: "flows/generic.json",
        inputs: {},
      },
      { createId: () => "settlement-owner" },
    );
    const initial = await getWorkItemSnapshot(repoPath, record.id);
    const runInput = {
      repoPath,
      flowPath: record.flowPath,
      inputs: record.inputs,
      workItemId: record.id,
      workItemType: record.workItemType,
    };
    await expect(
      admitWorkItemRun({
        repoPath,
        candidate: { workItem: initial.record, version: initial.version },
        runInput,
        createRunId: () => "run-settlement-owner",
      }),
    ).resolves.toMatchObject({ decision: "admitted" });

    let releaseProjection!: () => void;
    const projectionGate = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    let reportSettlementStarted!: () => void;
    const settlementStarted = new Promise<void>((resolve) => {
      reportSettlementStarted = resolve;
    });
    const settlement = settleWorkItemRun(
      {
        repoPath,
        workItemId: record.id,
        runId: "run-settlement-owner",
        status: "completed",
      },
      {
        beforeProjection: async () => {
          reportSettlementStarted();
          await projectionGate;
        },
      },
    );
    await settlementStarted;
    const duringSettlement = await getWorkItemSnapshot(repoPath, record.id);
    await expect(
      admitWorkItemRun({
        repoPath,
        candidate: {
          workItem: duringSettlement.record,
          version: duringSettlement.version,
        },
        runInput,
        createRunId: () => "run-too-early",
      }),
    ).resolves.toMatchObject({
      decision: "conflict",
      reason: "active-run",
      runId: "run-settlement-owner",
    });

    releaseProjection();
    await expect(settlement).resolves.toMatchObject({ settled: true });
    const next = await getWorkItemSnapshot(repoPath, record.id);
    await expect(
      admitWorkItemRun({
        repoPath,
        candidate: { workItem: next.record, version: next.version },
        runInput,
        createRunId: () => "run-after-settlement",
      }),
    ).resolves.toMatchObject({ decision: "admitted" });
    await expect(getWorkItem(repoPath, record.id)).resolves.toMatchObject({
      status: "running",
      latestRunId: "run-after-settlement",
    });
  });
});
