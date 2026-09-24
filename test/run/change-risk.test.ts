import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import { projectRun } from "../../src/run/project.js";
import { collectChangeDiff } from "../../src/run/change-risk.js";
import { runFlow } from "../../src/run/run-flow.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  return await execFileAsync("git", args, { cwd });
}

async function createRepo() {
  const repo = await mkdtemp(join(tmpdir(), "nitely-change-risk-"));
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

async function writePublishFlow(repo: string): Promise<string> {
  const flowPath = join(repo, "flows", "publish.json");
  await writeJson(flowPath, {
    apiVersion: "nitely.dev/v1alpha1",
    kind: "Flow",
    metadata: { name: "publish" },
    spec: {
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
          id: "publish",
          type: "publish-change",
          inputs: ["implementation"],
          outputs: ["change-request"],
        },
      ],
    },
  });
  return flowPath;
}

function agentWriting(files: Record<string, string>) {
  return async ({
    worktreePath,
    attemptDirectory,
  }: {
    worktreePath: string;
    attemptDirectory: string;
  }) => {
    for (const [path, content] of Object.entries(files)) {
      const target = join(worktreePath, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    await writeFile(
      join(attemptDirectory, "implementation.md"),
      "implemented\n",
      "utf8",
    );
  };
}

function projectionFor(repo: string, runId: string) {
  const store = new EventStore(join(repo, ".nitely", "events.db"));
  const events = store.list(runId);
  store.close();
  return projectRun(events);
}

describe("risk-based review policy", () => {
  it("classifies an ordinary change at its declared baseline and publishes", async () => {
    const repo = await createRepo();
    const flowPath = await writePublishFlow(repo);

    const result = await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-risk-normal",
        executeAgent: agentWriting({ "src/web/panel.ts": "export const x = 1;\n" }),
        publishChange: async ({ branchName, evidencePath }) => ({
          url: `https://example.test/pr/${branchName}`,
          evidencePath,
        }),
      },
    );

    const risk = projectionFor(repo, result.runId).riskClassification;
    expect(risk).toMatchObject({
      stageId: "publish",
      declared: "normal",
      effective: "normal",
      escalated: false,
    });
    expect(risk?.requirement).toMatchObject({
      requiredApprovals: 1,
      requireRunApproval: false,
    });
    expect(result.changeRequestUrl).toContain("https://example.test/pr/");
  });

  it("escalates a protected-path diff and refuses to publish it unattended", async () => {
    const repo = await createRepo();
    const flowPath = await writePublishFlow(repo);
    let published = false;

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-risk-protected",
          executeAgent: agentWriting({
            "src/auth/session.ts": "export const session = 1;\n",
          }),
          publishChange: async ({ branchName, evidencePath }) => {
            published = true;
            return {
              url: `https://example.test/pr/${branchName}`,
              evidencePath,
            };
          },
        },
      ),
    ).rejects.toThrow(/requires an approved gate/);

    expect(published).toBe(false);
    const risk = projectionFor(repo, "run-risk-protected").riskClassification;
    expect(risk).toMatchObject({
      declared: "normal",
      effective: "protected",
      escalated: true,
    });
    expect(risk?.explanation).toContain(
      "Escalated from normal to protected risk because",
    );
    expect(risk?.explanation).toContain("src/auth/session.ts");
    expect(risk?.requirement.allowUnattendedMerge).toBe(false);
  });

  it("lets repository policy widen the protected domains it escalates on", async () => {
    const repo = await createRepo();
    const flowPath = await writePublishFlow(repo);
    await writeJson(join(repo, ".nitely", "review-policy.json"), {
      signals: {
        protectedPaths: { tenancy: ["src/tenancy/**"] },
      },
    });

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        {
          createRunId: () => "run-risk-custom",
          executeAgent: agentWriting({
            "src/tenancy/isolation.ts": "export const isolate = 1;\n",
          }),
          publishChange: async ({ branchName, evidencePath }) => ({
            url: `https://example.test/pr/${branchName}`,
            evidencePath,
          }),
        },
      ),
    ).rejects.toThrow(/requires an approved gate/);

    const risk = projectionFor(repo, "run-risk-custom").riskClassification;
    expect(risk?.effective).toBe("protected");
    expect(risk?.signals[0]).toMatchObject({ domain: "tenancy" });
    expect(risk?.policyConfigured).toBe(true);
  });

  it("lets repository policy relax the run-approval requirement", async () => {
    const repo = await createRepo();
    const flowPath = await writePublishFlow(repo);
    await writeJson(join(repo, ".nitely", "review-policy.json"), {
      classes: { protected: { requireRunApproval: false } },
    });

    const result = await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-risk-relaxed",
        executeAgent: agentWriting({
          "src/auth/session.ts": "export const session = 1;\n",
        }),
        publishChange: async ({ branchName, evidencePath }) => ({
          url: `https://example.test/pr/${branchName}`,
          evidencePath,
        }),
      },
    );

    const risk = projectionFor(repo, result.runId).riskClassification;
    expect(risk?.effective).toBe("protected");
    expect(risk?.requirement.requireRunApproval).toBe(false);
    expect(result.changeRequestUrl).toContain("https://example.test/pr/");
  });

  it("recomputes risk from the reworked diff before updating a change request", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "specs"), { recursive: true });
    await writeFile(join(repo, "specs/change.md"), "Rework the session.\n", "utf8");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "spec"]);
    await git(repo, ["checkout", "-q", "-b", "nitely/pr-7"]);
    await writeFile(join(repo, "feature.txt"), "previous\n", "utf8");
    await git(repo, ["add", "feature.txt"]);
    await git(repo, ["commit", "-m", "seed pr branch"]);
    const headSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    await git(repo, ["checkout", "-q", "master"]);

    const flowPath = join(repo, "flows", "rework.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "rework" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Apply the requested rework.",
            inputs: ["spec"],
            outputs: ["implementation"],
          },
          {
            id: "update",
            type: "update-change",
            provider: "github",
            inputs: ["implementation"],
            outputs: ["change-request"],
          },
        ],
      },
    });

    const target = {
      provider: "github" as const,
      owner: "example",
      repository: "demo",
      number: 7,
      url: "https://github.com/example/demo/pull/7",
      baseBranch: "master",
      headBranch: "nitely/pr-7",
      headSha,
      headRepository: { owner: "example", repository: "demo" },
      isCrossRepository: false,
    };
    let updated = false;

    await expect(
      runFlow(
        {
          flowPath,
          repoPath: repo,
          inputs: { spec: { connector: "local-file", uri: "specs/change.md" } },
          changeRequestTarget: { provider: "github", target: "7" },
        },
        {
          createRunId: () => "run-risk-rework",
          executeAgent: async ({ worktreePath, attemptDirectory }) => {
            // The rework introduces a protected-path change that the
            // original change request never had.
            await mkdir(join(worktreePath, "src/auth"), { recursive: true });
            await writeFile(
              join(worktreePath, "src/auth/session.ts"),
              "export const session = 2;\n",
              "utf8",
            );
            await writeFile(
              join(attemptDirectory, "implementation.md"),
              "reworked\n",
              "utf8",
            );
          },
          scmProvider: {
            type: "github",
            resolveChangeRequestTarget: async () => target,
            checkoutChangeRequest: async ({ worktreePath }) => {
              await git(repo, [
                "worktree",
                "add",
                worktreePath,
                target.headBranch,
              ]);
              return { previousHeadSha: target.headSha };
            },
            updateChangeRequest: async () => {
              updated = true;
              throw new Error("updateChangeRequest must not be reached");
            },
            publishChange: async () => {
              throw new Error("publishChange must not be called during rework");
            },
          },
        },
      ),
    ).rejects.toThrow(/requires an approved gate/);

    expect(updated).toBe(false);
    const risk = projectionFor(repo, "run-risk-rework").riskClassification;
    expect(risk).toMatchObject({ stageId: "update", effective: "protected" });
    expect(risk?.explanation).toContain("src/auth/session.ts");
  });

  it("records the classification and its code owners in change evidence", async () => {
    const repo = await createRepo();
    const flowPath = await writePublishFlow(repo);
    await mkdir(join(repo, ".github"), { recursive: true });
    await writeFile(
      join(repo, ".github/CODEOWNERS"),
      "src/web/ @org/web-team\n",
      "utf8",
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "add codeowners"]);

    const result = await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-risk-evidence",
        executeAgent: agentWriting({
          "package.json": '{"name":"demo"}\n',
          "src/web/panel.ts": "export const x = 1;\n",
        }),
        publishChange: async ({ branchName, evidencePath }) => ({
          url: `https://example.test/pr/${branchName}`,
          evidencePath,
        }),
      },
    );

    const evidence = await readFile(
      join(repo, ".nitely", "runs", result.runId, "evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("## Risk Classification");
    expect(evidence).toContain("Declared risk: normal");
    expect(evidence).toContain("Effective risk: high");
    expect(evidence).toContain("dependency-manifest (high)");
    expect(evidence).toContain("- Code owners: @org/web-team");
    expect(evidence).toContain("- Human approvals: 2");
  });
});

describe("change diff collection", () => {
  it("counts pending worktree changes a rework has not committed yet", async () => {
    const repo = await createRepo();
    const baseBranch = (
      await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])
    ).stdout.trim();
    await git(repo, ["checkout", "-q", "-b", "feature"]);
    await mkdir(join(repo, "src/auth"), { recursive: true });
    await writeFile(
      join(repo, "src/auth/session.ts"),
      "export const session = 1;\n",
      "utf8",
    );
    await writeFile(join(repo, "README.md"), "# Pending\n", "utf8");

    const diff = await collectChangeDiff({ worktreePath: repo, baseBranch });

    expect(diff.files).toEqual(
      expect.arrayContaining([
        { path: "src/auth/session.ts", status: "added" },
        { path: "README.md", status: "modified" },
      ]),
    );
  });

  it("reads the committed diff against the base branch", async () => {
    const repo = await createRepo();
    const baseBranch = (
      await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])
    ).stdout.trim();
    await git(repo, ["checkout", "-q", "-b", "feature"]);
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src/new.ts"), "export const a = 1;\n", "utf8");
    await writeFile(join(repo, "README.md"), "# Changed\n", "utf8");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "feature"]);

    const diff = await collectChangeDiff({
      worktreePath: repo,
      baseBranch,
    });

    expect(diff.files).toEqual(
      expect.arrayContaining([
        { path: "src/new.ts", status: "added" },
        { path: "README.md", status: "modified" },
      ]),
    );
    expect(diff.changedLines).toBeGreaterThan(0);
  });
});
