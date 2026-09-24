import { posix } from "node:path";

/**
 * Repo-relative path globbing shared by the policies that reason about which
 * files a change touched. Supports `*` within a segment and `**` across
 * segments, which is the subset every policy file in this repository uses.
 */
export function normalizeRelativePath(value: string): string {
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  return normalized === "." ? "" : normalized.replace(/^\.\/+/, "");
}

function segmentMatches(pattern: string, segment: string): boolean {
  const regex = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*")}$`,
  );
  return regex.test(segment);
}

function matchSegments(pattern: string[], path: string[]): boolean {
  if (pattern.length === 0) return path.length === 0;
  const [head, ...tail] = pattern;
  if (head === "**") {
    if (matchSegments(tail, path)) return true;
    return path.length > 0 && matchSegments(pattern, path.slice(1));
  }
  return (
    path.length > 0 &&
    segmentMatches(head, path[0] ?? "") &&
    matchSegments(tail, path.slice(1))
  );
}

export function globMatches(pattern: string, repoRelativePath: string): boolean {
  const normalizedPattern = normalizeRelativePath(pattern);
  const normalizedPath = normalizeRelativePath(repoRelativePath);
  const patternSegments = normalizedPattern.split("/").filter(Boolean);
  const pathSegments = normalizedPath.split("/").filter(Boolean);
  return matchSegments(patternSegments, pathSegments);
}
