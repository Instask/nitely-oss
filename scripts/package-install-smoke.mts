/**
 * Builds the tarball users install, checks its contents, installs it in a
 * clean project, and runs the mocked golden path. Diagnostics written on
 * failure are command logs and proof flags. The fixture repository and run
 * evidence stay in a temp directory and are deleted.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { RUNNER_CONTROL_PLANE_SCHEMA_VERSION } from "../src/runner-control-plane/protocol.js";
import {
  goldenPathProofProblems,
  inspectPackedPackage,
  packagePathsFromTarList,
  packedPackageRegressionProblems,
  privateKeyProblem,
  redactDiagnosticText,
  WEB_STATIC_ASSETS,
  webStaticProblems,
  type PackedPackageManifest,
} from "./packed-package-inspect.js";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const diagnosticsDir = resolve(repoRoot, "package-smoke-diagnostics");

const SECRET_ENV =
  /TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY/i;

interface CommandResult {
  stdout: string;
  stderr: string;
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
      maxBuffer: 32 * 1024 * 1024,
      encoding: "utf8",
    });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    const failed = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
      code?: number | string;
    };
    const wrapped = new Error(
      `${command} ${args.join(" ")} failed (${failed.code ?? "error"}): ${failed.stderr || failed.message || "unknown error"}`,
    );
    (wrapped as Error & CommandResult).stdout = failed.stdout ?? "";
    (wrapped as Error & CommandResult).stderr = failed.stderr ?? "";
    throw wrapped;
  }
}

function smokeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || SECRET_ENV.test(name)) continue;
    env[name] = value;
  }
  return env;
}

function commandOutput(error: unknown): string {
  const failed = error as { stdout?: string; stderr?: string; message?: string };
  return [failed.stdout, failed.stderr, failed.message].filter(Boolean).join("\n");
}

function commandProblem(error: unknown): string {
  const failed = error as { stderr?: string; message?: string };
  const detail = (failed.stderr || failed.message || "command failed").trim();
  return redactDiagnosticText(detail).slice(0, 2000);
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files;
}

async function scanPrivateKeys(
  packageRoot: string,
  paths: readonly string[],
): Promise<string[]> {
  const problems: string[] = [];
  for (const path of paths) {
    const absolute = join(packageRoot, path);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      problems.push(`packed file ${path} is a symlink`);
      continue;
    }
    if (!info.isFile()) continue;
    const problem = await scanFileForPrivateKey(absolute, path);
    if (problem) problems.push(problem);
  }
  return problems;
}

async function binFileChecks(
  packageRoot: string,
  manifest: PackedPackageManifest,
): Promise<{
  binTexts: { path: string; text: string }[];
  modes: { path: string; mode: number }[];
}> {
  const binTexts: { path: string; text: string }[] = [];
  const modes: { path: string; mode: number }[] = [];
  const entries =
    typeof manifest.bin === "string"
      ? [["nitely", manifest.bin] as const]
      : manifest.bin && typeof manifest.bin === "object"
        ? Object.entries(manifest.bin)
        : [];
  for (const [, target] of entries) {
    if (typeof target !== "string" || !target.startsWith("./") || target.split("/").includes("..")) {
      continue;
    }
    const packedPath = target.slice(2);
    try {
      const info = await lstat(join(packageRoot, packedPath));
      if (info.isSymbolicLink() || !info.isFile()) continue;
      binTexts.push({ path: packedPath, text: await readFile(join(packageRoot, packedPath), "utf8") });
      modes.push({ path: packedPath, mode: info.mode });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { binTexts, modes };
}

function scanFileForPrivateKey(absolute: string, packedPath: string): Promise<string | undefined> {
  return new Promise((resolveScan, rejectScan) => {
    let settled = false;
    const finish = (problem: string | undefined) => {
      if (settled) return;
      settled = true;
      resolveScan(problem);
    };
    const stream = createReadStream(absolute);
    let pending = "";
    const markerLength = 80;
    stream.on("data", (chunk) => {
      pending += chunk.toString("latin1");
      const problem = privateKeyProblem(packedPath, pending);
      if (problem) {
        finish(problem);
        stream.destroy();
        return;
      }
      if (pending.length > markerLength) pending = pending.slice(-markerLength);
    });
    stream.on("error", (error) => {
      if (!settled) rejectScan(error);
    });
    stream.on("close", () => finish(undefined));
  });
}

function installedConsumerScript(): string {
  const assets = WEB_STATIC_ASSETS.map(
    (asset) => `  [${JSON.stringify(asset.path)}, ${JSON.stringify(asset.marker)}]`,
  ).join(",\n");
  return `import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as api from "nitely";
import { RUNNER_CONTROL_PLANE_SCHEMA_VERSION } from "nitely/runner-control-plane/protocol";
import { FileRunnerControlPlane } from "nitely/runner-control-plane/file-stub";

const expectedSchema = ${JSON.stringify(RUNNER_CONTROL_PLANE_SCHEMA_VERSION)};
if (api.RUNNER_CONTROL_PLANE_SCHEMA_VERSION !== expectedSchema) {
  throw new Error("api export schema mismatch");
}
if (RUNNER_CONTROL_PLANE_SCHEMA_VERSION !== expectedSchema) {
  throw new Error("protocol export schema mismatch");
}
if (typeof FileRunnerControlPlane !== "function") {
  throw new Error("file-stub export mismatch");
}

// \`exports\` does not expose ./package.json. Walk up from the public entry.
let packageRoot = dirname(fileURLToPath(import.meta.resolve("nitely")));
for (;;) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") throw error;
    manifest = undefined;
  }
  if (manifest && manifest.name === "nitely") break;
  const parent = dirname(packageRoot);
  if (parent === packageRoot) throw new Error("installed nitely package root not found");
  packageRoot = parent;
}

const assets = [
${assets}
];
const files = [];
for (const [path, marker] of assets) {
  const text = await readFile(join(packageRoot, path), "utf8");
  if (!text.includes(marker)) {
    throw new Error("web static asset " + path + " is missing " + JSON.stringify(marker));
  }
  files.push(path);
}
console.log(JSON.stringify({ schema: expectedSchema, packageRoot, files }));
`;
}

interface SmokeReport {
  ok: boolean;
  problems: string[];
  checks: Record<string, "passed" | "failed" | "not-run">;
  packedFileCount?: number;
  tarball?: string;
  goldenPathProof?: Record<string, unknown>;
  webStatic?: {
    status: "passed" | "failed" | "not-run";
    method: string;
  };
}

async function main(): Promise<number> {
  await mkdir(diagnosticsDir, { recursive: true });
  const log: string[] = [];
  const problems: string[] = [];
  const checks: SmokeReport["checks"] = {
    packedFiles: "not-run",
    regressionBrokenBin: "not-run",
    regressionBrokenExport: "not-run",
    regressionPrivatePath: "not-run",
    help: "not-run",
    importsAndWebStatic: "not-run",
    goldenPath: "not-run",
  };
  let packedFileCount: number | undefined;
  let tarballName: string | undefined;
  let goldenPathProof: Record<string, unknown> | undefined;
  const note = (line: string) => {
    log.push(redactDiagnosticText(line));
  };
  const env = smokeEnv();
  const temp = await mkdtemp(join(tmpdir(), "nitely-package-smoke-"));

  try {
    note(`pack in ${temp}`);
    const packed = await runCommand(
      "pnpm",
      ["pack", "--pack-destination", temp],
      { cwd: repoRoot, env, timeout: 300_000 },
    );
    const packLines = packed.stdout.trim().split("\n");
    note(packLines.slice(-8).join("\n"));
    if (packed.stderr.trim()) note(packed.stderr);
    const tarballLine = packed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.endsWith(".tgz"))
      .at(-1);
    if (!tarballLine) throw new Error("pnpm pack did not report a tarball");
    const tarball = resolve(temp, tarballLine);
    tarballName = tarballLine.split("/").at(-1);

    const listing = await runCommand("tar", ["-tzf", tarball], {
      cwd: temp,
      env,
      timeout: 60_000,
    });
    const paths = packagePathsFromTarList(listing.stdout.split("\n"));
    packedFileCount = paths.length;
    await writeFile(
      join(diagnosticsDir, "packed-files.txt"),
      paths.join("\n") + "\n",
      "utf8",
    );

    const extractDir = join(temp, "extract");
    await mkdir(extractDir);
    await runCommand("tar", ["-xzf", tarball, "-C", extractDir], {
      cwd: temp,
      env,
      timeout: 60_000,
    });
    const extractedRoots = (await walkFiles(extractDir)).map((file) => relative(extractDir, file));
    const packageRootName = extractedRoots[0]?.split("/")[0];
    if (!packageRootName) throw new Error("packed tarball extracted no files");
    const packageRoot = join(extractDir, packageRootName);
    const manifest = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    ) as PackedPackageManifest;

    const binChecks = await binFileChecks(packageRoot, manifest);
    const packedProblems = [
      ...inspectPackedPackage({
        paths,
        manifest,
        binTexts: binChecks.binTexts,
        modes: binChecks.modes,
      }),
      ...(await scanPrivateKeys(packageRoot, paths)),
    ];
    checks.packedFiles = packedProblems.length === 0 ? "passed" : "failed";
    problems.push(...packedProblems);

    const regressions = packedPackageRegressionProblems({ paths, manifest });
    const regressionChecks = {
      "broken-bin": "regressionBrokenBin",
      "broken-export": "regressionBrokenExport",
      "private-nitely-path": "regressionPrivatePath",
    } as const;
    for (const regression of regressions) {
      const check = regressionChecks[regression.name];
      const failedClosed = regression.problems.some((problem) => problem.includes(regression.planted));
      checks[check] = failedClosed ? "passed" : "failed";
      if (!failedClosed) {
        problems.push(
          `regression ${regression.name} did not fail closed for ${regression.planted}`,
        );
      }
    }

    if (packedProblems.length > 0) {
      note("skipping install because the packed tarball failed inspection");
      return 1;
    }

    const installDir = join(temp, "install");
    await mkdir(installDir);
    await writeFile(
      join(installDir, "package.json"),
      JSON.stringify(
        {
          name: "nitely-package-smoke-consumer",
          private: true,
          type: "module",
          dependencies: { nitely: `file:${tarball}` },
        },
        null,
        2,
      ),
      "utf8",
    );
    note("install tarball into a clean project");
    const installed = await runCommand(
      "pnpm",
      ["install", "--ignore-scripts"],
      { cwd: installDir, env, timeout: 180_000 },
    );
    note(installed.stdout);
    note(installed.stderr);

    const nitely = join(installDir, "node_modules", ".bin", "nitely");
    try {
      const help = await runCommand(nitely, ["--help"], {
        cwd: installDir,
        env,
        timeout: 60_000,
      });
      note(help.stdout);
      if (!help.stdout.includes("nitely") || !help.stdout.includes("golden-path")) {
        throw new Error("installed nitely --help did not list the golden path");
      }
      checks.help = "passed";
    } catch (error) {
      checks.help = "failed";
      problems.push(commandProblem(error));
      note(commandOutput(error));
    }

    const consumerScript = join(installDir, "installed-smoke.mjs");
    await writeFile(consumerScript, installedConsumerScript(), "utf8");
    try {
      const imported = await runCommand(process.execPath, [consumerScript], {
        cwd: installDir,
        env,
        timeout: 60_000,
      });
      note(imported.stdout);
      const reported = JSON.parse(imported.stdout) as { packageRoot?: string };
      if (!reported.packageRoot) throw new Error("installed import smoke did not report a package root");
      const staticProblems = webStaticProblems(
        await Promise.all(
          WEB_STATIC_ASSETS.map(async (asset) => ({
            path: asset.path,
            text: await readFile(join(reported.packageRoot as string, asset.path), "utf8"),
          })),
        ),
      );
      if (staticProblems.length > 0 || !reported) {
        throw new Error(staticProblems.join("\n") || "installed import smoke returned no report");
      }
      checks.importsAndWebStatic = "passed";
    } catch (error) {
      checks.importsAndWebStatic = "failed";
      problems.push(commandProblem(error));
      note(commandOutput(error));
    }

    const outputDir = join(temp, `golden-path-${randomUUID()}`);
    try {
      const demo = await runCommand(
        nitely,
        ["smoke", "golden-path", "--output", outputDir],
        { cwd: installDir, env, timeout: 300_000 },
      );
      note(demo.stdout);
      note(demo.stderr);
      if (!demo.stdout.includes("SMOKE golden-path ok")) {
        throw new Error("installed golden path did not report success");
      }
      const summary = JSON.parse(await readFile(join(outputDir, "summary.json"), "utf8")) as {
        proof?: Record<string, unknown>;
      };
      const proofProblems = goldenPathProofProblems(summary);
      if (proofProblems.length > 0) throw new Error(proofProblems.join("\n"));
      goldenPathProof = summary.proof;
      checks.goldenPath = "passed";
    } catch (error) {
      checks.goldenPath = "failed";
      problems.push(commandProblem(error));
      note(commandOutput(error));
      try {
        const summary = JSON.parse(await readFile(join(outputDir, "summary.json"), "utf8")) as {
          proof?: Record<string, unknown>;
        };
        if (summary.proof && typeof summary.proof === "object") goldenPathProof = summary.proof;
      } catch {
        // The demo failed before writing a proof summary.
      }
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }

    return problems.length === 0 ? 0 : 1;
  } catch (error) {
    problems.push(commandProblem(error));
    note(commandOutput(error));
    if (checks.packedFiles === "not-run") checks.packedFiles = "failed";
    return 1;
  } finally {
    const report: SmokeReport = {
      ok: problems.length === 0,
      problems: problems.map(redactDiagnosticText),
      checks,
      ...(packedFileCount !== undefined ? { packedFileCount } : {}),
      ...(tarballName ? { tarball: tarballName } : {}),
      ...(goldenPathProof ? { goldenPathProof } : {}),
      webStatic: {
        status: checks.importsAndWebStatic,
        method:
          "Read the installed src/web/static files served by dist/web/server.js. The Web server is not a package export, so this smoke checks those bytes in the installed tree.",
      },
    };
    await writeFile(
      join(diagnosticsDir, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
      "utf8",
    );
    await writeFile(join(diagnosticsDir, "smoke.log"), log.join("\n") + "\n", "utf8");
    await rm(temp, { recursive: true, force: true });
  }
}

process.exitCode = await main();
