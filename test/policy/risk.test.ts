import { describe, expect, it } from "vitest";

import {
  classifyChangeRisk,
  diffDigest,
  isRiskClassificationStale,
  maxRiskClass,
  parseNameStatusDiff,
  parseShortStatLines,
  type ChangeDiff,
  type DiffFileChange,
} from "../../src/policy/risk.js";
import { parseCodeOwners } from "../../src/policy/codeowners.js";

function diff(
  files: Array<[DiffFileChange["status"], string]>,
  changedLines?: number,
): ChangeDiff {
  return {
    files: files.map(([status, path]) => ({ status, path })),
    ...(changedLines !== undefined ? { changedLines } : {}),
  };
}

describe("change risk classification", () => {
  it("leaves an ordinary scoped change at its declared baseline", () => {
    const classification = classifyChangeRisk({
      declared: "normal",
      diff: diff([
        ["modified", "src/web/dashboard.ts"],
        ["added", "test/web/dashboard.test.ts"],
      ]),
    });

    expect(classification).toMatchObject({
      declared: "normal",
      effective: "normal",
      escalated: false,
      signals: [],
    });
    expect(classification.explanation).toContain("No diff signal raised it");
  });

  it("escalates a low-risk task that touches a protected auth path", () => {
    const classification = classifyChangeRisk({
      declared: "mechanical",
      diff: diff([
        ["modified", "docs/readme.md"],
        ["modified", "src/auth/session.ts"],
      ]),
    });

    expect(classification.effective).toBe("protected");
    expect(classification.escalated).toBe(true);
    expect(classification.explanation).toContain(
      "Escalated from mechanical to protected risk because",
    );
    expect(classification.signals).toContainEqual(
      expect.objectContaining({
        id: "protected-path",
        domain: "auth",
        riskClass: "protected",
        paths: ["src/auth/session.ts"],
      }),
    );
  });

  it("names every protected domain the diff touched", () => {
    const classification = classifyChangeRisk({
      declared: "normal",
      diff: diff([
        ["modified", "src/payments/charge.ts"],
        ["modified", "src/crypto/cipher.ts"],
        ["added", ".env.production"],
      ]),
    });

    expect(
      classification.signals
        .filter((signal) => signal.id === "protected-path")
        .map((signal) => signal.domain),
    ).toEqual(["payment", "crypto", "secrets"]);
  });

  it("raises migrations, dependency manifests, and deletions to high", () => {
    for (const [path, id] of [
      ["db/migrate/20260101_add_column.sql", "database-migration"],
      ["package.json", "dependency-manifest"],
    ] as const) {
      const classification = classifyChangeRisk({
        declared: "normal",
        diff: diff([["modified", path]]),
      });
      expect(classification.effective, path).toBe("high");
      expect(classification.signals[0], path).toMatchObject({ id });
    }

    const deletion = classifyChangeRisk({
      declared: "normal",
      diff: diff([["deleted", "src/web/legacy.ts"]]),
    });
    expect(deletion.effective).toBe("high");
    expect(deletion.signals[0]).toMatchObject({
      id: "destructive-change",
      paths: ["src/web/legacy.ts"],
    });
  });

  it("raises an oversized diff to high on either threshold", () => {
    const manyFiles = classifyChangeRisk({
      declared: "normal",
      diff: diff(
        Array.from({ length: 41 }, (_, index) => [
          "modified",
          `src/module-${index}.ts`,
        ]),
      ),
    });
    expect(manyFiles.effective).toBe("high");
    expect(manyFiles.signals[0]?.detail).toContain("41 files");

    const manyLines = classifyChangeRisk({
      declared: "normal",
      diff: diff([["modified", "src/module.ts"]], 900),
    });
    expect(manyLines.effective).toBe("high");
    expect(manyLines.signals[0]?.detail).toContain("900 lines");
  });

  it("never lowers the effective class below the declared baseline", () => {
    const classification = classifyChangeRisk({
      declared: "high",
      diff: diff([["modified", "docs/readme.md"]]),
    });

    expect(classification.effective).toBe("high");
    expect(classification.escalated).toBe(false);
    expect(maxRiskClass("protected", "normal")).toBe("protected");
  });

  it("records code owners of changed paths without inflating the class", () => {
    const classification = classifyChangeRisk({
      declared: "normal",
      diff: diff([["modified", "src/web/dashboard.ts"]]),
      codeOwners: {
        rules: parseCodeOwners("src/web/ @web-team @platform\n"),
      },
    });

    expect(classification.effective).toBe("normal");
    expect(classification.requiredOwners).toEqual(["@platform", "@web-team"]);
    expect(classification.signals[0]).toMatchObject({
      id: "code-owner",
      riskClass: "normal",
      owners: ["@platform", "@web-team"],
    });
  });

  it("honors repository-supplied signal patterns", () => {
    const classification = classifyChangeRisk({
      declared: "normal",
      diff: diff([["modified", "internal/tenancy/isolation.go"]]),
      policy: {
        protectedPaths: [
          { domain: "tenancy", patterns: ["internal/tenancy/**"] },
        ],
        migrations: [],
        dependencyManifests: [],
        diffSize: { files: 100, lines: 5000 },
      },
    });

    expect(classification.effective).toBe("protected");
    expect(classification.signals[0]).toMatchObject({ domain: "tenancy" });
  });

  it("ties a classification to the diff it was computed from", () => {
    const original = diff([["modified", "src/a.ts"]]);
    const classification = classifyChangeRisk({
      declared: "normal",
      diff: original,
    });

    expect(classification.diffDigest).toBe(diffDigest(original));
    expect(isRiskClassificationStale(classification, original)).toBe(false);
    expect(
      isRiskClassificationStale(
        classification,
        diff([
          ["modified", "src/a.ts"],
          ["modified", "src/auth/session.ts"],
        ]),
      ),
    ).toBe(true);
  });

  it("is order-independent for the same set of changes", () => {
    expect(
      diffDigest(
        diff([
          ["modified", "src/a.ts"],
          ["added", "src/b.ts"],
        ]),
      ),
    ).toBe(
      diffDigest(
        diff([
          ["added", "src/b.ts"],
          ["modified", "src/a.ts"],
        ]),
      ),
    );
  });
});

describe("git diff parsing", () => {
  it("reads name-status output including renames", () => {
    expect(
      parseNameStatusDiff(
        [
          "M\tsrc/a.ts",
          "A\tsrc/b.ts",
          "D\tsrc/c.ts",
          "R094\tsrc/old.ts\tsrc/new.ts",
          "",
        ].join("\n"),
      ),
    ).toEqual([
      { path: "src/a.ts", status: "modified" },
      { path: "src/b.ts", status: "added" },
      { path: "src/c.ts", status: "deleted" },
      { path: "src/new.ts", status: "renamed", previousPath: "src/old.ts" },
    ]);
  });

  it("matches a rename out of a protected path", () => {
    const classification = classifyChangeRisk({
      declared: "normal",
      diff: {
        files: parseNameStatusDiff("R100\tsrc/auth/session.ts\tsrc/lib/session.ts"),
      },
    });

    expect(classification.effective).toBe("protected");
  });

  it("totals changed lines from shortstat", () => {
    expect(
      parseShortStatLines(" 3 files changed, 42 insertions(+), 7 deletions(-)"),
    ).toBe(49);
    expect(parseShortStatLines(" 1 file changed, 5 insertions(+)")).toBe(5);
    expect(parseShortStatLines("")).toBeUndefined();
  });
});
