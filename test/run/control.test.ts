import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import { admitWorkItemRun } from "../../src/run/admission.js";
import {
  cancelRun,
  claimRunContinuation,
  decideRunApproval,
  latestRunEventSequence,
  recordRunnerCompletion,
  recordRunnerFailure,
  recordRunResumeFailure,
  registerActiveRun,
  requireResumableRun,
  RunCancellationRefusedError,
  RunResumeRefusedError,
} from "../../src/run/control.js";
import { eventStorePath, projectRun } from "../../src/run/project.js";
import {
  createWorkItem,
  getWorkItem,
  getWorkItemSnapshot,
} from "../../src/work-items/store.js";

async function createRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-run-control-"));
  await mkdir(join(repoPath, "flows"), { recursive: true });
  await writeFile(join(repoPath, "flows", "generic.json"), "{}\n", "utf8");
  return repoPath;
}

async function admittedRun(repoPath: string, runId: string): Promise<string> {
  const created = await createWorkItem(
    repoPath,
    { title: "Publish", workItemType: "autofarm.site", flowPath: "flows/generic.json", inputs: {} },
    { createId: () => "site" },
  );
  const candidate = await getWorkItemSnapshot(repoPath, created.id);
  const admission = await admitWorkItemRun({
    repoPath,
    candidate: { workItem: candidate.record, version: candidate.version },
    runInput: { repoPath, flowPath: created.flowPath, inputs: {}, workItemId: created.id },
    createRunId: () => runId,
  });
  expect(admission.decision).toBe("admitted");
  appendEvents(repoPath, [
    { runId, type: "run.created", payload: { flowName: "generic" } },
    { runId, stageId: "build", attempt: 1, type: "stage.started", payload: { type: "command" } },
  ]);
  return created.id;
}

function appendEvents(
  repoPath: string,
  events: Parameters<EventStore["append"]>[0][],
): void {
  const store = new EventStore(eventStorePath(repoPath));
  try {
    for (const event of events) store.append(event);
  } finally {
    store.close();
  }
}

function runEvents(repoPath: string, runId: string) {
  const store = new EventStore(eventStorePath(repoPath));
  try {
    return store.list(runId);
  } finally {
    store.close();
  }
}

const cancel = { actor: "human:test", reason: "stop", source: "cli" };

describe("Run control", () => {
  it("refuses to cancel a missing or already terminal Run", async () => {
    const repoPath = await createRepo();
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    await expect(cancelRun({ repoPath, runId: "run-missing", ...cancel }))
      .rejects.toThrow(new RunCancellationRefusedError("run was not found"));

    appendEvents(repoPath, [
      { runId: "run-done", type: "run.created", payload: {} },
      { runId: "run-done", type: "run.completed", payload: {} },
    ]);
    await expect(
      cancelRun({ repoPath, runId: "run-done", subject: "linked run", ...cancel }),
    ).rejects.toThrow(new RunCancellationRefusedError("linked run is already completed"));
    expect(runEvents(repoPath, "run-done").map((event) => event.type))
      .not.toContain("run.cancelled");
  });

  it("signals the active runner, records its stage, and settles the Work item", async () => {
    const repoPath = await createRepo();
    const workItemId = await admittedRun(repoPath, "run-active");
    const active = registerActiveRun({ repoPath, runId: "run-active" });
    active.control.onStageChange?.({ stageId: "build", attempt: 1 });

    await cancelRun({ repoPath, runId: "run-active", ...cancel });
    active.finish();

    expect(active.control.signal.aborted).toBe(true);
    expect(active.control.getRequest?.()).toMatchObject({ actor: "human:test", reason: "stop" });
    const cancelled = runEvents(repoPath, "run-active").find((event) => event.type === "run.cancelled");
    expect(cancelled).toMatchObject({
      stageId: "build",
      attempt: 1,
      payload: { affectedStage: "build", cleanup: { result: "abort-signal-dispatched" } },
    });
    expect(projectRun(runEvents(repoPath, "run-active")).status).toBe("cancelled");
    await expect(getWorkItem(repoPath, workItemId)).resolves.toMatchObject({
      status: "failed",
      latestRunId: "run-active",
    });
  });

  it("records a cancel for a Run no runner in this process owns", async () => {
    const repoPath = await createRepo();
    await admittedRun(repoPath, "run-idle");

    await cancelRun({ repoPath, runId: "run-idle", ...cancel });

    expect(runEvents(repoPath, "run-idle").find((event) => event.type === "run.cancelled"))
      .toMatchObject({ payload: { cleanup: { result: "no-active-process" } } });
  });

  it("hands the continuation claim to one owner until it is released", async () => {
    const repoPath = await createRepo();
    const release = await claimRunContinuation(repoPath, "run-claimed");
    expect(release).toBeDefined();
    await expect(claimRunContinuation(repoPath, "run-claimed")).resolves.toBeUndefined();

    release!();
    const next = await claimRunContinuation(repoPath, "run-claimed");
    expect(next).toBeDefined();
    next!();
  });

  it("records a runner's completion only while the Run is unsettled", async () => {
    const repoPath = await createRepo();
    await admittedRun(repoPath, "run-done");
    const result = { runId: "run-done", branchName: "nitely/run-done", worktreePath: repoPath };

    recordRunnerCompletion({ repoPath, result });
    recordRunnerCompletion({ repoPath, result });

    expect(
      runEvents(repoPath, "run-done").filter((event) => event.type === "run.completed"),
    ).toHaveLength(1);
  });

  it("records run.created first for a Work item Run that has no events", async () => {
    const repoPath = await createRepo();
    await mkdir(join(repoPath, ".nitely"), { recursive: true });

    recordRunnerCompletion({
      repoPath,
      result: { runId: "run-bare", branchName: "nitely/run-bare", worktreePath: repoPath },
      runInput: { repoPath, flowPath: "flows/generic.json", inputs: {}, workItemId: "site" },
    });

    expect(runEvents(repoPath, "run-bare").map((event) => event.type)).toEqual([
      "run.created",
      "run.completed",
    ]);
    expect(projectRun(runEvents(repoPath, "run-bare"))).toMatchObject({
      status: "completed",
      workItemId: "site",
    });
  });

  it("does not record a runner failure over a cancellation", async () => {
    const repoPath = await createRepo();
    await admittedRun(repoPath, "run-cancelled");
    await cancelRun({ repoPath, runId: "run-cancelled", ...cancel });

    const projection = recordRunnerFailure({
      repoPath,
      runId: "run-cancelled",
      error: new Error("runner stopped"),
    });

    expect(projection.status).toBe("cancelled");
    expect(
      runEvents(repoPath, "run-cancelled").some((event) => event.type === "run.failed"),
    ).toBe(false);
  });

  it("fails a resumed Run whose runner wrote no terminal event since it started", async () => {
    const repoPath = await createRepo();
    await admittedRun(repoPath, "run-resumed");
    appendEvents(repoPath, [
      { runId: "run-resumed", type: "run.blocked", payload: { reason: "approval_required", stageId: "build" } },
    ]);
    const afterSequence = latestRunEventSequence(repoPath, "run-resumed");

    const projection = recordRunnerFailure({
      repoPath,
      runId: "run-resumed",
      error: new Error("resume crashed"),
      afterSequence,
    });

    expect(projection.status).toBe("failed");
  });

  it("refuses to resume a Run that is not blocked or interrupted", async () => {
    const repoPath = await createRepo();
    await admittedRun(repoPath, "run-active");
    // The open attempt has no runner, so it counts as interrupted.
    expect(requireResumableRun(repoPath, "run-active").status).toBe("interrupted");

    appendEvents(repoPath, [{ runId: "run-active", type: "run.failed", payload: { error: "x" } }]);
    expect(() => requireResumableRun(repoPath, "run-active")).toThrow(RunResumeRefusedError);
  });

  it("does not record a resume failure on a cancelled Run", async () => {
    const repoPath = await createRepo();
    await admittedRun(repoPath, "run-stop");
    const failure = { repoPath, runId: "run-stop", message: "boom", actor: "human:test", source: "web" };

    expect(recordRunResumeFailure(failure)).toBe(true);
    expect(projectRun(runEvents(repoPath, "run-stop")).resumeFailure).toMatchObject({
      message: "boom",
      actor: "human:test",
    });
    await cancelRun({ repoPath, runId: "run-stop", ...cancel });
    expect(recordRunResumeFailure(failure)).toBe(false);
    expect(
      runEvents(repoPath, "run-stop").filter((event) => event.type === "run.resume.failed"),
    ).toHaveLength(1);
  });

  it("fails the Run and settles its Work item when an approval is denied", async () => {
    const repoPath = await createRepo();
    const workItemId = await admittedRun(repoPath, "run-gate");
    appendEvents(repoPath, [
      {
        runId: "run-gate",
        stageId: "build",
        attempt: 1,
        type: "approval.requested",
        payload: { approvalId: "gate-1", prompt: "ok?" },
      },
    ]);

    const approval = await decideRunApproval({
      repoPath,
      runId: "run-gate",
      approvalId: "gate-1",
      decision: "denied",
      actor: "human:test",
    });

    expect(approval.status).toBe("denied");
    expect(projectRun(runEvents(repoPath, "run-gate")).status).toBe("failed");
    expect((await getWorkItem(repoPath, workItemId)).status).not.toBe("running");
  });
});
