import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  OciExecutionBackend,
  reapExpiredOciContainers,
  type OciExecutionBackendOptions,
  type SandboxProcessInput,
  type SandboxProcessResult,
} from "../../../src/run/execution/oci.js";
import type { Stage } from "../../../src/flow/schema.js";
import { createExecutionBackend } from "../../../src/run/execution/backend.js";
import type {
  AgentRuntimeLauncher,
  AgentRuntimeRegistry,
} from "../../../src/run/execution/local.js";

type AgentStage = Extract<Stage, { type: "agent" }>;
const execFileAsync = promisify(execFile);

interface Fixture {
  runRoot: string;
  worktree: string;
  attempt: string;
}

async function createFixture(): Promise<Fixture> {
  const runRoot = await mkdtemp(join(tmpdir(), "nitely-oci-run-"));
  const worktree = join(runRoot, "worktree");
  const attempt = join(runRoot, "stages", "verify", "1");
  await mkdir(worktree, { recursive: true });
  await mkdir(attempt, { recursive: true });
  return { runRoot, worktree, attempt };
}

async function createGitRepository(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "nitely-oci-git-"));
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "nitely@example.test"], {
    cwd: repo,
  });
  await execFileAsync("git", ["config", "user.name", "Nitely Test"], {
    cwd: repo,
  });
  await writeFile(join(repo, "README.md"), "# fixture\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });
  return repo;
}

function successfulRunner(calls: SandboxProcessInput[]) {
  return async (input: SandboxProcessInput): Promise<SandboxProcessResult> => {
    calls.push(input);
    if (input.args[0] === "info") {
      return {
        stdout: '["name=seccomp,profile=builtin","name=rootless"]\t"2"\tnull\n',
        stderr: "",
        exitCode: 0,
      };
    }
    if (input.args[0] === "rm") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return { stdout: "ok\n", stderr: "", exitCode: 0 };
  };
}

function offlineRuntimeRegistry(input: {
  id?: string;
  requiredEnv?: string[][];
} = {}): AgentRuntimeRegistry {
  const id = input.id ?? "codex";
  const runtime: AgentRuntimeLauncher = {
    id,
    networkAccess: "none",
    ...(input.requiredEnv ? { requiredEnv: input.requiredEnv } : {}),
    build: ({ worktreePath }) => ({
      runtime: id,
      command: id,
      args: id === "codex" ? ["exec", "--cd", worktreePath, "-"] : [],
      promptDelivery: "stdin",
    }),
  };
  return {
    supportedIds: () => [id],
    resolve: (candidate) => {
      if (candidate !== id) {
        throw new Error(`unsupported agent runtime: ${candidate}`);
      }
      return runtime;
    },
  };
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function agentStage(
  capabilities?: AgentStage["capabilities"],
): AgentStage {
  return {
    id: "implement",
    type: "agent",
    runtime: "codex",
    prompt: "Implement.",
    inputs: [],
    outputs: ["implementation"],
    skills: [],
    required_mcp_servers: [],
    required_connectors: [],
    ...(capabilities ? { capabilities } : {}),
  };
}

function sandboxCapabilities(
  overrides: Partial<NonNullable<AgentStage["capabilities"]>> = {},
): NonNullable<AgentStage["capabilities"]> {
  return {
    read: { scope: "repository", allow: [] },
    write: { scope: "worktree", allow: [] },
    commands: { mode: "unrestricted", allow: [], deny: [], advisory: false },
    network: { mode: "disabled", advisory: false, domains: [] },
    allowedRuntimes: ["codex"],
    allowedModels: [],
    instructions: { repo: true, generated: true, skills: true },
    evidence: {
      prompts: true,
      toolCalls: true,
      fileChanges: true,
      runtimeUsage: true,
    },
    ...overrides,
  };
}

function networkRequiredRuntimeRegistry(): AgentRuntimeRegistry {
  const runtime: AgentRuntimeLauncher = {
    id: "codex",
    networkAccess: "required",
    build: ({ worktreePath }) => ({
      runtime: "codex",
      command: "codex",
      args: ["exec", "--cd", worktreePath, "-"],
      promptDelivery: "stdin",
    }),
  };
  return {
    supportedIds: () => ["codex"],
    resolve: (candidate) => {
      if (candidate !== "codex") {
        throw new Error(`unsupported agent runtime: ${candidate}`);
      }
      return runtime;
    },
  };
}

function directSocketRuntimeRegistry(): AgentRuntimeRegistry {
  const runtime: AgentRuntimeLauncher = {
    id: "codex",
    networkAccess: "required",
    build: () => ({
      runtime: "codex",
      command: "node",
      args: [
        "-e",
        "const net=require('node:net'); const socket=net.connect({host:'example.com',port:80}); const done=(code)=>{socket.destroy(); process.exit(code)}; socket.setTimeout(5000); socket.once('connect',()=>done(1)); socket.once('error',()=>done(0)); socket.once('timeout',()=>done(0));",
      ],
      promptDelivery: "stdin",
    }),
  };
  return {
    supportedIds: () => ["codex"],
    resolve: (candidate) => {
      if (candidate !== "codex") {
        throw new Error(`unsupported agent runtime: ${candidate}`);
      }
      return runtime;
    },
  };
}

describe("OciExecutionBackend", () => {
  it("labels workloads with ownership and bounded expiry metadata", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      cleanupGraceMs: 5_000,
      now: () => new Date("2026-09-18T00:00:00.000Z"),
      processRunner: successfulRunner(calls),
      containerName: () => "nitely-lifecycle",
    });

    await backend.runCommand(
      { runId: "run-lifecycle", path: fixture.worktree },
      "true",
      {
        runId: "run-lifecycle",
        stageId: "verify",
        timeoutMs: 12_000,
        outputDirectory: fixture.attempt,
      },
    );

    const launch = calls.find((call) => call.args[0] === "run");
    expect(launch?.args).toEqual(
      expect.arrayContaining([
        "--label",
        "com.nitely.managed=true",
        "com.nitely.run-id=run-lifecycle",
        "com.nitely.stage-id=verify",
        "com.nitely.created-at=2026-09-18T00:00:00.000Z",
        "com.nitely.expires-at=2026-09-18T00:00:17.000Z",
      ]),
    );
    expect(backend.describeExecution().lifecycle).toMatchObject({
      managed: true,
      cleanupGraceMs: 5_000,
    });
  });

  it("reaps only expired managed containers and tolerates races", async () => {
    const calls: SandboxProcessInput[] = [];
    const report = await reapExpiredOciContainers({
      env: { DOCKER_HOST: "unix:///run/user/501/docker.sock" },
      now: () => new Date("2026-09-18T00:00:00.000Z"),
      processRunner: async (input) => {
        calls.push(input);
        if (input.args[0] === "ps") {
          return { stdout: "stale\nactive\ninvalid\n", stderr: "", exitCode: 0 };
        }
        if (input.args[0] === "inspect") {
          const id = input.args.at(-1);
          return {
            stdout:
              id === "stale"
                ? "2026-09-17T23:59:00.000Z\n"
                : id === "active"
                  ? "2026-09-18T00:01:00.000Z\n"
                  : "not-a-date\n",
            stderr: "",
            exitCode: 0,
          };
        }
        return {
          stdout: "",
          stderr: "Error response from daemon: No such container: stale",
          exitCode: 1,
        };
      },
    });

    expect(report).toMatchObject({ scanned: 3, removed: ["stale"], skipped: 1 });
    expect(calls[0]?.args).toEqual([
      "ps",
      "-aq",
      "--filter",
      "label=com.nitely.managed=true",
    ]);
    expect(calls.filter((call) => call.args[0] === "rm")).toHaveLength(1);
    expect(calls.find((call) => call.args[0] === "rm")?.args.at(-1)).toBe("stale");
  });

  it("pins a mutable image tag to one immutable identity for the run", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const firstDigest = "a".repeat(64);
    const laterDigest = "b".repeat(64);
    let inspectCount = 0;
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: async (input) => {
        calls.push(input);
        if (input.args[0] === "info") {
          return { stdout: '["name=rootless"]\t"2"\t[]\n', stderr: "", exitCode: 0 };
        }
        if (input.args[0] === "image") {
          inspectCount += 1;
          const digest = inspectCount === 1 ? firstDigest : laterDigest;
          return {
            stdout: `${JSON.stringify(`sha256:${digest}`)}\t${JSON.stringify([`registry.example/nitely-runner@sha256:${digest}`])}\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        if (input.args[0] === "run") return { stdout: "ok\n", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await backend.prepareForRun();
    await backend.prepareForRun();
    await backend.runCommand(
      { runId: "image-pin", path: fixture.worktree },
      "printf ok",
      { outputDirectory: fixture.attempt },
    );

    expect(inspectCount).toBe(1);
    expect(backend.describeExecution()).toMatchObject({
      image: "nitely-runner:test",
      imageReference: "nitely-runner:test",
      imageIdentity: `sha256:${firstDigest}`,
    });
    expect(calls.find((call) => call.args[0] === "run")?.args).toContain(
      `registry.example/nitely-runner@sha256:${firstDigest}`,
    );
    expect(calls.find((call) => call.args[0] === "run")?.args).not.toContain(
      `registry.example/nitely-runner@sha256:${laterDigest}`,
    );
  });

  it("fails image preparation when the configured image cannot be inspected", async () => {
    const backend = new OciExecutionBackend({
      image: "missing-runner:test",
      processRunner: async (input) => input.args[0] === "info"
        ? { stdout: '["name=rootless"]\t"2"\t[]\n', stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "No such image", exitCode: 1 },
    });

    await expect(backend.prepareForRun()).rejects.toThrow(
      /unable to resolve OCI image missing-runner:test: No such image/,
    );
  });

  it("restores a persisted image identity instead of following the mutable tag", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const identity = `sha256:${"c".repeat(64)}`;
    const backend = new OciExecutionBackend({
      image: "nitely-runner:retagged",
      imageIdentity: identity,
      processRunner: async (input) => {
        calls.push(input);
        if (input.args[0] === "info") return { stdout: '["name=rootless"]\t"2"\t[]\n', stderr: "", exitCode: 0 };
        if (input.args[0] === "run") return { stdout: "ok\n", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await backend.prepareForRun();
    await backend.runCommand(
      { runId: "restored-image", path: fixture.worktree },
      "printf ok",
      { outputDirectory: fixture.attempt },
    );

    const inspect = calls.find((call) => call.args[0] === "image");
    expect(inspect?.args).toContain(identity);
    expect(calls.find((call) => call.args[0] === "run")?.args).toContain(identity);
    expect(calls.find((call) => call.args[0] === "run")?.args).not.toContain("nitely-runner:retagged");
  });

  it("redacts allow-listed secret values from captured workload output", async () => {
    const fixture = await createFixture();
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      env: { SHORT_SECRET: "xy" },
      secretAllowlist: ["SHORT_SECRET"],
      processRunner: async (input) => {
        if (input.args[0] === "info") {
          return {
            stdout: '["name=seccomp,profile=builtin","name=rootless"]\t"2"\t[]\n',
            stderr: "",
            exitCode: 0,
          };
        }
        if (input.args[0] === "run") {
          return { stdout: "value=xy\n", stderr: "error=xy\n", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await expect(
      backend.runCommand(
        { runId: "redaction", path: fixture.worktree },
        "printf secret",
        {
          runId: "redaction",
          stageId: "verify",
          attempt: 1,
          attemptDirectory: fixture.attempt,
          outputDirectory: fixture.attempt,
        },
      ),
    ).resolves.toEqual({
      stdout: "value=[REDACTED]\n",
      stderr: "error=[REDACTED]\n",
      exitCode: 0,
    });
  });

  it("constructs a rootless, repository-scoped, resource-bounded Docker command", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      env: {
        DOCKER_HOST: "unix:///run/user/501/docker.sock",
        LANG: "C.UTF-8",
        ALLOWED_SECRET: "super-secret-value",
        HOST_SECRET: "must-not-enter-container",
      },
      environmentAllowlist: ["LANG"],
      secretAllowlist: ["ALLOWED_SECRET"],
      engineCommand: "docker",
      processRunner: successfulRunner(calls),
      containerName: () => "nitely-run-test",
      uid: 501,
      gid: 20,
      resources: {
        cpus: 1.5,
        memoryBytes: 512 * 1024 * 1024,
        pids: 96,
        tmpfsBytes: 64 * 1024 * 1024,
        maxFileBytes: 8 * 1024 * 1024,
        maxCapturedOutputBytes: 2 * 1024 * 1024,
        timeoutMs: 45_000,
      },
    });

    await expect(
      backend.runCommand(
        { runId: "run-test", path: fixture.worktree },
        "printf ok",
        {
          runId: "run-test",
          stageId: "verify",
          attempt: 1,
          attemptDirectory: fixture.attempt,
          outputDirectory: fixture.attempt,
          timeoutMs: 12_000,
        },
      ),
    ).resolves.toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 });

    expect(calls.map((call) => call.args[0])).toEqual(["info", "run", "rm"]);
    const launch = calls[1]!;
    expect(launch.command).toBe("docker");
    expect(launch.args).toEqual(
      expect.arrayContaining([
        "run",
        "--rm",
        "--init",
        "--pull=never",
        "--read-only",
        "--network=none",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--ipc=none",
        "--user",
        "501:20",
        "--cpus",
        "1.5",
        "--memory",
        "536870912",
        "--memory-swap",
        "536870912",
        "--pids-limit",
        "96",
        "--ulimit",
        "fsize=8388608:8388608",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=67108864",
        "--env",
        "LANG",
        "--env",
        "ALLOWED_SECRET",
        "--workdir",
        "/workspace",
        "nitely-runner:test",
        "sh",
        "-c",
        "printf ok",
      ]),
    );
    expect(launch.args).toContain(
      `type=bind,src=${fixture.worktree},dst=/workspace`,
    );
    expect(launch.args).toContain(
      "type=bind,src=/dev/null,dst=/workspace/.git,readonly",
    );
    expect(launch.args).toContain(
      `type=bind,src=${fixture.runRoot},dst=/nitely/run,readonly`,
    );
    expect(launch.args).toContain(
      `type=bind,src=${fixture.attempt},dst=/nitely/output`,
    );
    expect(valueAfter(launch.args, "--name")).toBe("nitely-run-test");
    expect(launch.timeoutMs).toBe(12_000);
    expect(launch.maxOutputBytes).toBe(2 * 1024 * 1024);
    expect(launch.args.join("\0")).not.toContain("super-secret-value");
    expect(launch.args.join("\0")).not.toContain("must-not-enter-container");
    expect(launch.args).not.toContain("HOST_SECRET");
    expect(launch.env).toEqual({
      DOCKER_HOST: "unix:///run/user/501/docker.sock",
      LANG: "C.UTF-8",
      ALLOWED_SECRET: "super-secret-value",
    });
    expect(calls[2]!.args).toEqual(["rm", "-f", "nitely-run-test"]);
    expect(dirname(fixture.worktree)).toBe(fixture.runRoot);
  });

  it("uses container root by default so rootless UID mapping can write host-user bind mounts", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
    });

    await backend.runCommand(
      { runId: "rootless-identity", path: fixture.worktree },
      "touch rootless-write.txt",
      { outputDirectory: fixture.attempt },
    );

    expect(calls[1]!.args).toEqual(
      expect.arrayContaining(["--user", "0:0"]),
    );
  });

  it("fails closed before workload launch when the Docker engine is not rootless", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: async (input) => {
        calls.push(input);
        return {
          stdout: '["name=seccomp,profile=builtin"]\n',
          stderr: "",
          exitCode: 0,
        };
      },
    });

    await expect(
      backend.runCommand(
        { runId: "rootful", path: fixture.worktree },
        "echo unsafe",
        { outputDirectory: fixture.attempt },
      ),
    ).rejects.toThrow(/requires a rootless Docker engine/);
    expect(calls.map((call) => call.args[0])).toEqual(["info"]);
  });

  it("does not accept a rootless-like security option as rootless proof", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: async (input) => {
        calls.push(input);
        return {
          stdout: '["name=not-rootless"]\n',
          stderr: "",
          exitCode: 0,
        };
      },
    });

    await expect(
      backend.runCommand(
        { runId: "rootless-lookalike", path: fixture.worktree },
        "echo unsafe",
        { outputDirectory: fixture.attempt },
      ),
    ).rejects.toThrow(/requires a rootless Docker engine/);
    expect(calls.map((call) => call.args[0])).toEqual(["info"]);
  });

  it("rejects a rootless engine that does not report cgroup v2", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: async (input) => {
        calls.push(input);
        return {
          stdout: '["name=rootless"]\t"1"\t[]\n',
          stderr: "",
          exitCode: 0,
        };
      },
    });

    await expect(
      backend.runCommand(
        { runId: "cgroup-v1", path: fixture.worktree },
        "echo unsafe",
        { outputDirectory: fixture.attempt },
      ),
    ).rejects.toThrow(/requires cgroup v2/);
    expect(calls.map((call) => call.args[0])).toEqual(["info"]);
  });

  it("rejects a rootless engine that cannot enforce configured resource limits", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: async (input) => {
        calls.push(input);
        return {
          stdout:
            '["name=rootless"]\t"2"\t["WARNING: No memory limit support"]\n',
          stderr: "",
          exitCode: 0,
        };
      },
    });

    await expect(
      backend.runCommand(
        { runId: "missing-limits", path: fixture.worktree },
        "echo unsafe",
        { outputDirectory: fixture.attempt },
      ),
    ).rejects.toThrow(/cannot enforce required resource limits.*memory/i);
    expect(calls.map((call) => call.args[0])).toEqual(["info"]);
  });

  it("allows rootless engines that only lack unused cpuset support", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: async (input) => {
        calls.push(input);
        if (input.args[0] === "info") {
          return {
            stdout:
              '["name=rootless"]\t"2"\t["WARNING: No cpuset support"]\n',
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "ok\n", stderr: "", exitCode: 0 };
      },
    });

    await expect(
      backend.runCommand(
        { runId: "missing-unused-cpuset", path: fixture.worktree },
        "echo safe",
        { outputDirectory: fixture.attempt },
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(calls.map((call) => call.args[0])).toEqual(["info", "run", "rm"]);
  });

  it.each([
    ["a remote Docker host", { DOCKER_HOST: "tcp://daemon.example:2376" }],
    ["a Docker context", { DOCKER_CONTEXT: "remote-production" }],
  ])("rejects %s before invoking the engine", (_label, env) => {
    expect(
      () =>
        new OciExecutionBackend({
          image: "nitely-runner:test",
          env,
          processRunner: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        }),
    ).toThrow(/local Unix Docker socket|DOCKER_CONTEXT/);
  });

  it("fails closed when Docker rootless inspection itself fails", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: async (input) => {
        calls.push(input);
        return {
          stdout: '["name=rootless"]',
          stderr: "daemon unavailable",
          exitCode: 1,
        };
      },
    });

    await expect(
      backend.runCommand(
        { runId: "inspect-failure", path: fixture.worktree },
        "echo unsafe",
        { outputDirectory: fixture.attempt },
      ),
    ).rejects.toThrow(/unable to inspect OCI engine.*daemon unavailable/);
    expect(calls.map((call) => call.args[0])).toEqual(["info"]);
  });

  it("rejects an output mount whose symlink escapes the task run directory", async () => {
    const fixture = await createFixture();
    const outside = await mkdtemp(join(tmpdir(), "nitely-oci-outside-"));
    const escapedOutput = join(fixture.runRoot, "escaped-output");
    await symlink(outside, escapedOutput, "dir");
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
    });

    await expect(
      backend.runCommand(
        { runId: "escape", path: fixture.worktree },
        "echo unsafe",
        { outputDirectory: escapedOutput },
      ),
    ).rejects.toThrow(/output directory escapes the task run directory/);
    expect(calls).toHaveLength(0);
  });

  it("force-removes the container when workload execution throws", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      containerName: () => "nitely-throwing",
      processRunner: async (input) => {
        calls.push(input);
        if (input.args[0] === "info") {
          return {
            stdout: '["name=rootless"]\t"2"\t[]',
            stderr: "",
            exitCode: 0,
          };
        }
        if (input.args[0] === "run") {
          throw new Error("runner aborted workload");
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await expect(
      backend.runCommand(
        { runId: "throwing", path: fixture.worktree },
        "echo never",
        { outputDirectory: fixture.attempt },
      ),
    ).rejects.toThrow(/runner aborted workload/);
    expect(calls.map((call) => call.args)).toEqual([
      [
        "info",
        "--format",
        "{{json .SecurityOptions}}\t{{json .CgroupVersion}}\t{{json .Warnings}}",
      ],
      expect.arrayContaining(["run", "--name", "nitely-throwing"]),
      ["rm", "-f", "nitely-throwing"],
    ]);
  });

  it.each([
    ["non-zero exit", 7],
    ["timeout exit", 124],
  ])("force-removes the container after a %s", async (_label, exitCode) => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      containerName: () => `nitely-exit-${exitCode}`,
      processRunner: async (input) => {
        calls.push(input);
        if (input.args[0] === "info") {
          return {
            stdout: '["name=rootless"]\t"2"\t[]',
            stderr: "",
            exitCode: 0,
          };
        }
        if (input.args[0] === "run") {
          return { stdout: "", stderr: "failed\n", exitCode };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await expect(
      backend.runCommand(
        { runId: `exit-${exitCode}`, path: fixture.worktree },
        "exit 1",
        { outputDirectory: fixture.attempt },
      ),
    ).resolves.toMatchObject({ exitCode });
    expect(calls.at(-1)?.args).toEqual([
      "rm",
      "-f",
      `nitely-exit-${exitCode}`,
    ]);
  });

  it.each([
    ["captured-output overflow", "OUTPUT_LIMIT_EXCEEDED"],
    ["abort", "ABORT_ERR"],
  ])("force-removes the container after a %s error", async (_label, code) => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      containerName: () => `nitely-error-${code.toLowerCase()}`,
      processRunner: async (input) => {
        calls.push(input);
        if (input.args[0] === "info") {
          return {
            stdout: '["name=rootless"]\t"2"\t[]',
            stderr: "",
            exitCode: 0,
          };
        }
        if (input.args[0] === "run") {
          throw Object.assign(new Error(code), { code });
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await expect(
      backend.runCommand(
        { runId: code, path: fixture.worktree },
        "echo never",
        { outputDirectory: fixture.attempt },
      ),
    ).rejects.toMatchObject({ code });
    expect(calls.at(-1)?.args).toEqual([
      "rm",
      "-f",
      `nitely-error-${code.toLowerCase()}`,
    ]);
  });

  it("preserves an abort code while surfacing a forced-cleanup failure", async () => {
    const fixture = await createFixture();
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      containerName: () => "nitely-abort-cleanup-failure",
      processRunner: async (input) => {
        if (input.args[0] === "info") {
          return {
            stdout: '["name=rootless"]\t"2"\t[]',
            stderr: "",
            exitCode: 0,
          };
        }
        if (input.args[0] === "run") {
          throw Object.assign(new Error("sandbox aborted"), { code: "ABORT_ERR" });
        }
        return { stdout: "", stderr: "daemon unavailable", exitCode: 2 };
      },
    });

    const error = await backend.runCommand(
      { runId: "abort-cleanup-failure", path: fixture.worktree },
      "echo never",
      { outputDirectory: fixture.attempt },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "ABORT_ERR" });
    expect(String((error as Error).message)).toMatch(/sandbox aborted/i);
    expect(String((error as Error).message)).toMatch(/cleanup.*daemon unavailable/i);
  });

  it("reports both a non-zero workload result and forced-cleanup failure", async () => {
    const fixture = await createFixture();
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      containerName: () => "nitely-workload-cleanup-failure",
      processRunner: async (input) => {
        if (input.args[0] === "info") {
          return {
            stdout: '["name=rootless"]\t"2"\t[]',
            stderr: "",
            exitCode: 0,
          };
        }
        if (input.args[0] === "run") {
          return { stdout: "", stderr: "workload failed", exitCode: 7 };
        }
        return { stdout: "", stderr: "cleanup denied", exitCode: 3 };
      },
    });

    await expect(
      backend.runCommand(
        { runId: "workload-cleanup-failure", path: fixture.worktree },
        "exit 7",
        { outputDirectory: fixture.attempt },
      ),
    ).rejects.toThrow(/workload.*exit(?:ed)? 7.*cleanup.*cleanup denied/i);
  });

  it("accepts Docker's already-removed cleanup result after run --rm succeeds", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      containerName: () => "nitely-already-removed",
      processRunner: async (input) => {
        calls.push(input);
        if (input.args[0] === "info") {
          return {
            stdout: '["name=rootless"]\t"2"\t[]',
            stderr: "",
            exitCode: 0,
          };
        }
        if (input.args[0] === "rm") {
          return {
            stdout: "",
            stderr:
              "Error response from daemon: No such container: nitely-already-removed\n",
            exitCode: 1,
          };
        }
        return { stdout: "completed\n", stderr: "", exitCode: 0 };
      },
    });

    await expect(
      backend.runCommand(
        { runId: "already-removed", path: fixture.worktree },
        "echo completed",
        { outputDirectory: fixture.attempt },
      ),
    ).resolves.toEqual({ stdout: "completed\n", stderr: "", exitCode: 0 });
    expect(calls.at(-1)?.args).toEqual([
      "rm",
      "-f",
      "nitely-already-removed",
    ]);
  });

  it("uses the spawning process runner by default", async () => {
    const fixture = await createFixture();
    const binDirectory = await mkdtemp(join(tmpdir(), "nitely-fake-docker-"));
    const fakeDocker = join(binDirectory, "docker");
    await writeFile(
      fakeDocker,
      [
        "#!/bin/sh",
        'if [ "$1" = "info" ]; then printf \'["name=rootless"]\\t"2"\\t[]\\n\'; exit 0; fi',
        'if [ "$1" = "run" ]; then printf "from-default-runner\\n"; exit 0; fi',
        'if [ "$1" = "rm" ]; then exit 0; fi',
        "exit 64",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeDocker, 0o755);
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      engineCommand: fakeDocker,
      containerName: () => "nitely-default-runner",
      engineSocketVerifier: async () => {},
    });

    await expect(
      backend.runCommand(
        { runId: "default-runner", path: fixture.worktree },
        "echo ok",
        { outputDirectory: fixture.attempt },
      ),
    ).resolves.toEqual({
      stdout: "from-default-runner\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("rejects a non-socket local Docker endpoint before invoking the engine", async () => {
    const fixture = await createFixture();
    const binDirectory = await mkdtemp(join(tmpdir(), "nitely-fake-docker-host-"));
    const fakeDocker = join(binDirectory, "docker");
    const notSocket = join(binDirectory, "docker.sock");
    await writeFile(notSocket, "not a socket\n", "utf8");
    await writeFile(
      fakeDocker,
      [
        "#!/bin/sh",
        "printf '[\"name=rootless\"]\\t\"2\"\\t[]\\n'",
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeDocker, 0o755);
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      engineCommand: fakeDocker,
      env: { DOCKER_HOST: `unix://${notSocket}` },
    });

    await expect(
      backend.runCommand(
        { runId: "not-a-socket", path: fixture.worktree },
        "echo unsafe",
        { outputDirectory: fixture.attempt },
      ),
    ).rejects.toThrow(/Docker endpoint.*Unix socket/i);
  });

  it("attaches stdin to the workload when the runtime reads its prompt from stdin", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
      runtimeRegistry: offlineRuntimeRegistry(),
    });

    await backend.runAgent(
      { runId: "stdin-prompt", path: fixture.worktree },
      {
        stage: agentStage(sandboxCapabilities()),
        prompt: "Implement.",
        attemptDirectory: fixture.attempt,
      },
    );

    const launch = calls.find((call) => call.args[0] === "run");
    // `docker run` discards the piped prompt unless stdin is attached, and the
    // CLI then exits with "Input must be provided either through stdin or as
    // a prompt argument".
    expect(launch?.stdin).toBe("Implement.");
    expect(launch?.args).toContain("--interactive");
    expect(launch?.args).not.toContain("--tty");
  });

  it("passes Claude the permission mode its capabilities imply and the container output/input dirs", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const builds: Array<{ permissionMode?: string; additionalDirectories?: string[] }> = [];
    const registry: AgentRuntimeRegistry = {
      supportedIds: () => ["claude"],
      resolve: () => ({
        id: "claude",
        networkAccess: "none",
        build: (input) => {
          builds.push({
            ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
            ...(input.additionalDirectories
              ? { additionalDirectories: input.additionalDirectories }
              : {}),
          });
          return { runtime: "claude", command: "claude", args: ["-p"], promptDelivery: "stdin" };
        },
      }),
    };
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
      runtimeRegistry: registry,
    });

    // write-tests style: writes allowed, no commands → acceptEdits.
    await backend.runAgent(
      { runId: "claude-accept-edits", path: fixture.worktree },
      {
        stage: {
          ...agentStage(
            sandboxCapabilities({
              commands: { mode: "none", allow: [], deny: [], advisory: true },
              allowedRuntimes: ["claude"],
            }),
          ),
          runtime: "claude",
          inputs: ["spec", "tech-design"],
        },
        prompt: "Write tests.",
        attemptDirectory: fixture.attempt,
      },
    );
    expect(builds.at(-1)).toEqual({
      permissionMode: "acceptEdits",
      additionalDirectories: [
        "/nitely/output",
        "/nitely/run/inputs/spec",
        "/nitely/run/inputs/tech-design",
      ],
    });

    // review-gate style: no worktree writes, no commands. The read-only
    // worktree mount enforces the write boundary, so Claude still gets
    // acceptEdits — otherwise print mode denies the write of its own
    // declared output under /nitely/output and the gate fails on a missing
    // artifact.
    await backend.runAgent(
      { runId: "claude-review", path: fixture.worktree },
      {
        stage: {
          ...agentStage(
            sandboxCapabilities({
              write: { scope: "none", allow: [] },
              commands: { mode: "none", allow: [], deny: [], advisory: true },
              allowedRuntimes: ["claude"],
            }),
          ),
          runtime: "claude",
        },
        prompt: "Review.",
        attemptDirectory: fixture.attempt,
      },
    );
    expect(builds.at(-1)).toEqual({
      permissionMode: "acceptEdits",
      additionalDirectories: ["/nitely/output"],
    });
    const reviewLaunch = calls.filter((call) => call.args[0] === "run").at(-1);
    expect(reviewLaunch?.args.join(" ")).toContain(`src=${fixture.worktree},dst=/workspace,readonly`);

    // implement style: commands unrestricted → bypassPermissions.
    await backend.runAgent(
      { runId: "claude-bypass", path: fixture.worktree },
      {
        stage: {
          ...agentStage(sandboxCapabilities({ allowedRuntimes: ["claude"] })),
          runtime: "claude",
        },
        prompt: "Implement.",
        attemptDirectory: fixture.attempt,
      },
    );
    expect(builds.at(-1)).toEqual({
      permissionMode: "bypassPermissions",
      additionalDirectories: ["/nitely/output"],
    });
  });

  it("marks the container as a sandbox so Claude may bypass permissions as the mapped root user", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const registry: AgentRuntimeRegistry = {
      supportedIds: () => ["claude"],
      resolve: () => ({
        id: "claude",
        networkAccess: "none",
        build: () => ({ runtime: "claude", command: "claude", args: ["-p"], promptDelivery: "stdin" }),
      }),
    };
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
      runtimeRegistry: registry,
    });

    await backend.runAgent(
      { runId: "claude-sandbox-root", path: fixture.worktree },
      {
        stage: {
          ...agentStage(sandboxCapabilities({ allowedRuntimes: ["claude"] })),
          runtime: "claude",
        },
        prompt: "Implement.",
        attemptDirectory: fixture.attempt,
      },
    );

    // Rootless engines map the operator to uid 0 inside the container, and
    // the Claude CLI refuses --permission-mode bypassPermissions as root
    // unless the environment declares the process sandboxed.
    const launch = calls.find((call) => call.args[0] === "run");
    expect(launch?.args).toContain("IS_SANDBOX=1");
  });

  it("keeps /tmp noexec by default and allows exec only when the operator opts in", async () => {
    const fixture = await createFixture();
    const tmpfsArg = (calls: SandboxProcessInput[]): string | undefined => {
      const launch = calls.find((call) => call.args[0] === "run");
      const index = launch?.args.indexOf("--tmpfs") ?? -1;
      return index >= 0 ? launch?.args[index + 1] : undefined;
    };

    const defaultCalls: SandboxProcessInput[] = [];
    const strict = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(defaultCalls),
    });
    await strict.runCommand({ runId: "tmp-noexec", path: fixture.worktree }, "true", {
      attemptDirectory: fixture.attempt,
    });
    expect(tmpfsArg(defaultCalls)).toBe("/tmp:rw,nosuid,nodev,noexec,size=268435456");
    expect(strict.describeExecution().tmpfs).toEqual({ exec: false });

    // A repository whose verification writes helper scripts to os.tmpdir()
    // and runs them (fake CLIs, shims) needs exec on /tmp. The engine's own
    // default is noexec, so the flag has to be spelled out.
    const execCalls: SandboxProcessInput[] = [];
    const permissive = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(execCalls),
      tmpfsExec: true,
    });
    await permissive.runCommand({ runId: "tmp-exec", path: fixture.worktree }, "true", {
      attemptDirectory: fixture.attempt,
    });
    expect(tmpfsArg(execCalls)).toBe("/tmp:rw,exec,nosuid,nodev,size=268435456");
    expect(permissive.describeExecution().tmpfs).toEqual({ exec: true });
  });

  it("states an advisory command policy in the agent prompt and runs the stage", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
      runtimeRegistry: offlineRuntimeRegistry(),
    });

    await backend.runAgent(
      { runId: "command-advisory", path: fixture.worktree },
      {
        stage: agentStage(
          sandboxCapabilities({
            commands: {
              mode: "allow-list",
              allow: ["pnpm test*"],
              deny: ["git push*"],
              advisory: true,
            },
          }),
        ),
        prompt: "Implement.",
        attemptDirectory: fixture.attempt,
      },
    );

    const launch = calls.find((call) => call.args[0] === "run");
    expect(launch?.stdin).toContain("## Command Policy");
    expect(launch?.stdin).toContain(
      "You may only run commands matching: pnpm test*",
    );
    expect(launch?.stdin).toContain(
      "You must not run commands matching: git push*",
    );
    expect(launch?.stdin).toContain("stated, not enforced");
  });

  it("leaves the prompt alone and reports the mechanism when one mediates commands", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
      runtimeRegistry: offlineRuntimeRegistry(),
      commandMediation: { id: "test-mediator", supports: () => true },
    });

    await backend.runAgent(
      { runId: "command-enforced", path: fixture.worktree },
      {
        stage: agentStage(
          sandboxCapabilities({
            commands: {
              mode: "allow-list",
              allow: ["pnpm test*"],
              deny: [],
              advisory: false,
            },
          }),
        ),
        prompt: "Implement.",
        attemptDirectory: fixture.attempt,
      },
    );

    const launch = calls.find((call) => call.args[0] === "run");
    expect(launch?.stdin).toBe("Implement.");
    expect(backend.describeExecution().commands).toEqual({
      mediation: "mechanism",
      mechanism: "test-mediator",
    });
    expect(backend.describeExecution().limitations).toContain(
      "agent-spawned commands are mediated by test-mediator",
    );
  });

  it("reports a demanded command policy as unavailable during preflight", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
      runtimeRegistry: offlineRuntimeRegistry(),
    });

    const result = await backend.preflightAgentRuntime(
      { runId: "command-preflight", path: fixture.worktree },
      {
        stage: agentStage(
          sandboxCapabilities({
            commands: {
              mode: "deny-list",
              allow: [],
              deny: ["curl"],
              advisory: false,
            },
          }),
        ),
        attemptDirectory: fixture.attempt,
      },
    );

    expect(result).toMatchObject({
      available: false,
      reason: expect.stringContaining("demands enforcement"),
    });
    expect(calls).toHaveLength(0);
  });

  it("fails closed when a stage demands command mediation the sandbox cannot provide", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
    });

    await expect(
      backend.runAgent(
        { runId: "command-policy", path: fixture.worktree },
        {
          stage: agentStage({
            read: { scope: "repository", allow: [] },
            write: { scope: "worktree", allow: [] },
            commands: {
              mode: "allow-list",
              allow: ["pnpm test"],
              deny: [],
              advisory: false,
            },
            network: { mode: "disabled", advisory: false, domains: [] },
            allowedRuntimes: ["codex"],
            allowedModels: [],
            instructions: { repo: true, generated: true, skills: true },
            evidence: {
              prompts: true,
              toolCalls: true,
              fileChanges: true,
              runtimeUsage: true,
            },
          }),
          prompt: "Implement.",
          attemptDirectory: fixture.attempt,
        },
      ),
    ).rejects.toThrow(
      /the OCI sandbox has no mechanism that mediates the commands an agent spawns inside it/,
    );
    expect(calls).toHaveLength(0);
  });

  it("rejects restricted network policy without domains before workload launch", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
      runtimeRegistry: networkRequiredRuntimeRegistry(),
    });

    await expect(
      backend.runAgent(
        { runId: "network-policy", path: fixture.worktree },
        {
          stage: agentStage(
            sandboxCapabilities({
              network: { mode: "restricted", advisory: false, domains: [] },
            }),
          ),
          prompt: "Implement.",
          attemptDirectory: fixture.attempt,
        },
      ),
    ).rejects.toThrow(/cannot enforce network mode restricted without domains/i);
    expect(calls).toHaveLength(0);
  });

  it("rejects open allowed network policy fail-closed", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
      networkAllowlist: ["api.openai.com"],
      runtimeRegistry: networkRequiredRuntimeRegistry(),
    });

    await expect(
      backend.runAgent(
        { runId: "network-allowed", path: fixture.worktree },
        {
          stage: agentStage(
            sandboxCapabilities({
              network: {
                mode: "allowed",
                advisory: false,
                domains: ["api.openai.com"],
              },
            }),
          ),
          prompt: "Implement.",
          attemptDirectory: fixture.attempt,
        },
      ),
    ).rejects.toThrow(/cannot enforce network mode allowed/i);
    expect(calls).toHaveLength(0);
  });

  it("preflights network-dependent agent runtimes as unavailable without allowlist", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
    });

    await expect(
      backend.preflightAgentRuntime(
        { runId: "network-runtime-preflight", path: fixture.worktree },
        {
          stage: agentStage(sandboxCapabilities()),
          attemptDirectory: fixture.attempt,
        },
      ),
    ).resolves.toEqual({
      available: false,
      reason: expect.stringMatching(/codex requires network access.*network=none/i),
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects network-dependent agent runtimes before workload launch without allowlist", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
    });

    await expect(
      backend.runAgent(
        { runId: "network-runtime", path: fixture.worktree },
        {
          stage: agentStage(sandboxCapabilities()),
          prompt: "Implement.",
          attemptDirectory: fixture.attempt,
        },
      ),
    ).rejects.toThrow(/codex requires network access.*network=none/i);
    expect(calls).toHaveLength(0);
  });

  it("preflights network-dependent runtimes when allowlist gateway is configured", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    let disposed = 0;
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
      networkAllowlist: ["api.openai.com"],
      runtimeRegistry: networkRequiredRuntimeRegistry(),
      networkGatewayFactory: (domains) => ({
        id: "http-connect-allowlist",
        domains,
        assertEnforceable: async () => undefined,
        prepareContainerNetwork: async () => ({
          dockerArgs: ["--network=bridge"],
          containerEnv: { HTTPS_PROXY: "http://host.docker.internal:9" },
          description: "allowlist(api.openai.com) via http-connect-allowlist",
        }),
        dispose: async () => {
          disposed += 1;
        },
      }),
    });

    await expect(
      backend.preflightAgentRuntime(
        { runId: "network-runtime-preflight-allowlist", path: fixture.worktree },
        {
          stage: agentStage(
            sandboxCapabilities({
              network: {
                mode: "restricted",
                advisory: false,
                domains: ["api.openai.com"],
              },
            }),
          ),
          attemptDirectory: fixture.attempt,
        },
      ),
    ).resolves.toEqual({ available: true });
    expect(disposed).toBe(1);
  });

  it("runs network-required agents with allowlist gateway bridge + proxy env", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    let disposed = 0;
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
      containerName: () => "nitely-network-agent",
      networkAllowlist: ["api.openai.com"],
      runtimeRegistry: networkRequiredRuntimeRegistry(),
      networkGatewayFactory: (domains) => ({
        id: "http-connect-allowlist",
        domains,
        assertEnforceable: async () => undefined,
        prepareContainerNetwork: async () => ({
          dockerArgs: [
            "--network=bridge",
            "--add-host",
            "host.docker.internal:host-gateway",
          ],
          containerEnv: {
            HTTPS_PROXY: "http://host.docker.internal:18080",
            HTTP_PROXY: "http://host.docker.internal:18080",
            NO_PROXY: "",
          },
          description: "allowlist(api.openai.com) via http-connect-allowlist",
        }),
        dispose: async () => {
          disposed += 1;
        },
      }),
    });

    await expect(
      backend.runAgent(
        { runId: "network-agent", path: fixture.worktree },
        {
          stage: agentStage(
            sandboxCapabilities({
              network: {
                mode: "restricted",
                advisory: false,
                domains: ["api.openai.com"],
              },
            }),
          ),
          prompt: "Implement.",
          attemptDirectory: fixture.attempt,
        },
      ),
    ).resolves.toEqual({
      stdout: "ok\n",
      stderr: "",
      // The container never mounts an operator home, so no global skill pack
      // can reach the attempt.
      globalSkills: { isolated: true },
    });

    expect(calls.map((call) => call.args[0])).toEqual(["info", "run", "rm"]);
    const launch = calls[1]!;
    expect(launch.args).toEqual(
      expect.arrayContaining([
        "--network=bridge",
        "--add-host",
        "host.docker.internal:host-gateway",
        "--env",
        "HTTPS_PROXY=http://host.docker.internal:18080",
      ]),
    );
    expect(launch.args).not.toContain("--network=none");
    expect(disposed).toBe(1);
    expect(backend.describeExecution().network).toContain("allowlist(api.openai.com)");
  });

  it("provisions an internal-only workload network and never attaches the agent to docker bridge", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
      containerName: () => "nitely-internal-agent",
      networkAllowlist: ["api.openai.com"],
      runtimeRegistry: networkRequiredRuntimeRegistry(),
    });

    await backend.runAgent(
      { runId: "internal-network-agent", path: fixture.worktree },
      {
        stage: agentStage(
          sandboxCapabilities({
            network: {
              mode: "restricted",
              advisory: false,
              domains: ["api.openai.com"],
            },
          }),
        ),
        prompt: "Implement.",
        attemptDirectory: fixture.attempt,
      },
    );

    const createNetwork = calls.find(
      (call) => call.args[0] === "network" && call.args[1] === "create",
    );
    expect(createNetwork?.args).toEqual(
      expect.arrayContaining(["--driver", "bridge", "--internal"]),
    );
    const networkName = createNetwork?.args.at(-1);
    expect(networkName).toMatch(/^nitely-egress-/);

    const sidecar = calls.find(
      (call) => call.args[0] === "run" && call.args.includes("-d"),
    );
    expect(sidecar?.args).toEqual(expect.arrayContaining(["--network=bridge"]));
    const connect = calls.find(
      (call) => call.args[0] === "network" && call.args[1] === "connect",
    );
    expect(connect?.args[2]).toBe("--alias");
    expect(connect?.args[3]).toMatch(/^nitely-egress-gateway-/);
    expect(connect?.args[4]).toBe(networkName);
    expect(connect?.args[5]).toMatch(/^nitely-egress-gateway-/);

    const workload = calls.find(
      (call) => call.args[0] === "run" && !call.args.includes("-d"),
    );
    expect(workload?.args).toContain(`--network=${networkName}`);
    expect(workload?.args).not.toContain("--network=bridge");
    expect(workload?.args).not.toContain("--network=host");
    expect(workload?.args).not.toContain("--network=none");
    expect(calls.some((call) => call.args[0] === "network" && call.args[1] === "rm")).toBe(
      true,
    );
  });

  it("fails closed before launching a workload when the internal network cannot be created", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: async (input) => {
        calls.push(input);
        if (input.args[0] === "info") {
          return {
            stdout:
              '["name=seccomp,profile=builtin","name=rootless"]\t"2"\tnull\n',
            stderr: "",
            exitCode: 0,
          };
        }
        if (input.args[0] === "network" && input.args[1] === "create") {
          return {
            stdout: "",
            stderr: "Error: network create failed",
            exitCode: 1,
          };
        }
        return { stdout: "ok\n", stderr: "", exitCode: 0 };
      },
      networkAllowlist: ["api.openai.com"],
      runtimeRegistry: networkRequiredRuntimeRegistry(),
    });

    await expect(
      backend.runAgent(
        { runId: "internal-network-fail-closed", path: fixture.worktree },
        {
          stage: agentStage(
            sandboxCapabilities({
              network: {
                mode: "restricted",
                advisory: false,
                domains: ["api.openai.com"],
              },
            }),
          ),
          prompt: "Implement.",
          attemptDirectory: fixture.attempt,
        },
      ),
    ).rejects.toThrow(/internal egress network could not be created/i);
    expect(calls.some((call) => call.args[0] === "run")).toBe(false);
  });

  it("runs an agent inside the sandbox and translates the persisted output path", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      env: { OPENAI_API_KEY: "openai-secret" },
      secretAllowlist: ["OPENAI_API_KEY"],
      processRunner: successfulRunner(calls),
      containerName: () => "nitely-agent",
      runtimeRegistry: offlineRuntimeRegistry(),
    });

    await expect(
      backend.runAgent(
        { runId: "agent", path: fixture.worktree },
        {
          stage: agentStage(sandboxCapabilities()),
          prompt: `Write implementation.md to ${fixture.attempt}.`,
          attemptDirectory: fixture.attempt,
          timeoutMs: 30_000,
        },
      ),
    ).resolves.toEqual({
      stdout: "ok\n",
      stderr: "",
      // The container never mounts an operator home, so no global skill pack
      // can reach the attempt.
      globalSkills: { isolated: true },
    });

    expect(calls.map((call) => call.args[0])).toEqual(["info", "run", "rm"]);
    const launch = calls[1]!;
    expect(launch.args).toEqual(
      expect.arrayContaining([
        "--network=none",
        "--env",
        "OPENAI_API_KEY",
        "nitely-runner:test",
        "codex",
        "exec",
        "--skip-git-repo-check",
        "--cd",
        "/workspace",
        "-",
      ]),
    );
    expect(launch.stdin).toBe("Write implementation.md to /nitely/output.");
    expect(launch.stdin).not.toContain(fixture.runRoot);
    expect(launch.args.join("\0")).not.toContain("openai-secret");
    expect(launch.timeoutMs).toBe(30_000);
  });

  it("enforces required read bounds with a filtered read-only workspace", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.worktree, "small.txt"), "small\n", "utf8");
    await writeFile(join(fixture.worktree, "large.txt"), "01234567890123456789", "utf8");
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: async (input) => {
        calls.push(input);
        if (input.args[0] === "info") {
          return {
            stdout: '["name=rootless"]\t"2"\t[]\n',
            stderr: "",
            exitCode: 0,
          };
        }
        if (input.args[0] === "run") {
          const mount = input.args.find(
            (arg) => arg.startsWith("type=bind,src=") && arg.includes(",dst=/workspace"),
          );
          const source = mount?.match(/^type=bind,src=(.*),dst=\/workspace/iu)?.[1];
          expect(source).toBeDefined();
          await expect(access(join(source!, "small.txt"))).resolves.toBeUndefined();
          await expect(access(join(source!, "large.txt"))).rejects.toThrow();
          return { stdout: "ok\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      runtimeRegistry: offlineRuntimeRegistry(),
    });

    await expect(
      backend.runAgent(
        { runId: "bounded-read", path: fixture.worktree },
        {
          stage: agentStage(
            sandboxCapabilities({ write: { scope: "none", allow: [] } }),
          ),
          prompt: "Review.",
          attemptDirectory: fixture.attempt,
          readPolicy: {
            maxFileBytes: 16,
            deny: ["**/large.txt"],
            enforcement: "required",
          },
        },
      ),
    ).resolves.toMatchObject({ stdout: "ok\n" });
    expect(calls.map((call) => call.args[0])).toEqual(["info", "run", "rm"]);
  });

  it("fails closed when required read bounds would accompany worktree writes", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
      runtimeRegistry: offlineRuntimeRegistry(),
    });

    await expect(
      backend.runAgent(
        { runId: "bounded-write", path: fixture.worktree },
        {
          stage: agentStage(sandboxCapabilities()),
          prompt: "Implement.",
          attemptDirectory: fixture.attempt,
          readPolicy: {
            maxFileBytes: 16,
            deny: [],
            enforcement: "required",
          },
        },
      ),
    ).rejects.toThrow(/only enforce it for read-only stages/);
    expect(calls).toHaveLength(0);
  });

  it("mounts a read-only worktree for a stage with no write capability", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
      runtimeRegistry: offlineRuntimeRegistry(),
    });

    await backend.runAgent(
      { runId: "read-only-agent", path: fixture.worktree },
      {
        stage: agentStage(
          sandboxCapabilities({
            write: { scope: "none", allow: [] },
          }),
        ),
        prompt: "Review.",
        attemptDirectory: fixture.attempt,
      },
    );

    const launch = calls.find((call) => call.args[0] === "run");
    expect(launch?.args).toContain(
      `type=bind,src=${fixture.worktree},dst=/workspace,readonly`,
    );
    expect(launch?.args).not.toContain(
      `type=bind,src=${fixture.worktree},dst=/workspace`,
    );
  });

  it("rejects writable paths when a stage declares write scope none", async () => {
    const fixture = await createFixture();
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner([]),
      runtimeRegistry: offlineRuntimeRegistry(),
    });

    await expect(
      backend.runAgent(
        { runId: "invalid-read-only", path: fixture.worktree },
        {
          stage: agentStage(
            sandboxCapabilities({
              write: { scope: "none", allow: ["test/"] },
            }),
          ),
          prompt: "Review.",
          attemptDirectory: fixture.attempt,
        },
      ),
    ).rejects.toThrow(/write scope none with writable paths/);
  });

  it("reports an agent timeout only after the workload is reaped and cleaned up", async () => {
    const fixture = await createFixture();
    let workloadSettled = false;
    let cleanupFinished = false;
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      env: { OPENAI_API_KEY: "openai-secret" },
      secretAllowlist: ["OPENAI_API_KEY"],
      runtimeRegistry: offlineRuntimeRegistry(),
      processRunner: async (input) => {
        if (input.args[0] === "info") {
          return {
            stdout: '["name=rootless"]\t"2"\t[]',
            stderr: "",
            exitCode: 0,
          };
        }
        if (input.args[0] === "run") {
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          workloadSettled = true;
          return {
            stdout: "partial output\n",
            stderr: "process timed out after 10ms\n",
            exitCode: 124,
          };
        }
        expect(workloadSettled).toBe(true);
        cleanupFinished = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    const error = await backend.runAgent(
      { runId: "agent-timeout", path: fixture.worktree },
      {
        stage: agentStage(sandboxCapabilities()),
        prompt: "Implement.",
        attemptDirectory: fixture.attempt,
        timeoutMs: 10,
      },
    ).catch((caught: unknown) => caught);

    expect(cleanupFinished).toBe(true);
    expect(error).toMatchObject({
      code: "EXECUTION_TIMEOUT",
      timeoutMs: 10,
      stdout: "partial output\n",
      stderr: "process timed out after 10ms\n",
    });
  });

  it("mounts only declared repository paths and keeps write access scoped", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.worktree, "docs"));
    await mkdir(join(fixture.worktree, "src"));
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
      containerName: () => "nitely-scoped-paths",
      runtimeRegistry: offlineRuntimeRegistry(),
    });

    await backend.runAgent(
      { runId: "scoped-paths", path: fixture.worktree },
      {
        stage: agentStage(
          sandboxCapabilities({
            read: { scope: "approved inputs", allow: ["docs"] },
            write: { scope: "worktree", allow: ["src"] },
          }),
        ),
        prompt: "Implement.",
        attemptDirectory: fixture.attempt,
      },
    );

    const args = calls[1]!.args;
    expect(args).toContain(
      "/workspace:ro,nosuid,nodev,noexec,size=1048576",
    );
    expect(args).toContain(
      "/nitely/run:nosuid,nodev,noexec,size=1048576",
    );
    expect(args).toContain(
      `type=bind,src=${join(fixture.worktree, "docs")},dst=/workspace/docs,readonly`,
    );
    expect(args).toContain(
      `type=bind,src=${join(fixture.worktree, "src")},dst=/workspace/src`,
    );
    expect(args).not.toContain(
      `type=bind,src=${fixture.worktree},dst=/workspace`,
    );
    expect(args).not.toContain(
      `type=bind,src=${fixture.worktree},dst=/workspace,readonly`,
    );
  });

  it("mounts only the stage-admitted run artifacts", async () => {
    const fixture = await createFixture();
    const approved = join(fixture.runRoot, "inputs", "approved", "content");
    const unrelated = join(fixture.runRoot, "inputs", "unrelated", "content");
    await mkdir(dirname(approved), { recursive: true });
    await mkdir(dirname(unrelated), { recursive: true });
    await writeFile(approved, "approved\n", "utf8");
    await writeFile(unrelated, "unrelated\n", "utf8");
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
      runtimeRegistry: offlineRuntimeRegistry(),
    });

    await backend.runAgent(
      { runId: "artifact-isolation", path: fixture.worktree },
      {
        stage: agentStage(sandboxCapabilities()),
        prompt: `Read ${approved}.`,
        attemptDirectory: fixture.attempt,
        visibleInputPaths: [approved],
      },
    );

    const args = calls[1]!.args;
    expect(args).toContain(
      `type=bind,src=${dirname(approved)},dst=/nitely/run/inputs/approved,readonly`,
    );
    expect(args.join("\0")).not.toContain(unrelated);
    expect(args.join("\0")).not.toContain(`src=${fixture.runRoot},dst=/nitely/run`);
  });

  it("fails closed when an admitted run artifact is missing", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
      runtimeRegistry: offlineRuntimeRegistry(),
    });

    await expect(
      backend.runAgent(
        { runId: "missing-artifact", path: fixture.worktree },
        {
          stage: agentStage(sandboxCapabilities()),
          prompt: "Review.",
          attemptDirectory: fixture.attempt,
          visibleInputPaths: [join(fixture.runRoot, "inputs", "missing", "content")],
        },
      ),
    ).rejects.toThrow(/required stage artifact cannot be mounted/);
    expect(calls).toHaveLength(0);
  });

  it("injects only the selected runtime's allow-listed credentials", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      env: {
        ANTHROPIC_API_KEY: "anthropic-secret",
        OPENAI_API_KEY: "openai-secret",
      },
      secretAllowlist: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
      processRunner: successfulRunner(calls),
      runtimeRegistry: offlineRuntimeRegistry({
        id: "claude",
        requiredEnv: [["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]],
      }),
    });

    await backend.runAgent(
      { runId: "secret-isolation", path: fixture.worktree },
      {
        stage: {
          ...agentStage(sandboxCapabilities({ allowedRuntimes: ["claude"] })),
          runtime: "claude",
        },
        prompt: "Review.",
        attemptDirectory: fixture.attempt,
      },
    );

    const args = calls[1]!.args;
    expect(args).toContain("ANTHROPIC_API_KEY");
    expect(args).not.toContain("OPENAI_API_KEY");
    expect(args.join("\0")).not.toContain("openai-secret");
  });

  it("rejects a capability path whose symlink escapes the worktree", async () => {
    const fixture = await createFixture();
    const outside = await mkdtemp(join(tmpdir(), "nitely-oci-path-outside-"));
    await symlink(outside, join(fixture.worktree, "docs"), "dir");
    await mkdir(join(fixture.worktree, "src"));
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
      runtimeRegistry: offlineRuntimeRegistry(),
    });

    await expect(
      backend.runAgent(
        { runId: "path-escape", path: fixture.worktree },
        {
          stage: agentStage(
            sandboxCapabilities({
              read: { scope: "approved inputs", allow: ["docs"] },
              write: { scope: "worktree", allow: ["src"] },
            }),
          ),
          prompt: "Implement.",
          attemptDirectory: fixture.attempt,
        },
      ),
    ).rejects.toThrow(/capability path escapes the task worktree/);
    expect(calls).toHaveLength(0);
  });

  it("uses host Git only for workspace creation and commits", async () => {
    const repo = await createGitRepository();
    const worktree = join(repo, ".nitely", "runs", "git-ops", "worktree");
    const backend = new OciExecutionBackend({ image: "nitely-runner:test" });

    const workspace = await backend.createWorkspace({
      repoPath: repo,
      branchName: "nitely/git-ops",
      runId: "git-ops",
      worktreePath: worktree,
    });
    expect(workspace).toEqual({ runId: "git-ops", path: worktree });
    await writeFile(join(worktree, "feature.txt"), "done\n", "utf8");
    await expect(backend.commitAll(workspace, "feat: sandbox output")).resolves.toEqual({
      committed: true,
    });
    const { stdout } = await execFileAsync("git", ["log", "-1", "--pretty=%s"], {
      cwd: worktree,
    });
    expect(stdout.trim()).toBe("feat: sandbox output");
  });

  it("rejects replaced worktree Git metadata before host Git can execute a hook", async () => {
    const repo = await createGitRepository();
    const worktree = join(repo, ".nitely", "runs", "git-attack", "worktree");
    const marker = join(repo, "host-hook-executed");
    const backend = new OciExecutionBackend({ image: "nitely-runner:test" });
    const workspace = await backend.createWorkspace({
      repoPath: repo,
      branchName: "nitely/git-attack",
      runId: "git-attack",
      worktreePath: worktree,
    });

    await rm(join(worktree, ".git"), { force: true });
    await execFileAsync("git", ["init"], { cwd: worktree });
    await execFileAsync("git", ["config", "user.email", "attacker@example.test"], {
      cwd: worktree,
    });
    await execFileAsync("git", ["config", "user.name", "Attacker"], {
      cwd: worktree,
    });
    await execFileAsync("git", ["config", "core.hooksPath", "host-hooks"], {
      cwd: worktree,
    });
    await mkdir(join(worktree, "host-hooks"));
    const hook = join(worktree, "host-hooks", "pre-commit");
    await writeFile(hook, `#!/bin/sh\nprintf owned > ${JSON.stringify(marker)}\n`, "utf8");
    await chmod(hook, 0o755);
    await writeFile(join(worktree, "feature.txt"), "untrusted\n", "utf8");

    await expect(
      backend.commitAll(workspace, "feat: attacker-controlled commit"),
    ).rejects.toThrow(/Git metadata changed|unsafe Git metadata/i);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects capability paths that expose worktree Git metadata", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.worktree, ".git"), "gitdir: /host/metadata\n", "utf8");
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
      runtimeRegistry: offlineRuntimeRegistry(),
    });

    await expect(
      backend.runAgent(
        { runId: "git-capability", path: fixture.worktree },
        {
          stage: agentStage(
            sandboxCapabilities({
              read: { scope: "approved inputs", allow: [".git"] },
              write: { scope: "worktree", allow: [".git"] },
            }),
          ),
          prompt: "Do not inspect host Git metadata.",
          attemptDirectory: fixture.attempt,
        },
      ),
    ).rejects.toThrow(/Git metadata/i);
    expect(calls).toHaveLength(0);
  });

  it("preflights runtime credentials against the explicit container allowlists", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      env: { ANTHROPIC_API_KEY: "host-only-secret" },
      processRunner: successfulRunner(calls),
      runtimeRegistry: offlineRuntimeRegistry({
        id: "claude",
        requiredEnv: [["ANTHROPIC_API_KEY"]],
      }),
    });
    const claudeStage = {
      ...agentStage(sandboxCapabilities()),
      runtime: "claude",
    } satisfies AgentStage;

    await expect(
      backend.preflightAgentRuntime(
        { runId: "preflight", path: fixture.worktree },
        { stage: claudeStage, attemptDirectory: fixture.attempt },
      ),
    ).resolves.toEqual({
      available: false,
      reason:
        "agent runtime claude is not configured in the OCI environment allowlists. Allow ANTHROPIC_API_KEY.",
      missingConfig: ["ANTHROPIC_API_KEY"],
    });
    expect(calls.map((call) => call.args[0])).toEqual(["info"]);
  });

  it("describes the effective sandbox policy without recording secret values", () => {
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      env: {
        LANG: "C.UTF-8",
        OPENAI_API_KEY: "never-record-this-value",
      },
      environmentAllowlist: ["LANG"],
      secretAllowlist: ["OPENAI_API_KEY"],
      resources: { cpus: 2, memoryBytes: 268_435_456, pids: 64 },
    });

    const description = backend.describeExecution();
    expect(description).toEqual({
      backend: "oci",
      engine: "docker-rootless",
      image: "nitely-runner:test",
      policyVersion: 1,
      isolation: "rootless-container",
      identity: {
        uid: 0,
        gid: 0,
        strategy: "rootless-container-root",
      },
      network: "none",
      mounts: [
        "task worktree (capability-scoped)",
        "task run artifacts (read-only)",
        "attempt output (read-write)",
      ],
      environment: {
        allowedNames: ["LANG"],
        secretNames: ["OPENAI_API_KEY"],
        valuesRecorded: false,
      },
      commands: { mediation: "stated" },
      resources: expect.objectContaining({
        cpus: 2,
        memoryBytes: 268_435_456,
        pids: 64,
      }),
      tmpfs: { exec: false },
      cleanup: "run --rm plus forced rm -f",
      lifecycle: {
        managed: true,
        expiry: "effective timeout plus bounded cleanup grace",
        cleanupGraceMs: 30_000,
        labelKeys: [
          "com.nitely.managed",
          "com.nitely.run-id",
          "com.nitely.stage-id",
          "com.nitely.created-at",
          "com.nitely.expires-at",
          "com.nitely.instance-id",
        ],
      },
      limitations: [
        "backing linked-worktree Git metadata is never mounted; host-side workspace create/commit is the only Git write path; Codex uses --skip-git-repo-check and in-container Git commands may be unavailable",
        "without NITELY_OCI_NETWORK_ALLOWLIST, agent runtimes must be offline or fail preflight; built-in Codex/Claude/GLM/Grok/Pi require the allowlist gateway",
        "agent-spawned commands are not mediated inside the image; a stage that sets capabilities.commands.advisory false fails closed instead of running unmediated",
        "aggregate bind-mount disk quota (NITELY_OCI_DISK_BYTES) is not supported and will not be; setting it fails closed. Use per-file NITELY_OCI_MAX_FILE_BYTES and captured-output NITELY_OCI_MAX_CAPTURED_OUTPUT_BYTES",
      ],
    });
    expect(JSON.stringify(description)).not.toContain("never-record-this-value");
  });

  it("states host-only Git as the permanent sandbox limitation and matches the README", async () => {
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
    });
    const gitLimitation =
      "backing linked-worktree Git metadata is never mounted; host-side workspace create/commit is the only Git write path; Codex uses --skip-git-repo-check and in-container Git commands may be unavailable";
    const emittedGit = backend.describeExecution().limitations.find((line) =>
      line.includes("Git metadata"),
    );
    expect(emittedGit).toBe(gitLimitation);
    expect(emittedGit).not.toMatch(/this slice|opt-in|follow-up/i);

    const readme = (
      await readFile(join(import.meta.dirname, "..", "..", "..", "README.md"), "utf8")
    )
      .replaceAll("`", "")
      .replace(/\s+/g, " ");
    expect(readme).toContain(gitLimitation);
    expect(readme).toContain("Host-only Git is the permanent sandbox model");
    expect(readme).toContain(
      "Mounting the backing worktree .git would let a workload follow the gitdir pointer out of the sandbox.",
    );
  });

  it("exposes the versioned SandboxPolicyV1 contract used for execution", () => {
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      environmentAllowlist: ["LANG"],
      secretAllowlist: ["OPENAI_API_KEY"],
    });

    expect(backend.policy).toMatchObject({
      version: 1,
      image: "nitely-runner:test",
      engineCommand: "docker",
      network: { mode: "none" },
      identity: { uid: 0, gid: 0, strategy: "rootless-container-root" },
      environment: {
        allowedNames: ["LANG"],
        secretNames: ["OPENAI_API_KEY"],
      },
      mounts: {
        worktree: "capability-scoped",
        runArtifacts: "read-only",
        attemptOutput: "read-write",
      },
      resources: expect.objectContaining({ cpus: 1, pids: 128 }),
    });
  });

  it.each([
    ["CPU limit", { resources: { cpus: 0 } }, /resources\.cpus.*positive/],
    [
      "memory limit",
      { resources: { memoryBytes: 1.5 } },
      /resources\.memoryBytes.*positive integer/,
    ],
    ["PID limit", { resources: { pids: Number.NaN } }, /resources\.pids.*positive integer/],
    [
      "captured output limit",
      { resources: { maxCapturedOutputBytes: Number.POSITIVE_INFINITY } },
      /resources\.maxCapturedOutputBytes.*positive integer/,
    ],
    ["UID", { uid: -1 }, /uid.*non-negative integer/],
    ["GID", { gid: 1.5 }, /gid.*non-negative integer/],
    ["engine command", { engineCommand: "   " }, /engineCommand.*non-empty/],
    ["image reference", { image: "--privileged" }, /invalid OCI image reference/],
  ])("rejects an invalid %s in direct constructor options", (_label, invalid, message) => {
    expect(
      () =>
        new OciExecutionBackend({
          image: "nitely-runner:test",
          ...(invalid as Partial<OciExecutionBackendOptions>),
        }),
    ).toThrow(message as RegExp);
  });

  it("rejects an invalid generated container name before invoking Docker", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      containerName: () => "--security-opt=seccomp=unconfined",
      processRunner: successfulRunner(calls),
    });

    await expect(
      backend.runCommand(
        { runId: "invalid-name", path: fixture.worktree },
        "echo unsafe",
        { outputDirectory: fixture.attempt },
      ),
    ).rejects.toThrow(/invalid OCI container name/);
    expect(calls).toHaveLength(0);
  });

  it("loads explicit allowlists and resource limits from backend environment configuration", () => {
    const backend = createExecutionBackend({
      backend: "oci",
      env: {
        NITELY_OCI_IMAGE: "configured-runner:test",
        NITELY_OCI_ENGINE_COMMAND: "docker",
        NITELY_OCI_ENV_ALLOWLIST: "LANG, CI,LANG",
        NITELY_OCI_SECRET_ALLOWLIST: "OPENAI_API_KEY, ANTHROPIC_API_KEY",
        NITELY_OCI_CPUS: "2.5",
        NITELY_OCI_MEMORY_BYTES: "536870912",
        NITELY_OCI_PIDS: "80",
        NITELY_OCI_TMPFS_BYTES: "33554432",
        NITELY_OCI_MAX_FILE_BYTES: "16777216",
        NITELY_OCI_MAX_CAPTURED_OUTPUT_BYTES: "1048576",
        NITELY_OCI_TIMEOUT_MS: "90000",
        NITELY_OCI_UID: "0",
        NITELY_OCI_GID: "0",
      },
    });

    expect(backend.describeExecution?.()).toMatchObject({
      image: "configured-runner:test",
      environment: {
        allowedNames: ["CI", "LANG"],
        secretNames: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
        valuesRecorded: false,
      },
      resources: {
        cpus: 2.5,
        memoryBytes: 536_870_912,
        pids: 80,
        tmpfsBytes: 33_554_432,
        maxFileBytes: 16_777_216,
        maxCapturedOutputBytes: 1_048_576,
        timeoutMs: 90_000,
      },
    });
    expect((backend as OciExecutionBackend).policy.identity).toEqual({
      uid: 0,
      gid: 0,
      strategy: "explicit",
    });
  });

  it("fails closed when an unsupported aggregate bind-mount disk quota is requested", () => {
    expect(() =>
      createExecutionBackend({
        backend: "oci",
        env: {
          NITELY_OCI_IMAGE: "configured-runner:test",
          NITELY_OCI_DISK_BYTES: "1073741824",
        },
      }),
    ).toThrow(
      /aggregate bind-mount disk quota is not supported[\s\S]*NITELY_OCI_MAX_FILE_BYTES[\s\S]*NITELY_OCI_MAX_CAPTURED_OUTPUT_BYTES/,
    );
  });

  it("prepares the exact in-container prompt for durable prompt evidence", async () => {
    const fixture = await createFixture();
    const backend = new OciExecutionBackend({ image: "nitely-runner:test" });

    await expect(
      backend.prepareAgentPrompt({
        workspace: { runId: "prompt", path: fixture.worktree },
        attemptDirectory: fixture.attempt,
        prompt: `Read ${join(fixture.runRoot, "inputs", "issue.md")} and write ${fixture.attempt}.`,
      }),
    ).resolves.toBe(
      "Read /nitely/run/inputs/issue.md and write /nitely/output.",
    );
  });

  it("fails closed when an empty path scope cannot be represented safely", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
      runtimeRegistry: offlineRuntimeRegistry(),
    });

    await expect(
      backend.runAgent(
        { runId: "empty-scope", path: fixture.worktree },
        {
          stage: agentStage(
            sandboxCapabilities({
              read: { scope: "approved inputs", allow: [] },
            }),
          ),
          prompt: "Implement.",
          attemptDirectory: fixture.attempt,
        },
      ),
    ).rejects.toThrow(/cannot enforce empty read scope approved inputs/);
    expect(calls).toHaveLength(0);
  });

  it("rejects write scopes outside the task worktree", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
      runtimeRegistry: offlineRuntimeRegistry(),
    });

    await expect(
      backend.runAgent(
        { runId: "write-scope", path: fixture.worktree },
        {
          stage: agentStage(
            sandboxCapabilities({
              write: { scope: "host", allow: [] },
            }),
          ),
          prompt: "Implement.",
          attemptDirectory: fixture.attempt,
        },
      ),
    ).rejects.toThrow(/cannot enforce write scope host/);
    expect(calls).toHaveLength(0);
  });

  it("enforces runtime allowlists again at the sandbox boundary", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
    });

    await expect(
      backend.runAgent(
        { runId: "runtime-denied", path: fixture.worktree },
        {
          stage: agentStage(
            sandboxCapabilities({ allowedRuntimes: ["claude"] }),
          ),
          prompt: "Implement.",
          attemptDirectory: fixture.attempt,
        },
      ),
    ).rejects.toThrow(/does not allow runtime "codex"/);
    expect(calls).toHaveLength(0);
  });

  it("enforces model allowlists again at the sandbox boundary", async () => {
    const fixture = await createFixture();
    const calls: SandboxProcessInput[] = [];
    const backend = new OciExecutionBackend({
      image: "nitely-runner:test",
      processRunner: successfulRunner(calls),
    });

    await expect(
      backend.runAgent(
        { runId: "model-denied", path: fixture.worktree },
        {
          stage: {
            ...agentStage(
              sandboxCapabilities({ allowedModels: ["approved-model"] }),
            ),
            model: "unapproved-model",
          },
          prompt: "Implement.",
          attemptDirectory: fixture.attempt,
        },
      ),
    ).rejects.toThrow(/does not allow model "unapproved-model"/);
    expect(calls).toHaveLength(0);
  });

  it.runIf(
    process.env.NITELY_TEST_ROOTLESS_DOCKER === "1" &&
      Boolean(process.env.NITELY_OCI_TEST_IMAGE),
  )("writes worktree and output bind mounts through a real rootless Docker daemon", async () => {
    const fixture = await createFixture();
    const backend = new OciExecutionBackend({
      image: process.env.NITELY_OCI_TEST_IMAGE!,
    });

    await expect(
      backend.runCommand(
        { runId: "real-rootless", path: fixture.worktree },
        "printf worktree > rootless-write.txt; printf output > \"$NITELY_OUTPUT_DIR/result.txt\"",
        { outputDirectory: fixture.attempt, timeoutMs: 30_000 },
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      readFile(join(fixture.worktree, "rootless-write.txt"), "utf8"),
    ).resolves.toBe("worktree");
    await expect(
      readFile(join(fixture.attempt, "result.txt"), "utf8"),
    ).resolves.toBe("output");
  });

  it.runIf(
    process.platform === "linux" &&
      process.env.NITELY_TEST_ROOTLESS_DOCKER === "1" &&
      Boolean(process.env.NITELY_OCI_TEST_IMAGE),
  )("blocks direct sockets even when an allowlisted gateway is configured", async () => {
    const fixture = await createFixture();
    const backend = new OciExecutionBackend({
      image: process.env.NITELY_OCI_TEST_IMAGE!,
      networkAllowlist: ["example.com"],
      runtimeRegistry: directSocketRuntimeRegistry(),
    });

    await expect(
      backend.runAgent(
        { runId: "real-network-boundary", path: fixture.worktree },
        {
          stage: agentStage(
            sandboxCapabilities({
              network: {
                mode: "restricted",
                advisory: false,
                domains: ["example.com"],
              },
            }),
          ),
          prompt: "Verify the direct socket boundary.",
          attemptDirectory: fixture.attempt,
          timeoutMs: 30_000,
        },
      ),
    ).resolves.toMatchObject({ stdout: "", stderr: "" });
  });
});
