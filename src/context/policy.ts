import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { globMatches, normalizeRelativePath } from "../policy/glob.js";

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
  ".nitely/connections*",
  ".nitely/users/**/connections*",
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
