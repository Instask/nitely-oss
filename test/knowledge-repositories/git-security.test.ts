import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ProviderConnectionStore } from "../../src/providers/types.js";
import {
  refreshKnowledgeGitSnapshot,
  type KnowledgeGitCommandInput,
  type KnowledgeGitCommandRunner,
} from "../../src/knowledge-repositories/git.js";
import { resolveKnowledgeRepositoryPaths } from "../../src/knowledge-repositories/paths.js";

describe("knowledge Git transport isolation", () => {
  it("keeps GitHub tokens out of argv and scrubs inherited Git/config/proxy state", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-kb-git-"));
    const targetRepoPath = await mkdtemp(join(root, "target-"));
    const paths = await resolveKnowledgeRepositoryPaths({
      targetRepoPath,
      runtimeRoot: join(root, "runtime"),
    });
    const token = "github_pat_fixture_secret_123456789";
    const calls: KnowledgeGitCommandInput[] = [];
    const commitSha = "a".repeat(40);
    const runner: KnowledgeGitCommandRunner = async (input) => {
      calls.push(structuredClone(input));
      if (input.args[0] === "init") {
        await mkdir(input.args.at(-1)!, { recursive: true });
      }
      if (input.args.includes("rev-parse")) {
        return { stdout: Buffer.from(`${commitSha}\n`), stderr: Buffer.alloc(0) };
      }
      if (input.args.includes("cat-file")) {
        return { stdout: Buffer.from("commit\n"), stderr: Buffer.alloc(0) };
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };
    const providerStore: ProviderConnectionStore = {
      async getConnection() {
        return { providerId: "github", async getAccessToken() { return token; } };
      },
      async resolveEnv() { return {}; },
      async listStatuses() { return []; },
    };

    const snapshot = await refreshKnowledgeGitSnapshot({
      paths,
      source: {
        type: "remote",
        providerId: "github",
        url: "https://github.com/acme/standards",
      },
      ref: { type: "branch", value: "release/v2" },
      providerStore,
      runner,
      sourceEnv: {
        PATH: process.env.PATH,
        GIT_DIR: "/attacker/repository",
        GIT_CONFIG_GLOBAL: "/attacker/config",
        GIT_CONFIG_COUNT: "99",
        HOME: "/attacker/home",
        HTTPS_PROXY: "https://attacker.invalid",
      },
    });

    expect(snapshot).toMatchObject({
      commitSha,
      source: { type: "remote", url: "https://github.com/acme/standards.git" },
      ref: { type: "branch", value: "release/v2" },
    });
    expect(calls.some((call) => call.args.includes("checkout"))).toBe(false);
    expect(calls.some((call) => call.args[0] === "init" && call.args[1] === "--bare")).toBe(true);
    const fetch = calls.find((call) => call.args.includes("fetch"))!;
    expect(fetch.args).toContain("+refs/heads/release/v2:refs/nitely/source");
    expect(JSON.stringify(calls.map((call) => call.args))).not.toContain(token);
    expect(fetch.env).not.toHaveProperty("GIT_DIR");
    expect(fetch.env).not.toHaveProperty("HOME");
    expect(fetch.env).not.toHaveProperty("HTTPS_PROXY");
    expect(fetch.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(fetch.env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(fetch.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(fetch.env.GIT_LFS_SKIP_SMUDGE).toBe("1");
    expect(Object.values(fetch.env).join("\n")).not.toContain(token);
    expect(Object.values(fetch.env).join("\n")).toContain("AUTHORIZATION: basic ");
    const configuredKeys = Object.entries(fetch.env)
      .filter(([key]) => key.startsWith("GIT_CONFIG_KEY_"))
      .map(([, value]) => value);
    expect(configuredKeys).toEqual(expect.arrayContaining([
      "credential.helper",
      "core.hooksPath",
      "init.templateDir",
      "filter.lfs.smudge",
      "protocol.ext.allow",
      "http.https://github.com/.extraHeader",
    ]));
  });
});
