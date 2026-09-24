import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeArtifactRegistry } from "../../src/artifacts/registry.js";
import { runCli } from "../../src/cli.js";
import { EventStore } from "../../src/events/store.js";
import { eventStorePath } from "../../src/run/project.js";
import { evidencePolicyPath } from "../../src/evidence/policy.js";

async function createCliEvidenceRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-evidence-cli-"));
  const runDirectory = join(repoPath, ".nitely", "runs", "run-cli");
  await mkdir(runDirectory, { recursive: true });
  const store = new EventStore(eventStorePath(repoPath));
  store.append({
    runId: "run-cli",
    type: "run.created",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: {
      flowName: "cli-flow",
      workItemId: "task-cli",
      repoName: "cli-repository",
    },
  });
  store.append({
    runId: "run-cli",
    type: "run.completed",
    createdAt: "2026-01-01T01:00:00.000Z",
    payload: { changeRequestUrl: "https://github.com/acme/cli/pull/1" },
  });
  store.close();
  await writeFile(
    join(runDirectory, "run.json"),
    JSON.stringify({ runId: "run-cli", completedStages: [] }),
    "utf8",
  );
  return repoPath;
}

async function invoke(argv: string[]): Promise<{
  code: number;
  stdout: string[];
  stderr: string[];
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { code, stdout, stderr };
}

describe("evidence CLI", () => {
  it("inspects policy and searches metadata as JSON", async () => {
    const repoPath = await createCliEvidenceRepo();
    const policy = await invoke(["evidence", "policy", "--repo", repoPath, "--json"]);
    expect(policy.code).toBe(0);
    expect(policy.stderr).toEqual([]);
    expect(JSON.parse(policy.stdout.join("\n"))).toMatchObject({
      source: "default",
      retention: { runsDays: null },
    });

    const search = await invoke([
      "evidence",
      "search",
      "--repo",
      repoPath,
      "--task",
      "task-cli",
      "--json",
    ]);
    expect(search.code).toBe(0);
    expect(search.stderr).toEqual([]);
    expect(JSON.parse(search.stdout.join("\n"))).toEqual([
      expect.objectContaining({
        runId: "run-cli",
        status: "completed",
        taskId: "task-cli",
      }),
    ]);
  });

  it("exports selected runs and keeps prune dry-run until --apply", async () => {
    const repoPath = await createCliEvidenceRepo();
    const outputPath = join(repoPath, "closeout");
    const exported = await invoke([
      "evidence",
      "export",
      "--repo",
      repoPath,
      "--run",
      "run-cli",
      "--output",
      outputPath,
    ]);
    expect(exported.code).toBe(0);
    expect(exported.stderr).toEqual([]);
    expect(exported.stdout.join("\n")).toContain("metadata-only");
    expect(JSON.parse(await readFile(join(outputPath, "manifest.json"), "utf8")))
      .toMatchObject({ runIds: ["run-cli"], rawContentIncluded: false });

    await writeFile(
      evidencePolicyPath(repoPath),
      JSON.stringify({
        apiVersion: "nitely.dev/v1alpha1",
        kind: "EvidencePolicy",
        spec: { retention: { runsDays: 0, eventsDays: 0 } },
      }),
      "utf8",
    );
    const runDirectory = join(repoPath, ".nitely", "runs", "run-cli");
    const dryRun = await invoke([
      "evidence",
      "prune",
      "--repo",
      repoPath,
      "--at",
      "2026-07-14T00:00:00.000Z",
    ]);
    expect(dryRun.code).toBe(0);
    expect(dryRun.stdout.join("\n")).toContain("DRY-RUN");
    await expect(access(runDirectory)).resolves.toBeUndefined();

    const applied = await invoke([
      "evidence",
      "prune",
      "--repo",
      repoPath,
      "--at",
      "2026-07-14T00:00:00.000Z",
      "--apply",
    ]);
    expect(applied.code).toBe(0);
    expect(applied.stdout.join("\n")).toContain("APPLIED");
    await expect(access(runDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("omits private Artifact paths from prune JSON output", async () => {
    const repoPath = await createCliEvidenceRepo();
    const runDirectory = join(repoPath, ".nitely", "runs", "run-cli");
    const secret = "ordinary-private-path-segment";
    const artifactRelativePath = `stages/review/1/${secret}/output.bin`;
    const artifactPath = join(runDirectory, artifactRelativePath);
    await mkdir(join(artifactPath, ".."), { recursive: true });
    await writeFile(artifactPath, "private bytes\n", "utf8");
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-cli",
      artifacts: [{
        id: "private-output",
        producer: "review",
        mediaType: "application/octet-stream",
        path: artifactRelativePath,
      }],
      redactionSecrets: [secret],
    });
    await writeFile(
      evidencePolicyPath(repoPath),
      JSON.stringify({
        apiVersion: "nitely.dev/v1alpha1",
        kind: "EvidencePolicy",
        spec: {
          retention: {
            runsDays: null,
            eventsDays: null,
            logsDays: null,
            artifactsDays: 0,
            evidenceDays: null,
          },
        },
      }),
      "utf8",
    );
    const args = [
      "evidence",
      "prune",
      "--repo",
      repoPath,
      "--at",
      "2026-07-14T00:00:00.000Z",
      "--json",
    ];

    const dryRun = await invoke(args);
    expect(dryRun.code).toBe(0);
    const dryRunText = dryRun.stdout.join("\n");
    expect(dryRunText).not.toContain(secret);
    const dryRunAction = (JSON.parse(dryRunText) as {
      actions: Array<Record<string, unknown>>;
    }).actions.find((action) => action.category === "artifacts");
    expect(dryRunAction).toMatchObject({
      runId: "run-cli",
      category: "artifacts",
      targetCount: 3,
    });
    expect(dryRunAction).not.toHaveProperty("paths");

    const applied = await invoke([...args, "--apply"]);
    expect(applied.code).toBe(0);
    const appliedText = applied.stdout.join("\n");
    expect(appliedText).not.toContain(secret);
    const appliedAction = (JSON.parse(appliedText) as {
      applied: Array<Record<string, unknown>>;
    }).applied.find((action) => action.category === "artifacts");
    expect(appliedAction).toMatchObject({
      runId: "run-cli",
      category: "artifacts",
      targetCount: 3,
    });
    expect(appliedAction).not.toHaveProperty("paths");
  });

  it("omits private Artifact paths from prune errors", async () => {
    const repoPath = await createCliEvidenceRepo();
    const runDirectory = join(repoPath, ".nitely", "runs", "run-cli");
    const secret = "ordinary-private-error-segment";
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-cli",
      artifacts: [{
        id: "private-output",
        producer: "review",
        mediaType: "application/octet-stream",
        path: "stages/review/1/output.bin",
      }],
      redactionSecrets: [],
    });
    const publicRegistry = JSON.parse(
      await readFile(join(runDirectory, "artifacts.json"), "utf8"),
    ) as { privatePathRef: string };
    const privateRegistryPath = join(
      runDirectory,
      `artifact-paths.private.${publicRegistry.privatePathRef}.json`,
    );
    const privateRegistry = JSON.parse(
      await readFile(privateRegistryPath, "utf8"),
    ) as { artifacts: Array<{ path: string }> };
    if (!privateRegistry.artifacts[0]) {
      throw new Error("expected private Artifact path fixture");
    }
    privateRegistry.artifacts[0].path = `../${secret}/output.bin`;
    await writeFile(
      privateRegistryPath,
      JSON.stringify(privateRegistry, null, 2),
      "utf8",
    );
    await writeFile(
      evidencePolicyPath(repoPath),
      JSON.stringify({
        apiVersion: "nitely.dev/v1alpha1",
        kind: "EvidencePolicy",
        spec: { retention: { artifactsDays: 0 } },
      }),
      "utf8",
    );

    const result = await invoke([
      "evidence",
      "prune",
      "--repo",
      repoPath,
      "--at",
      "2026-07-14T00:00:00.000Z",
    ]);

    expect(result.code).toBe(1);
    expect([...result.stdout, ...result.stderr].join("\n")).not.toContain(secret);
    expect(result.stderr).toEqual([
      "Evidence prune failed safely; sensitive path details were omitted.",
    ]);
  });

  it("rejects incomplete and unknown evidence commands", async () => {
    const missing = await invoke(["evidence", "export", "--run", "run-1"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr.join("\n")).toMatch(/--output/);

    const unknown = await invoke(["evidence", "erase-everything"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr.join("\n")).toMatch(/policy\|search\|export\|prune/);
  });
});
