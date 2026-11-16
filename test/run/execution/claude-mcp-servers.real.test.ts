import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  claudeMcpProbeArgs,
  parseClaudeInitMcpServers,
  withClaudeStrictMcpConfig,
} from "../../../src/run/execution/mcp-servers.js";

const execFileAsync = promisify(execFile);

/**
 * Runs the real Claude Code CLI. Generic runners do not install it, so the
 * suite skips unless a binary is on PATH or named by NITELY_TEST_CLAUDE_BIN /
 * NITELY_CLAUDE_COMMAND. CI pins a binary and sets NITELY_TEST_REQUIRE_CLAUDE=1,
 * which fails instead of skipping when that pin is missing.
 */
function findClaude(): string | undefined {
  const configured =
    process.env.NITELY_TEST_CLAUDE_BIN?.trim() || process.env.NITELY_CLAUDE_COMMAND?.trim();
  if (configured) return configured;
  try {
    return execFileSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

const claudeBin = findClaude();
const requireClaude = process.env.NITELY_TEST_REQUIRE_CLAUDE === "1";

async function runClaude(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(claudeBin!, args, {
      cwd,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "sk-ant-api03-nitely-mcp-probe-invalid",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const err = error as { stdout?: string; message?: string };
    if (typeof err.stdout === "string" && err.stdout.length > 0) return err.stdout;
    throw error;
  }
}

describe.skipIf(!claudeBin && !requireClaude)("claude MCP restriction (real CLI)", () => {
  it("has a Claude binary when CI requires one", () => {
    expect(claudeBin, "NITELY_TEST_REQUIRE_CLAUDE=1 but no claude binary was found").toBeTruthy();
  });

  it.skipIf(!claudeBin)(
    "loads only --mcp-config servers under --strict-mcp-config",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "nitely-claude-mcp-real-"));
      try {
        await writeFile(
          join(root, ".mcp.json"),
          `${JSON.stringify({ mcpServers: { sneaky: { command: "true", args: [] } } })}\n`,
        );
        const empty = join(root, "empty.json");
        const kept = join(root, "kept.json");
        await writeFile(empty, `${JSON.stringify({ mcpServers: {} })}\n`);
        await writeFile(
          kept,
          `${JSON.stringify({ mcpServers: { kept: { command: "true", args: [] } } })}\n`,
        );

        const open = parseClaudeInitMcpServers(
          await runClaude(root, [
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-prompts",
            "none",
            "x",
          ]),
        );
        expect(open?.map((s) => s.name)).toContain("sneaky");

        const strictEmpty = parseClaudeInitMcpServers(
          await runClaude(root, claudeMcpProbeArgs(empty)),
        );
        expect(strictEmpty).toEqual([]);

        const strictKept = parseClaudeInitMcpServers(
          await runClaude(root, claudeMcpProbeArgs(kept)),
        );
        expect(strictKept?.map((s) => s.name)).toEqual(["kept"]);
        expect(withClaudeStrictMcpConfig(["-p"], kept)[0]).toBe("--strict-mcp-config");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
