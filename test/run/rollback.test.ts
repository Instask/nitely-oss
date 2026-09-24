import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import {
  applyRollbackDecision,
  recordRollbackDecision,
} from "../../src/run/rollback.js";
import { eventStorePath } from "../../src/run/project.js";
import { buildRunTrace } from "../../src/run/trace.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function createRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-rollback-repo-"));
  await git(repoPath, ["init"]);
  await git(repoPath, ["config", "user.email", "nitely@example.test"]);
  await git(repoPath, ["config", "user.name", "Nitely Test"]);
  await writeFile(join(repoPath, "README.md"), "repo\n", "utf8");
  await git(repoPath, ["add", "README.md"]);
  await git(repoPath, ["commit", "-m", "initial"]);
  return repoPath;
}

async function createRunWorktree(
  repoPath: string,
  runId: string,
): Promise<string> {
  const runDirectory = join(repoPath, ".nitely", "runs", runId);
  const worktreePath = join(runDirectory, "worktree");
  await mkdir(runDirectory, { recursive: true });
  await git(repoPath, [
    "worktree",
    "add",
    "-b",
    `nitely/${runId}`,
    worktreePath,
    "HEAD",
  ]);
  return worktreePath;
}

function seedRollbackRun(input: {
  repoPath: string;
  runId: string;
  worktreePath?: string;
  branchHeadSha?: string;
  changeRequestUrl?: string;
  changeRequestTarget?: unknown;
}): void {
  const store = new EventStore(eventStorePath(input.repoPath));
  store.append({
    runId: input.runId,
    type: "run.created",
    createdAt: "2026-07-08T00:00:00.000Z",
    payload: {
      flowName: "flow",
      branchName: `nitely/${input.runId}`,
      baseBranch: "master",
    },
  });
  if (input.worktreePath) {
    store.append({
      runId: input.runId,
      type: "workspace.created",
      createdAt: "2026-07-08T00:00:01.000Z",
      payload: { worktreePath: input.worktreePath },
    });
  }
  store.append({
    runId: input.runId,
    type: "stage.started",
    stageId: "implement",
    attempt: 1,
    createdAt: "2026-07-08T00:00:02.000Z",
    payload: {
      type: "agent",
      ...(input.branchHeadSha ? { branchHeadSha: input.branchHeadSha } : {}),
    },
  });
  store.append({
    runId: input.runId,
    type: "stage.blocked",
    stageId: "implement",
    attempt: 1,
    createdAt: "2026-07-08T00:00:03.000Z",
    payload: { reason: "usage-limit" },
  });
  store.append({
    runId: input.runId,
    type: "run.blocked",
    createdAt: "2026-07-08T00:00:04.000Z",
    payload: { reason: "usage-limit" },
  });
  if (input.changeRequestTarget) {
    store.append({
      runId: input.runId,
      type: "change.target.resolved",
      createdAt: "2026-07-08T00:00:04.500Z",
      payload: input.changeRequestTarget,
    });
  }
  if (input.changeRequestUrl) {
    store.append({
      runId: input.runId,
      type: "change.published",
      createdAt: "2026-07-08T00:00:04.750Z",
      payload: {
        url: input.changeRequestUrl,
        changeRequest: {
          provider: "github",
          url: input.changeRequestUrl,
          number: 42,
          owner: "Instask",
          repository: "nitely",
          baseBranch: "master",
          headBranch: `nitely/${input.runId}`,
          draft: true,
        },
      },
    });
  }
  store.close();
}

describe("recordRollbackDecision", () => {
  it("appends a non-destructive rollback decision event for a checkpoint", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-rollback-"));
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    let store = new EventStore(eventStorePath(repoPath));
    store.append({
      runId: "run-rollback",
      type: "run.created",
      createdAt: "2026-07-08T00:00:00.000Z",
      payload: { flowName: "flow" },
    });
    store.append({
      runId: "run-rollback",
      type: "stage.started",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-07-08T00:00:01.000Z",
      payload: { type: "agent" },
    });
    store.append({
      runId: "run-rollback",
      type: "stage.blocked",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-07-08T00:00:02.000Z",
      payload: { reason: "usage-limit" },
    });
    store.append({
      runId: "run-rollback",
      type: "run.blocked",
      createdAt: "2026-07-08T00:00:03.000Z",
      payload: { reason: "usage-limit" },
    });
    store.close();

    const result = await recordRollbackDecision({
      repoPath,
      runId: "run-rollback",
      checkpointId: "stage-attempt:2",
      actor: "leo",
      reason: "Resume after quota reset.",
      worktreePolicy: "cleanup",
      branchPolicy: "reset-to-checkpoint",
      changePolicy: "new-pr",
      now: () => new Date("2026-07-08T00:00:04.000Z"),
    });

    expect(result.event).toMatchObject({
      runId: "run-rollback",
      stageId: "implement",
      attempt: 1,
      type: "rollback.recorded",
      createdAt: "2026-07-08T00:00:04.000Z",
      payload: {
        checkpointId: "stage-attempt:2",
        checkpointKind: "stage-attempt",
        checkpointEventSequence: 2,
        actor: "leo",
        reason: "Resume after quota reset.",
        mode: "record-only",
        nonDestructive: true,
        policy: {
          worktree: "cleanup",
          branch: "reset-to-checkpoint",
          change: "new-pr",
        },
      },
    });

    store = new EventStore(eventStorePath(repoPath));
    const events = store.list("run-rollback");
    store.close();
    expect(events.map((event) => event.type)).toEqual([
      "run.created",
      "stage.started",
      "stage.blocked",
      "run.blocked",
      "rollback.recorded",
    ]);
    const trace = buildRunTrace(events);
    expect(trace.checkpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "rollback-decision",
          eventType: "rollback.recorded",
          label: "Rollback decision: Stage implement attempt 1",
          stageId: "implement",
          attempt: 1,
          changes: expect.arrayContaining([
            "operator rollback decision is recorded for audit",
            "no worktree, branch, artifact, or pull request mutation is performed",
          ]),
        }),
      ]),
    );
  });

  it("applies cleanup policy only when branch and change policies are non-mutating", async () => {
    const repoPath = await createRepo();
    const runId = "run-rollback-apply";
    const worktreePath = await createRunWorktree(repoPath, runId);
    seedRollbackRun({ repoPath, runId, worktreePath });
    const decision = await recordRollbackDecision({
      repoPath,
      runId,
      checkpointId: "stage-attempt:3",
      worktreePolicy: "cleanup",
      branchPolicy: "preserve",
      changePolicy: "none",
      now: () => new Date("2026-07-08T00:00:05.000Z"),
    });

    const result = await applyRollbackDecision({
      repoPath,
      runId,
      decisionSequence: decision.event.sequence,
      now: () => new Date("2026-07-08T00:00:06.000Z"),
    });

    expect(result.event).toMatchObject({
      type: "rollback.applied",
      stageId: "implement",
      attempt: 1,
      payload: {
        decisionEventSequence: decision.event.sequence,
        application: {
          status: "applied",
          worktree: {
            policy: "cleanup",
            status: "removed",
            path: worktreePath,
          },
          branch: {
            policy: "preserve",
            status: "preserved",
            branchName: `nitely/${runId}`,
          },
          change: {
            policy: "none",
            status: "skipped",
          },
          failures: [],
          mutations: [`remove worktree ${worktreePath}`],
        },
      },
    });
    await expect(access(worktreePath)).rejects.toThrow();
    const store = new EventStore(eventStorePath(repoPath));
    const events = store.list(runId);
    store.close();
    expect(buildRunTrace(events).checkpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "rollback-decision",
          eventType: "rollback.applied",
          label: "Rollback policy applied",
        }),
      ]),
    );
  });

  it("fails closed without cleanup when branch reset policy cannot be proven safe", async () => {
    const repoPath = await createRepo();
    const runId = "run-rollback-apply-fail";
    const worktreePath = await createRunWorktree(repoPath, runId);
    seedRollbackRun({ repoPath, runId, worktreePath });
    const decision = await recordRollbackDecision({
      repoPath,
      runId,
      checkpointId: "stage-attempt:3",
      worktreePolicy: "cleanup",
      branchPolicy: "reset-to-checkpoint",
      changePolicy: "none",
      now: () => new Date("2026-07-08T00:00:05.000Z"),
    });

    const result = await applyRollbackDecision({
      repoPath,
      runId,
      decisionSequence: decision.event.sequence,
      now: () => new Date("2026-07-08T00:00:06.000Z"),
    });

    expect(result.event).toMatchObject({
      type: "rollback.apply_failed",
      payload: {
        application: {
          status: "failed",
          worktree: {
            policy: "cleanup",
            status: "blocked",
            path: worktreePath,
            reason: "not applied because rollback policy validation failed",
          },
          branch: {
            policy: "reset-to-checkpoint",
            status: "blocked",
            branchName: `nitely/${runId}`,
          },
          failures: [
            "checkpoint branch head is not recorded; no branch reset was performed",
          ],
          mutations: [],
        },
      },
    });
    await expect(access(worktreePath)).resolves.toBeUndefined();
  });

  it("resets the run branch to the checkpoint head when the policy is safe", async () => {
    const repoPath = await createRepo();
    const runId = "run-rollback-reset";
    const worktreePath = await createRunWorktree(repoPath, runId);
    const checkpointSha = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
    seedRollbackRun({ repoPath, runId, worktreePath, branchHeadSha: checkpointSha });
    await writeFile(join(worktreePath, "feature.txt"), "after checkpoint\n", "utf8");
    await git(worktreePath, ["add", "feature.txt"]);
    await git(worktreePath, ["commit", "-m", "after checkpoint"]);
    expect((await git(worktreePath, ["rev-parse", "HEAD"])).trim()).not.toBe(
      checkpointSha,
    );
    const decision = await recordRollbackDecision({
      repoPath,
      runId,
      checkpointId: "stage-attempt:3",
      worktreePolicy: "preserve",
      branchPolicy: "reset-to-checkpoint",
      changePolicy: "none",
      now: () => new Date("2026-07-08T00:00:05.000Z"),
    });

    const result = await applyRollbackDecision({
      repoPath,
      runId,
      decisionSequence: decision.event.sequence,
      now: () => new Date("2026-07-08T00:00:06.000Z"),
    });

    expect(result.event).toMatchObject({
      type: "rollback.applied",
      payload: {
        application: {
          status: "applied",
          worktree: {
            policy: "preserve",
            status: "preserved",
            path: worktreePath,
          },
          branch: {
            policy: "reset-to-checkpoint",
            status: "reset",
            branchName: `nitely/${runId}`,
            targetHeadSha: checkpointSha,
          },
          change: {
            policy: "none",
            status: "skipped",
          },
          failures: [],
          mutations: [`reset branch nitely/${runId} to ${checkpointSha}`],
        },
      },
    });
    await expect(access(worktreePath)).resolves.toBeUndefined();
    expect((await git(worktreePath, ["rev-parse", "HEAD"])).trim()).toBe(
      checkpointSha,
    );
  });

  it("fails closed when a branch reset is combined with worktree cleanup", async () => {
    const repoPath = await createRepo();
    const runId = "run-rollback-reset-cleanup";
    const worktreePath = await createRunWorktree(repoPath, runId);
    const checkpointSha = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
    seedRollbackRun({ repoPath, runId, worktreePath, branchHeadSha: checkpointSha });
    const decision = await recordRollbackDecision({
      repoPath,
      runId,
      checkpointId: "stage-attempt:3",
      worktreePolicy: "cleanup",
      branchPolicy: "reset-to-checkpoint",
      changePolicy: "none",
      now: () => new Date("2026-07-08T00:00:05.000Z"),
    });

    const result = await applyRollbackDecision({
      repoPath,
      runId,
      decisionSequence: decision.event.sequence,
      now: () => new Date("2026-07-08T00:00:06.000Z"),
    });

    expect(result.event).toMatchObject({
      type: "rollback.apply_failed",
      payload: {
        application: {
          status: "failed",
          worktree: {
            policy: "cleanup",
            status: "blocked",
            path: worktreePath,
            reason: "not applied because rollback policy validation failed",
          },
          branch: {
            policy: "reset-to-checkpoint",
            status: "blocked",
            branchName: `nitely/${runId}`,
            targetHeadSha: checkpointSha,
            reason:
              "branch reset with worktree cleanup is not atomic; no mutation was performed",
          },
          failures: [
            "branch reset with worktree cleanup is not atomic; no mutation was performed",
          ],
          mutations: [],
        },
      },
    });
    await expect(access(worktreePath)).resolves.toBeUndefined();
  });

  it("routes update-existing-pr through resumed change execution", async () => {
    const repoPath = await createRepo();
    const runId = "run-rollback-update-pr";
    const worktreePath = await createRunWorktree(repoPath, runId);
    seedRollbackRun({
      repoPath,
      runId,
      worktreePath,
      changeRequestUrl: "https://github.com/Instask/nitely/pull/42",
      changeRequestTarget: {
        provider: "github",
        target: {
          provider: "github",
          owner: "Instask",
          repository: "nitely",
          number: 42,
          url: "https://github.com/Instask/nitely/pull/42",
          baseBranch: "master",
          headBranch: `nitely/${runId}`,
          headSha: "a".repeat(40),
        },
      },
    });
    const decision = await recordRollbackDecision({
      repoPath,
      runId,
      checkpointId: "stage-attempt:3",
      worktreePolicy: "preserve",
      branchPolicy: "preserve",
      changePolicy: "update-existing-pr",
      now: () => new Date("2026-07-08T00:00:05.000Z"),
    });
    const resumeCalls: unknown[] = [];

    const result = await applyRollbackDecision({
      repoPath,
      runId,
      decisionSequence: decision.event.sequence,
      resumeRun: async (input) => {
        resumeCalls.push(input);
        return {
          runId: input.runId,
          branchName: `nitely/${input.runId}`,
          worktreePath,
          changeRequestUrl: "https://github.com/Instask/nitely/pull/42",
        };
      },
      now: () => new Date("2026-07-08T00:00:06.000Z"),
    });

    expect(resumeCalls).toEqual([
      {
        repoPath,
        runId,
        checkpointId: "stage-attempt:3",
      },
    ]);
    expect(result.event).toMatchObject({
      type: "rollback.applied",
      payload: {
        application: {
          status: "applied",
          worktree: { policy: "preserve", status: "preserved", path: worktreePath },
          branch: {
            policy: "preserve",
            status: "preserved",
            branchName: `nitely/${runId}`,
          },
          change: {
            policy: "update-existing-pr",
            status: "applied",
            changeRequestUrl: "https://github.com/Instask/nitely/pull/42",
            resume: {
              runId,
              checkpointId: "stage-attempt:3",
              changeRequestUrl: "https://github.com/Instask/nitely/pull/42",
            },
          },
          failures: [],
          mutations: [
            `resume run ${runId} from stage-attempt:3 for update-existing-pr`,
          ],
        },
      },
    });
    await expect(access(worktreePath)).resolves.toBeUndefined();
  });

  it("routes new-pr through resumed change execution and keeps planned status when approval pauses before PR creation", async () => {
    const repoPath = await createRepo();
    const runId = "run-rollback-new-pr";
    const worktreePath = await createRunWorktree(repoPath, runId);
    seedRollbackRun({ repoPath, runId, worktreePath });
    const decision = await recordRollbackDecision({
      repoPath,
      runId,
      checkpointId: "stage-attempt:3",
      worktreePolicy: "preserve",
      branchPolicy: "preserve",
      changePolicy: "new-pr",
      now: () => new Date("2026-07-08T00:00:05.000Z"),
    });

    const result = await applyRollbackDecision({
      repoPath,
      runId,
      decisionSequence: decision.event.sequence,
      resumeRun: async (input) => ({
        runId: input.runId,
        branchName: `nitely/${input.runId}`,
        worktreePath,
        status: "awaiting-approval",
        approvalId: "approval-1",
      }),
      now: () => new Date("2026-07-08T00:00:06.000Z"),
    });

    expect(result.event).toMatchObject({
      type: "rollback.applied",
      payload: {
        application: {
          status: "applied",
          change: {
            policy: "new-pr",
            status: "planned",
            resume: {
              runId,
              checkpointId: "stage-attempt:3",
              status: "awaiting-approval",
            },
          },
          failures: [],
          mutations: [`resume run ${runId} from stage-attempt:3 for new-pr`],
        },
      },
    });
    await expect(access(worktreePath)).resolves.toBeUndefined();
  });

  it("fails update-existing-pr before resume when no change request target exists", async () => {
    const repoPath = await createRepo();
    const runId = "run-rollback-update-missing-target";
    const worktreePath = await createRunWorktree(repoPath, runId);
    seedRollbackRun({ repoPath, runId, worktreePath });
    const decision = await recordRollbackDecision({
      repoPath,
      runId,
      checkpointId: "stage-attempt:3",
      worktreePolicy: "preserve",
      branchPolicy: "preserve",
      changePolicy: "update-existing-pr",
      now: () => new Date("2026-07-08T00:00:05.000Z"),
    });
    let resumeCalled = false;

    const result = await applyRollbackDecision({
      repoPath,
      runId,
      decisionSequence: decision.event.sequence,
      resumeRun: async () => {
        resumeCalled = true;
        throw new Error("must not resume");
      },
      now: () => new Date("2026-07-08T00:00:06.000Z"),
    });

    expect(resumeCalled).toBe(false);
    expect(result.event).toMatchObject({
      type: "rollback.apply_failed",
      payload: {
        application: {
          status: "failed",
          change: {
            policy: "update-existing-pr",
            status: "blocked",
            reason:
              "update-existing-pr requires an existing change request target; no resumed change execution was started",
          },
          failures: [
            "update-existing-pr requires an existing change request target; no resumed change execution was started",
          ],
          mutations: [],
        },
      },
    });
    await expect(access(worktreePath)).resolves.toBeUndefined();
  });

  it("fails closed without branch or PR mutation when resumed change execution fails", async () => {
    const repoPath = await createRepo();
    const runId = "run-rollback-resume-fails";
    const worktreePath = await createRunWorktree(repoPath, runId);
    const beforeHead = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
    seedRollbackRun({ repoPath, runId, worktreePath });
    const decision = await recordRollbackDecision({
      repoPath,
      runId,
      checkpointId: "stage-attempt:3",
      worktreePolicy: "preserve",
      branchPolicy: "preserve",
      changePolicy: "new-pr",
      now: () => new Date("2026-07-08T00:00:05.000Z"),
    });

    const result = await applyRollbackDecision({
      repoPath,
      runId,
      decisionSequence: decision.event.sequence,
      resumeRun: async () => {
        throw new Error("provider rejected update");
      },
      now: () => new Date("2026-07-08T00:00:06.000Z"),
    });

    expect(result.event).toMatchObject({
      type: "rollback.apply_failed",
      payload: {
        application: {
          status: "failed",
          change: {
            policy: "new-pr",
            status: "blocked",
            reason:
              "failed to route resumed change execution: provider rejected update",
          },
          failures: [
            "failed to route resumed change execution: provider rejected update",
          ],
          mutations: [],
        },
      },
    });
    await expect(access(worktreePath)).resolves.toBeUndefined();
    expect((await git(worktreePath, ["rev-parse", "HEAD"])).trim()).toBe(
      beforeHead,
    );
  });

  it("does not partially mutate worktree state when change-request policy validation fails", async () => {
    const repoPath = await createRepo();
    const runId = "run-rollback-no-partial-change";
    const worktreePath = await createRunWorktree(repoPath, runId);
    seedRollbackRun({ repoPath, runId, worktreePath });
    const decision = await recordRollbackDecision({
      repoPath,
      runId,
      checkpointId: "stage-attempt:3",
      worktreePolicy: "cleanup",
      branchPolicy: "preserve",
      changePolicy: "new-pr",
      now: () => new Date("2026-07-08T00:00:05.000Z"),
    });
    let resumeCalled = false;

    const result = await applyRollbackDecision({
      repoPath,
      runId,
      decisionSequence: decision.event.sequence,
      resumeRun: async () => {
        resumeCalled = true;
        throw new Error("must not resume");
      },
      now: () => new Date("2026-07-08T00:00:06.000Z"),
    });

    expect(resumeCalled).toBe(false);
    expect(result.event).toMatchObject({
      type: "rollback.apply_failed",
      payload: {
        application: {
          status: "failed",
          worktree: {
            policy: "cleanup",
            status: "blocked",
            path: worktreePath,
            reason: "not applied because rollback policy validation failed",
          },
          change: {
            policy: "new-pr",
            status: "blocked",
            reason:
              "change request mutation through resumed execution requires preserved worktree and branch state; no pull request was updated or created",
          },
          failures: [
            "change request mutation through resumed execution requires preserved worktree and branch state; no pull request was updated or created",
          ],
          mutations: [],
        },
      },
    });
    await expect(access(worktreePath)).resolves.toBeUndefined();
  });
});
