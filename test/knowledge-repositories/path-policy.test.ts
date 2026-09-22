import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadContextPolicy } from "../../src/context/policy.js";
import { knowledgePathAllowed } from "../../src/knowledge-repositories/service.js";
import { normalizeCreateKnowledgeAttachment } from "../../src/knowledge-repositories/schema.js";

describe("knowledge repository path policy", () => {
  it("implements single-character globs without widening path access", async () => {
    const targetRepoPath = await mkdtemp(join(tmpdir(), "nitely-kb-policy-"));
    await writeFile(join(targetRepoPath, "nitely.context.json"), JSON.stringify({
      version: 1,
      include: ["**/*"],
      exclude: [],
      warnOnly: true,
      redactEnv: [],
    }));
    const targetPolicy = await loadContextPolicy(targetRepoPath);
    const attachment = normalizeCreateKnowledgeAttachment(
      {
        id: "standards",
        name: "Standards",
        source: { type: "local", path: targetRepoPath },
        ref: { type: "branch", value: "main" },
        paths: { include: ["docs/rule?.md"] },
      },
      { now: "2026-07-21T00:00:00.000Z", canonicalLocalPath: targetRepoPath },
    );

    expect(knowledgePathAllowed({
      targetPolicy,
      attachment,
      path: "docs/rule1.md",
    })).toBe(true);
    expect(knowledgePathAllowed({
      targetPolicy,
      attachment,
      path: "docs/rule12.md",
    })).toBe(false);
    expect(knowledgePathAllowed({
      targetPolicy,
      attachment,
      path: "docs/.env",
    })).toBe(false);
  });
});
