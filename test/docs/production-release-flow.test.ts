import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");

function extractTemplateSection(markdown: string, template: string): string {
  const heading = `## Template: \`${template}\``;
  const sectionStart = markdown.indexOf(heading);
  if (sectionStart < 0) return "";
  const nextTemplate = markdown.indexOf(
    "\n## Template: `",
    sectionStart + heading.length,
  );
  return markdown.slice(
    sectionStart,
    nextTemplate < 0 ? markdown.length : nextTemplate,
  );
}

describe("governed production release Flow documentation", () => {
  it("documents the operator, command-output, recovery, and trust contracts", async () => {
    const doc = await readFile(
      join(repositoryRoot, "docs", "pilot-flow-templates.md"),
      "utf8",
    );
    const section = extractTemplateSection(
      doc,
      "pilot-issue-to-production",
    );

    expect(section).not.toBe("");
    const normalized = section.replace(/\s+/g, " ");

    for (const input of ["`issue`", "`repo-notes`", "`release-runbook`"]) {
      expect(section).toContain(input);
    }
    for (const approval of [
      "`approve-spec`",
      "`approve-tech-design`",
      "`approve-release`",
    ]) {
      expect(section).toContain(approval);
    }
    expect(normalized).toContain(
      "Fresh execution and resume use the same task-plan state machine",
    );
    expect(section).toContain("`taskPlan.role = \"execute-current\"`");
    expect(section).toContain("`taskPlan.role = \"verify-advance\"`");
    expect(section).toContain("`taskPlan.role = \"final\"`");
    expect(normalized).toContain(
      "`final-review` may reopen one uniquely identified completed task",
    );
    expect(normalized).toContain(
      "Ambiguous or unidentifiable final-review rework fails closed before `publish`",
    );
    expect(normalized).not.toContain("`final-review` runs once");

    expect(section).toContain("`./scripts/nitely/release-production`");
    expect(normalized).toContain("Nitely does not autonomously merge or deploy");
    expect(normalized).toContain(
      "explicit `approve-release` approval before invoking the adapter",
    );

    for (const outputProtocolTerm of [
      "`NITELY_OUTPUT_DIR`",
      "`artifact.json`",
      "`release-report.md`",
      "`smoke-report.md`",
      "`output.md`",
    ]) {
      expect(section).toContain(outputProtocolTerm);
    }
    expect(normalized).toContain("single Markdown fallback");
    expect(normalized).toContain("multi-output sets fail closed");
    expect(normalized).toContain(
      "validates the complete declared set before registering any artifact",
    );

    expect(section).toContain("`NITELY_RUN_ID` + `NITELY_STAGE_ID`");
    expect(section).toContain("`maxAttempts: 1`");
    expect(normalized).toContain("capture the rollback baseline before mutation");
    expect(normalized).toContain("roll back before returning a terminal failure");
    expect(normalized).toContain(
      "reconcile durable state instead of blindly repeating merge or deploy",
    );

    expect(normalized).toContain(
      "Secret values must stay out of Flow JSON, prompts, command strings, and artifacts",
    );
    expect(normalized).toContain(
      "Agent and review blockers remain resumable",
    );
    expect(normalized).toContain(
      "An open attempt is projected as interrupted after restart",
    );
    expect(normalized).toContain(
      "A normal non-zero release result is terminal and is not automatically retried",
    );
    expect(normalized).toContain(
      "A terminal run after a normal non-zero release cannot be resumed",
    );
    expect(normalized).toContain(
      "Only an open release attempt projected as interrupted can be resumed and reconciled",
    );
    expect(normalized).not.toContain(
      "An operator who explicitly resumes such a release",
    );
    expect(normalized).toContain(
      "Completed registered artifacts are rehydrated without republishing them",
    );
    expect(normalized).toContain(
      "regular-file and path-containment checks, stored size and digest, media type, and schema",
    );
    expect(normalized).not.toContain(
      "Rehydration verifies the stored path, file identity",
    );

    expect(normalized).toContain(
      "Same-PR review rework remains the separate `pilot-pr-review-rework` Flow",
    );
    expect(section).toContain(
      "node dist/index.js run flows/pilot-issue-to-production.json",
    );
  });

  it("does not satisfy this template contract from a later template section", () => {
    const laterOnlyTerm = "TERM_FROM_A_DIFFERENT_TEMPLATE";
    const doc = [
      "## Template: `pilot-issue-to-production`",
      "This section intentionally lacks the term.",
      "",
      "## Template: `later-template`",
      laterOnlyTerm,
    ].join("\n");

    expect(
      extractTemplateSection(doc, "pilot-issue-to-production"),
    ).not.toContain(laterOnlyTerm);
  });
});
