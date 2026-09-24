import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";

import { z } from "zod";

import type { Stage } from "../flow/schema.js";

export const PROJECT_INSTRUCTIONS_PATH = ".nitely/instructions.json";

export type ProjectInstructionAppliesTo = "agent" | "review" | "both";

export interface ProjectInstructionGroup {
  id: string;
  title?: string;
  appliesTo: ProjectInstructionAppliesTo;
  include: string[];
  exclude: string[];
  text: string;
}

export type ProjectInstructions =
  | {
      loaded: false;
      path: typeof PROJECT_INSTRUCTIONS_PATH;
    }
  | {
      loaded: true;
      path: typeof PROJECT_INSTRUCTIONS_PATH;
      hash: string;
      groups: ProjectInstructionGroup[];
    };

export interface SelectedProjectInstruction extends ProjectInstructionGroup {
  matchedPaths: string[];
}

export class ProjectInstructionsError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`invalid ${path}: ${message}`);
    this.name = "ProjectInstructionsError";
    this.path = path;
  }
}

const identifierSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,160}$/,
    "must start with a letter or number and contain only letters, numbers, dots, underscores, and hyphens",
  );

const instructionGroupSchema = z.object({
  id: identifierSchema,
  title: z.string().min(1).optional(),
  appliesTo: z.enum(["agent", "review", "both"]).default("both"),
  include: z.array(z.string().min(1)).default(["**/*"]),
  exclude: z.array(z.string().min(1)).default([]),
  text: z.string().refine((value) => value.trim().length > 0, {
    message: "must not be empty",
  }),
});

const instructionsDocumentSchema = z
  .object({
    version: z.literal(1).default(1),
    instructions: z.array(instructionGroupSchema).default([]),
  })
  .superRefine((document, context) => {
    const seen = new Set<string>();
    for (const [index, group] of document.instructions.entries()) {
      if (seen.has(group.id)) {
        context.addIssue({
          code: "custom",
          path: ["instructions", index, "id"],
          message: `duplicate instruction id: ${group.id}`,
        });
      }
      seen.add(group.id);
    }
  });

function formatIssuePath(path: PropertyKey[]): string {
  return path.length === 0 ? "file" : path.map(String).join(".");
}

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

export function projectInstructionGlobMatches(
  pattern: string,
  repoRelativePath: string,
): boolean {
  const normalizedPattern = normalizeRelativePath(pattern);
  const normalizedPath = normalizeRelativePath(repoRelativePath);
  const patternSegments = normalizedPattern.split("/").filter(Boolean);
  const pathSegments = normalizedPath.split("/").filter(Boolean);
  return matchSegments(patternSegments, pathSegments);
}

function safeCandidatePath(value: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return undefined;
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return undefined;
  const normalized = normalizeRelativePath(value);
  return normalized.length > 0 ? normalized : undefined;
}

function appliesToStage(group: ProjectInstructionGroup, stage: Stage): boolean {
  if (stage.type === "agent") {
    return group.appliesTo === "agent" || group.appliesTo === "both";
  }
  if (stage.type === "judge") {
    return group.appliesTo === "review" || group.appliesTo === "both";
  }
  if (stage.type === "gate" && stage.mode === "review") {
    return group.appliesTo === "review" || group.appliesTo === "both";
  }
  return false;
}

function matchesCandidatePaths(
  group: ProjectInstructionGroup,
  candidatePaths: string[],
): { matched: boolean; matchedPaths: string[] } {
  const safePaths = candidatePaths
    .map(safeCandidatePath)
    .filter((path): path is string => path !== undefined);
  const unfiltered =
    group.include.length === 1 &&
    normalizeRelativePath(group.include[0] ?? "") === "**/*" &&
    group.exclude.length === 0;
  if (unfiltered) {
    return { matched: true, matchedPaths: safePaths };
  }
  if (safePaths.length === 0) {
    return { matched: false, matchedPaths: [] };
  }
  const matchedPaths = safePaths.filter((path) => {
    const included = group.include.some((pattern) =>
      projectInstructionGlobMatches(pattern, path),
    );
    const excluded = group.exclude.some((pattern) =>
      projectInstructionGlobMatches(pattern, path),
    );
    return included && !excluded;
  });
  return { matched: matchedPaths.length > 0, matchedPaths };
}

export async function loadProjectInstructions(
  repoPath: string,
): Promise<ProjectInstructions> {
  const path = PROJECT_INSTRUCTIONS_PATH;
  let content: string;
  try {
    content = await readFile(join(repoPath, path), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { loaded: false, path };
    }
    throw error;
  }
  if (content.trim().length === 0) {
    return { loaded: false, path };
  }

  let document: unknown;
  try {
    document = JSON.parse(content);
  } catch (error) {
    throw new ProjectInstructionsError(
      path,
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = instructionsDocumentSchema.safeParse(document);
  if (!parsed.success) {
    throw new ProjectInstructionsError(
      path,
      parsed.error.issues
        .map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`)
        .join("; "),
    );
  }

  const hash = createHash("sha256").update(content).digest("hex");
  return {
    loaded: true,
    path,
    hash: `sha256:${hash}`,
    groups: parsed.data.instructions,
  };
}

export function selectProjectInstructions(input: {
  instructions: ProjectInstructions;
  stage: Stage;
  candidatePaths: string[];
}): SelectedProjectInstruction[] {
  if (!input.instructions.loaded) return [];
  return input.instructions.groups.flatMap((group) => {
    if (!appliesToStage(group, input.stage)) return [];
    const match = matchesCandidatePaths(group, input.candidatePaths);
    if (!match.matched) return [];
    return [{ ...group, matchedPaths: match.matchedPaths }];
  });
}
