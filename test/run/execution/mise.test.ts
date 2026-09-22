import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createExecutionBackend } from "../../../src/run/execution/backend.js";
import { MiseExecutionBackend } from "../../../src/run/execution/mise.js";
import { runFlow } from "../../../src/run/run-flow.js";
import type { Stage } from "../../../src/flow/schema.js";
import type { ProviderConnectionStore, ProviderId } from "../../../src/providers/types.js";

const execFileAsync = promisify(execFile);

type AgentStage = Extract<Stage, { type: "agent" }>;

interface SpawnCall {
  command: string;
  args: string[];
  cwd?: string;
  stdin: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

function agentStage(): AgentStage {
  return {
    id: "agent",
    type: "agent",
    runtime: "codex",
    skills: [],
    required_mcp_servers: [],
    required_connectors: [],
    prompt: "Run.",
    inputs: [],
    outputs: ["implementation"],
  };
}

async function createFakeMiseBin(logPath: string): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "nitely-mise-bin-"));
  const misePath = join(bin, "mise");
  await writeFile(
    misePath,
    `#!/bin/sh
echo "$@" >> "${logPath}"
if [ "$1" = "install" ]; then
  exit 0
fi
if [ "$1" = "exec" ] && [ "$2" = "--" ]; then
  shift 2
  in_env=0
  while IFS= read -r line; do
    case "$line" in
      "[env]")
        in_env=1
        continue
        ;;
      "["*"]")
        in_env=0
        ;;
    esac
    if [ "$in_env" = "1" ] && [ -n "$line" ]; then
      key=\${line%%=*}
      value=\${line#*=}
      key=\$(printf '%s' "$key" | sed 's/[[:space:]]//g')
      value=\$(printf '%s' "$value" | sed 's/^[[:space:]]*"//; s/"[[:space:]]*$//')
      export "$key=$value"
    fi
  done < mise.toml
  export NITELY_TEST_MISE_WRAPPED=1
  exec "$@"
fi
echo "unexpected mise invocation: $@" >&2
exit 64
`,
    "utf8",
  );
  await chmod(misePath, 0o755);
  return misePath;
}

async function git(cwd: string, args: string[]) {
  return await execFileAsync("git", args, { cwd });
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "nitely-mise-flow-"));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "nitely@example.test"]);
  await git(repo, ["config", "user.name", "Nitely Test"]);
  await writeFile(join(repo, "README.md"), "# Test\n", "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

function providerStoreWithEnv(
  env: Record<string, string | undefined>,
): ProviderConnectionStore {
  return {
    getConnection: async (providerId: ProviderId) => ({
      providerId,
      getAccessToken: async () => "token",
    }),
    resolveEnv: async () => env,
    listStatuses: async () => [],
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
      cwd: options.cwd,
      env: options.env,
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

describe("MiseExecutionBackend", () => {
  it("installs and executes command stages through mise when a toolchain file exists", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-mise-repo-"));
    await writeFile(join(repo, "mise.toml"), "[tools]\npython = '3.12'\n", "utf8");
    const logPath = join(repo, "mise.log");
    const miseCommand = await createFakeMiseBin(logPath);
    const backend = new MiseExecutionBackend({
      miseCommand,
    });

    const result = await backend.runCommand(
      { runId: "run-mise", path: repo },
      "printf \"$NITELY_TEST_MISE_WRAPPED\"",
    );

    expect(result).toEqual({ stdout: "1", stderr: "", exitCode: 0 });
    await expect(readFile(logPath, "utf8")).resolves.toContain("install");
    await expect(readFile(logPath, "utf8")).resolves.toContain("exec -- sh -c");
  });

  it("preserves runtime-owned command attempt metadata through mise exec", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-mise-command-env-"));
    const logPath = join(repo, "mise.log");
    const miseCommand = await createFakeMiseBin(logPath);
    const outputDirectory = join(
      repo,
      ".nitely",
      "runs",
      "run owned's",
      "stages",
      "release stage",
      "3",
    );
    try {
      await writeFile(
        join(repo, "mise.toml"),
        [
          "[tools]",
          "node = '24'",
          "",
          "[env]",
          'NITELY_OUTPUT_DIR = "/mise/output"',
          'NITELY_ATTEMPT_DIR = "/mise/attempt"',
          'NITELY_RUN_ID = "mise-run"',
          'NITELY_STAGE_ID = "mise-stage"',
          'NITELY_ATTEMPT = "41"',
          "",
        ].join("\n"),
        "utf8",
      );
      const backend = new MiseExecutionBackend({
        miseCommand,
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
          runId: "run owned's",
          stageId: "release stage",
          attempt: 3,
        },
      );

      expect(result.stdout).toBe(
        `${outputDirectory}|${outputDirectory}|run owned's|release stage|3\n`,
      );
      await expect(readFile(logPath, "utf8")).resolves.toContain(
        "exec -- env NITELY_OUTPUT_DIR=",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(dirname(miseCommand), { recursive: true, force: true });
    }
  });

  it("runs locally without invoking mise when no toolchain file exists", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-mise-nospec-"));
    const logPath = join(repo, "mise.log");
    const miseCommand = await createFakeMiseBin(logPath);
    const backend = new MiseExecutionBackend({
      miseCommand,
    });

    const result = await backend.runCommand(
      { runId: "run-local", path: repo },
      "printf \"${NITELY_TEST_MISE_WRAPPED:-local}\"",
    );

    expect(result).toEqual({ stdout: "local", stderr: "", exitCode: 0 });
    await expect(readFile(logPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("wraps agent runtimes with mise exec after provisioning the workspace", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-mise-agent-"));
    await writeFile(join(repo, ".tool-versions"), "node 24\n", "utf8");
    const logPath = join(repo, "mise.log");
    const miseCommand = await createFakeMiseBin(logPath);
    const calls: SpawnCall[] = [];
    const backend = new MiseExecutionBackend({
      miseCommand,
      spawn: createSuccessfulSpawn(calls),
    });

    await backend.runAgent(
      { runId: "run-agent", path: repo },
      {
        stage: agentStage(),
        prompt: "Implement.",
        attemptDirectory: join(repo, ".nitely", "runs", "run-agent", "stages", "agent", "1"),
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(miseCommand);
    expect(calls[0]?.args.slice(0, 3)).toEqual(["exec", "--", "codex"]);
    expect(calls[0]?.stdin).toBe("Implement.");
    await expect(readFile(logPath, "utf8")).resolves.toContain("install");
  });

  it("reports an actionable error when mise is not installed", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-mise-missing-"));
    await writeFile(join(repo, "mise.toml"), "[tools]\npython = '3.12'\n", "utf8");
    const backend = new MiseExecutionBackend({
      miseCommand: "nitely-missing-mise",
    });

    await expect(
      backend.runCommand({ runId: "run-missing", path: repo }, "python --version"),
    ).rejects.toThrow(/mise execution backend requires nitely-missing-mise/);
  });

  it("can be selected by the execution backend factory", () => {
    expect(createExecutionBackend({ backend: "local" }).constructor.name).toBe(
      "LocalExecutionBackend",
    );
    expect(createExecutionBackend({ backend: "mise" }).constructor.name).toBe(
      "MiseExecutionBackend",
    );
    expect(
      createExecutionBackend({
        backend: "oci",
        env: { NITELY_OCI_IMAGE: "nitely-runner:test" },
      }).constructor.name,
    ).toBe("OciExecutionBackend");
    expect(
      createExecutionBackend({
        backend: "docker",
        env: { NITELY_OCI_IMAGE: "nitely-runner:test" },
      }).constructor.name,
    ).toBe("OciExecutionBackend");
    expect(() => createExecutionBackend({ backend: "oci", env: {} })).toThrow(
      /NITELY_OCI_IMAGE/,
    );
  });

  it("uses NITELY_EXECUTION_BACKEND=mise when runFlow resolves the default backend", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "mise.toml"), "[tools]\npython = '3.12'\n", "utf8");
    const logPath = join(repo, "mise.log");
    const miseCommand = await createFakeMiseBin(logPath);
    const flowPath = join(repo, "flows", "mise-command.json");
    await writeJson(flowPath, {
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "mise-command" },
      spec: {
        stages: [
          {
            id: "test",
            type: "command",
            command: "printf \"$NITELY_TEST_MISE_WRAPPED\" > wrapped.txt",
            inputs: [],
            outputs: ["test-report"],
          },
        ],
      },
    });
    await git(repo, ["add", "mise.toml", "flows/mise-command.json"]);
    await git(repo, ["commit", "-m", "add mise flow"]);

    const result = await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      {
        createRunId: () => "run-mise-env",
        providerStore: providerStoreWithEnv({
          NITELY_EXECUTION_BACKEND: "mise",
          NITELY_MISE_COMMAND: miseCommand,
        }),
      },
    );

    await expect(readFile(join(result.worktreePath, "wrapped.txt"), "utf8")).resolves.toBe(
      "1",
    );
    await expect(readFile(logPath, "utf8")).resolves.toContain(
      "exec -- env NITELY_OUTPUT_DIR=",
    );
  });
});
