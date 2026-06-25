import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";

import { z } from "zod";

export interface ContextPolicy {
  version: 1;
  include: string[];
  exclude: string[];
  warnOnly: boolean;
  redactEnv: string[];
}

export interface ContextDecision {
  decision: "allowed" | "excluded" | "warned";
  reason?: string;
  matchedPattern?: string;
}

export class ContextPolicyError extends Error {
  readonly repoRelativePath: string;
  readonly decision: ContextDecision;

  constructor(repoRelativePath: string, decision: ContextDecision) {
    super(`context policy excluded local input: ${repoRelativePath}`);
    this.name = "ContextPolicyError";
    this.repoRelativePath = repoRelativePath;
    this.decision = decision;
  }
}

const builtInExcludes = [
  ".git/**",
  ".nitely/providers/**",
  ".nitely/events.db",
  ".env",
  ".env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa",
  "**/id_ed25519",
];

const policySchema = z.object({
  version: z.literal(1).default(1),
  include: z.array(z.string()).default(["**/*"]),
  exclude: z.array(z.string()).default([]),
  warnOnly: z.boolean().default(false),
  redactEnv: z.array(z.string()).default([]),
});

function normalizeRelativePath(value: string): string {
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

function globMatches(pattern: string, repoRelativePath: string): boolean {
  const normalizedPattern = normalizeRelativePath(pattern);
  const normalizedPath = normalizeRelativePath(repoRelativePath);
  const patternSegments = normalizedPattern.split("/").filter(Boolean);
  const pathSegments = normalizedPath.split("/").filter(Boolean);
  return matchSegments(patternSegments, pathSegments);
}

export async function loadContextPolicy(repoPath: string): Promise<ContextPolicy> {
  let document: unknown = {};
  try {
    document = JSON.parse(await readFile(join(repoPath, "nitely.context.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const parsed = policySchema.parse(document);
  return {
    version: 1,
    include: parsed.include,
    exclude: [...parsed.exclude, ...builtInExcludes],
    warnOnly: parsed.warnOnly,
    redactEnv: parsed.redactEnv,
  };
}

export function evaluateLocalPath(
  policy: ContextPolicy,
  repoRelativePath: string,
): ContextDecision {
  const normalized = normalizeRelativePath(repoRelativePath);
  const excludedPattern = policy.exclude.find((pattern) =>
    globMatches(pattern, normalized),
  );
  if (excludedPattern) {
    return {
      decision: policy.warnOnly ? "warned" : "excluded",
      reason: `matched exclude pattern ${excludedPattern}`,
      matchedPattern: excludedPattern,
    };
  }

  const included = policy.include.some((pattern) => globMatches(pattern, normalized));
  if (!included) {
    return {
      decision: policy.warnOnly ? "warned" : "excluded",
      reason: "did not match any include pattern",
    };
  }

  return { decision: "allowed" };
}
