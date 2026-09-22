import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import { projectRun } from "../../src/run/project.js";
import { runFlow } from "../../src/run/run-flow.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  return await execFileAsync("git", args, { cwd });
}

async function createRepo() {
  const repo = await mkdtemp(join(tmpdir(), "nitely-multi-review-"));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "nitely@example.test"]);
  await git(repo, ["config", "user.name", "Nitely Test"]);
  await writeFile(join(repo, "README.md"), "# Test Repo\n", "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

const APPROVED = "Review verdict: approved\nReason: nothing blocking\n";

async function writeMultiReviewFlow(repo: string): Promise<string> {
  const flowPath = join(repo, "flows", "multi-review.json");
  await writeJson(flowPath, {
    apiVersion: "nitely.dev/v1alpha1",
    kind: "Flow",
    metadata: { name: "multi-review" },
    spec: {
      maxAttempts: 3,
      stages: [
        {
          id: "implement",
          type: "agent",
          runtime: "mock",
          prompt: "Implement the change.",
          inputs: [],
          outputs: ["implementation"],
        },
        {
          id: "review-correctness",
          type: "gate",
          mode: "review",
          runtime: "mock",
          blocking: false,
          prompt: "Review for correctness only.",
          inputs: ["implementation"],
          outputs: ["review-correctness"],
        },
        {
          id: "review-security",
          type: "gate",
          mode: "review",
          runtime: "mock",
          blocking: false,
          prompt: "Review for security only.",
          inputs: ["implementation"],
          outputs: ["review-security"],
        },
        {
          id: "review",
          type: "gate",
          mode: "review-aggregate",
          name: "Aggregated review",
          perspectives: ["review-correctness", "review-security"],
          inputs: ["implementation", "review-correctness", "review-security"],
          outputs: ["review"],
        },
      ],
    },
  });
  return flowPath;
}

async function readAggregateReport(
  repo: string,
  runId: string,
): Promise<string> {
  const store = new EventStore(join(repo, ".nitely", "events.db"));
  const events = store.list(runId);
  store.close();
  const gate = projectRun(events).gates.find((entry) => entry.stageId === "review");
  expect(gate, "aggregate gate result is missing").toBeDefined();
  return await readFile(gate!.reviewOutput!.path, "utf8");
}

describe("multi-perspective review", () => {
  it("passes one aggregated decision when every perspective approves", async () => {
    const repo = await createRepo();
    const flowPath = await writeMultiReviewFlow(repo);

    const result = await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-multi-review-pass",
        executeAgent: async ({ stage, attemptDirectory }) => {
          const filename =
            stage.id === "implement" ? "implementation.md" : `${stage.id}.md`;
          await writeFile(join(attemptDirectory, filename), APPROVED, "utf8");
        },
      },
    );

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(store.list(result.runId));
    store.close();
    expect(
      projection.gates.map((gate) => [gate.stageId, gate.mode, gate.status]),
    ).toEqual([
      ["review-correctness", "review", "passed"],
      ["review-security", "review", "passed"],
      ["review", "review-aggregate", "passed"],
    ]);

    const report = await readAggregateReport(repo, result.runId);
    expect(report).toContain("Review verdict: approved");
    expect(report).toContain("Perspectives: 2 of 2 approved");
  });

  it("keeps a blocking perspective advisory and fails closed in the aggregate", async () => {
    const repo = await createRepo();
    const flowPath = await writeMultiReviewFlow(repo);
    const perspectiveCalls = new Map<string, number>();

    const result = await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-multi-review-block",
        executeAgent: async ({ stage, attemptDirectory }) => {
          if (stage.id === "implement") {
            await writeFile(
              join(attemptDirectory, "implementation.md"),
              "implemented\n",
              "utf8",
            );
            return;
          }
          const calls = (perspectiveCalls.get(stage.id) ?? 0) + 1;
          perspectiveCalls.set(stage.id, calls);
          const blocks = stage.id === "review-security" && calls === 1;
          await writeFile(
            join(attemptDirectory, `${stage.id}.md`),
            blocks
              ? [
                  "Review verdict: needs_fix",
                  "Reason: the upload path is joined without validation",
                  "src/web/server.ts:42: path traversal in the upload root",
                  "",
                ].join("\n")
              : APPROVED,
            "utf8",
          );
        },
      },
    );

    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const events = store.list(result.runId);
    store.close();
    const projection = projectRun(events);

    // The perspective itself never stops the run; it records why it would have.
    const advisory = projection.gates.find(
      (gate) => gate.stageId === "review-security" && gate.attempt === 1,
    );
    expect(advisory).toMatchObject({ status: "passed" });
    expect(advisory?.advisoryReason).toContain("needs_fix");

    // The aggregate owns the single blocking decision.
    const blocked = projection.gates.find(
      (gate) => gate.stageId === "review" && gate.status === "failed",
    );
    expect(blocked?.reason).toContain("1 of 2 review perspectives blocked");
    expect(blocked?.reason).toContain("review-security");

    // And it routes rework at the implementation, not at the reviewers.
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "stage.rework.requested",
          stageId: "review",
          payload: expect.objectContaining({ targetStage: "implement" }),
        }),
      ]),
    );
    expect(perspectiveCalls.get("review-correctness")).toBe(2);
    expect(perspectiveCalls.get("review-security")).toBe(2);
  });

  it("fails closed when a declared perspective never produced a verdict", async () => {
    const repo = await createRepo();
    const flowPath = await writeMultiReviewFlow(repo);

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-multi-review-silent",
          executeAgent: async ({ stage, attemptDirectory }) => {
            const filename =
              stage.id === "implement" ? "implementation.md" : `${stage.id}.md`;
            await writeFile(
              join(attemptDirectory, filename),
              stage.id === "review-security"
                ? "The change looks fine to me.\n"
                : APPROVED,
              "utf8",
            );
          },
        },
      ),
    ).rejects.toThrow("review-security stated no review verdict");

    const report = await readAggregateReport(repo, "run-multi-review-silent");
    expect(report).toContain("- review-security: blocked (stated no review verdict)");
  });
});
