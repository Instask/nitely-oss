import { createHash } from "node:crypto";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { writeArtifactRegistry } from "../../src/artifacts/registry.js";
import { EventStore } from "../../src/events/store.js";
import { eventStorePath } from "../../src/run/project.js";
import {
  evidencePolicyPath,
  loadEvidencePolicy,
} from "../../src/evidence/policy.js";
import { searchEvidenceRuns } from "../../src/evidence/catalog.js";
import { exportEvidenceBundle } from "../../src/evidence/export.js";
import {
  applyEvidencePrunePlan,
  buildEvidencePrunePlan,
} from "../../src/evidence/retention.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function privateRegistryPaths(runDirectory: string): Promise<string[]> {
  return (await readdir(runDirectory))
    .filter((name) => /^artifact-paths\.private\.[a-f0-9]{32}\.json$/u.test(name))
    .map((name) => join(runDirectory, name))
    .sort();
}

async function listFiles(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, path));
    } else if (entry.isFile()) {
      files.push(relative(root, path));
    }
  }
  return files.sort();
}

async function bundleText(root: string): Promise<string> {
  const contents = await Promise.all(
    (await listFiles(root)).map(async (path) =>
      `${path}\n${await readFile(join(root, path), "utf8")}`,
    ),
  );
  return contents.join("\n");
}

async function createRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-evidence-"));
  await mkdir(join(repoPath, ".nitely", "runs"), { recursive: true });
  return repoPath;
}

interface SeedRunInput {
  runId: string;
  createdAt: string;
  terminalAt?: string;
  status?: "completed" | "failed" | "blocked" | "cancelled" | "running";
  taskId?: string;
  flowName?: string;
  repositoryName?: string;
  prUrl?: string;
  blockerReason?: string;
  secret?: string;
}

async function seedRun(repoPath: string, input: SeedRunInput): Promise<string> {
  const runDirectory = join(repoPath, ".nitely", "runs", input.runId);
  const stageDirectory = join(runDirectory, "stages", "implement", "1");
  await mkdir(stageDirectory, { recursive: true });
  const store = new EventStore(eventStorePath(repoPath));
  const secret = input.secret ?? "fixture-private-source";
  const artifactContent = `artifact ${secret}`;
  try {
    store.append({
      runId: input.runId,
      type: "run.created",
      createdAt: input.createdAt,
      payload: {
        flowName: input.flowName ?? "implement-spec",
        flowPath: `/private/flows/${secret}.json`,
        workItemId: input.taskId ?? "task-default",
        repoId: "repo-local",
        repoName: input.repositoryName ?? "payments-service",
        repoPath: `/private/source/${secret}`,
        configuration: { source: secret },
      },
    });
    store.append({
      runId: input.runId,
      type: "stage.started",
      stageId: "implement",
      attempt: 1,
      createdAt: input.createdAt,
      payload: { attemptDirectory: stageDirectory },
    });
    store.append({
      runId: input.runId,
      type: "gate.completed",
      stageId: "verify",
      attempt: 1,
      createdAt: input.createdAt,
      payload: {
        gate: {
          id: "unit-tests",
          stageId: "verify",
          name: "Unit tests",
          mode: "deterministic",
          status: "passed",
          command: `cat ${secret}`,
          stdout: secret,
          stderr: secret,
          reason: secret,
          createdAt: input.createdAt,
        },
      },
    });
    store.append({
      runId: input.runId,
      type: "artifact.published",
      stageId: "implement",
      attempt: 1,
      createdAt: input.createdAt,
      payload: {
        artifact: {
          id: "implementation",
          name: "Implementation summary",
          type: "implementation",
          description: secret,
          producer: "implement",
          mediaType: "text/markdown",
          path: "stages/implement/1/output.md",
          sourceUri: `/private/source/${secret}.ts`,
          filename: `${secret}.md`,
          sha256: createHash("sha256").update(artifactContent).digest("hex"),
          size: Buffer.byteLength(artifactContent),
        },
      },
    });

    const status = input.status ?? "completed";
    if (status !== "running") {
      store.append({
        runId: input.runId,
        type: status === "completed"
          ? "stage.completed"
          : status === "blocked"
            ? "stage.blocked"
            : "stage.failed",
        stageId: "implement",
        attempt: 1,
        createdAt: input.terminalAt ?? input.createdAt,
        payload: status === "blocked"
          ? { reason: input.blockerReason ?? "approval_required" }
          : {},
      });
      const terminalType = `run.${status}` as
        | "run.completed"
        | "run.failed"
        | "run.blocked"
        | "run.cancelled";
      store.append({
        runId: input.runId,
        type: terminalType,
        createdAt: input.terminalAt ?? input.createdAt,
        payload: {
          ...(input.prUrl ? { changeRequestUrl: input.prUrl } : {}),
          ...(status === "blocked"
            ? {
                reason: input.blockerReason ?? "approval_required",
                message: secret,
              }
            : {}),
        },
      });
    }
  } finally {
    store.close();
  }

  if ((input.status ?? "completed") === "completed") {
    await writeJson(join(runDirectory, "run.json"), {
      runId: input.runId,
      flowName: input.flowName ?? "implement-spec",
      workItemId: input.taskId ?? "task-default",
      repoId: "repo-local",
      repoName: input.repositoryName ?? "payments-service",
      repoPath: `/private/source/${secret}`,
      changeRequestUrl: input.prUrl,
      gates: [{ stdout: secret }],
      completedStages: ["implement"],
    });
  }
  await writeJson(join(runDirectory, "artifacts.json"), {
    runId: input.runId,
    artifacts: [
      {
        id: "implementation",
        name: "Implementation summary",
        type: "implementation",
        producer: "implement",
        mediaType: "text/markdown",
        path: "stages/implement/1/output.md",
        sourceUri: `/private/source/${secret}.ts`,
        filename: `${secret}.md`,
        sha256: createHash("sha256").update(artifactContent).digest("hex"),
        size: Buffer.byteLength(artifactContent),
      },
    ],
  });
  await writeFile(join(runDirectory, "evidence.md"), `evidence ${secret}`, "utf8");
  await writeFile(join(stageDirectory, "prompt.md"), `prompt ${secret}`, "utf8");
  await writeFile(join(stageDirectory, "stdout.log"), `stdout ${secret}`, "utf8");
  await writeFile(join(stageDirectory, "stderr.log"), `stderr ${secret}`, "utf8");
  await writeFile(join(stageDirectory, "output.md"), artifactContent, "utf8");
  return runDirectory;
}

describe("evidence policy", () => {
  it("defaults every category to indefinite retention and validates a local policy", async () => {
    const repoPath = await createRepo();
    const defaults = await loadEvidencePolicy(repoPath);

    expect(defaults.source).toBe("default");
    expect(defaults.retention).toEqual({
      runsDays: null,
      eventsDays: null,
      logsDays: null,
      artifactsDays: null,
      evidenceDays: null,
    });

    await writeJson(evidencePolicyPath(repoPath), {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "EvidencePolicy",
      spec: {
        retention: {
          runsDays: 90,
          eventsDays: 365,
          logsDays: 30,
          artifactsDays: 60,
          evidenceDays: null,
        },
      },
    });

    const configured = await loadEvidencePolicy(repoPath);
    expect(configured.source).toBe("file");
    expect(configured.retention.eventsDays).toBe(365);
    expect(configured.effectiveRetention.artifactsDays).toBe(60);
    expect(configured.effectiveRetention.evidenceDays).toBe(90);
  });

  it("rejects invalid fields and event retention shorter than run retention", async () => {
    const repoPath = await createRepo();
    await writeJson(evidencePolicyPath(repoPath), {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "EvidencePolicy",
      spec: {
        retention: {
          runsDays: 90,
          eventsDays: 30,
          unexpected: true,
        },
      },
    });

    await expect(loadEvidencePolicy(repoPath)).rejects.toThrow(
      /invalid evidence policy/i,
    );

    await writeJson(evidencePolicyPath(repoPath), {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "EvidencePolicy",
      spec: { retention: { runsDays: 90, eventsDays: 30 } },
    });
    await expect(loadEvidencePolicy(repoPath)).rejects.toThrow(
      /eventsDays.*runsDays/i,
    );
  });
});

describe("evidence metadata search", () => {
  it("searches required run metadata and includes eventless run directories", async () => {
    const repoPath = await createRepo();
    await seedRun(repoPath, {
      runId: "run-alpha",
      taskId: "task-checkout",
      flowName: "release-flow",
      repositoryName: "payments-api",
      prUrl: "https://github.com/acme/payments/pull/42",
      createdAt: "2026-07-01T10:00:00.000Z",
      terminalAt: "2026-07-01T10:30:00.000Z",
    });
    await seedRun(repoPath, {
      runId: "run-beta",
      taskId: "task-ledger",
      flowName: "recovery-flow",
      repositoryName: "ledger-api",
      status: "blocked",
      blockerReason: "configuration_missing",
      createdAt: "2026-07-02T10:00:00.000Z",
      terminalAt: "2026-07-02T10:30:00.000Z",
    });

    const orphanDirectory = join(repoPath, ".nitely", "runs", "run-orphan");
    await writeJson(join(orphanDirectory, "run.json"), {
      runId: "run-orphan",
      workItemId: "task-orphan",
      flowName: "orphan-flow",
      repoName: "archive-repo",
      changeRequestUrl: "https://github.com/acme/archive/pull/7",
    });
    await writeJson(join(orphanDirectory, "artifacts.json"), {
      runId: "run-orphan",
      artifacts: [{
        id: "closeout-report",
        name: "Weekly closeout",
        producer: "report",
        mediaType: "text/markdown",
        sha256: "abc123",
      }],
    });

    expect((await searchEvidenceRuns(repoPath, { run: "alpha" })).map((run) => run.runId))
      .toEqual(["run-alpha"]);
    expect((await searchEvidenceRuns(repoPath, { task: "LEDGER" })).map((run) => run.runId))
      .toEqual(["run-beta"]);
    expect((await searchEvidenceRuns(repoPath, { repository: "payments" })).map((run) => run.runId))
      .toEqual(["run-alpha"]);
    expect((await searchEvidenceRuns(repoPath, { flow: "release" })).map((run) => run.runId))
      .toEqual(["run-alpha"]);
    expect((await searchEvidenceRuns(repoPath, { status: "blocked" })).map((run) => run.runId))
      .toEqual(["run-beta"]);
    expect((await searchEvidenceRuns(repoPath, { pr: "pull/42" })).map((run) => run.runId))
      .toEqual(["run-alpha"]);
    expect((await searchEvidenceRuns(repoPath, { blocker: "configuration" })).map((run) => run.runId))
      .toEqual(["run-beta"]);
    expect((await searchEvidenceRuns(repoPath, {
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-01T23:59:59.999Z",
    })).map((run) => run.runId)).toEqual(["run-alpha"]);
    const artifactMatches = await searchEvidenceRuns(repoPath, {
      artifact: "weekly closeout",
    });
    expect(artifactMatches).toEqual([
      expect.objectContaining({ runId: "run-orphan", status: "completed" }),
    ]);
  });

  it("uses canonical event Artifact fields while retaining registry-only evidence", async () => {
    const repoPath = await createRepo();
    const runDirectory = await seedRun(repoPath, {
      runId: "run-reconciled-evidence",
      createdAt: "2026-07-03T10:00:00.000Z",
      terminalAt: "2026-07-03T10:30:00.000Z",
    });
    const artifactContent = "artifact fixture-private-source";
    const eventSha256 = createHash("sha256").update(artifactContent).digest("hex");
    await writeJson(join(runDirectory, "artifacts.json"), {
      runId: "run-reconciled-evidence",
      artifacts: [
        {
          id: "implementation",
          name: "Stale registry summary",
          producer: "implement",
          mediaType: "text/plain",
          path: "stale/output.md",
          sha256: "f".repeat(64),
          size: 999,
        },
        {
          id: "registry-only",
          name: "Operator review note",
          producer: "review",
          mediaType: "text/markdown",
        },
      ],
    });

    const [record] = await searchEvidenceRuns(repoPath, {
      run: "run-reconciled-evidence",
    });

    expect(record?.artifacts).toEqual([
      expect.objectContaining({
        id: "implementation",
        name: "Implementation summary",
        producer: "implement",
        mediaType: "text/markdown",
        path: "stages/implement/1/output.md",
        sha256: eventSha256,
        size: Buffer.byteLength(artifactContent),
      }),
      expect.objectContaining({
        id: "registry-only",
        name: "Operator review note",
        producer: "review",
      }),
    ]);
  });
});

describe("evidence export", () => {
  it("builds a checksummed metadata-only package with no source or raw evidence", async () => {
    const repoPath = await createRepo();
    const secret = "private-source-export-sentinel";
    await seedRun(repoPath, {
      runId: "run-export",
      taskId: "task-closeout",
      flowName: "weekly-review",
      repositoryName: "billing-api",
      prUrl: "https://github.com/acme/billing/pull/18",
      createdAt: "2026-07-03T10:00:00.000Z",
      terminalAt: "2026-07-03T10:30:00.000Z",
      secret,
    });
    const outputPath = join(repoPath, "exports", "safe-closeout");

    const result = await exportEvidenceBundle({
      repoPath,
      runIds: ["run-export"],
      outputPath,
      generatedAt: "2026-07-14T00:00:00.000Z",
    });

    expect(result.rawIncluded).toBe(false);
    expect(await listFiles(outputPath)).toEqual([
      "checksums.sha256",
      "manifest.json",
      "runs/run-export.json",
      "summary.md",
    ]);
    const text = await bundleText(outputPath);
    expect(text).toContain("task-closeout");
    expect(text).toContain("https://github.com/acme/billing/pull/18");
    expect(text).toContain("unit-tests");
    expect(text).toContain("metadata-only");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("evidence private");
    expect(text).not.toContain("prompt private");
    expect(text).not.toContain("stdout private");
    expect(text).not.toContain("/private/source");
    expect(text).not.toContain("sourceUri");
    expect(text).not.toContain("artifact private");

    const checksums = await readFile(join(outputPath, "checksums.sha256"), "utf8");
    for (const path of ["manifest.json", "runs/run-export.json", "summary.md"]) {
      const digest = createHash("sha256")
        .update(await readFile(join(outputPath, path)))
        .digest("hex");
      expect(checksums).toContain(`${digest}  ${path}`);
    }
  });

  it("copies only recognized raw files after explicit opt-in and marks them sensitive", async () => {
    const repoPath = await createRepo();
    const secret = "raw-export-sentinel";
    const runDirectory = await seedRun(repoPath, {
      runId: "run-raw",
      createdAt: "2026-07-03T10:00:00.000Z",
      terminalAt: "2026-07-03T10:30:00.000Z",
      secret,
    });
    await mkdir(join(runDirectory, "inputs", "source"), { recursive: true });
    await writeFile(join(runDirectory, "inputs", "source", "content"), secret, "utf8");
    await mkdir(join(runDirectory, "worktree"), { recursive: true });
    await writeFile(join(runDirectory, "worktree", "source.ts"), secret, "utf8");
    await writeFile(join(runDirectory, "recovery.patch"), `recovery ${secret}`, "utf8");
    await writeJson(join(runDirectory, "recovery.json"), {
      version: 1,
      status: "available",
      patchPath: "recovery.patch",
    });
    await writeJson(join(runDirectory, "artifacts.json"), {
      runId: "run-raw",
      artifacts: [
        {
          id: "implementation",
          producer: "implement",
          mediaType: "text/markdown",
          path: "stages/implement/1/output.md",
        },
        {
          id: "unsafe-source-reference",
          producer: "implement",
          mediaType: "text/plain",
          path: "worktree/source.ts",
        },
      ],
    });
    const outputPath = join(repoPath, "exports", "raw-closeout");

    const result = await exportEvidenceBundle({
      repoPath,
      runIds: ["run-raw"],
      outputPath,
      includeRaw: true,
      generatedAt: "2026-07-14T00:00:00.000Z",
    });

    expect(result.rawIncluded).toBe(true);
    const files = await listFiles(outputPath);
    expect(files).toContain("RAW_CONTENT_WARNING.txt");
    expect(files).toContain("raw/run-raw/evidence.md");
    expect(files).toContain("raw/run-raw/stages/implement/1/prompt.md");
    expect(files).toContain("raw/run-raw/stages/implement/1/stdout.log");
    expect(files).toContain("raw/run-raw/stages/implement/1/output.md");
    expect(files).toContain("raw/run-raw/recovery.patch");
    expect(files).toContain("raw/run-raw/recovery.json");
    expect(files.some((path) => path.includes("inputs/source"))).toBe(false);
    expect(files.some((path) => path.includes("worktree/source.ts"))).toBe(false);
    expect(await readFile(join(outputPath, "RAW_CONTENT_WARNING.txt"), "utf8"))
      .toMatch(/sensitive.*not guaranteed.*redact/i);
    expect(await bundleText(outputPath)).toContain(secret);
  });

  it("exports canonical event integrity and registry-only raw Artifacts", async () => {
    const repoPath = await createRepo();
    const runDirectory = await seedRun(repoPath, {
      runId: "run-reconciled-raw",
      createdAt: "2026-07-03T10:00:00.000Z",
      terminalAt: "2026-07-03T10:30:00.000Z",
    });
    const reviewDirectory = join(runDirectory, "stages", "review", "1");
    await mkdir(reviewDirectory, { recursive: true });
    await writeFile(join(reviewDirectory, "operator-note.txt"), "approved\n", "utf8");
    await writeJson(join(runDirectory, "artifacts.json"), {
      runId: "run-reconciled-raw",
      artifacts: [
        {
          id: "implementation",
          producer: "implement",
          mediaType: "text/markdown",
          path: "stages/implement/1/output.md",
          sha256: "0".repeat(64),
        },
        {
          id: "operator-note",
          producer: "review",
          mediaType: "text/plain",
          path: "stages/review/1/operator-note.txt",
        },
      ],
    });
    const outputPath = join(repoPath, "exports", "reconciled-raw");

    const result = await exportEvidenceBundle({
      repoPath,
      runIds: ["run-reconciled-raw"],
      outputPath,
      includeRaw: true,
    });

    expect(result.files).toEqual(expect.arrayContaining([
      "raw/run-reconciled-raw/stages/implement/1/output.md",
      "raw/run-reconciled-raw/stages/review/1/operator-note.txt",
    ]));
    await expect(readFile(
      join(outputPath, "raw/run-reconciled-raw/stages/implement/1/output.md"),
      "utf8",
    )).resolves.toBe("artifact fixture-private-source");
  });

  it("exports registered raw Artifacts beyond the metadata display path limit", async () => {
    const repoPath = await createRepo();
    const runDirectory = await seedRun(repoPath, {
      runId: "run-long-artifact-path",
      createdAt: "2026-07-03T10:00:00.000Z",
      terminalAt: "2026-07-03T10:30:00.000Z",
    });
    const nestedPath = Array.from(
      { length: 24 },
      (_, index) => `segment-${String(index).padStart(2, "0")}-${"x".repeat(40)}`,
    );
    const artifactRelativePath = join(
      "stages",
      "archive",
      ...nestedPath,
      "artifact.bin",
    );
    expect(Buffer.byteLength(artifactRelativePath)).toBeGreaterThan(1_024);
    const artifactPath = join(runDirectory, artifactRelativePath);
    const content = Buffer.from("long-path evidence\n", "utf8");
    await mkdir(join(artifactPath, ".."), { recursive: true });
    await writeFile(artifactPath, content);
    await writeJson(join(runDirectory, "artifacts.json"), {
      runId: "run-long-artifact-path",
      artifacts: [{
        id: "long-path-artifact",
        producer: "archive",
        mediaType: "application/octet-stream",
        path: artifactRelativePath,
        sha256: createHash("sha256").update(content).digest("hex"),
        size: content.byteLength,
      }],
    });
    const outputPath = join(repoPath, "exports", "long-artifact-path");

    const result = await exportEvidenceBundle({
      repoPath,
      runIds: ["run-long-artifact-path"],
      outputPath,
      includeRaw: true,
    });

    const exportedRelativePath = join(
      "raw",
      "run-long-artifact-path",
      artifactRelativePath,
    );
    expect(result.files).toContain(exportedRelativePath);
    await expect(readFile(join(outputPath, exportedRelativePath)))
      .resolves.toEqual(content);
  });

  it("keeps registered paths redacted in metadata without losing raw Artifacts", async () => {
    const previousSecret = process.env.NITELY_ARTIFACT_SECRET_TOKEN;
    const secret = "artifact-path-secret";
    process.env.NITELY_ARTIFACT_SECRET_TOKEN = secret;
    try {
      const repoPath = await createRepo();
      const runDirectory = await seedRun(repoPath, {
        runId: "run-redacted-artifact-path",
        createdAt: "2026-07-03T10:00:00.000Z",
        terminalAt: "2026-07-03T10:30:00.000Z",
      });
      const artifactRelativePath = join(
        "stages",
        "review",
        "1",
        secret,
        "artifact.bin",
      );
      const artifactPath = join(runDirectory, artifactRelativePath);
      const content = Buffer.from("path-redaction evidence\n", "utf8");
      await mkdir(join(artifactPath, ".."), { recursive: true });
      await writeFile(artifactPath, content);
      await writeArtifactRegistry({
        runDirectory,
        boundaryRoot: repoPath,
        runId: "run-redacted-artifact-path",
        artifacts: [{
          id: "redacted-path-artifact",
          producer: "review",
          mediaType: "application/octet-stream",
          path: artifactRelativePath,
          sha256: createHash("sha256").update(content).digest("hex"),
          size: content.byteLength,
        }],
        redactionSecrets: [secret],
      });
      const store = new EventStore(eventStorePath(repoPath));
      store.append({
        runId: "run-redacted-artifact-path",
        stageId: "review",
        attempt: 1,
        type: "artifact.published",
        payload: {
          artifact: {
            id: "redacted-path-artifact",
            producer: "review",
            mediaType: "application/octet-stream",
            path: artifactRelativePath.replace(secret, "[REDACTED]"),
            sha256: createHash("sha256").update(content).digest("hex"),
            size: content.byteLength,
          },
        },
      });
      store.close();

      const metadataOutputPath = join(repoPath, "exports", "redacted-metadata");
      await exportEvidenceBundle({
        repoPath,
        runIds: ["run-redacted-artifact-path"],
        outputPath: metadataOutputPath,
      });
      expect(await bundleText(metadataOutputPath)).not.toContain(secret);

      const rawOutputPath = join(repoPath, "exports", "redacted-raw");
      const result = await exportEvidenceBundle({
        repoPath,
        runIds: ["run-redacted-artifact-path"],
        outputPath: rawOutputPath,
        includeRaw: true,
      });

      const exportedRelativePath = join(
        "raw",
        "run-redacted-artifact-path",
        artifactRelativePath,
      );
      expect(result.files).toContain(exportedRelativePath);
      await expect(readFile(join(rawOutputPath, exportedRelativePath)))
        .resolves.toEqual(content);
    } finally {
      if (previousSecret === undefined) {
        delete process.env.NITELY_ARTIFACT_SECRET_TOKEN;
      } else {
        process.env.NITELY_ARTIFACT_SECRET_TOKEN = previousSecret;
      }
    }
  });

  it("keeps integrity hashes structural when metadata redaction matches them", async () => {
    const repoPath = await createRepo();
    const runDirectory = await seedRun(repoPath, {
      runId: "run-redacted-artifact-hash",
      createdAt: "2026-07-03T10:00:00.000Z",
      terminalAt: "2026-07-03T10:30:00.000Z",
    });
    const artifactRelativePath = join(
      "stages",
      "archive",
      "1",
      "digest.bin",
    );
    const artifactPath = join(runDirectory, artifactRelativePath);
    const content = Buffer.from("hash-redaction evidence\n", "utf8");
    const sha256 = createHash("sha256").update(content).digest("hex");
    await mkdir(join(artifactPath, ".."), { recursive: true });
    await writeFile(artifactPath, content);
    await writeJson(join(runDirectory, "artifacts.json"), {
      runId: "run-redacted-artifact-hash",
      artifacts: [{
        id: "redacted-hash-artifact",
        producer: "archive",
        mediaType: "application/octet-stream",
        path: artifactRelativePath,
        sha256,
        size: content.byteLength,
      }],
    });

    const previousSecret = process.env.NITELY_ARTIFACT_SECRET_TOKEN;
    process.env.NITELY_ARTIFACT_SECRET_TOKEN = sha256.slice(0, 8);
    try {
      const outputPath = join(repoPath, "exports", "redacted-hash");

      const result = await exportEvidenceBundle({
        repoPath,
        runIds: ["run-redacted-artifact-hash"],
        outputPath,
        includeRaw: true,
      });

      const exportedRelativePath = join(
        "raw",
        "run-redacted-artifact-hash",
        artifactRelativePath,
      );
      expect(result.files).toContain(exportedRelativePath);
      await expect(readFile(join(outputPath, exportedRelativePath)))
        .resolves.toEqual(content);
    } finally {
      if (previousSecret === undefined) {
        delete process.env.NITELY_ARTIFACT_SECRET_TOKEN;
      } else {
        process.env.NITELY_ARTIFACT_SECRET_TOKEN = previousSecret;
      }
    }
  });

  it("rejects registered raw artifact paths outside the run and removes partial output", async () => {
    const repoPath = await createRepo();
    const runDirectory = await seedRun(repoPath, {
      runId: "run-escape",
      createdAt: "2026-07-03T10:00:00.000Z",
      terminalAt: "2026-07-03T10:30:00.000Z",
    });
    await writeJson(join(runDirectory, "artifacts.json"), {
      runId: "run-escape",
      artifacts: [{
        id: "escape",
        producer: "implement",
        mediaType: "text/plain",
        path: "../../outside.txt",
      }],
    });
    await writeFile(join(repoPath, ".nitely", "outside.txt"), "outside", "utf8");
    const outputPath = join(repoPath, "exports", "rejected");

    await expect(exportEvidenceBundle({
      repoPath,
      runIds: ["run-escape"],
      outputPath,
      includeRaw: true,
    })).rejects.toThrow(/escapes run directory/i);

    expect(await pathExists(outputPath)).toBe(false);
    expect(await readFile(join(repoPath, ".nitely", "outside.txt"), "utf8"))
      .toBe("outside");
  });

  it("rejects registered raw artifacts hard-linked outside the Run", async () => {
    const repoPath = await createRepo();
    const runDirectory = await seedRun(repoPath, {
      runId: "run-hard-link",
      createdAt: "2026-07-03T10:00:00.000Z",
      terminalAt: "2026-07-03T10:30:00.000Z",
    });
    const outsidePath = join(repoPath, "outside.txt");
    const artifactPath = join(runDirectory, "linked-output.md");
    await writeFile(outsidePath, "outside", "utf8");
    await link(outsidePath, artifactPath);
    await writeJson(join(runDirectory, "artifacts.json"), {
      runId: "run-hard-link",
      artifacts: [{
        id: "linked-output",
        producer: "implement",
        mediaType: "text/plain",
        path: "linked-output.md",
      }],
    });
    const outputPath = join(repoPath, "exports", "hard-link-rejected");

    await expect(exportEvidenceBundle({
      repoPath,
      runIds: ["run-hard-link"],
      outputPath,
      includeRaw: true,
    })).rejects.toThrow(/hard link/i);

    expect(await pathExists(outputPath)).toBe(false);
    expect(await readFile(outsidePath, "utf8")).toBe("outside");
  });

  it("preserves every registered integrity constraint for a shared raw path", async () => {
    const repoPath = await createRepo();
    const runDirectory = await seedRun(repoPath, {
      runId: "run-integrity",
      createdAt: "2026-07-03T10:00:00.000Z",
      terminalAt: "2026-07-03T10:30:00.000Z",
    });
    const artifactPath = join(
      runDirectory,
      "stages",
      "implement",
      "1",
      "output.md",
    );
    const artifactSize = (await stat(artifactPath)).size;
    await writeJson(join(runDirectory, "artifacts.json"), {
      runId: "run-integrity",
      artifacts: [
        {
          id: "constrained-output",
          producer: "implement",
          mediaType: "text/markdown",
          path: "stages/implement/1/output.md",
          sha256: "0".repeat(64),
          size: artifactSize,
        },
        {
          id: "unconstrained-alias",
          producer: "implement",
          mediaType: "text/markdown",
          path: "stages/implement/1/output.md",
        },
      ],
    });
    const outputPath = join(repoPath, "exports", "integrity-rejected");

    await expect(exportEvidenceBundle({
      repoPath,
      runIds: ["run-integrity"],
      outputPath,
      includeRaw: true,
    })).rejects.toThrow(/sha256/i);

    expect(await pathExists(outputPath)).toBe(false);
  });

  it("rejects recognized raw files hard-linked outside the Run", async () => {
    const repoPath = await createRepo();
    const runDirectory = await seedRun(repoPath, {
      runId: "run-raw-hard-link",
      createdAt: "2026-07-03T10:00:00.000Z",
      terminalAt: "2026-07-03T10:30:00.000Z",
    });
    const outsidePath = join(repoPath, "outside.log");
    const logDirectory = join(runDirectory, "stages", "verify", "1");
    await mkdir(logDirectory, { recursive: true });
    await writeFile(outsidePath, "outside raw evidence", "utf8");
    await link(outsidePath, join(logDirectory, "stdout.log"));
    const outputPath = join(repoPath, "exports", "raw-hard-link-rejected");

    await expect(exportEvidenceBundle({
      repoPath,
      runIds: ["run-raw-hard-link"],
      outputPath,
      includeRaw: true,
    })).rejects.toThrow(/hard link/i);

    expect(await pathExists(outputPath)).toBe(false);
    expect(await readFile(outsidePath, "utf8")).toBe("outside raw evidence");
  });

  it("rejects raw paths that would make the checksum manifest ambiguous", async () => {
    const repoPath = await createRepo();
    const runDirectory = await seedRun(repoPath, {
      runId: "run-unsafe-checksum-path",
      createdAt: "2026-07-03T10:00:00.000Z",
      terminalAt: "2026-07-03T10:30:00.000Z",
    });
    const unsafeDirectory = join(
      runDirectory,
      "stages",
      "forged\n000000  forged-entry",
      "1",
    );
    await mkdir(unsafeDirectory, { recursive: true });
    await writeFile(join(unsafeDirectory, "output.md"), "ambiguous", "utf8");
    const outputPath = join(repoPath, "exports", "unsafe-checksum-path");

    await expect(exportEvidenceBundle({
      repoPath,
      runIds: ["run-unsafe-checksum-path"],
      outputPath,
      includeRaw: true,
    })).rejects.toThrow(/checksum.*path|unsafe path/i);

    expect(await pathExists(outputPath)).toBe(false);
  });

  it("does not follow run metadata symlinks outside the run directory", async () => {
    const repoPath = await createRepo();
    const runDirectory = join(repoPath, ".nitely", "runs", "run-symlink");
    await mkdir(runDirectory, { recursive: true });
    const secret = "symlinked-private-metadata";
    const outsideRun = join(repoPath, "outside-run.json");
    const outsideArtifacts = join(repoPath, "outside-artifacts.json");
    await writeJson(outsideRun, {
      runId: "run-symlink",
      flowName: secret,
      completedStages: [secret],
    });
    await writeJson(outsideArtifacts, {
      runId: "run-symlink",
      artifacts: [{
        id: secret,
        producer: "outside",
        mediaType: "text/plain",
        sha256: secret,
      }],
    });
    await symlink(outsideRun, join(runDirectory, "run.json"));
    await symlink(outsideArtifacts, join(runDirectory, "artifacts.json"));
    const outputPath = join(repoPath, "exports", "symlink-safe");

    await exportEvidenceBundle({
      repoPath,
      runIds: ["run-symlink"],
      outputPath,
    });

    const text = await bundleText(outputPath);
    expect(text).toContain("run-symlink");
    expect(text).not.toContain(secret);
  });

  it("does not read run metadata hard-linked outside the Run", async () => {
    const repoPath = await createRepo();
    const runDirectory = join(
      repoPath,
      ".nitely",
      "runs",
      "run-hard-link-metadata",
    );
    await mkdir(runDirectory, { recursive: true });
    const secret = "hard-linked-private-metadata";
    const outsideRun = join(repoPath, "outside-run.json");
    const outsideArtifacts = join(repoPath, "outside-artifacts.json");
    await writeJson(outsideRun, {
      runId: "run-hard-link-metadata",
      flowName: secret,
      completedStages: [secret],
    });
    await writeJson(outsideArtifacts, {
      runId: "run-hard-link-metadata",
      artifacts: [{
        id: secret,
        producer: "outside",
        mediaType: "text/plain",
      }],
    });
    await link(outsideRun, join(runDirectory, "run.json"));
    await link(outsideArtifacts, join(runDirectory, "artifacts.json"));
    const outputPath = join(repoPath, "exports", "hard-link-metadata-safe");

    await exportEvidenceBundle({
      repoPath,
      runIds: ["run-hard-link-metadata"],
      outputPath,
    });

    const text = await bundleText(outputPath);
    expect(text).toContain("run-hard-link-metadata");
    expect(text).not.toContain(secret);
  });

  it("rejects an output parent symlink that resolves inside the run root", async () => {
    const repoPath = await createRepo();
    await seedRun(repoPath, {
      runId: "run-output-boundary",
      createdAt: "2026-07-03T10:00:00.000Z",
      terminalAt: "2026-07-03T10:30:00.000Z",
    });
    const linkedParent = join(repoPath, "linked-export-parent");
    await symlink(join(repoPath, ".nitely", "runs"), linkedParent);

    await expect(exportEvidenceBundle({
      repoPath,
      runIds: ["run-output-boundary"],
      outputPath: join(linkedParent, "unsafe-bundle"),
    })).rejects.toThrow(/outside \.nitely\/runs/i);

    expect(await pathExists(join(repoPath, ".nitely", "runs", "unsafe-bundle")))
      .toBe(false);
  });
});

describe("evidence retention", () => {
  it("dry-runs category cleanup, preserves active runs, and applies only explicit plans", async () => {
    const repoPath = await createRepo();
    const oldDirectory = await seedRun(repoPath, {
      runId: "run-old",
      createdAt: "2025-12-31T23:00:00.000Z",
      terminalAt: "2026-01-01T00:00:00.000Z",
    });
    const componentDirectory = await seedRun(repoPath, {
      runId: "run-components",
      createdAt: "2026-04-30T23:00:00.000Z",
      terminalAt: "2026-05-01T00:00:00.000Z",
    });
    const activeDirectory = await seedRun(repoPath, {
      runId: "run-active",
      status: "running",
      createdAt: "2025-12-01T00:00:00.000Z",
    });
    await mkdir(join(componentDirectory, "worktree"), { recursive: true });
    await writeFile(
      join(componentDirectory, "worktree", "registered-source.ts"),
      "must remain until whole-run removal",
      "utf8",
    );
    await writeJson(join(componentDirectory, "artifacts.json"), {
      runId: "run-components",
      artifacts: [
        {
          id: "implementation",
          producer: "implement",
          mediaType: "text/markdown",
          path: "stages/implement/1/output.md",
        },
        {
          id: "unsafe-source-reference",
          producer: "implement",
          mediaType: "text/plain",
          path: "worktree/registered-source.ts",
        },
      ],
    });
    await writeFile(join(componentDirectory, "recovery.patch"), "partial source diff", "utf8");
    await writeJson(join(componentDirectory, "recovery.json"), {
      version: 1,
      status: "available",
      patchPath: "recovery.patch",
    });
    const resumedDirectory = await seedRun(repoPath, {
      runId: "run-resumed-active",
      status: "blocked",
      createdAt: "2025-12-01T00:00:00.000Z",
      terminalAt: "2026-01-01T00:00:00.000Z",
    });
    const resumedStore = new EventStore(eventStorePath(repoPath));
    resumedStore.append({
      runId: "run-resumed-active",
      stageId: "implement",
      attempt: 2,
      type: "stage.started",
      createdAt: "2026-01-02T00:00:00.000Z",
      payload: {
        attemptDirectory: join(
          resumedDirectory,
          "stages",
          "implement",
          "2",
        ),
        resumedFrom: "blocked",
      },
    });
    resumedStore.close();
    await writeJson(evidencePolicyPath(repoPath), {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "EvidencePolicy",
      spec: {
        retention: {
          runsDays: 90,
          eventsDays: 180,
          logsDays: 30,
          artifactsDays: 60,
          evidenceDays: 90,
        },
      },
    });

    const plan = await buildEvidencePrunePlan({
      repoPath,
      now: new Date("2026-07-14T00:00:00.000Z"),
    });

    expect(plan.mode).toBe("dry-run");
    expect(plan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: "run-old", category: "runs" }),
      expect.objectContaining({ runId: "run-old", category: "events" }),
      expect.objectContaining({ runId: "run-components", category: "logs" }),
      expect.objectContaining({ runId: "run-components", category: "artifacts" }),
    ]));
    expect(plan.actions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: "run-old", category: "logs" }),
      expect.objectContaining({ runId: "run-components", category: "evidence" }),
      expect.objectContaining({ runId: "run-active" }),
      expect.objectContaining({ runId: "run-resumed-active" }),
    ]));

    expect(await pathExists(oldDirectory)).toBe(true);
    expect(await pathExists(join(componentDirectory, "stages", "implement", "1", "stdout.log")))
      .toBe(true);
    const storeBefore = new EventStore(eventStorePath(repoPath));
    expect(storeBefore.list("run-old").length).toBeGreaterThan(0);
    storeBefore.close();

    const result = await applyEvidencePrunePlan(plan);
    expect(result.applied.length).toBe(plan.actions.length);
    expect(result.skipped).toEqual([]);

    expect(await pathExists(oldDirectory)).toBe(false);
    expect(await pathExists(join(componentDirectory, "stages", "implement", "1", "stdout.log")))
      .toBe(false);
    expect(await pathExists(join(componentDirectory, "artifacts.json"))).toBe(false);
    expect(await pathExists(join(componentDirectory, "recovery.patch"))).toBe(false);
    expect(await pathExists(join(componentDirectory, "recovery.json"))).toBe(false);
    expect(await pathExists(join(componentDirectory, "stages", "implement", "1", "output.md")))
      .toBe(false);
    expect(await pathExists(join(componentDirectory, "evidence.md"))).toBe(true);
    expect(await pathExists(join(componentDirectory, "stages", "implement", "1", "prompt.md")))
      .toBe(true);
    expect(await pathExists(join(componentDirectory, "worktree", "registered-source.ts")))
      .toBe(true);
    expect(await pathExists(activeDirectory)).toBe(true);
    expect((await stat(activeDirectory)).isDirectory()).toBe(true);
    expect(await pathExists(resumedDirectory)).toBe(true);

    const storeAfter = new EventStore(eventStorePath(repoPath));
    expect(storeAfter.list("run-old")).toEqual([]);
    expect(storeAfter.list("run-components").length).toBeGreaterThan(0);
    expect(storeAfter.list("run-active").length).toBeGreaterThan(0);
    expect(storeAfter.list("run-resumed-active").length).toBeGreaterThan(0);
    storeAfter.close();
  });

  it("unions current public and event paths for the same Artifact identity", async () => {
    const repoPath = await createRepo();
    const runDirectory = await seedRun(repoPath, {
      runId: "run-artifact-path-union",
      createdAt: "2026-01-01T00:00:00.000Z",
      terminalAt: "2026-01-01T01:00:00.000Z",
    });
    const publicRelativePath = "stages/implement/1/registry-only.md";
    const publicArtifactPath = join(runDirectory, publicRelativePath);
    await writeFile(publicArtifactPath, "registry-only bytes", "utf8");
    await writeJson(join(runDirectory, "artifacts.json"), {
      runId: "run-artifact-path-union",
      artifacts: [{
        id: "implementation",
        producer: "implement",
        mediaType: "text/markdown",
        path: publicRelativePath,
      }],
    });
    await writeJson(evidencePolicyPath(repoPath), {
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
    });

    const eventArtifactPath = join(
      runDirectory,
      "stages",
      "implement",
      "1",
      "output.md",
    );
    const registryPath = join(runDirectory, "artifacts.json");
    const plan = await buildEvidencePrunePlan({
      repoPath,
      now: new Date("2026-07-14T00:00:00.000Z"),
    });
    const artifactAction = plan.actions.find(
      (action) => action.runId === "run-artifact-path-union" &&
        action.category === "artifacts",
    );
    expect(artifactAction?.paths).toEqual(expect.arrayContaining([
      publicArtifactPath,
      eventArtifactPath,
      registryPath,
    ]));
    const prunePaths = artifactAction?.paths ?? [];
    expect(prunePaths.indexOf(publicArtifactPath)).toBeLessThan(
      prunePaths.indexOf(registryPath),
    );
    expect(prunePaths.indexOf(eventArtifactPath)).toBeLessThan(
      prunePaths.indexOf(registryPath),
    );

    await applyEvidencePrunePlan(plan);
    expect(await pathExists(publicArtifactPath)).toBe(false);
    expect(await pathExists(eventArtifactPath)).toBe(false);
    expect(await pathExists(registryPath)).toBe(false);
  });

  it("applies rebuilt canonical Artifact ordering instead of caller path ordering", async () => {
    const repoPath = await createRepo();
    const runDirectory = await seedRun(repoPath, {
      runId: "run-canonical-retention-order",
      createdAt: "2026-01-01T00:00:00.000Z",
      terminalAt: "2026-01-01T01:00:00.000Z",
    });
    await writeJson(evidencePolicyPath(repoPath), {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "EvidencePolicy",
      spec: {
        retention: {
          runsDays: null,
          eventsDays: 0,
          logsDays: null,
          artifactsDays: 0,
          evidenceDays: null,
        },
      },
    });
    const plan = await buildEvidencePrunePlan({
      repoPath,
      now: new Date("2026-01-02T00:00:00.000Z"),
    });
    const canonicalAction = plan.actions.find(
      (action) => action.runId === "run-canonical-retention-order" &&
        action.category === "artifacts",
    );
    expect(canonicalAction).toBeDefined();
    const reversedPlan = {
      ...plan,
      actions: [...plan.actions].reverse().map((action) =>
        action === canonicalAction
          ? { ...action, paths: [...action.paths].reverse() }
          : action
      ),
    };

    const result = await applyEvidencePrunePlan(reversedPlan);
    const appliedAction = result.applied.find(
      (action) => action.runId === "run-canonical-retention-order" &&
        action.category === "artifacts",
    );
    expect(appliedAction?.paths).toEqual(canonicalAction?.paths);
    expect(result.applied.filter((action) =>
      action.runId === "run-canonical-retention-order"
    ).map((action) => action.category)).toEqual(["artifacts", "events"]);
    expect(await pathExists(join(
      runDirectory,
      "stages",
      "implement",
      "1",
      "output.md",
    ))).toBe(false);
    expect(await pathExists(join(runDirectory, "artifacts.json"))).toBe(false);
  });

  it("retains event-only Artifact indexes until later Artifact retention removes the bytes", async () => {
    const repoPath = await createRepo();
    const runDirectory = await seedRun(repoPath, {
      runId: "run-event-index-retention",
      createdAt: "2026-01-01T00:00:00.000Z",
      terminalAt: "2026-01-01T01:00:00.000Z",
    });
    const eventRelativePath = "stages/archive/1/event-index-only.bin";
    const eventArtifactPath = join(runDirectory, eventRelativePath);
    const content = Buffer.from("event-index-only bytes", "utf8");
    await mkdir(join(eventArtifactPath, ".."), { recursive: true });
    await writeFile(eventArtifactPath, content);
    const store = new EventStore(eventStorePath(repoPath));
    store.append({
      runId: "run-event-index-retention",
      stageId: "archive",
      attempt: 1,
      type: "artifact.published",
      createdAt: "2026-01-01T01:30:00.000Z",
      payload: {
        artifact: {
          id: "event-index-only",
          producer: "archive",
          mediaType: "application/octet-stream",
          path: eventRelativePath,
          sha256: createHash("sha256").update(content).digest("hex"),
          size: content.byteLength,
        },
      },
    });
    const initialEventCount = store.list("run-event-index-retention").length;
    store.close();
    await writeJson(evidencePolicyPath(repoPath), {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "EvidencePolicy",
      spec: {
        retention: {
          runsDays: null,
          eventsDays: 0,
          logsDays: null,
          artifactsDays: 30,
          evidenceDays: null,
        },
      },
    });

    const earlyPlan = await buildEvidencePrunePlan({
      repoPath,
      now: new Date("2026-01-02T00:00:00.000Z"),
    });
    for (const category of ["artifacts", "events"]) {
      expect(earlyPlan.actions.find(
        (action) => action.runId === "run-event-index-retention" &&
          action.category === category,
      )).toBeUndefined();
    }
    await applyEvidencePrunePlan(earlyPlan);
    const earlyStore = new EventStore(eventStorePath(repoPath));
    expect(earlyStore.list("run-event-index-retention")).toHaveLength(
      initialEventCount,
    );
    earlyStore.close();
    expect(await pathExists(eventArtifactPath)).toBe(true);

    const artifactPlan = await buildEvidencePrunePlan({
      repoPath,
      now: new Date("2026-02-02T00:00:00.000Z"),
    });
    expect(artifactPlan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: "run-event-index-retention",
        category: "artifacts",
      }),
    ]));
    expect(artifactPlan.actions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: "run-event-index-retention",
        category: "events",
      }),
    ]));
    await applyEvidencePrunePlan(artifactPlan);
    expect(await pathExists(eventArtifactPath)).toBe(false);
    const retainedStore = new EventStore(eventStorePath(repoPath));
    expect(retainedStore.list("run-event-index-retention")).toHaveLength(
      initialEventCount,
    );
    retainedStore.close();

    const eventPlan = await buildEvidencePrunePlan({
      repoPath,
      now: new Date("2026-02-02T00:00:00.000Z"),
    });
    expect(eventPlan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: "run-event-index-retention",
        category: "events",
      }),
    ]));
    await applyEvidencePrunePlan(eventPlan);
    const finalStore = new EventStore(eventStorePath(repoPath));
    expect(finalStore.list("run-event-index-retention")).toEqual([]);
    finalStore.close();
  });

  it("retains events while an event-only Artifact has an unsafe hard link", async () => {
    const repoPath = await createRepo();
    const runDirectory = await seedRun(repoPath, {
      runId: "run-event-hard-link-retention",
      createdAt: "2026-01-01T00:00:00.000Z",
      terminalAt: "2026-01-01T01:00:00.000Z",
    });
    const eventRelativePath = "stages/archive/1/event-hard-link.bin";
    const eventArtifactPath = join(runDirectory, eventRelativePath);
    const content = Buffer.from("hard-linked event-only bytes", "utf8");
    await mkdir(join(eventArtifactPath, ".."), { recursive: true });
    await writeFile(eventArtifactPath, content);
    const outsidePath = join(repoPath, "event-hard-link.bin");
    await link(eventArtifactPath, outsidePath);
    const store = new EventStore(eventStorePath(repoPath));
    store.append({
      runId: "run-event-hard-link-retention",
      stageId: "archive",
      attempt: 1,
      type: "artifact.published",
      createdAt: "2026-01-01T01:30:00.000Z",
      payload: {
        artifact: {
          id: "event-hard-link",
          producer: "archive",
          mediaType: "application/octet-stream",
          path: eventRelativePath,
          sha256: createHash("sha256").update(content).digest("hex"),
          size: content.byteLength,
        },
      },
    });
    const initialEventCount = store.list("run-event-hard-link-retention").length;
    store.close();
    await writeJson(evidencePolicyPath(repoPath), {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "EvidencePolicy",
      spec: {
        retention: {
          runsDays: null,
          eventsDays: 0,
          logsDays: null,
          artifactsDays: 0,
          evidenceDays: null,
        },
      },
    });

    const unsafePlan = await buildEvidencePrunePlan({
      repoPath,
      now: new Date("2026-01-02T00:00:00.000Z"),
    });
    for (const category of ["artifacts", "events"]) {
      expect(unsafePlan.actions.find(
        (action) => action.runId === "run-event-hard-link-retention" &&
          action.category === category,
      )).toBeUndefined();
    }
    await applyEvidencePrunePlan(unsafePlan);
    expect(await pathExists(eventArtifactPath)).toBe(true);
    expect(await pathExists(join(runDirectory, "artifacts.json"))).toBe(true);
    const unsafeStore = new EventStore(eventStorePath(repoPath));
    expect(unsafeStore.list("run-event-hard-link-retention")).toHaveLength(
      initialEventCount,
    );
    unsafeStore.close();

    await rm(outsidePath);
    const safeArtifactPlan = await buildEvidencePrunePlan({
      repoPath,
      now: new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(safeArtifactPlan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: "run-event-hard-link-retention",
        category: "artifacts",
      }),
    ]));
    expect(safeArtifactPlan.actions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: "run-event-hard-link-retention",
        category: "events",
      }),
    ]));
    await applyEvidencePrunePlan(safeArtifactPlan);
    expect(await pathExists(eventArtifactPath)).toBe(false);

    const finalEventPlan = await buildEvidencePrunePlan({
      repoPath,
      now: new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(finalEventPlan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: "run-event-hard-link-retention",
        category: "events",
      }),
    ]));
    await applyEvidencePrunePlan(finalEventPlan);
    const finalStore = new EventStore(eventStorePath(repoPath));
    expect(finalStore.list("run-event-hard-link-retention")).toEqual([]);
    finalStore.close();
  });

  it("retains events while an event-only removal residue is unsafe", async () => {
    const repoPath = await createRepo();
    const runDirectory = await seedRun(repoPath, {
      runId: "run-event-removal-residue",
      createdAt: "2026-01-01T00:00:00.000Z",
      terminalAt: "2026-01-01T01:00:00.000Z",
    });
    const eventRelativePath = "stages/archive/1/removing-output.bin";
    const eventArtifactPath = join(runDirectory, eventRelativePath);
    await mkdir(join(eventArtifactPath, ".."), { recursive: true });
    await writeFile(eventArtifactPath, "removing event bytes", "utf8");
    const store = new EventStore(eventStorePath(repoPath));
    store.append({
      runId: "run-event-removal-residue",
      stageId: "archive",
      attempt: 1,
      type: "artifact.published",
      createdAt: "2026-01-01T01:30:00.000Z",
      payload: {
        artifact: {
          id: "removing-event-output",
          producer: "archive",
          mediaType: "application/octet-stream",
          path: eventRelativePath,
        },
      },
    });
    store.append({
      runId: "run-event-removal-residue",
      type: "run.completed",
      createdAt: "2026-01-01T02:00:00.000Z",
      payload: {},
    });
    const initialEventCount = store.list("run-event-removal-residue").length;
    store.close();
    const removingPath = join(
      eventArtifactPath,
      "..",
      ".removing-output.bin.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.removing",
    );
    await rename(eventArtifactPath, removingPath);
    const outsidePath = join(repoPath, "removing-output-hard-link.bin");
    await link(removingPath, outsidePath);
    await writeJson(evidencePolicyPath(repoPath), {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "EvidencePolicy",
      spec: { retention: {
        runsDays: null,
        eventsDays: 0,
        logsDays: null,
        artifactsDays: 0,
        evidenceDays: null,
      } },
    });

    const unsafePlan = await buildEvidencePrunePlan({
      repoPath,
      now: new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(unsafePlan.actions.find((action) =>
      action.runId === "run-event-removal-residue" &&
      (action.category === "artifacts" || action.category === "events")
    )).toBeUndefined();
    const retainedStore = new EventStore(eventStorePath(repoPath));
    expect(retainedStore.list("run-event-removal-residue")).toHaveLength(
      initialEventCount,
    );
    retainedStore.close();

    await rm(outsidePath);
    const artifactPlan = await buildEvidencePrunePlan({
      repoPath,
      now: new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(artifactPlan.actions.find((action) =>
      action.runId === "run-event-removal-residue" &&
      action.category === "artifacts"
    )?.paths).toContain(removingPath);
    expect(artifactPlan.actions.find((action) =>
      action.runId === "run-event-removal-residue" &&
      action.category === "events"
    )).toBeUndefined();
    await applyEvidencePrunePlan(artifactPlan);
    expect(await pathExists(removingPath)).toBe(false);

    const eventPlan = await buildEvidencePrunePlan({
      repoPath,
      now: new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(eventPlan.actions.find((action) =>
      action.runId === "run-event-removal-residue" &&
      action.category === "events"
    )).toBeDefined();
    await applyEvidencePrunePlan(eventPlan);
    const finalStore = new EventStore(eventStorePath(repoPath));
    expect(finalStore.list("run-event-removal-residue")).toEqual([]);
    finalStore.close();
  });

  it("does not retain events solely for source-directory Artifact paths", async () => {
    const repoPath = await createRepo();
    const runDirectory = await seedRun(repoPath, {
      runId: "run-event-source-retention",
      createdAt: "2026-01-01T00:00:00.000Z",
      terminalAt: "2026-01-01T01:00:00.000Z",
    });
    const sourceRelativePath = "worktree/event-source.ts";
    const sourcePath = join(runDirectory, sourceRelativePath);
    await mkdir(join(sourcePath, ".."), { recursive: true });
    await writeFile(sourcePath, "source bytes", "utf8");
    const store = new EventStore(eventStorePath(repoPath));
    store.append({
      runId: "run-event-source-retention",
      stageId: "implement",
      attempt: 1,
      type: "artifact.published",
      createdAt: "2026-01-01T01:30:00.000Z",
      payload: {
        artifact: {
          id: "event-source",
          producer: "implement",
          mediaType: "text/plain",
          path: sourceRelativePath,
        },
      },
    });
    store.close();
    await writeJson(evidencePolicyPath(repoPath), {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "EvidencePolicy",
      spec: {
        retention: {
          runsDays: null,
          eventsDays: 0,
          logsDays: null,
          artifactsDays: null,
          evidenceDays: null,
        },
      },
    });

    const plan = await buildEvidencePrunePlan({
      repoPath,
      now: new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(plan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: "run-event-source-retention",
        category: "events",
      }),
    ]));
    await applyEvidencePrunePlan(plan);
    expect(await pathExists(sourcePath)).toBe(true);
    const finalStore = new EventStore(eventStorePath(repoPath));
    expect(finalStore.list("run-event-source-retention")).toEqual([]);
    finalStore.close();
  });

  it("prunes reconciled, event-only, and orphan-private Artifacts before every index", async () => {
    const repoPath = await createRepo();
    const runDirectory = await seedRun(repoPath, {
      runId: "run-private-retention",
      createdAt: "2026-01-01T00:00:00.000Z",
      terminalAt: "2026-01-01T01:00:00.000Z",
    });
    const artifactRelativePath =
      "stages/archive/1/secret=retention-private-value/artifact.bin";
    const artifactPath = join(runDirectory, artifactRelativePath);
    const content = Buffer.from("retained private bytes\n", "utf8");
    await mkdir(join(artifactPath, ".."), { recursive: true });
    await writeFile(artifactPath, content);
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-private-retention",
      artifacts: [{
        id: "private-retained",
        producer: "archive",
        mediaType: "application/octet-stream",
        path: artifactRelativePath,
        sha256: createHash("sha256").update(content).digest("hex"),
        size: content.byteLength,
      }],
      redactionSecrets: [],
    });
    const currentPrivateRegistryPaths = await privateRegistryPaths(runDirectory);
    expect(currentPrivateRegistryPaths).toHaveLength(1);
    const privateRegistryPath = currentPrivateRegistryPaths[0] as string;
    expect(await readFile(privateRegistryPath, "utf8"))
      .toContain("retention-private-value");
    expect(await readFile(join(runDirectory, "artifacts.json"), "utf8"))
      .not.toContain("retention-private-value");

    const eventOnlyRelativePath = "stages/archive/1/event-only/artifact.bin";
    const eventOnlyPath = join(runDirectory, eventOnlyRelativePath);
    const eventOnlyContent = Buffer.from("event-only retained bytes\n", "utf8");
    await mkdir(join(eventOnlyPath, ".."), { recursive: true });
    await writeFile(eventOnlyPath, eventOnlyContent);
    const store = new EventStore(eventStorePath(repoPath));
    store.append({
      runId: "run-private-retention",
      stageId: "archive",
      attempt: 1,
      type: "artifact.published",
      createdAt: "2026-01-01T01:30:00.000Z",
      payload: {
        artifact: {
          id: "event-only-retained",
          producer: "archive",
          mediaType: "application/octet-stream",
          path: eventOnlyRelativePath,
          sha256: createHash("sha256").update(eventOnlyContent).digest("hex"),
          size: eventOnlyContent.byteLength,
        },
      },
    });
    store.close();

    const orphanRelativePath =
      "stages/archive/1/orphan-private/artifact.bin";
    const orphanArtifactPath = join(runDirectory, orphanRelativePath);
    await mkdir(join(orphanArtifactPath, ".."), { recursive: true });
    await writeFile(orphanArtifactPath, "orphan private bytes\n", "utf8");
    const currentPrivateRegistry = JSON.parse(
      await readFile(privateRegistryPath, "utf8"),
    ) as {
      privatePathRef: string;
      artifacts: Array<Record<string, unknown>>;
    };
    const availableRefs = ["a", "b", "c", "d", "e", "f"]
      .map((character) => character.repeat(32))
      .filter((ref) => ref !== currentPrivateRegistry.privatePathRef);
    const [orphanRef, completeTemporaryRef, truncatedTemporaryRef] =
      availableRefs as [string, string, string];
    const orphanPrivateRegistryPath = join(
      runDirectory,
      `artifact-paths.private.${orphanRef}.json`,
    );
    await writeJson(orphanPrivateRegistryPath, {
      ...currentPrivateRegistry,
      privatePathRef: orphanRef,
      artifacts: [{
        ...(currentPrivateRegistry.artifacts[0] ?? {}),
        path: orphanRelativePath,
      }],
    });

    const temporaryRelativePath =
      "stages/archive/1/complete-private-temporary/artifact.bin";
    const temporaryArtifactPath = join(runDirectory, temporaryRelativePath);
    await mkdir(join(temporaryArtifactPath, ".."), { recursive: true });
    await writeFile(temporaryArtifactPath, "temporary private bytes\n", "utf8");
    const completePrivateTemporaryPath = join(
      runDirectory,
      `.artifact-paths.private.${completeTemporaryRef}.json.` +
        "11111111-1111-4111-8111-111111111111.tmp",
    );
    await writeJson(completePrivateTemporaryPath, {
      ...currentPrivateRegistry,
      privatePathRef: completeTemporaryRef,
      artifacts: [{
        ...(currentPrivateRegistry.artifacts[0] ?? {}),
        path: temporaryRelativePath,
      }],
    });
    const truncatedPrivateTemporaryPath = join(
      runDirectory,
      `.artifact-paths.private.${truncatedTemporaryRef}.json.` +
        "22222222-2222-4222-8222-222222222222.tmp",
    );
    await writeFile(truncatedPrivateTemporaryPath, '{"schemaVersion":', "utf8");
    const publicTemporaryPath = join(
      runDirectory,
      ".artifacts.json.33333333-3333-4333-8333-333333333333.tmp",
    );
    await writeFile(
      publicTemporaryPath,
      await readFile(join(runDirectory, "artifacts.json")),
    );
    await writeFile(join(runDirectory, "recovery.patch"), "recover me", "utf8");
    await writeJson(join(runDirectory, "recovery.json"), {
      version: 1,
      status: "available",
      patchPath: "recovery.patch",
    });
    await writeJson(evidencePolicyPath(repoPath), {
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
    });

    const plan = await buildEvidencePrunePlan({
      repoPath,
      now: new Date("2026-07-14T00:00:00.000Z"),
    });
    const artifactAction = plan.actions.find(
      (action) => action.runId === "run-private-retention" &&
        action.category === "artifacts",
    );
    expect(artifactAction?.paths).toEqual(expect.arrayContaining([
      artifactPath,
      eventOnlyPath,
      orphanArtifactPath,
      temporaryArtifactPath,
      join(runDirectory, "recovery.json"),
      join(runDirectory, "recovery.patch"),
      join(runDirectory, "artifacts.json"),
      publicTemporaryPath,
      privateRegistryPath,
      orphanPrivateRegistryPath,
      completePrivateTemporaryPath,
      truncatedPrivateTemporaryPath,
    ]));
    const prunePaths = artifactAction?.paths ?? [];
    const publicRegistryPath = join(runDirectory, "artifacts.json");
    for (
      const materializedPath of [
        artifactPath,
        eventOnlyPath,
        orphanArtifactPath,
        temporaryArtifactPath,
        join(runDirectory, "recovery.json"),
        join(runDirectory, "recovery.patch"),
      ]
    ) {
      expect(prunePaths.indexOf(materializedPath)).toBeLessThan(
        prunePaths.indexOf(publicRegistryPath),
      );
      expect(prunePaths.indexOf(materializedPath)).toBeLessThan(
        prunePaths.indexOf(publicTemporaryPath),
      );
    }
    for (
      const privatePath of [
        privateRegistryPath,
        orphanPrivateRegistryPath,
        completePrivateTemporaryPath,
        truncatedPrivateTemporaryPath,
      ]
    ) {
      expect(prunePaths.indexOf(publicRegistryPath)).toBeLessThan(
        prunePaths.indexOf(privatePath),
      );
      expect(prunePaths.indexOf(publicTemporaryPath)).toBeLessThan(
        prunePaths.indexOf(privatePath),
      );
    }

    await applyEvidencePrunePlan(plan);
    expect(await pathExists(artifactPath)).toBe(false);
    expect(await pathExists(eventOnlyPath)).toBe(false);
    expect(await pathExists(orphanArtifactPath)).toBe(false);
    expect(await pathExists(temporaryArtifactPath)).toBe(false);
    expect(await pathExists(publicRegistryPath)).toBe(false);
    expect(await pathExists(publicTemporaryPath)).toBe(false);
    expect(await pathExists(privateRegistryPath)).toBe(false);
    expect(await pathExists(orphanPrivateRegistryPath)).toBe(false);
    expect(await pathExists(completePrivateTemporaryPath)).toBe(false);
    expect(await pathExists(truncatedPrivateTemporaryPath)).toBe(false);
  });

  it("preserves all Artifact indexes until a hard link becomes safe to prune", async () => {
    const repoPath = await createRepo();
    const runDirectory = await seedRun(repoPath, {
      runId: "run-hard-link-retention",
      createdAt: "2026-01-01T00:00:00.000Z",
      terminalAt: "2026-01-01T01:00:00.000Z",
    });
    const artifactRelativePath = "stages/archive/1/linked-output.bin";
    const artifactPath = join(runDirectory, artifactRelativePath);
    const content = Buffer.from("retain me", "utf8");
    await mkdir(join(artifactPath, ".."), { recursive: true });
    await writeFile(artifactPath, content);
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-hard-link-retention",
      artifacts: [{
        id: "linked-output",
        producer: "archive",
        mediaType: "text/plain",
        path: artifactRelativePath,
        sha256: createHash("sha256").update(content).digest("hex"),
        size: content.byteLength,
      }],
      redactionSecrets: [],
    });
    const currentPrivateRegistryPaths = await privateRegistryPaths(runDirectory);
    expect(currentPrivateRegistryPaths).toHaveLength(1);
    const privateRegistryPath = currentPrivateRegistryPaths[0] as string;
    const publicRegistryPath = join(runDirectory, "artifacts.json");
    const outsidePath = join(repoPath, "outside-retained.txt");
    await link(artifactPath, outsidePath);
    await writeJson(evidencePolicyPath(repoPath), {
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
    });

    const firstPlan = await buildEvidencePrunePlan({
      repoPath,
      now: new Date("2026-07-14T00:00:00.000Z"),
    });
    const unsafeArtifactAction = firstPlan.actions.find(
      (action) => action.category === "artifacts",
    );

    expect(unsafeArtifactAction).toBeUndefined();
    await applyEvidencePrunePlan(firstPlan);
    expect(await pathExists(artifactPath)).toBe(true);
    expect(await pathExists(publicRegistryPath)).toBe(true);
    expect(await pathExists(privateRegistryPath)).toBe(true);
    expect(await readFile(outsidePath, "utf8")).toBe("retain me");

    await rm(outsidePath);
    const retryPlan = await buildEvidencePrunePlan({
      repoPath,
      now: new Date("2026-07-14T00:00:00.000Z"),
    });
    const retryArtifactAction = retryPlan.actions.find(
      (action) => action.category === "artifacts",
    );
    expect(retryArtifactAction?.paths).toEqual(expect.arrayContaining([
      artifactPath,
      publicRegistryPath,
      privateRegistryPath,
    ]));

    const retryResult = await applyEvidencePrunePlan(retryPlan);
    expect(retryResult.skipped).toEqual([]);
    expect(await pathExists(artifactPath)).toBe(false);
    expect(await pathExists(publicRegistryPath)).toBe(false);
    expect(await pathExists(privateRegistryPath)).toBe(false);
  });

  it("prunes every published path when one Artifact identity is rematerialized", async () => {
    const repoPath = await createRepo();
    const runDirectory = await seedRun(repoPath, {
      runId: "run-event-materialization-history",
      createdAt: "2026-01-01T00:00:00.000Z",
      terminalAt: "2026-01-01T01:00:00.000Z",
    });
    const firstRelativePath = "stages/archive/1/first-materialization.bin";
    const secondRelativePath = "stages/archive/2/second-materialization.bin";
    const firstPath = join(runDirectory, firstRelativePath);
    const secondPath = join(runDirectory, secondRelativePath);
    await mkdir(join(firstPath, ".."), { recursive: true });
    await mkdir(join(secondPath, ".."), { recursive: true });
    await writeFile(firstPath, "first materialization", "utf8");
    await writeFile(secondPath, "second materialization", "utf8");
    const store = new EventStore(eventStorePath(repoPath));
    for (const [createdAt, path] of [
      ["2026-01-01T02:00:00.000Z", firstRelativePath],
      ["2026-01-01T03:00:00.000Z", secondRelativePath],
    ] as const) {
      store.append({
        runId: "run-event-materialization-history",
        stageId: "archive",
        attempt: path === firstRelativePath ? 1 : 2,
        type: "artifact.published",
        createdAt,
        payload: {
          artifact: {
            id: "archive-output",
            producer: "archive",
            mediaType: "application/octet-stream",
            path,
          },
        },
      });
    }
    store.append({
      runId: "run-event-materialization-history",
      type: "run.completed",
      createdAt: "2026-01-01T04:00:00.000Z",
      payload: {},
    });
    store.close();
    await writeJson(evidencePolicyPath(repoPath), {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "EvidencePolicy",
      spec: { retention: {
        runsDays: null,
        eventsDays: null,
        logsDays: null,
        artifactsDays: 0,
        evidenceDays: null,
      } },
    });

    const plan = await buildEvidencePrunePlan({
      repoPath,
      now: new Date("2026-01-02T00:00:00.000Z"),
    });
    const action = plan.actions.find((candidate) =>
      candidate.runId === "run-event-materialization-history" &&
      candidate.category === "artifacts"
    );
    expect(action?.paths).toEqual(expect.arrayContaining([firstPath, secondPath]));

    await applyEvidencePrunePlan(plan);
    expect(await pathExists(firstPath)).toBe(false);
    expect(await pathExists(secondPath)).toBe(false);
  });

  it("uses private sidecar history to prune older secret paths", async () => {
    const repoPath = await createRepo();
    const runDirectory = await seedRun(repoPath, {
      runId: "run-private-path-history",
      createdAt: "2026-01-01T00:00:00.000Z",
      terminalAt: "2026-01-01T01:00:00.000Z",
    });
    const firstRelativePath =
      "stages/archive/1/secret=first-private-value/output.bin";
    const secondRelativePath =
      "stages/archive/2/secret=second-private-value/output.bin";
    const firstPath = join(runDirectory, firstRelativePath);
    const secondPath = join(runDirectory, secondRelativePath);
    await mkdir(join(firstPath, ".."), { recursive: true });
    await mkdir(join(secondPath, ".."), { recursive: true });
    await writeFile(firstPath, "first private bytes", "utf8");
    await writeFile(secondPath, "second private bytes", "utf8");
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-private-path-history",
      artifacts: [{
        id: "private-output",
        producer: "archive",
        mediaType: "application/octet-stream",
        path: firstRelativePath,
      }],
      redactionSecrets: ["first-private-value"],
    });
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-private-path-history",
      artifacts: [{
        id: "private-output",
        producer: "archive",
        mediaType: "application/octet-stream",
        path: secondRelativePath,
      }],
      redactionSecrets: ["first-private-value", "second-private-value"],
    });
    await writeJson(evidencePolicyPath(repoPath), {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "EvidencePolicy",
      spec: { retention: {
        runsDays: null,
        eventsDays: null,
        logsDays: null,
        artifactsDays: 0,
        evidenceDays: null,
      } },
    });

    const plan = await buildEvidencePrunePlan({
      repoPath,
      now: new Date("2026-01-02T00:00:00.000Z"),
    });
    const action = plan.actions.find((candidate) =>
      candidate.runId === "run-private-path-history" &&
      candidate.category === "artifacts"
    );
    expect(action?.paths).toEqual(expect.arrayContaining([firstPath, secondPath]));

    await applyEvidencePrunePlan(plan);
    expect(await pathExists(firstPath)).toBe(false);
    expect(await pathExists(secondPath)).toBe(false);
  });

  it("recovers atomic temporary and repeated removal residues by category", async () => {
    const repoPath = await createRepo();
    const runDirectory = await seedRun(repoPath, {
      runId: "run-owned-residue-recovery",
      createdAt: "2026-01-01T00:00:00.000Z",
      terminalAt: "2026-01-01T01:00:00.000Z",
    });
    const stageDirectory = join(runDirectory, "stages", "implement", "1");
    const rawPath = join(stageDirectory, "output.md");
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-owned-residue-recovery",
      artifacts: [{
        id: "implementation",
        producer: "implement",
        mediaType: "text/markdown",
        path: "stages/implement/1/output.md",
      }],
      redactionSecrets: [],
    });
    const privatePath = (await privateRegistryPaths(runDirectory))[0] as string;
    const rawRemovingPath = join(
      stageDirectory,
      ".output.md.11111111-1111-4111-8111-111111111111.removing",
    );
    const publicRemovingPath = join(
      runDirectory,
      ".artifacts.json.22222222-2222-4222-8222-222222222222.removing",
    );
    const privateRemovingOnce = join(
      runDirectory,
      `.${basename(privatePath)}.33333333-3333-4333-8333-333333333333.removing`,
    );
    const privateRemovingTwice = join(
      runDirectory,
      `.${basename(privateRemovingOnce)}.44444444-4444-4444-8444-444444444444.removing`,
    );
    await rename(rawPath, rawRemovingPath);
    await rename(join(runDirectory, "artifacts.json"), publicRemovingPath);
    await rename(privatePath, privateRemovingOnce);
    await rename(privateRemovingOnce, privateRemovingTwice);

    const artifactTemporaryPath = join(
      stageDirectory,
      ".operator-review.md.55555555-5555-4555-8555-555555555555.tmp",
    );
    const logTemporaryPath = join(
      stageDirectory,
      ".extra.log.66666666-6666-4666-8666-666666666666.tmp",
    );
    const evidenceTemporaryPath = join(
      runDirectory,
      ".evidence.md.77777777-7777-4777-8777-777777777777.tmp",
    );
    const promptTemporaryPath = join(
      stageDirectory,
      ".prompt.md.88888888-8888-4888-8888-888888888888.tmp",
    );
    for (const path of [
      artifactTemporaryPath,
      logTemporaryPath,
      evidenceTemporaryPath,
      promptTemporaryPath,
    ]) await writeFile(path, `residue ${basename(path)}`, "utf8");
    await writeJson(evidencePolicyPath(repoPath), {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "EvidencePolicy",
      spec: { retention: {
        runsDays: null,
        eventsDays: null,
        logsDays: 0,
        artifactsDays: 0,
        evidenceDays: 0,
      } },
    });

    const plan = await buildEvidencePrunePlan({
      repoPath,
      now: new Date("2026-01-02T00:00:00.000Z"),
    });
    const artifactAction = plan.actions.find((candidate) =>
      candidate.runId === "run-owned-residue-recovery" &&
      candidate.category === "artifacts"
    );
    expect(artifactAction?.paths).toEqual(expect.arrayContaining([
      rawRemovingPath,
      artifactTemporaryPath,
      publicRemovingPath,
      privateRemovingTwice,
    ]));
    expect(artifactAction?.paths.indexOf(rawRemovingPath)).toBeLessThan(
      artifactAction?.paths.indexOf(publicRemovingPath) ?? -1,
    );
    expect(artifactAction?.paths.indexOf(publicRemovingPath)).toBeLessThan(
      artifactAction?.paths.indexOf(privateRemovingTwice) ?? -1,
    );
    expect(plan.actions.find((candidate) => candidate.category === "logs")?.paths)
      .toContain(logTemporaryPath);
    expect(plan.actions.find((candidate) => candidate.category === "evidence")?.paths)
      .toContain(evidenceTemporaryPath);
    expect(plan.actions.flatMap((candidate) => candidate.paths))
      .not.toContain(promptTemporaryPath);

    await applyEvidencePrunePlan(plan);
    for (const path of [
      rawRemovingPath,
      artifactTemporaryPath,
      publicRemovingPath,
      privateRemovingTwice,
      logTemporaryPath,
      evidenceTemporaryPath,
    ]) expect(await pathExists(path)).toBe(false);
    expect(await pathExists(promptTemporaryPath)).toBe(true);
  });

  it("finishes a whole-run quarantine left by an interrupted prune", async () => {
    const repoPath = await createRepo();
    const runDirectory = await seedRun(repoPath, {
      runId: "run-directory-quarantine",
      createdAt: "2026-01-01T00:00:00.000Z",
      terminalAt: "2026-01-01T01:00:00.000Z",
    });
    const quarantinePath = join(
      runDirectory,
      "..",
      ".run-directory-quarantine.99999999-9999-4999-8999-999999999999.removing",
    );
    await rename(runDirectory, quarantinePath);
    await writeJson(evidencePolicyPath(repoPath), {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "EvidencePolicy",
      spec: { retention: {
        runsDays: 0,
        eventsDays: 0,
        logsDays: null,
        artifactsDays: null,
        evidenceDays: null,
      } },
    });

    const plan = await buildEvidencePrunePlan({
      repoPath,
      now: new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(plan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: "run-directory-quarantine",
        category: "runs",
        paths: [quarantinePath],
      }),
      expect.objectContaining({
        runId: "run-directory-quarantine",
        category: "events",
      }),
    ]));

    const result = await applyEvidencePrunePlan(plan);
    expect(result.skipped).toEqual([]);
    expect(await pathExists(quarantinePath)).toBe(false);
    const store = new EventStore(eventStorePath(repoPath));
    expect(store.list("run-directory-quarantine")).toEqual([]);
    store.close();
  });

  it("treats nested evidence names as Artifacts but retains prompt snapshots", async () => {
    const repoPath = await createRepo();
    const runDirectory = await seedRun(repoPath, {
      runId: "run-nested-component-names",
      createdAt: "2026-01-01T00:00:00.000Z",
      terminalAt: "2026-01-01T01:00:00.000Z",
    });
    const nestedEvidencePath = join(
      runDirectory,
      "stages",
      "implement",
      "1",
      "evidence.md",
    );
    const promptPath = join(
      runDirectory,
      "stages",
      "implement",
      "1",
      "prompt.md",
    );
    await writeFile(nestedEvidencePath, "nested Artifact evidence", "utf8");
    await writeJson(join(runDirectory, "artifacts.json"), {
      runId: "run-nested-component-names",
      artifacts: [
        {
          id: "nested-evidence",
          producer: "implement",
          mediaType: "text/markdown",
          path: "stages/implement/1/evidence.md",
        },
        {
          id: "prompt-snapshot",
          producer: "implement",
          mediaType: "text/markdown",
          path: "stages/implement/1/prompt.md",
        },
      ],
    });
    await writeJson(evidencePolicyPath(repoPath), {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "EvidencePolicy",
      spec: { retention: {
        runsDays: null,
        eventsDays: null,
        logsDays: null,
        artifactsDays: 0,
        evidenceDays: null,
      } },
    });

    const plan = await buildEvidencePrunePlan({
      repoPath,
      now: new Date("2026-01-02T00:00:00.000Z"),
    });
    const action = plan.actions.find((candidate) =>
      candidate.runId === "run-nested-component-names" &&
      candidate.category === "artifacts"
    );
    expect(action?.paths).toContain(nestedEvidencePath);
    expect(action?.paths).not.toContain(promptPath);

    await applyEvidencePrunePlan(plan);
    expect(await pathExists(nestedEvidencePath)).toBe(false);
    expect(await pathExists(promptPath)).toBe(true);
  });
});
