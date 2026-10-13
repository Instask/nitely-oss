import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ciRepairIdempotencyKey } from "../src/ci-repair.js";
import { changeMutationDomains, runGuardedMutation } from "../src/coordination/claims.js";
import { EventStore } from "../src/events/store.js";
import { listEvidenceRuns } from "../src/evidence/catalog.js";
import { parseCiFailureObservation, submitCiRepair } from "../src/ci-repair/runtime.js";
import { ciRepairEventStorePath } from "../src/ci-repair/store.js";

const observation = {
  provider: "github" as const,
  repository: "acme/nitely",
  pullRequest: 42,
  checkSuiteId: "suite-3",
  workflowRunId: "workflow-5",
  checkRunId: "check-7",
  checkName: "tests",
  headSha: "abc123",
  conclusion: "failure",
  status: "completed",
  failureOutput: "AssertionError: token=secret expected 1, received 2",
  observedAt: "2026-09-18T00:00:00.000Z",
};

describe("CI repair runtime", () => {
  it("rejects non-failing or malformed operator observations", () => {
    expect(() => parseCiFailureObservation({
      ...observation,
      headSha: "abc1234",
      status: "queued",
    })).toThrow(/status must be completed/);
    expect(() => parseCiFailureObservation({
      ...observation,
      headSha: "abc1234",
      conclusion: "success",
    })).toThrow(/conclusion must indicate a failure/);
  });

  it("persists redacted evidence and reuses an idempotent submission", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-ci-repair-"));
    let applyCalls = 0;
    let remoteCalls = 0;
    const dependencies = {
      applySamePullRequestRepair: async () => {
        applyCalls += 1;
        return { updatedHeadSha: "repaired-sha" };
      },
      runLocalChecks: async () => true,
      runStructuredReview: async () => true,
      observeRemoteResult: async () => {
        remoteCalls += 1;
        return { headSha: "repaired-sha", passed: true };
      },
    };

    const first = await submitCiRepair({
      repoPath,
      observation,
      currentHeadSha: observation.headSha,
      secrets: ["secret"],
      dependencies,
    });
    const second = await submitCiRepair({
      repoPath,
      observation,
      currentHeadSha: observation.headSha,
      secrets: ["secret"],
      dependencies,
    });

    expect(first.result.outcome).toBe("repaired");
    expect(second.reused).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(applyCalls).toBe(1);
    expect(remoteCalls).toBe(1);
    expect(first.evidence.failureOutput).not.toContain("secret");
    expect(first.evidence.terminal).toBe(true);
    if (process.platform === "linux") {
      await expect(listEvidenceRuns(repoPath)).resolves.toEqual([]);
    }

    const events = new EventStore(ciRepairEventStorePath(repoPath));
    expect(events.list(`ci-repair-${first.evidence.idempotencyKey}`).map((event) => event.type)).toEqual([
      "ci-repair.submitted",
      "ci-repair.diagnosed",
      "ci-repair.local-verified",
      "ci-repair.reviewed",
      "ci-repair.remote-observed",
      "ci-repair.completed",
    ]);
    events.close();
  });

  it("holds a repair when the pull request head changed and does not apply it", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-ci-repair-"));
    await runGuardedMutation({
      repoPath,
      domains: changeMutationDomains({
        action: "repair",
        pull: { owner: "acme", repository: "nitely", number: 42 },
      }),
      observedHead: "bbbbbbb",
      runId: "earlier-repair",
      idempotencyKey: "earlier-repair",
      effect: async () => ({ head: "bbbbbbb" }),
      resultOf: () => ({ head: "bbbbbbb" }),
    });
    let applyCalls = 0;
    const submitted = await submitCiRepair({
      repoPath,
      observation,
      currentHeadSha: observation.headSha,
      dependencies: {
        applySamePullRequestRepair: async () => {
          applyCalls += 1;
          return { updatedHeadSha: "should-not-apply" };
        },
        runLocalChecks: async () => true,
        runStructuredReview: async () => true,
        observeRemoteResult: async () => ({ headSha: "should-not-apply", passed: true }),
      },
    });

    expect(applyCalls).toBe(0);
    expect(submitted.result.outcome).toBe("needs-human");
    expect(submitted.result.reason).toContain("stale-cursor");
  });

  it("replays a completed repair claim without applying the pull request again", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-ci-repair-"));
    const idempotencyKey = ciRepairIdempotencyKey(observation);
    await runGuardedMutation({
      repoPath,
      domains: changeMutationDomains({
        action: "repair",
        pull: { owner: "acme", repository: "nitely", number: 42 },
      }),
      observedHead: observation.headSha,
      runId: `ci-repair:${idempotencyKey}`,
      idempotencyKey,
      effect: async () => ({ head: "bbbbbbb" }),
      resultOf: () => ({ head: "bbbbbbb" }),
    });
    let applyCalls = 0;
    const submitted = await submitCiRepair({
      repoPath,
      observation,
      currentHeadSha: observation.headSha,
      dependencies: {
        applySamePullRequestRepair: async () => {
          applyCalls += 1;
          return { updatedHeadSha: "should-not-apply" };
        },
        runLocalChecks: async () => true,
        runStructuredReview: async () => true,
        observeRemoteResult: async () => ({ headSha: "bbbbbbb", passed: true }),
      },
    });

    expect(applyCalls).toBe(0);
    expect(submitted.result.outcome).toBe("repaired");
    expect(submitted.evidence.samePullRequestUpdate?.updatedHeadSha).toBe("bbbbbbb");
  });
});
