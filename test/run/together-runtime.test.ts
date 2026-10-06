import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import { FileProviderConnectionStore } from "../../src/providers/file-store.js";
import { projectRun } from "../../src/run/project.js";
import { runFlow } from "../../src/run/run-flow.js";

const execFileAsync = promisify(execFile);

const STORED_KEY = "stored-together-key-0123456789";
const ENV_KEY = "env-together-key-0123456789";

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "nitely-together-repo-"));
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "nitely@example.test"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Nitely Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "# Test Repo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });
  return repo;
}

async function writeTogetherFlow(repo: string, model: string | undefined): Promise<string> {
  const flowPath = join(repo, "flows", "together.json");
  await mkdir(dirname(flowPath), { recursive: true });
  await writeFile(
    flowPath,
    JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "together" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "together",
            ...(model ? { model } : {}),
            prompt: "Implement with Together AI.",
            inputs: [],
            outputs: ["implementation"],
          },
        ],
      },
    }),
    "utf8",
  );
  return flowPath;
}

/**
 * A stand-in for the Pi CLI: records its arguments and which credential it
 * received (never the credential itself), then either writes the stage output
 * or fails like Pi does when Together AI rejects the key.
 */
async function writeFakePi(repo: string, mode: "succeed" | "reject-key"): Promise<string> {
  const path = join(repo, `fake-pi-${mode}.sh`);
  const lines = [
    "#!/bin/sh",
    "cat > /dev/null",
    "printf '%s\\n' \"$@\" > \"$NITELY_ATTEMPT_DIR/pi-args.txt\"",
    `if [ "$TOGETHER_API_KEY" = "${STORED_KEY}" ]; then echo stored; elif [ "$TOGETHER_API_KEY" = "${ENV_KEY}" ]; then echo environment; else echo none; fi > "$NITELY_ATTEMPT_DIR/key-source.txt"`,
    mode === "succeed"
      ? "printf 'done\\n' > \"$NITELY_ATTEMPT_DIR/implementation.md\""
      : "echo '401 Invalid API key provided.' >&2; exit 1",
    "",
  ];
  await writeFile(path, lines.join("\n"), "utf8");
  await chmod(path, 0o755);
  return path;
}

async function providerStore(repo: string, piCommand: string, stored: boolean) {
  const store = new FileProviderConnectionStore({
    path: join(repo, ".nitely", "connections.json"),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TOGETHER_API_KEY: ENV_KEY,
      NITELY_PI_COMMAND: piCommand,
    },
    commandStatus: async () => true,
  });
  if (stored) {
    await store.setConnection({
      providerId: "together",
      authMethod: "api_key",
      value: STORED_KEY,
      label: "Together AI",
      metadata: { scope: "repo", source: "web-console" },
    });
  }
  return store;
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

async function expectNoSecretPersisted(repo: string, runId: string): Promise<void> {
  const eventFiles = (await readdir(join(repo, ".nitely")))
    .filter((name) => name.startsWith("events.db"))
    .map((name) => join(repo, ".nitely", name));
  const paths = [...(await filesUnder(join(repo, ".nitely", "runs", runId))), ...eventFiles];
  expect(paths.length).toBeGreaterThan(eventFiles.length);
  expect(eventFiles).toContain(join(repo, ".nitely", "events.db"));
  for (const path of paths) {
    const content = await readFile(path);
    expect(content.includes(STORED_KEY), path).toBe(false);
    expect(content.includes(ENV_KEY), path).toBe(false);
  }
}

describe("together agent runtime", () => {
  it("runs a Together AI stage through Pi with the Web Console connection taking precedence", async () => {
    const repo = await createRepo();
    const flowPath = await writeTogetherFlow(repo, "moonshotai/Kimi-K3");
    const store = await providerStore(repo, await writeFakePi(repo, "succeed"), true);

    const result = await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      { createRunId: () => "run-together", providerStore: store },
    );

    expect(result.runId).toBe("run-together");
    const events = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(events.list("run-together"));
    events.close();
    expect(projection).toMatchObject({ status: "completed", completedStages: ["implement"] });

    const attempt = join(repo, ".nitely", "runs", "run-together", "stages", "implement", "1");
    await expect(readFile(join(attempt, "pi-args.txt"), "utf8")).resolves.toBe(
      "-p\n--provider\ntogether\n--model\nmoonshotai/Kimi-K3\n",
    );
    await expect(readFile(join(attempt, "key-source.txt"), "utf8")).resolves.toBe("stored\n");
    await expectNoSecretPersisted(repo, "run-together");
  });

  it("falls back to TOGETHER_API_KEY from the environment without a stored connection", async () => {
    const repo = await createRepo();
    const flowPath = await writeTogetherFlow(repo, "moonshotai/Kimi-K3");
    const store = await providerStore(repo, await writeFakePi(repo, "succeed"), false);

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      { createRunId: () => "run-together-env", providerStore: store },
    );

    const attempt = join(repo, ".nitely", "runs", "run-together-env", "stages", "implement", "1");
    await expect(readFile(join(attempt, "key-source.txt"), "utf8")).resolves.toBe("environment\n");
  });

  it("blocks the run on a rejected Together AI key with an actionable message", async () => {
    const repo = await createRepo();
    const flowPath = await writeTogetherFlow(repo, "moonshotai/Kimi-K3");
    const store = await providerStore(repo, await writeFakePi(repo, "reject-key"), true);

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        { createRunId: () => "run-together-rejected", providerStore: store },
      ),
    ).rejects.toThrow(/run blocked by agent_credentials_invalid on stage implement/);

    const events = new EventStore(join(repo, ".nitely", "events.db"));
    const projection = projectRun(events.list("run-together-rejected"));
    events.close();
    expect(projection).toMatchObject({
      status: "blocked",
      blocker: {
        reason: "agent_credentials_invalid",
        stageId: "implement",
        runtime: "together",
        message: expect.stringMatching(/Together AI rejected the API key.*TOGETHER_API_KEY/s),
      },
    });
    await expectNoSecretPersisted(repo, "run-together-rejected");
  });

  it("fails a Together AI stage without a model before starting Pi", async () => {
    const repo = await createRepo();
    const flowPath = await writeTogetherFlow(repo, undefined);
    const store = await providerStore(repo, await writeFakePi(repo, "succeed"), true);

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        { createRunId: () => "run-together-no-model", providerStore: store },
      ),
    ).rejects.toThrow(/agent runtime together requires a Together AI model id/);

    const attempt = join(repo, ".nitely", "runs", "run-together-no-model", "stages", "implement", "1");
    await expect(readFile(join(attempt, "pi-args.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
