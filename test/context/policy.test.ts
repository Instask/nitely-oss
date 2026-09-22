import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { evaluateLocalPath, loadContextPolicy } from "../../src/context/policy.js";

describe("context policy", () => {
  it("defaults to allowing ordinary repository files", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-context-policy-"));

    const policy = await loadContextPolicy(repo);

    expect(evaluateLocalPath(policy, "docs/spec.md")).toMatchObject({
      decision: "allowed",
    });
  });

  it("blocks built-in secret paths without a project policy", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-context-policy-"));
    const policy = await loadContextPolicy(repo);

    for (const path of [
      ".env",
      ".env.local",
      "certs/service.pem",
      "keys/deploy.key",
      ".nitely/providers/github.json",
      ".nitely/connections.json",
      ".nitely/connections.secrets.json",
      ".nitely/connections.json.audit.jsonl",
      ".nitely/users/usr_1/connections.secrets.json",
      ".nitely/events.db",
      "nested/id_rsa",
      "nested/id_ed25519",
    ]) {
      expect(evaluateLocalPath(policy, path), path).toMatchObject({
        decision: "excluded",
      });
    }
  });

  it("lets project excludes override includes", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-context-policy-"));
    await writeFile(
      join(repo, "nitely.context.json"),
      JSON.stringify({
        version: 1,
        include: ["docs/**"],
        exclude: ["docs/private/**"],
      }),
      "utf8",
    );

    const policy = await loadContextPolicy(repo);

    expect(evaluateLocalPath(policy, "docs/public/spec.md")).toMatchObject({
      decision: "allowed",
    });
    expect(evaluateLocalPath(policy, "docs/private/spec.md")).toMatchObject({
      decision: "excluded",
      matchedPattern: "docs/private/**",
    });
  });

  it("normalizes repository-relative paths before matching", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-context-policy-"));
    await writeFile(
      join(repo, "nitely.context.json"),
      JSON.stringify({
        version: 1,
        exclude: ["secrets/**"],
      }),
      "utf8",
    );

    const policy = await loadContextPolicy(repo);

    expect(evaluateLocalPath(policy, "./secrets//token.txt")).toMatchObject({
      decision: "excluded",
      matchedPattern: "secrets/**",
    });
  });

  it("warns when warnOnly is enabled while still identifying excluded paths", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-context-policy-"));
    await writeFile(
      join(repo, "nitely.context.json"),
      JSON.stringify({
        version: 1,
        exclude: ["private/**"],
        warnOnly: true,
      }),
      "utf8",
    );

    const policy = await loadContextPolicy(repo);

    expect(evaluateLocalPath(policy, "private/spec.md")).toMatchObject({
      decision: "warned",
      matchedPattern: "private/**",
    });
  });
});
