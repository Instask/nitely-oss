import { describe, expect, it, vi } from "vitest";

const outputSwapRace = vi.hoisted(() => ({
  enabled: false,
  outputPath: "",
  replacementPath: "",
  triggered: false,
}));

const outputDirectorySwapRace = vi.hoisted(() => ({
  enabled: false,
  outputFilename: "",
  swapPath: "",
  displacedPath: "",
  displacedOutputDirectory: "",
  replacementPath: "",
  replacementOutputDirectory: "",
  triggered: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const metadata = await actual.lstat(...args);
      const requestedPath = String(args[0]);
      if (
        outputSwapRace.enabled &&
        !outputSwapRace.triggered &&
        (requestedPath === outputSwapRace.outputPath ||
          requestedPath.endsWith(
            `/${outputSwapRace.outputPath.split("/").pop()}`,
          ))
      ) {
        await actual.rm(outputSwapRace.outputPath);
        await actual.symlink(
          outputSwapRace.replacementPath,
          outputSwapRace.outputPath,
        );
        outputSwapRace.triggered = true;
      }
      return metadata;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const sourcePath = String(args[0]);
      const destinationPath = String(args[1]);
      if (
        outputDirectorySwapRace.enabled &&
        !outputDirectorySwapRace.triggered &&
        sourcePath.endsWith(".tmp") &&
        destinationPath.endsWith(
          `/${outputDirectorySwapRace.outputFilename}`,
        )
      ) {
        const temporaryFilename = sourcePath.split("/").pop();
        if (!temporaryFilename) {
          throw new Error("expected eval report temporary file");
        }
        await actual.rename(
          outputDirectorySwapRace.swapPath,
          outputDirectorySwapRace.displacedPath,
        );
        await actual.symlink(
          outputDirectorySwapRace.replacementPath,
          outputDirectorySwapRace.swapPath,
          "dir",
        );
        await actual.link(
          join(
            outputDirectorySwapRace.displacedOutputDirectory,
            temporaryFilename,
          ),
          join(
            outputDirectorySwapRace.replacementOutputDirectory,
            temporaryFilename,
          ),
        );
        outputDirectorySwapRace.triggered = true;
      }
      return actual.rename(...args);
    },
  };
});
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runEvalCli } from "../../src/eval/cli.js";
import {
  parseEvalCohortManifest,
  type EvalCohortManifest,
} from "../../src/eval/manifest.js";
import type { EvalRunSample } from "../../src/eval/report.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const itLinux = process.platform === "linux" ? it : it.skip;
const itNonLinux = process.platform === "linux" ? it.skip : it;

function manifestFor(
  cohortId = "candidate",
  baselineCohortId: string | undefined = "baseline",
  thresholds: EvalCohortManifest["thresholds"] = {},
): EvalCohortManifest {
  return parseEvalCohortManifest({
    schemaVersion: "nitely.eval-cohort.v1",
    cohort: {
      id: cohortId,
      ...(baselineCohortId ? { baselineCohortId } : {}),
    },
    cases: [
      {
        id: "case-1",
        baselineRunId: "run-baseline",
        source: { revision: "b".repeat(40) },
        flow: { path: "flows/eval.json", sha256: DIGEST },
        inputs: [],
        runtime: {
          executionBackend: "local",
          sandboxPolicy: { codex: "danger-full-access" },
          stages: [],
        },
        contextPolicy: { sha256: DIGEST },
        expectedGates: [],
        allowedNondeterminism: [],
        scoring: { requireReviewablePr: true, requireExpectedGates: true },
      },
    ],
    thresholds,
  });
}

function comparisonSample(
  cohortId: string,
  reviewablePr = true,
): EvalRunSample {
  return {
    schemaVersion: "nitely.eval-run-sample.v1",
    runId: `run-${cohortId}`,
    cohortId,
    caseId: "case-1",
    baselineRunId: "run-baseline",
    terminalStatus: "completed",
    reviewablePr,
    expectedGatesPassed: true,
    scoringPassed: reviewablePr,
    retries: 0,
    humanRework: 0,
    latencyMs: 100,
    usage: { knownAttempts: 0, unknownAttempts: 1 },
  };
}

function comparisonDependencies(
  candidate: EvalCohortManifest,
  baseline: EvalCohortManifest,
) {
  return {
    loadManifest: async (path: string) => ({
      manifest: path === "candidate.json" ? candidate : baseline,
      document: "{}",
      sha256: DIGEST,
    }),
    loadSamples: ({ manifest }: { manifest: EvalCohortManifest }) => [
      comparisonSample(manifest.cohort.id),
    ],
  };
}

describe("eval CLI", () => {
  it("prints a machine-readable compatible replay plan", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const manifest = manifestFor();
    const code = await runEvalCli(
      ["plan", "cohort.json", "--repo", "/repo", "--case", "case-1", "--json"],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      {
        loadManifest: async () => ({
          manifest,
          document: "{}",
          sha256: DIGEST,
        }),
        planReplay: async () => ({
          status: "ready",
          cohortId: "candidate",
          caseId: "case-1",
          manifestSha256: DIGEST,
          manifest,
          baselineCohortId: "baseline",
          baselineRunId: "run-baseline",
          sourceRevision: "b".repeat(40),
          allowedNondeterminism: [],
          findings: [],
          runInput: {
            repoPath: "/repo",
            flowPath: "/repo/flows/eval.json",
            flowDocument: "{}",
            executionBackend: "local",
            inputs: {},
            configuration: { reviewMode: "strict" },
          },
        }),
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const output = stdout.join("\n");
    expect(output).not.toContain("strict");
    expect(JSON.parse(output)).toMatchObject({
      status: "ready",
      cohortId: "candidate",
      caseId: "case-1",
      findings: [],
      execution: { configurationKeys: ["reviewMode"] },
    });
  });

  it("executes a compatible case through the replay execution seam", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const manifest = manifestFor();
    const plan = {
      status: "ready" as const,
      cohortId: "candidate",
      caseId: "case-1",
      manifestSha256: DIGEST,
      manifest,
      baselineCohortId: "baseline",
      baselineRunId: "run-baseline",
      sourceRevision: "b".repeat(40),
      allowedNondeterminism: [],
      findings: [] as [],
      runInput: {
        repoPath: "/repo",
        flowPath: "/repo/flows/eval.json",
        flowDocument: "{}",
        executionBackend: "local",
        inputs: {},
      },
    };
    let executeCalls = 0;

    const code = await runEvalCli(
      ["run", "cohort.json", "--repo", "/repo", "--case", "case-1"],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      {
        loadManifest: async () => ({ manifest, document: "{}", sha256: DIGEST }),
        planReplay: async () => plan,
        executeReplay: async (received) => {
          executeCalls += 1;
          expect(received).toBe(plan);
          return {
            runId: "eval-run-1",
            result: {
              runId: "eval-run-1",
              branchName: "nitely/eval-run-1",
              worktreePath: "/repo/.nitely/runs/eval-run-1/worktree",
            },
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(executeCalls).toBe(1);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "EVAL RUN eval-run-1 completed",
      "Cohort: candidate",
      "Case: case-1",
    ]);
  });

  itLinux("writes a versioned comparison report and exits non-zero on regression", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-eval-cli-"));
    const outputPath = join(repoPath, ".nitely", "evals", "eval.json");
    const baseline = manifestFor("baseline", undefined);
    const candidate = manifestFor("candidate", "baseline", {
      reviewablePrRate: { maxAbsoluteDecrease: 0 },
    });
    const sample = (
      cohortId: string,
      reviewablePr: boolean,
    ): EvalRunSample => ({
      schemaVersion: "nitely.eval-run-sample.v1",
      runId: `run-${cohortId}`,
      cohortId,
      caseId: "case-1",
      baselineRunId: "run-baseline",
      terminalStatus: "completed",
      reviewablePr,
      expectedGatesPassed: true,
      scoringPassed: reviewablePr,
      retries: 0,
      humanRework: 0,
      latencyMs: 100,
      usage: { knownAttempts: 0, unknownAttempts: 1 },
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runEvalCli(
      [
        "compare",
        "candidate.json",
        "--baseline",
        "baseline.json",
        "--repo",
        repoPath,
        "--output",
        outputPath,
      ],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      {
        loadManifest: async (path) => ({
          manifest: path === "candidate.json" ? candidate : baseline,
          document: "{}",
          sha256: DIGEST,
        }),
        loadSamples: ({ manifest }) => [
          sample(manifest.cohort.id, manifest.cohort.id === "baseline"),
        ],
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([`EVAL REPORT regressed ${outputPath}`]);
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
      schemaVersion: "nitely.eval-report.v1",
      status: "regressed",
      regressions: [expect.objectContaining({ metric: "reviewablePrRate" })],
    });
  });

  it("refuses to overwrite a repository source file", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-eval-cli-source-"));
    const sourcePath = join(repoPath, "flows", "eval.json");
    await mkdir(join(repoPath, "flows"));
    await writeFile(sourcePath, "source sentinel\n", "utf8");
    const candidate = manifestFor("candidate", "baseline");
    const baseline = manifestFor("baseline", undefined);
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runEvalCli(
      [
        "compare",
        "candidate.json",
        "--baseline",
        "baseline.json",
        "--repo",
        repoPath,
        "--output",
        sourcePath,
      ],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      comparisonDependencies(candidate, baseline),
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      expect.stringMatching(/\.nitely[/\\]evals/),
    ]);
    expect(await readFile(sourcePath, "utf8")).toBe("source sentinel\n");
  });

  itLinux("refuses a symlinked eval report output", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-eval-cli-symlink-"));
    const outputDirectory = join(repoPath, ".nitely", "evals");
    const outputPath = join(outputDirectory, "report.json");
    const outsidePath = join(repoPath, "outside-source.json");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(outsidePath, "outside sentinel\n", "utf8");
    await symlink(outsidePath, outputPath);
    const candidate = manifestFor("candidate", "baseline");
    const baseline = manifestFor("baseline", undefined);
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runEvalCli(
      [
        "compare",
        "candidate.json",
        "--baseline",
        "baseline.json",
        "--repo",
        repoPath,
        "--output",
        outputPath,
      ],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      comparisonDependencies(candidate, baseline),
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([expect.stringMatching(/symbolic link/i)]);
    expect(await readFile(outsidePath, "utf8")).toBe("outside sentinel\n");
  });

  itLinux("refuses an eval report output hard-linked to a repository source", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-eval-cli-hardlink-"));
    const outputDirectory = join(repoPath, ".nitely", "evals");
    const outputPath = join(outputDirectory, "report.json");
    const sourceDirectory = join(repoPath, "flows");
    const sourcePath = join(sourceDirectory, "eval.json");
    await mkdir(outputDirectory, { recursive: true });
    await mkdir(sourceDirectory);
    await writeFile(sourcePath, "flow sentinel\n", "utf8");
    await link(sourcePath, outputPath);
    const candidate = manifestFor("candidate", "baseline");
    const baseline = manifestFor("baseline", undefined);
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runEvalCli(
      [
        "compare",
        "candidate.json",
        "--baseline",
        "baseline.json",
        "--repo",
        repoPath,
        "--output",
        outputPath,
      ],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      comparisonDependencies(candidate, baseline),
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([expect.stringMatching(/hard link/i)]);
    expect(await readFile(sourcePath, "utf8")).toBe("flow sentinel\n");
  });

  itLinux("refuses to overwrite an existing non-report file in the eval directory", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-eval-cli-existing-"));
    const outputDirectory = join(repoPath, ".nitely", "evals");
    const outputPath = join(outputDirectory, "report.json");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(outputPath, "ordinary sentinel\n", "utf8");
    const candidate = manifestFor("candidate", "baseline");
    const baseline = manifestFor("baseline", undefined);
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runEvalCli(
      [
        "compare",
        "candidate.json",
        "--baseline",
        "baseline.json",
        "--repo",
        repoPath,
        "--output",
        outputPath,
      ],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      comparisonDependencies(candidate, baseline),
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([expect.stringMatching(/existing eval report/i)]);
    expect(await readFile(outputPath, "utf8")).toBe("ordinary sentinel\n");
  });

  itLinux("refuses a symlinked eval report output directory", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-eval-cli-parent-"));
    const nitelyDirectory = join(repoPath, ".nitely");
    const outsideDirectory = await mkdtemp(
      join(tmpdir(), "nitely-eval-cli-parent-outside-"),
    );
    const outputPath = join(nitelyDirectory, "evals", "report.json");
    await mkdir(nitelyDirectory);
    await symlink(outsideDirectory, join(nitelyDirectory, "evals"), "dir");
    const candidate = manifestFor("candidate", "baseline");
    const baseline = manifestFor("baseline", undefined);
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runEvalCli(
      [
        "compare",
        "candidate.json",
        "--baseline",
        "baseline.json",
        "--repo",
        repoPath,
        "--output",
        outputPath,
      ],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      comparisonDependencies(candidate, baseline),
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      expect.stringMatching(/output directory.*symbolic link/i),
    ]);
    await expect(readFile(join(outsideDirectory, "report.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  itLinux("does not follow an output swapped to a symlink after validation", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-eval-cli-race-"));
    const outputDirectory = join(repoPath, ".nitely", "evals");
    const outputPath = join(outputDirectory, "report.json");
    const protectedPath = join(repoPath, "protected-report.json");
    const originalDocument = JSON.stringify({
      schemaVersion: "nitely.eval-report.v1",
      sentinel: "original",
    });
    const protectedDocument = JSON.stringify({
      schemaVersion: "nitely.eval-report.v1",
      sentinel: "protected",
    });
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(outputPath, originalDocument, "utf8");
    await writeFile(protectedPath, protectedDocument, "utf8");
    const candidate = manifestFor("candidate", "baseline");
    const baseline = manifestFor("baseline", undefined);
    const stdout: string[] = [];
    const stderr: string[] = [];
    outputSwapRace.enabled = true;
    outputSwapRace.outputPath = outputPath;
    outputSwapRace.replacementPath = protectedPath;
    outputSwapRace.triggered = false;

    const code = await runEvalCli(
      [
        "compare",
        "candidate.json",
        "--baseline",
        "baseline.json",
        "--repo",
        repoPath,
        "--output",
        outputPath,
      ],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      comparisonDependencies(candidate, baseline),
    );
    outputSwapRace.enabled = false;

    expect(outputSwapRace.triggered).toBe(true);
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      expect.stringMatching(/symbolic link|changed while/i),
    ]);
    expect(await readFile(protectedPath, "utf8")).toBe(protectedDocument);
  });

  itLinux(
    "does not overwrite an external report when .nitely is swapped after final validation",
    async () => {
      const repoPath = await mkdtemp(
        join(tmpdir(), "nitely-eval-cli-parent-race-"),
      );
      const nitelyDirectory = join(repoPath, ".nitely");
      const outputDirectory = join(nitelyDirectory, "evals");
      const outputFilename = "report.json";
      const outputPath = join(outputDirectory, outputFilename);
      const displacedNitelyDirectory = join(repoPath, ".nitely-displaced");
      const replacementNitelyDirectory = await mkdtemp(
        join(tmpdir(), "nitely-eval-cli-parent-race-outside-"),
      );
      const replacementOutputDirectory = join(
        replacementNitelyDirectory,
        "evals",
      );
      const protectedPath = join(replacementOutputDirectory, outputFilename);
      const originalDocument = JSON.stringify({
        schemaVersion: "nitely.eval-report.v1",
        sentinel: "original",
      });
      const protectedDocument = JSON.stringify({
        schemaVersion: "nitely.eval-report.v1",
        sentinel: "protected",
      });
      await mkdir(outputDirectory, { recursive: true });
      await mkdir(replacementOutputDirectory, { recursive: true });
      await writeFile(outputPath, originalDocument, "utf8");
      await writeFile(protectedPath, protectedDocument, "utf8");
      const candidate = manifestFor("candidate", "baseline");
      const baseline = manifestFor("baseline", undefined);
      const stdout: string[] = [];
      const stderr: string[] = [];
      Object.assign(outputDirectorySwapRace, {
        enabled: true,
        outputFilename,
        swapPath: nitelyDirectory,
        displacedPath: displacedNitelyDirectory,
        displacedOutputDirectory: join(displacedNitelyDirectory, "evals"),
        replacementPath: replacementNitelyDirectory,
        replacementOutputDirectory,
        triggered: false,
      });

      const code = await runEvalCli(
        [
          "compare",
          "candidate.json",
          "--baseline",
          "baseline.json",
          "--repo",
          repoPath,
          "--output",
          outputPath,
        ],
        {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        },
        comparisonDependencies(candidate, baseline),
      );
      outputDirectorySwapRace.enabled = false;

      expect(outputDirectorySwapRace.triggered).toBe(true);
      expect(code).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([
        expect.stringMatching(
          /output directory.*changed|multiple hard links|symbolic link/i,
        ),
      ]);
      expect(await readFile(protectedPath, "utf8")).toBe(protectedDocument);
    },
  );

  itLinux("refuses a directory as an eval report output", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-eval-cli-directory-"));
    const outputPath = join(repoPath, ".nitely", "evals", "report.json");
    await mkdir(outputPath, { recursive: true });
    const candidate = manifestFor("candidate", "baseline");
    const baseline = manifestFor("baseline", undefined);
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runEvalCli(
      [
        "compare",
        "candidate.json",
        "--baseline",
        "baseline.json",
        "--repo",
        repoPath,
        "--output",
        outputPath,
      ],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      comparisonDependencies(candidate, baseline),
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([expect.stringMatching(/regular file/i)]);
  });

  itLinux("atomically replaces an existing versioned eval report", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-eval-cli-replace-"));
    const outputDirectory = join(repoPath, ".nitely", "evals");
    const outputPath = join(outputDirectory, "report.json");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      outputPath,
      JSON.stringify({
        schemaVersion: "nitely.eval-report.v1",
        sentinel: "old-report",
      }),
      "utf8",
    );
    const before = await stat(outputPath, { bigint: true });
    const candidate = manifestFor("candidate", "baseline");
    const baseline = manifestFor("baseline", undefined);
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runEvalCli(
      [
        "compare",
        "candidate.json",
        "--baseline",
        "baseline.json",
        "--repo",
        repoPath,
        "--output",
        outputPath,
      ],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      comparisonDependencies(candidate, baseline),
    );

    expect(code).toBe(1);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([`EVAL REPORT insufficient_data ${outputPath}`]);
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
      schemaVersion: "nitely.eval-report.v1",
      status: "insufficient_data",
    });
    const after = await stat(outputPath, { bigint: true });
    expect(after.ino).not.toBe(before.ino);
    expect(await readdir(outputDirectory)).toEqual(["report.json"]);
  });

  itNonLinux("fails closed for an explicit report output", async () => {
    const repoPath = await mkdtemp(
      join(tmpdir(), "nitely-eval-cli-non-linux-output-"),
    );
    const outputPath = join(repoPath, ".nitely", "evals", "report.json");
    const candidate = manifestFor("candidate", "baseline");
    const baseline = manifestFor("baseline", undefined);
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runEvalCli(
      [
        "compare",
        "candidate.json",
        "--baseline",
        "baseline.json",
        "--repo",
        repoPath,
        "--output",
        outputPath,
      ],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      comparisonDependencies(candidate, baseline),
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      expect.stringMatching(/requires Linux descriptor-relative path anchoring/i),
    ]);
    await expect(readFile(outputPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps comparison JSON on stdout when no output path is requested", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-eval-cli-stdout-"));
    const candidate = manifestFor("candidate", "baseline");
    const baseline = manifestFor("baseline", undefined);
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runEvalCli(
      [
        "compare",
        "candidate.json",
        "--baseline",
        "baseline.json",
        "--repo",
        repoPath,
      ],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      comparisonDependencies(candidate, baseline),
    );

    expect(code).toBe(1);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      schemaVersion: "nitely.eval-report.v1",
      status: "insufficient_data",
    });
  });

  it("loads a bounded routing experiment and emits a recommendation proposal", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-eval-routing-cli-"));
    await mkdir(join(repoPath, "reports"), { recursive: true });
    await writeFile(join(repoPath, "reports", "fast.json"), "{}", "utf8");
    await writeFile(join(repoPath, "reports", "slow.json"), "{}", "utf8");
    const stdout: string[] = [];
    const stderr: string[] = [];
    let receivedCandidates: unknown[] = [];
    const experiment = {
      experiment: { id: "routing-1", flow: { path: "flow.json", sha256: DIGEST }, stageId: "implement", baselineManifestSha256: DIGEST },
      candidates: [
        { id: "fast", runtime: "oci", model: "fast", cohortManifestPath: "fast.json", reportPath: "reports/fast.json" },
        { id: "slow", runtime: "oci", model: "slow", cohortManifestPath: "slow.json", reportPath: "reports/slow.json" },
      ],
      budget: { maxCandidates: 2, maxRuns: 2 },
      policy: { minScoringPassRate: 1, minReviewablePrRate: 1, requireCompleteCases: true, requireKnownCost: true },
    } as any;
    const recommendation = {
      schemaVersion: "nitely.model-routing-recommendation.v1",
      recommendation: { status: "recommended", candidateId: "fast" },
    };

    const code = await runEvalCli(
      ["recommend", "experiment.json", "--repo", repoPath],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      {
        loadRoutingExperiment: async () => ({ experiment, document: "{}", sha256: DIGEST }),
        loadManifest: async () => ({ manifest: manifestFor(), document: "{}", sha256: DIGEST }),
        parseRoutingReport: () => ({}) as any,
        buildRoutingRecommendation: (input) => {
          receivedCandidates = [...input.candidates];
          return recommendation as any;
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join("\n"))).toEqual(recommendation);
    expect(receivedCandidates).toHaveLength(2);
  });
});
