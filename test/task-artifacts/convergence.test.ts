import { describe, expect, it } from "vitest";

import {
  appendConvergenceTasks,
  CONVERGENCE_REPORT_VERSION,
  convergenceGapFingerprint,
  parseConvergenceReport,
  parseConvergenceReportText,
  type ConvergenceGap,
  type ConvergenceReport,
} from "../../src/task-artifacts/convergence.js";
import { parseTaskArtifact } from "../../src/task-artifacts/parse.js";

function gap(
  classification: ConvergenceGap["classification"],
  title: string,
  sourceRefs: string[],
  paths: string[] = [],
): ConvergenceGap {
  return {
    classification,
    title,
    sourceRefs,
    evidence: [`Observed ${classification} behavior in the current worktree.`],
    paths,
  };
}

function report(gaps: ConvergenceGap[]): ConvergenceReport {
  return { version: CONVERGENCE_REPORT_VERSION, gaps };
}

const sourceTasks = `# Tasks

## Phase 1: Existing work

- [x] T001 FR-001 Existing setup
- [ ] T007 SC-001 Preserve this ID and content
`;

describe("convergence reports", () => {
  it("normalizes all supported classifications, source references, and evidence", () => {
    const parsed = parseConvergenceReport({
      version: CONVERGENCE_REPORT_VERSION,
      summary: "  Four   gaps\nremain. ",
      gaps: [
        {
          classification: "MISSING",
          title: " Add missing behavior ",
          sourceRefs: ["fr-001", "US-001/ac-002"],
          evidence: [" src/feature.ts has no implementation. "],
          paths: ["src/feature.ts"],
        },
        {
          classification: "partial",
          title: "Finish the partial path",
          sourceRefs: ["SC-002"],
          evidence: ["Only the success branch exists."],
        },
        {
          classification: "contradicts",
          title: "Align the contradicting behavior",
          sourceRefs: ["plan:Retry-Policy", "PD-001"],
          evidence: ["The implementation retries forever."],
        },
        {
          classification: "unrequested",
          title: "Remove unrequested scope",
          sourceRefs: ["constitution:scope-discipline"],
          evidence: ["An unrelated endpoint was added."],
        },
      ],
    });

    expect(parsed.errors).toEqual([]);
    expect(parsed.report).toMatchObject({
      summary: "Four gaps remain.",
      gaps: [
        {
          classification: "missing",
          sourceRefs: ["FR-001", "US-001/AC-002"],
          paths: ["src/feature.ts"],
        },
        { classification: "partial", sourceRefs: ["SC-002"], paths: [] },
        {
          classification: "contradicts",
          sourceRefs: ["PD-001", "plan:retry-policy"],
        },
        {
          classification: "unrequested",
          sourceRefs: ["constitution:scope-discipline"],
        },
      ],
    });
  });

  it("rejects invalid JSON, unknown fields, unsafe paths, invalid refs, and duplicate gaps", () => {
    expect(parseConvergenceReportText("{broken").errors[0]).toMatch(/valid JSON/);

    const duplicate = {
      classification: "missing",
      title: "Same gap",
      sourceRefs: ["FR-001"],
      evidence: ["first wording"],
      paths: ["src/same.ts"],
    };
    const parsed = parseConvergenceReport({
      version: CONVERGENCE_REPORT_VERSION,
      extra: true,
      gaps: [
        {
          ...duplicate,
          sourceRefs: ["not-a-source"],
          paths: ["../escape.ts"],
          unexpected: "field",
        },
        duplicate,
        { ...duplicate, evidence: ["changed evidence does not change identity"] },
      ],
    });

    expect(parsed.report).toBeUndefined();
    expect(parsed.errors.join("\n")).toMatch(/unknown field extra/);
    expect(parsed.errors.join("\n")).toMatch(/unknown field unexpected/);
    expect(parsed.errors.join("\n")).toMatch(/supported source reference/);
    expect(parsed.errors.join("\n")).toMatch(/safe repository-relative path/);
    expect(parsed.errors.join("\n")).toMatch(/duplicates semantic gap/);
  });
});

describe("appendConvergenceTasks", () => {
  it("appends missing, partial, contradicting, and unrequested work after the greatest ID", () => {
    const result = appendConvergenceTasks(
      sourceTasks,
      report([
        gap("missing", "Implement the missing path", ["FR-002"], ["src/missing.ts"]),
        gap("partial", "Complete the partial path", ["SC-002"]),
        gap("contradicts", "Correct the retry behavior", ["PD-003"]),
        gap("unrequested", "Remove the extra endpoint", ["constitution:scope"]),
      ]),
    );
    const markdown = result.content.toString("utf8");
    const parsed = parseTaskArtifact(markdown);

    expect(result.unchanged).toBe(false);
    expect(markdown.startsWith(sourceTasks)).toBe(true);
    expect(markdown).toContain("## Convergence");
    expect(result.appended.map((task) => task.taskId)).toEqual([
      "T008",
      "T009",
      "T010",
      "T011",
    ]);
    expect(parsed.valid).toBe(true);
    expect(parsed.tasks.slice(-4).map((task) => task.id)).toEqual([
      "T008",
      "T009",
      "T010",
      "T011",
    ]);
    expect(markdown).toContain("[CONVERGENCE:missing]");
    expect(markdown).toContain("[CONVERGENCE:partial]");
    expect(markdown).toContain("[CONVERGENCE:contradicts]");
    expect(markdown).toContain("[CONVERGENCE:unrequested]");
    expect(markdown).toContain("FR-002");
    expect(markdown).toContain("`src/missing.ts`");
  });

  it("leaves a clean task artifact byte-for-byte unchanged", () => {
    const source = Buffer.from(
      "\uFEFF# Tasks\r\n\r\n## Phase 1: Work\r\n\r\n- [ ] T001 FR-001 Keep CRLF and BOM\r\n",
      "utf8",
    );
    const result = appendConvergenceTasks(source, report([]));

    expect(result.unchanged).toBe(true);
    expect(result.appended).toEqual([]);
    expect(result.content.equals(source)).toBe(true);
  });

  it("is deterministic across report order and idempotent on a converged artifact", () => {
    const gaps = [
      gap("missing", "First semantic gap", ["FR-010"]),
      gap("partial", "Second semantic gap", ["SC-010"]),
    ];
    const forward = appendConvergenceTasks(sourceTasks, report(gaps));
    const reverse = appendConvergenceTasks(sourceTasks, report([...gaps].reverse()));
    const repeated = appendConvergenceTasks(forward.content, report(gaps));

    expect(forward.content.equals(reverse.content)).toBe(true);
    expect(repeated.unchanged).toBe(true);
    expect(repeated.appended).toEqual([]);
    expect(repeated.skippedFingerprints.sort()).toEqual(
      gaps.map(convergenceGapFingerprint).sort(),
    );
    expect(repeated.content.equals(forward.content)).toBe(true);
  });

  it("preserves prior convergence IDs and appends later gaps after the current maximum", () => {
    const firstGap = gap("missing", "First gap", ["FR-020"]);
    const secondGap = gap("partial", "Later gap", ["SC-020"]);
    const first = appendConvergenceTasks(sourceTasks, report([firstGap]));
    const second = appendConvergenceTasks(first.content, report([firstGap, secondGap]));
    const markdown = second.content.toString("utf8");

    expect(markdown.startsWith(first.content.toString("utf8"))).toBe(true);
    expect(second.appended).toHaveLength(1);
    expect(second.appended[0]?.taskId).toBe("T009");
    expect((markdown.match(/T008/g) ?? []).length).toBe(1);
    expect((markdown.match(/T009/g) ?? []).length).toBe(1);
  });

  it("only deduplicates fingerprints attached to existing task lines", () => {
    const semanticGap = gap("missing", "Do not suppress this gap", ["FR-025"]);
    const strayMarker = `<!-- nitely-convergence:${convergenceGapFingerprint(
      semanticGap,
    )} -->`;
    const result = appendConvergenceTasks(
      `${sourceTasks}\n${strayMarker}\n`,
      report([semanticGap]),
    );

    expect(result.unchanged).toBe(false);
    expect(result.appended[0]?.taskId).toBe("T008");
  });

  it("fails closed for invalid source tasks, duplicate semantic gaps, and exhausted IDs", () => {
    const oneGap = gap("missing", "Remaining work", ["FR-030"]);
    expect(() =>
      appendConvergenceTasks("# Tasks\n\n- [ ] Missing ID\n", report([oneGap])),
    ).toThrow(/invalid task artifact/);
    expect(() =>
      appendConvergenceTasks(sourceTasks, report([oneGap, { ...oneGap }])),
    ).toThrow(/duplicate semantic gap/);
    expect(() =>
      appendConvergenceTasks("# Tasks\n\n- [ ] T999 Last ID\n", report([oneGap])),
    ).toThrow(/ID space.*exhausted/);
  });
});
