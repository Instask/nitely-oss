import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");

async function readRepoFile(path: string): Promise<string> {
  return readFile(join(repositoryRoot, path), "utf8");
}

describe("mobile support boundary docs", () => {
  it("documents browser access, native app status, and on-device runner limits", async () => {
    const doc = await readRepoFile("docs/mobile-support-boundary.md");

    expect(doc).toContain("Mobile browser access to a reachable Web Console is supported");
    expect(doc).toContain("Nitely execution still runs on the desktop or server host");
    expect(doc).toContain("Native iOS and Android apps are not currently supported");
    expect(doc).toContain("On-device iOS and Android runners are not supported");
    expect(doc).toContain("Node.js 24");
    expect(doc).toContain("Git worktrees");
    expect(doc).toContain("local agent CLIs");
    expect(doc).toContain("server-hosted runner");
  });

  it("links the support boundary from the README", async () => {
    const readme = await readRepoFile("README.md");

    expect(readme).toContain("(docs/mobile-support-boundary.md)");
  });

  it("links the support boundary from the Chinese README", async () => {
    const readme = await readRepoFile("README.zh-CN.md");

    expect(readme).toContain("(docs/mobile-support-boundary.md)");
  });
});
