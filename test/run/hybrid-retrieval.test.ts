import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as hybrid from "../../src/hybrid-retrieval.js";
import { runFlow } from "../../src/run/run-flow.js";
import { EventStore } from "../../src/events/store.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe.skipIf(process.platform !== "linux")("hybrid context in real Run prompts", () => {
  it.each(["1", "0", "isolated", "denied", "unavailable"])("observes flag and context/read boundaries: %s", async (mode) => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-hybrid-run-")); roots.push(repo);
    const git = (...args: string[]) => promisify(execFile)("git", ["-C", repo, ...args]);
    await git("init"); await git("config", "user.email", "fixture@example.test"); await git("config", "user.name", "Fixture");
    await writeFile(join(repo, "source.md"), "Kestrel dispatch uses the silver queue.");
    await git("add", "."); await git("commit", "-m", "fixture");
    await mkdir(join(repo, "flows"));
    const flowPath = join(repo, "flows", "hybrid.json");
    await writeFile(flowPath, JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1", kind: "Flow", metadata: { name: "hybrid-test" },
      spec: { stages: [{ id: "implement", type: "agent", runtime: "mock", prompt: "Kestrel dispatch", inputs: [], outputs: ["implementation"],
        ...(mode === "isolated" ? { context: { isolated: true } } : {}),
        ...(mode === "denied" ? { reads: { deny: ["source.md"] } } : {}),
      }] },
    }));
    vi.stubEnv("NITELY_HYBRID_RETRIEVAL", mode === "0" ? "0" : "1");
    if (mode === "unavailable") vi.spyOn(hybrid, "retrieveHybridRepositoryContext").mockRejectedValue(new Error("fixture unavailable"));
    let captured = "";
    await runFlow({ repoPath: repo, flowPath, inputs: {} }, {
      createRunId: () => "hybrid-run",
      executeAgent: async ({ prompt, attemptDirectory }) => {
        captured = prompt;
        await writeFile(join(attemptDirectory, "implementation.md"), "done");
      },
    });
    expect(captured.includes("silver queue")).toBe(mode === "1");
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    try {
      const events = store.list("hybrid-run").filter((event) => event.type === "knowledge.retrieved");
      if (mode === "unavailable") expect(events[0]?.payload).toMatchObject({ status: "degraded", reasonCodes: expect.arrayContaining(["task-repository-query-failed"]) });
      if (mode === "1") expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({ selectedCount: 1 }) })]));
    } finally { store.close(); }
  });
});

it.skipIf(process.platform !== "linux")("retrieves the execution worktree revision after an earlier stage commits", async () => {
  const repo = await mkdtemp(join(tmpdir(), "nitely-hybrid-revision-")); roots.push(repo);
  const git = (cwd: string, ...args: string[]) => promisify(execFile)("git", ["-C", cwd, ...args]);
  await git(repo, "init"); await git(repo, "config", "user.email", "fixture@example.test"); await git(repo, "config", "user.name", "Fixture");
  await writeFile(join(repo, "source.md"), "Kestrel dispatch uses the bronze queue.");
  await git(repo, "add", "."); await git(repo, "commit", "-m", "fixture");
  await mkdir(join(repo, "flows"));
  const flowPath = join(repo, "flows", "revision.json");
  await writeFile(flowPath, JSON.stringify({
    apiVersion: "nitely.dev/v1alpha1", kind: "Flow", metadata: { name: "hybrid-revision" },
    spec: { stages: [
      { id: "setup", type: "agent", runtime: "mock", prompt: "Kestrel dispatch", inputs: [], outputs: ["setup"] },
      { id: "implement", type: "agent", runtime: "mock", prompt: "Kestrel dispatch", inputs: ["setup"], outputs: ["implementation"] },
    ] },
  }));
  vi.stubEnv("NITELY_HYBRID_RETRIEVAL", "1");
  let secondPrompt = "";
  await runFlow({ repoPath: repo, flowPath, inputs: {} }, {
    createRunId: () => "revision-run",
    executeAgent: async ({ prompt, stage, worktreePath, attemptDirectory }) => {
      if (stage.id === "setup") {
        await writeFile(join(worktreePath, "source.md"), "Kestrel dispatch uses the silver queue.");
        await git(worktreePath, "add", "source.md"); await git(worktreePath, "commit", "-m", "change queue");
      } else secondPrompt = prompt;
      await writeFile(join(attemptDirectory, stage.id === "setup" ? "setup.md" : "implementation.md"), "done");
    },
  });
  expect(secondPrompt).toContain("silver queue");
  expect(secondPrompt).not.toContain("bronze queue");
});

it.skipIf(process.platform !== "linux").each(["1", "0"])(
  "keeps task-repository context when attached knowledge already fills topK (flag %s)",
  async (flag) => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-hybrid-quota-")); roots.push(repo);
    const git = (...args: string[]) => promisify(execFile)("git", ["-C", repo, ...args]);
    await git("init"); await git("config", "user.email", "fixture@example.test"); await git("config", "user.name", "Fixture");
    await writeFile(join(repo, "source.md"), "Kestrel dispatch uses the silver queue.");
    await git("add", "."); await git("commit", "-m", "fixture");
    await mkdir(join(repo, "flows"));
    const flowPath = join(repo, "flows", "quota.json");
    await writeFile(flowPath, JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1", kind: "Flow", metadata: { name: "hybrid-quota" },
      spec: { stages: [{ id: "implement", type: "agent", runtime: "mock", prompt: "Kestrel dispatch", inputs: [], outputs: ["implementation"] }] },
    }));
    vi.stubEnv("NITELY_HYBRID_RETRIEVAL", flag);
    const hex = (char: string, length: number) => char.repeat(length);
    const topK = 6;
    // The attached knowledge repository alone returns topK passages.
    const attachedMatches = Array.from({ length: topK }, (_, index) => ({
      rank: index + 1,
      chunkId: `chunk-${index}`,
      attachmentId: "handbook",
      commitSha: hex("b", 40),
      path: `handbook/${index}.md`,
      startLine: 1,
      endLine: 1,
      contentDigest: `sha256:${hex("c", 64)}`,
      citation: `handbook/${index}.md:1-1`,
      text: `Attached handbook passage ${index} about Kestrel dispatch.`,
      approxTokens: 12,
      lexicalScore: 1,
      vectorScore: 1,
      semanticScore: 1,
      fusedScore: 1,
    }));
    let captured = "";
    await runFlow({ repoPath: repo, flowPath, inputs: {} }, {
      createRunId: () => `quota-run-${flag}`,
      pinKnowledgeRepositorySnapshots: async () => ({
        version: 1,
        pinnedAt: "2026-10-18T00:00:00.000Z",
        attachments: [{
          attachmentId: "handbook",
          snapshotId: hex("a", 64),
          commitSha: hex("b", 40),
          indexDigest: `sha256:${hex("d", 64)}`,
          policyFingerprint: `sha256:${hex("e", 64)}`,
          providerId: "fixture",
          model: "fixture-embed",
          providerConfigurationDigest: `sha256:${hex("f", 64)}`,
          topK,
          maxPromptTokens: 4_000,
          attachmentRequired: false,
          required: false,
        }],
        degradedAttachmentIds: [],
      }),
      fingerprintKnowledgeRepositoryQuery: async () => `sha256:${hex("9", 64)}`,
      queryKnowledgeRepositories: (async () => ({
        queryDigest: `sha256:${hex("8", 64)}`,
        mode: "hybrid",
        matches: attachedMatches,
        degradedAttachmentIds: [],
        warnings: [],
        selectedCount: topK,
        truncatedCount: 0,
        approxTokens: topK * 12,
      })) as never,
      executeAgent: async ({ prompt, attemptDirectory }) => {
        captured = prompt;
        await writeFile(join(attemptDirectory, "implementation.md"), "done");
      },
    });
    const attachedInPrompt = attachedMatches.filter((match) => captured.includes(match.text)).length;
    if (flag === "1") {
      expect(captured).toContain("silver queue");
      expect(attachedInPrompt).toBe(topK - 1);
    } else {
      expect(captured).not.toContain("silver queue");
      expect(attachedInPrompt).toBe(topK);
    }
  },
);
