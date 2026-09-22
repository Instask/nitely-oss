import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  LocalExecutionBackend,
  claudeAdditionalDirectories,
  claudePermissionModeForPolicy,
  codexSandboxModeForPolicy,
  createClaudePrintArgs,
  createCodexExecArgs,
  createDefaultAgentRuntimeRegistry,
  createGrokBuildArgs,
  createPiAgentArgs,
  runInputsDirectoryFromAttempt,
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
    detached?: boolean;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  };
  stdin: string;
}

function agentStage(input: {
  id?: string;
  runtime: string;
  model?: string;
  inputs?: string[];
  outputs?: string[];
  capabilities?: AgentStage["capabilities"];
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
    inputs: input.inputs ?? [],
    outputs: input.outputs ?? ["implementation"],
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
  };
}

function capabilitiesWithCommands(
  commands: NonNullable<AgentStage["capabilities"]>["commands"],
): NonNullable<AgentStage["capabilities"]> {
  return {
    read: { scope: "repository", allow: [] },
    write: { scope: "worktree", allow: [] },
    commands,
    network: { mode: "advisory", advisory: true, domains: [] },
    allowedRuntimes: [],
    allowedModels: [],
    instructions: { repo: true, generated: true, skills: true },
    evidence: {
      prompts: true,
      toolCalls: true,
      fileChanges: true,
      runtimeUsage: true,
    },
  };
}

function createSuccessfulSpawn(calls: SpawnCall[]) {
  return (
    command: string,
    args: readonly string[],
    options: {
      cwd?: string;
      stdio?: string[];
      detached?: boolean;
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

function createOutputSpawn(
  stdoutText: string,
  stderrText: string,
  exitCode = 0,
) {
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
          child.emit("close", exitCode);
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

  it("createWorkspace checks out the pinned source revision instead of mutable HEAD", async () => {
    const repo = await createRepo();
    const { stdout: sourceRevisionOutput } = await git(repo, ["rev-parse", "HEAD"]);
    const sourceRevision = sourceRevisionOutput.trim();
    await writeFile(join(repo, "README.md"), "# Changed after planning\n", "utf8");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "advance mutable head"]);

    const worktreePath = join(repo, ".nitely", "runs", "run-pinned", "worktree");
    const backend = new LocalExecutionBackend();
    await backend.createWorkspace({
      repoPath: repo,
      branchName: "nitely/run-pinned",
      runId: "run-pinned",
      worktreePath,
      sourceRevision,
    });

    await expect(readFile(join(worktreePath, "README.md"), "utf8")).resolves.toBe(
      "# Test\n",
    );
    const { stdout } = await git(worktreePath, ["rev-parse", "HEAD"]);
    expect(stdout.trim()).toBe(sourceRevision);
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

  it("cancels command process trees and prevents orphan writes", async () => {
    const repo = await createRepo();
    const marker = join(repo, "orphan-marker.txt");
    const childScript = join(repo, "child.js");
    const parentScript = join(repo, "parent.js");
    await writeFile(
      childScript,
      [
        "import { writeFileSync } from 'node:fs';",
        `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'orphan\\n'), 250);`,
        "setTimeout(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      parentScript,
      [
        "import { spawn } from 'node:child_process';",
        `spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        "setTimeout(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );
    const controller = new AbortController();
    const backend = new LocalExecutionBackend();
    const resultPromise = backend.runCommand(
      { runId: "run-cancel-command", path: repo },
      `${JSON.stringify(process.execPath)} ${JSON.stringify(parentScript)}`,
      {
        signal: controller.signal,
        cancellationGraceMs: 25,
      },
    );

    setTimeout(() => {
      controller.abort({ reason: "operator requested stop" });
    }, 30);

    const result = await resultPromise;

    expect(result.exitCode).toBe(130);
    expect(result.cancelled).toBe(true);
    expect(result.termination).toMatchObject({
      reason: "cancelled",
      signal: "SIGTERM",
      forceSignal: "SIGKILL",
    });
    expect(result.stderr).toContain("operator requested stop");
    await new Promise((resolve) => setTimeout(resolve, 400));
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });

  it("overrides inherited command output identity with runtime-owned attempt metadata", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-local-command-env-"));
    const outputDirectory = join(repo, ".nitely", "runs", "run-owned", "stages", "verify", "2");
    try {
      const backend = new LocalExecutionBackend({
        env: {
          ...process.env,
          NITELY_OUTPUT_DIR: "/inherited/output",
          NITELY_ATTEMPT_DIR: "/inherited/attempt",
          NITELY_RUN_ID: "inherited-run",
          NITELY_STAGE_ID: "inherited-stage",
          NITELY_ATTEMPT: "99",
        },
      });

      const result = await backend.runCommand(
        { runId: "workspace-run", path: repo },
        "printf '%s\\n' \"$NITELY_OUTPUT_DIR|$NITELY_ATTEMPT_DIR|$NITELY_RUN_ID|$NITELY_STAGE_ID|$NITELY_ATTEMPT\"",
        {
          outputDirectory,
          attemptDirectory: outputDirectory,
          runId: "run-owned",
          stageId: "verify",
          attempt: 2,
        },
      );

      expect(result).toEqual({
        stdout: `${outputDirectory}|${outputDirectory}|run-owned|verify|2\n`,
        stderr: "",
        exitCode: 0,
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("runs command stages with backend env and a python3 compatibility shim", async () => {
    const repo = await createRepo();
    const bin = await mkdtemp(join(tmpdir(), "nitely-local-bin-"));
    await symlink("/bin/sh", join(bin, "sh"));
    await writeFile(
      join(bin, "python3"),
      "#!/bin/sh\nprintf 'Python 3.12.0\\n'\n",
      "utf8",
    );
    await chmod(join(bin, "python3"), 0o755);
    const backend = new LocalExecutionBackend({
      env: { PATH: bin },
    });

    const result = await backend.runCommand(
      { runId: "run-python-shim", path: repo },
      "python --version",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Python 3.12.0\n");
    expect(result.stderr).toContain(
      "Nitely command environment added a python compatibility shim",
    );
    expect(result.environmentRepairs).toEqual([
      expect.objectContaining({
        id: "python-to-python3-compatibility-shim",
        scope: "outside-worktree",
      }),
    ]);
    expect(result.environmentRepairs?.[0]?.path?.startsWith(repo)).toBe(false);
    const { stdout: status } = await git(repo, ["status", "--short"]);
    expect(status).toBe("");
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

  it("uses the backend's pinned sandbox environment instead of mutable process state", () => {
    expect(createCodexExecArgs("/wt", undefined, {
      NITELY_CODEX_SANDBOX: "read-only",
    })).toEqual([
      "exec",
      "--sandbox",
      "read-only",
      "--cd",
      "/wt",
      "-",
    ]);
    expect(() => createCodexExecArgs("/wt", undefined, {
      NITELY_CODEX_SANDBOX: "forged-mode",
    })).toThrow(/unsupported Codex sandbox mode/);
  });

  it("maps explicit stage write bounds to Codex sandbox modes", () => {
    expect(codexSandboxModeForPolicy({ write: { scope: "none", allow: [] } })).toBe(
      "read-only",
    );
    expect(codexSandboxModeForPolicy({ write: { scope: "worktree", allow: ["test/"] } })).toBe(
      "workspace-write",
    );
  });

  it("applies an explicit read-only stage policy to Codex", async () => {
    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      spawn: createSuccessfulSpawn(calls),
    });
    await backend.runAgent(
      { runId: "run-agent", path: "/repo/worktree" },
      {
        stage: agentStage({
          runtime: "codex",
          capabilities: {
            ...capabilitiesWithCommands({
              mode: "none",
              allow: [],
              deny: [],
              advisory: true,
            }),
            write: { scope: "none", allow: [] },
          },
        }),
        prompt: "Review.",
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
      },
    );
    expect(calls[0]?.args).toContain("read-only");
  });

  it("fails closed for read-only stages on runtimes without local enforcement", async () => {
    const backend = new LocalExecutionBackend({
      env: { NITELY_GLM_API_KEY: "key" },
      spawn: createSuccessfulSpawn([]),
    });
    await expect(
      backend.runAgent(
        { runId: "run-agent", path: "/repo/worktree" },
        {
          stage: agentStage({
            runtime: "glm",
            capabilities: {
              ...capabilitiesWithCommands({
                mode: "none",
                allow: [],
                deny: [],
                advisory: true,
              }),
              write: { scope: "none", allow: [] },
            },
          }),
          prompt: "Review.",
          attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
        },
      ),
    ).rejects.toThrow(/has no read-only enforcement/);
  });

  it("omits the -m flag when no model is given", () => {
    expect(createCodexExecArgs("/wt")).not.toContain("-m");
  });

  it("maps write-only Claude stages to acceptEdits so -p can write the worktree", () => {
    expect(
      claudePermissionModeForPolicy({
        write: { scope: "worktree", allow: [] },
        commands: { mode: "none", allow: [], deny: [], advisory: true },
      }),
    ).toBe("acceptEdits");
  });

  it("maps Claude stages that may run commands to bypassPermissions", () => {
    expect(
      claudePermissionModeForPolicy({
        write: { scope: "worktree", allow: [] },
        commands: { mode: "unrestricted", allow: [], deny: [], advisory: true },
      }),
    ).toBe("bypassPermissions");
  });

  it("keeps read-only Claude stages on the default -p mode", () => {
    expect(
      claudePermissionModeForPolicy({
        write: { scope: "none", allow: [] },
        commands: { mode: "none", allow: [], deny: [], advisory: true },
      }),
    ).toBeUndefined();
  });

  it("refuses write:none when Claude would still be allowed to run commands", () => {
    const combinations = [
      "unrestricted",
      "allow-list",
      "deny-list",
    ] as const;
    for (const mode of combinations) {
      expect(() =>
        claudePermissionModeForPolicy({
          write: { scope: "none", allow: [] },
          commands: { mode, allow: ["pnpm test*"], deny: [], advisory: true },
        }),
      ).toThrow(
        /Claude cannot honor write scope none while commands\.mode is .+; a command can mutate the worktree/,
      );
    }
  });

  it("builds unattended Claude -p args with permission mode, extra read dirs, and model", () => {
    expect(
      createClaudePrintArgs({
        model: "claude-sonnet-4-5",
        permissionMode: "acceptEdits",
        additionalDirectories: ["/repo/.nitely/runs/run-agent/inputs"],
      }),
    ).toEqual([
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "acceptEdits",
      "--add-dir",
      "/repo/.nitely/runs/run-agent/inputs",
      "--model",
      "claude-sonnet-4-5",
    ]);
  });

  it("derives the run inputs directory from an attempt directory", () => {
    expect(
      runInputsDirectoryFromAttempt(
        "/repo/.nitely/runs/run-agent/stages/write-tests/1",
      ),
    ).toBe("/repo/.nitely/runs/run-agent/inputs");
  });

  it("exposes only the stage's declared input directories to Claude", () => {
    expect(
      claudeAdditionalDirectories({
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/write-tests/1",
        inputIds: ["spec", "tech-design"],
      }),
    ).toEqual([
      "/repo/.nitely/runs/run-agent/inputs/spec",
      "/repo/.nitely/runs/run-agent/inputs/tech-design",
    ]);
    expect(
      claudeAdditionalDirectories({
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/review/1",
        inputIds: [],
      }),
    ).toEqual([]);
  });

  it("resolves supported agent runtimes exactly after trimming", () => {
    const registry = createDefaultAgentRuntimeRegistry();

    expect(registry.resolve(" codex ")).toMatchObject({
      id: "codex",
      networkAccess: "required",
    });
    expect(registry.resolve("claude")).toMatchObject({
      id: "claude",
      networkAccess: "required",
    });
    expect(registry.resolve("glm")).toMatchObject({
      id: "glm",
      networkAccess: "required",
    });
    expect(registry.resolve("grok")).toMatchObject({
      id: "grok",
      networkAccess: "required",
    });
    expect(registry.resolve("pi")).toMatchObject({
      id: "pi",
      networkAccess: "required",
    });
    expect(() => registry.resolve("Codex")).toThrow(
      /unsupported agent runtime: Codex.*codex.*claude.*glm.*grok.*pi/s,
    );
  });

  it("fails closed when a stage demands command mediation the local backend cannot provide", async () => {
    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      spawn: createSuccessfulSpawn(calls),
    });

    await expect(
      backend.runAgent(
        { runId: "run-agent", path: "/repo/worktree" },
        {
          stage: agentStage({
            runtime: "codex",
            capabilities: capabilitiesWithCommands({
              mode: "allow-list",
              allow: ["pnpm test*"],
              deny: [],
              advisory: false,
            }),
          }),
          prompt: "Implement this.",
          attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
        },
      ),
    ).rejects.toThrow(
      /the local execution backend has no mechanism that mediates the commands an agent spawns inside it/,
    );
    expect(calls).toHaveLength(0);
  });

  it("runs a stage whose command policy is advisory", async () => {
    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      spawn: createSuccessfulSpawn(calls),
    });

    await backend.runAgent(
      { runId: "run-agent", path: "/repo/worktree" },
      {
        stage: agentStage({
          runtime: "codex",
          capabilities: capabilitiesWithCommands({
            mode: "allow-list",
            allow: ["pnpm test*"],
            deny: [],
            advisory: true,
          }),
        }),
        prompt: "Implement this.",
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
      },
    );

    expect(calls).toHaveLength(1);
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
      args: [
        "exec",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-5.3-codex-spark",
        "--json",
        "--cd",
        "/repo/worktree",
        "-",
      ],
      options: { cwd: "/repo/worktree", stdio: ["pipe", "pipe", "pipe"] },
      stdin: "Implement this.",
    });
  });

  it("points Codex at an isolated CODEX_HOME that carries only auth and config", async () => {
    const operatorHome = await mkdtemp(join(tmpdir(), "nitely-codex-home-"));
    await writeFile(join(operatorHome, "auth.json"), "{}\n", "utf8");
    await writeFile(join(operatorHome, "config.toml"), "model = \"x\"\n", "utf8");
    await mkdir(join(operatorHome, "superpowers", "skills"), { recursive: true });
    await writeFile(
      join(operatorHome, "superpowers", "skills", "SKILL.md"), "global\n", "utf8",
    );
    await mkdir(join(operatorHome, "plugins"), { recursive: true });
    const isolatedHome = join(
      await mkdtemp(join(tmpdir(), "nitely-isolated-home-")),
      "codex",
    );

    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      env: { CODEX_HOME: operatorHome, PATH: "/usr/bin" },
      spawn: createSuccessfulSpawn(calls),
    });

    const result = await backend.runAgent(
      { runId: "run-agent", path: "/repo/worktree" },
      {
        stage: agentStage({ runtime: "codex" }),
        prompt: "Implement this.",
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
        globalSkills: { mode: "required-isolated", homeDirectory: isolatedHome },
      },
    );

    expect(result.globalSkills).toEqual({ isolated: true });
    expect(calls[0]?.options.env?.CODEX_HOME).toBe(isolatedHome);
    expect((await readdir(isolatedHome)).sort()).toEqual([
      "auth.json",
      "config.toml",
    ]);
    await expect(
      readFile(join(isolatedHome, "auth.json"), "utf8"),
    ).resolves.toBe("{}\n");
  });

  it("relinks the isolated home without discarding runtime session state", async () => {
    const operatorHome = await mkdtemp(join(tmpdir(), "nitely-codex-home-"));
    await writeFile(join(operatorHome, "auth.json"), "{}\n", "utf8");
    await writeFile(join(operatorHome, "dropped.toml"), "gone\n", "utf8");
    const isolatedHome = join(
      await mkdtemp(join(tmpdir(), "nitely-isolated-home-")),
      "codex",
    );
    await mkdir(isolatedHome, { recursive: true });
    // A link from an earlier attempt to something no longer preserved.
    await symlink(join(operatorHome, "dropped.toml"), join(isolatedHome, "dropped.toml"));
    // State the runtime wrote itself, which a later attempt resumes from.
    await mkdir(join(isolatedHome, "sessions"), { recursive: true });
    await writeFile(join(isolatedHome, "sessions", "thread.json"), "{}\n", "utf8");

    const backend = new LocalExecutionBackend({
      env: { CODEX_HOME: operatorHome, PATH: "/usr/bin" },
      spawn: createSuccessfulSpawn([]),
    });

    await backend.runAgent(
      { runId: "run-agent", path: "/repo/worktree" },
      {
        stage: agentStage({ runtime: "codex" }),
        prompt: "Implement this.",
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
        globalSkills: { mode: "required-isolated", homeDirectory: isolatedHome },
      },
    );

    expect((await readdir(isolatedHome)).sort()).toEqual(["auth.json", "sessions"]);
    await expect(
      readFile(join(isolatedHome, "sessions", "thread.json"), "utf8"),
    ).resolves.toBe("{}\n");
  });

  it("leaves the runtime home alone when the flow inherits global skills", async () => {
    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      env: { CODEX_HOME: "/home/operator/.codex", PATH: "/usr/bin" },
      spawn: createSuccessfulSpawn(calls),
    });

    const result = await backend.runAgent(
      { runId: "run-agent", path: "/repo/worktree" },
      {
        stage: agentStage({ runtime: "codex" }),
        prompt: "Implement this.",
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
        globalSkills: { mode: "inherited" },
      },
    );

    expect(result.globalSkills).toEqual({
      isolated: false,
      reason: "flow opted into the operator's global skills",
    });
    expect(calls[0]?.options.env?.CODEX_HOME).toBe("/home/operator/.codex");
  });

  it("fails closed when a runtime without an isolation mechanism must isolate", async () => {
    const backend = new LocalExecutionBackend({
      env: { ANTHROPIC_API_KEY: "key", PATH: "/usr/bin" },
      spawn: createSuccessfulSpawn([]),
    });

    await expect(
      backend.runAgent(
        { runId: "run-agent", path: "/repo/worktree" },
        {
          stage: agentStage({ runtime: "claude" }),
          prompt: "Implement this.",
          attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
          globalSkills: {
            mode: "required-isolated",
            homeDirectory: "/tmp/unused-isolated-home",
          },
        },
      ),
    ).rejects.toThrow(
      /requires isolated global skills but agent runtime claude has no global skill isolation mechanism/,
    );
  });

  it("runs a runtime without an isolation mechanism when isolation is only preferred", async () => {
    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      env: { ANTHROPIC_API_KEY: "key", PATH: "/usr/bin" },
      spawn: createSuccessfulSpawn(calls),
    });

    const result = await backend.runAgent(
      { runId: "run-agent", path: "/repo/worktree" },
      {
        stage: agentStage({ runtime: "claude" }),
        prompt: "Implement this.",
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
        globalSkills: {
          mode: "isolate-if-supported",
          homeDirectory: "/tmp/unused-isolated-home",
        },
      },
    );

    expect(result.globalSkills).toEqual({
      isolated: false,
      reason: "agent runtime claude has no global skill isolation mechanism",
    });
    expect(calls).toHaveLength(1);
  });

  it("reports the Codex session id so the next execution can continue it", async () => {
    const threadId = "019bffff-1111-7111-8111-111111111111";
    const backend = new LocalExecutionBackend({
      spawn: createOutputSpawn(
        [
          `{"type":"thread.started","thread_id":"${threadId}"}`,
          '{"type":"turn.started"}',
          '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}',
          "",
        ].join("\n"),
        "",
      ),
    });

    const result = await backend.runAgent(
      { runId: "run-agent", path: "/repo/worktree" },
      {
        stage: agentStage({ runtime: "codex" }),
        prompt: "Implement this.",
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
      },
    );

    expect(result.session).toEqual({ mode: "cold", sessionId: threadId });
  });

  it("resumes a Codex session instead of starting a cold one", async () => {
    const threadId = "019bffff-1111-7111-8111-111111111111";
    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      spawn: createSuccessfulSpawn(calls),
    });

    const result = await backend.runAgent(
      { runId: "run-agent", path: "/repo/worktree" },
      {
        stage: agentStage({ runtime: "codex", model: "gpt-5.3-codex-spark" }),
        prompt: "Next task.",
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/2",
        session: { resumeSessionId: threadId },
      },
    );

    expect(calls[0]).toMatchObject({
      command: "codex",
      // resume inherits sandbox and working directory from the session it
      // continues, and rejects --sandbox and --cd.
      args: ["exec", "resume", threadId, "-m", "gpt-5.3-codex-spark", "--json", "-"],
      stdin: "Next task.",
    });
    expect(result.session).toMatchObject({ mode: "resumed", sessionId: threadId });
  });

  it("starts cold and says why when the runtime cannot resume a session", async () => {
    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      env: { ANTHROPIC_API_KEY: "key", PATH: "/usr/bin" },
      spawn: createSuccessfulSpawn(calls),
    });

    const result = await backend.runAgent(
      { runId: "run-agent", path: "/repo/worktree" },
      {
        stage: agentStage({ runtime: "claude" }),
        prompt: "Next task.",
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/2",
        session: { resumeSessionId: "019bffff-1111-7111-8111-111111111111" },
      },
    );

    expect(result.session).toEqual({
      mode: "cold",
      reason: "agent runtime claude cannot resume a previous session",
    });
    expect(calls[0]?.args).not.toContain("resume");
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

  it("fails closed when a local stage requires a byte-level read bound", async () => {
    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      spawn: createSuccessfulSpawn(calls),
    });

    await expect(
      backend.runAgent(
        { runId: "read-bound", path: "/repo/worktree" },
        {
          stage: agentStage({ runtime: "codex" }),
          prompt: "Review.",
          attemptDirectory: "/repo/.nitely/runs/read-bound/stages/agent/1",
          readPolicy: {
            maxFileBytes: 1024,
            deny: [],
            enforcement: "required",
          },
        },
      ),
    ).rejects.toThrow(/no execution backend enforces a byte-level read bound/);
    expect(calls).toHaveLength(0);
  });

  it("streams agent stdout and stderr into attempt log files while running", async () => {
    const attemptDirectory = await mkdtemp(join(tmpdir(), "nitely-stream-logs-"));
    const seen: string[] = [];
    const backend = new LocalExecutionBackend({
      spawn: () => {
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
            queueMicrotask(async () => {
              child.stdout.write("line-1\n");
              await new Promise((resolve) => setTimeout(resolve, 20));
              seen.push(await readFile(join(attemptDirectory, "stdout.log"), "utf8"));
              child.stdout.write("line-2\n");
              child.stderr.write("warn\n");
              await new Promise((resolve) => setTimeout(resolve, 20));
              seen.push(await readFile(join(attemptDirectory, "stdout.log"), "utf8"));
              seen.push(await readFile(join(attemptDirectory, "stderr.log"), "utf8"));
              child.stdout.end();
              child.stderr.end();
              child.emit("close", 0);
            });
            callback();
          },
        });
        return child;
      },
    });

    const result = await backend.runAgent(
      { runId: "run-agent", path: "/repo/worktree" },
      {
        stage: agentStage({ runtime: "codex" }),
        prompt: "Run.",
        attemptDirectory,
      },
    );

    expect(result).toEqual({
      stdout: "line-1\nline-2\n",
      stderr: "warn\n",
    });
    expect(seen[0]).toBe("line-1\n");
    expect(seen[1]).toBe("line-1\nline-2\n");
    expect(seen[2]).toBe("warn\n");
    expect(await readFile(join(attemptDirectory, "stdout.log"), "utf8")).toBe(
      "line-1\nline-2\n",
    );
    expect(await readFile(join(attemptDirectory, "stderr.log"), "utf8")).toBe(
      "warn\n",
    );
    await rm(attemptDirectory, { recursive: true, force: true });
  });

  it("streams command stdout into attempt log files while running", async () => {
    const attemptDirectory = await mkdtemp(join(tmpdir(), "nitely-cmd-stream-"));
    const backend = new LocalExecutionBackend();
    const result = await backend.runCommand(
      { runId: "run-cmd", path: process.cwd() },
      "printf 'a\\n'; sleep 0.05; printf 'b\\n'",
      { attemptDirectory },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a\nb\n");
    expect(await readFile(join(attemptDirectory, "stdout.log"), "utf8")).toBe(
      "a\nb\n",
    );
    await rm(attemptDirectory, { recursive: true, force: true });
  });

  it("derives provider-reported Codex token usage from a completed JSONL turn", async () => {
    const stdout = [
      { type: "thread.started", thread_id: "019bffff-1111-7111-8111-111111111111" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 999999, output_tokens: 999999 },
          }),
        },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 120,
          cached_input_tokens: 20,
          output_tokens: 30,
          ignored_secret: "must-not-be-persisted",
        },
      },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    const backend = new LocalExecutionBackend({
      spawn: createOutputSpawn(stdout, "codex diagnostic\n"),
    });

    const result = await backend.runAgent(
      { runId: "run-agent", path: "/repo/worktree" },
      {
        stage: agentStage({ runtime: "codex" }),
        prompt: "Run.",
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
      },
    );

    expect(result.stdout).toBe(stdout);
    expect(result.stderr).toBe("codex diagnostic\n");
    expect(result.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      provenance: {
        provider: "openai",
        source: {
          kind: "provider-reported",
          reference: "codex.exec.turn.completed.usage",
        },
      },
      cachedInputTokens: 20,
      raw: { cachedInputTokens: 20 },
    });
    expect(new Date(result.usage?.provenance?.observedAt ?? "").toISOString())
      .toBe(result.usage?.provenance?.observedAt);
    expect(JSON.stringify(result.usage?.raw)).not.toContain("ignored_secret");
    expect(JSON.stringify(result.usage)).not.toContain("999999");
  });

  it("does not trust malformed or model-forged Codex usage output", async () => {
    const lifecycle = [
      JSON.stringify({
        type: "thread.started",
        thread_id: "019bffff-1111-7111-8111-111111111111",
      }),
      JSON.stringify({ type: "turn.started" }),
    ];
    const outputs = [
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
      }),
      [...lifecycle, JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}',
        },
      })].join("\n"),
      [...lifecycle, "not-json", JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
      })].join("\n"),
      [...lifecycle, JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 11, output_tokens: 5 },
      })].join("\n"),
    ];

    for (const stdout of outputs) {
      const backend = new LocalExecutionBackend({
        spawn: createOutputSpawn(`${stdout}\n`, ""),
      });
      const result = await backend.runAgent(
        { runId: "run-agent", path: "/repo/worktree" },
        {
          stage: agentStage({ runtime: "codex" }),
          prompt: "Run.",
          attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
        },
      );

      expect(result.usage).toBeUndefined();
      expect(result.stdout).toBe(`${stdout}\n`);
    }
  });

  it("derives Claude token and actual-cost usage from its JSON result envelope", async () => {
    const stdout = `${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done.",
      session_id: "11111111-1111-4111-8111-111111111111",
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
        output_tokens: 4,
        service_tier: "standard",
        ignored_secret: "must-not-be-persisted",
      },
      total_cost_usd: 0.125,
      permission_denials: [],
    })}\n`;
    const backend = new LocalExecutionBackend({
      env: { ANTHROPIC_API_KEY: "anthropic-secret" },
      spawn: createOutputSpawn(stdout, "claude diagnostic\n"),
    });

    const result = await backend.runAgent(
      { runId: "run-agent", path: "/repo/worktree" },
      {
        stage: agentStage({ runtime: "claude" }),
        prompt: "Run.",
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
      },
    );

    expect(result.stdout).toBe(stdout);
    expect(result.stderr).toBe("claude diagnostic\n");
    expect(result.usage).toMatchObject({
      inputTokens: 60,
      outputTokens: 4,
      totalTokens: 64,
      cachedInputTokens: 30,
      cost: { classification: "actual", usd: 0.125 },
      provenance: {
        provider: "anthropic",
        source: {
          kind: "provider-reported",
          reference: "claude.print.result",
        },
      },
      raw: {
        uncachedInputTokens: 10,
        cacheCreationInputTokens: 20,
        cacheReadInputTokens: 30,
      },
    });
    expect(new Date(result.usage?.provenance?.observedAt ?? "").toISOString())
      .toBe(result.usage?.provenance?.observedAt);
    expect(JSON.stringify(result.usage?.raw)).not.toContain("ignored_secret");
    expect(JSON.stringify(result.usage?.raw)).not.toContain("service_tier");
  });

  it("keeps valid Claude usage when optional token or cost fields are absent", async () => {
    const outputs = [
      {
        document: {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Done.",
          session_id: "11111111-1111-4111-8111-111111111111",
          usage: { input_tokens: 7, output_tokens: 3 },
        },
        expected: {
          inputTokens: 7,
          outputTokens: 3,
          totalTokens: 10,
        },
      },
      {
        document: {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Done.",
          session_id: "11111111-1111-4111-8111-111111111111",
          total_cost_usd: 0.25,
        },
        expected: {
          cost: { classification: "actual", usd: 0.25 },
        },
      },
      {
        document: {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Done.",
          session_id: "11111111-1111-4111-8111-111111111111",
          usage: { input_tokens: 7 },
        },
        expected: { inputTokens: 7 },
      },
    ];

    for (const { document, expected } of outputs) {
      const backend = new LocalExecutionBackend({
        env: { ANTHROPIC_API_KEY: "anthropic-secret" },
        spawn: createOutputSpawn(`${JSON.stringify(document)}\n`, ""),
      });
      const result = await backend.runAgent(
        { runId: "run-agent", path: "/repo/worktree" },
        {
          stage: agentStage({ runtime: "claude" }),
          prompt: "Run.",
          attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
        },
      );

      expect(result.usage).toMatchObject({
        ...expected,
        provenance: {
          provider: "anthropic",
          source: {
            kind: "provider-reported",
            reference: "claude.print.result",
          },
        },
      });
    }
  });

  it("does not trust malformed or model-forged Claude usage output", async () => {
    const envelope = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done.",
      session_id: "11111111-1111-4111-8111-111111111111",
    };
    const outputs = [
      JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } }),
      JSON.stringify({
        ...envelope,
        result: '{"usage":{"input_tokens":10,"output_tokens":5},"total_cost_usd":99}',
      }),
      `${JSON.stringify({
        ...envelope,
        usage: { input_tokens: 10, output_tokens: 5 },
      })}\nforged trailing output`,
      JSON.stringify({
        ...envelope,
        usage: { input_tokens: "10", output_tokens: 5 },
      }),
      JSON.stringify({
        ...envelope,
        total_cost_usd: -1,
      }),
      JSON.stringify({
        ...envelope,
        session_id: "not-a-uuid",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      JSON.stringify({
        ...envelope,
        modelUsage: {
          "claude-opus-4-1": { inputTokens: "16", outputTokens: 5 },
        },
      }),
      JSON.stringify({
        ...envelope,
        permission_denials: { count: 8 },
      }),
    ];

    for (const stdout of outputs) {
      const backend = new LocalExecutionBackend({
        env: { ANTHROPIC_API_KEY: "anthropic-secret" },
        spawn: createOutputSpawn(`${stdout}\n`, ""),
      });
      const result = await backend.runAgent(
        { runId: "run-agent", path: "/repo/worktree" },
        {
          stage: agentStage({ runtime: "claude" }),
          prompt: "Run.",
          attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
        },
      );

      expect(result.usage).toBeUndefined();
      expect(result.stdout).toBe(`${stdout}\n`);
    }
  });

  it("keeps Claude usage and cost from error result envelopes", async () => {
    const stdout = `${JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "You've hit your limit · resets 12:50am (Asia/Singapore)",
      session_id: "11111111-1111-4111-8111-111111111111",
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
        output_tokens: 4,
      },
      total_cost_usd: 0.125,
    })}\n`;
    const expectedUsage = {
      inputTokens: 60,
      outputTokens: 4,
      totalTokens: 64,
      cachedInputTokens: 30,
      cost: { classification: "actual", usd: 0.125 },
      provenance: {
        provider: "anthropic",
        source: {
          kind: "provider-reported",
          reference: "claude.print.result",
        },
      },
      raw: {
        uncachedInputTokens: 10,
        cacheCreationInputTokens: 20,
        cacheReadInputTokens: 30,
      },
    };

    for (const exitCode of [0, 1]) {
      const backend = new LocalExecutionBackend({
        env: { ANTHROPIC_API_KEY: "anthropic-secret" },
        spawn: createOutputSpawn(stdout, "", exitCode),
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
      ).rejects.toMatchObject({
        stdout,
        usage: expectedUsage,
      });
    }
  });

  it("pins dogfood run 2026-09-08T121859874Z-159dd9aa provider totals from modelUsage", async () => {
    const stdout = `${JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "You've hit your limit · resets 12:50am (Asia/Singapore)",
      session_id: "11111111-1111-4111-8111-111111111111",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 200,
        output_tokens: 3,
      },
      modelUsage: {
        "claude-opus-4-1-20250805": {
          inputTokens: 16,
          cacheCreationInputTokens: 83223,
          cacheReadInputTokens: 633975,
          outputTokens: 51918,
          costUSD: 2.13,
        },
        "claude-haiku-3-5-20241022": {
          inputTokens: 47,
          cacheCreationInputTokens: 46292,
          cacheReadInputTokens: 260373,
          outputTokens: 4397,
          costUSD: 0.11109555,
        },
      },
      total_cost_usd: 2.24109555,
      permission_denials: Array.from({ length: 8 }, (_, index) => ({
        tool_name: index < 2 ? "Read" : index < 5 ? "Edit" : "Write",
      })),
    })}\n`;
    const backend = new LocalExecutionBackend({
      env: { ANTHROPIC_API_KEY: "anthropic-secret" },
      spawn: createOutputSpawn(stdout, "", 0),
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
    ).rejects.toMatchObject({
      stdout,
      usage: {
        inputTokens: 1_023_926,
        outputTokens: 56_315,
        totalTokens: 1_080_241,
        cachedInputTokens: 894_348,
        cost: { classification: "actual", usd: 2.24109555 },
        provenance: {
          provider: "anthropic",
          source: {
            kind: "provider-reported",
            reference: "claude.print.result",
          },
        },
        raw: {
          uncachedInputTokens: 63,
          cacheCreationInputTokens: 129_515,
          cacheReadInputTokens: 894_348,
          permissionDenialCount: 8,
        },
      },
    });
  });

  it("times out agent runtime sessions", async () => {
    const calls: SpawnCall[] = [];
    const killed: Array<NodeJS.Signals | undefined> = [];
    const backend = new LocalExecutionBackend({
      spawn: (command, args, options) => {
        const child = new EventEmitter() as EventEmitter & {
          stdin: Writable;
          stdout: PassThrough;
          stderr: PassThrough;
          kill: (signal?: NodeJS.Signals) => boolean;
        };
        const call: SpawnCall = {
          command,
          args: [...args],
          options,
          stdin: "",
        };
        calls.push(call);
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = (signal?: NodeJS.Signals) => {
          killed.push(signal);
          queueMicrotask(() => child.emit("close", null));
          return true;
        };
        child.stdin = new Writable({
          write(chunk, _encoding, callback) {
            call.stdin += chunk.toString();
            callback();
          },
          final(callback) {
            callback();
          },
        });
        return child;
      },
    });

    await expect(
      backend.runAgent(
        { runId: "run-agent", path: "/repo/worktree" },
        {
          stage: agentStage({ runtime: "codex" }),
          prompt: "Run.",
          attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
          timeoutMs: 10,
        },
      ),
    ).rejects.toThrow(/agent session timed out after 10ms/);

    expect(calls[0]).toMatchObject({
      options: { detached: true },
      stdin: "Run.",
    });
    expect(killed).toContain("SIGTERM");
  });

  it("cancels agent runtime sessions with a bounded force-kill fallback", async () => {
    const calls: SpawnCall[] = [];
    const killed: Array<NodeJS.Signals | undefined> = [];
    const controller = new AbortController();
    const backend = new LocalExecutionBackend({
      spawn: (command, args, options) => {
        const child = new EventEmitter() as EventEmitter & {
          stdin: Writable;
          stdout: PassThrough;
          stderr: PassThrough;
          kill: (signal?: NodeJS.Signals) => boolean;
        };
        const call: SpawnCall = {
          command,
          args: [...args],
          options,
          stdin: "",
        };
        calls.push(call);
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = (signal?: NodeJS.Signals) => {
          killed.push(signal);
          if (signal === "SIGKILL") {
            queueMicrotask(() => child.emit("close", null));
          }
          return true;
        };
        child.stdin = new Writable({
          write(chunk, _encoding, callback) {
            call.stdin += chunk.toString();
            callback();
          },
          final(callback) {
            callback();
          },
        });
        return child;
      },
    });

    const execution = backend.runAgent(
      { runId: "run-agent-cancel", path: "/repo/worktree" },
      {
        stage: agentStage({ runtime: "codex" }),
        prompt: "Run.",
        attemptDirectory: "/repo/.nitely/runs/run-agent-cancel/stages/agent/1",
        signal: controller.signal,
        cancellationGraceMs: 1,
      },
    );
    setTimeout(() => {
      controller.abort({ reason: "operator requested stop" });
    }, 0);

    await expect(execution).rejects.toMatchObject({
      cancelled: true,
      termination: expect.objectContaining({
        reason: "cancelled",
        signal: "SIGTERM",
        forceSignal: "SIGKILL",
      }),
    });
    expect(calls[0]).toMatchObject({
      options: { detached: true },
      stdin: "Run.",
    });
    expect(killed).toContain("SIGTERM");
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
      args: [
        "-p",
        "--output-format",
        "json",
        "--permission-mode",
        "bypassPermissions",
        "--model",
        "claude-sonnet-4-5",
      ],
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

  it("launches Claude write-tests stages with acceptEdits so worktree writes are not denied", async () => {
    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      env: { ANTHROPIC_API_KEY: "anthropic-secret" },
      spawn: createSuccessfulSpawn(calls),
    });

    await backend.runAgent(
      { runId: "run-agent", path: "/repo/worktree" },
      {
        stage: agentStage({
          id: "write-tests",
          runtime: "claude",
          inputs: ["spec", "tech-design"],
          capabilities: capabilitiesWithCommands({
            mode: "none",
            allow: [],
            deny: [],
            advisory: true,
          }),
        }),
        prompt: "Write the tests.",
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/write-tests/1",
      },
    );

    expect(calls[0]?.args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "acceptEdits",
      "--add-dir",
      "/repo/.nitely/runs/run-agent/inputs/spec",
      "--add-dir",
      "/repo/.nitely/runs/run-agent/inputs/tech-design",
    ]);
    expect(calls[0]?.args).not.toContain("/repo/.nitely/runs/run-agent/inputs");
  });

  it("launches implicit Claude agent stages with bypassPermissions, matching Grok --always-approve", async () => {
    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      env: { ANTHROPIC_API_KEY: "anthropic-secret" },
      spawn: createSuccessfulSpawn(calls),
    });

    await backend.runAgent(
      { runId: "run-agent", path: "/repo/worktree" },
      {
        stage: agentStage({ runtime: "claude" }),
        prompt: "Implement this.",
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/implement/1",
      },
    );

    expect(calls[0]?.args).toContain("--permission-mode");
    expect(calls[0]?.args).toContain("bypassPermissions");
  });

  it("does not bypass Claude permissions on an explicit read-only stage", async () => {
    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      env: { ANTHROPIC_API_KEY: "anthropic-secret" },
      spawn: createSuccessfulSpawn(calls),
    });

    await backend.runAgent(
      { runId: "run-agent", path: "/repo/worktree" },
      {
        stage: agentStage({
          id: "review",
          runtime: "claude",
          capabilities: {
            read: { scope: "repository", allow: [] },
            write: { scope: "none", allow: [] },
            commands: { mode: "none", allow: [], deny: [], advisory: true },
            network: { mode: "advisory", advisory: true, domains: [] },
            allowedRuntimes: [],
            allowedModels: [],
            instructions: { repo: true, generated: true, skills: true },
            evidence: {
              prompts: true,
              toolCalls: true,
              fileChanges: true,
              runtimeUsage: true,
            },
          },
        }),
        prompt: "Review this.",
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/review/1",
      },
    );

    expect(calls[0]?.args).not.toContain("--permission-mode");
    expect(calls[0]?.args).not.toContain("--add-dir");
  });

  it("fails closed when a Claude stage forbids writes but still allows commands", async () => {
    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      env: { ANTHROPIC_API_KEY: "anthropic-secret" },
      spawn: createSuccessfulSpawn(calls),
    });

    await expect(
      backend.runAgent(
        { runId: "run-agent", path: "/repo/worktree" },
        {
          stage: agentStage({
            id: "review",
            runtime: "claude",
            capabilities: {
              read: { scope: "repository", allow: [] },
              write: { scope: "none", allow: [] },
              commands: {
                mode: "unrestricted",
                allow: [],
                deny: [],
                advisory: true,
              },
              network: { mode: "advisory", advisory: true, domains: [] },
              allowedRuntimes: [],
              allowedModels: [],
              instructions: { repo: true, generated: true, skills: true },
              evidence: {
                prompts: true,
                toolCalls: true,
                fileChanges: true,
                runtimeUsage: true,
              },
            },
          }),
          prompt: "Review this.",
          attemptDirectory: "/repo/.nitely/runs/run-agent/stages/review/1",
        },
      ),
    ).rejects.toThrow(
      /stage review: Claude cannot honor write scope none while commands\.mode is unrestricted/,
    );
    expect(calls).toHaveLength(0);
  });

  it("does not apply the Claude write/command conflict to other runtimes", async () => {
    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      spawn: createSuccessfulSpawn(calls),
    });

    await backend.runAgent(
      { runId: "run-agent", path: "/repo/worktree" },
      {
        stage: agentStage({
          runtime: "codex",
          capabilities: {
            read: { scope: "repository", allow: [] },
            write: { scope: "none", allow: [] },
            commands: {
              mode: "unrestricted",
              allow: [],
              deny: [],
              advisory: true,
            },
            network: { mode: "advisory", advisory: true, domains: [] },
            allowedRuntimes: [],
            allowedModels: [],
            instructions: { repo: true, generated: true, skills: true },
            evidence: {
              prompts: true,
              toolCalls: true,
              fileChanges: true,
              runtimeUsage: true,
            },
          },
        }),
        prompt: "Review this.",
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/review/1",
      },
    );

    expect(calls).toHaveLength(1);
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

  it("runs Grok Build with prompt argument delivery", async () => {
    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      env: { NITELY_GROK_COMMAND: "grok-dev" },
      spawn: createSuccessfulSpawn(calls),
    });

    await backend.runAgent(
      { runId: "run-agent", path: "/repo/worktree" },
      {
        stage: agentStage({ runtime: "grok", model: "grok-4.5" }),
        prompt: "Implement with Grok.",
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
      },
    );

    expect(calls[0]).toMatchObject({
      command: "grok-dev",
      args: createGrokBuildArgs(
        "/repo/worktree",
        "Implement with Grok.",
        "grok-4.5",
      ),
      options: { cwd: "/repo/worktree", stdio: ["pipe", "pipe", "pipe"] },
      stdin: "",
    });
    expect(calls[0].options.env?.NITELY_GROK_COMMAND).toBe("grok-dev");
  });

  it("runs Pi Agent with stdin prompt delivery", async () => {
    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      env: { NITELY_PI_COMMAND: "pi-dev" },
      spawn: createSuccessfulSpawn(calls),
    });

    await backend.runAgent(
      { runId: "run-agent", path: "/repo/worktree" },
      {
        stage: agentStage({ runtime: "pi", model: "openai/gpt-4o" }),
        prompt: "Implement with Pi.",
        attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
      },
    );

    expect(calls[0]).toMatchObject({
      command: "pi-dev",
      args: createPiAgentArgs("openai/gpt-4o"),
      options: { cwd: "/repo/worktree", stdio: ["pipe", "pipe", "pipe"] },
      stdin: "Implement with Pi.",
    });
    expect(calls[0].options.env?.NITELY_PI_COMMAND).toBe("pi-dev");
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
    ).rejects.toThrow(
      /unsupported agent runtime: llama.*codex.*claude.*glm.*grok.*pi/s,
    );
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

  it("treats a Claude subscription OAuth token as a configured claude runtime", async () => {
    const calls: SpawnCall[] = [];
    const backend = new LocalExecutionBackend({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-subscription" },
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
    ).resolves.toMatchObject({ available: true });
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
      reason:
        "agent runtime claude is not configured. Set one of ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN.",
      missingConfig: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
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
    await expect(
      backend.preflightAgentRuntime(
        { runId: "run-agent", path: "/repo/worktree" },
        {
          stage: agentStage({ runtime: "grok" }),
          attemptDirectory: "/repo/.nitely/runs/run-agent/stages/agent/1",
        },
      ),
    ).resolves.toEqual({ available: true });
    await expect(
      backend.preflightAgentRuntime(
        { runId: "run-agent", path: "/repo/worktree" },
        {
          stage: agentStage({ runtime: "pi" }),
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
      reason: expect.stringMatching(
        /unsupported agent runtime: llama.*codex.*claude.*glm.*grok.*pi/s,
      ),
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
