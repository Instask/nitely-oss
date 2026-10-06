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

const STORED_KEY = "sk-or-v1-stored-openrouter-key-0123456789";
const ENV_KEY = "sk-or-v1-env-openrouter-key-0123456789";

// What the real Pi CLI prints when OpenRouter rejects a key (captured from Pi
// 1.0.4 against https://openrouter.ai/api/v1 with an invalid key).
const PI_REJECTED_KEY_STDERR = '401: {"message":"User not found.","code":401}';
const PI_RATE_LIMIT_STDERR =
  '429: {"message":"Rate limit exceeded: free-models-per-min. ","code":429}';
const PI_NO_ENDPOINTS_STDERR =
  '404: {"message":"No endpoints found for qwen/qwen3-coder-next.","code":404}';

type FakePiMode = "succeed" | "reject-key" | "rate-limit-first-model" | "no-endpoints";

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "nitely-openrouter-repo-"));
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "nitely@example.test"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Nitely Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "# Test Repo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });
  return repo;
}

async function writeFlow(repo: string, stage: Record<string, unknown>): Promise<string> {
  const flowPath = join(repo, "flows", "openrouter.json");
  await mkdir(dirname(flowPath), { recursive: true });
  await writeFile(
    flowPath,
    JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "openrouter" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            prompt: "Implement with an OpenRouter model.",
            inputs: [],
            outputs: ["implementation"],
            ...stage,
          },
        ],
      },
    }),
    "utf8",
  );
  return flowPath;
}

/**
 * A stand-in for the Pi CLI. It records its arguments (appending, so retried
 * and fallback attempts are visible) and which credential it received — never
 * the credential itself — then uses its tools the way Pi would: it edits a file
 * in the worktree and writes the stage artifact. Failure modes print what Pi
 * prints for the matching OpenRouter response.
 */
async function writeFakePi(repo: string, mode: FakePiMode): Promise<string> {
  const path = join(repo, `fake-pi-${mode}.sh`);
  const fail = (stderr: string) => `printf '%s\\n' '${stderr}' >&2; exit 1`;
  const lines = [
    "#!/bin/sh",
    "cat > /dev/null",
    "printf '%s\\n' \"$@\" >> \"$NITELY_ATTEMPT_DIR/pi-args.txt\"",
    `if [ "$OPENROUTER_API_KEY" = "${STORED_KEY}" ]; then echo stored; elif [ "$OPENROUTER_API_KEY" = "${ENV_KEY}" ]; then echo environment; else echo none; fi > "$NITELY_ATTEMPT_DIR/key-source.txt"`,
    "model=\"$5\"",
    "echo 'Warning: Model \"x\" not found for provider \"openrouter\". Using custom model id.' >&2",
  ];
  if (mode === "reject-key") lines.push(fail(PI_REJECTED_KEY_STDERR));
  if (mode === "no-endpoints") lines.push(fail(PI_NO_ENDPOINTS_STDERR));
  if (mode === "rate-limit-first-model") {
    lines.push(`if [ "$model" = "openrouter/qwen/qwen3-coder-next:free" ]; then ${fail(PI_RATE_LIMIT_STDERR)}; fi`);
  }
  lines.push(
    "printf 'edited by %s\\n' \"$model\" > OPENROUTER.md",
    "printf 'done with %s\\n' \"$model\" > \"$NITELY_ATTEMPT_DIR/implementation.md\"",
    "",
  );
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
      OPENROUTER_API_KEY: ENV_KEY,
      NITELY_PI_COMMAND: piCommand,
    },
    commandStatus: async () => true,
  });
  if (stored) {
    await store.setConnection({
      providerId: "openrouter",
      authMethod: "api_key",
      value: STORED_KEY,
      label: "OpenRouter",
      metadata: { scope: "repo", source: "web-console" },
    });
  }
  return store;
}

function project(repo: string, runId: string) {
  const events = new EventStore(join(repo, ".nitely", "events.db"));
  try {
    return { projection: projectRun(events.list(runId)), events: events.list(runId) };
  } finally {
    events.close();
  }
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

const attemptDir = (repo: string, runId: string, attempt = 1) =>
  join(repo, ".nitely", "runs", runId, "stages", "implement", String(attempt));

describe("openrouter agent runtime", () => {
  it("runs an OpenRouter model through Pi with the Web Console connection taking precedence", async () => {
    const repo = await createRepo();
    const flowPath = await writeFlow(repo, { runtime: "openrouter", model: "qwen/qwen3-coder-next" });
    const store = await providerStore(repo, await writeFakePi(repo, "succeed"), true);

    const result = await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      { createRunId: () => "run-or", providerStore: store },
    );

    expect(result.runId).toBe("run-or");
    expect(project(repo, "run-or").projection).toMatchObject({
      status: "completed",
      completedStages: ["implement"],
    });
    const attempt = attemptDir(repo, "run-or");
    await expect(readFile(join(attempt, "pi-args.txt"), "utf8")).resolves.toBe(
      "-p\n--provider\nopenrouter\n--model\nopenrouter/qwen/qwen3-coder-next\n",
    );
    await expect(readFile(join(attempt, "key-source.txt"), "utf8")).resolves.toBe("stored\n");
    await expect(readFile(join(attempt, "implementation.md"), "utf8")).resolves.toBe(
      "done with openrouter/qwen/qwen3-coder-next\n",
    );
    await expectNoSecretPersisted(repo, "run-or");
  });

  it("falls back to OPENROUTER_API_KEY from the environment without a stored connection", async () => {
    const repo = await createRepo();
    const flowPath = await writeFlow(repo, { runtime: "openrouter", model: "qwen/qwen3-coder-next" });
    const store = await providerStore(repo, await writeFakePi(repo, "succeed"), false);

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      { createRunId: () => "run-or-env", providerStore: store },
    );

    await expect(
      readFile(join(attemptDir(repo, "run-or-env"), "key-source.txt"), "utf8"),
    ).resolves.toBe("environment\n");
    await expectNoSecretPersisted(repo, "run-or-env");
  });

  it("blocks the run on a rejected OpenRouter key with an actionable message", async () => {
    const repo = await createRepo();
    const flowPath = await writeFlow(repo, { runtime: "openrouter", model: "qwen/qwen3-coder-next" });
    const store = await providerStore(repo, await writeFakePi(repo, "reject-key"), true);

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        { createRunId: () => "run-or-rejected", providerStore: store },
      ),
    ).rejects.toThrow(/run blocked by agent_credentials_invalid on stage implement/);

    expect(project(repo, "run-or-rejected").projection).toMatchObject({
      status: "blocked",
      blocker: {
        reason: "agent_credentials_invalid",
        stageId: "implement",
        runtime: "openrouter",
        message: expect.stringMatching(/OpenRouter rejected the API key \(401\).*OPENROUTER_API_KEY/s),
      },
    });
    await expectNoSecretPersisted(repo, "run-or-rejected");
  });

  it("routes to the next OpenRouter model when the first one is rate limited", async () => {
    const repo = await createRepo();
    const flowPath = await writeFlow(repo, {
      runtimes: [
        { runtime: "openrouter", model: "qwen/qwen3-coder-next:free" },
        { runtime: "openrouter", model: "moonshotai/kimi-k3" },
      ],
    });
    const store = await providerStore(repo, await writeFakePi(repo, "rate-limit-first-model"), true);

    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      { createRunId: () => "run-or-fallback", providerStore: store },
    );

    const { projection, events } = project(repo, "run-or-fallback");
    expect(projection).toMatchObject({ status: "completed", completedStages: ["implement"] });
    const fallback = events.find((event) => event.type === "stage.runtime.fallback");
    expect(fallback?.payload).toMatchObject({
      failedRuntime: "openrouter",
      failedModel: "qwen/qwen3-coder-next:free",
      nextRuntime: "openrouter",
      nextModel: "moonshotai/kimi-k3",
      blocker: {
        reason: "agent_usage_limit",
        message: expect.stringContaining("OpenRouter rate limit reached for model qwen/qwen3-coder-next:free"),
      },
    });
    await expect(
      readFile(join(attemptDir(repo, "run-or-fallback", 1), "pi-args.txt"), "utf8"),
    ).resolves.toBe("-p\n--provider\nopenrouter\n--model\nopenrouter/qwen/qwen3-coder-next:free\n");
    await expect(
      readFile(join(attemptDir(repo, "run-or-fallback", 2), "pi-args.txt"), "utf8"),
    ).resolves.toBe("-p\n--provider\nopenrouter\n--model\nopenrouter/moonshotai/kimi-k3\n");
    await expect(
      readFile(join(attemptDir(repo, "run-or-fallback", 2), "implementation.md"), "utf8"),
    ).resolves.toBe("done with openrouter/moonshotai/kimi-k3\n");
    await expectNoSecretPersisted(repo, "run-or-fallback");
  });

  it("fails an unavailable model as an ordinary stage failure that honours maxAttempts", async () => {
    const repo = await createRepo();
    const flowPath = await writeFlow(repo, {
      runtime: "openrouter",
      model: "qwen/qwen3-coder-next",
      maxAttempts: 2,
    });
    const store = await providerStore(repo, await writeFakePi(repo, "no-endpoints"), true);

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        { createRunId: () => "run-or-404", providerStore: store },
      ),
    ).rejects.toThrow(/OpenRouter has no available endpoint for model qwen\/qwen3-coder-next/);

    const { projection, events } = project(repo, "run-or-404");
    expect(projection.status).toBe("failed");
    expect(events.filter((event) => event.type === "stage.started")).toHaveLength(2);
    await expectNoSecretPersisted(repo, "run-or-404");
  });

  it("fails an OpenRouter stage without a model before starting Pi", async () => {
    const repo = await createRepo();
    const flowPath = await writeFlow(repo, { runtime: "openrouter" });
    const store = await providerStore(repo, await writeFakePi(repo, "succeed"), true);

    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        { createRunId: () => "run-or-no-model", providerStore: store },
      ),
    ).rejects.toThrow(/runtime openrouter requires a model/);

    await expect(
      readFile(join(attemptDir(repo, "run-or-no-model"), "pi-args.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
