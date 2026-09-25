import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Root of this Nitely installation, whose `flows/` directory holds the flows
 * shipped with it. Resolves the same from `src/flows/` and `dist/flows/`.
 */
export function bundledFlowsRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export class BuiltinFlowPathError extends Error {
  constructor(message = "built-in flow path must be a relative JSON path under flows/") {
    super(message);
    this.name = "BuiltinFlowPathError";
  }
}

export interface BuiltinFlowPath {
  flowPath: string;
  absolutePath: string;
}

export class RepositoryFlowPathError extends Error {
  constructor(
    message:
      | "flow path must stay inside the repository"
      | "flow path must exist inside the repository",
  ) {
    super(message);
    this.name = "RepositoryFlowPathError";
  }
}

export interface RepositoryFlowPath {
  flowPath: string;
  absolutePath: string;
}

function pathInside(parentPath: string, candidatePath: string): boolean {
  const fromParent = relative(parentPath, candidatePath);
  return (
    fromParent === "" ||
    (fromParent !== ".." &&
      !fromParent.startsWith(`..${posix.sep}`) &&
      !fromParent.startsWith("..\\") &&
      !isAbsolute(fromParent))
  );
}

function normalizeBuiltinFlowPath(flowPath: string): string {
  if (
    isAbsolute(flowPath) ||
    posix.isAbsolute(flowPath) ||
    flowPath.includes("\\")
  ) {
    throw new BuiltinFlowPathError();
  }
  const segments = flowPath.split("/");
  if (
    segments.length !== 2 ||
    segments[0] !== "flows" ||
    !segments[1] ||
    segments.some((segment) => segment === "." || segment === "..") ||
    posix.normalize(flowPath) !== flowPath ||
    !flowPath.endsWith(".json")
  ) {
    throw new BuiltinFlowPathError();
  }
  return flowPath;
}

/**
 * Resolve `flows/<name>.json` under `root`. Returns undefined when the root has
 * no such flow; throws when the flows directory or the flow escapes `root`.
 */
async function resolveFlowUnder(
  root: string,
  normalizedFlowPath: string,
): Promise<BuiltinFlowPath | undefined> {
  const rootPath = resolve(root);
  const flowsDirectory = resolve(rootPath, "flows");
  let rootRealPath: string;
  let flowsRealPath: string;
  try {
    rootRealPath = await realpath(rootPath);
    flowsRealPath = await realpath(flowsDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!pathInside(rootRealPath, flowsRealPath)) {
    throw new BuiltinFlowPathError();
  }

  const absolutePath = resolve(rootPath, normalizedFlowPath);
  if (!pathInside(flowsDirectory, absolutePath)) {
    throw new BuiltinFlowPathError();
  }

  let realFlowPath: string;
  try {
    realFlowPath = await realpath(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!pathInside(flowsRealPath, realFlowPath)) {
    throw new BuiltinFlowPathError();
  }

  return { flowPath: normalizedFlowPath, absolutePath };
}

/**
 * Resolve a built-in `flows/<name>.json`: the repository's own copy wins, and
 * the flow shipped with this installation is the fallback.
 */
export async function resolveBuiltinFlowPath(
  repoPath: string,
  flowPath: string,
  bundledRoot: string = bundledFlowsRoot(),
): Promise<BuiltinFlowPath> {
  const normalizedFlowPath = normalizeBuiltinFlowPath(flowPath);
  const resolved =
    (await resolveFlowUnder(repoPath, normalizedFlowPath)) ??
    (await resolveFlowUnder(bundledRoot, normalizedFlowPath));
  if (!resolved) {
    throw new BuiltinFlowPathError();
  }
  return resolved;
}

/**
 * Resolve a legacy repository-backed Flow without depending on Web request
 * types. Both lexical traversal and symlink escape are rejected before the
 * caller reads the document. A `flows/<name>.json` the repository does not
 * contain falls back to the flow shipped with this installation.
 */
export async function resolveRepositoryFlowPath(
  repoPath: string,
  candidatePath: string,
  bundledRoot: string = bundledFlowsRoot(),
): Promise<RepositoryFlowPath> {
  const repoRoot = resolve(repoPath);
  const candidate = resolve(repoRoot, candidatePath);
  if (!pathInside(repoRoot, candidate)) {
    throw new RepositoryFlowPathError(
      "flow path must stay inside the repository",
    );
  }
  const flowPath = relative(repoRoot, candidate).replaceAll("\\", "/");
  if (!flowPath) {
    throw new RepositoryFlowPathError(
      "flow path must stay inside the repository",
    );
  }

  const repoRealPath = await realpath(repoRoot);
  let flowRealPath: string;
  try {
    flowRealPath = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const bundled = await resolveBundledFallback(flowPath, bundledRoot);
      if (bundled) return bundled;
      throw new RepositoryFlowPathError(
        "flow path must exist inside the repository",
      );
    }
    throw error;
  }
  if (!pathInside(repoRealPath, flowRealPath)) {
    throw new RepositoryFlowPathError(
      "flow path must stay inside the repository",
    );
  }
  return { flowPath, absolutePath: candidate };
}

async function resolveBundledFallback(
  flowPath: string,
  bundledRoot: string,
): Promise<RepositoryFlowPath | undefined> {
  let normalizedFlowPath: string;
  try {
    normalizedFlowPath = normalizeBuiltinFlowPath(flowPath);
  } catch {
    return undefined;
  }
  return resolveFlowUnder(bundledRoot, normalizedFlowPath);
}
