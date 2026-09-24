import { describe, expect, it } from "vitest";

import {
  classifySecurityFinding,
  extractAffectedFiles,
  renderSecurityAssessmentMarkdown,
} from "../../src/security/findings.js";

describe("security finding classification", () => {
  it("classifies supported vulnerability classes and affected files", () => {
    const assessment = classifySecurityFinding(
      "Path traversal in src/web/server.ts allows ../ segments to escape the upload root.",
    );

    expect(assessment).toMatchObject({
      supported: true,
      vulnerabilityClass: "path-traversal",
      validationResult: "supported",
      affectedFiles: ["src/web/server.ts"],
    });
  });

  it("extracts unique path-like affected files", () => {
    expect(
      extractAffectedFiles(
        "src/a.ts calls src/b.ts and src/a.ts again; docs/security.md has notes.",
      ),
    ).toEqual(["docs/security.md", "src/a.ts", "src/b.ts"]);
  });

  it("returns an unsupported result for unknown finding classes", () => {
    const assessment = classifySecurityFinding(
      "TLS cipher suite preference in infrastructure load balancer config.",
    );

    expect(assessment.supported).toBe(false);
    expect(assessment.validationResult).toBe("unsupported");
    expect(assessment.reason).toContain("supported classes");
  });

  it("renders assessment evidence with class, files, and assumptions", () => {
    const markdown = renderSecurityAssessmentMarkdown(
      classifySecurityFinding(
        "Command injection in src/run/execution/local.ts through child_process exec.",
      ),
    );

    expect(markdown).toContain("Validation result: supported");
    expect(markdown).toContain("Class: command-injection");
    expect(markdown).toContain("- src/run/execution/local.ts");
    expect(markdown).toContain("## Assumptions");
  });
});
