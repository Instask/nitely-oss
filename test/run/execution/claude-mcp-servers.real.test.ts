import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  claudeMcpProbeArgs,
  parseClaudeInitMcpServers,
  withClaudeStrictMcpConfig,
} from "../../../src/run/execution/mcp-servers.js";

const execFileAsync = promisify(execFile);
const CLAUDE = process.env.NITELY_CLAUDE_COMMAND?.trim() || "claude";

async function runClaude(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(CLAUDE, args, {
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

describe("claude MCP restriction (real CLI)", () => {
  it("loads only --mcp-config servers under --strict-mcp-config", async () => {
    // Must fail (not skip) when the binary is missing — acceptance for #727.
    await execFileAsync(CLAUDE, ["--version"], { timeout: 15_000 });

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
  }, 60_000);
});
