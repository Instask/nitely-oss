import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import type { CommandEnvironmentRepair } from "./execution/types.js";

export interface ToolchainFileDetection {
  path: string;
  kind: string;
}

export interface ToolchainExecutableStatus {
  name: string;
  available: boolean;
  path?: string;
}

export interface ToolchainPreflight {
  version: 1;
  runId: string;
  generatedAt: string;
  repoPath: string;
  worktreePath?: string;
  executionBackend?: string;
  commandEnvironment: {
    envSource: string;
    shellMode: string;
    pathEntryCount: number;
    repairs: CommandEnvironmentRepair[];
  };
  toolchainFiles: ToolchainFileDetection[];
  executables: ToolchainExecutableStatus[];
}

const toolchainFileCandidates: ToolchainFileDetection[] = [
  { path: "package.json", kind: "node-package" },
  { path: "pnpm-lock.yaml", kind: "pnpm-lock" },
  { path: "package-lock.json", kind: "npm-lock" },
  { path: "yarn.lock", kind: "yarn-lock" },
  { path: "bun.lock", kind: "bun-lock" },
  { path: "bun.lockb", kind: "bun-lock" },
  { path: "deno.json", kind: "deno-config" },
  { path: "deno.jsonc", kind: "deno-config" },
  { path: "mise.toml", kind: "mise" },
  { path: ".mise.toml", kind: "mise" },
  { path: ".tool-versions", kind: "asdf-tool-versions" },
  { path: "pyproject.toml", kind: "python-project" },
  { path: "requirements.txt", kind: "python-requirements" },
  { path: "uv.lock", kind: "uv-lock" },
  { path: "poetry.lock", kind: "poetry-lock" },
  { path: "Pipfile", kind: "pipenv" },
  { path: "go.mod", kind: "go-module" },
  { path: "Cargo.toml", kind: "rust-package" },
  { path: "Gemfile", kind: "ruby-bundle" },
];

const executableCandidates = [
  "git",
  "node",
  "npm",
  "pnpm",
  "python",
  "python3",
  "mise",
];

export function toolchainPreflightPath(runDirectory: string): string {
  return join(runDirectory, "toolchain-preflight.json");
}

async function detectToolchainFiles(rootPath: string): Promise<ToolchainFileDetection[]> {
  const detected: ToolchainFileDetection[] = [];
  for (const candidate of toolchainFileCandidates) {
    try {
      await access(join(rootPath, candidate.path), constants.R_OK);
      detected.push(candidate);
    } catch {
      // Missing or unreadable files are reported by absence from the artifact.
    }
  }
  return detected;
}

async function resolveExecutable(
  name: string,
  pathValue: string | undefined,
): Promise<string | undefined> {
  for (const entry of (pathValue ?? "").split(delimiter).filter(Boolean)) {
    const executablePath = join(entry, name);
    try {
      await access(executablePath, constants.X_OK);
      return executablePath;
    } catch {
      // Try the next PATH entry.
    }
  }
  return undefined;
}

async function executableStatuses(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Promise<ToolchainExecutableStatus[]> {
  const statuses: ToolchainExecutableStatus[] = [];
  for (const name of executableCandidates) {
    const executablePath = await resolveExecutable(name, env.PATH);
    statuses.push({
      name,
      available: executablePath !== undefined,
      ...(executablePath ? { path: executablePath } : {}),
    });
  }
  return statuses;
}

function uniqueRepairs(
  repairs: CommandEnvironmentRepair[],
): CommandEnvironmentRepair[] {
  const seen = new Set<string>();
  const unique: CommandEnvironmentRepair[] = [];
  for (const repair of repairs) {
    const key = `${repair.id}\0${repair.scope}\0${repair.path ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(repair);
  }
  return unique;
}

export async function writeToolchainPreflight(input: {
  runDirectory: string;
  runId: string;
  repoPath: string;
  worktreePath?: string;
  executionBackend?: string;
  envSource?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  environmentRepairs?: CommandEnvironmentRepair[];
}): Promise<ToolchainPreflight> {
  const env = input.env ?? process.env;
  const rootPath = input.worktreePath ?? input.repoPath;
  const manifest: ToolchainPreflight = {
    version: 1,
    runId: input.runId,
    generatedAt: new Date().toISOString(),
    repoPath: input.repoPath,
    ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
    ...(input.executionBackend ? { executionBackend: input.executionBackend } : {}),
    commandEnvironment: {
      envSource: input.envSource ?? "execution-backend-env",
      shellMode: "non-login sh -c",
      pathEntryCount: (env.PATH ?? "").split(delimiter).filter(Boolean).length,
      repairs: uniqueRepairs(input.environmentRepairs ?? []),
    },
    toolchainFiles: await detectToolchainFiles(rootPath),
    executables: await executableStatuses(env),
  };
  await writeFile(
    toolchainPreflightPath(input.runDirectory),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

export async function readToolchainPreflight(input: {
  runDirectory: string;
}): Promise<ToolchainPreflight | undefined> {
  try {
    return JSON.parse(
      await readFile(toolchainPreflightPath(input.runDirectory), "utf8"),
    ) as ToolchainPreflight;
  } catch {
    return undefined;
  }
}
