import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { globMatches, normalizeRelativePath } from "./glob.js";

export interface CodeOwnerRule {
  pattern: string;
  owners: string[];
}

export interface CodeOwners {
  /** Repo-relative path the rules were read from, when one existed. */
  sourcePath?: string;
  rules: CodeOwnerRule[];
}

/**
 * Where GitHub looks, in the order it looks. The first file that exists wins.
 */
const CODEOWNERS_PATHS = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
];

export function parseCodeOwners(content: string): CodeOwnerRule[] {
  const rules: CodeOwnerRule[] = [];
  for (const line of content.split(/\r?\n/)) {
    const withoutComment = line.replace(/#.*$/, "").trim();
    if (withoutComment.length === 0) continue;
    const [pattern, ...owners] = withoutComment.split(/\s+/);
    if (!pattern || owners.length === 0) continue;
    rules.push({ pattern, owners });
  }
  return rules;
}

export async function loadCodeOwners(repoPath: string): Promise<CodeOwners> {
  for (const candidate of CODEOWNERS_PATHS) {
    try {
      const content = await readFile(
        join(resolve(repoPath), candidate),
        "utf8",
      );
      return { sourcePath: candidate, rules: parseCodeOwners(content) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return { rules: [] };
}

/**
 * Expand one CODEOWNERS pattern into the glob patterns that cover it. The
 * CODEOWNERS syntax is gitignore-like, so a bare name matches at any depth and
 * a directory matches everything beneath it.
 */
function ownerPatternGlobs(pattern: string): string[] {
  const trimmed = pattern.trim();
  if (trimmed === "*" || trimmed === "**") return ["**"];
  const anchored = trimmed.startsWith("/");
  const body = normalizeRelativePath(
    anchored ? trimmed.slice(1) : trimmed,
  ).replace(/\/$/, "");
  if (body.length === 0) return ["**"];
  const directoryMatch = `${body}/**`;
  if (trimmed.endsWith("/")) {
    return anchored ? [directoryMatch] : [directoryMatch, `**/${directoryMatch}`];
  }
  if (anchored || body.includes("/")) {
    return [body, directoryMatch];
  }
  // An unanchored bare name matches that name anywhere in the tree.
  return [body, directoryMatch, `**/${body}`, `**/${directoryMatch}`];
}

export function codeOwnersForPath(
  owners: CodeOwners,
  repoRelativePath: string,
): CodeOwnerRule | undefined {
  // GitHub gives the last matching rule precedence.
  let matched: CodeOwnerRule | undefined;
  for (const rule of owners.rules) {
    if (
      ownerPatternGlobs(rule.pattern).some((glob) =>
        globMatches(glob, repoRelativePath),
      )
    ) {
      matched = rule;
    }
  }
  return matched;
}

export function codeOwnersForPaths(
  owners: CodeOwners,
  repoRelativePaths: readonly string[],
): { owners: string[]; paths: string[] } {
  const matchedOwners = new Set<string>();
  const matchedPaths: string[] = [];
  for (const path of repoRelativePaths) {
    const rule = codeOwnersForPath(owners, path);
    if (!rule) continue;
    matchedPaths.push(path);
    for (const owner of rule.owners) {
      matchedOwners.add(owner);
    }
  }
  return {
    owners: [...matchedOwners].sort((left, right) => left.localeCompare(right)),
    paths: matchedPaths,
  };
}
