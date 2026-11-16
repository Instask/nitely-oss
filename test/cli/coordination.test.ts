import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../../src/cli.js";
import { listUnknownWorkClaims, runGuardedMutation } from "../../src/coordination/claims.js";

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) } };
}

async function unknownClaim(repoPath: string, key: string): Promise<void> {
  await expect(runGuardedMutation({
    repoPath,
    domains: ["action:update:acme/widgets#22", "github-pr:acme/widgets#22"],
    observedAt: new Date().toISOString(),
    runId: "run-crashed",
    idempotencyKey: key,
    effect: async () => {
      throw new Error("push rejected");
    },
    resultOf: () => ({ head: "none" }),
  })).rejects.toThrow("push rejected");
}

describe("nitely coordination", () => {
  it("lists unknown claims and resolves one as not applied", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-cli-coordination-"));
    await unknownClaim(repoPath, "update:run-crashed:publish:acme/widgets#22");

    const listed = capture();
    expect(await runCli(["coordination", "unknown", "--repo", repoPath], listed.io)).toBe(0);
    expect(listed.stdout.join("\n")).toContain("update:run-crashed:publish:acme/widgets#22\trun run-crashed");

    const resolved = capture();
    expect(await runCli([
      "coordination", "resolve", "update:run-crashed:publish:acme/widgets#22", "--not-applied", "--repo", repoPath,
    ], resolved.io)).toBe(0);
    expect(resolved.stdout.join("\n")).toContain("resolved as not-applied for run run-crashed");
    expect(listUnknownWorkClaims(repoPath)).toEqual([]);
  });

  it("refuses an applied answer without the pushed head, and ambiguous answers", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-cli-coordination-"));
    await unknownClaim(repoPath, "lost");

    for (const argv of [
      ["coordination", "resolve", "lost", "--applied", "--repo", repoPath],
      ["coordination", "resolve", "lost", "--applied", "--not-applied", "--repo", repoPath],
      ["coordination", "resolve", "lost", "--not-applied", "--head", "abcdef1", "--repo", repoPath],
      ["coordination", "resolve", "lost", "--applied", "--head", "abcdef1", "--url", "https://evil.test/x", "--repo", repoPath],
      ["coordination", "resolve", "--applied"],
    ]) {
      const out = capture();
      expect(await runCli(argv, out.io)).toBe(1);
      expect(out.stderr.join("\n")).not.toBe("");
    }
    expect(listUnknownWorkClaims(repoPath)).toHaveLength(1);

    const applied = capture();
    expect(await runCli([
      "coordination", "resolve", "lost", "--applied", "--head", "abcdef1",
      "--url", "https://github.com/acme/widgets/pull/22", "--repo", repoPath,
    ], applied.io)).toBe(0);
    expect(listUnknownWorkClaims(repoPath)).toEqual([]);
  });
});
