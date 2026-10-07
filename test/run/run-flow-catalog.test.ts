import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

const runFlowCalls: Array<Record<string, unknown>> = [];
vi.mock("../../src/run/run-flow.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/run/run-flow.js")>();
  return {
    ...actual,
    runFlow: async (input: Record<string, unknown>, dependencies?: unknown) => {
      if ((input as { __real?: boolean }).__real) {
        const { __real: _real, ...rest } = input as Record<string, unknown>;
        return actual.runFlow(rest as never, dependencies as never);
      }
      runFlowCalls.push(input);
      return { runId: "run-ci", branchName: "b", worktreePath: "/w", updatedHeadSha: "def456" };
    },
  };
});

import { defaultCiRepairDependencies } from "../../src/ci-repair/runtime.js";
import { EventStore } from "../../src/events/store.js";
import {
  CatalogFlowDisabledError,
  catalogSeedKeyForFlowReference,
  resolveRunFlowSource,
  setCatalogFlowEnabled,
  updateCatalogFlowDocument,
} from "../../src/flows/catalog.js";
import { flowDocumentHash } from "../../src/flows/store.js";
import { runFlow } from "../../src/run/run-flow.js";
import { evaluateRunPreflight } from "../../src/run/preflight.js";
import type { ExecutionBackend } from "../../src/run/execution/types.js";

const exec = promisify(execFile);
const git = (cwd: string, args: string[]) => exec("git", args, { cwd });

function flow(name: string, command: string): string {
  return JSON.stringify({
    apiVersion: "nitely.dev/v1alpha1",
    kind: "Flow",
    metadata: { name },
    spec: { stages: [{ id: "verify", type: "command", command, inputs: [], outputs: ["test-report"] }] },
  });
}

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "nitely-run-catalog-"));
  const remote = await mkdtemp(join(tmpdir(), "nitely-run-catalog-origin-"));
  await git(remote, ["init", "--bare"]);
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "nitely@example.test"]);
  await git(repo, ["config", "user.name", "Nitely Test"]);
  await mkdir(join(repo, "flows"), { recursive: true });
  await writeFile(join(repo, "flows/foo.json"), flow("foo", "printf shipped"), "utf8");
  await writeFile(join(repo, "custom.json"), flow("custom", "printf custom"), "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "-u", "origin", "HEAD"]);
  return repo;
}

const stopBackend: ExecutionBackend = {
  async createWorkspace() { throw new Error("stop after run.created"); },
  async runCommand() { throw new Error("command should not run"); },
  async runAgent() { throw new Error("agent should not run"); },
  async commitAll() { throw new Error("commit should not run"); },
};

function runCreated(repo: string, runId: string): Record<string, unknown> | undefined {
  const store = new EventStore(join(repo, ".nitely", "events.db"));
  try {
    return store.list(runId).find((event) => event.type === "run.created")?.payload as
      | Record<string, unknown>
      | undefined;
  } finally {
    store.close();
  }
}

describe("CLI/runtime Flow references resolve through the repository Flow catalog", () => {
  it("classifies catalog references and leaves explicit files alone", async () => {
    const repo = await createRepo();
    expect(catalogSeedKeyForFlowReference(repo, "flows/foo.json")).toBe("flows/foo.json");
    expect(catalogSeedKeyForFlowReference(repo, join(repo, "flows/foo.json"))).toBe("flows/foo.json");
    expect(catalogSeedKeyForFlowReference(repo, "./flows/foo.json", { cwd: repo })).toBe("flows/foo.json");
    expect(catalogSeedKeyForFlowReference(repo, join(repo, "custom.json"))).toBeUndefined();
    expect(catalogSeedKeyForFlowReference(repo, join(repo, "flows/nested/x.json"))).toBeUndefined();
  });

  it("runs an edited built-in via --flow with the stored document and snapshots its hash", async () => {
    const repo = await createRepo();
    const edited = flow("foo", "printf edited");
    await updateCatalogFlowDocument(repo, "flows/foo.json", edited);

    await expect(runFlow(
      { repoPath: repo, flowPath: "flows/foo.json", inputs: {}, __real: true } as never,
      { createRunId: () => "run-edited", backend: stopBackend },
    )).rejects.toThrow("stop after run.created");

    const payload = runCreated(repo, "run-edited");
    expect(payload).toMatchObject({
      flowPath: "flows/foo.json",
      flowDocument: edited,
      flowDocumentSha256: flowDocumentHash(edited),
    });
  });

  it("refuses a disabled built-in referenced by --flow", async () => {
    const repo = await createRepo();
    await setCatalogFlowEnabled(repo, "flows/foo.json", false);
    await expect(runFlow(
      { repoPath: repo, flowPath: join(repo, "flows/foo.json"), inputs: {}, __real: true } as never,
      { createRunId: () => "run-disabled", backend: stopBackend },
    )).rejects.toBeInstanceOf(CatalogFlowDisabledError);
    expect(runCreated(repo, "run-disabled")).toBeUndefined();

    const report = await evaluateRunPreflight({ repoPath: repo, flowPath: "flows/foo.json", inputs: {} });
    expect(report.status).toBe("BLOCK");
    expect(report.issues.map((issue) => issue.code)).toContain("flow-disabled");
  });

  it("reads an explicit non-catalog Flow file unchanged", async () => {
    const repo = await createRepo();
    const source = await resolveRunFlowSource(repo, join(repo, "custom.json"));
    expect(source).toEqual({ flowPath: join(repo, "custom.json"), flowDocument: flow("custom", "printf custom") });

    await expect(runFlow(
      { repoPath: repo, flowPath: join(repo, "custom.json"), inputs: {}, __real: true } as never,
      { createRunId: () => "run-custom", backend: stopBackend },
    )).rejects.toThrow("stop after run.created");
    expect(runCreated(repo, "run-custom")).toMatchObject({
      flowPath: join(repo, "custom.json"),
      flowDocumentSha256: flowDocumentHash(flow("custom", "printf custom")),
    });
  });

  it("CI repair runs the stored Flow and refuses a disabled one", async () => {
    const repo = await createRepo();
    const edited = flow("foo", "printf edited");
    await updateCatalogFlowDocument(repo, "flows/foo.json", edited);
    const observation = {
      provider: "github" as const,
      repository: "acme/nitely",
      pullRequest: 42,
      checkRunId: "check-7",
      checkName: "tests",
      headSha: "abc123",
      conclusion: "failure",
      status: "completed",
      failureOutput: { text: "boom", truncated: false },
      observedAt: "2026-09-18T00:00:00.000Z",
    };
    const dependencies = defaultCiRepairDependencies({
      repoPath: repo,
      flowPath: join(repo, "flows/foo.json"),
      inputs: {},
      pullRequestTarget: "https://github.com/acme/nitely/pull/42",
    });
    runFlowCalls.length = 0;
    await dependencies.applySamePullRequestRepair({ observation } as never).catch(() => undefined);
    expect(runFlowCalls).toHaveLength(1);
    expect(JSON.parse(String(runFlowCalls[0]?.flowDocument))).toEqual(JSON.parse(edited));
    expect(runFlowCalls[0]?.flowPath).toBe(join(repo, "flows/foo.json"));

    await setCatalogFlowEnabled(repo, "flows/foo.json", false);
    runFlowCalls.length = 0;
    await expect(dependencies.applySamePullRequestRepair({ observation } as never))
      .rejects.toBeInstanceOf(CatalogFlowDisabledError);
    expect(runFlowCalls).toHaveLength(0);
  });
});
