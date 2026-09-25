import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { cliCommands, runCli } from "../src/cli.js";
import { parseRemoteRunStatusOption } from "../src/cli/remote.js";
import type { RunFlowInput } from "../src/run/run-flow.js";
import { EventStore } from "../src/events/store.js";
import { eventStorePath } from "../src/run/project.js";
import { projectRun } from "../src/run/project.js";
import { WEB_RUN_STATUSES } from "../src/web/runs.js";
import { createTokenOwner } from "./helpers/token-owner.js";

async function writeCliFlow(flow: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "nitely-cli-"));
  const flowPath = join(directory, "flow.json");
  await writeFile(flowPath, JSON.stringify(flow), "utf8");
  return flowPath;
}

function singleAgentFlow(stage: Record<string, unknown>) {
  return {
    apiVersion: "nitely.dev/v1alpha1",
    kind: "Flow",
    metadata: { name: "hello" },
    spec: {
      stages: [
        {
          id: "implement",
          type: "agent",
          runtime: "mock",
          prompt: "Write hello.",
          outputs: ["implementation"],
          ...stage,
        },
      ],
    },
  };
}

describe("runCli", () => {
  it("prints help when no command is provided", async () => {
    const lines: string[] = [];
    const code = await runCli([], {
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("nitely");
    expect(lines.join("\n")).toContain("validate");
    expect(lines.join("\n")).toContain(
      "graph <flow> [--format text|mermaid|json] [--external-input <name>]",
    );
    expect(lines.join("\n")).toContain("runs");
    expect(lines.join("\n")).toContain("runs [--repo <path>]");
    expect(lines.join("\n")).toContain("metrics --repo <path> [--json]");
    expect(lines.join("\n")).toContain("status <run-id> [--repo <path>]");
    expect(lines.join("\n")).toContain("[--backend local|mise|oci]");
    expect(lines.join("\n")).toContain(
      "run <flow> --repo <path> [--config <key=value>] [--backend local|mise|oci]",
    );
    expect(lines.join("\n")).toContain(
      "run-stage <flow> <stage-id> [--repo <path>] [--input <name>=<path>] [--input-dir <path>] [--dry-run] [--backend local|mise|oci]",
    );
    expect(lines.join("\n")).toContain(
      "resume <run-id> [--checkpoint <checkpoint-id>] [--backend local|mise|oci]",
    );
    expect(lines.join("\n")).not.toContain("cancel");
    expect(lines.join("\n")).toContain("mcp serve");
    expect(lines.join("\n")).toContain("mcp token create");
    expect(lines.join("\n")).toContain("connect --server");
    expect(lines.join("\n")).toContain("whoami");
    expect(lines.join("\n")).toContain("disconnect");
    expect(lines.join("\n")).toContain("evidence search");
    expect(lines.join("\n")).toContain("tasks-to-issues");
    expect(lines.join("\n")).toContain("eval compare");
    expect(lines.join("\n")).toContain("knowledge-repo attach");
    expect(lines.join("\n")).toContain("schedule show");
  });

  it("exports machine-readable factory metrics", async () => {
    const lines: string[] = [];
    const code = await runCli(["metrics", "--repo", "/repo", "--json"], {
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    }, {
      listFactoryWorkItems: async () => [{ status: "ready" } as never],
      listFactoryRuns: async () => [{
        runId: "run-1",
        sessionId: "run-1",
        status: "completed",
        completedStages: ["implement"],
        inputs: {},
        startedAt: "2026-09-18T00:00:00.000Z",
        completedAt: "2026-09-18T00:01:00.000Z",
      }],
      now: () => new Date("2026-09-18T01:00:00.000Z"),
    });

    expect(code).toBe(0);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({
      schemaVersion: "nitely.factory-metrics.v1",
      window: "all",
      metrics: { funnel: { candidate: 1, eligible: 1, queued: 1 } },
    });
  });

  it("dry-runs one stage without invoking the runner", async () => {
    const flowPath = await writeCliFlow({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "review-flow" },
      spec: {
        maxAttempts: 3,
        stages: [
          {
            id: "review",
            type: "gate",
            mode: "review",
            runtime: "mock",
            prompt: "Review the implementation.",
            inputs: ["implementation", "test-report"],
            outputs: ["review"],
          },
        ],
      },
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(
      ["run-stage", flowPath, "review", "--dry-run"],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      {
        runFlow: async () => {
          throw new Error("runner must not be called for --dry-run");
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("TYPE gate");
    expect(stdout.join("\n")).toContain("RUNTIME mock");
    expect(stdout.join("\n")).toContain("INPUTS implementation, test-report");
    expect(stdout.join("\n")).toContain("ATTEMPTS 3");
    expect(stdout.join("\n")).toContain("no worktree, publish, or external PR");
  });

  it("executes one command stage with injected directory artifacts", async () => {
    const flowPath = await writeCliFlow({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "test-flow" },
      spec: {
        stages: [
          {
            id: "test",
            type: "command",
            command: "pnpm test",
            inputs: ["implementation"],
            outputs: ["test-report"],
          },
        ],
      },
    });
    const inputDirectory = await mkdtemp(join(tmpdir(), "nitely-stage-inputs-"));
    await writeFile(join(inputDirectory, "implementation.md"), "implementation summary", "utf8");
    await writeFile(
      join(inputDirectory, "artifact.json"),
      JSON.stringify({ version: 1, outputs: [{ id: "implementation", path: "implementation.md" }] }),
      "utf8",
    );
    let captured: RunFlowInput | undefined;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(
      [
        "run-stage",
        flowPath,
        "test",
        "--repo",
        "/repo",
        "--input-dir",
        inputDirectory,
      ],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      {
        runFlow: async (input) => {
          captured = input;
          return {
            runId: "run-1",
            branchName: "nitely/run-1",
            worktreePath: "/repo/.nitely/runs/run-1/worktree",
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(captured).toBeDefined();
    const replayed = JSON.parse(captured!.flowDocument!) as {
      spec: { stages: Array<{ id: string; type: string }> };
    };
    expect(replayed.spec.stages).toHaveLength(1);
    expect(replayed.spec.stages[0]).toMatchObject({ id: "test", type: "command" });
    expect(captured!.inputs.implementation).toEqual({
      connector: "local-file",
      uri: join(inputDirectory, "implementation.md"),
    });
    expect(stdout.join("\n")).toContain("RUN run-1 completed");
  });

  it("routes eval subcommands through the eval CLI", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["eval"],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Usage: nitely eval");
  });

  it("syncs task artifacts to issues with explicit source paths and grouping", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const calls: unknown[] = [];
    const code = await runCli(
      [
        "tasks-to-issues",
        "--repo",
        "/repo",
        "--tasks",
        "docs/tasks.md",
        "--spec",
        "docs/spec.md",
        "--plan",
        "docs/plan.md",
        "--group-by",
        "phase",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        env: { NITELY_GITHUB_TOKEN: "token" },
        syncTaskIssues: async (input) => {
          calls.push(input);
          return {
            repository: {
              provider: "github",
              owner: "Instask",
              repository: "nitely",
              url: "https://github.com/Instask/nitely",
            },
            grouping: "phase",
            created: 1,
            reused: 1,
            registryPath: "/repo/.nitely/task-issues.json",
            issues: [
              {
                taskIds: ["T001", "T002"],
                outcome: "created",
                issue: {
                  provider: "github",
                  owner: "Instask",
                  repository: "nitely",
                  number: 10,
                  url: "https://github.com/Instask/nitely/issues/10",
                  title: "T001: Foundation (2 tasks)",
                  body: "body",
                  state: "open",
                },
              },
            ],
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(calls).toEqual([
      {
        repoPath: "/repo",
        tasksPath: "docs/tasks.md",
        specPath: "docs/spec.md",
        planPath: "docs/plan.md",
        grouping: "phase",
        env: { NITELY_GITHUB_TOKEN: "token" },
      },
    ]);
    expect(stdout).toEqual([
      "TASK ISSUES synced",
      "Repository: Instask/nitely",
      "Grouping: phase",
      "Created: 1",
      "Reused: 1",
      "Registry: /repo/.nitely/task-issues.json",
      "Created T001, T002: https://github.com/Instask/nitely/issues/10",
    ]);
  });

  it("validates required task issue bridge options before invoking the bridge", async () => {
    const stderr: string[] = [];
    let calls = 0;

    expect(
      await runCli(
        ["tasks-to-issues", "--tasks", "docs/tasks.md", "--group-by", "story"],
        { stdout: () => {}, stderr: (line) => stderr.push(line) },
        {
          syncTaskIssues: async () => {
            calls += 1;
            throw new Error("must not run");
          },
        },
      ),
    ).toBe(1);
    expect(stderr).toEqual(["invalid --group-by value: story"]);
    expect(calls).toBe(0);
  });

  it("creates, lists, and revokes scoped MCP API tokens without reprinting secrets", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-cli-mcp-token-"));
    const owner = await createTokenOwner(repoPath);
    const createdOut: string[] = [];
    const createdErr: string[] = [];
    const createCode = await runCli(
      [
        "mcp",
        "token",
        "create",
        "--repo",
        repoPath,
        "--name",
        "Claude Code",
        "--owner",
        owner.email,
        "--capability",
        "tasks:read",
        "--capability",
        "runs:start",
        "--allow-high-impact",
      ],
      {
        stdout: (line) => createdOut.push(line),
        stderr: (line) => createdErr.push(line),
      },
    );
    expect(createCode).toBe(0);
    expect(createdErr).toEqual([]);
    expect(createdOut).toHaveLength(6);
    expect(createdOut[0]).toMatch(/^API TOKEN tok_[A-Za-z0-9_-]+ created$/);
    expect(createdOut[1]).toBe("Name: Claude Code");
    expect(createdOut[2]).toBe("Capabilities: tasks:read, runs:start");
    expect(createdOut[3]).toBe(`Owner: ${owner.id}`);
    expect(createdOut[4]).toMatch(/^Token: nitely_api_/);
    expect(createdOut[5]).toBe("Store this token now; it will not be shown again.");
    const tokenId = createdOut[0].split(" ")[2];
    const rawToken = createdOut[4].slice("Token: ".length);

    const listedOut: string[] = [];
    expect(
      await runCli(
        ["mcp", "token", "list", "--repo", repoPath],
        {
          stdout: (line) => listedOut.push(line),
          stderr: () => {},
        },
      ),
    ).toBe(0);
    expect(listedOut).toEqual([
      `${tokenId}\tactive\tClaude Code\ttasks:read,runs:start\t${owner.id}`,
    ]);
    expect(listedOut.join("\n")).not.toContain(rawToken);

    const revokedOut: string[] = [];
    expect(
      await runCli(
        ["mcp", "token", "revoke", tokenId, "--repo", repoPath],
        {
          stdout: (line) => revokedOut.push(line),
          stderr: () => {},
        },
      ),
    ).toBe(0);
    expect(revokedOut).toEqual([`API TOKEN ${tokenId} revoked`]);

    const relistedOut: string[] = [];
    await runCli(
      ["mcp", "token", "list", "--repo", repoPath],
      {
        stdout: (line) => relistedOut.push(line),
        stderr: () => {},
      },
    );
    expect(relistedOut).toEqual([
      `${tokenId}\trevoked\tClaude Code\ttasks:read,runs:start\t${owner.id}`,
    ]);
  });

  it("requires high-impact token confirmation and rejects unknown capabilities", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-cli-mcp-token-"));
    const owner = await createTokenOwner(repoPath);
    for (const [capability, expected] of [
      ["runs:start", "high-impact capability requires confirmation: runs:start"],
      ["unknown:scope", "Unknown API token capability: unknown:scope"],
    ] as const) {
      const stderr: string[] = [];
      const code = await runCli(
        [
          "mcp",
          "token",
          "create",
          "--repo",
          repoPath,
          "--name",
          "agent",
          "--owner",
          owner.email,
          "--capability",
          capability,
        ],
        { stdout: () => {}, stderr: (line) => stderr.push(line) },
      );
      expect(code).toBe(1);
      expect(stderr).toEqual([expected]);
    }
  });

  it("refuses to mint an MCP API token without a resolvable owner", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-cli-mcp-token-"));
    const base = ["mcp", "token", "create", "--repo", repoPath, "--name", "agent", "--capability", "tasks:read"];

    const noUsers: string[] = [];
    expect(
      await runCli([...base, "--owner", "someone@example.test"], {
        stdout: () => {},
        stderr: (line) => noUsers.push(line),
      }),
    ).toBe(1);
    expect(noUsers).toEqual([
      "No users exist in this instance yet; start the Web Console once with NITELY_ADMIN_EMAIL and NITELY_ADMIN_PASSWORD set to bootstrap the initial admin, then re-run with --owner <that email>",
    ]);

    const owner = await createTokenOwner(repoPath);

    const missingFlag: string[] = [];
    expect(
      await runCli(base, { stdout: () => {}, stderr: (line) => missingFlag.push(line) }),
    ).toBe(1);
    expect(missingFlag).toEqual(["--owner <email-or-user-id> is required"]);

    const unknown: string[] = [];
    expect(
      await runCli([...base, "--owner", "nobody@example.test"], {
        stdout: () => {},
        stderr: (line) => unknown.push(line),
      }),
    ).toBe(1);
    expect(unknown).toEqual(["Unknown API token owner: nobody@example.test"]);

    const out: string[] = [];
    expect(
      await runCli([...base, "--owner", owner.email.toUpperCase()], {
        stdout: (line) => out.push(line),
        stderr: () => {},
      }),
    ).toBe(0);
    expect(out[3]).toBe(`Owner: ${owner.id}`);
  });

  it("starts stdio MCP from environment credentials without writing to stdout", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const starts: Array<{ serverUrl: string; apiToken: string }> = [];
    const code = await runCli(
      ["mcp", "serve", "--server", "http://127.0.0.1:4174"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        env: { NITELY_API_TOKEN: "secret-token" },
        startMcpServer: async (input) => {
          starts.push(input);
        },
      },
    );
    expect(code).toBe(0);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
    expect(starts).toEqual([
      { serverUrl: "http://127.0.0.1:4174", apiToken: "secret-token" },
    ]);

    const missingErr: string[] = [];
    expect(
      await runCli(
        ["mcp", "serve"],
        { stdout: () => {}, stderr: (line) => missingErr.push(line) },
        { env: {} },
      ),
    ).toBe(1);
    expect(missingErr).toEqual([
      "Missing --server, NITELY_SERVER_URL, or a saved instance from nitely connect",
    ]);

    const tokenFlagErr: string[] = [];
    expect(
      await runCli(
        ["mcp", "serve", "--server", "http://server.test", "--token", "unsafe"],
        { stdout: () => {}, stderr: (line) => tokenFlagErr.push(line) },
        { env: { NITELY_API_TOKEN: "secret-token" } },
      ),
    ).toBe(1);
    expect(tokenFlagErr).toEqual(["Unknown mcp serve option: --token"]);
  });

  it("validates a flow and prints its stage and artifact counts", async () => {
    const flowPath = await writeCliFlow(singleAgentFlow({ inputs: [] }));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(["validate", flowPath], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual(["VALID hello: 1 stages, 1 artifacts"]);
  });

  it("prints a text flow graph by default", async () => {
    const flowPath = await writeCliFlow(singleAgentFlow({ inputs: ["spec"] }));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["graph", flowPath, "--external-input", "spec"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain(
      "STAGE implement agent mock in:spec out:implementation",
    );
    expect(stdout.join("\n")).toContain("INPUT spec");
    expect(stdout.join("\n")).not.toContain("flowchart");
  });

  it("prints mermaid for implement-spec-bootstrap with artifact-labeled edges", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "graph",
        "flows/implement-spec-bootstrap.json",
        "--format",
        "mermaid",
        "--external-input",
        "spec",
        "--external-input",
        "tech-design",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    const mermaid = stdout.join("\n");
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(mermaid).toContain("flowchart TD");
    expect(mermaid).toContain("write-tests -->|tests| implement");
    expect(mermaid).toContain("implement -->|implementation| test");
  });

  it("prints a json flow graph projection", async () => {
    const flowPath = await writeCliFlow(singleAgentFlow({ inputs: ["spec"] }));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["graph", flowPath, "--format", "json", "--external-input", "spec"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      name: "hello",
      externalInputs: ["spec"],
      edges: [{ from: "input:spec", to: "implement", artifact: "spec" }],
    });
  });

  it("fails graph on an invalid flow without printing a partial projection", async () => {
    const flowPath = await writeCliFlow(singleAgentFlow({ inputs: ["spec"] }));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(["graph", flowPath], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("[error]");
    expect(stderr.join("\n")).toContain("unknown artifact: spec");
    expect(stdout.join("\n")).not.toContain("STAGE");
    expect(stdout.join("\n")).not.toContain("flowchart");
  });

  it("rejects an unknown graph format", async () => {
    const flowPath = await writeCliFlow(singleAgentFlow({ inputs: [] }));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(["graph", flowPath, "--format", "dot"], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "Unknown graph format: dot (expected text, mermaid, or json)",
    ]);
  });

  it("validates a flow with a declared external input", async () => {
    const flowPath = await writeCliFlow(singleAgentFlow({ inputs: ["spec"] }));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(["validate", flowPath, "--external-input", "spec"], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual(["VALID hello: 1 stages, 1 artifacts"]);
  });

  it("prints production lint warnings separately from validate errors", async () => {
    const flowPath = await writeCliFlow({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "publish-minimal" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Write hello.",
            outputs: ["implementation", "pr-title"],
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github-cli",
            inputs: ["implementation", "pr-title"],
            outputs: ["change-request"],
          },
        ],
      },
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(["validate", flowPath], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout[0]).toBe("VALID publish-minimal: 2 stages, 3 artifacts");
    expect(stdout.slice(1).join("\n")).toContain("[warning] [production-lint:missing-review-evidence]");
    expect(stdout.slice(1).join("\n")).toContain("[warning] [production-lint:missing-verification-evidence]");
  });

  it("runs a local doctor preflight without starting execution", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["doctor", "flows/preflight.json", "--repo", "/repo", "--input", "spec=spec.md"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        evaluateRunPreflight: async (input) => {
          expect(input).toEqual({
            repoPath: "/repo",
            flowPath: "flows/preflight.json",
            inputs: {
              spec: {
                connector: "local-file",
                uri: resolve(process.cwd(), "spec.md"),
              },
            },
          });
          return {
            status: "PASS",
            summary: "run preflight passed",
            flowPath: "flows/preflight.json",
            flowName: "preflight",
            stageCount: 1,
            artifactCount: 1,
            requiredInputs: ["spec"],
            requiredProviders: ["codex"],
            outputDirectory: ".nitely/preflight",
            executionPlan: [],
            issues: [],
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "DOCTOR PASS preflight: 1 stages, 1 artifacts",
      "Inputs: spec",
      "Providers: codex",
    ]);
  });

  it("returns a non-zero doctor exit code for blocking preflight issues", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["doctor", "flows/preflight.json", "--repo", "/repo"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        evaluateRunPreflight: async () => ({
          status: "BLOCK",
          summary: "run preflight blocks execution",
          flowPath: "flows/preflight.json",
          flowName: "preflight",
          stageCount: 1,
          artifactCount: 1,
          requiredInputs: ["spec"],
          requiredProviders: ["github"],
          outputDirectory: ".nitely/preflight",
          executionPlan: [],
          issues: [
            {
              severity: "blocking",
              code: "missing-provider",
              message: "stage implement requires unconfigured provider: github",
              remediation: "Configure GitHub.",
              stageId: "implement",
              providerId: "github",
            },
          ],
        }),
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "DOCTOR BLOCK preflight: 1 stages, 1 artifacts",
      "Inputs: spec",
      "Providers: github",
      "BLOCKING missing-provider stage implement provider github: stage implement requires unconfigured provider: github",
    ]);
  });

  it("imports a local skill from the CLI", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-cli-skill-repo-"));
    const source = await mkdtemp(join(tmpdir(), "nitely-cli-skill-source-"));
    await writeFile(
      join(source, "SKILL.md"),
      [
        "---",
        "name: cli-review",
        "description: CLI imported skill",
        "---",
        "",
        "Review the generated change.",
        "",
      ].join("\n"),
      "utf8",
    );
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(["skill", "import", source, "--repo", repo], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout[0]).toBe("SKILL imported cli-review");
    expect(stdout[1]).toBe("Target: .nitely/skills/cli-review");
    expect(stdout[2]).toMatch(/^Hash: [a-f0-9]{64}$/);
    expect(stdout[3]).toBe("Resources: 0");
    await expect(
      readFile(join(repo, ".nitely", "skills", "cli-review", "SKILL.md"), "utf8"),
    ).resolves.toContain("CLI imported skill");
  });

  it("returns a CLI error for invalid skill imports", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-cli-skill-repo-"));
    const source = await mkdtemp(join(tmpdir(), "nitely-cli-skill-source-"));
    await writeFile(join(source, "SKILL.md"), "---\nname: broken\n---\nBody\n", "utf8");
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(["skill", "import", source, "--repo", repo], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("missing required frontmatter field: description");
  });

  it("writes pilot setup reports and returns blocked status when required checks fail", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-cli-pilot-repo-"));
    const flowPath = join(repo, "flow.json");
    const outputPath = join(repo, ".nitely", "pilot-setup-report.md");
    await writeFile(flowPath, "{}", "utf8");
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "pilot",
        "setup-report",
        "--repo",
        repo,
        "--flow",
        flowPath,
        "--runtime",
        "claude",
        "--verify-command",
        "pnpm run check",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        generatePilotSetupReport: async (input) => {
          expect(input.repoPath).toBe(repo);
          expect(input.flowPath).toBe(flowPath);
          expect(input.outputPath).toBe(outputPath);
          expect(input.runtimes).toEqual(["claude"]);
          expect(input.verifyCommands).toEqual(["pnpm run check"]);
          return {
            ready: false,
            checks: [
              {
                id: "github-publishing",
                label: "GitHub publishing",
                status: "fail",
                detail: "missing token",
                remediation: "Set NITELY_GITHUB_TOKEN.",
              },
            ],
            markdown: "# Customer-Hosted Runner Setup Report\n\nReady: **no**\n",
          };
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "PILOT SETUP blocked",
      `Report: ${outputPath}`,
      "Failing checks: github-publishing",
    ]);
    await expect(readFile(outputPath, "utf8")).resolves.toContain("Ready: **no**");
  });

  it("runs one scheduler cycle from the CLI", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["scheduler", "--repo", "/repo", "--once"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        runSchedulerOnce: async (input) => {
          expect(input).toEqual({ repoPath: "/repo" });
          return {
            startedTaskIds: ["task-a"],
            completedTaskIds: ["task-a"],
            awaitingApprovalTaskIds: [],
            failedTaskIds: [],
            blockedTaskIds: ["task-b"],
            cooldownTaskIds: ["task-c"],
            cooldownUntil: { "task-c": "2026-07-15T02:00:00.000Z" },
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "SCHEDULER started=1 completed=1 awaitingApproval=0 failed=0 blocked=1",
      "Started: task-a",
      "Blocked: task-b",
      "Cooling down: task-c until 2026-07-15T02:00:00.000Z",
    ]);
  });

  it("passes scheduler concurrency limits from the CLI", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "scheduler",
        "--repo",
        "/repo",
        "--once",
        "--max-concurrent-tasks",
        "3",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        runSchedulerOnce: async (input) => {
          expect(input).toEqual({ repoPath: "/repo", maxConcurrentTasks: 3 });
          return {
            startedTaskIds: [],
            completedTaskIds: [],
            awaitingApprovalTaskIds: [],
            failedTaskIds: [],
            blockedTaskIds: [],
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "SCHEDULER started=0 completed=0 awaitingApproval=0 failed=0 blocked=0",
    ]);
  });

  it("rejects invalid scheduler concurrency limits before running", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "scheduler",
        "--repo",
        "/repo",
        "--once",
        "--max-concurrent-tasks",
        "65",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        runSchedulerOnce: async () => {
          throw new Error("scheduler should not run");
        },
      },
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "maxConcurrentTasks must be an integer between 1 and 64",
    ]);
  });

  it("prints scheduler spec readiness warnings and blockers", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["scheduler", "--repo", "/repo", "--once"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        runSchedulerOnce: async () => ({
          startedTaskIds: ["task-warn"],
          completedTaskIds: ["task-warn"],
          awaitingApprovalTaskIds: [],
          failedTaskIds: [],
          blockedTaskIds: ["task-block"],
          specReadiness: {
            "task-block": {
              status: "BLOCK",
              summary: "spec readiness blocks execution",
              issues: [
                {
                  severity: "blocking",
                  code: "missing-source-specific-functional-requirement",
                  message: "at least one source-specific FR is required before approval",
                  remediation: "Refine the spec.",
                },
              ],
            },
            "task-warn": {
              status: "WARN",
              summary: "spec readiness has warnings",
              issues: [
                {
                  severity: "warning",
                  code: "missing-planning-source",
                  message: "no source snapshot is recorded for this work item",
                  remediation: "Use source-backed planning.",
                },
              ],
            },
          },
        }),
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "SCHEDULER started=1 completed=1 awaitingApproval=0 failed=0 blocked=1",
      "Started: task-warn",
      "Blocked: task-block",
      "Spec readiness task-block: BLOCK - at least one source-specific FR is required before approval",
      "Spec readiness task-warn: WARN - no source snapshot is recorded for this work item",
    ]);
  });

  it("runs one scheduler cycle through a remote Nitely server", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["scheduler", "--server", "http://server.test/", "--once"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        fetch: async (input, init) => {
          expect(String(input)).toBe("http://server.test/api/scheduler/run");
          expect(init?.method).toBe("POST");
          return new Response(
            JSON.stringify({
              summary: {
                startedTaskIds: ["task-a"],
                completedTaskIds: [],
                awaitingApprovalTaskIds: ["task-review"],
                failedTaskIds: [],
                blockedTaskIds: ["task-b"],
                taskErrors: {
                  "task-local": {
                    code: "scheduler_task_processing_failed",
                    message: "Scheduler could not process this Work item",
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "SCHEDULER started=1 completed=0 awaitingApproval=1 failed=0 blocked=1",
      "Started: task-a",
      "Awaiting approval: task-review",
      "Blocked: task-b",
      "Task error task-local: scheduler_task_processing_failed - Scheduler could not process this Work item",
    ]);
  });

  it("passes scheduler concurrency limits to a remote Nitely server", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "scheduler",
        "--server",
        "http://server.test/",
        "--once",
        "--max-concurrent-tasks",
        "4",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        fetch: async (input, init) => {
          expect(String(input)).toBe("http://server.test/api/scheduler/run");
          expect(init?.method).toBe("POST");
          expect(init?.headers).toEqual({ "content-type": "application/json" });
          expect(init?.body).toBe(JSON.stringify({ maxConcurrentTasks: 4 }));
          return new Response(
            JSON.stringify({
              summary: {
                startedTaskIds: [],
                completedTaskIds: [],
                awaitingApprovalTaskIds: [],
                failedTaskIds: [],
                blockedTaskIds: [],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "SCHEDULER started=0 completed=0 awaitingApproval=0 failed=0 blocked=0",
    ]);
  });

  it("runs scheduler cycles continuously while inside the configured window", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const sleeps: number[] = [];
    let calls = 0;

    const code = await runCli(
      [
        "scheduler",
        "--repo",
        "/repo",
        "--window",
        "22:00-23:00",
        "--interval-ms",
        "5",
        "--max-cycles",
        "2",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        now: () => new Date(2026, 0, 1, 22, 15),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        runSchedulerOnce: async (input) => {
          calls += 1;
          expect(input).toEqual({ repoPath: "/repo" });
          return {
            startedTaskIds: [`task-${calls}`],
            completedTaskIds: [],
            awaitingApprovalTaskIds: [],
            failedTaskIds: [],
            blockedTaskIds: [],
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(sleeps).toEqual([5]);
    expect(stdout).toEqual([
      "SCHEDULER window=22:00-23:00 intervalMs=5",
      "SCHEDULER cycle=1",
      "SCHEDULER started=1 completed=0 awaitingApproval=0 failed=0 blocked=0",
      "Started: task-1",
      "SCHEDULER cycle=2",
      "SCHEDULER started=1 completed=0 awaitingApproval=0 failed=0 blocked=0",
      "Started: task-2",
    ]);
  });

  it("runs daemon cycles without a window and wakes at the next cooldown reset", async () => {
    const stdout: string[] = [];
    const sleeps: number[] = [];
    let calls = 0;
    const code = await runCli(
      ["scheduler", "--repo", "/repo", "--daemon", "--interval-ms", "5", "--max-cycles", "2"],
      { stdout: (line) => stdout.push(line), stderr: () => undefined },
      {
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        runSchedulerOnce: async () => {
          calls += 1;
          const cooldownUntil: Record<string, string> = calls === 1
            ? { task: "2026-01-01T00:00:00.003Z" }
            : {};
          return {
            startedTaskIds: [],
            completedTaskIds: [],
            awaitingApprovalTaskIds: [],
            failedTaskIds: [],
            blockedTaskIds: [],
            cooldownUntil,
          };
        },
      },
    );
    expect(code).toBe(0);
    expect(sleeps).toEqual([3]);
    expect(stdout[0]).toBe("SCHEDULER daemon intervalMs=5");
  });

  it("does not run scheduler cycles outside the configured window", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["scheduler", "--repo", "/repo", "--window", "22:00-23:00"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        now: () => new Date(2026, 0, 1, 9, 0),
        runSchedulerOnce: async () => {
          throw new Error("scheduler should not run outside the window");
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "SCHEDULER window=22:00-23:00 inactive; no cycles run",
    ]);
  });

  it("runs continuous scheduler cycles through a remote Nitely server", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const requests: string[] = [];

    const code = await runCli(
      [
        "scheduler",
        "--server",
        "http://server.test/",
        "--window",
        "22:00-23:00",
        "--interval-ms",
        "1",
        "--max-cycles",
        "2",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        now: () => new Date(2026, 0, 1, 22, 30),
        sleep: async () => {},
        fetch: async (input, init) => {
          requests.push(String(input));
          expect(init?.method).toBe("POST");
          return new Response(
            JSON.stringify({
              summary: {
                startedTaskIds: [`remote-${requests.length}`],
                completedTaskIds: [],
                awaitingApprovalTaskIds: [],
                failedTaskIds: [],
                blockedTaskIds: [],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(requests).toEqual([
      "http://server.test/api/scheduler/run",
      "http://server.test/api/scheduler/run",
    ]);
    expect(stdout).toEqual([
      "SCHEDULER window=22:00-23:00 intervalMs=1",
      "SCHEDULER cycle=1",
      "SCHEDULER started=1 completed=0 awaitingApproval=0 failed=0 blocked=0",
      "Started: remote-1",
      "SCHEDULER cycle=2",
      "SCHEDULER started=1 completed=0 awaitingApproval=0 failed=0 blocked=0",
      "Started: remote-2",
    ]);
  });

  it("prints scheduler preflight warnings and blockers", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["scheduler", "--repo", "/repo", "--once"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        runSchedulerOnce: async () => ({
          startedTaskIds: [],
          completedTaskIds: [],
          awaitingApprovalTaskIds: [],
          failedTaskIds: [],
          blockedTaskIds: ["task-block"],
          preflight: {
            "task-block": {
              status: "BLOCK",
              summary: "run preflight blocks execution",
              flowPath: "flows/preflight.json",
              flowName: "preflight",
              stageCount: 1,
              artifactCount: 1,
              requiredInputs: ["spec"],
              requiredProviders: ["github"],
              outputDirectory: ".nitely/preflight",
              executionPlan: [],
              issues: [
                {
                  severity: "blocking",
                  code: "missing-provider",
                  message: "stage implement requires unconfigured provider: github",
                  remediation: "Configure GitHub.",
                  stageId: "implement",
                  providerId: "github",
                },
              ],
            },
          },
        }),
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "SCHEDULER started=0 completed=0 awaitingApproval=0 failed=0 blocked=1",
      "Blocked: task-block",
      "Preflight task-block: BLOCK - stage implement requires unconfigured provider: github",
    ]);
  });

  it("uses NITELY_SERVER_URL for remote scheduler runs", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["scheduler", "--once"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        env: { NITELY_SERVER_URL: "http://env-server.test/" },
        fetch: async (input, init) => {
          expect(String(input)).toBe("http://env-server.test/api/scheduler/run");
          expect(init?.method).toBe("POST");
          return new Response(
            JSON.stringify({
              summary: {
                startedTaskIds: [],
                completedTaskIds: [],
                awaitingApprovalTaskIds: [],
                failedTaskIds: [],
                blockedTaskIds: [],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "SCHEDULER started=0 completed=0 awaitingApproval=0 failed=0 blocked=0",
    ]);
  });

  it("keeps the scheduler local when only a saved instance is connected", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "nitely-cli-instance-"));
    expect(
      await runCli(
        ["connect", "--server", "http://saved.test"],
        { stdout: () => {}, stderr: () => {} },
        {
          env: {
            NITELY_CONFIG_DIR: configDir,
            NITELY_API_TOKEN: "saved-token",
          },
        },
      ),
    ).toBe(0);

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(
      ["scheduler", "--repo", "/repo", "--once"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        env: { NITELY_CONFIG_DIR: configDir },
        fetch: async () => {
          throw new Error("scheduler must not reach the saved instance");
        },
        runSchedulerOnce: async (input) => {
          expect(input).toEqual({ repoPath: "/repo" });
          return {
            startedTaskIds: [],
            completedTaskIds: [],
            awaitingApprovalTaskIds: [],
            failedTaskIds: [],
            blockedTaskIds: [],
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "SCHEDULER started=0 completed=0 awaitingApproval=0 failed=0 blocked=0",
    ]);
  });

  it("smokes credential-backed GitHub issue intake through a remote Web server", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const requests: Array<{ url: string; init?: RequestInit }> = [];

    const code = await runCli(
      [
        "smoke",
        "github-issue-intake",
        "--server",
        "http://server.test/",
        "--issue",
        "https://github.com/Instask/nitely/issues/296",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        fetch: async (input, init) => {
          const url = String(input);
          requests.push({ url, init });
          if (url === "http://server.test/api/providers") {
            return new Response(
              JSON.stringify({
                providers: [
                  {
                    id: "github",
                    name: "GitHub",
                    configured: true,
                    message: "Configured in Web Console.",
                    hints: [],
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          expect(url).toBe("http://server.test/api/draft-specs");
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toEqual({
            sourceType: "github-issue",
            issue: "https://github.com/Instask/nitely/issues/296",
          });
          return new Response(
            JSON.stringify({
              task: {
                id: "task-smoke",
                source: {
                  type: "github-issue",
                  uri: "https://github.com/Instask/nitely/issues/296",
                  snapshot: {
                    uri: "https://github.com/Instask/nitely/issues/296",
                    title: "Credential-backed intake",
                    body: "Use configured Web credentials for private issue intake.",
                    fetchedAt: "2026-06-28T09:00:00.000Z",
                    comments: [{ body: "Include comments in the source snapshot." }],
                  },
                },
              },
              spec: "# Feature Spec: Credential-backed intake\n",
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(stdout).toEqual([
      "SMOKE github-issue-intake ok",
      "Issue: https://github.com/Instask/nitely/issues/296",
      "Task: task-smoke",
      "Source: Credential-backed intake (body=present comments=1)",
    ]);
  });

  it("runs the local golden path smoke command", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["smoke", "golden-path", "--output", "/tmp/nitely-demo"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        runGoldenPathDemo: async (input) => {
          expect(input).toEqual({ outputDir: "/tmp/nitely-demo" });
          return {
            outputDir: input.outputDir,
            repoPath: "/tmp/nitely-demo/fixture-repo",
            taskId: "golden-path-task",
            implementationRunId: "run-golden-implementation",
            implementationEvidencePath:
              "/tmp/nitely-demo/fixture-repo/.nitely/runs/run-golden-implementation/evidence.md",
            draftPullRequestUrl: "https://github.com/Instask/nitely/pull/1",
            reworkRunId: "run-golden-rework",
            reworkEvidencePath:
              "/tmp/nitely-demo/fixture-repo/.nitely/runs/run-golden-rework/evidence.md",
            updatedPullRequestUrl: "https://github.com/Instask/nitely/pull/1",
            proof: {
              approvedPlanning: true,
              eligibleImplementationStart: true,
              verifiedImplementation: true,
              draftPullRequest: true,
              evidenceBacked: true,
              controlledSamePullRequestRework: true,
            },
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "SMOKE golden-path ok",
      "Output: /tmp/nitely-demo",
      "Task: golden-path-task",
      "Implementation run: run-golden-implementation",
      "Draft PR: https://github.com/Instask/nitely/pull/1",
      "Rework run: run-golden-rework",
      "Updated PR: https://github.com/Instask/nitely/pull/1",
      "Proof: 6/6 passed (approved planning, eligible implementation start, verification/review, draft PR, evidence, same-PR rework)",
      "Evidence: /tmp/nitely-demo/fixture-repo/.nitely/runs/run-golden-implementation/evidence.md",
      "Evidence: /tmp/nitely-demo/fixture-repo/.nitely/runs/run-golden-rework/evidence.md",
    ]);
  });

  it("skips the GitHub issue intake smoke when Web reports no GitHub credentials", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const requests: string[] = [];

    const code = await runCli(
      [
        "smoke",
        "github-issue-intake",
        "--server",
        "http://server.test/",
        "--issue",
        "https://github.com/Instask/nitely/issues/296",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        fetch: async (input) => {
          requests.push(String(input));
          return new Response(
            JSON.stringify({
              providers: [
                {
                  id: "github",
                  name: "GitHub",
                  configured: false,
                  message: "Set NITELY_GITHUB_TOKEN or GITHUB_TOKEN.",
                  hints: [],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(requests).toEqual(["http://server.test/api/providers"]);
    expect(stdout).toEqual([
      "SMOKE github-issue-intake skipped: GitHub provider credentials are not configured on http://server.test. Configure NITELY_GITHUB_TOKEN, GITHUB_TOKEN, or the Web Console GitHub provider connection.",
    ]);
  });

  it("fails the GitHub issue intake smoke with API credential guidance", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "smoke",
        "github-issue-intake",
        "--server",
        "http://server.test/",
        "--issue",
        "https://github.com/Instask/nitely/issues/296",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        fetch: async (input) => {
          const url = String(input);
          if (url === "http://server.test/api/providers") {
            return new Response(
              JSON.stringify({
                providers: [
                  {
                    id: "github",
                    name: "GitHub",
                    configured: true,
                    message: "Configured in Web Console.",
                    hints: [],
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return new Response(
            JSON.stringify({
              error: {
                message:
                  "GitHub issue could not be fetched because configured GitHub credentials were rejected or do not have access. Update NITELY_GITHUB_TOKEN, GITHUB_TOKEN, or the Web Console GitHub provider connection with access to the repository.",
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "remote GitHub issue intake smoke failed (HTTP 400): GitHub issue could not be fetched because configured GitHub credentials were rejected or do not have access. Update NITELY_GITHUB_TOKEN, GITHUB_TOKEN, or the Web Console GitHub provider connection with access to the repository.",
    ]);
  });

  it("builds and queries the repository index from the CLI", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-cli-index-"));
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(
      join(repo, "src", "helper.ts"),
      "export function helper() { return 'ok'; }\n",
      "utf8",
    );
    await writeFile(
      join(repo, "src", "main.ts"),
      "import { helper } from './helper.js';\nexport class MainService { run() { return helper(); } }\n",
      "utf8",
    );
    const stdout: string[] = [];
    const stderr: string[] = [];

    const buildCode = await runCli(["repo-index", "build", "--repo", repo], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    const queryCode = await runCli(["repo-index", "query", "--repo", repo, "MainService"], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(buildCode).toBe(0);
    expect(queryCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("INDEX ");
    expect(stdout.join("\n")).toContain("2 files");
    expect(stdout.join("\n")).toContain("INDEX QUERY MainService");
    expect(stdout.join("\n")).toContain("- src/main.ts [symbol]");
    expect(stdout.join("\n")).toContain("- src/helper.ts [import]");
  });

  it("records repository index query evidence when run metadata is supplied", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-cli-index-"));
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(
      join(repo, "src", "main.ts"),
      "export class MainService {}\n",
      "utf8",
    );
    const buildStdout: string[] = [];
    const queryStdout: string[] = [];
    const stderr: string[] = [];
    await runCli(["repo-index", "build", "--repo", repo], {
      stdout: (line) => buildStdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    const queryCode = await runCli(
      [
        "repo-index",
        "query",
        "--repo",
        repo,
        "MainService",
        "--run",
        "run-index",
        "--stage",
        "implement",
        "--attempt",
        "1",
      ],
      {
        stdout: (line) => queryStdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    const store = new EventStore(eventStorePath(repo));
    const projection = projectRun(store.list("run-index"));
    store.close();

    expect(queryCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(projection.repoIndexQueries).toEqual([
      expect.objectContaining({
        query: "MainService",
        stageId: "implement",
        attempt: 1,
        matchCount: 1,
        matches: [
          {
            path: "src/main.ts",
            reasons: ["symbol"],
          },
        ],
      }),
    ]);
  });

  it("routes knowledge repository lifecycle and query commands through injected services", async () => {
    const calls: Array<{ action: string; input: unknown }> = [];
    const knowledgeRepositories = {
      attach: async (input: unknown) => {
        calls.push({ action: "attach", input });
        return { action: "attach", attachmentId: "standards" };
      },
      list: async (input: unknown) => {
        calls.push({ action: "list", input });
        return { action: "list", attachments: [] };
      },
      status: async (input: unknown) => {
        calls.push({ action: "status", input });
        return { action: "status", attachmentId: "standards", state: "ready" };
      },
      refresh: async (input: unknown) => {
        calls.push({ action: "refresh", input });
        return { action: "refresh", attachmentId: "standards", state: "ready" };
      },
      query: async (input: unknown) => {
        calls.push({ action: "query", input });
        return { action: "query", matches: [] };
      },
      detach: async (input: unknown) => {
        calls.push({ action: "detach", input });
        return { action: "detach", attachmentId: "standards" };
      },
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    };

    const codes = await Promise.all([
      runCli(
        [
          "knowledge-repo",
          "attach",
          "--repo",
          "/repo",
          "--id",
          "standards",
          "--name",
          "Platform standards",
          "--source",
          "https://github.com/acme/standards",
          "--ref",
          "main",
          "--include",
          "docs/**",
          "--exclude",
          "private/**",
          "--required",
          "--embedding-provider",
          "ollama",
          "--embedding-model",
          "nomic-embed-text",
          "--json",
        ],
        io,
        { knowledgeRepositories },
      ),
      runCli(
        ["knowledge-repo", "list", "--repo", "/repo", "--json"],
        io,
        { knowledgeRepositories },
      ),
      runCli(
        [
          "knowledge-repo",
          "status",
          "--repo",
          "/repo",
          "--id",
          "standards",
          "--json",
        ],
        io,
        { knowledgeRepositories },
      ),
      runCli(
        [
          "knowledge-repo",
          "refresh",
          "--repo",
          "/repo",
          "--id",
          "standards",
          "--json",
        ],
        io,
        { knowledgeRepositories },
      ),
      runCli(
        [
          "knowledge-repo",
          "query",
          "--repo",
          "/repo",
          "--query",
          "idempotent imports",
          "--attachment",
          "standards",
          "--limit",
          "3",
          "--json",
        ],
        io,
        { knowledgeRepositories },
      ),
      runCli(
        [
          "knowledge-repo",
          "detach",
          "--repo",
          "/repo",
          "--id",
          "standards",
          "--json",
        ],
        io,
        { knowledgeRepositories },
      ),
    ]);

    expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
    expect(stderr).toEqual([]);
    expect(stdout.map((line) => JSON.parse(line))).toEqual([
      { action: "attach", attachmentId: "standards" },
      { action: "list", attachments: [] },
      { action: "status", attachmentId: "standards", state: "ready" },
      { action: "refresh", attachmentId: "standards", state: "ready" },
      { action: "query", matches: [] },
      { action: "detach", attachmentId: "standards" },
    ]);
    expect(calls).toEqual([
      {
        action: "attach",
        input: {
          targetRepoPath: "/repo",
          attachment: {
            id: "standards",
            name: "Platform standards",
            source: {
              type: "remote",
              providerId: "github",
              url: "https://github.com/acme/standards",
            },
            ref: { type: "branch", value: "main" },
            paths: { include: ["docs/**"], exclude: ["private/**"] },
            required: true,
            retrieval: {
              providerId: "ollama",
              model: "nomic-embed-text",
            },
          },
        },
      },
      { action: "list", input: { targetRepoPath: "/repo" } },
      {
        action: "status",
        input: { targetRepoPath: "/repo", attachmentId: "standards" },
      },
      {
        action: "refresh",
        input: { targetRepoPath: "/repo", attachmentId: "standards" },
      },
      {
        action: "query",
        input: {
          targetRepoPath: "/repo",
          query: "idempotent imports",
          attachmentIds: ["standards"],
          topK: 3,
        },
      },
      {
        action: "detach",
        input: { targetRepoPath: "/repo", attachmentId: "standards" },
      },
    ]);
  });

  it("rejects incomplete knowledge repository attachment commands before service execution", async () => {
    let called = false;
    const stderr: string[] = [];
    const code = await runCli(
      [
        "knowledge-repo",
        "attach",
        "--repo",
        "/repo",
        "--id",
        "standards",
        "--name",
        "Platform standards",
        "--source",
        "/knowledge/standards",
      ],
      { stdout: () => undefined, stderr: (line) => stderr.push(line) },
      {
        knowledgeRepositories: {
          attach: async () => {
            called = true;
            return {};
          },
          list: async () => ({}),
          status: async () => ({}),
          refresh: async () => ({}),
          query: async () => ({}),
          detach: async () => ({}),
        },
      },
    );

    expect(code).toBe(1);
    expect(called).toBe(false);
    expect(stderr).toEqual(["Missing --ref"]);
  });

  it("prints concise human-readable knowledge repository status", async () => {
    const stdout: string[] = [];
    const code = await runCli(
      ["knowledge-repo", "list", "--repo", "/repo"],
      { stdout: (line) => stdout.push(line), stderr: () => undefined },
      {
        knowledgeRepositories: {
          attach: async () => ({}),
          list: async () => [
            {
              attachment: { id: "standards", name: "Platform standards" },
              status: { state: "ready" },
            },
          ],
          status: async () => ({}),
          refresh: async () => ({}),
          query: async () => ({}),
          detach: async () => ({}),
        },
      },
    );

    expect(code).toBe(0);
    expect(stdout).toEqual([
      "KNOWLEDGE REPOSITORIES: 1",
      "- standards: Platform standards [ready]",
    ]);
  });

  it("omits local source and runtime index paths from knowledge JSON output", async () => {
    const stdout: string[] = [];
    const code = await runCli(
      ["knowledge-repo", "status", "--repo", "/repo", "--id", "standards", "--json"],
      { stdout: (line) => stdout.push(line), stderr: () => undefined },
      {
        knowledgeRepositories: {
          attach: async () => ({}),
          list: async () => [],
          status: async () => ({
            attachment: {
              id: "standards",
              source: { type: "local", path: "/private/knowledge/standards" },
            },
            status: {
              state: "ready",
              currentSnapshot: {
                indexPath: "/private/runtime/index.json",
                indexDigest: `sha256:${"a".repeat(64)}`,
              },
            },
          }),
          refresh: async () => ({}),
          query: async () => ({}),
          detach: async () => ({}),
        },
      },
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout[0]!)).toEqual({
      attachment: { id: "standards", source: { type: "local" } },
      status: {
        state: "ready",
        currentSnapshot: { indexDigest: `sha256:${"a".repeat(64)}` },
      },
    });
  });

  it("redacts credentials from knowledge repository service errors", async () => {
    const stderr: string[] = [];
    const code = await runCli(
      ["knowledge-repo", "list", "--repo", "/repo"],
      { stdout: () => undefined, stderr: (line) => stderr.push(line) },
      {
        knowledgeRepositories: {
          attach: async () => ({}),
          list: async () => {
            throw new Error(
              "fetch failed for https://alice:secret-value@github.com/acme/standards.git",
            );
          },
          status: async () => ({}),
          refresh: async () => ({}),
          query: async () => ({}),
          detach: async () => ({}),
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr.join("\n")).not.toContain("alice");
    expect(stderr.join("\n")).not.toContain("secret-value");
    expect(stderr.join("\n")).toContain("[REDACTED]");
  });

  it("uses the production knowledge repository service when no CLI override is injected", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-cli-knowledge-repo-"));
    const runtimeRoot = await mkdtemp(
      join(tmpdir(), "nitely-cli-knowledge-runtime-"),
    );
    const stdout: string[] = [];
    const stderr: string[] = [];

    const listCode = await runCli(
      [
        "knowledge-repo",
        "list",
        "--repo",
        repo,
        "--runtime-root",
        runtimeRoot,
        "--json",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );
    const queryCode = await runCli(
      [
        "knowledge-repo",
        "query",
        "--repo",
        repo,
        "--runtime-root",
        runtimeRoot,
        "--query",
        "idempotent imports",
        "--json",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(listCode).toBe(0);
    expect(queryCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(2);
    expect(JSON.parse(stdout[0]!)).toEqual([]);
    expect(JSON.parse(stdout[1]!)).toMatchObject({
      mode: "lexical",
      matches: [],
      selectedCount: 0,
      truncatedCount: 0,
    });
  });

  it("creates a remote task from local spec and tech design files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nitely-cli-task-"));
    const specPath = join(directory, "spec.md");
    const techDesignPath = join(directory, "tech-design.md");
    await writeFile(specPath, "remote spec", "utf8");
    await writeFile(techDesignPath, "remote tech design", "utf8");
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "task",
        "create",
        "--server",
        "http://server.test",
        "--title",
        "Remote task",
        "--issue",
        "https://github.com/Instask/nitely/issues/81",
        "--spec",
        specPath,
        "--tech-design",
        techDesignPath,
        "--flow",
        "flows/implement-spec-bootstrap.json",
        "--repo-id",
        "nitely",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        fetch: async (input, init) => {
          expect(String(input)).toBe("http://server.test/api/tasks");
          expect(init?.method).toBe("POST");
          expect(init?.headers).toEqual({ "content-type": "application/json" });
          const body = JSON.parse(String(init?.body));
          expect(body).toEqual({
            title: "Remote task",
            spec: "remote spec",
            techDesign: "remote tech design",
            issueUrl: "https://github.com/Instask/nitely/issues/81",
            flowPath: "flows/implement-spec-bootstrap.json",
            repoId: "nitely",
          });
          return new Response(
            JSON.stringify({
              task: {
                id: "task-81",
                status: "ready",
                issueUrl: "https://github.com/Instask/nitely/issues/81",
              },
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "TASK task-81 ready",
      "Issue: https://github.com/Instask/nitely/issues/81",
      "Web: http://server.test/tasks/task-81",
    ]);
  });

  it("plans a draft task from prompt intake without spec or tech design files", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "task",
        "plan",
        "--server",
        "http://server.test",
        "--prompt",
        "Let operators import repositories from a pasted GitHub URL.",
        "--title",
        "Repository import",
        "--guidance",
        "Keep the first slice small.",
        "--repo-id",
        "nitely",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        fetch: async (input, init) => {
          expect(String(input)).toBe("http://server.test/api/draft-specs");
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toEqual({
            sourceType: "prompt",
            prompt: "Let operators import repositories from a pasted GitHub URL.",
            title: "Repository import",
            guidance: "Keep the first slice small.",
            repoId: "nitely",
          });
          return new Response(
            JSON.stringify({
              task: {
                id: "task-901",
                status: "draft",
                specStatus: "draft",
                source: { type: "prompt" },
              },
              spec: "# Feature Spec",
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "TASK task-901 draft",
      "Source: prompt",
      "Spec: draft  Tech design: draft",
      "Web: http://server.test/tasks/task-901",
      "Next: nitely task approve-spec task-901",
    ]);
  });

  it("plans a draft task from a GitHub issue URL", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "task",
        "plan",
        "--server",
        "http://server.test",
        "--issue",
        "https://github.com/Instask/nitely/issues/578",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        fetch: async (input, init) => {
          expect(String(input)).toBe("http://server.test/api/draft-specs");
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toEqual({
            sourceType: "github-issue",
            issue: "https://github.com/Instask/nitely/issues/578",
          });
          return new Response(
            JSON.stringify({
              task: {
                id: "task-904",
                status: "draft",
                specStatus: "draft",
                source: {
                  type: "github-issue",
                  uri: "https://github.com/Instask/nitely/issues/578",
                },
              },
              spec: "# Feature Spec",
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "TASK task-904 draft",
      "Source: github-issue · https://github.com/Instask/nitely/issues/578",
      "Spec: draft  Tech design: draft",
      "Web: http://server.test/tasks/task-904",
      "Next: nitely task approve-spec task-904",
    ]);
  });

  it("plans a draft task from a Jira ticket", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "task",
        "plan",
        "--server",
        "http://server.test",
        "--jira",
        "PLAT-142",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        fetch: async (input, init) => {
          expect(String(input)).toBe("http://server.test/api/draft-specs");
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toEqual({
            sourceType: "jira-ticket",
            issue: "PLAT-142",
          });
          return new Response(
            JSON.stringify({
              task: {
                id: "task-905",
                status: "draft",
                specStatus: "draft",
                source: {
                  type: "jira-ticket",
                  uri: "PLAT-142",
                },
              },
              spec: "# Feature Spec",
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "TASK task-905 draft",
      "Source: jira-ticket · PLAT-142",
      "Spec: draft  Tech design: draft",
      "Web: http://server.test/tasks/task-905",
      "Next: nitely task approve-spec task-905",
    ]);
  });

  it("plans a draft task from an external document snapshot and reports source drift on reuse", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nitely-cli-intake-"));
    const documentPath = join(directory, "policy.md");
    await writeFile(documentPath, "Every release publishes a draft PR.", "utf8");
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "task",
        "plan",
        "--server",
        "http://server.test",
        "--document-url",
        "https://example.feishu.cn/docx/ABC123",
        "--document-file",
        documentPath,
        "--document-version",
        "rev-42",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        fetch: async (input, init) => {
          expect(String(input)).toBe("http://server.test/api/draft-specs");
          expect(JSON.parse(String(init?.body))).toEqual({
            sourceType: "external-document",
            text: "Every release publishes a draft PR.",
            documentUrl: "https://example.feishu.cn/docx/ABC123",
            documentVersion: "rev-42",
          });
          return new Response(
            JSON.stringify({
              task: {
                id: "task-902",
                status: "draft",
                specStatus: "draft",
                source: {
                  type: "external-document",
                  uri: "https://example.feishu.cn/docx/ABC123",
                },
              },
              ingestion: { created: false, reused: true, driftStatus: "changed" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "TASK task-902 draft",
      "Source: external-document · https://example.feishu.cn/docx/ABC123",
      "Spec: draft  Tech design: draft",
      "Existing task reused: the source changed since planning was approved. Refresh planning before starting a run.",
      "Web: http://server.test/tasks/task-902",
      "Next: nitely task approve-spec task-902",
    ]);
  });

  it("sends recorded planning turns from a conversation file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nitely-cli-intake-"));
    const conversationPath = join(directory, "conversation.json");
    await writeFile(
      conversationPath,
      JSON.stringify({
        turns: [
          { role: "operator", text: "Import repositories from a pasted URL." },
          { role: "agent", text: "Which providers?" },
          { role: "operator", text: "GitHub only." },
        ],
      }),
      "utf8",
    );
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "task",
        "plan",
        "--server",
        "http://server.test",
        "--conversation",
        conversationPath,
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        fetch: async (input, init) => {
          expect(JSON.parse(String(init?.body))).toEqual({
            sourceType: "prompt",
            conversation: [
              { role: "operator", text: "Import repositories from a pasted URL." },
              { role: "agent", text: "Which providers?" },
              { role: "operator", text: "GitHub only." },
            ],
          });
          return new Response(
            JSON.stringify({
              task: { id: "task-903", status: "draft", specStatus: "draft" },
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout[0]).toBe("TASK task-903 draft");
  });

  it("refuses to mix planning intake with artifact-first task creation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nitely-cli-intake-"));
    const specPath = join(directory, "spec.md");
    await writeFile(specPath, "remote spec", "utf8");
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "task",
        "create",
        "--server",
        "http://server.test",
        "--title",
        "Remote task",
        "--spec",
        specPath,
        "--prompt",
        "Import repositories",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        fetch: async () => {
          throw new Error("fetch must not be called");
        },
      },
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr[0]).toContain(
      "--prompt cannot be combined with --spec or --tech-design",
    );
  });

  it("requires one intake source for task plan", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["task", "plan", "--server", "http://server.test"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        fetch: async () => {
          throw new Error("fetch must not be called");
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr[0]).toContain("task plan requires one intake source");
  });

  it("drafts a technical design for a remote task from the approved spec", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["task", "draft-tech-design", "task-901", "--server", "http://server.test"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        fetch: async (input, init) => {
          expect(String(input)).toBe(
            "http://server.test/api/tasks/task-901/draft-tech-design",
          );
          expect(init?.method).toBe("POST");
          return new Response(
            JSON.stringify({
              task: { id: "task-901", techDesignStatus: "draft" },
              techDesign: "# Technical Plan",
              openQuestions: ["Which module should own the import?"],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "TASK task-901 tech-design draft",
      "Open question: Which module should own the import?",
      "Next: nitely task approve-tech-design task-901",
    ]);
  });

  it("rejects missing remote task files before calling the server", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nitely-cli-task-"));
    const techDesignPath = join(directory, "tech-design.md");
    await writeFile(techDesignPath, "remote tech design", "utf8");
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "task",
        "create",
        "--server",
        "http://server.test",
        "--title",
        "Remote task",
        "--spec",
        join(directory, "missing-spec.md"),
        "--tech-design",
        techDesignPath,
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        fetch: async () => {
          throw new Error("fetch must not be called");
        },
      },
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr[0]).toContain("failed to read --spec file:");
  });

  it("prints remote task server errors with HTTP status and message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nitely-cli-task-"));
    const specPath = join(directory, "spec.md");
    const techDesignPath = join(directory, "tech-design.md");
    await writeFile(specPath, "remote spec", "utf8");
    await writeFile(techDesignPath, "remote tech design", "utf8");
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "task",
        "create",
        "--server",
        "http://server.test",
        "--title",
        "Remote task",
        "--spec",
        specPath,
        "--tech-design",
        techDesignPath,
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        fetch: async () =>
          new Response(
            JSON.stringify({ error: { message: "specification text is required" } }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
      },
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "remote task create failed (HTTP 400): specification text is required",
    ]);
  });

  it("rejects invalid remote task success payloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nitely-cli-task-"));
    const specPath = join(directory, "spec.md");
    const techDesignPath = join(directory, "tech-design.md");
    await writeFile(specPath, "remote spec", "utf8");
    await writeFile(techDesignPath, "remote tech design", "utf8");
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "task",
        "create",
        "--server",
        "http://server.test",
        "--title",
        "Remote task",
        "--spec",
        specPath,
        "--tech-design",
        techDesignPath,
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        fetch: async () =>
          new Response(JSON.stringify({ task: { status: "ready" } }), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
      },
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "remote task create failed: invalid response: missing task.id",
    ]);
  });

  it("uses NITELY_SERVER_URL when creating a remote task without --server", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nitely-cli-task-"));
    const specPath = join(directory, "spec.md");
    const techDesignPath = join(directory, "tech-design.md");
    await writeFile(specPath, "remote spec", "utf8");
    await writeFile(techDesignPath, "remote tech design", "utf8");
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "task",
        "create",
        "--title",
        "Remote task",
        "--spec",
        specPath,
        "--tech-design",
        techDesignPath,
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        env: { NITELY_SERVER_URL: "http://env-server.test/" },
        fetch: async (input) => {
          expect(String(input)).toBe("http://env-server.test/api/tasks");
          return new Response(
            JSON.stringify({ task: { id: "task-env", status: "ready" } }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "TASK task-env ready",
      "Web: http://env-server.test/tasks/task-env",
    ]);
  });

  it("connects, reports, and disconnects the current instance without printing the token", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "nitely-cli-instance-"));
    const env = {
      NITELY_CONFIG_DIR: configDir,
      NITELY_API_TOKEN: "nitely_api_secret",
    };
    const connectedOut: string[] = [];
    const connectedErr: string[] = [];
    expect(
      await runCli(
        ["connect", "--server", "http://192.168.50.177:4173/"],
        {
          stdout: (line) => connectedOut.push(line),
          stderr: (line) => connectedErr.push(line),
        },
        { env },
      ),
    ).toBe(0);
    expect(connectedErr).toEqual([]);
    expect(connectedOut).toEqual([
      "Connected: http://192.168.50.177:4173",
      "API token: configured",
    ]);
    expect(connectedOut.join("\n")).not.toContain("nitely_api_secret");

    const whoamiOut: string[] = [];
    expect(
      await runCli(
        ["whoami"],
        { stdout: (line) => whoamiOut.push(line), stderr: () => {} },
        { env: { NITELY_CONFIG_DIR: configDir } },
      ),
    ).toBe(0);
    expect(whoamiOut).toEqual([
      "Connected: http://192.168.50.177:4173",
      "API token: configured",
    ]);
    expect(whoamiOut.join("\n")).not.toContain("nitely_api_secret");

    const disconnectedOut: string[] = [];
    expect(
      await runCli(
        ["disconnect"],
        { stdout: (line) => disconnectedOut.push(line), stderr: () => {} },
        { env: { NITELY_CONFIG_DIR: configDir } },
      ),
    ).toBe(0);
    expect(disconnectedOut).toEqual(["Disconnected"]);

    const missingOut: string[] = [];
    const missingErr: string[] = [];
    expect(
      await runCli(
        ["whoami"],
        {
          stdout: (line) => missingOut.push(line),
          stderr: (line) => missingErr.push(line),
        },
        { env: { NITELY_CONFIG_DIR: configDir } },
      ),
    ).toBe(1);
    expect(missingOut).toEqual([]);
    expect(missingErr).toEqual([
      "Not connected. Run nitely connect --server <url>.",
    ]);
  });

  it("rejects --token on connect", async () => {
    const stderr: string[] = [];
    expect(
      await runCli(
        ["connect", "--server", "http://server.test", "--token", "unsafe"],
        { stdout: () => {}, stderr: (line) => stderr.push(line) },
        { env: { NITELY_CONFIG_DIR: await mkdtemp(join(tmpdir(), "nitely-cli-instance-")) } },
      ),
    ).toBe(1);
    expect(stderr).toEqual(["Unknown connect option: --token"]);
  });

  it("creates a remote task from the saved instance and bearer token", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "nitely-cli-instance-"));
    const directory = await mkdtemp(join(tmpdir(), "nitely-cli-task-"));
    const specPath = join(directory, "spec.md");
    const techDesignPath = join(directory, "tech-design.md");
    await writeFile(specPath, "remote spec", "utf8");
    await writeFile(techDesignPath, "remote tech design", "utf8");
    expect(
      await runCli(
        ["connect", "--server", "http://saved.test"],
        { stdout: () => {}, stderr: () => {} },
        {
          env: {
            NITELY_CONFIG_DIR: configDir,
            NITELY_API_TOKEN: "saved-token",
          },
        },
      ),
    ).toBe(0);

    const stdout: string[] = [];
    const headers: unknown[] = [];
    const code = await runCli(
      [
        "task",
        "create",
        "--title",
        "Saved instance task",
        "--spec",
        specPath,
        "--tech-design",
        techDesignPath,
      ],
      { stdout: (line) => stdout.push(line), stderr: () => {} },
      {
        env: { NITELY_CONFIG_DIR: configDir },
        fetch: async (input, init) => {
          expect(String(input)).toBe("http://saved.test/api/tasks");
          headers.push(init?.headers);
          return new Response(
            JSON.stringify({ task: { id: "task-saved", status: "ready" } }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    expect(code).toBe(0);
    expect(headers).toEqual([
      {
        "content-type": "application/json",
        authorization: "Bearer saved-token",
      },
    ]);
    expect(stdout).toEqual([
      "TASK task-saved ready",
      "Web: http://saved.test/tasks/task-saved",
    ]);
  });

  it("lets --server and NITELY_API_TOKEN override the saved instance for one invocation", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "nitely-cli-instance-"));
    const directory = await mkdtemp(join(tmpdir(), "nitely-cli-task-"));
    const specPath = join(directory, "spec.md");
    const techDesignPath = join(directory, "tech-design.md");
    await writeFile(specPath, "remote spec", "utf8");
    await writeFile(techDesignPath, "remote tech design", "utf8");
    expect(
      await runCli(
        ["connect", "--server", "http://saved.test"],
        { stdout: () => {}, stderr: () => {} },
        {
          env: {
            NITELY_CONFIG_DIR: configDir,
            NITELY_API_TOKEN: "saved-token",
          },
        },
      ),
    ).toBe(0);

    const urls: string[] = [];
    const headers: unknown[] = [];
    expect(
      await runCli(
        [
          "task",
          "create",
          "--server",
          "http://override.test",
          "--title",
          "Override task",
          "--spec",
          specPath,
          "--tech-design",
          techDesignPath,
        ],
        { stdout: () => {}, stderr: () => {} },
        {
          env: {
            NITELY_CONFIG_DIR: configDir,
            NITELY_API_TOKEN: "env-token",
          },
          fetch: async (input, init) => {
            urls.push(String(input));
            headers.push(init?.headers);
            return new Response(
              JSON.stringify({ task: { id: "task-override", status: "ready" } }),
              { status: 201, headers: { "content-type": "application/json" } },
            );
          },
        },
      ),
    ).toBe(0);
    expect(urls).toEqual(["http://override.test/api/tasks"]);
    expect(headers).toEqual([
      {
        "content-type": "application/json",
        authorization: "Bearer env-token",
      },
    ]);

    const whoamiOut: string[] = [];
    expect(
      await runCli(
        ["whoami"],
        { stdout: (line) => whoamiOut.push(line), stderr: () => {} },
        { env: { NITELY_CONFIG_DIR: configDir } },
      ),
    ).toBe(0);
    expect(whoamiOut).toEqual([
      "Connected: http://saved.test",
      "API token: configured",
    ]);
  });

  it("starts MCP from the saved instance when flags and env are omitted", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "nitely-cli-instance-"));
    expect(
      await runCli(
        ["connect", "--server", "http://saved.test"],
        { stdout: () => {}, stderr: () => {} },
        {
          env: {
            NITELY_CONFIG_DIR: configDir,
            NITELY_API_TOKEN: "saved-token",
          },
        },
      ),
    ).toBe(0);

    const starts: Array<{ serverUrl: string; apiToken: string }> = [];
    expect(
      await runCli(
        ["mcp", "serve"],
        { stdout: () => {}, stderr: () => {} },
        {
          env: { NITELY_CONFIG_DIR: configDir },
          startMcpServer: async (input) => {
            starts.push(input);
          },
        },
      ),
    ).toBe(0);
    expect(starts).toEqual([
      { serverUrl: "http://saved.test", apiToken: "saved-token" },
    ]);
  });

  it("redacts a saved-instance token in mcp serve errors", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "nitely-cli-instance-"));
    expect(
      await runCli(
        ["connect", "--server", "http://saved.test"],
        { stdout: () => {}, stderr: () => {} },
        {
          env: {
            NITELY_CONFIG_DIR: configDir,
            NITELY_API_TOKEN: "nitely_api_saved_secret",
          },
        },
      ),
    ).toBe(0);

    const stderr: string[] = [];
    expect(
      await runCli(
        ["mcp", "serve"],
        { stdout: () => {}, stderr: (line) => stderr.push(line) },
        {
          env: { NITELY_CONFIG_DIR: configDir },
          startMcpServer: async (input) => {
            throw new Error(`upstream rejected token ${input.apiToken}`);
          },
        },
      ),
    ).toBe(1);
    expect(stderr).toEqual(["upstream rejected token [REDACTED]"]);
    expect(stderr.join("\n")).not.toContain("nitely_api_saved_secret");
  });

  it("watches a remote run until completion", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const requests: string[] = [];
    const responses = [
      {
        run: {
          runId: "run-watch",
          status: "running",
          currentStage: "implement",
          latestOutputSummary: "working",
        },
      },
      {
        run: {
          runId: "run-watch",
          status: "completed",
          currentStage: "review",
          latestOutputSummary: "done",
          changeRequestUrl: "https://github.com/example/repo/pull/149",
        },
      },
    ];

    const code = await runCli(
      [
        "run",
        "watch",
        "run-watch",
        "--server",
        "http://server.test",
        "--interval-ms",
        "1",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        fetch: async (input) => {
          requests.push(String(input));
          const payload = responses.shift() ?? responses.at(-1);
          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(requests).toEqual([
      "http://server.test/api/runs/run-watch",
      "http://server.test/api/runs/run-watch",
    ]);
    expect(stdout).toEqual([
      "RUN run-watch running stage=implement summary=working",
      "RUN run-watch completed stage=review summary=done url=https://github.com/example/repo/pull/149",
    ]);
  });

  it.each(["failed", "blocked", "interrupted"] as const)(
    "exits non-zero when a remote run reaches %s",
    async (terminalStatus) => {
      const stdout: string[] = [];
      const stderr: string[] = [];

      const code = await runCli(
        [
          "run",
          "watch",
          "run-watch",
          "--server",
          "http://server.test",
          "--interval-ms",
          "1",
        ],
        {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        },
        {
          fetch: async () =>
            new Response(
              JSON.stringify({
                run: {
                  runId: "run-watch",
                  status: terminalStatus,
                  currentStage: "implement",
                  latestOutputSummary: "terminal output",
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
        },
      );

      expect(code).toBe(1);
      expect(stderr).toEqual([]);
      expect(stdout).toEqual([
        `RUN run-watch ${terminalStatus} stage=implement summary=terminal output`,
      ]);
    },
  );

  it("resolves a task latest run before watching remote progress", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const requests: string[] = [];

    const code = await runCli(
      [
        "task",
        "watch",
        "task-149",
        "--server",
        "http://server.test",
        "--interval-ms",
        "1",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        fetch: async (input) => {
          requests.push(String(input));
          if (String(input) === "http://server.test/api/tasks/task-149") {
            return new Response(
              JSON.stringify({ task: { id: "task-149", latestRunId: "run-latest" } }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return new Response(
            JSON.stringify({
              run: {
                runId: "run-latest",
                status: "completed",
                currentStage: "implement",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(requests).toEqual([
      "http://server.test/api/tasks/task-149",
      "http://server.test/api/runs/run-latest",
    ]);
    expect(stdout).toEqual([
      "RUN run-latest completed stage=implement",
    ]);
  });

  it("rejects unknown validate options", async () => {
    const flowPath = await writeCliFlow(singleAgentFlow({ inputs: [] }));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(["validate", flowPath, "--bogus"], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["Unknown validate option: --bogus"]);
  });

  it("rejects unknown graph options", async () => {
    const flowPath = await writeCliFlow(singleAgentFlow({ inputs: [] }));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(["graph", flowPath, "--bogus"], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["Unknown graph option: --bogus"]);
  });

  it("prints clarify-spec questions as JSON without modifying the spec", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nitely-cli-clarify-"));
    const specPath = join(directory, "spec.md");
    const original = `# Feature Spec

## Background
Need a robust importer.

## User Stories
- **US-001:** As an operator, I can import things.

## Acceptance Scenarios
- **US-001 / SC-001:** Given input, when import runs, then it works.

## Functional Requirements
- **FR-001:** Nitely must import data quickly and securely.

## Success Criteria
- **SC-001:** Import is fast.

## Edge Cases
None.

## Assumptions
None.

## Out Of Scope
None.
`;
    await writeFile(specPath, original, "utf8");
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(["clarify-spec", specPath], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const payload = JSON.parse(stdout.join("\n")) as { questions: unknown[] };
    expect(payload.questions.length).toBeGreaterThan(0);
    expect(await readFile(specPath, "utf8")).toBe(original);
  });

  it("writes accepted clarify-spec answers to the spec", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nitely-cli-clarify-"));
    const specPath = join(directory, "spec.md");
    await writeFile(
      specPath,
      `# Feature Spec

## Background
Need a robust importer.

## User Stories
- **US-001:** As an operator, I can import things.

## Acceptance Scenarios
- **US-001 / SC-001:** Given input, when import runs, then it works.

## Functional Requirements
- **FR-001:** Nitely must import data quickly and securely.

## Success Criteria
- **SC-001:** Import is fast.

## Edge Cases
None.

## Assumptions
None.

## Out Of Scope
None.
`,
      "utf8",
    );
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "clarify-spec",
        specPath,
        "--answer",
        "CQ-001=A",
        "--session",
        "cli-session",
        "--date",
        "2026-06-22",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual(["Applied 1 clarification(s)"]);
    const updated = await readFile(specPath, "utf8");
    expect(updated).toContain("## Clarifications");
    expect(updated).toContain("cli-session");
  });

  it("rejects missing external input values", async () => {
    const flowPath = await writeCliFlow(singleAgentFlow({ inputs: [] }));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(["validate", flowPath, "--external-input"], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["Missing value for --external-input"]);
  });

  it("passes run arguments to the workflow runner", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "run",
        "flows/self-improve.json",
        "--repo",
        "/repo",
        "--input",
        "spec=specs/change.md",
        "--input",
        "tech-design=docs/design.md",
        "--config",
        "scope=checkout",
        "--config",
        "dryRun=true",
        "--backend",
        "mise",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        runFlow: async (input) => {
          expect(input).toEqual({
            flowPath: "flows/self-improve.json",
            repoPath: "/repo",
            inputs: {
              spec: {
                connector: "local-file",
                uri: resolve(process.cwd(), "specs/change.md"),
              },
              "tech-design": {
                connector: "local-file",
                uri: resolve(process.cwd(), "docs/design.md"),
              },
            },
            configuration: {
              scope: "checkout",
              dryRun: "true",
            },
            executionBackend: "mise",
          });
          return {
            runId: "run-1",
            branchName: "nitely/run-1",
            worktreePath: "/repo/.nitely/runs/run-1/worktree",
            changeRequestUrl: "https://example.test/pr/1",
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("RUN run-1 completed");
    expect(stdout.join("\n")).toContain("https://example.test/pr/1");
    expect(stdout.join("\n")).toContain(
      `Status command: nitely status run-1 --repo ${resolve("/repo")}`,
    );
    expect(stdout.join("\n")).toContain(
      `Run directory: ${join(resolve("/repo"), ".nitely", "runs", "run-1")}`,
    );
  });

  it("resolves relative --input paths against process.cwd() before run starts", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const absoluteInput = resolve(process.cwd(), "local-spec.md");

    const code = await runCli(
      [
        "run",
        "flows/self-improve.json",
        "--repo",
        "/other/repo",
        "--input",
        "spec=./local-spec.md",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        runFlow: async (input) => {
          expect(input.repoPath).toBe("/other/repo");
          expect(input.inputs?.spec).toEqual({
            connector: "local-file",
            uri: absoluteInput,
          });
          expect(isAbsolute(input.inputs?.spec?.uri ?? "")).toBe(true);
          return {
            runId: "run-cwd-input",
            branchName: "nitely/run-cwd-input",
            worktreePath: "/other/repo/.nitely/runs/run-cwd-input/worktree",
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain(
      `Status command: nitely status run-cwd-input --repo ${resolve("/other/repo")}`,
    );
  });

  it("passes task scope run arguments to the workflow runner", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "run",
        "flows/self-improve.json",
        "--repo",
        "/repo",
        "--input",
        "tasks=docs/tasks.md",
        "--task-scope",
        "tasks:next:5",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        runFlow: async (input) => {
          expect(input).toMatchObject({
            flowPath: "flows/self-improve.json",
            repoPath: "/repo",
            inputs: {
              tasks: {
                connector: "local-file",
                uri: resolve(process.cwd(), "docs/tasks.md"),
              },
            },
            taskScope: { inputId: "tasks", expression: "next:5" },
          });
          return {
            runId: "run-1",
            branchName: "nitely/run-1",
            worktreePath: "/repo/.nitely/runs/run-1/worktree",
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("RUN run-1 completed");
  });

  it("passes rework-pr arguments to the workflow runner", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "rework-pr",
        "https://github.com/Instask/nitely/pull/22",
        "--repo",
        "/repo",
        "--flow",
        "flows/rework-pr-bootstrap.json",
        "--provider",
        "github-cli",
        "--input",
        "spec=specs/issues/022-pr-rework-flow-spec.md",
        "--input",
        "tech-design=docs/plans/rework.md",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        runFlow: async (input) => {
          expect(input).toEqual({
            flowPath: "flows/rework-pr-bootstrap.json",
            repoPath: "/repo",
            inputs: {
              spec: {
                connector: "local-file",
                uri: resolve(
                  process.cwd(),
                  "specs/issues/022-pr-rework-flow-spec.md",
                ),
              },
              "tech-design": {
                connector: "local-file",
                uri: resolve(process.cwd(), "docs/plans/rework.md"),
              },
            },
            changeRequestTarget: {
              provider: "github-cli",
              target: "https://github.com/Instask/nitely/pull/22",
            },
          });
          return {
            runId: "run-22",
            branchName: "nitely/pr-22",
            worktreePath: "/repo/.nitely/runs/run-22/worktree",
            changeRequestUrl: "https://github.com/Instask/nitely/pull/22",
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("RUN run-22 completed");
    expect(stdout.join("\n")).toContain(
      "Change request: https://github.com/Instask/nitely/pull/22",
    );
  });

  it("passes pr-comments arguments to the comment processor", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "pr-comments",
        "https://github.com/Instask/nitely/pull/15",
        "--repo",
        "/repo",
        "--flow",
        "flows/rework-pr-bootstrap.json",
        "--route-flow",
        "spec=flows/rework-spec-bootstrap.json",
        "--route-flow",
        "workflow=flows/rework-workflow-bootstrap.json",
        "--route-override",
        "103=implementation",
        "--dry-run",
        "--allow-author",
        "alice",
        "--bot-login",
        "nitely",
        "--prior-run",
        "run-prev",
        "--max-rework-attempts",
        "2",
        "--approve-required-routes",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        processPullRequestComments: async (input) => {
          expect(input).toMatchObject({
            repoPath: "/repo",
            target: "https://github.com/Instask/nitely/pull/15",
            flowPath: "flows/rework-pr-bootstrap.json",
            routeFlowPaths: {
              spec: "flows/rework-spec-bootstrap.json",
              workflow: "flows/rework-workflow-bootstrap.json",
            },
            routeOverrides: {
              "103": "implementation",
            },
            dryRun: true,
            allowAuthors: ["alice"],
            botLogin: "nitely",
            priorRunId: "run-prev",
            maxReworkAttempts: 2,
            approveRequiredRoutes: true,
          });
          return {
            target: {
              provider: "github",
              owner: "Instask",
              repository: "nitely",
              number: 15,
              url: "https://github.com/Instask/nitely/pull/15",
              baseBranch: "main",
              headBranch: "nitely/pr-15",
              headSha: "abc123",
              headRepository: { owner: "Instask", repository: "nitely" },
              isCrossRepository: false,
            },
            processed: 2,
            triggered: [{ commentId: "100", runId: "dry-run" }],
            explained: [{ commentId: "101", commentUrl: "https://example.test/c/101" }],
            pendingApprovals: [
              {
                commentId: "103",
                route: "spec",
                reason: "feedback route spec requires operator approval before execution",
              },
            ],
            skipped: [{ commentId: "102", reason: "unauthorized author" }],
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain(
      "PR: https://github.com/Instask/nitely/pull/15",
    );
    expect(stdout.join("\n")).toContain("Processed: 2");
    expect(stdout.join("\n")).toContain("Triggered: 100 -> dry-run");
    expect(stdout.join("\n")).toContain("Skipped: 1");
  });

  it("requires --flow for rework-pr", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["rework-pr", "22", "--repo", "/repo"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        runFlow: async () => {
          throw new Error("runFlow must not be called");
        },
      },
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["Usage: nitely rework-pr <pr-url-or-number> --repo <path> --flow <flow> --input <name>=<path>"]);
  });

  it("prints event-backed run summaries", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["runs", "--repo", "/repo"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        listRuns: async (repoPath) => {
          expect(repoPath).toBe("/repo");
          return [
            {
              runId: "run-1",
              status: "completed",
              flowName: "flow",
              branchName: "nitely/run-1",
              completedStages: ["implement"],
              stages: [],
              logs: [],
              approvals: [],
              artifacts: [],
              gates: [],
              orchestratorDecisions: [],
              verificationDiagnoses: [],
            },
          ];
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual(["run-1\tcompleted\tflow\t1 stages"]);
  });

  it("prints projected status for a run", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["status", "run-1", "--repo", "/repo"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        getRunStatus: async (repoPath, runId) => {
          expect(repoPath).toBe("/repo");
          expect(runId).toBe("run-1");
          return {
            runId: "run-1",
            status: "interrupted",
            flowName: "flow",
            completedStages: [],
            stages: [
              {
                stageId: "implement",
                status: "interrupted",
                attempts: [{ attempt: 1, status: "interrupted" }],
              },
            ],
            logs: [],
            approvals: [],
            artifacts: [],
            gates: [],
            orchestratorDecisions: [],
            verificationDiagnoses: [],
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "Run: run-1",
      "Status: interrupted",
      "Flow: flow",
      "Stages:",
      "  implement\tinterrupted\tattempts: 1",
    ]);
  });

  it("prints reproducibility diagnostics in projected status output", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-cli-repro-"));
    const runDirectory = join(repoPath, ".nitely", "runs", "run-1");
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      join(runDirectory, "reproducibility.json"),
      JSON.stringify(
        {
          version: 1,
          runId: "run-1",
          generatedAt: "2026-07-08T00:00:00.000Z",
          replayability: "partially-replayable",
          repo: { path: repoPath, headCommit: "abc123" },
          flow: { name: "flow" },
          inputs: [],
          context: {
            policySha256: "sha256:policy",
            constitution: { loaded: false, path: ".nitely/constitution.md" },
            projectInstructions: {
              loaded: false,
              path: ".nitely/instructions.json",
            },
          },
          runtimes: [],
          commands: [],
          skills: [],
          providers: [],
          environment: {
            nodeVersion: "v24.0.0",
            platform: "darwin",
            arch: "arm64",
          },
          nonDeterministicFactors: ["agent runtime output depends on external model/provider behavior"],
          missingReplayPrerequisites: [],
        },
        null,
        2,
      ),
      "utf8",
    );
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["status", "run-1", "--repo", repoPath],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        getRunStatus: async () => ({
          runId: "run-1",
          status: "completed",
          flowName: "flow",
          completedStages: ["test"],
          stages: [
            {
              stageId: "test",
              status: "completed",
              attempts: [{ attempt: 1, status: "completed" }],
            },
          ],
          logs: [],
          approvals: [],
          artifacts: [],
          gates: [],
          orchestratorDecisions: [],
          verificationDiagnoses: [],
        }),
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toContain("Replayability: partially-replayable");
    expect(stdout).toContain(
      `Reproducibility manifest: ${join(runDirectory, "reproducibility.json")}`,
    );
    expect(stdout).toContain(
      "Known non-determinism: agent runtime output depends on external model/provider behavior",
    );
  });

  it("prints blocker details in projected status output", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["status", "run-1", "--repo", "/repo"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        getRunStatus: async () => ({
          runId: "run-1",
          status: "blocked",
          flowName: "flow",
          blocker: {
            reason: "agent_usage_limit",
            stageId: "review",
            runtime: "codex",
            message: "ERROR: You've hit your usage limit.",
            retryAfter: "Jun 21st, 2026 12:37 AM",
          },
          completedStages: ["implement"],
          stages: [
            {
              stageId: "implement",
              status: "completed",
              attempts: [{ attempt: 1, status: "completed" }],
            },
            {
              stageId: "review",
              status: "blocked",
              blocker: {
                reason: "agent_usage_limit",
                stageId: "review",
                runtime: "codex",
                message: "ERROR: You've hit your usage limit.",
                retryAfter: "Jun 21st, 2026 12:37 AM",
              },
              attempts: [{ attempt: 1, status: "blocked" }],
            },
          ],
          logs: [],
          approvals: [],
          artifacts: [],
          gates: [],
          orchestratorDecisions: [],
          verificationDiagnoses: [],
        }),
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "Run: run-1",
      "Status: blocked",
      "Flow: flow",
      "Blocked: stage review reason agent_usage_limit runtime codex retry after Jun 21st, 2026 12:37 AM",
      "Message: ERROR: You've hit your usage limit.",
      "Stages:",
      "  implement\tcompleted\tattempts: 1",
      "  review\tblocked\tattempts: 1\treason: agent_usage_limit",
    ]);
  });

  it("prints checkpoint candidates in projected status output", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-cli-status-"));
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const store = new EventStore(eventStorePath(repoPath));
    store.append({
      runId: "run-checkpoints",
      type: "run.created",
      createdAt: "2026-07-08T00:00:00.000Z",
      payload: { flowName: "flow" },
    });
    store.append({
      runId: "run-checkpoints",
      type: "stage.started",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-07-08T00:00:01.000Z",
      payload: { type: "agent" },
    });
    store.append({
      runId: "run-checkpoints",
      type: "stage.blocked",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-07-08T00:00:02.000Z",
      payload: { reason: "usage-limit" },
    });
    store.append({
      runId: "run-checkpoints",
      type: "run.blocked",
      createdAt: "2026-07-08T00:00:03.000Z",
      payload: { reason: "usage-limit" },
    });
    store.close();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(["status", "run-checkpoints", "--repo", repoPath], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toContain("Checkpoint candidates:");
    expect(stdout).toContain(
      "  stage-attempt\tresume-run\tstage implement attempt 1",
    );
  });

  it("records rollback decisions as append-only events", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-cli-rollback-"));
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const store = new EventStore(eventStorePath(repoPath));
    store.append({
      runId: "run-rollback",
      type: "run.created",
      createdAt: "2026-07-08T00:00:00.000Z",
      payload: { flowName: "flow" },
    });
    store.append({
      runId: "run-rollback",
      type: "stage.started",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-07-08T00:00:01.000Z",
      payload: { type: "agent" },
    });
    store.append({
      runId: "run-rollback",
      type: "stage.blocked",
      stageId: "implement",
      attempt: 1,
      createdAt: "2026-07-08T00:00:02.000Z",
      payload: { reason: "usage-limit" },
    });
    store.append({
      runId: "run-rollback",
      type: "run.blocked",
      createdAt: "2026-07-08T00:00:03.000Z",
      payload: { reason: "usage-limit" },
    });
    store.close();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "rollback",
        "record",
        "run-rollback",
        "--repo",
        repoPath,
        "--checkpoint",
        "stage-attempt:2",
        "--actor",
        "leo",
        "--reason",
        "Resume after quota reset.",
        "--worktree",
        "cleanup",
        "--branch",
        "reset-to-checkpoint",
        "--change",
        "new-pr",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      { now: () => new Date("2026-07-08T00:00:04.000Z") },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "ROLLBACK run-rollback recorded",
      "Checkpoint: stage-attempt:2",
      "Policy: worktree=cleanup branch=reset-to-checkpoint change=new-pr",
      "Event: 5",
    ]);
    const verifyStore = new EventStore(eventStorePath(repoPath));
    const event = verifyStore.latest("run-rollback");
    verifyStore.close();
    expect(event).toMatchObject({
      type: "rollback.recorded",
      payload: {
        actor: "leo",
        reason: "Resume after quota reset.",
        policy: {
          worktree: "cleanup",
          branch: "reset-to-checkpoint",
          change: "new-pr",
        },
      },
    });
  });

  it("requires a repository path when recording rollback decisions", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["rollback", "record", "run-rollback", "--checkpoint", "stage-attempt:2"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["Missing value for --repo"]);
  });

  it("applies rollback decisions through the injected runner", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [
        "rollback",
        "apply",
        "run-rollback",
        "--repo",
        "/repo",
        "--decision",
        "5",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        applyRollbackDecision: async (input) => {
          expect(input).toEqual({
            repoPath: "/repo",
            runId: "run-rollback",
            decisionSequence: 5,
          });
          return {
            event: {
              sequence: 6,
              runId: "run-rollback",
              type: "rollback.applied",
              createdAt: "2026-07-08T00:00:06.000Z",
              payload: {},
            },
            decision: {
              sequence: 5,
              runId: "run-rollback",
              type: "rollback.recorded",
              createdAt: "2026-07-08T00:00:05.000Z",
              payload: {},
            },
            application: {
              status: "applied",
              decisionEventSequence: 5,
              policy: {
                worktree: "cleanup",
                branch: "preserve",
                change: "none",
              },
              worktree: { policy: "cleanup", status: "removed" },
              branch: { policy: "preserve", status: "preserved" },
              change: { policy: "none", status: "skipped" },
              failures: [],
              mutations: ["remove worktree /repo/.nitely/runs/run-rollback/worktree"],
            },
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "ROLLBACK run-rollback applied",
      "Decision: 5",
      "Policy: worktree=cleanup branch=preserve change=none",
      "Worktree: removed",
      "Branch: preserved",
      "Change: skipped",
      "Event: 6",
    ]);
  });

  it("prints planned rollback change-request routing status", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["rollback", "apply", "run-rollback", "--repo", "/repo"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        applyRollbackDecision: async () => ({
          event: {
            sequence: 6,
            runId: "run-rollback",
            type: "rollback.applied",
            createdAt: "2026-07-08T00:00:06.000Z",
            payload: {},
          },
          decision: {
            sequence: 5,
            runId: "run-rollback",
            type: "rollback.recorded",
            createdAt: "2026-07-08T00:00:05.000Z",
            payload: {},
          },
          application: {
            status: "applied",
            decisionEventSequence: 5,
            policy: {
              worktree: "preserve",
              branch: "preserve",
              change: "new-pr",
            },
            worktree: { policy: "preserve", status: "preserved" },
            branch: { policy: "preserve", status: "preserved" },
            change: {
              policy: "new-pr",
              status: "planned",
              resume: {
                runId: "run-rollback",
                checkpointId: "stage-attempt:3",
                status: "awaiting-approval",
              },
            },
            failures: [],
            mutations: ["resume run run-rollback from stage-attempt:3 for new-pr"],
          },
        }),
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "ROLLBACK run-rollback applied",
      "Decision: 5",
      "Policy: worktree=preserve branch=preserve change=new-pr",
      "Worktree: preserved",
      "Branch: preserved",
      "Change: planned",
      "Event: 6",
    ]);
  });

  it("exits non-zero when rollback apply fails closed", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["rollback", "apply", "run-rollback", "--repo", "/repo"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        applyRollbackDecision: async () => ({
          event: {
            sequence: 6,
            runId: "run-rollback",
            type: "rollback.apply_failed",
            createdAt: "2026-07-08T00:00:06.000Z",
            payload: {},
          },
          decision: {
            sequence: 5,
            runId: "run-rollback",
            type: "rollback.recorded",
            createdAt: "2026-07-08T00:00:05.000Z",
            payload: {},
          },
          application: {
            status: "failed",
            decisionEventSequence: 5,
            policy: {
              worktree: "cleanup",
              branch: "reset-to-checkpoint",
              change: "none",
            },
            worktree: { policy: "cleanup", status: "blocked" },
            branch: {
              policy: "reset-to-checkpoint",
              status: "blocked",
              reason: "checkpoint branch head is not recorded; no branch reset was performed",
            },
            change: { policy: "none", status: "skipped" },
            failures: [
              "checkpoint branch head is not recorded; no branch reset was performed",
            ],
            mutations: [],
          },
        }),
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "ROLLBACK run-rollback apply failed",
      "Decision: 5",
      "Policy: worktree=cleanup branch=reset-to-checkpoint change=none",
      "Worktree: blocked",
      "Branch: blocked",
      "Change: skipped",
      "Failure: checkpoint branch head is not recorded; no branch reset was performed",
      "Event: 6",
    ]);
  });

  it("does not print historical blocker details after a blocked run completes", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const blocker = {
      reason: "agent_usage_limit",
      stageId: "review",
      runtime: "codex",
      message: "ERROR: You've hit your usage limit.",
      retryAfter: "Jun 21st, 2026 12:37 AM",
    };

    const code = await runCli(
      ["status", "run-1", "--repo", "/repo"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        getRunStatus: async () =>
          projectRun([
            {
              sequence: 1,
              runId: "run-1",
              type: "run.created",
              createdAt: "2026-06-19T00:00:01.000Z",
              payload: { flowName: "flow" },
            },
            {
              sequence: 2,
              runId: "run-1",
              type: "stage.started",
              stageId: "review",
              attempt: 1,
              createdAt: "2026-06-19T00:00:02.000Z",
              payload: {},
            },
            {
              sequence: 3,
              runId: "run-1",
              type: "stage.blocked",
              stageId: "review",
              attempt: 1,
              createdAt: "2026-06-19T00:00:03.000Z",
              payload: blocker,
            },
            {
              sequence: 4,
              runId: "run-1",
              type: "run.blocked",
              createdAt: "2026-06-19T00:00:04.000Z",
              payload: blocker,
            },
            {
              sequence: 5,
              runId: "run-1",
              type: "stage.started",
              stageId: "review",
              attempt: 2,
              createdAt: "2026-06-19T00:00:05.000Z",
              payload: {},
            },
            {
              sequence: 6,
              runId: "run-1",
              type: "stage.completed",
              stageId: "review",
              attempt: 2,
              createdAt: "2026-06-19T00:00:06.000Z",
              payload: {},
            },
            {
              sequence: 7,
              runId: "run-1",
              type: "run.completed",
              createdAt: "2026-06-19T00:00:07.000Z",
              payload: {},
            },
          ]),
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "Run: run-1",
      "Status: completed",
      "Flow: flow",
      "Stages:",
      "  review\tcompleted\tattempts: 2",
    ]);
    expect(stdout.join("\n")).not.toContain("Blocked:");
    expect(stdout.join("\n")).not.toContain("reason: agent_usage_limit");
  });

  it("prints projected logs and filters by stage", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["logs", "run-1", "--repo", "/repo", "--stage", "test"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        getRunLogs: async (repoPath, runId, options) => {
          expect(repoPath).toBe("/repo");
          expect(runId).toBe("run-1");
          expect(options).toEqual({ stageId: "test" });
          return [
            {
              stageId: "test",
              attempt: 1,
              source: "command",
              command: "pnpm test",
              stdout: "ok\n",
              stderr: "warn\n",
            },
          ];
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "== test attempt 1 command ==",
      "$ pnpm test",
      "-- stdout --",
      "ok\n",
      "-- stderr --",
      "warn\n",
    ]);
  });

  it("lists and resolves approval requests", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-cli-approvals-"));
    await mkdir(join(repo, ".nitely"), { recursive: true });
    const store = new EventStore(eventStorePath(repo));
    store.append({
      runId: "run-approval",
      type: "run.created",
      payload: { flowName: "approval-flow" },
    });
    store.append({
      runId: "run-approval",
      stageId: "approve-release",
      attempt: 1,
      type: "stage.started",
      payload: { type: "approval" },
    });
    store.append({
      runId: "run-approval",
      stageId: "approve-release",
      attempt: 1,
      type: "approval.requested",
      payload: {
        approvalId: "approve-release-1",
        prompt: "Approve release",
        reviewedArtifactIds: ["implementation"],
      },
    });
    store.close();

    const stdout: string[] = [];
    const stderr: string[] = [];
    let code = await runCli(
      ["approvals", "run-approval", "--repo", repo],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "approve-release-1\tpending\tapprove-release\tattempt 1\tApprove release",
    ]);

    stdout.length = 0;
    code = await runCli(
      [
        "approve",
        "run-approval",
        "approve-release-1",
        "--repo",
        repo,
        "--actor",
        "human:test",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toBe(0);
    expect(stdout).toEqual(["APPROVAL approve-release-1 approved"]);

    const verifyStore = new EventStore(eventStorePath(repo));
    const projection = projectRun(verifyStore.list("run-approval"));
    verifyStore.close();
    expect(projection.approvals).toEqual([
      expect.objectContaining({
        id: "approve-release-1",
        status: "approved",
        actor: "human:test",
        decision: "approved",
        reviewedArtifactIds: ["implementation"],
      }),
    ]);
  });

  it("lists, answers, and prints a structured operator question", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-cli-questions-"));
    await mkdir(join(repo, ".nitely"), { recursive: true });
    const store = new EventStore(eventStorePath(repo));
    store.append({
      runId: "run-question",
      type: "run.created",
      payload: { flowName: "question-flow" },
    });
    store.append({
      runId: "run-question",
      stageId: "implement",
      attempt: 1,
      type: "stage.started",
      payload: { type: "agent" },
    });
    store.append({
      runId: "run-question",
      stageId: "implement",
      attempt: 1,
      type: "stage.question",
      payload: {
        questionId: "implement-1",
        question: {
          version: 1,
          question: "Keep history?",
          options: [
            { id: "keep", label: "Keep history", recommended: true },
            { id: "purge", label: "Purge history" },
          ],
          context: "Affects retention.",
        },
      },
    });
    const blocker = {
      reason: "awaiting_operator_answer",
      stageId: "implement",
      questionId: "implement-1",
      message: "Keep history?",
    };
    store.append({
      runId: "run-question",
      stageId: "implement",
      attempt: 1,
      type: "stage.blocked",
      payload: blocker,
    });
    store.append({
      runId: "run-question",
      type: "run.blocked",
      payload: blocker,
    });
    store.close();

    const stdout: string[] = [];
    const stderr: string[] = [];
    let code = await runCli(
      ["questions", "run-question", "--repo", repo],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );
    expect(code).toBe(0);
    expect(stdout).toEqual([
      "implement-1\tpending\timplement\tattempt 1\tKeep history?",
      "  keep\tKeep history (recommended)",
      "  purge\tPurge history",
    ]);

    stdout.length = 0;
    code = await runCli(
      [
        "answer",
        "run-question",
        "implement-1",
        "--repo",
        repo,
        "--option",
        "keep",
        "--actor",
        "human:test",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );
    expect(code).toBe(0);
    expect(stdout).toEqual(["QUESTION implement-1 answered"]);

    stdout.length = 0;
    code = await runCli(
      ["status", "run-question", "--repo", repo],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual(
      expect.arrayContaining([
        "Question: implement-1 (answered)",
        "Keep history?",
        "Context: Affects retention.",
        "  keep\tKeep history (recommended)",
        "Answer: keep (by human:test)",
      ]),
    );
  });

  it("attaches an operator review verdict with required CLI provenance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nitely-cli-review-verdict-"));
    const reviewPath = join(directory, "review.md");
    await writeFile(reviewPath, "Review verdict: pass\nReason: checked\n", "utf8");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(
      [
        "review-verdict",
        "run-review",
        "--repo",
        "/repo",
        "--file",
        reviewPath,
        "--actor",
        "human:test",
        "--reviewed-artifact",
        "implementation",
      ],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        submitOperatorReview: async (input) => {
          expect(input).toEqual({
            repoPath: "/repo",
            runId: "run-review",
            actor: "human:test",
            content: "Review verdict: pass\nReason: checked\n",
            mediaType: "text/markdown",
            reviewedArtifactIds: ["implementation"],
          });
          return {
            id: "review-result",
            stageId: "review",
            mode: "review",
            status: "passed",
            runtime: "operator",
            reviewedArtifacts: ["implementation"],
            reviewOutput: {
              id: "review-result",
              path: "stages/review/1/operator-review.md",
              filename: "operator-review.md",
              mediaType: "text/markdown",
              content: "Review verdict: pass\nReason: checked",
              truncated: false,
              verdict: { verdict: "approved", reason: "checked" },
            },
            operatorReview: {
              actor: "human:test",
              submittedAt: "2026-07-14T00:00:00.000Z",
              reviewedArtifactIds: ["implementation"],
              blocker: {
                reason: "agent_usage_limit",
                stageId: "review",
              },
            },
            attempt: 1,
            createdAt: "2026-07-14T00:00:00.000Z",
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "REVIEW VERDICT review attempt 1 passed",
      "Actor: human:test",
      "Reviewed artifacts: implementation",
      "Verdict: approved",
      "Evidence: stages/review/1/operator-review.md",
    ]);
  });

  it("requires actor, file, and reviewed artifacts for review-verdict", async () => {
    const stderr: string[] = [];
    const code = await runCli(
      ["review-verdict", "run-review", "--file", "review.md"],
      {
        stdout: () => {},
        stderr: (line) => stderr.push(line),
      },
    );
    expect(code).toBe(1);
    expect(stderr).toEqual(["Missing value for --actor"]);
  });

  it("prints operator review provenance in run status", async () => {
    const stdout: string[] = [];
    const code = await runCli(
      ["status", "run-review", "--repo", "/repo"],
      { stdout: (line) => stdout.push(line), stderr: () => {} },
      {
        getRunStatus: async () => ({
          runId: "run-review",
          status: "blocked",
          blocker: {
            reason: "agent_usage_limit",
            stageId: "review",
            message: "quota exceeded",
          },
          completedStages: [],
          stages: [
            {
              stageId: "review",
              status: "blocked",
              attempts: [{ attempt: 1, status: "blocked" }],
            },
          ],
          logs: [],
          approvals: [],
          artifacts: [],
          gates: [
            {
              id: "review-result",
              stageId: "review",
              mode: "review",
              status: "passed",
              runtime: "operator",
              reviewedArtifacts: ["implementation"],
              operatorReview: {
                actor: "human:test",
                submittedAt: "2026-07-14T00:00:00.000Z",
                reviewedArtifactIds: ["implementation"],
                blocker: {
                  reason: "agent_usage_limit",
                  stageId: "review",
                },
              },
              attempt: 1,
              createdAt: "2026-07-14T00:00:00.000Z",
            },
          ],
          orchestratorDecisions: [],
          verificationDiagnoses: [],
        }),
      },
    );
    expect(code).toBe(0);
    expect(stdout).toEqual(
      expect.arrayContaining([
        "Operator review: review attempt 1 passed",
        "  Actor: human:test at 2026-07-14T00:00:00.000Z",
        "  Reviewed artifacts: implementation",
        "  Blocker: agent_usage_limit",
      ]),
    );
  });

  it("resumes interrupted runs through the injected runner", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["resume", "run-1", "--repo", "/repo", "--checkpoint", "stage-attempt:2"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        resumeRun: async (input) => {
          expect(input).toEqual({
            repoPath: "/repo",
            runId: "run-1",
            checkpointId: "stage-attempt:2",
          });
          return {
            runId: "run-1",
            branchName: "nitely/run-1",
            worktreePath: "/repo/.nitely/runs/run-1/worktree",
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "RUN run-1 resumed",
      "Branch: nitely/run-1",
      "Worktree: /repo/.nitely/runs/run-1/worktree",
      `Status command: nitely status run-1 --repo ${resolve("/repo")}`,
      `Run directory: ${join(resolve("/repo"), ".nitely", "runs", "run-1")}`,
    ]);
  });

  it("requires a checkpoint value when resuming from an explicit checkpoint", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["resume", "run-1", "--repo", "/repo", "--checkpoint"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["Missing value for --checkpoint"]);
  });

  it("keeps placeholder commands wired to real handlers", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["status", "run-1"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        getRunStatus: async () => {
          throw new Error("boom");
        },
      },
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["boom"]);
  });

  it("hints at --repo when status cannot find a run", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["status", "missing-run", "--repo", "/wrong/repo"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        getRunStatus: async () => {
          throw new Error("run not found: missing-run");
        },
      },
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toMatch(/run not found: missing-run/i);
    expect(stderr.join("\n")).toMatch(/--repo/i);
  });

  it("passes web arguments to the web server starter", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["web", "--repo", "/repo", "--host", "0.0.0.0", "--port", "4180"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        startWebServer: async (input) => {
          expect(input.repoPath).toBe("/repo");
          expect(input.host).toBe("0.0.0.0");
          expect(input.port).toBe(4180);
          return {
            url: "http://0.0.0.0:4180",
            close: async () => {},
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual(["Web Console: http://0.0.0.0:4180"]);
  });

  it("prints the active Web security readiness controls", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["web", "--repo", "/repo", "--auth", "required"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        startWebServer: async () => ({
          url: "http://127.0.0.1:4173",
          readiness: {
            schemaVersion: "nitely.web-security-readiness.v1",
            ready: true,
            production: true,
            auth: { mode: "required", adminConfigured: true },
            bind: { host: "127.0.0.1", scope: "loopback" },
            transport: {
              mode: "loopback-http",
              trustedProxy: false,
              secureCookie: false,
            },
            execution: {
              backend: "oci",
              reason: "required-auth-default",
              unsafeOverride: false,
            },
          },
          close: async () => {},
        }),
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "Web Console: http://127.0.0.1:4173",
      "Web Security: ready=true auth=required admin=configured bind=loopback transport=loopback-http secureCookie=false execution=oci reason=required-auth-default unsafeOverride=false production=true",
    ]);
  });

  it("keeps the web command alive until the server closes", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let resolveClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const runPromise = runCli(
      ["web", "--repo", "/repo"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        startWebServer: async () => ({
          url: "http://127.0.0.1:4173",
          closed,
          close: async () => {
            resolveClosed?.();
          },
        }),
      },
    );
    let settled = false;
    void runPromise.then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(settled).toBe(false);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual(["Web Console: http://127.0.0.1:4173"]);

    resolveClosed?.();

    await expect(runPromise).resolves.toBe(0);
  });

  it("passes required web auth mode to the web server starter", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["web", "--repo", "/repo", "--auth", "required"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        startWebServer: async (input) => {
          expect(input).toMatchObject({
            repoPath: "/repo",
            authMode: "required",
          });
          return {
            url: "http://127.0.0.1:4173",
            close: async () => {},
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual(["Web Console: http://127.0.0.1:4173"]);
  });

  it("accepts --home as the state directory and keeps --repo as an alias", async () => {
    for (const flag of ["--home", "--repo"]) {
      const stdout: string[] = [];
      const stderr: string[] = [];

      const code = await runCli(
        ["web", flag, "/state"],
        {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        },
        {
          startWebServer: async (input) => {
            expect(input).toMatchObject({ repoPath: "/state" });
            expect(input).not.toHaveProperty("repositories");
            return {
              url: "http://127.0.0.1:4173",
              close: async () => {},
            };
          },
        },
      );

      expect(code).toBe(0);
      expect(stderr).toEqual([]);
      expect(stdout).toEqual(["Web Console: http://127.0.0.1:4173"]);
    }
  });

  it("rejects the removed --repository option", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["web", "--home", "/state", "--repository", "docs=/repos/docs"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        startWebServer: async () => {
          throw new Error("must not start");
        },
      },
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "--repository was removed; register repositories by GitHub URL from the Repos page",
    ]);
  });

  it("accepts pnpm argument separators before the web command", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["--", "web", "--repo", "/repo"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        startWebServer: async (input) => {
          expect(input).toMatchObject({
            repoPath: "/repo",
            host: "127.0.0.1",
            port: 4173,
          });
          return {
            url: "http://127.0.0.1:4173",
            close: async () => {},
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual(["Web Console: http://127.0.0.1:4173"]);
  });
  it("lists flows on the connected instance", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const headers: unknown[] = [];

    const code = await runCli(
      ["flow", "list", "--server", "http://server.test/"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        fetch: async (input, init) => {
          expect(String(input)).toBe("http://server.test/api/flows");
          expect(init?.method ?? "GET").toBe("GET");
          headers.push(init?.headers);
          return new Response(
            JSON.stringify({
              flows: [
                {
                  id: "flow-local",
                  name: "Team implement",
                  source: "user",
                  stageCount: 5,
                  runnable: true,
                  editable: true,
                },
                {
                  id: "flows/implement-spec-bootstrap.json",
                  name: "implement-spec-bootstrap",
                  source: "builtin",
                  stageCount: 7,
                  runnable: false,
                  editable: false,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "flow-local  user  runnable  Team implement",
      "flows/implement-spec-bootstrap.json  builtin  blocked  implement-spec-bootstrap",
      "Pass an id above to nitely task create --flow <id>.",
    ]);
    expect(headers).toEqual([undefined]);
  });

  it("prints flows as JSON with --json", async () => {
    const stdout: string[] = [];

    const code = await runCli(
      ["flow", "list", "--server", "http://server.test", "--json"],
      { stdout: (line) => stdout.push(line), stderr: () => {} },
      {
        fetch: async () =>
          new Response(
            JSON.stringify({
              flows: [
                {
                  id: "flows/implement-spec-bootstrap.json",
                  name: "implement-spec-bootstrap",
                  source: "builtin",
                  stageCount: 7,
                  runnable: true,
                  editable: false,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      },
    );

    expect(code).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0])).toEqual({
      flows: [
        {
          id: "flows/implement-spec-bootstrap.json",
          name: "implement-spec-bootstrap",
          source: "builtin",
          stageCount: 7,
          runnable: true,
          editable: false,
        },
      ],
    });
  });

  it("reports an empty flow catalog", async () => {
    const stdout: string[] = [];

    const code = await runCli(
      ["flow", "list", "--server", "http://server.test"],
      { stdout: (line) => stdout.push(line), stderr: () => {} },
      {
        fetch: async () =>
          new Response(JSON.stringify({ flows: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );

    expect(code).toBe(0);
    expect(stdout).toEqual(["No flows"]);
  });

  it("uses the saved instance and token for flow list", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "nitely-cli-instance-"));
    expect(
      await runCli(
        ["connect", "--server", "http://saved.test"],
        { stdout: () => {}, stderr: () => {} },
        {
          env: {
            NITELY_CONFIG_DIR: configDir,
            NITELY_API_TOKEN: "saved-token",
          },
        },
      ),
    ).toBe(0);

    const urls: string[] = [];
    const headers: unknown[] = [];
    expect(
      await runCli(
        ["flow", "list"],
        { stdout: () => {}, stderr: () => {} },
        {
          env: { NITELY_CONFIG_DIR: configDir },
          fetch: async (input, init) => {
            urls.push(String(input));
            headers.push(init?.headers);
            return new Response(JSON.stringify({ flows: [] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        },
      ),
    ).toBe(0);

    expect(urls).toEqual(["http://saved.test/api/flows"]);
    expect(headers).toEqual([{ authorization: "Bearer saved-token" }]);
  });

  it("fails flow list without a configured instance", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "nitely-cli-instance-"));
    const stderr: string[] = [];

    const code = await runCli(
      ["flow", "list"],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      {
        env: { NITELY_CONFIG_DIR: configDir },
        fetch: async () => {
          throw new Error("fetch must not be called");
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual(["Missing --server, NITELY_SERVER_URL, or a saved instance from nitely connect"]);
  });

  it("prints flow list server errors with HTTP status and message", async () => {
    const stderr: string[] = [];

    const code = await runCli(
      ["flow", "list", "--server", "http://server.test"],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      {
        fetch: async () =>
          new Response(
            JSON.stringify({
              error: { message: "API token capability denied: tasks:read is required" },
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          ),
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual([
      "remote flow list failed (HTTP 403): API token capability denied: tasks:read is required",
    ]);
  });

  it("rejects flow list payloads without a flows array", async () => {
    const stderr: string[] = [];

    const code = await runCli(
      ["flow", "list", "--server", "http://server.test"],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      {
        fetch: async () =>
          new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual([
      "remote flow list failed: invalid response: missing flows",
    ]);
  });

  it("redacts the resolved token in flow list errors", async () => {
    const stderr: string[] = [];

    const code = await runCli(
      ["flow", "list", "--server", "http://server.test"],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      {
        env: { NITELY_API_TOKEN: "nitely_api_flow_secret" },
        fetch: async () => {
          throw new Error("upstream rejected token nitely_api_flow_secret");
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual(["upstream rejected token [REDACTED]"]);
  });

  it("rejects unknown flow subcommands", async () => {
    const stderr: string[] = [];

    const code = await runCli(
      ["flow", "create"],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      {},
    );

    expect(code).toBe(1);
    expect(stderr).toEqual(["Usage: nitely flow list [--server <url>] [--json]"]);
  });

  it("lists remote tasks with id, status, and title", async () => {
    const stdout: string[] = [];
    const urls: string[] = [];

    const code = await runCli(
      ["task", "list", "--server", "http://server.test"],
      { stdout: (line) => stdout.push(line), stderr: () => {} },
      {
        fetch: async (input) => {
          urls.push(String(input));
          return new Response(
            JSON.stringify({
              tasks: [
                { id: "task-1", title: "Add retry policy", displayStatus: "running" },
                { id: "task-2", title: "Fix flaky gate", status: "planned" },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    expect(code).toBe(0);
    expect(urls).toEqual(["http://server.test/api/tasks"]);
    expect(stdout).toEqual([
      "task-1  running  Add retry policy",
      "task-2  planned  Fix flaky gate",
    ]);
  });

  it("reports an empty remote task list", async () => {
    const stdout: string[] = [];

    const code = await runCli(
      ["task", "list", "--server", "http://server.test"],
      { stdout: (line) => stdout.push(line), stderr: () => {} },
      {
        fetch: async () =>
          new Response(JSON.stringify({ tasks: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );

    expect(code).toBe(0);
    expect(stdout).toEqual(["No tasks"]);
  });

  it("emits the remote task payload unchanged for task list --json", async () => {
    const stdout: string[] = [];
    const tasks = [{ id: "task-1", title: "Add retry policy", status: "running" }];

    const code = await runCli(
      ["task", "list", "--server", "http://server.test", "--json"],
      { stdout: (line) => stdout.push(line), stderr: () => {} },
      {
        fetch: async () =>
          new Response(JSON.stringify({ tasks }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );

    expect(code).toBe(0);
    expect(stdout).toEqual([JSON.stringify({ tasks })]);
  });

  it("prints task list server errors with HTTP status and message", async () => {
    const stderr: string[] = [];

    const code = await runCli(
      ["task", "list", "--server", "http://server.test"],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      {
        fetch: async () =>
          new Response(
            JSON.stringify({
              error: { message: "API token capability denied: tasks:read is required" },
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          ),
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual([
      "remote task list failed (HTTP 403): API token capability denied: tasks:read is required",
    ]);
  });

  it("fails task list without a configured instance", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "nitely-cli-instance-"));
    const stderr: string[] = [];

    const code = await runCli(
      ["task", "list"],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      {
        env: { NITELY_CONFIG_DIR: configDir },
        fetch: async () => {
          throw new Error("fetch must not be called");
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual(["Missing --server, NITELY_SERVER_URL, or a saved instance from nitely connect"]);
  });

  it("lists remote runs with run id, status, task id, and stage", async () => {
    const stdout: string[] = [];
    const urls: string[] = [];

    const code = await runCli(
      ["run", "list", "--server", "http://server.test"],
      { stdout: (line) => stdout.push(line), stderr: () => {} },
      {
        fetch: async (input) => {
          urls.push(String(input));
          return new Response(
            JSON.stringify({
              runs: [
                {
                  runId: "run-1",
                  status: "running",
                  taskId: "task-1",
                  currentStage: "implement",
                },
                { runId: "run-2", status: "completed" },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    expect(code).toBe(0);
    expect(urls).toEqual(["http://server.test/api/runs"]);
    expect(stdout).toEqual([
      "run-1  running  task-1  implement",
      "run-2  completed  -  -",
    ]);
  });

  it("reports an empty remote run list", async () => {
    const stdout: string[] = [];

    const code = await runCli(
      ["run", "list", "--server", "http://server.test"],
      { stdout: (line) => stdout.push(line), stderr: () => {} },
      {
        fetch: async () =>
          new Response(JSON.stringify({ runs: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );

    expect(code).toBe(0);
    expect(stdout).toEqual(["No runs"]);
  });

  it("emits the remote run payload unchanged for run list --json", async () => {
    const stdout: string[] = [];
    const runs = [{ runId: "run-1", status: "running", taskId: "task-1" }];

    const code = await runCli(
      ["run", "list", "--server", "http://server.test", "--json"],
      { stdout: (line) => stdout.push(line), stderr: () => {} },
      {
        fetch: async () =>
          new Response(JSON.stringify({ runs }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );

    expect(code).toBe(0);
    expect(stdout).toEqual([JSON.stringify({ runs })]);
  });

  it("filters remote runs by status", async () => {
    const stdout: string[] = [];

    const code = await runCli(
      ["run", "list", "--server", "http://server.test", "--status", "running"],
      { stdout: (line) => stdout.push(line), stderr: () => {} },
      {
        fetch: async () =>
          new Response(
            JSON.stringify({
              runs: [
                { runId: "run-1", status: "running" },
                { runId: "run-2", status: "completed" },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      },
    );

    expect(code).toBe(0);
    expect(stdout).toEqual(["run-1  running  -  -"]);
  });

  it.each(["incomplete", "awaiting-approval"] as const)(
    "filters remote runs by %s",
    async (status) => {
      const stdout: string[] = [];

      const code = await runCli(
        ["run", "list", "--server", "http://server.test", "--status", status],
        { stdout: (line) => stdout.push(line), stderr: () => {} },
        {
          fetch: async () =>
            new Response(
              JSON.stringify({
                runs: [
                  { runId: "run-1", status },
                  { runId: "run-2", status: "completed" },
                  {
                    runId: "run-3",
                    status: status === "incomplete" ? "awaiting-approval" : "incomplete",
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
        },
      );

      expect(code).toBe(0);
      expect(stdout).toEqual([`run-1  ${status}  -  -`]);
    },
  );

  it("pins run list --status accepted values to WEB_RUN_STATUSES", () => {
    for (const status of WEB_RUN_STATUSES) {
      expect(parseRemoteRunStatusOption(status)).toBe(status);
    }
    expect(() => parseRemoteRunStatusOption("pending")).toThrow(
      `invalid --status value: pending. Supported statuses: ${WEB_RUN_STATUSES.join(", ")}`,
    );
  });

  it("rejects an unknown run list status without calling the server", async () => {
    const stderr: string[] = [];

    const code = await runCli(
      ["run", "list", "--server", "http://server.test", "--status", "pending"],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      {
        fetch: async () => {
          throw new Error("fetch must not be called");
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual([
      `invalid --status value: pending. Supported statuses: ${WEB_RUN_STATUSES.join(", ")}`,
    ]);
  });

  it("rejects run list payloads without a runs array", async () => {
    const stderr: string[] = [];

    const code = await runCli(
      ["run", "list", "--server", "http://server.test"],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      {
        fetch: async () =>
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual(["remote run list failed: invalid response: missing runs"]);
  });

  it("redacts the resolved token in run list errors", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "nitely-cli-instance-"));
    expect(
      await runCli(
        ["connect", "--server", "http://saved.test"],
        { stdout: () => {}, stderr: () => {} },
        { env: { NITELY_CONFIG_DIR: configDir, NITELY_API_TOKEN: "secret-token" } },
      ),
    ).toBe(0);

    const stderr: string[] = [];
    const code = await runCli(
      ["run", "list"],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      {
        env: { NITELY_CONFIG_DIR: configDir },
        fetch: async () => {
          throw new Error("upstream rejected secret-token");
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual(["upstream rejected [REDACTED]"]);
  });

  it("prints run list server errors with HTTP status and message", async () => {
    const stderr: string[] = [];

    const code = await runCli(
      ["run", "list", "--server", "http://server.test"],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      {
        fetch: async () =>
          new Response(
            JSON.stringify({
              error: { message: "API token capability denied: runs:read is required" },
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          ),
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual([
      "remote run list failed (HTTP 403): API token capability denied: runs:read is required",
    ]);
  });

  it("fails run list without a configured instance", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "nitely-cli-instance-"));
    const stderr: string[] = [];

    const code = await runCli(
      ["run", "list"],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      {
        env: { NITELY_CONFIG_DIR: configDir },
        fetch: async () => {
          throw new Error("fetch must not be called");
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual(["Missing --server, NITELY_SERVER_URL, or a saved instance from nitely connect"]);
  });

  it("approves a remote task spec", async () => {
    const stdout: string[] = [];
    const calls: Array<{ url: string; method?: string }> = [];

    const code = await runCli(
      ["task", "approve-spec", "task-1", "--server", "http://server.test"],
      { stdout: (line) => stdout.push(line), stderr: () => {} },
      {
        fetch: async (input, init) => {
          calls.push({ url: String(input), method: init?.method });
          return new Response(
            JSON.stringify({ task: { id: "task-1", specStatus: "approved" } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    expect(code).toBe(0);
    expect(calls).toEqual([
      { url: "http://server.test/api/tasks/task-1/approve-spec", method: "POST" },
    ]);
    expect(stdout).toEqual(["TASK task-1 spec approved"]);
  });

  it("approves a remote task technical design", async () => {
    const stdout: string[] = [];
    const calls: string[] = [];

    const code = await runCli(
      ["task", "approve-tech-design", "task-1", "--server", "http://server.test"],
      { stdout: (line) => stdout.push(line), stderr: () => {} },
      {
        fetch: async (input) => {
          calls.push(String(input));
          return new Response(
            JSON.stringify({ task: { id: "task-1", techDesignStatus: "approved" } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    expect(code).toBe(0);
    expect(calls).toEqual(["http://server.test/api/tasks/task-1/approve-tech-design"]);
    expect(stdout).toEqual(["TASK task-1 tech-design approved"]);
  });

  it("emits the remote payload unchanged for task approve-spec --json", async () => {
    const stdout: string[] = [];
    const task = { id: "task-1", specStatus: "approved" };

    const code = await runCli(
      ["task", "approve-spec", "task-1", "--server", "http://server.test", "--json"],
      { stdout: (line) => stdout.push(line), stderr: () => {} },
      {
        fetch: async () =>
          new Response(JSON.stringify({ task }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );

    expect(code).toBe(0);
    expect(stdout).toEqual([JSON.stringify({ task })]);
  });

  it("emits the remote payload unchanged for task approve-tech-design --json", async () => {
    const stdout: string[] = [];
    const task = { id: "task-1", techDesignStatus: "approved" };

    const code = await runCli(
      ["task", "approve-tech-design", "task-1", "--server", "http://server.test", "--json"],
      { stdout: (line) => stdout.push(line), stderr: () => {} },
      {
        fetch: async () =>
          new Response(JSON.stringify({ task }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );

    expect(code).toBe(0);
    expect(stdout).toEqual([JSON.stringify({ task })]);
  });

  it("starts a remote run and names the watch command", async () => {
    const stdout: string[] = [];
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];

    const code = await runCli(
      ["task", "start", "task-1", "--server", "http://server.test"],
      { stdout: (line) => stdout.push(line), stderr: () => {} },
      {
        fetch: async (input, init) => {
          calls.push({ url: String(input), method: init?.method, body: init?.body });
          return new Response(
            JSON.stringify({ run: { runId: "run-9", status: "running", taskId: "task-1" } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    expect(code).toBe(0);
    expect(calls).toEqual([
      {
        url: "http://server.test/api/tasks/task-1/runs",
        method: "POST",
        body: JSON.stringify({}),
      },
    ]);
    expect(stdout).toEqual([
      "RUN run-9 running",
      "Watch command: nitely run watch run-9",
    ]);
  });

  it("emits the remote payload unchanged for task start --json", async () => {
    const stdout: string[] = [];
    const run = { runId: "run-9", status: "running", taskId: "task-1" };

    const code = await runCli(
      ["task", "start", "task-1", "--server", "http://server.test", "--json"],
      { stdout: (line) => stdout.push(line), stderr: () => {} },
      {
        fetch: async () =>
          new Response(JSON.stringify({ run }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );

    expect(code).toBe(0);
    expect(stdout).toEqual([JSON.stringify({ run })]);
  });

  it("rejects task start payloads without a run id", async () => {
    const stderr: string[] = [];

    const code = await runCli(
      ["task", "start", "task-1", "--server", "http://server.test"],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      {
        fetch: async () =>
          new Response(JSON.stringify({ run: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual([
      "remote task start failed: invalid response: missing run.runId",
    ]);
  });

  it("rejects task start --json payloads without a run id", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["task", "start", "task-1", "--server", "http://server.test", "--json"],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      {
        fetch: async () =>
          new Response(JSON.stringify({ run: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "remote task start failed: invalid response: missing run.runId",
    ]);
  });

  it("prints the remote capability failure for an unauthorized spec approval", async () => {
    const stderr: string[] = [];

    const code = await runCli(
      ["task", "approve-spec", "task-1", "--server", "http://server.test"],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      {
        fetch: async () =>
          new Response(
            JSON.stringify({
              error: { message: "API token capability denied: spec:approve is required" },
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          ),
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual([
      "remote task approve-spec failed (HTTP 403): API token capability denied: spec:approve is required",
    ]);
  });

  it("prints the remote capability failure for an unauthorized tech-design approval", async () => {
    const stderr: string[] = [];

    const code = await runCli(
      ["task", "approve-tech-design", "task-1", "--server", "http://server.test"],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      {
        fetch: async () =>
          new Response(
            JSON.stringify({
              error: { message: "API token capability denied: spec:approve is required" },
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          ),
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual([
      "remote task approve-tech-design failed (HTTP 403): API token capability denied: spec:approve is required",
    ]);
  });

  it("requires a task id for remote task approve-spec", async () => {
    const stderr: string[] = [];

    const code = await runCli(
      ["task", "approve-spec"],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      {
        fetch: async () => {
          throw new Error("fetch must not be called");
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual([
      "Usage: nitely task approve-spec <task-id> [--server <url>] [--json]",
    ]);
  });

  it("requires a task id for remote task approve-tech-design", async () => {
    const stderr: string[] = [];

    const code = await runCli(
      ["task", "approve-tech-design"],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      {
        fetch: async () => {
          throw new Error("fetch must not be called");
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual([
      "Usage: nitely task approve-tech-design <task-id> [--server <url>] [--json]",
    ]);
  });

  it("fails remote task approve-spec without a configured instance", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "nitely-cli-instance-"));
    const stderr: string[] = [];

    const code = await runCli(
      ["task", "approve-spec", "task-1"],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      {
        env: { NITELY_CONFIG_DIR: configDir },
        fetch: async () => {
          throw new Error("fetch must not be called");
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual(["Missing --server, NITELY_SERVER_URL, or a saved instance from nitely connect"]);
  });

  it("fails remote task approve-tech-design without a configured instance", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "nitely-cli-instance-"));
    const stderr: string[] = [];

    const code = await runCli(
      ["task", "approve-tech-design", "task-1"],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      {
        env: { NITELY_CONFIG_DIR: configDir },
        fetch: async () => {
          throw new Error("fetch must not be called");
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual(["Missing --server, NITELY_SERVER_URL, or a saved instance from nitely connect"]);
  });

  it("rejects task approve-spec payloads without a spec status", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["task", "approve-spec", "task-1", "--server", "http://server.test"],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      {
        fetch: async () =>
          new Response(JSON.stringify({ task: { id: "task-1" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "remote task approve-spec failed: invalid response: missing task.specStatus",
    ]);
  });

  it("rejects task approve-spec --json payloads without a spec status", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["task", "approve-spec", "task-1", "--server", "http://server.test", "--json"],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      {
        fetch: async () =>
          new Response(JSON.stringify({ task: { id: "task-1" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "remote task approve-spec failed: invalid response: missing task.specStatus",
    ]);
  });

  it("rejects task approve-tech-design payloads without a tech-design status", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["task", "approve-tech-design", "task-1", "--server", "http://server.test"],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      {
        fetch: async () =>
          new Response(JSON.stringify({ task: { id: "task-1" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "remote task approve-tech-design failed: invalid response: missing task.techDesignStatus",
    ]);
  });

  it("rejects task approve-tech-design --json payloads without a tech-design status", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["task", "approve-tech-design", "task-1", "--server", "http://server.test", "--json"],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      {
        fetch: async () =>
          new Response(JSON.stringify({ task: { id: "task-1" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "remote task approve-tech-design failed: invalid response: missing task.techDesignStatus",
    ]);
  });

  it("requires a task id for remote task start", async () => {
    const stderr: string[] = [];

    const code = await runCli(
      ["task", "start"],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      {
        fetch: async () => {
          throw new Error("fetch must not be called");
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual(["Usage: nitely task start <task-id> [--server <url>] [--json]"]);
  });

  it("fails remote task start without a configured instance", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "nitely-cli-instance-"));
    const stderr: string[] = [];

    const code = await runCli(
      ["task", "start", "task-1"],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      {
        env: { NITELY_CONFIG_DIR: configDir },
        fetch: async () => {
          throw new Error("fetch must not be called");
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual(["Missing --server, NITELY_SERVER_URL, or a saved instance from nitely connect"]);
  });

  it("redacts the resolved token in remote task start errors", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "nitely-cli-instance-"));
    expect(
      await runCli(
        ["connect", "--server", "http://saved.test"],
        { stdout: () => {}, stderr: () => {} },
        { env: { NITELY_CONFIG_DIR: configDir, NITELY_API_TOKEN: "start-token" } },
      ),
    ).toBe(0);

    const stderr: string[] = [];
    const code = await runCli(
      ["task", "start", "task-1"],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      {
        env: { NITELY_CONFIG_DIR: configDir },
        fetch: async () => {
          throw new Error("upstream rejected start-token");
        },
      },
    );

    expect(code).toBe(1);
    expect(stderr).toEqual(["upstream rejected [REDACTED]"]);
  });

  it("prints a run efficiency diagnostic from evidence", async () => {
    const stdout: string[] = [];
    const code = await runCli(
      ["diagnose", "run-517", "--repo", "/repo"],
      { stdout: (line) => stdout.push(line), stderr: () => {} },
      {
        diagnoseRun: (repoPath, runId) => {
          expect(repoPath).toBe("/repo");
          expect(runId).toBe("run-517");
          return {
            schemaVersion: "nitely.efficiency-report.v1",
            runId,
            findings: [
              {
                ruleId: "runtime-input-amplification",
                version: 1,
                severity: "high",
                confidence: "high",
                title: "Runtime input grew far beyond assembled context",
                summary: "Stage write-tests sent 2216578 runtime input tokens while Nitely assembled about 2300 context tokens.",
                evidence: {
                  runId,
                  stageIds: ["write-tests"],
                  eventTypes: ["stage.context.usage", "stage.runtime.usage"],
                },
                remediation: "Bound agent reads.",
                relatedIssues: [517, 529],
              },
            ],
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(stdout[0]).toBe("Run: run-517");
    expect(stdout.join("\n")).toContain("runtime-input-amplification");
    expect(stdout.join("\n")).toContain("2300");
  });

  it("derives the help text from the command registry", async () => {
    const lines: string[] = [];
    await runCli([], { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) });

    const usageLines = cliCommands().flatMap((command) => command.usage);

    expect(usageLines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toBe(["nitely", "", "Commands:", ...usageLines].join("\n"));
  });

  it("registers no undocumented command", async () => {
    const undocumented = cliCommands()
      .filter((command) => command.usage.length === 0)
      .map((command) => command.name);

    expect(undocumented).toEqual([]);
  });

  it("reports an unknown command", async () => {
    const stderr: string[] = [];

    const code = await runCli(
      ["definitely-not-a-command"],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      {},
    );

    expect(code).toBe(1);
    expect(stderr).toEqual(["Unknown command: definitely-not-a-command"]);
  });

  it("marks --server optional for every command that accepts a saved instance", async () => {
    const lines: string[] = [];
    await runCli([], { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) });
    const help = lines.join("\n");

    expect(help).toContain(
      "task create [--server <url>] --title <title> --spec <path> --tech-design <path>",
    );
    expect(help).toContain("task plan [--server <url>]");
    expect(help).toContain("--issue <url> | --jira <ref>");
    expect(help).toContain("task draft-tech-design <task-id> [--server <url>] [--json]");
    expect(help).toContain("task watch <task-id> [--server <url>] [--interval-ms <n>]");
    expect(help).toContain("run watch <run-id> [--server <url>] [--interval-ms <n>]");
    expect(help).toContain("mcp serve [--server <url>]");
    expect(help).toContain(
      "smoke github-issue-intake [--server <url>] --issue <github-issue-url>",
    );
  });

  it("keeps --server required for connect, which has no saved instance to fall back on", async () => {
    const lines: string[] = [];
    await runCli([], { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) });

    expect(lines.join("\n")).toContain("connect --server <url>");
    expect(lines.join("\n")).not.toContain("connect [--server <url>]");
  });
});
