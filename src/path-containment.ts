import { isAbsolute, relative, sep } from "node:path";

/**
 * Whether `candidate` is `parent` itself or lies beneath it. Lexical only: it
 * does not resolve symbolic links, so callers that guard Run-owned content
 * must still anchor the path on a descriptor.
 */
export function isPathInside(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return !(
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}
