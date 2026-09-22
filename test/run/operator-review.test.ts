import {
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readArtifactRegistry,
  readArtifactRegistryWithPrivatePaths,
  writeArtifactRegistry,
} from "../../src/artifacts/registry.js";
import { readContextManifest } from "../../src/context/manifest.js";
import { EventStore } from "../../src/events/store.js";
import {
  operatorReviewForActiveBlocker,
  submitOperatorReview,
} from "../../src/run/operator-review.js";
import { eventStorePath, projectRun } from "../../src/run/project.js";
import {
  blockingReviewReason,
  hasManualReviewDecision,
  parseReviewGateVerdict,
} from "../../src/run/review-verdict.js";

const flowDocument = JSON.stringify({
  apiVersion: "nitely.dev/v1alpha1",
  kind: "Flow",
  metadata: { name: "operator-review-test", inputs: [{ id: "implementation" }] },
  spec: {
    stages: [
      {
        id: "review",
        type: "gate",
        mode: "review",
        runtime: "codex",
        prompt: "Review the implementation",
        inputs: ["implementation"],
        outputs: [{ id: "review-result", mediaType: "text/markdown" }],
      },
    ],
  },
});

async function blockedReviewRun(
  reason: "agent_usage_limit" | "agent_runtime_unavailable" =
    "agent_usage_limit",
): Promise<{ repo: string; store: EventStore }> {
  const repo = await mkdtemp(join(tmpdir(), "nitely-operator-review-"));
  await mkdir(join(repo, ".nitely"), { recursive: true });
  const store = new EventStore(eventStorePath(repo));
  const attemptDirectory = join(
    repo,
    ".nitely",
    "runs",
    "run-review",
    "stages",
    "review",
    "1",
  );
  await mkdir(attemptDirectory, { recursive: true });
  store.append({
    runId: "run-review",
    type: "run.created",
    payload: {
      flowPath: "unused.json",
      flowDocument,
      inputs: {
        implementation: { connector: "local-file", uri: "README.md" },
      },
    },
  });
  store.append({
    runId: "run-review",
    stageId: "review",
    attempt: 1,
    type: "stage.started",
    payload: { type: "gate", attemptDirectory, runtime: "codex" },
  });
  const blocker = {
    reason,
    stageId: "review",
    runtime: "codex",
    message: reason === "agent_usage_limit" ? "quota exceeded" : "codex missing",
    ...(reason === "agent_usage_limit" ? { retryAfter: "tomorrow" } : {}),
  };
  store.append({
    runId: "run-review",
    stageId: "review",
    attempt: 1,
    type: "stage.blocked",
    payload: blocker,
  });
  store.append({
    runId: "run-review",
    type: "run.blocked",
    payload: blocker,
  });
  return { repo, store };
}

describe("operator review verdicts", () => {
  it("reuses the existing review verdict and blocker parsing", () => {
    expect(parseReviewGateVerdict("Review verdict: pass\nReason: checked")).toEqual({
      verdict: "pass",
      reason: "checked",
    });
    expect(blockingReviewReason("Review verdict: fail")).toBe(
      "a failing verdict",
    );
    expect(blockingReviewReason("### P1 regression")).toBe(
      "blocking findings",
    );
    expect(hasManualReviewDecision("looks fine")).toBe(false);
  });

  it("persists a passing operator review with immutable provenance", async () => {
    const { repo, store } = await blockedReviewRun();
    store.close();

    const gate = await submitOperatorReview({
      repoPath: repo,
      runId: "run-review",
      actor: "reviewer@example.test",
      content: "Review verdict: pass\nReason: manually verified",
      reviewedArtifactIds: ["implementation"],
    });

    expect(gate).toMatchObject({
      id: "review-result",
      stageId: "review",
      status: "passed",
      runtime: "operator",
      reviewedArtifacts: ["implementation"],
      attempt: 1,
      reviewOutput: { verdict: { verdict: "pass" } },
      operatorReview: {
        actor: "reviewer@example.test",
        reviewedArtifactIds: ["implementation"],
        blocker: {
          reason: "agent_usage_limit",
          stageId: "review",
          runtime: "codex",
          retryAfter: "tomorrow",
        },
      },
    });

    const reopened = new EventStore(eventStorePath(repo));
    const events = reopened.list("run-review");
    reopened.close();
    expect(events.slice(-3).map((event) => event.type)).toEqual([
      "operator.review.submitted",
      "artifact.published",
      "gate.completed",
    ]);
    const projection = projectRun(events);
    expect(projection.status).toBe("blocked");
    expect(operatorReviewForActiveBlocker(projection)).toMatchObject({
      status: "passed",
      attempt: 1,
      operatorReview: { actor: "reviewer@example.test" },
    });

    const runDirectory = join(repo, ".nitely", "runs", "run-review");
    const registry = await readArtifactRegistry({
      runDirectory,
      boundaryRoot: repo,
    });
    expect(registry?.artifacts).toEqual([
      expect.objectContaining({
        id: "review-result",
        producer: "review",
        type: "gate.result",
        stageId: "review",
        attempt: 1,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        gateResult: expect.objectContaining({ runtime: "operator" }),
      }),
    ]);
    const manifest = await readContextManifest({ runDirectory });
    expect(manifest?.entries).toContainEqual(
      expect.objectContaining({
        id: "review-result",
        kind: "generated-artifact",
        runRelativePath: "stages/review/1/review-result.json",
      }),
    );
    await expect(
      readFile(join(runDirectory, "stages", "review", "1", "operator-review.md"), "utf8"),
    ).resolves.toContain("Review verdict: pass");

    await expect(
      submitOperatorReview({
        repoPath: repo,
        runId: "run-review",
        actor: "second-reviewer",
        content: "Review verdict: pass",
        reviewedArtifactIds: ["implementation"],
      }),
    ).rejects.toThrow(/already submitted/);
  });

  it("preserves private Artifact paths while appending an operator review", async () => {
    const { repo, store } = await blockedReviewRun();
    store.close();
    const runDirectory = join(repo, ".nitely", "runs", "run-review");
    const secret = "operator-private-value";
    const rawPath = `stages/implement/1/${secret}/output.md`;
    await mkdir(join(runDirectory, "stages", "implement", "1", secret), {
      recursive: true,
    });
    await writeFile(join(runDirectory, rawPath), "implementation\n", "utf8");
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repo,
      runId: "run-review",
      artifacts: [{
        id: "implementation",
        producer: "implement",
        mediaType: "text/markdown",
        path: rawPath,
      }],
      redactionSecrets: [secret],
    });

    await submitOperatorReview({
      repoPath: repo,
      runId: "run-review",
      actor: "reviewer@example.test",
      content: "Review verdict: pass\nReason: manually verified",
      reviewedArtifactIds: ["implementation"],
    });

    expect(await readFile(join(runDirectory, "artifacts.json"), "utf8"))
      .not.toContain("operator-private-value");
    const internalRegistry = await readArtifactRegistryWithPrivatePaths({
      runDirectory,
      boundaryRoot: repo,
      runId: "run-review",
    });
    expect(internalRegistry?.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "implementation", path: rawPath }),
      expect.objectContaining({ id: "review-result" }),
    ]));
  });

  it("does not follow pre-existing links for operator review files", async () => {
    for (const filename of ["operator-review.md", "review-result.json"]) {
      const { repo, store } = await blockedReviewRun();
      store.close();
      const attemptDirectory = join(
        repo,
        ".nitely",
        "runs",
        "run-review",
        "stages",
        "review",
        "1",
      );
      const outsidePath = join(repo, `outside-${filename}`);
      await writeFile(outsidePath, "must not change\n", "utf8");
      await symlink(outsidePath, join(attemptDirectory, filename));

      await expect(submitOperatorReview({
        repoPath: repo,
        runId: "run-review",
        actor: "reviewer",
        content: "Review verdict: pass\nReason: manually verified",
        reviewedArtifactIds: ["implementation"],
      })).rejects.toThrow(/symbolic link/i);
      await expect(readFile(outsidePath, "utf8")).resolves.toBe(
        "must not change\n",
      );
    }
  });

  it("persists explicit fail and P0 decisions as failed manual gates", async () => {
    const failed = await blockedReviewRun("agent_runtime_unavailable");
    failed.store.close();
    await expect(
      submitOperatorReview({
        repoPath: failed.repo,
        runId: "run-review",
        actor: "reviewer",
        content: "Review verdict: fail\nReason: tests do not cover the regression",
        reviewedArtifactIds: ["implementation"],
      }),
    ).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("a failing verdict"),
    });

    const p0 = await blockedReviewRun();
    p0.store.close();
    await expect(
      submitOperatorReview({
        repoPath: p0.repo,
        runId: "run-review",
        actor: "reviewer",
        content: "### P0 data loss\nThe implementation deletes history.",
        reviewedArtifactIds: ["implementation"],
      }),
    ).resolves.toMatchObject({ status: "failed" });
  });

  it("rejects missing decisions, actor provenance, and mismatched artifacts", async () => {
    const invalid = await blockedReviewRun();
    invalid.store.close();
    await expect(
      submitOperatorReview({
        repoPath: invalid.repo,
        runId: "run-review",
        actor: "reviewer",
        content: "I looked at it.",
        reviewedArtifactIds: ["implementation"],
      }),
    ).rejects.toThrow(/recognized pass\/fail verdict or P0\/P1/);
    await expect(
      submitOperatorReview({
        repoPath: invalid.repo,
        runId: "run-review",
        actor: " ",
        content: "Review verdict: pass",
        reviewedArtifactIds: ["implementation"],
      }),
    ).rejects.toThrow(/actor is required/);
    await expect(
      submitOperatorReview({
        repoPath: invalid.repo,
        runId: "run-review",
        actor: "reviewer\nforged evidence",
        content: "Review verdict: pass",
        reviewedArtifactIds: ["implementation"],
      }),
    ).rejects.toThrow(/actor must be a single line/);
    await expect(
      submitOperatorReview({
        repoPath: invalid.repo,
        runId: "run-review",
        actor: "reviewer",
        content: "Review verdict: pass",
        reviewedArtifactIds: ["unknown"],
      }),
    ).rejects.toThrow(/must exactly match review gate inputs: implementation/);
  });
});
