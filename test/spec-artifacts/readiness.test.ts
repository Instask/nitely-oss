import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { generateDraftSpec } from "../../src/spec-artifacts/draft.js";
import {
  evaluateSourceSpecificSpecReadiness,
  evaluateWorkItemSpecReadiness,
} from "../../src/spec-artifacts/readiness.js";
import type { WorkItemRecord } from "../../src/work-items/types.js";

function refinedSpec() {
  return `# Feature Spec: Repository import

Status: draft
Source: github-issue https://github.com/Instask/nitely/issues/305

## Background

Operators need source-backed planning tasks to become concrete implementation contracts.

## User Stories

- **US-001:** As an operator, I can paste a GitHub issue URL and create a planning task.

## Acceptance Scenarios

- **US-001 / SC-001:** Given a GitHub issue URL, when draft planning runs, then Nitely stores the issue title, URL, and source snapshot.

## Functional Requirements

- **FR-001:** Nitely must persist the source issue URL, title, and fetched snapshot on the generated planning task.
- **FR-002:** Nitely must reject implementation attempts while the generated task spec remains in draft status.

## Success Criteria

- **SC-001:** Approving the refined spec updates the persisted spec markdown status to approved.
- **SC-002:** Starting a run before technical design approval returns a validation error.

## Edge Cases And Failure Behavior

- Private issue fetch failures must report a provider setup error.

## Assumptions

- GitHub credentials are configured when the issue is private.

## Out Of Scope

- Automatically approving generated specs.

## Open Questions

- None.
`;
}

describe("source-specific spec readiness", () => {
  it("flags deterministic generated draft specs as not ready for approval", () => {
    const draft = generateDraftSpec({
      type: "github-issue",
      uri: "https://github.com/Instask/nitely/issues/305",
      title: "Generated spec approval",
      body: "Require source-specific requirements before approving generated specs.",
    });

    const result = evaluateSourceSpecificSpecReadiness(draft.markdown);

    expect(result.ready).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "generic-functional-requirement",
          id: "FR-001",
        }),
        expect.objectContaining({
          code: "generic-success-criterion",
          id: "SC-001",
        }),
        expect.objectContaining({
          code: "default-open-question",
        }),
      ]),
    );
  });

  it("accepts refined specs with source-specific requirements and success criteria", () => {
    const result = evaluateSourceSpecificSpecReadiness(refinedSpec());

    expect(result).toEqual({
      ready: true,
      issues: [],
    });
  });

  it("reports PASS for source-backed work items with refined approved specs", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-readiness-pass-"));
    await writeFile(join(repo, "spec.md"), refinedSpec(), "utf8");

    const result = await evaluateWorkItemSpecReadiness(repo, {
      ...workItem("ready-source"),
      specPath: "spec.md",
      planningSource: sourceRecord(),
    });

    expect(result).toEqual({
      status: "PASS",
      summary: "spec readiness passed",
      issues: [],
    });
  });

  it("reports WARN for work items without source-backed planning", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-readiness-warn-"));
    await writeFile(join(repo, "spec.md"), refinedSpec(), "utf8");

    const result = await evaluateWorkItemSpecReadiness(repo, {
      ...workItem("manual"),
      specPath: "spec.md",
    });

    expect(result.status).toBe("WARN");
    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "missing-planning-source",
      }),
    ]);
  });

  it("reports BLOCK for source-backed work items with generic generated specs", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-readiness-block-"));
    const draft = generateDraftSpec({
      type: "github-issue",
      uri: "https://github.com/Instask/nitely/issues/305",
      title: "Generated spec approval",
      body: "Require source-specific requirements before approving generated specs.",
    });
    await writeFile(join(repo, "spec.md"), draft.markdown, "utf8");

    const result = await evaluateWorkItemSpecReadiness(repo, {
      ...workItem("generic-source"),
      specPath: "spec.md",
      planningSource: sourceRecord(),
    });

    expect(result.status).toBe("BLOCK");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "blocking",
          code: "generic-functional-requirement",
        }),
      ]),
    );
  });
});

function sourceRecord(): WorkItemRecord["planningSource"] {
  return {
    type: "github-issue",
    uri: "https://github.com/Instask/nitely/issues/305",
    title: "Generated spec approval",
    snapshot: {
      uri: "https://github.com/Instask/nitely/issues/305",
      title: "Generated spec approval",
      body: "Require source-specific requirements before approving generated specs.",
      fetchedAt: "2026-06-28T00:00:00.000Z",
    },
  };
}

function workItem(id: string): WorkItemRecord {
  return {
    id,
    title: id,
    status: "ready",
    workItemType: "dev.pr",
    flowPath: "flows/implement-spec-bootstrap.json",
    inputs: {},
    priority: "P2",
    dependsOn: [],
    suggestedDependencies: [],
    createdAt: "2026-06-28T00:00:00.000Z",
    updatedAt: "2026-06-28T00:00:00.000Z",
  };
}
