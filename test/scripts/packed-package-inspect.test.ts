import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  goldenPathProofProblems,
  inspectPackedPackage,
  packagePathsFromTarList,
  PACKED_PACKAGE_MISSING_BIN,
  PACKED_PACKAGE_MISSING_EXPORT,
  PACKED_PACKAGE_PRIVATE_PATH,
  packedPackageRegressionProblems,
  privateKeyProblem,
  redactDiagnosticText,
  REQUIRED_PACKED_FILES,
  webStaticProblems,
  type PackedPackageManifest,
} from "../../scripts/packed-package-inspect.js";

const manifest: PackedPackageManifest = {
  name: "nitely",
  bin: { nitely: "./dist/index.js" },
  exports: {
    ".": { types: "./dist/api.d.ts", default: "./dist/api.js" },
    "./runner-control-plane/file-stub": {
      types: "./dist/runner-control-plane/file-stub.d.ts",
      default: "./dist/runner-control-plane/file-stub.js",
    },
    "./runner-control-plane/protocol": {
      types: "./dist/runner-control-plane/protocol.d.ts",
      default: "./dist/runner-control-plane/protocol.js",
    },
  },
};

function validPaths(): string[] {
  return [...REQUIRED_PACKED_FILES, "flows/pilot-bug-ticket-fix-pr.json", "docs/security-and-trust.md"];
}

describe("packed package inspection", () => {
  it("accepts the contracted tarball layout", () => {
    expect(inspectPackedPackage({ paths: validPaths(), manifest })).toEqual([]);
  });

  it("strips the tarball root and ignores directory entries", () => {
    expect(
      packagePathsFromTarList([
        "package/package.json",
        "package/dist/",
        "package/dist/index.js",
        "",
      ]),
    ).toEqual(["package.json", "dist/index.js"]);
  });

  it("rejects a bin or export that does not exist in the tarball", () => {
    const problems = inspectPackedPackage({
      paths: validPaths().filter((path) => path !== "dist/index.js" && path !== "dist/api.js"),
      manifest,
    });
    expect(problems).toContain("missing packed file: dist/index.js");
    expect(problems).toContain("bin nitely points at missing file dist/index.js");
    expect(problems).toContain("export . default points at missing file dist/api.js");
  });

  it("rejects a non-relative bin and a missing shebang or executable bit", () => {
    expect(
      inspectPackedPackage({
        paths: validPaths(),
        manifest: { ...manifest, bin: { nitely: "dist/index.js" } },
      }),
    ).toContain("bin nitely is not a relative file");

    expect(
      inspectPackedPackage({
        paths: validPaths(),
        manifest,
        binTexts: [{ path: "dist/index.js", text: "console.log('no shebang')\n" }],
        modes: [{ path: "dist/index.js", mode: 0o644 }],
      }),
    ).toEqual([
      "bin nitely is missing a shebang",
      "bin nitely is not executable",
    ]);
  });

  it("rejects private Nitely state, worktrees, env files, and key material", () => {
    const problems = inspectPackedPackage({
      paths: [
        ...validPaths(),
        ".nitely/runs/run-1/evidence.md",
        ".worktrees/feature/file.ts",
        "worktrees/feature/file.ts",
        ".env",
        "secrets/id_rsa",
        "certs/server.pem",
        "credentials.json",
      ],
      manifest,
      fileContents: [
        {
          path: "docs/notes.md",
          content: `-----BEGIN ${"RSA"} PRIVATE KEY-----\nabc`,
        },
      ],
    });
    expect(problems).toEqual([
      "forbidden packed path .nitely/runs/run-1/evidence.md (.nitely)",
      "forbidden packed path .worktrees/feature/file.ts (.worktrees)",
      "forbidden packed path worktrees/feature/file.ts (worktrees)",
      "forbidden packed path .env (env file)",
      "forbidden packed path secrets/id_rsa (private key filename)",
      "forbidden packed path certs/server.pem (certificate or key material)",
      "forbidden packed path credentials.json (credentials file)",
      "packed file docs/notes.md contains a private key",
    ]);
    expect(privateKeyProblem("docs/security-and-trust.md", "secrets stay out of logs")).toBeUndefined();
  });

  it("fails closed on the planted bin, export, and private-path regressions", () => {
    const sample = { paths: validPaths(), manifest };
    expect(inspectPackedPackage(sample)).toEqual([]);
    const regressions = packedPackageRegressionProblems(sample);
    expect(regressions.map((regression) => regression.name)).toEqual([
      "broken-bin",
      "broken-export",
      "private-nitely-path",
    ]);
    for (const regression of regressions) {
      expect(regression.problems.some((problem) => problem.includes(regression.planted))).toBe(true);
    }
    expect(regressions[0]?.planted).toBe(PACKED_PACKAGE_MISSING_BIN);
    expect(regressions[1]?.planted).toBe(PACKED_PACKAGE_MISSING_EXPORT);
    expect(regressions[2]?.planted).toBe(PACKED_PACKAGE_PRIVATE_PATH);
    expect(inspectPackedPackage(sample)).toEqual([]);
  });

  it("checks installed web static markers and golden-path proof flags", () => {
    expect(
      webStaticProblems([
        { path: "src/web/static/console.dc.html", text: "<x-dc>" },
        { path: "src/web/static/device.html", text: "Authorize a device" },
        { path: "src/web/static/support.js", text: "dc-runtime" },
      ]),
    ).toEqual([]);
    expect(webStaticProblems([{ path: "src/web/static/console.dc.html", text: "" }])).toContain(
      "web static asset src/web/static/console.dc.html is missing \"<x-dc>\"",
    );

    expect(
      goldenPathProofProblems({
        proof: {
          approvedPlanning: true,
          eligibleImplementationStart: true,
          verifiedImplementation: true,
          draftPullRequest: true,
          evidenceBacked: true,
          controlledSamePullRequestRework: true,
        },
      }),
    ).toEqual([]);
    expect(goldenPathProofProblems({ proof: { approvedPlanning: false } })).toContain(
      "golden path proof approvedPlanning is not true",
    );
  });

  it("redacts demo tokens and credential-shaped text from diagnostic logs", () => {
    expect(
      redactDiagnosticText(
        "token golden-path-demo-token ghp_abc123 github_pat_abc123 sk-abcdef123456 Bearer ghp_nope",
      ),
    ).toBe("token [redacted] [redacted] [redacted] [redacted] Bearer [redacted]");
  });

  it("is wired into Linux CI as the install smoke", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const server = readFileSync("src/web/server.ts", "utf8");

    expect(workflow).toContain("pnpm run build");
    expect(workflow).toContain("pnpm run package:smoke");
    expect(workflow).toContain("package-smoke-diagnostics");
    expect(workflow).toContain("if: failure()");
    expect(packageJson.scripts["package:smoke"]).toContain("package-install-smoke");
    expect(server).toMatch(/"\.\.",\s*"\.\.",\s*"src",\s*"web",\s*"static"/);
    expect(REQUIRED_PACKED_FILES).not.toContain(PACKED_PACKAGE_MISSING_BIN);
  });
});
