import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { OciExecutionBackend } from "../../../src/run/execution/oci.js";
import type { Stage } from "../../../src/flow/schema.js";

// Real rootless Docker only. The `Rootless OCI integration` CI job sets both
// variables and fails if any of these tests is skipped instead of passed.
// The fake-Docker coverage of the same paths lives in oci.test.ts.
const realRootless =
  process.platform === "linux" &&
  process.arch === "x64" &&
  process.env.NITELY_TEST_ROOTLESS_DOCKER === "1" &&
  Boolean(process.env.NITELY_OCI_TEST_IMAGE);

type AgentStage = Extract<Stage, { type: "agent" }>;
const execFileAsync = promisify(execFile);

interface Fixture {
  worktree: string;
  attempt: string;
}

async function createFixture(): Promise<Fixture> {
  const runRoot = await mkdtemp(join(tmpdir(), "nitely-oci-rootless-"));
  const worktree = join(runRoot, "worktree");
  const attempt = join(runRoot, "stages", "implement", "1");
  await mkdir(worktree, { recursive: true });
  await mkdir(attempt, { recursive: true });
  return { worktree, attempt };
}

function agentStage(
  runtime: string,
  capabilities: Partial<NonNullable<AgentStage["capabilities"]>>,
): AgentStage {
  return {
    id: "implement",
    type: "agent",
    runtime,
    prompt: "Implement.",
    inputs: [],
    outputs: ["implementation"],
    skills: [],
    required_mcp_servers: [],
    required_connectors: [],
    capabilities: {
      read: { scope: "repository", allow: [] },
      write: { scope: "worktree", allow: [] },
      commands: { mode: "unrestricted", allow: [], deny: [], advisory: false },
      network: { mode: "disabled", advisory: false, domains: [] },
      allowedRuntimes: [runtime],
      allowedModels: [],
      instructions: { repo: true, generated: true, skills: true },
      evidence: {
        prompts: true,
        toolCalls: true,
        fileChanges: true,
        runtimeUsage: true,
      },
      ...capabilities,
    },
  };
}

/** Writes an executable stand-in for an agent CLI into the worktree. */
async function fakeAgentCli(worktree: string, body: string[]): Promise<string> {
  const dir = join(worktree, ".nitely-fake");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "agent");
  await writeFile(path, ["#!/bin/sh", "set +e", ...body, ""].join("\n"), "utf8");
  await chmod(path, 0o755);
  return "/workspace/.nitely-fake/agent";
}

async function readOutput(fixture: Fixture, name: string): Promise<string | undefined> {
  return readFile(join(fixture.attempt, name), "utf8").catch(() => undefined);
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { env: process.env });
  return stdout.trim();
}

describe.runIf(realRootless)("OCI backend on a real rootless Docker daemon", () => {
  afterEach(async () => {
    // Every workload, egress gateway, and internal network a run creates is
    // gone once runAgent settles, whether the stage passed or crashed.
    // Containers carry their run id. Egress networks carry no run label, so
    // that check needs the other OCI test files not to run at the same time
    // (the CI job passes --no-file-parallelism).
    for (const runId of ["rootless-claude", "rootless-pi", "rootless-crash", "rootless-no-python"]) {
      expect(await docker(["ps", "-aq", "--filter", `label=com.nitely.run-id=${runId}`])).toBe("");
    }
    expect(
      await docker(["network", "ls", "-q", "--filter", "label=com.nitely.network-purpose=oci-egress"]),
    ).toBe("");
  });

  it("runs as rootless Docker", async () => {
    expect(await docker(["info", "--format", "{{json .SecurityOptions}}"])).toContain("rootless");
  });

  it.each([
    ["claude", "NITELY_CLAUDE_COMMAND", "api.anthropic.com"],
    ["pi", "NITELY_PI_COMMAND", "api.openai.com"],
  ])(
    "mediates a %s workflow behind the real egress gateway",
    async (runtime, commandEnv, domain) => {
      const fixture = await createFixture();
      const command = await fakeAgentCli(fixture.worktree, [
        'printf "%s\\n" "$@" > "$NITELY_OUTPUT_DIR/argv.txt"',
        '/bin/cat > "$NITELY_OUTPUT_DIR/prompt.txt"; echo cat:$?',
        '/usr/bin/id -u > "$NITELY_OUTPUT_DIR/id.txt"; echo id:$?',
        '/usr/bin/touch "$NITELY_OUTPUT_DIR/touched"; echo touch:$?',
        '/bin/sh -c \'/usr/bin/touch "$NITELY_OUTPUT_DIR/touched-sh"\'; echo sh:$?',
        'if [ -n "$HTTPS_PROXY" ]; then echo proxy:set; fi',
        'printf "%s" "$IS_SANDBOX" > "$NITELY_OUTPUT_DIR/sandbox.txt"',
        "echo done",
      ]);
      const backend = new OciExecutionBackend({
        image: process.env.NITELY_OCI_TEST_IMAGE!,
        env: {
          ...process.env,
          [commandEnv]: command,
          ANTHROPIC_API_KEY: "sk-ant-rootless-ci-placeholder",
        },
        secretAllowlist: ["ANTHROPIC_API_KEY"],
        networkAllowlist: [domain],
      });

      const result = await backend.runAgent(
        { runId: `rootless-${runtime}`, path: fixture.worktree },
        {
          stage: agentStage(runtime, {
            commands: {
              mode: "allow-list",
              allow: ["cat", "id"],
              deny: ["touch"],
              advisory: false,
            },
            network: { mode: "restricted", advisory: false, domains: [domain] },
          }),
          prompt: "Rootless workflow prompt.",
          attemptDirectory: fixture.attempt,
          timeoutMs: 90_000,
        },
      );

      expect(result.stdout).toContain("cat:0");
      expect(result.stdout).toContain("id:0");
      expect(result.stdout).toContain("proxy:set");
      expect(result.stdout).not.toContain("touch:0");
      expect(result.stdout).not.toContain("sh:0");
      expect(result.stdout).toContain("done");
      expect(await readOutput(fixture, "prompt.txt")).toContain("Rootless workflow prompt.");
      expect(await readOutput(fixture, "id.txt")).toMatch(/^0\s*$/);
      expect(await readOutput(fixture, "touched")).toBeUndefined();
      expect(await readOutput(fixture, "touched-sh")).toBeUndefined();
      if (runtime === "claude") {
        expect(await readOutput(fixture, "sandbox.txt")).toBe("1");
        expect(await readOutput(fixture, "argv.txt")).toContain("--permission-mode");
      }

      const evidence = (await readOutput(fixture, "command-mediation.jsonl")) ?? "";
      expect(evidence).toContain('"event":"launch"');
      expect(evidence).toContain('"program":"touch"');
      expect(evidence).toContain('"program":"dash"');
      expect(evidence).toContain('"decision":"deny"');
      expect(evidence).toContain('"event":"supervisor-exit"');
      expect(evidence).not.toContain("sk-ant-rootless-ci-placeholder");
      expect(evidence).not.toContain("Rootless workflow prompt.");
    },
  );

  it("kills the workload and removes the container when the supervisor dies", async () => {
    const fixture = await createFixture();
    // The agent CLI is the supervisor's traced child, so $PPID is the
    // supervisor. Killing it must take the workload down with it
    // (PTRACE_O_EXITKILL plus PR_SET_PDEATHSIG) before the loop finishes.
    const command = await fakeAgentCli(fixture.worktree, [
      'printf started > "$NITELY_OUTPUT_DIR/started"',
      'kill -9 "$PPID"',
      "i=0",
      'while [ "$i" -lt 2000000 ]; do i=$((i + 1)); done',
      'printf survived > "$NITELY_OUTPUT_DIR/survived"',
      '/usr/bin/touch "$NITELY_OUTPUT_DIR/touched-after-crash"',
    ]);
    const backend = new OciExecutionBackend({
      image: process.env.NITELY_OCI_TEST_IMAGE!,
      env: {
        ...process.env,
        NITELY_CLAUDE_COMMAND: command,
        ANTHROPIC_API_KEY: "sk-ant-rootless-ci-placeholder",
      },
      secretAllowlist: ["ANTHROPIC_API_KEY"],
      networkAllowlist: ["api.anthropic.com"],
    });

    await expect(
      backend.runAgent(
        { runId: "rootless-crash", path: fixture.worktree },
        {
          stage: agentStage("claude", {
            commands: {
              mode: "allow-list",
              allow: ["id"],
              deny: ["touch"],
              advisory: false,
            },
            network: {
              mode: "restricted",
              advisory: false,
              domains: ["api.anthropic.com"],
            },
          }),
          prompt: "Crash the supervisor.",
          attemptDirectory: fixture.attempt,
          timeoutMs: 90_000,
        },
      ),
    ).rejects.toThrow(/exited with code/);

    expect(await readOutput(fixture, "started")).toBe("started");
    expect(await readOutput(fixture, "survived")).toBeUndefined();
    expect(await readOutput(fixture, "touched-after-crash")).toBeUndefined();
    const evidence = (await readOutput(fixture, "command-mediation.jsonl")) ?? "";
    expect(evidence).toContain('"event":"launch"');
    expect(evidence).not.toContain('"event":"supervisor-exit"');
  });

  it("refuses an enforcement stage before launch when the image has no python3", async () => {
    const fixture = await createFixture();
    // An offline launcher, so the refusal comes from the python3 probe and
    // not from the egress gateway, which also needs the runner image.
    const backend = new OciExecutionBackend({
      image: process.env.NITELY_OCI_NO_PYTHON_TEST_IMAGE ?? "busybox:1.36.1",
      runtimeRegistry: {
        supportedIds: () => ["codex"],
        resolve: () => ({
          id: "codex",
          networkAccess: "none",
          build: () => ({
            runtime: "codex",
            command: "/bin/true",
            args: [],
            promptDelivery: "stdin" as const,
          }),
        }),
      },
    });
    const before = await docker(["ps", "-aq"]);

    await expect(
      backend.runAgent(
        { runId: "rootless-no-python", path: fixture.worktree },
        {
          stage: {
            ...agentStage("codex", {
              commands: { mode: "allow-list", allow: ["id"], deny: [], advisory: false },
            }),
          },
          prompt: "Should not start.",
          attemptDirectory: fixture.attempt,
          timeoutMs: 30_000,
        },
      ),
    ).rejects.toThrow(/requires python3 on Linux x86_64/);
    expect(await docker(["ps", "-aq"])).toBe(before);
    expect(await readOutput(fixture, "command-mediation.jsonl")).toBeUndefined();
  });
});
