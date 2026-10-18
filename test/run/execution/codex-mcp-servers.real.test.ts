import { execFile, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { LocalExecutionBackend } from "../../../src/run/execution/local.js";
import {
  codexConfigOverrides,
  parseCodexMcpList,
} from "../../../src/run/execution/mcp-servers.js";
import type { AgentMcpServersRequest } from "../../../src/run/execution/types.js";
import type { Stage } from "../../../src/flow/schema.js";

const execFileAsync = promisify(execFile);

/**
 * These tests run the real Codex CLI, because the effective MCP server set is
 * Codex's own merge of its config layers and a fake that only inspects argv
 * cannot see a trusted project's `.codex/config.toml`. `codex mcp list` needs
 * no credentials and makes no model call; the agent launch itself is a fake
 * spawn. CI sets NITELY_TEST_CODEX_BIN to a pinned install and
 * NITELY_TEST_REQUIRE_CODEX=1, so a missing binary fails instead of skipping.
 */
function findCodex(): string | undefined {
  const configured = process.env.NITELY_TEST_CODEX_BIN?.trim();
  if (configured) return configured;
  try {
    return execFileSync("sh", ["-c", "command -v codex"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

const codexBin = findCodex();
const requireCodex = process.env.NITELY_TEST_REQUIRE_CODEX === "1";

type AgentStage = Extract<Stage, { type: "agent" }>;

function codexStage(): AgentStage {
  return {
    id: "reflect",
    type: "agent",
    runtime: "codex",
    skills: [],
    required_mcp_servers: [],
    required_connectors: [],
    prompt: "reflect",
    inputs: [],
    outputs: ["notes"],
  };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

/**
 * A repository that commits a project `.codex/config.toml`, a linked worktree
 * of it (which is what Nitely runs stages in), and an operator Codex home whose
 * user config defines its own server and trusts the repository.
 */
async function trustedProjectFixture(projectConfig: string): Promise<{
  worktree: string;
  operatorHome: string;
  isolatedHome: string;
  home: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nitely-codex-mcp-")));
  const repo = join(root, "repo");
  await mkdir(join(repo, ".codex"), { recursive: true });
  await git(repo, ["init", "-q"]);
  await git(repo, ["config", "user.email", "test@example.invalid"]);
  await git(repo, ["config", "user.name", "Test"]);
  await writeFile(join(repo, ".codex", "config.toml"), projectConfig, "utf8");
  await writeFile(join(repo, "README.md"), "fixture\n", "utf8");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "fixture"]);
  const worktree = join(root, "worktree");
  await git(repo, ["worktree", "add", "-q", "-b", "stage", worktree]);

  const operatorHome = join(root, "operator-codex");
  await mkdir(operatorHome, { recursive: true });
  await writeFile(
    join(operatorHome, "config.toml"),
    [
      "[mcp_servers.userone]",
      'command = "true"',
      "",
      `[projects."${repo}"]`,
      'trust_level = "trusted"',
      "",
    ].join("\n"),
    "utf8",
  );
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  return { worktree, operatorHome, isolatedHome: join(root, "isolated", "codex"), home };
}

async function listServers(input: {
  codexHome: string;
  home: string;
  cwd: string;
  overrides?: string[];
}): Promise<Record<string, boolean>> {
  const { stdout } = await execFileAsync(
    codexBin!,
    [...(input.overrides ?? []), "mcp", "list", "--json"],
    {
      cwd: input.cwd,
      env: { PATH: process.env.PATH, HOME: input.home, CODEX_HOME: input.codexHome },
    },
  );
  const servers = parseCodexMcpList(stdout);
  if (!servers) throw new Error("codex mcp list printed no server list");
  return Object.fromEntries(servers.map((server) => [server.name, server.enabled]));
}

async function runStage(input: {
  fixture: Awaited<ReturnType<typeof trustedProjectFixture>>;
  mcpServers: AgentMcpServersRequest;
}) {
  const launches: string[][] = [];
  const backend = new LocalExecutionBackend({
    env: {
      PATH: process.env.PATH,
      HOME: input.fixture.home,
      CODEX_HOME: input.fixture.operatorHome,
      NITELY_CODEX_COMMAND: codexBin,
    },
    // The launch is faked so no model call happens; the MCP probe is real.
    spawn: (_command, args) => {
      launches.push([...args]);
      const child = new EventEmitter() as EventEmitter & { stdin: Writable };
      child.stdin = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
        final(callback) {
          queueMicrotask(() => child.emit("close", 0));
          callback();
        },
      });
      return child;
    },
  });
  const result = await backend.runAgent(
    { runId: "run-real-codex", path: input.fixture.worktree },
    {
      stage: codexStage(),
      prompt: "reflect",
      attemptDirectory: join(input.fixture.worktree, "..", "attempt"),
      globalSkills: { mode: "isolate-if-supported", homeDirectory: input.fixture.isolatedHome },
      mcpServers: input.mcpServers,
    },
  );
  return { result, launch: launches[0] ?? [] };
}

describe.skipIf(!codexBin && !requireCodex)("Codex MCP servers against the real Codex CLI", () => {
  it("has a Codex binary when CI requires one", () => {
    expect(codexBin, "NITELY_TEST_REQUIRE_CODEX=1 but no codex binary was found").toBeTruthy();
  });

  it.each(["declared-if-supported", "declared-required"] as const)(
    "turns off a trusted project's MCP server for a stage that declares none (%s)",
    async (mode) => {
      const fixture = await trustedProjectFixture('[mcp_servers.projone]\ncommand = "true"\n');
      // Without the trust entry's project layer this test would prove nothing.
      await expect(
        listServers({ codexHome: fixture.operatorHome, home: fixture.home, cwd: fixture.worktree }),
      ).resolves.toEqual({ projone: true, userone: true });

      const { result, launch } = await runStage({ fixture, mcpServers: { mode, declared: [] } });

      expect(result.mcpServers?.enforcement).toBe("enforced");
      expect([...(result.mcpServers?.disabled ?? [])].sort()).toEqual(["projone", "userone"]);
      expect(result.mcpServers?.enabled).toEqual([]);
      // What the launch carries is what Codex itself now reports.
      await expect(
        listServers({
          codexHome: fixture.isolatedHome,
          home: fixture.home,
          cwd: fixture.worktree,
          overrides: codexConfigOverrides(launch),
        }),
      ).resolves.toEqual({ projone: false, userone: false });
    },
    60_000,
  );

  it("keeps the project server a stage declares and turns off the rest", async () => {
    const fixture = await trustedProjectFixture('[mcp_servers.projone]\ncommand = "true"\n');
    const { result, launch } = await runStage({
      fixture,
      mcpServers: { mode: "declared-required", declared: ["projone"] },
    });

    expect(result.mcpServers).toEqual({
      enforcement: "enforced",
      enabled: ["projone"],
      disabled: ["userone"],
    });
    await expect(
      listServers({
        codexHome: fixture.isolatedHome,
        home: fixture.home,
        cwd: fixture.worktree,
        overrides: codexConfigOverrides(launch),
      }),
    ).resolves.toEqual({ projone: true, userone: false });
  }, 60_000);

  it("records a project server it cannot address as partial, and fails closed when required", async () => {
    const fixture = await trustedProjectFixture('[mcp_servers."proj.dotted"]\ncommand = "true"\n');

    const { result, launch } = await runStage({
      fixture,
      mcpServers: { mode: "declared-if-supported", declared: [] },
    });
    expect(result.mcpServers).toMatchObject({
      enforcement: "partial",
      enabled: ["proj.dotted"],
      disabled: ["userone"],
    });
    await expect(
      listServers({
        codexHome: fixture.isolatedHome,
        home: fixture.home,
        cwd: fixture.worktree,
        overrides: codexConfigOverrides(launch),
      }),
    ).resolves.toEqual({ "proj.dotted": true, userone: false });

    await expect(
      runStage({ fixture, mcpServers: { mode: "declared-required", declared: [] } }),
    ).rejects.toThrow(/requires only its declared MCP servers but codex cannot address MCP server name\(s\) proj\.dotted/);
  }, 60_000);
});
