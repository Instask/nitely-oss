import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = resolve("scripts/nitely-prod-web-deploy");

describe("production deploy helper", () => {
  it("documents dirty remote worktree handling in help output", async () => {
    const { stdout } = await execFileAsync(script, ["--help"]);

    expect(stdout).toContain("--dirty-mode MODE");
    expect(stdout).toContain("--node-bin PATH");
    expect(stdout).toContain("Default: stash");
    expect(stdout).toContain("NITELY_DEPLOY_REMOTE");
    expect(stdout).toContain("NITELY_PROD_NODE_BIN");
  });

  it("rejects invalid dirty modes before opening an SSH connection", async () => {
    try {
      await execFileAsync(script, ["--dirty-mode", "overwrite"]);
      throw new Error("expected deploy helper to reject invalid dirty mode");
    } catch (error) {
      const failure = error as Error & { code?: number; stderr?: string };
      expect(failure.code).toBe(64);
      expect(failure.stderr).toContain("invalid --dirty-mode overwrite");
    }
  });

  it("requires the deployment target instead of assuming a host", async () => {
    try {
      await execFileAsync(script, [], {
        env: { ...process.env, NITELY_DEPLOY_REMOTE: "", NITELY_PROD_DIR: "" },
      });
      throw new Error("expected deploy helper to require --remote");
    } catch (error) {
      const failure = error as Error & { code?: number; stderr?: string };
      expect(failure.code).toBe(64);
      expect(failure.stderr).toContain("missing --remote");
    }
  });
});
