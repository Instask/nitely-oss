import { realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";

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

export async function resolveBuiltinFlowPath(
  repoPath: string,
  flowPath: string,
): Promise<BuiltinFlowPath> {
  const normalizedFlowPath = normalizeBuiltinFlowPath(flowPath);
  const repoRoot = resolve(repoPath);
  const repoRealPath = await realpath(repoRoot);
  const flowsDirectory = resolve(repoRoot, "flows");
  const flowsRealPath = await realpath(flowsDirectory);
  if (!pathInside(repoRealPath, flowsRealPath)) {
    throw new BuiltinFlowPathError();
  }

  const absolutePath = resolve(repoRoot, normalizedFlowPath);
  if (!pathInside(flowsDirectory, absolutePath)) {
    throw new BuiltinFlowPathError();
  }

  let realFlowPath: string;
  try {
    realFlowPath = await realpath(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BuiltinFlowPathError();
    }
    throw error;
  }
  if (!pathInside(flowsRealPath, realFlowPath)) {
    throw new BuiltinFlowPathError();
  }

  return { flowPath: normalizedFlowPath, absolutePath };
}

/**
 * Resolve a legacy repository-backed Flow without depending on Web request
 * types. Both lexical traversal and symlink escape are rejected before the
 * caller reads the document.
 */
export async function resolveRepositoryFlowPath(
  repoPath: string,
  candidatePath: string,
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
