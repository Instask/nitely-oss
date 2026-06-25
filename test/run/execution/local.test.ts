import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  LocalExecutionBackend,
  createCodexExecArgs,
  createDefaultAgentRuntimeRegistry,
} from "../../../src/run/execution/local.js";
import type { Stage } from "../../../src/flow/schema.js";

const execFileAsync = promisify(execFile);
async function git(cwd: string, args: string[]) {
  return await execFileAsync("git", args, { cwd });
}
async function createRepo() {
  const repo = await mkdtemp(join(tmpdir(), "nitely-local-be-"));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "nitely@example.test"]);
  await git(repo, ["config", "user.name", "Nitely Test"]);
  await writeFile(join(repo, "README.md"), "# Test\n", "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

type AgentStage = Extract<Stage, { type: "agent" }>;

interface SpawnCall {
  command: string;
  args: string[];
  options: {
    cwd?: string;
    stdio?: string[];
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  };
  stdin: string;
}

function agentStage(input: {
  id?: string;
  runtime: string;
  model?: string;
  outputs?: string[];
}): AgentStage {
  return {
    id: input.id ?? "agent",
    type: "agent",
    runtime: input.runtime,
    model: input.model,
    skills: [],
    required_mcp_servers: [],
    required_connectors: [],
    prompt: "Run the agent.",
    inputs: [],
    outputs: input.outputs ?? ["implementation"],
  };
}

function createSuccessfulSpawn(calls: SpawnCall[]) {
  return (
    command: string,
    args: readonly string[],
    options: {
      cwd?: string;
      stdio?: string[];
      env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    },
  ) => {
    const child = new EventEmitter() as EventEmitter & { stdin: Writable };
    const call: SpawnCall = {
      command,
      args: [...args],
      options,
      stdin: "",
    };
    calls.push(call);
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        call.stdin += chunk.toString();
        callback();
      },
      final(callback) {
        queueMicrotask(() => child.emit("close", 0));
        callback();
      },
    });
    return child;
  };
}

function createOutputSpawn(stdoutText: string, stderrText: string) {
  return () => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: Writable;
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        queueMicrotask(() => {
          child.stdout.write(stdoutText);
          child.stderr.write(stderrText);
          child.stdout.end();
          child.stderr.end();
          child.emit("close", 0);
        });
        callback();
      },
    });
    return child;
  };
}

function createMissingExecutableSpawn(command: string) {
  return () => {
    const child = new EventEmitter() as EventEmitter & { stdin: Writable };
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    queueMicrotask(() => {
      const error = new Error(`spawn ${command} ENOENT`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      child.emit("error", error);
    });
    return child;
  };
}

function createNonzeroExitSpawn(code: number) {
  return () => {
    const child = new EventEmitter() as EventEmitter & { stdin: Writable };
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        queueMicrotask(() => child.emit("close", code));
        callback();
      },
    });
    return child;
  };
}

function createEarlyStdinCloseSpawn() {
  return () => {
    const child = new EventEmitter() as EventEmitter & { stdin: Writable };
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        const error = new Error("write EPIPE") as NodeJS.ErrnoException;
        error.code = "EPIPE";
        callback(error);
      },
    });
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };
}

describe("LocalExecutionBackend", () => {
  it("createWorkspace adds a branch and worktree and returns a handle with the path", async () => {
    const repo = await createRepo();
    const worktreePath = join(repo, ".nitely", "runs", "run-1", "worktree");
    const backend = new LocalExecutionBackend();
    const ws = await backend.createWorkspace({
      repoPath: repo,
      branchName: "nitely/run-1",
      runId: "run-1",
      worktreePath,
    });
    expect(ws).toEqual({ runId: "run-1", path: worktreePath });
    await expect(stat(join(worktreePath, "README.md"))).resolves.toBeDefined();
    const { stdout } = await git(worktreePath, ["branch", "--show-current"]);
    expect(stdout.trim()).toBe("nitely/run-1");
  });

  it("runCommand returns captured stdout, stderr, and exit code", async () => {
    const repo = await createRepo();
    const backend = new LocalExecutionBackend();
    const ws = { runId: "run-2", path: repo };
    const ok = await backend.runCommand(ws, "printf hello");
    expect(ok).toEqual({ stdout: "hello", stderr: "", exitCode: 0 });
    const bad = await backend.runCommand(ws, "printf oops >&2; exit 3");
    expect(bad.stderr).toBe("oops");
    expect(bad.exitCode).toBe(3);
  });

  it("commitAll commits only when the worktree is dirty", async () => {
    const repo = await createRepo();
    const backend = new LocalExecutionBackend();
    const ws = { runId: "run-3", path: repo };
    expect(await backend.commitAll(ws, "feat: noop")).toEqual({
      committed: false,
    });
    await writeFile(join(repo, "feature.txt"), "x\n", "utf8");
    expect(await backend.commitAll(ws, "feat: change")).toEqual({
      committed: true,
    });
    const { stdout } = await git(repo, ["status", "--short"]);
    expect(stdout.trim()).toBe("");
  });

  it("createCodexExecArgs builds the codex exec args with the default sandbox", () => {
    expect(createCodexExecArgs("/wt")).toEqual([
      "exec",
      "--sandbox",
      "danger-full-access",
      "--cd",
      "/wt",
      "-",
    ]);
  });

  it("passes the requested model to Codex with -m when a model is given", () => {
    expect(createCodexExecArgs("/wt", "gpt-5.3-codex-spark")).toEqual([
      "exec",
      "--sandbox",
      "danger-full-access",
      "-m",
      "gpt-5.3-codex-spark",
      "--cd",
      "/wt",
      "-",
    ]);
  });

  it("omits the -m flag when no model is given", () => {
    expect(createCodexExecArgs("/wt")).not.toContain("-m");
  });

  it("resolves supported agent runtimes exactly after trimming", () => {
    const registry = createDefaultAgentRuntimeRegistry();

    expect(registry.resolve(" codex ").id).toBe("codex");
    expect(registry.resolve("claude").id).toBe("claude");
    expect(registry.resolve("glm").id).toBe("glm");
    expect(() => registry.resolve("Codex")).toThrow(
      /unsupported agent runtime: Codex.*codex.*claude.*glm/s,
    );
  });

  it("runs Codex through the registry with existing args and stdin prompt delivery", async () => {
    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      spawn: createSuccessfulSpawn(calls),
    });

    await backend.runAgent(
      { runId: "run-agent", path: "/repo/worktree" },
      {
        stage: agentStage({ runtime: "codex", model: "gpt-5.3-codex-spark" }),
        prompt: "Implement this.",
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "codex",
      args: createCodexExecArgs("/repo/worktree", "gpt-5.3-codex-spark"),
      options: { cwd: "/repo/worktree", stdio: ["pipe", "pipe", "pipe"] },
      stdin: "Implement this.",
    });
  });

  it("captures stdout and stderr from agent runtimes", async () => {
    const backend = new LocalExecutionBackend({
      spawn: createOutputSpawn("agent stdout\n", "agent stderr\n"),
    });

    const result = await backend.runAgent(
      { runId: "run-agent", path: "/repo/worktree" },
      {
        stage: agentStage({ runtime: "codex" }),
        prompt: "Run.",
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
      },
    );

    expect(result).toEqual({
      stdout: "agent stdout\n",
      stderr: "agent stderr\n",
    });
  });

  it("passes the attempt directory to real agent runtimes through output environment variables", async () => {
    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      spawn: createSuccessfulSpawn(calls),
    });

    await backend.runAgent(
      { runId: "run-agent", path: "/repo/worktree" },
      {
        stage: agentStage({
          runtime: "codex",
          outputs: ["implementation", "pr-title"],
        }),
        prompt: "Implement this.",
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/implement/1",
      },
    );

    expect(calls[0]?.options.env).toMatchObject({
      NITELY_ATTEMPT_DIR: "/repo/.nitely/runs/run-agent/stages/implement/1",
      NITELY_OUTPUT_DIR: "/repo/.nitely/runs/run-agent/stages/implement/1",
    });
  });

  it("runs Claude with configured env, command override, model args, and stdin prompt delivery", async () => {
    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      env: {
        ANTHROPIC_API_KEY: "anthropic-secret",
        NITELY_CLAUDE_COMMAND: "claude-dev",
      },
      spawn: createSuccessfulSpawn(calls),
    });

    await backend.runAgent(
      { runId: "run-agent", path: "/repo/worktree" },
      {
        stage: agentStage({
          id: "review",
          runtime: "claude",
          model: "claude-sonnet-4-5",
        }),
        prompt: "Review this.",
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/review/1",
      },
    );

    expect(calls[0]).toMatchObject({
      command: "claude-dev",
      args: ["-p", "--model", "claude-sonnet-4-5"],
      options: { cwd: "/repo/worktree", stdio: ["pipe", "pipe", "pipe"] },
      stdin: "Review this.",
    });
    expect(calls[0].options.env?.ANTHROPIC_API_KEY).toBe("anthropic-secret");
    expect(calls[0].options.env?.NITELY_CLAUDE_COMMAND).toBe("claude-dev");
  });

  it("does not pass --bare to Claude so CLAUDE.md can load", async () => {
    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      env: { ANTHROPIC_API_KEY: "anthropic-secret" },
      spawn: createSuccessfulSpawn(calls),
    });

    await backend.runAgent(
      { runId: "run-agent", path: "/repo/worktree" },
      {
        stage: agentStage({ runtime: "claude" }),
        prompt: "Review this.",
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/review/1",
      },
    );

    expect(calls[0]?.args).not.toContain("--bare");
  });

  it("runs GLM with configured env, command override, model args, and stdin prompt delivery", async () => {
    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      env: {
        ZHIPUAI_API_KEY: "glm-secret",
        NITELY_GLM_COMMAND: "glm-local",
      },
      spawn: createSuccessfulSpawn(calls),
    });

    await backend.runAgent(
      { runId: "run-agent", path: "/repo/worktree" },
      {
        stage: agentStage({ runtime: "glm", model: "glm-4.5" }),
        prompt: "Implement with GLM.",
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
      },
    );

    expect(calls[0]).toMatchObject({
      command: "glm-local",
      args: ["chat", "--model", "glm-4.5"],
      options: { cwd: "/repo/worktree", stdio: ["pipe", "pipe", "pipe"] },
      stdin: "Implement with GLM.",
    });
    expect(calls[0].options.env?.ZHIPUAI_API_KEY).toBe("glm-secret");
    expect(calls[0].options.env?.NITELY_GLM_COMMAND).toBe("glm-local");
  });

  it("fails unknown runtimes before spawning an unrelated command", async () => {
    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      spawn: createSuccessfulSpawn(calls),
    });

    await expect(
      backend.runAgent(
        { runId: "run-agent", path: "/repo/worktree" },
        {
          stage: agentStage({ runtime: "llama" }),
          prompt: "Run.",
          attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
        },
      ),
    ).rejects.toThrow(/unsupported agent runtime: llama.*codex.*claude.*glm/s);
    expect(calls).toHaveLength(0);
  });

  it("fails known runtimes when required environment is missing", async () => {
    const backend = new LocalExecutionBackend({ env: {} });

    await expect(
      backend.runAgent(
        { runId: "run-agent", path: "/repo/worktree" },
        {
          stage: agentStage({ runtime: "claude" }),
          prompt: "Run.",
          attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
        },
      ),
    ).rejects.toThrow(/agent runtime claude is not configured.*ANTHROPIC_API_KEY/s);

    await expect(
      backend.runAgent(
        { runId: "run-agent", path: "/repo/worktree" },
        {
          stage: agentStage({ runtime: "glm" }),
          prompt: "Run.",
          attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
        },
      ),
    ).rejects.toThrow(
      /agent runtime glm is not configured.*NITELY_GLM_API_KEY.*GLM_API_KEY.*ZHIPUAI_API_KEY/s,
    );
  });

  it("preflights known runtime credential requirements without spawning", async () => {
    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      env: {},
      spawn: createSuccessfulSpawn(calls),
    });

    await expect(
      backend.preflightAgentRuntime(
        { runId: "run-agent", path: "/repo/worktree" },
        {
          stage: agentStage({ runtime: "claude" }),
          attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
        },
      ),
    ).resolves.toEqual({
      available: false,
      reason: "agent runtime claude is not configured. Set ANTHROPIC_API_KEY.",
      missingConfig: ["ANTHROPIC_API_KEY"],
    });
    await expect(
      backend.preflightAgentRuntime(
        { runId: "run-agent", path: "/repo/worktree" },
        {
          stage: agentStage({ runtime: "glm" }),
          attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
        },
      ),
    ).resolves.toEqual({
      available: false,
      reason:
        "agent runtime glm is not configured. Set one of NITELY_GLM_API_KEY, GLM_API_KEY, ZHIPUAI_API_KEY.",
      missingConfig: ["NITELY_GLM_API_KEY", "GLM_API_KEY", "ZHIPUAI_API_KEY"],
    });
    await expect(
      backend.preflightAgentRuntime(
        { runId: "run-agent", path: "/repo/worktree" },
        {
          stage: agentStage({ runtime: "codex" }),
          attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
        },
      ),
    ).resolves.toEqual({ available: true });
    expect(calls).toHaveLength(0);
  });

  it("preflights unknown runtimes as unavailable without spawning", async () => {
    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      spawn: createSuccessfulSpawn(calls),
    });

    await expect(
      backend.preflightAgentRuntime(
        { runId: "run-agent", path: "/repo/worktree" },
        {
          stage: agentStage({ runtime: "llama" }),
          attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
        },
      ),
    ).resolves.toEqual({
      available: false,
      reason: expect.stringMatching(/unsupported agent runtime: llama.*codex.*claude.*glm/s),
    });
    expect(calls).toHaveLength(0);
  });

  it("reports missing runtime executables with the runtime id and command", async () => {
    const backend = new LocalExecutionBackend({
      env: { ANTHROPIC_API_KEY: "anthropic-secret" },
      spawn: createMissingExecutableSpawn("claude"),
    });

    await expect(
      backend.runAgent(
        { runId: "run-agent", path: "/repo/worktree" },
        {
          stage: agentStage({ runtime: "claude" }),
          prompt: "Run.",
          attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
        },
      ),
    ).rejects.toThrow(/unable to start agent runtime claude.*command claude/s);
  });

  it("ignores stdin EPIPE when a runtime exits successfully before reading the prompt", async () => {
    const backend = new LocalExecutionBackend({
      spawn: createEarlyStdinCloseSpawn(),
    });

    await expect(
      backend.runAgent(
        { runId: "run-agent", path: "/repo/worktree" },
        {
          stage: agentStage({ runtime: "codex" }),
          prompt: "Run.",
          attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
        },
      ),
    ).resolves.toEqual({ stdout: "", stderr: "" });
  });

  it("reports nonzero runtime exits with the runtime id and exit code", async () => {
    const backend = new LocalExecutionBackend({
      env: { ANTHROPIC_API_KEY: "anthropic-secret" },
      spawn: createNonzeroExitSpawn(7),
    });

    await expect(
      backend.runAgent(
        { runId: "run-agent", path: "/repo/worktree" },
        {
          stage: agentStage({ runtime: "claude" }),
          prompt: "Run.",
          attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
        },
      ),
    ).rejects.toThrow(/claude exited with code 7/);
  });
});
