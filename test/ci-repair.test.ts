import { describe, expect, it } from "vitest";

import {
  ciRepairIdempotencyKey,
  classifyCiFailure,
  executeCiRepairCycle,
  evaluateCiRepairAdmission,
  redactCiFailureObservation,
} from "../src/ci-repair.js";

const observation = {
  provider: "github" as const,
  repository: "acme/nitely",
  pullRequest: 42,
  checkRunId: "check-7",
  checkName: "tests",
  headSha: "abc123",
  conclusion: "failure",
  status: "completed",
  failureOutput: "AssertionError: expected 1, received 2",
  observedAt: "2026-09-18T00:00:00.000Z",
};

describe("bounded CI repair core", () => {
  it("classifies deterministic failures and redacts/bounds output", () => {
    expect(classifyCiFailure(observation.failureOutput).classification).toBe(
      "test-expectation",
    );
    const result = redactCiFailureObservation(
      { ...observation, failureOutput: `token=secret\n${"x".repeat(20)}` },
      ["secret"],
    );
    expect(result.failureOutput).not.toContain("secret");
    expect(result.outputTruncated).toBe(false);
  });

  it("does not treat ordinary test wording as a flaky runner signal", () => {
    expect(classifyCiFailure("AssertionError: handles flaky retry expected 1, received 2").classification)
      .toBe("test-expectation");
    expect(classifyCiFailure("CI runner reported flaky retry after a network timeout").classification)
      .toBe("environment/infrastructure");
  });

  it("truncates UTF-8 on a character boundary and reports the truncation", () => {
    const result = redactCiFailureObservation({
      ...observation,
      failureOutput: `${"😀".repeat(20)}\n[TRUNCATED]`,
    }, [], 17);
    expect(result.outputTruncated).toBe(true);
    expect(result.failureOutput).not.toContain("�");
    expect(result.failureOutput).toContain("[TRUNCATED]");
  });

  it("uses immutable source identity for duplicate submissions", () => {
    expect(ciRepairIdempotencyKey(observation)).toBe(
      ciRepairIdempotencyKey({
        provider: observation.provider,
        repository: observation.repository,
        pullRequest: observation.pullRequest,
        checkRunId: observation.checkRunId,
        headSha: observation.headSha,
      }),
    );
    expect(ciRepairIdempotencyKey(observation)).not.toBe(
      ciRepairIdempotencyKey({
        provider: observation.provider,
        repository: observation.repository,
        pullRequest: observation.pullRequest,
        checkRunId: observation.checkRunId,
        headSha: "def456",
      }),
    );
  });

  it("fails closed for stale, infra/flaky, and exhausted cycles", () => {
    expect(
      evaluateCiRepairAdmission({
        observation,
        currentHeadSha: "def456",
        remoteObservationCount: 0,
      }),
    ).toMatchObject({ allowed: false, outcome: "stale" });
    expect(
      evaluateCiRepairAdmission({
        observation: { ...observation, failureOutput: "runner unavailable" },
        currentHeadSha: observation.headSha,
        remoteObservationCount: 0,
      }),
    ).toMatchObject({ allowed: false, outcome: "infra-or-flaky" });
    expect(
      evaluateCiRepairAdmission({
        observation,
        currentHeadSha: observation.headSha,
        remoteObservationCount: 2,
      }),
    ).toMatchObject({ allowed: false, outcome: "needs-human" });
  });

  it("updates the existing PR once, verifies locally, reviews, and bounds CI", async () => {
    const calls: string[] = [];
    const result = await executeCiRepairCycle(
      { observation, currentHeadSha: observation.headSha, remoteObservationCount: 0 },
      {
        applySamePullRequestRepair: async () => {
          calls.push("update-existing-pr");
          return { updatedHeadSha: "repaired-sha" };
        },
        runLocalChecks: async () => true,
        runStructuredReview: async () => true,
        observeRemoteResult: async () => ({ headSha: "repaired-sha", passed: true }),
      },
    );
    expect(result).toMatchObject({ outcome: "repaired", remoteObservationCount: 1 });
    expect(calls).toEqual(["update-existing-pr"]);
  });
});
