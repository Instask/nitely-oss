import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  generatePilotSetupReport,
  type PilotSetupCommandRunner,
} from "../../src/pilots/setup-report.js";

async function createPilotRepo(): Promise<{ repoPath: string; flowPath: string }> {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-pilot-setup-"));
  await mkdir(join(repoPath, ".git"));
  await writeFile(join(repoPath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  await writeFile(
    join(repoPath, "nitely.context.json"),
    JSON.stringify({
      version: 1,
      include: ["src/**", "docs/**"],
      exclude: [".env.local"],
      warnOnly: false,
      redactEnv: ["NITELY_*"],
    }),
    "utf8",
  );
  const flowPath = join(repoPath, "flow.json");
  await writeFile(
    flowPath,
    JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "pilot-approved-spec-pr" },
      spec: {
        stages: [
          {
            id: "verify",
            type: "command",
            command: "pnpm run check",
            outputs: ["verification-report"],
          },
        ],
      },
    }),
    "utf8",
  );
  return { repoPath, flowPath };
}

const successfulRunner: PilotSetupCommandRunner = async (command, args, options) => {
  if (command === "node") return { stdout: "v24.17.0\n", stderr: "" };
  if (command === "pnpm") return { stdout: "11.0.7\n", stderr: "" };
  if (command === "codex") return { stdout: "codex 1.0.0\n", stderr: "" };
  if (command === "claude") return { stdout: "claude 2.0.0\n", stderr: "" };
  if (command === "grok" && args.join(" ") === "version") {
    return { stdout: "grok 0.8.0\n", stderr: "" };
  }
  if (command === "pi") return { stdout: "pi 0.1.0\n", stderr: "" };
  if (command === "git" && args.join(" ") === "--version") {
    return { stdout: "git version 2.50.0\n", stderr: "" };
  }
  if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
    return { stdout: `${options.cwd}\n`, stderr: "" };
  }
  if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
    return { stdout: "main\n", stderr: "" };
  }
  throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
};

describe("pilot setup report", () => {
  it("generates a ready customer-hosted runner setup report", async () => {
    const { repoPath, flowPath } = await createPilotRepo();

    const report = await generatePilotSetupReport({
      repoPath,
      flowPath,
      runtimes: ["codex", "claude", "grok", "pi"],
      verifyCommands: ["pnpm run check"],
      env: {
        NITELY_GITHUB_TOKEN: "github-token",
        ANTHROPIC_API_KEY: "anthropic-key",
      },
      now: new Date("2026-07-08T00:00:00.000Z"),
      commandRunner: successfulRunner,
    });

    expect(report.ready).toBe(true);
    expect(report.checks.filter((check) => check.status === "fail")).toEqual([]);
    expect(report.markdown).toContain("# Customer-Hosted Runner Setup Report");
    expect(report.markdown).toContain("Flow: `pilot-approved-spec-pr`");
    expect(report.markdown).toContain("GitHub publishing");
    expect(report.markdown).toContain("Runtime claude");
    expect(report.markdown).toContain("Runtime grok");
    expect(report.markdown).toContain("Runtime pi");
    expect(report.markdown).toContain("Context policy");
    expect(report.markdown).toContain("pnpm run check");
  });

  it("resolves relative flow paths from the repository path", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-pilot-setup-relative-"));
    await mkdir(join(repoPath, ".git"));
    await mkdir(join(repoPath, "flows"));
    await writeFile(join(repoPath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const flowPath = join(repoPath, "flows", "pilot.json");
    await writeFile(
      flowPath,
      JSON.stringify({
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "relative-pilot-flow" },
        spec: {
          stages: [
            {
              id: "verify",
              type: "command",
              command: "pnpm run check",
              outputs: ["verification-report"],
            },
          ],
        },
      }),
      "utf8",
    );

    const report = await generatePilotSetupReport({
      repoPath,
      flowPath: "flows/pilot.json",
      runtimes: ["codex"],
      verifyCommands: ["pnpm run check"],
      env: {
        NITELY_GITHUB_TOKEN: "github-token",
      },
      now: new Date("2026-07-08T00:00:00.000Z"),
      commandRunner: successfulRunner,
    });

    expect(report.ready).toBe(true);
    expect(report.markdown).toContain("Flow: `relative-pilot-flow`");
    expect(report.markdown).toContain(`Flow path: \`${flowPath}\``);
  });

  it("reports missing credentials, verification commands, and context policy risks", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-pilot-setup-missing-"));
    await mkdir(join(repoPath, ".git"));
    const flowPath = join(repoPath, "flow.json");
    await writeFile(
      flowPath,
      JSON.stringify({
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "pilot-bug-ticket-fix-pr" },
        spec: {
          stages: [
            {
              id: "verify",
              type: "command",
              command: "pnpm run check",
              outputs: ["verification-report"],
            },
          ],
        },
      }),
      "utf8",
    );
    const commandRunner: PilotSetupCommandRunner = async (command, args, options) => {
      if (command === "node") return { stdout: "v24.17.0\n", stderr: "" };
      if (command === "pnpm") return { stdout: "11.0.7\n", stderr: "" };
      if (command === "git" && args.join(" ") === "--version") {
        return { stdout: "git version 2.50.0\n", stderr: "" };
      }
      if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
        return { stdout: `${options.cwd}\n`, stderr: "" };
      }
      if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
        return { stdout: "feature/pilot\n", stderr: "" };
      }
      if (command === "gh" && args.join(" ") === "auth status") {
        throw new Error("gh is not authenticated");
      }
      if (command === "claude") return { stdout: "claude 2.0.0\n", stderr: "" };
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };

    const report = await generatePilotSetupReport({
      repoPath,
      flowPath,
      runtimes: ["claude", "glm"],
      verifyCommands: [],
      env: {},
      now: new Date("2026-07-08T00:00:00.000Z"),
      commandRunner,
    });

    expect(report.ready).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "github-publishing", status: "fail" }),
        expect.objectContaining({ id: "runtime.claude.credentials", status: "fail" }),
        expect.objectContaining({ id: "runtime.glm.credentials", status: "fail" }),
        expect.objectContaining({ id: "verify-commands", status: "fail" }),
        expect.objectContaining({ id: "context-policy", status: "warn" }),
      ]),
    );
    expect(report.markdown).toContain("Ready: **no**");
    expect(report.markdown).toContain(
      "Set one of ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN",
    );
    expect(report.markdown).toContain("Add nitely.context.json");
  });
});
