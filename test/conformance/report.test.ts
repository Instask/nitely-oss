import { describe, expect, it } from "vitest";

import {
  evaluateConformanceReport,
  parseConformanceReport,
  parseConformanceReportText,
} from "../../src/conformance/report.js";

describe("conformance report", () => {
  it("parses a structured coverage report", () => {
    const parsed = parseConformanceReport({
      version: 1,
      summary: "All required items covered.",
      items: [
        {
          id: "FR-001",
          status: "satisfied",
          evidence: ["implemented parser"],
          files: ["src/parser.ts"],
          tests: ["pnpm test"],
          artifacts: ["implementation"],
        },
      ],
    });

    expect(parsed.errors).toEqual([]);
    expect(parsed.report?.items[0]).toMatchObject({
      id: "FR-001",
      status: "satisfied",
      files: ["src/parser.ts"],
      tests: ["pnpm test"],
    });
  });

  it("reports invalid JSON and invalid item statuses", () => {
    expect(parseConformanceReportText("{ not json").errors[0]).toMatch(
      /not valid JSON/,
    );
    const parsed = parseConformanceReport({
      items: [{ id: "FR-001", status: "done" }],
    });
    expect(parsed.errors).toEqual([
      "items[0].status is invalid for FR-001",
    ]);
  });

  it("flags missing required IDs in strict mode", () => {
    const parsed = parseConformanceReport({
      items: [{ id: "FR-001", status: "satisfied" }],
    });

    const findings = evaluateConformanceReport(parsed.report, {
      mode: "strict",
      reportId: "conformance-report",
      requiredIds: ["FR-001", "SC-001"],
    });

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "blocking",
        code: "missing-required-id",
        itemId: "SC-001",
      }),
    ]);
  });

  it("flags partial, unverified, and design-decision violations", () => {
    const parsed = parseConformanceReport({
      items: [
        { id: "FR-001", status: "partially_satisfied" },
        { id: "SC-001", status: "not_verified" },
        { id: "PD-001", status: "not_satisfied" },
      ],
    });

    const findings = evaluateConformanceReport(parsed.report, {
      mode: "strict",
      reportId: "conformance-report",
      requiredIds: ["FR-001", "SC-001", "PD-001"],
    });

    expect(findings.map((finding) => finding.itemId)).toEqual([
      "FR-001",
      "SC-001",
      "PD-001",
    ]);
    expect(findings.every((finding) => finding.severity === "blocking")).toBe(
      true,
    );
  });

  it("records scope drift as advisory unless strict mode marks it blocking", () => {
    const parsed = parseConformanceReport({
      items: [{ id: "FR-001", status: "satisfied" }],
      scopeDrift: [
        {
          severity: "blocking",
          description: "Changed an unrelated billing module.",
          files: ["src/billing.ts"],
        },
      ],
    });

    expect(
      evaluateConformanceReport(parsed.report, {
        mode: "advisory",
        reportId: "conformance-report",
        requiredIds: ["FR-001"],
      }),
    ).toEqual([
      expect.objectContaining({ severity: "warning", code: "scope-drift" }),
    ]);
    expect(
      evaluateConformanceReport(parsed.report, {
        mode: "strict",
        reportId: "conformance-report",
        requiredIds: ["FR-001"],
      }),
    ).toEqual([
      expect.objectContaining({ severity: "blocking", code: "scope-drift" }),
    ]);
  });
});
