import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  renderDraftExternalKnowledgeSection,
  type DraftExternalKnowledgePassage,
} from "../spec-artifacts/draft.js";
import { validateStructuredSpec } from "../spec-artifacts/parse.js";

export type { DraftExternalKnowledgePassage } from "../spec-artifacts/draft.js";

export interface RepositoryPlanContext {
  packageScripts: string[];
  sourceFiles: string[];
  testFiles: string[];
  docsPresent: boolean;
  specsPresent: boolean;
  flowsPresent: boolean;
}

export interface GeneratedDraftTechnicalPlan {
  markdown: string;
  openQuestions: string[];
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function firstLevelFiles(root: string, directory: string): Promise<string[]> {
  const path = join(root, directory);
  if (!(await directoryExists(path))) return [];
  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => `${directory}/${entry.name}`)
    .sort()
    .slice(0, 12);
}

export async function collectRepositoryPlanContext(
  repoPath: string,
): Promise<RepositoryPlanContext> {
  let packageScripts: string[] = [];
  try {
    const packageJson = JSON.parse(
      await readFile(join(repoPath, "package.json"), "utf8"),
    ) as { scripts?: Record<string, unknown> };
    packageScripts = Object.entries(packageJson.scripts ?? {})
      .filter(([, value]) => typeof value === "string")
      .map(([key]) => key)
      .sort();
  } catch {
    packageScripts = [];
  }

  const [sourceFiles, testFiles, docsPresent, specsPresent, flowsPresent] =
    await Promise.all([
      firstLevelFiles(repoPath, "src"),
      firstLevelFiles(repoPath, "test"),
      directoryExists(join(repoPath, "docs")),
      directoryExists(join(repoPath, "specs")),
      directoryExists(join(repoPath, "flows")),
    ]);

  return {
    packageScripts,
    sourceFiles,
    testFiles,
    docsPresent,
    specsPresent,
    flowsPresent,
  };
}

function csv(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none discovered";
}

function traceIds(input: { stories: string[]; requirements: string[]; criteria: string[] }): string {
  return [...input.stories, ...input.requirements, ...input.criteria]
    .slice(0, 8)
    .join(", ");
}

function likelyImplementationFiles(context: RepositoryPlanContext): string[] {
  if (context.sourceFiles.length > 0) return context.sourceFiles.slice(0, 4);
  return ["src/path-to-be-confirmed.ts"];
}

function likelyTestFiles(context: RepositoryPlanContext): string[] {
  if (context.testFiles.length > 0) return context.testFiles.slice(0, 4);
  return ["test/path-to-be-confirmed.test.ts"];
}

export function generateDraftTechnicalPlan(input: {
  specMarkdown: string;
  context: RepositoryPlanContext;
  source?: {
    type: string;
    uri?: string;
    externalId?: string;
  };
  externalKnowledge?: DraftExternalKnowledgePassage[];
}): GeneratedDraftTechnicalPlan {
  const parsed = validateStructuredSpec(input.specMarkdown);
  if (!parsed.valid || parsed.status === "draft") {
    throw new Error("approved structured spec is required");
  }
  const storyIds = parsed.stories.map((story) => story.id);
  const requirementIds = parsed.requirements.map((requirement) => requirement.id);
  const criterionIds = parsed.successCriteria.map((criterion) => criterion.id);
  const trace = traceIds({
    stories: storyIds,
    requirements: requirementIds,
    criteria: criterionIds,
  });
  const implementationFiles = likelyImplementationFiles(input.context);
  const testFiles = likelyTestFiles(input.context);
  const openQuestions: string[] = [];
  if (input.context.sourceFiles.length === 0) {
    openQuestions.push("Which source modules should own the implementation?");
  }
  if (input.context.testFiles.length === 0) {
    openQuestions.push("Which test location should own acceptance coverage?");
  }
  if (input.context.packageScripts.length === 0) {
    openQuestions.push("Which command should verify the implementation?");
  }
  const verificationCommand = input.context.packageScripts.includes("test:run")
    ? "pnpm test:run"
    : input.context.packageScripts.includes("test")
      ? "pnpm test"
      : "verification command to be confirmed";
  const sourceSnapshot = input.source
    ? [input.source.type, input.source.externalId, input.source.uri]
        .filter((value): value is string => Boolean(value))
        .join(" · ")
    : "not recorded";

  const markdown = `# Technical Plan: Draft From Approved Spec

Status: draft

## Summary

- **Trace:** ${trace || "US/FR/SC ids unavailable"}
- **Source snapshot:** ${sourceSnapshot}
- **Approach:** Implement the approved structured spec with the smallest change that fits existing repository conventions.

## Technical Context

- **Language / runtime:** TypeScript / Node.js when applicable.
- **Package scripts:** ${csv(input.context.packageScripts)}
- **Source files observed:** ${csv(input.context.sourceFiles)}
- **Test files observed:** ${csv(input.context.testFiles)}
- **Docs present:** ${input.context.docsPresent ? "yes" : "no"}
- **Specs present:** ${input.context.specsPresent ? "yes" : "no"}
- **Flows present:** ${input.context.flowsPresent ? "yes" : "no"}

${renderDraftExternalKnowledgeSection(
    input.externalKnowledge,
    "the approved spec, plan constraints, or Nitely instructions",
  )}## Files / Modules Touched

${implementationFiles.map((file) => `- \`${file}\`: candidate implementation surface for ${requirementIds[0] ?? "FR-001"}.`).join("\n")}
${testFiles.map((file) => `- \`${file}\`: candidate verification surface for ${criterionIds[0] ?? "SC-001"}.`).join("\n")}

## Data Model Or Schema Changes

- **PD-001:** No schema change is assumed until the reviewer confirms the data model impact.

## Flow / API / CLI Contract Changes

- **PD-002:** Preserve existing public contracts unless the approved spec explicitly requires an API, CLI, or flow change.

## Failure Modes And Recovery Behavior

- Invalid inputs should fail with clear errors tied back to ${requirementIds[0] ?? "the relevant requirement"}.
- Partial writes or generated artifacts should remain inspectable for retry.

## Compatibility And Migration Plan

- Existing flows and tasks should continue to work unless the approved spec says otherwise.
- Migration is not assumed in this draft.

## Test Strategy

${criterionIds.map((id) => `- **${id}:** Add or update focused tests, then run \`${verificationCommand}\`.`).join("\n") || "- **SC-001:** Add focused tests and confirm the verification command."}

## Constitution Check

- **Conflict:** none identified by deterministic repo-context scan.
- **Evidence:** Keep code, secrets, and generated artifacts local to the repository.
- **Review:** Human reviewer must approve this draft before implementation.

## Complexity Tracking

- **PD-001**
  - **Complexity introduced:** None assumed.
  - **Simpler alternative rejected:** Not applicable.
  - **Reason:** Draft keeps schema changes out until explicitly justified.
- **PD-002**
  - **Complexity introduced:** None assumed.
  - **Simpler alternative rejected:** Not applicable.
  - **Reason:** Draft preserves existing contracts until scope is explicit.

## Open Questions

${openQuestions.length > 0 ? openQuestions.map((question) => `- ${question}`).join("\n") : "- No open questions from lightweight repository context."}
`;

  return { markdown, openQuestions };
}
