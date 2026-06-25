import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectRepositoryPlanContext,
  generateDraftTechnicalPlan,
} from "../../src/plan-artifacts/draft.js";
import { validateTechnicalPlan } from "../../src/plan-artifacts/parse.js";

const approvedSpec = `# Feature Spec

## Background
Problem.

## User Stories
- **US-001:** As an operator, I can import repositories.

## Acceptance Scenarios
- **US-001 / SC-001:** Import succeeds.

## Functional Requirements
- **FR-001:** Import repositories from URLs.

## Success Criteria
- **SC-001:** Import is verified by a test.

## Edge Cases
None.

## Assumptions
None.

## Out Of Scope
None.
`;

describe("draft technical design generation", () => {
  it("generates a valid technical plan from approved spec and repo context", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-plan-draft-"));
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "test"), { recursive: true });
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({ scripts: { "test:run": "vitest run" } }),
      "utf8",
    );
    await writeFile(join(repo, "src/import.ts"), "", "utf8");
    await writeFile(join(repo, "test/import.test.ts"), "", "utf8");

    const draft = generateDraftTechnicalPlan({
      specMarkdown: approvedSpec,
      context: await collectRepositoryPlanContext(repo),
    });

    expect(draft.markdown).toContain("Status: draft");
    expect(draft.markdown).toContain("FR-001");
    expect(draft.markdown).toContain("src/import.ts");
    expect(draft.markdown).toContain("pnpm test:run");
    expect(validateTechnicalPlan(draft.markdown).valid).toBe(true);
  });

  it("records open questions when repository context is sparse", () => {
    const draft = generateDraftTechnicalPlan({
      specMarkdown: approvedSpec,
      context: {
        packageScripts: [],
        sourceFiles: [],
        testFiles: [],
        docsPresent: false,
        specsPresent: false,
        flowsPresent: false,
      },
    });

    expect(draft.openQuestions.length).toBeGreaterThan(0);
    expect(draft.markdown).toContain("Which source modules should own");
  });
});
