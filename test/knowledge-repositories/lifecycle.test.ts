import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import type { KnowledgeIndexArtifact } from "../../src/knowledge-repositories/index.js";
import { resolveKnowledgeRepositoryPaths } from "../../src/knowledge-repositories/paths.js";
import { renderExternalKnowledgePrompt } from "../../src/knowledge-repositories/prompt.js";
import { estimateKnowledgeTokens } from "../../src/knowledge-repositories/tokenize.js";
import type { ProviderConnectionStore } from "../../src/providers/types.js";
import {
  attachKnowledgeRepository,
  detachKnowledgeRepository,
  getKnowledgeRepositoryStatus,
  pinKnowledgeRepositorySnapshots,
  queryKnowledgeRepositories,
} from "../../src/knowledge-repositories/service.js";

const execFileAsync = promisify(execFile);

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    encoding: "utf8",
  });
  return stdout.trim();
}

describe("external knowledge repository lifecycle", () => {
  it("indexes only committed policy-approved secret-free files and retains pinned indexes after detach", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-kb-lifecycle-"));
    const targetRepoPath = await mkdtemp(join(root, "target-"));
    const sourceRepoPath = await mkdtemp(join(root, "source-"));
    const runtimeRoot = join(root, "runtime");
    const secret = "rotated-provider-secret-value";
    const providerStore: ProviderConnectionStore = {
      async getConnection() {
        throw new Error("local knowledge fixtures must not request a GitHub connection");
      },
      async resolveEnv() {
        return { GITHUB_TOKEN: secret };
      },
      async listStatuses() {
        return [];
      },
    };
    await writeFile(join(targetRepoPath, "nitely.context.json"), JSON.stringify({
      version: 1,
      include: ["**/*"],
      exclude: ["docs/blocked.md"],
      warnOnly: true,
      redactEnv: [],
    }));
    await git(sourceRepoPath, "init", "-b", "main");
    await git(sourceRepoPath, "config", "user.name", "Nitely Test");
    await git(sourceRepoPath, "config", "user.email", "nitely-test@example.invalid");
    await mkdir(join(sourceRepoPath, "docs"), { recursive: true });
    await writeFile(
      join(sourceRepoPath, "docs", "allowed.md"),
      "Callbacks require replay protection and timestamp validation.\n",
    );
    await writeFile(
      join(sourceRepoPath, "docs", "blocked.md"),
      "Forbidden internal deployment ritual.\n",
    );
    await writeFile(
      join(sourceRepoPath, "docs", "secret.json"),
      JSON.stringify({ service: "payments", apiKey: "fixture-secret-value" }),
    );
    await writeFile(
      join(sourceRepoPath, "docs", "provider-secret.md"),
      `Never copy this runtime credential: ${secret}\n`,
    );
    await git(sourceRepoPath, "add", "docs");
    await git(sourceRepoPath, "commit", "-m", "add knowledge fixtures");
    const committedSha = await git(sourceRepoPath, "rev-parse", "HEAD");
    await writeFile(
      join(sourceRepoPath, "docs", "dirty.md"),
      "Uncommitted dragonfruit operational notes.\n",
    );

    const attached = await attachKnowledgeRepository(
      {
        targetRepoPath,
        runtimeRoot,
        attachment: {
          id: "standards",
          name: "Engineering standards",
          source: { type: "local", path: sourceRepoPath },
          ref: { type: "branch", value: "main" },
          paths: { include: ["docs/**"] },
          retrieval: { providerId: "local-hash", model: "unicode-hash-v1" },
        },
      },
      { providerStore },
    );

    expect(attached.status).toMatchObject({
      state: "ready",
      currentSnapshot: {
        commitSha: committedSha,
        fileCount: 1,
        skippedFileCounts: {
          policy: 1,
          sensitive: 2,
          unsupported: 0,
        },
      },
    });
    const indexPath = attached.status.currentSnapshot!.indexPath;
    const index = JSON.parse(await readFile(indexPath, "utf8")) as KnowledgeIndexArtifact;
    expect(index.chunks.map((chunk) => chunk.path)).toEqual(["docs/allowed.md"]);
    expect(JSON.stringify(index)).not.toContain("fixture-secret-value");
    expect(JSON.stringify(index)).not.toContain(secret);
    expect(JSON.stringify(index)).not.toContain("Forbidden internal deployment ritual");
    expect(JSON.stringify(index)).not.toContain("dragonfruit");

    const pins = await pinKnowledgeRepositorySnapshots({
      targetRepoPath,
      runtimeRoot,
      ids: ["standards"],
      availability: "require-all",
    });
    expect(pins.attachments).toHaveLength(1);
    expect(pins.attachments[0]).toMatchObject({
      attachmentId: "standards",
      required: true,
      topK: 6,
      maxPromptTokens: 2_000,
      attachmentRequired: false,
      providerConfigurationDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(pins.attachments[0]).not.toHaveProperty("indexPath");

    const missingOptional = await pinKnowledgeRepositorySnapshots({
      targetRepoPath,
      runtimeRoot,
      ids: ["not-attached"],
      availability: "allow-degraded",
    });
    expect(missingOptional.attachments).toEqual([]);
    expect(missingOptional.degradedAttachmentIds).toEqual(["not-attached"]);
    await expect(pinKnowledgeRepositorySnapshots({
      targetRepoPath,
      runtimeRoot,
      ids: ["not-attached"],
      availability: "require-all",
    })).rejects.toThrow(/required knowledge repository is not attached/i);

    const firstQuery = await queryKnowledgeRepositories({
      targetRepoPath,
      runtimeRoot,
      query: "  REPLAY   protection ",
      pins,
    });
    const normalizedQuery = await queryKnowledgeRepositories({
      targetRepoPath,
      runtimeRoot,
      query: "replay protection",
      pins,
    });
    expect(firstQuery.matches[0]).toMatchObject({
      attachmentId: "standards",
      attachmentName: "Engineering standards",
      snapshotId: pins.attachments[0]!.snapshotId,
      indexDigest: pins.attachments[0]!.indexDigest,
      providerId: "local-hash",
      model: "unicode-hash-v1",
      path: "docs/allowed.md",
    });
    expect(firstQuery.queryDigest).toBe(normalizedQuery.queryDigest);
    expect(firstQuery.queryDigest).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    const rawDigest = createHash("sha256").update("replay protection").digest("hex");
    expect(firstQuery.queryDigest).not.toBe(`hmac-sha256:${rawDigest}`);

    const previousSnapshotWarning = await queryKnowledgeRepositories({
      targetRepoPath,
      runtimeRoot,
      query: "replay protection",
      pins: { ...pins, degradedAttachmentIds: ["standards"] },
    });
    expect(previousSnapshotWarning.matches[0]?.attachmentId).toBe("standards");
    expect(previousSnapshotWarning.degradedAttachmentIds).toEqual(["standards"]);

    let effectiveTopK: number | undefined;
    let effectiveMaxPromptTokens: number | undefined;
    await queryKnowledgeRepositories(
      {
        targetRepoPath,
        runtimeRoot,
        query: "replay protection",
        pins,
        topK: 100,
        maxPromptTokens: 32_768,
      },
      {
        queryIndexes: async (input) => {
          effectiveTopK = input.topK;
          effectiveMaxPromptTokens = input.maxPromptTokens;
          return {
            queryDigest: "sha256:" + "0".repeat(64),
            mode: "lexical-hash",
            matches: [],
            degradedAttachmentIds: [],
            warnings: [],
            selectedCount: 0,
            truncatedCount: 0,
            approxTokens: 0,
          };
        },
      },
    );
    expect(effectiveTopK).toBe(6);
    expect(effectiveMaxPromptTokens).toBe(2_000);

    const queryIndexes = vi.fn(async () => ({
      queryDigest: "sha256:" + "0".repeat(64),
      mode: "lexical" as const,
      matches: [],
      degradedAttachmentIds: [],
      warnings: [],
      selectedCount: 0,
      truncatedCount: 0,
      approxTokens: 0,
    }));
    await expect(queryKnowledgeRepositories(
      { targetRepoPath, runtimeRoot, query: `token=${secret}`, pins },
      { providerStore, queryIndexes },
    )).rejects.toThrow(/sensitive content/i);
    expect(queryIndexes).not.toHaveBeenCalled();

    const redacted = await queryKnowledgeRepositories(
      { targetRepoPath, runtimeRoot, query: "replay protection", pins },
      {
        redactionSecrets: [secret],
        queryIndexes: async () => ({
          queryDigest: "sha256:" + "0".repeat(64),
          mode: "lexical-hash",
          matches: [{ ...firstQuery.matches[0]!, text: `token=${secret}` }],
          degradedAttachmentIds: [],
          warnings: [],
          selectedCount: 1,
          truncatedCount: 0,
          approxTokens: 8,
        }),
      },
    );
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(redacted.matches).toEqual([]);

    const expandedRedaction = await queryKnowledgeRepositories(
      { targetRepoPath, runtimeRoot, query: "replay protection", pins },
      {
        redactionSecrets: [secret],
        queryIndexes: async () => ({
          queryDigest: "sha256:" + "0".repeat(64),
          mode: "lexical-hash",
          matches: [{
            ...firstQuery.matches[0]!,
            text: secret.repeat(400),
          }],
          degradedAttachmentIds: [],
          warnings: [],
          selectedCount: 1,
          truncatedCount: 0,
          approxTokens: 1,
        }),
      },
    );
    const expandedPrompt = renderExternalKnowledgePrompt(
      expandedRedaction.matches,
    ).join("\n");
    expect(expandedRedaction.matches).toHaveLength(1);
    expect(expandedPrompt).not.toContain(secret);
    expect(estimateKnowledgeTokens(expandedPrompt)).toBeLessThanOrEqual(2_000);

    const optionalDegraded = await queryKnowledgeRepositories({
      targetRepoPath,
      runtimeRoot,
      query: "replay protection",
      attachmentIds: ["standards"],
      allowDegraded: true,
      pins: {
        ...pins,
        attachments: [],
        degradedAttachmentIds: ["standards", "unrelated-stage"],
      },
    });
    expect(optionalDegraded.matches).toEqual([]);
    expect(optionalDegraded.degradedAttachmentIds).toEqual(["standards"]);

    await expect(queryKnowledgeRepositories(
      { targetRepoPath, runtimeRoot, query: "replay protection", pins },
      {
        queryIndexes: async () => ({
          queryDigest: "sha256:" + "0".repeat(64),
          mode: "lexical",
          matches: [],
          degradedAttachmentIds: ["standards"],
          warnings: ["provider unavailable"],
          selectedCount: 0,
          truncatedCount: 0,
          approxTokens: 0,
        }),
      },
    )).rejects.toThrow(/required knowledge repository retrieval provider/i);

    const optionalStageDegradation = await queryKnowledgeRepositories(
      {
        targetRepoPath,
        runtimeRoot,
        query: "replay protection",
        pins,
        allowDegraded: true,
        requiredAttachmentIds: [],
      },
      {
        queryIndexes: async () => ({
          queryDigest: "sha256:" + "0".repeat(64),
          mode: "lexical",
          matches: [],
          degradedAttachmentIds: ["standards"],
          warnings: ["provider unavailable"],
          selectedCount: 0,
          truncatedCount: 0,
          approxTokens: 0,
        }),
      },
    );
    expect(optionalStageDegradation.degradedAttachmentIds).toEqual(["standards"]);

    await expect(queryKnowledgeRepositories(
      {
        targetRepoPath,
        runtimeRoot,
        query: "replay protection",
        pins: {
          ...pins,
          attachments: pins.attachments.map((pin) => ({
            ...pin,
            attachmentRequired: true,
          })),
        },
        allowDegraded: true,
        requiredAttachmentIds: [],
      },
      {
        queryIndexes: async () => ({
          queryDigest: "sha256:" + "0".repeat(64),
          mode: "lexical",
          matches: [],
          degradedAttachmentIds: ["standards"],
          warnings: ["provider unavailable"],
          selectedCount: 0,
          truncatedCount: 0,
          approxTokens: 0,
        }),
      },
    )).rejects.toThrow(/required knowledge repository retrieval provider/i);

    const paths = await resolveKnowledgeRepositoryPaths({ targetRepoPath, runtimeRoot });
    expect((await stat(paths.queryHmacKeyPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(paths.queryHmacKeyPath, "utf8")).not.toContain("replay protection");
    await expect(access(join(targetRepoPath, ".nitely"))).rejects.toMatchObject({ code: "ENOENT" });

    await detachKnowledgeRepository({
      targetRepoPath,
      runtimeRoot,
      attachmentId: "standards",
    });
    await expect(access(indexPath)).resolves.toBeUndefined();

    const afterDetach = await queryKnowledgeRepositories({
      targetRepoPath,
      runtimeRoot,
      query: "replay protection",
      pins,
    });
    expect(afterDetach.matches[0]).toMatchObject({
      attachmentId: "standards",
      path: "docs/allowed.md",
    });
    expect(afterDetach.queryDigest).toBe(firstQuery.queryDigest);

    await attachKnowledgeRepository({
      targetRepoPath,
      runtimeRoot,
      attachment: {
        id: "standards",
        name: "Reattached standards",
        source: { type: "local", path: sourceRepoPath },
        ref: { type: "branch", value: "main" },
        paths: { include: ["docs/**"] },
        retrieval: { providerId: "local-hash", model: "unicode-hash-v2" },
      },
    });
    const resolver = vi.fn(async () => {
      throw new Error("current attachment provider must not replace a pinned provider");
    });
    const afterReattach = await queryKnowledgeRepositories(
      { targetRepoPath, runtimeRoot, query: "replay protection", pins },
      { embeddingProviderResolver: resolver },
    );
    expect(afterReattach.matches[0]?.snapshotId).toBe(pins.attachments[0]!.snapshotId);
    expect(resolver).not.toHaveBeenCalled();

    await writeFile(join(targetRepoPath, "nitely.context.json"), JSON.stringify({
      version: 1,
      include: ["**/*"],
      exclude: ["docs/allowed.md"],
      warnOnly: true,
      redactEnv: [],
    }));
    const stale = await getKnowledgeRepositoryStatus({
      targetRepoPath,
      runtimeRoot,
      attachmentId: "standards",
    });
    expect(stale.status.state).toBe("stale");
    expect(stale.status.staleReasons).toContain("policy-changed");
  });
});
