import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { benchmarkFixture, buildComparisonReport, packCandidates, prepareContext, runBenchmark, retrieveHybridRepositoryContext, type BenchmarkResult } from "../src/hybrid-retrieval.js";
import { runCli } from "../src/cli.js";
import { estimateKnowledgeTokens } from "../src/knowledge-repositories/tokenize.js";

const candidate = {
  path: "src/example.ts", lineRange: { start: 100, end: 101 }, text: "first\nsecond",
  sourceRevision: "a".repeat(40), relevanceScore: 1, reason: "lexical match",
};
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

describe("context pack boundary", () => {
  it("accepts source-relative multiline ranges and rejects mismatched spans", () => {
    expect(packCandidates([candidate], 1000).pack).toHaveLength(1);
    expect(packCandidates([{ ...candidate, lineRange: { start: 1, end: 1 } }], 1000).invalid).toHaveLength(1);
  });
  it("budgets the full escaped context including long provenance", () => {
    const packed = packCandidates([{ ...candidate, lineRange: { start: 1, end: 1 }, text: "a", reason: "x".repeat(10000) }], 30);
    expect(packed.pack).toHaveLength(0);
  });
  it("does not emit credentials through any candidate field", () => {
    for (const text of ["password=hunter2", "Authorization: Bearer abcdefgh", '{"password":"hunter2"}', "https://user:password@example.com", "-----BEGIN PRIVATE KEY-----"]) {
      expect(packCandidates([{ ...candidate, text, lineRange: { start: 1, end: 1 } }], 1000).pack).toEqual([]);
      expect(packCandidates([{ ...candidate, reason: text }], 1000).pack).toEqual([]);
    }
  });
  it("rejects arbitrarily named symlinks including parent directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-pack-")); directories.push(root);
    await mkdir(join(root, "src"));
    await symlink(tmpdir(), join(root, "anything"));
    expect(packCandidates([{ ...candidate, path: "anything/outside.ts" }], 1000, { repositoryRoot: root }).invalid).toHaveLength(1);
  });
  it("rejects malformed scores, missing provenance and noncanonical paths", () => {
    for (const changed of [{ relevanceScore: NaN }, { sourceRevision: "" }, { path: "src/../file.ts" }]) {
      expect(packCandidates([{ ...candidate, ...changed }], 1000).invalid).toHaveLength(1);
    }
  });
  it("ranks higher relevance first and enforces the exact rendered budget", () => {
    const result = packCandidates([{ ...candidate, relevanceScore: 0.1 }, { ...candidate, path: "src/better.ts" }], 200);
    expect(result.pack[0]?.path).toBe("src/better.ts");
    expect(result.tokenCount).toBeLessThanOrEqual(200);
    // The rendered form is the only payload passed to consumers.
    expect(result).toHaveProperty("context");
    expect(result.tokenCount).toBe(estimateKnowledgeTokens((result as unknown as { context: string }).context));
  });
  it("returns an empty pack at zero budget and rejects negative budgets", () => {
    expect(packCandidates([candidate], 0).pack).toEqual([]);
    expect(() => packCandidates([], -1)).toThrow();
  });
});

describe("benchmark evidence", () => {
  it("does not approve on token savings without evaluation evidence", () => {
    expect(buildComparisonReport({ baselineTokenCount: 42, hybridTokenCount: 0, proposals: [] })).toMatch(/Decision: no-go$/);
    expect(buildComparisonReport({
      baselineTokenCount: 1, hybridTokenCount: 0, proposals: [], budgetHeld: true, externalAbstained: true,
      fileGrepPasses: 0, repoIndexPasses: 0, lexicalPasses: 0, hybridPasses: 3,
      semantic: { id: "frozen-semantic", model: "nomic-embed-text", sourceDigest: `sha256:${"ab".repeat(32)}`, dimensions: 768 },
    })).toMatch(/Decision: no-go$/);
  });
  it.each([{ version: 1, questions: [] }, { version: 2, questions: [] }, { questions: [{}] }])("rejects incomplete fixtures", async (fixture) => {
    await expect(runBenchmark({ fixture: fixture as never })).rejects.toThrow();
  });
  it("never writes authoritative context", async () => {
    const write = vi.fn();
    await runBenchmark({ writeAuthoritativeContext: write });
    expect(write).not.toHaveBeenCalled();
  });
});

describe("feature flag", () => {
  it("preserves evidence and skips retrieval when disabled", async () => {
    const evidence = { id: "flow" }; const hybridPacker = vi.fn();
    expect(await prepareContext({ env: {}, existingFlowEvidence: evidence, hybridPacker })).toBe(evidence);
    expect(hybridPacker).not.toHaveBeenCalled();
  });
  it("returns supplemental context alongside unchanged authoritative evidence", async () => {
    const evidence = { id: "flow" }; const hybrid = { pack: [candidate] };
    expect(await prepareContext({ env: { NITELY_HYBRID_RETRIEVAL: "1" }, existingFlowEvidence: evidence, hybridPacker: () => hybrid })).toEqual({ existingFlowEvidence: evidence, hybridContext: hybrid });
  });
});


describe("real repository retrieval", () => {
  it("searches committed text, anchors provenance and excludes symlinks, secrets and policy-denied paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-hybrid-")); directories.push(root);
    const git = async (...args: string[]) => promisify(execFile)("git", ["-C", root, ...args]);
    await git("init"); await git("config", "user.email", "fixture@example.test"); await git("config", "user.name", "Fixture");
    await writeFile(join(root, "allowed.md"), "Kestrel retrieval target is implemented here.");
    await writeFile(join(root, "denied.md"), "Kestrel forbidden policy content.");
    await writeFile(join(root, "credential.md"), 'Kestrel {"password":"fixture-secret"}');
    await symlink("allowed.md", join(root, "arbitrary.md"));
    await git("add", "."); await git("commit", "-m", "fixture");
    await writeFile(join(root, "nitely.context.json"), JSON.stringify({ exclude: ["denied.md"] }));
    const matches = await retrieveHybridRepositoryContext({ repoPath: root, query: "Kestrel retrieval target", tokenBudget: 1000 });
    expect(matches.map((m) => m.path)).toEqual(["allowed.md"]);
    expect(matches[0].text).toBe("Kestrel retrieval target is implemented here.");
    expect(matches[0].commitSha).toBe((await git("rev-parse", "HEAD")).stdout.trim());
    expect(matches[0].contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    await writeFile(join(root, "allowed.md"), "uncommitted replacement");
    expect((await retrieveHybridRepositoryContext({ repoPath: root, query: "Kestrel", tokenBudget: 1000 }))[0].text).toContain("retrieval target");
  });
  it("measures semantic retrieval, baselines, and downstream outcomes", async () => {
    const result = await runBenchmark();
    const again = await runBenchmark();
    expect(result.baselineTokenCount).toBeGreaterThan(0);
    expect(result.hybridTokenCount).toBeGreaterThan(0);
    expect(result.measurements).toHaveLength(6);
    expect(result.measurements.every((measurement) => measurement.provenanceValid)).toBe(true);
    expect(result.measurements.find((measurement) => measurement.id === "external")).toMatchObject({ baselinePaths: [], hybridPaths: [], hybridRecall: 1, hybridPass: true });
    expect(stableBenchmark(result)).toEqual(stableBenchmark(again));
    expect(result.measurements.map((measurement) => [measurement.id, measurement.fileGrepPass, measurement.repoIndexPass, measurement.baselinePass, measurement.hybridPass, measurement.hybridTop])).toEqual([
      ["omitted-counter", false, false, false, true, "src/ledger/counters.ts"],
      ["unknown-tally", false, false, false, true, "src/ledger/counters.ts"],
      ["saved-record", false, false, false, true, "docs/kept-evidence.md"],
      ["strip-material", true, false, true, true, "src/safety/passage-filter.ts"],
      ["symbol-lookup", true, true, true, true, "src/ledger/counters.ts"],
      ["external", true, true, true, true, ""],
    ]);
    expect(result.measurements.find((measurement) => measurement.id === "omitted-counter")).toMatchObject({ recencyReordered: true, recencyBefore: "src/showroom/drawer-label.ts" });
    expect(result.proposals).toEqual([
      "Stored flow evidence stays the source of truth.",
      "A retrieved passage cannot replace a stored decision.",
      "Prefer review before adopting a retrieved passage.",
    ]);
    expect(result.report.match(/^Decision: .+$/gm)).toEqual(["Decision: go"]);
    expect(result.report).toContain("Semantic provider: frozen-semantic nomic-embed-text semantic=true");
    expect(result.report).toContain("Downstream passes: file-grep 3, repo-index 2, BM25 3, hybrid 6");
    expect(result.report).toContain("Proposals withheld: 1");
    expect(result.report).not.toContain("api_key");
    expect(result.decision).toBe("go");
    const published = await readFile(new URL("../benchmarks/hybrid-retrieval-result.md", import.meta.url), "utf8");
    const fixture = JSON.parse(await readFile(new URL("../benchmarks/hybrid-retrieval.fixture.json", import.meta.url), "utf8"));
    expect(fixture).toEqual(benchmarkFixture);
    expect(published).toContain(result.fixtureDigest);
    expect(published.match(/^Decision: .+$/gm)).toEqual(["Decision: go"]);
    expect(stripLatency(published).trimEnd()).toBe(stripLatency(result.report).trimEnd());
  });
});

function stableBenchmark(result: BenchmarkResult) {
  return {
    decision: result.decision,
    fixtureDigest: result.fixtureDigest,
    baselineTokenCount: result.baselineTokenCount,
    hybridTokenCount: result.hybridTokenCount,
    proposals: result.proposals,
    measurements: result.measurements.map(({ baselineLatencyMs, hybridLatencyMs, fileGrepLatencyMs, repoIndexLatencyMs, ...measurement }) => {
      void baselineLatencyMs; void hybridLatencyMs; void fileGrepLatencyMs; void repoIndexLatencyMs;
      return measurement;
    }),
  };
}
function stripLatency(report: string): string {
  return report.replace(/\d+\.\d{3}/g, "0.000");
}


describe("benchmark CLI", () => {
  it("returns a go exit status for the bundled semantic fixture", async () => {
    const stdout = vi.fn(); const stderr = vi.fn();
    expect(await runCli(["benchmark", "hybrid-retrieval"], { stdout, stderr })).toBe(0);
    expect(stdout.mock.calls[0][0]).toContain("Per-query budget: 1800");
    expect(stdout.mock.calls[0][0]).toMatch(/Decision: go$/);
    expect(stdout.mock.calls[0][0].match(/^Decision: .+$/gm)).toEqual(["Decision: go"]);
    expect(stderr).not.toHaveBeenCalled();
  });
  it.each([["--fixture"], ["--budget", "-1"], ["--output", "--budget", "100"]])("rejects incomplete or malformed options %s", async (...args) => {
    const stdout = vi.fn(); const stderr = vi.fn();
    expect(await runCli(["benchmark", "hybrid-retrieval", ...args.flat()], { stdout, stderr })).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalled();
  });
});

describe("bounded benchmark provenance", () => {
  it("validates the original source hash when a retrieved passage is truncated", async () => {
    const result = await runBenchmark({ tokenBudget: 300, fixture: {
      version: 1, documents: [{ path: "a.md", text: "kestrel ".repeat(200) }],
      questions: [{ id: "long", question: "kestrel", answerKind: "single-source-file", expectedPaths: ["a.md"] }],
    } });
    expect(result.measurements[0].provenanceValid).toBe(true);
    expect(result.hybridTokenCount).toBeLessThanOrEqual(300);
  });
});
