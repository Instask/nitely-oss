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
