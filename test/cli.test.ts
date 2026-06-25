import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli.js";
import { EventStore } from "../src/events/store.js";
import { eventStorePath } from "../src/run/project.js";
import { projectRun } from "../src/run/project.js";

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
    expect(lines.join("\n")).toContain("runs");
    expect(lines.join("\n")).not.toContain("cancel");
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
              spec: { connector: "local-file", uri: "specs/change.md" },
              "tech-design": {
                connector: "local-file",
                uri: "docs/design.md",
              },
            },
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
              tasks: { connector: "local-file", uri: "docs/tasks.md" },
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
                uri: "specs/issues/022-pr-rework-flow-spec.md",
              },
              "tech-design": {
                connector: "local-file",
                uri: "docs/plans/rework.md",
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
        "--dry-run",
        "--allow-author",
        "alice",
        "--bot-login",
        "nitely",
        "--prior-run",
        "run-prev",
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
            dryRun: true,
            allowAuthors: ["alice"],
            botLogin: "nitely",
            priorRunId: "run-prev",
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
              artifacts: [],
              gates: [],
              orchestratorDecisions: [],
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
            artifacts: [],
            gates: [],
            orchestratorDecisions: [],
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
          artifacts: [],
          gates: [],
          orchestratorDecisions: [],
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

  it("resumes interrupted runs through the injected runner", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["resume", "run-1", "--repo", "/repo"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        resumeRun: async (input) => {
          expect(input).toEqual({ repoPath: "/repo", runId: "run-1" });
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
    ]);
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

  it("passes additional web repositories to the web server starter", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["web", "--repo", "/repo", "--repository", "docs=/repos/docs"],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        startWebServer: async (input) => {
          expect(input).toMatchObject({
            repoPath: "/repo",
            repositories: [{ id: "docs", path: "/repos/docs" }],
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
});
