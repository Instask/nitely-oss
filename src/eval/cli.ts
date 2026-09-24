import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { redactText } from "../context/redaction.js";
import { loadEvalCohortManifest } from "./manifest.js";
import { compareEvalCohorts, loadEvalRunSamples } from "./report.js";
import { executeEvalReplay, planEvalReplay } from "./replay.js";
import {
  buildModelRoutingRecommendation,
  loadModelRoutingExperiment,
  parseModelRoutingReport,
} from "./routing.js";

export interface EvalCliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface EvalCliDependencies {
  loadManifest?: typeof loadEvalCohortManifest;
  loadRoutingExperiment?: typeof loadModelRoutingExperiment;
  parseRoutingReport?: typeof parseModelRoutingReport;
  buildRoutingRecommendation?: typeof buildModelRoutingRecommendation;
  planReplay?: typeof planEvalReplay;
  executeReplay?: typeof executeEvalReplay;
  loadSamples?: typeof loadEvalRunSamples;
  compareCohorts?: typeof compareEvalCohorts;
}

function safeError(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error)) ??
    "eval command failed";
}

interface ValidatedEvalReportOutput {
  canonicalRepoPath: string;
  outputFilename: string;
}

interface OpenedOutputDirectory {
  handle: FileHandle;
  metadata: BigIntStats;
  pathFromParent: string;
  subject: string;
}

const DIRECTORY_FLAGS =
  constants.O_RDONLY |
  constants.O_DIRECTORY |
  constants.O_NOFOLLOW;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const TEMPORARY_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW;
const PROC_SELF_FD = "/proc/self/fd";

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertSameFile(
  expected: BigIntStats,
  actual: BigIntStats,
  subject: string,
): void {
  if (!sameFile(expected, actual)) {
    throw new Error(`${subject} changed while it was being accessed`);
  }
}

function assertSafeOutputFile(
  metadata: BigIntStats,
  subject: string,
): void {
  if (metadata.isSymbolicLink()) {
    throw new Error(`${subject} must not be a symbolic link`);
  }
  if (!metadata.isFile()) {
    throw new Error(`${subject} must be a regular file`);
  }
  if (metadata.nlink !== 1n) {
    throw new Error(`${subject} must not have multiple hard links`);
  }
}

function assertSafeOutputDirectory(
  metadata: BigIntStats,
  subject: string,
): void {
  if (metadata.isSymbolicLink()) {
    throw new Error(`${subject} must not be a symbolic link`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`${subject} must be a directory`);
  }
}

function rethrowUnsafeOutputLookup(error: unknown, subject: string): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ELOOP") {
    throw new Error(`${subject} must not be a symbolic link`);
  }
  if (code === "ENOTDIR") {
    throw new Error(`${subject} traverses a non-directory path`);
  }
  throw error;
}

async function validatedEvalReportOutputPath(
  repoPath: string,
  outputPath: string,
): Promise<ValidatedEvalReportOutput> {
  const logicalRepoPath = resolve(repoPath);
  const expectedDirectory = resolve(logicalRepoPath, ".nitely", "evals");
  const resolvedOutputPath = resolve(outputPath);
  const relativeOutputPath = relative(logicalRepoPath, resolvedOutputPath);
  const segments = relativeOutputPath.split(sep);
  if (
    segments.length !== 3 ||
    segments[0] !== ".nitely" ||
    segments[1] !== "evals" ||
    !segments[2] ||
    !segments[2].endsWith(".json")
  ) {
    throw new Error(
      `Eval report output must be a JSON file directly under ${expectedDirectory}`,
    );
  }
  const canonicalRepoPath = await realpath(logicalRepoPath);
  return {
    canonicalRepoPath,
    outputFilename: segments[2],
  };
}

function assertExistingEvalReport(document: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    throw new Error(
      "Eval report output must be a new file or an existing eval report",
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !==
      "nitely.eval-report.v1" &&
    (parsed as { schemaVersion?: unknown }).schemaVersion !==
      "nitely.model-routing-recommendation.v1"
  ) {
    throw new Error(
      "Eval report output must be a new file or an existing eval report",
    );
  }
}

function descriptorChildPath(handle: FileHandle, child: string): string {
  return join(PROC_SELF_FD, String(handle.fd), child);
}

async function openOutputDirectory(
  path: string,
  subject: string,
): Promise<OpenedOutputDirectory> {
  const expected = await lstat(path, { bigint: true });
  assertSafeOutputDirectory(expected, subject);
  let handle: FileHandle;
  try {
    handle = await open(path, DIRECTORY_FLAGS);
  } catch (error) {
    rethrowUnsafeOutputLookup(error, subject);
  }
  try {
    const metadata = await handle.stat({ bigint: true });
    assertSafeOutputDirectory(metadata, subject);
    assertSameFile(expected, metadata, subject);
    const current = await lstat(path, { bigint: true });
    assertSafeOutputDirectory(current, subject);
    assertSameFile(metadata, current, subject);
    return { handle, metadata, pathFromParent: path, subject };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openOrCreateOutputDirectory(
  parent: OpenedOutputDirectory,
  segment: string,
): Promise<OpenedOutputDirectory> {
  const path = descriptorChildPath(parent.handle, segment);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return openOutputDirectory(path, "Eval report output directory");
}

async function validateOutputDirectoryIdentity(
  directory: OpenedOutputDirectory,
): Promise<void> {
  const opened = await directory.handle.stat({ bigint: true });
  assertSafeOutputDirectory(opened, directory.subject);
  assertSameFile(directory.metadata, opened, directory.subject);
  let current: BigIntStats;
  try {
    current = await lstat(directory.pathFromParent, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `${directory.subject} changed while it was being accessed`,
      );
    }
    rethrowUnsafeOutputLookup(error, directory.subject);
  }
  assertSafeOutputDirectory(current, directory.subject);
  assertSameFile(opened, current, directory.subject);
}

async function validateOutputDirectoryChain(
  repo: OpenedOutputDirectory,
  nitely: OpenedOutputDirectory,
  evals: OpenedOutputDirectory,
): Promise<void> {
  await validateOutputDirectoryIdentity(repo);
  await validateOutputDirectoryIdentity(nitely);
  await validateOutputDirectoryIdentity(evals);
}

async function inspectExistingEvalReport(
  outputPath: string,
): Promise<BigIntStats | undefined> {
  let expected: BigIntStats;
  try {
    expected = await lstat(outputPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    rethrowUnsafeOutputLookup(error, "Eval report output");
  }
  assertSafeOutputFile(expected, "Eval report output");

  let handle: FileHandle;
  try {
    handle = await open(outputPath, READ_FLAGS);
  } catch (error) {
    rethrowUnsafeOutputLookup(error, "Eval report output");
  }
  try {
    const opened = await handle.stat({ bigint: true });
    assertSafeOutputFile(opened, "Eval report output");
    assertSameFile(expected, opened, "Eval report output");
    const document = await handle.readFile("utf8");
    const afterRead = await handle.stat({ bigint: true });
    assertSafeOutputFile(afterRead, "Eval report output");
    assertSameFile(opened, afterRead, "Eval report output");
    if (
      opened.size !== afterRead.size ||
      opened.mtimeNs !== afterRead.mtimeNs ||
      opened.ctimeNs !== afterRead.ctimeNs
    ) {
      throw new Error("Eval report output changed while it was being read");
    }
    const current = await lstat(outputPath, { bigint: true });
    assertSafeOutputFile(current, "Eval report output");
    assertSameFile(opened, current, "Eval report output");
    assertExistingEvalReport(document);
    return opened;
  } finally {
    await handle.close();
  }
}

async function removeFileIfSame(
  path: string,
  expected: BigIntStats | undefined,
): Promise<void> {
  if (!expected) return;
  try {
    const current = await lstat(path, { bigint: true });
    if (sameFile(expected, current)) await unlink(path);
  } catch {
    // Best-effort cleanup must not hide the output safety failure.
  }
}

async function writeEvalReportSafely(input: {
  repoPath: string;
  outputPath: string;
  document: string;
}): Promise<void> {
  const validated = await validatedEvalReportOutputPath(
    input.repoPath,
    input.outputPath,
  );
  if (process.platform !== "linux") {
    throw new Error(
      "Explicit eval report output requires Linux descriptor-relative path anchoring",
    );
  }
  const repo = await openOutputDirectory(
    validated.canonicalRepoPath,
    "Eval report repository",
  );
  try {
    const nitely = await openOrCreateOutputDirectory(repo, ".nitely");
    try {
      const evals = await openOrCreateOutputDirectory(nitely, "evals");
      try {
        const outputPath = descriptorChildPath(
          evals.handle,
          validated.outputFilename,
        );
        const temporaryPath = descriptorChildPath(
          evals.handle,
          `.${validated.outputFilename}.${randomUUID()}.tmp`,
        );
        let temporary: FileHandle | undefined;
        let temporaryMetadata: BigIntStats | undefined;
        let temporaryCreated = false;
        try {
          await validateOutputDirectoryChain(repo, nitely, evals);
          const existing = await inspectExistingEvalReport(outputPath);
          await validateOutputDirectoryChain(repo, nitely, evals);
          try {
            temporary = await open(temporaryPath, TEMPORARY_FLAGS, 0o600);
          } catch (error) {
            rethrowUnsafeOutputLookup(error, "Eval report temporary output");
          }
          temporaryCreated = true;
          temporaryMetadata = await temporary.stat({ bigint: true });
          assertSafeOutputFile(
            temporaryMetadata,
            "Eval report temporary output",
          );
          await temporary.writeFile(input.document, "utf8");
          await temporary.sync();
          const completedTemporary = await temporary.stat({ bigint: true });
          assertSafeOutputFile(
            completedTemporary,
            "Eval report temporary output",
          );
          assertSameFile(
            temporaryMetadata,
            completedTemporary,
            "Eval report temporary output",
          );
          await temporary.close();
          temporary = undefined;

          await validateOutputDirectoryChain(repo, nitely, evals);
          const currentTemporary = await lstat(temporaryPath, { bigint: true });
          assertSafeOutputFile(
            currentTemporary,
            "Eval report temporary output",
          );
          assertSameFile(
            temporaryMetadata,
            currentTemporary,
            "Eval report temporary output",
          );
          if (existing) {
            const current = await lstat(outputPath, { bigint: true });
            assertSafeOutputFile(current, "Eval report output");
            assertSameFile(existing, current, "Eval report output");
            if (
              existing.size !== current.size ||
              existing.mtimeNs !== current.mtimeNs ||
              existing.ctimeNs !== current.ctimeNs
            ) {
              throw new Error(
                "Eval report output changed before it could be replaced",
              );
            }
            await validateOutputDirectoryChain(repo, nitely, evals);
            await rename(temporaryPath, outputPath);
            temporaryCreated = false;
          } else {
            await validateOutputDirectoryChain(repo, nitely, evals);
            try {
              await link(temporaryPath, outputPath);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "EEXIST") {
                throw new Error(
                  "Eval report output changed before it could be created",
                );
              }
              rethrowUnsafeOutputLookup(error, "Eval report output");
            }
            await unlink(temporaryPath);
            temporaryCreated = false;
          }

          const written = await lstat(outputPath, { bigint: true });
          assertSafeOutputFile(written, "Eval report output");
          assertSameFile(temporaryMetadata, written, "Eval report output");
          await validateOutputDirectoryChain(repo, nitely, evals);
          await evals.handle.sync();
          await validateOutputDirectoryChain(repo, nitely, evals);
        } finally {
          if (temporary) await temporary.close();
          if (temporaryCreated) {
            await removeFileIfSame(temporaryPath, temporaryMetadata);
          }
        }
      } finally {
        await evals.handle.close();
      }
    } finally {
      await nitely.handle.close();
    }
  } finally {
    await repo.handle.close();
  }
}

function printablePlan(plan: Awaited<ReturnType<typeof planEvalReplay>>): unknown {
  return {
    status: plan.status,
    cohortId: plan.cohortId,
    caseId: plan.caseId,
    manifestSha256: plan.manifestSha256,
    ...(plan.baselineCohortId ? { baselineCohortId: plan.baselineCohortId } : {}),
    baselineRunId: plan.baselineRunId,
    sourceRevision: plan.sourceRevision,
    allowedNondeterminism: plan.allowedNondeterminism,
    findings: plan.findings,
    ...(plan.status === "ready"
      ? {
          execution: {
            flowPath: plan.runInput.flowPath,
            executionBackend: plan.runInput.executionBackend,
            inputIds: Object.keys(plan.runInput.inputs).sort(),
            ...(plan.runInput.configuration
              ? {
                  configurationKeys: Object.keys(
                    plan.runInput.configuration,
                  ).sort(),
                }
              : {}),
          },
        }
      : {}),
  };
}

export async function runEvalCli(
  argv: string[],
  io: EvalCliIo,
  dependencies: EvalCliDependencies = {},
): Promise<number> {
  const action = argv[0];
  if (action === "recommend") {
    const experimentPath = argv[1];
    if (!experimentPath) {
      io.stderr(
        "Usage: nitely eval recommend <experiment> --repo <path> [--output <recommendation.json>]",
      );
      return 1;
    }
    let repoPath = ".";
    let outputPath = "";
    try {
      for (let index = 2; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--repo") {
          repoPath = argv[++index] ?? "";
          if (!repoPath) throw new Error("Missing value for --repo");
          continue;
        }
        if (argument === "--output") {
          outputPath = argv[++index] ?? "";
          if (!outputPath) throw new Error("Missing value for --output");
          continue;
        }
        throw new Error(`Unknown eval recommend option: ${argument}`);
      }
      const loadedExperiment = await (
        dependencies.loadRoutingExperiment ?? loadModelRoutingExperiment
      )(experimentPath);
      const loadManifest = dependencies.loadManifest ?? loadEvalCohortManifest;
      const candidates = await Promise.all(
        loadedExperiment.experiment.candidates.map(async (candidate) => {
          const manifestPath = resolve(repoPath, candidate.cohortManifestPath);
          const reportPath = resolve(repoPath, candidate.reportPath);
          const [loadedManifest, reportDocument] = await Promise.all([
            loadManifest(manifestPath),
            readFile(reportPath, "utf8"),
          ]);
          return {
            id: candidate.id,
            stageId: loadedExperiment.experiment.experiment.stageId,
            runtime: candidate.runtime,
            model: candidate.model,
            manifest: loadedManifest.manifest,
            manifestSha256: loadedManifest.sha256,
            report: (
              dependencies.parseRoutingReport ?? parseModelRoutingReport
            )(JSON.parse(reportDocument) as unknown),
          };
        }),
      );
      const recommendation = (
        dependencies.buildRoutingRecommendation ?? buildModelRoutingRecommendation
      )({
        experiment: loadedExperiment.experiment,
        experimentSha256: loadedExperiment.sha256,
        candidates,
      });
      const document = `${JSON.stringify(recommendation, null, 2)}\n`;
      if (outputPath) {
        await writeEvalReportSafely({ repoPath, outputPath, document });
        io.stdout(`EVAL RECOMMENDATION ${recommendation.recommendation.status} ${outputPath}`);
      } else {
        io.stdout(document.trimEnd());
      }
      return recommendation.recommendation.status === "recommended" ? 0 : 1;
    } catch (error) {
      io.stderr(safeError(error));
      return 1;
    }
  }
  if (action === "compare") {
    const candidatePath = argv[1];
    if (!candidatePath) {
      io.stderr(
        "Usage: nitely eval compare <candidate-manifest> --baseline <baseline-manifest> --repo <path> [--output <report.json>]",
      );
      return 1;
    }
    let baselinePath = "";
    let repoPath = ".";
    let outputPath = "";
    try {
      for (let index = 2; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--baseline") {
          baselinePath = argv[++index] ?? "";
          if (!baselinePath) throw new Error("Missing value for --baseline");
          continue;
        }
        if (argument === "--repo") {
          repoPath = argv[++index] ?? "";
          if (!repoPath) throw new Error("Missing value for --repo");
          continue;
        }
        if (argument === "--output") {
          outputPath = argv[++index] ?? "";
          if (!outputPath) throw new Error("Missing value for --output");
          continue;
        }
        throw new Error(`Unknown eval compare option: ${argument}`);
      }
      if (!baselinePath) throw new Error("Missing --baseline");
      const loadManifest = dependencies.loadManifest ?? loadEvalCohortManifest;
      const [candidate, baseline] = await Promise.all([
        loadManifest(candidatePath),
        loadManifest(baselinePath),
      ]);
      const loadSamples = dependencies.loadSamples ?? loadEvalRunSamples;
      const report = (dependencies.compareCohorts ?? compareEvalCohorts)({
        candidateManifest: candidate.manifest,
        baselineManifest: baseline.manifest,
        candidateSamples: loadSamples({ repoPath, manifest: candidate.manifest }),
        baselineSamples: loadSamples({ repoPath, manifest: baseline.manifest }),
      });
      const document = `${JSON.stringify(report, null, 2)}\n`;
      if (outputPath) {
        await writeEvalReportSafely({
          repoPath,
          outputPath,
          document,
        });
        io.stdout(`EVAL REPORT ${report.status} ${outputPath}`);
      } else {
        io.stdout(document.trimEnd());
      }
      return report.status === "passed" ? 0 : 1;
    } catch (error) {
      io.stderr(safeError(error));
      return 1;
    }
  }
  if (action !== "plan" && action !== "run") {
    io.stderr(
      "Usage: nitely eval plan|run <manifest> --repo <path> --case <id> [--json] | nitely eval compare <candidate-manifest> --baseline <baseline-manifest> --repo <path> [--output <report.json>] | nitely eval recommend <experiment> --repo <path> [--output <recommendation.json>]",
    );
    return 1;
  }
  const manifestPath = argv[1];
  if (!manifestPath) {
    io.stderr("Usage: nitely eval plan|run <manifest> --repo <path> --case <id> [--json]");
    return 1;
  }
  let repoPath = ".";
  let caseId = "";
  let json = false;
  try {
    for (let index = 2; index < argv.length; index += 1) {
      const argument = argv[index];
      if (argument === "--repo") {
        repoPath = argv[++index] ?? "";
        if (!repoPath) throw new Error("Missing value for --repo");
        continue;
      }
      if (argument === "--case") {
        caseId = argv[++index] ?? "";
        if (!caseId) throw new Error("Missing value for --case");
        continue;
      }
      if (argument === "--json") {
        json = true;
        continue;
      }
      throw new Error(`Unknown eval ${action} option: ${argument}`);
    }
    if (!caseId) throw new Error("Missing --case");
    const loaded = await (
      dependencies.loadManifest ?? loadEvalCohortManifest
    )(manifestPath);
    const plan = await (dependencies.planReplay ?? planEvalReplay)({
      repoPath,
      manifest: loaded.manifest,
      manifestSha256: loaded.sha256,
      caseId,
    });
    if (action === "run") {
      if (plan.status !== "ready") {
        io.stderr(JSON.stringify(printablePlan(plan), null, 2));
        return 1;
      }
      const executed = await (
        dependencies.executeReplay ?? executeEvalReplay
      )(plan);
      const status = executed.result.status ?? "completed";
      if (json) {
        io.stdout(JSON.stringify({
          schemaVersion: "nitely.eval-run-result.v1",
          runId: executed.runId,
          cohortId: plan.cohortId,
          caseId: plan.caseId,
          status,
        }, null, 2));
      } else {
        io.stdout(`EVAL RUN ${executed.runId} ${status}`);
        io.stdout(`Cohort: ${plan.cohortId}`);
        io.stdout(`Case: ${plan.caseId}`);
      }
      return 0;
    }
    if (json) {
      io.stdout(JSON.stringify(printablePlan(plan), null, 2));
    } else {
      io.stdout(`EVAL PLAN ${plan.status}`);
      io.stdout(`Cohort: ${plan.cohortId}`);
      io.stdout(`Case: ${plan.caseId}`);
      for (const finding of plan.findings) {
        io.stdout(`[${finding.code}] ${finding.message}`);
      }
    }
    return plan.status === "ready" ? 0 : 1;
  } catch (error) {
    io.stderr(safeError(error));
    return 1;
  }
}
