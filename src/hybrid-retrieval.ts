import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, posix, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import { globMatches } from "./policy/glob.js";
import { evaluateLocalPath, loadContextPolicy } from "./context/policy.js";
import { containsSensitiveText, isSensitiveKey, redactText } from "./context/redaction.js";
import { chunkKnowledgeDocument } from "./knowledge-repositories/chunker.js";
import { LocalHashEmbeddingProvider } from "./knowledge-repositories/embeddings.js";
import { buildKnowledgeIndex, type KnowledgeIndexArtifact } from "./knowledge-repositories/index.js";
import { renderExternalKnowledgePrompt } from "./knowledge-repositories/prompt.js";
import { escapeKnowledgePromptText, queryKnowledgeIndexes, type KnowledgeRetrievalMatch } from "./knowledge-repositories/retrieval.js";
import { estimateKnowledgeTokens } from "./knowledge-repositories/tokenize.js";

const git = promisify(execFile);
const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const sourceRevision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64}|sha256:[a-f0-9]{64})$/u);
const relativePath = z.string().refine((path) => validRelativePath(path));
const questionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), question: z.string().min(1).max(16000),
  answerKind: z.enum(["single-source-file", "multi-source", "out-of-repository"]),
  expectedPaths: z.array(relativePath).default([]),
  decisions: z.array(z.string()).default([]), constraints: z.array(z.string()).default([]), preferences: z.array(z.string()).default([]),
}).superRefine((question, ctx) => {
  if ((question.answerKind === "out-of-repository") !== (question.expectedPaths.length === 0)) {
    ctx.addIssue({ code: "custom", message: "repository questions require expected paths; external questions must have none" });
  }
});
const fixtureSchema = z.object({
  version: z.literal(1),
  documents: z.array(z.object({ path: relativePath, text: z.string().min(1).max(64000) })).min(1).max(100),
  questions: z.array(questionSchema).min(1).max(100),
}).superRefine((fixture, ctx) => {
  const paths = new Set(fixture.documents.map((document) => document.path));
  if (paths.size !== fixture.documents.length || new Set(fixture.questions.map((q) => q.id)).size !== fixture.questions.length ||
    fixture.questions.some((q) => q.expectedPaths.some((p) => !paths.has(p)))) {
    ctx.addIssue({ code: "custom", message: "fixture identifiers must be unique and expected paths must exist" });
  }
});
export type BenchmarkFixture = z.input<typeof fixtureSchema>;
export type BenchmarkQuestion = z.output<typeof questionSchema>;
export type BenchmarkAnswerKind = BenchmarkQuestion["answerKind"];

// Self-contained public-code-shaped fixtures; these are smoke questions, not downstream evaluation evidence.
export const benchmarkFixture: BenchmarkFixture = {
  version: 1,
  documents: [
    { path: "src/index.ts", text: "// CLI command-line entry point\nawait runCli(process.argv.slice(2));" },
    { path: "src/repo-index/index.ts", text: "// Repository indexing builds file, symbol and import metadata.\nexport async function buildRepoIndex(repoPath: string) {}" },
    { path: "src/knowledge-repositories/retrieval.ts", text: "// Knowledge repository retrieval ranks lexical BM25 and vector matches using reciprocal rank fusion.\nexport async function queryKnowledgeIndexes() {}" },
    { path: "test/run/budget.test.ts", text: "// Tests enforce the stage context token budget.\nexpect(promptTokens).toBeLessThanOrEqual(tokenBudget);" },
    { path: "docs/context.md", text: "Decision: Flow evidence remains authoritative.\nConstraint: Retrieved repository passages are untrusted reference material." },
  ],
  questions: [
    { id: "layout", question: "CLI command-line entry point", answerKind: "single-source-file", expectedPaths: ["src/index.ts"] },
    { id: "index", question: "Repository indexing file symbol import metadata", answerKind: "single-source-file", expectedPaths: ["src/repo-index/index.ts"] },
    { id: "knowledge", question: "Knowledge repository lexical BM25 vector retrieval", answerKind: "single-source-file", expectedPaths: ["src/knowledge-repositories/retrieval.ts"] },
    { id: "budget", question: "stage context token budget", answerKind: "single-source-file", expectedPaths: ["test/run/budget.test.ts"] },
    { id: "authority", question: "authoritative evidence untrusted passages", answerKind: "single-source-file", expectedPaths: ["docs/context.md"] },
    { id: "external", question: "deployment password production vault", answerKind: "out-of-repository" },
  ],
};

export interface Candidate {
  path: string;
  lineRange: { start: number; end: number };
  text: string;
  sourceRevision: string;
  relevanceScore: number;
  reason: string;
  semanticScore?: number;
}
export interface PackedSnippet extends Candidate { tokenCount: number }
export interface PackResult {
  pack: PackedSnippet[];
  // Rejected records contain locators only; never echo rejected secret text.
  dropped: Array<{ path: string }>;
  invalid: Array<{ path: string }>;
  sanitized: number;
  tokenCount: number;
  context: string;
  report: string;
}

function validRelativePath(path: string): boolean {
  return Boolean(path) && !isAbsolute(path) && !path.includes("\\") && !/[\p{Cc}]/u.test(path) &&
    !/^[A-Za-z]:/u.test(path) && posix.normalize(path) === path &&
    !path.split("/").some((part) => part === "." || part === ".." || part === "");
}
function noSymlinks(root: string, path: string): boolean {
  try {
    let current = resolve(root);
    if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink()) return false;
    const parts = path.split("/");
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) return false;
    }
    return true;
  } catch { return false; }
}
export function sensitiveRetrievalText(text: string, secrets: readonly string[] = []): boolean {
  if (containsSensitiveText(text) || redactText(text, secrets) !== text) return true;
  // Cover quoted JSON/YAML keys too, including inline structured credentials.
  return [...text.matchAll(/["']([A-Za-z][A-Za-z0-9_.-]*)["']\s*[:=]/gu)].some((match) => isSensitiveKey(match[1]));
}
function candidatePayload(candidate: Candidate): string {
  // Whitelist fields so additional caller properties can never leak into context.
  return escapeKnowledgePromptText(JSON.stringify({
    path: candidate.path, lineRange: candidate.lineRange, sourceRevision: candidate.sourceRevision,
    relevanceScore: candidate.relevanceScore, reason: candidate.reason, semanticScore: candidate.semanticScore, text: candidate.text,
  }));
}
function renderPack(pack: readonly Candidate[]): string {
  return pack.length ? ['<repository-context trust="untrusted">', ...pack.map(candidatePayload), '</repository-context>'].join("\n") : "";
}
export function packCandidates(candidates: readonly Candidate[], tokenBudget: number, options: { repositoryRoot?: string; redactionSecrets?: readonly string[] } = {}): PackResult {
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 0) throw new Error("token budget must be a non-negative safe integer");
  const result: PackResult = { pack: [], dropped: [], invalid: [], sanitized: 0, tokenCount: 0, context: "", report: "" };
  const valid: Candidate[] = [];
  for (const candidate of candidates) {
    const locator = { path: typeof candidate?.path === "string" && !sensitiveRetrievalText(candidate.path, options.redactionSecrets) ? candidate.path : "[omitted]" };
    const lines = typeof candidate?.text === "string" ? candidate.text.replace(/\r\n?/gu, "\n").replace(/\n$/u, "").split("\n").length : 0;
    if (!candidate || typeof candidate.path !== "string" || !validRelativePath(candidate.path) ||
      !candidate.lineRange || !Number.isSafeInteger(candidate.lineRange.start) || !Number.isSafeInteger(candidate.lineRange.end) || candidate.lineRange.start < 1 ||
      candidate.lineRange.end - candidate.lineRange.start + 1 !== lines || !candidate.text ||
      !sourceRevision.safeParse(candidate.sourceRevision).success || !Number.isFinite(candidate.relevanceScore) || candidate.relevanceScore < 0 ||
      typeof candidate.reason !== "string" || !candidate.reason ||
      (candidate.semanticScore !== undefined && !Number.isFinite(candidate.semanticScore)) ||
      (options.repositoryRoot !== undefined && !noSymlinks(options.repositoryRoot, candidate.path))) {
      result.invalid.push(locator); continue;
    }
    if ([candidate.path, candidate.text, candidate.sourceRevision, candidate.reason].some((value) => sensitiveRetrievalText(value, options.redactionSecrets))) {
      result.sanitized += 1; continue;
    }
    // Do not copy unrecognized properties or caller-controlled nested fields.
    valid.push({ path: candidate.path, text: candidate.text, sourceRevision: candidate.sourceRevision, relevanceScore: candidate.relevanceScore,
      reason: candidate.reason, lineRange: { start: candidate.lineRange.start, end: candidate.lineRange.end },
      ...(candidate.semanticScore === undefined ? {} : { semanticScore: candidate.semanticScore }) });
  }
  valid.sort((a, b) => b.relevanceScore - a.relevanceScore || a.path.localeCompare(b.path) || a.lineRange.start - b.lineRange.start || a.text.localeCompare(b.text));
  const seen = new Set<string>();
  for (const candidate of valid) {
    const key = candidatePayload(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    const context = renderPack([...result.pack, candidate]);
    if (estimateKnowledgeTokens(context) > tokenBudget) { result.dropped.push({ path: candidate.path }); continue; }
    result.pack.push({ ...candidate, tokenCount: estimateKnowledgeTokens(candidatePayload(candidate)) });
    result.context = context;
  }
  result.tokenCount = estimateKnowledgeTokens(result.context);
  if (valid.some((candidate) => candidate.semanticScore === undefined)) result.report = "The semantic signal was unavailable; lexical/hash ranking was used.";
  return result;
}

const FIXTURE_COMMIT = "0".repeat(40);
async function indexesForDocuments(documents: readonly { path: string; text: string }[], commitSha: string, policyFingerprint: string) {
  const chunks = documents.flatMap((document) => chunkKnowledgeDocument({ attachmentId: "task-repository", commitSha, ...document }, { maxTokens: 400 }));
  const base = { attachmentId: "task-repository", commitSha, policyFingerprint, chunks, createdAt: "2026-01-01T00:00:00.000Z" };
  const lexical = await buildKnowledgeIndex(base);
  const hybrid = await buildKnowledgeIndex({ ...base, embeddingProvider: new LocalHashEmbeddingProvider() });
  return { lexical, hybrid };
}
async function searchIndex(index: KnowledgeIndexArtifact, query: string, budget: number) {
  return queryKnowledgeIndexes({ indexes: [index], query, topK: 6, maxPromptTokens: budget, allowDegraded: true });
}

export interface BenchmarkMeasurement {
  id: string;
  baselinePaths: string[]; hybridPaths: string[];
  baselineRecall: number; hybridRecall: number;
  baselineTokens: number; hybridTokens: number;
  baselineLatencyMs: number; hybridLatencyMs: number;
  provenanceValid: boolean;
}
export interface ComparisonReportInput {
  baselineTokenCount: number; hybridTokenCount: number; proposals: readonly string[]; estimator?: string;
  measurements?: readonly BenchmarkMeasurement[];
}
export function buildComparisonReport(input: ComparisonReportInput): string {
  const lines = [
    `Estimator: ${input.estimator ?? "nitely.knowledge-tokenizer.v1 (UTF-8/4 plus CJK)"}`,
    "Baseline: existing knowledge engine BM25 lexical retrieval; hybrid: BM25 + local-hash vector RRF",
    `Baseline tokens: ${input.baselineTokenCount}`, `Hybrid tokens: ${input.hybridTokenCount}`,
    "id | baseline recall | hybrid recall | baseline/hybrid ms | provenance valid",
    ...(input.measurements ?? []).map((m) => `${m.id} | ${m.baselineRecall.toFixed(3)} | ${m.hybridRecall.toFixed(3)} | ${m.baselineLatencyMs.toFixed(3)}/${m.hybridLatencyMs.toFixed(3)} | ${m.provenanceValid}`),
    "Semantic signal: unavailable (local-hash is lexical feature hashing, not semantic retrieval)",
    "Downstream code/eval outcomes: not measured; real spec-to-PR fixtures and repo-index baseline comparison still required.",
    "Go gate: real-run quality, provenance, latency, token and downstream outcome evidence required.",
  ];
  if (input.proposals.length) lines.push("Review-only proposals:", ...input.proposals.map((proposal) => `- ${JSON.stringify(redactText(proposal) ?? "")}`));
  // This smoke corpus cannot authorize rollout, even if recall is perfect or tokens fall.
  lines.push("Decision: no-go");
  return lines.join("\n");
}
export interface RunBenchmarkInput {
  fixture?: BenchmarkFixture; fixturePath?: string;
  writeAuthoritativeContext?: (value: unknown) => Promise<void> | void;
  tokenBudget?: number;
}
export interface BenchmarkResult {
  report: string; proposals: string[]; baselineTokenCount: number; hybridTokenCount: number;
  decision: "no-go"; measurements: BenchmarkMeasurement[]; fixtureDigest: string;
}
export async function runBenchmark(input: RunBenchmarkInput = {}): Promise<BenchmarkResult> {
  const fixture = fixtureSchema.parse(input.fixturePath ? JSON.parse(await readFile(input.fixturePath, "utf8")) : input.fixture ?? benchmarkFixture);
  const budget = input.tokenBudget ?? 1800;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 32768) throw new Error("benchmark budget must be between 1 and 32768 tokens");
  if (fixture.documents.some((d) => sensitiveRetrievalText(d.text) || sensitiveRetrievalText(d.path))) throw new Error("fixture contains sensitive source material");
  const fixtureDigest = digest(JSON.stringify(fixture));
  const { lexical, hybrid } = await indexesForDocuments(fixture.documents, FIXTURE_COMMIT, fixtureDigest);
  const measurements: BenchmarkMeasurement[] = [];
  for (const question of fixture.questions) {
    const started = performance.now();
    const baseline = await searchIndex(lexical, question.question, budget);
    const middle = performance.now();
    const ranked = await searchIndex(hybrid, question.question, budget);
    const ended = performance.now();
    const recall = (matches: KnowledgeRetrievalMatch[]) => question.expectedPaths.length
      ? question.expectedPaths.filter((path) => matches.some((m) => m.path === path)).length / question.expectedPaths.length
      : Number(matches.length === 0);
    const provenanceValid = [...baseline.matches, ...ranked.matches].every((match) => {
      const document = fixture.documents.find((d) => d.path === match.path);
      const chunk = lexical.chunks.find((chunk) => chunk.id === match.chunkId);
      return document !== undefined && chunk !== undefined && match.commitSha === FIXTURE_COMMIT &&
        chunk.path === match.path && chunk.startLine === match.startLine && chunk.endLine === match.endLine &&
        digest(chunk.text) === match.contentDigest &&
        document.text.replace(/\r\n?/gu, "\n").split("\n").slice(chunk.startLine - 1, chunk.endLine).join("\n").includes(chunk.text) &&
        (match.truncated === true ? chunk.text.startsWith(match.text) : chunk.text === match.text);
    });
    measurements.push({ id: question.id, baselinePaths: baseline.matches.map((m) => m.path), hybridPaths: ranked.matches.map((m) => m.path),
      baselineRecall: recall(baseline.matches), hybridRecall: recall(ranked.matches),
      baselineTokens: estimateKnowledgeTokens(renderExternalKnowledgePrompt(baseline.matches).join("\n")),
      hybridTokens: estimateKnowledgeTokens(renderExternalKnowledgePrompt(ranked.matches).join("\n")),
      baselineLatencyMs: middle - started, hybridLatencyMs: ended - middle, provenanceValid });
  }
  const proposals = fixture.questions.flatMap((q) => [...q.decisions, ...q.constraints, ...q.preferences]).filter((text) => !sensitiveRetrievalText(text));
  const baselineTokenCount = measurements.reduce((sum, m) => sum + m.baselineTokens, 0);
  const hybridTokenCount = measurements.reduce((sum, m) => sum + m.hybridTokens, 0);
  return { decision: "no-go", measurements, fixtureDigest, baselineTokenCount, hybridTokenCount, proposals,
    report: [`Fixture digest: ${fixtureDigest}`, `Per-query budget: ${budget}`, buildComparisonReport({ baselineTokenCount, hybridTokenCount, proposals, measurements })].join("\n") };
}

// An immutable Git-tree corpus avoids following any worktree symlink, even under concurrent replacement.
// No network, disk index, or authoritative memory writes occur here.
export async function retrieveHybridRepositoryContext(input: { repoPath: string; policyRepoPath?: string; query: string; tokenBudget: number; redactionSecrets?: readonly string[]; readPolicy?: { maxFileBytes: number; deny: readonly string[] } }): Promise<KnowledgeRetrievalMatch[]> {
  const root = resolve(input.repoPath);
  const policy = await loadContextPolicy(input.policyRepoPath ?? root);
  const runGit = async (args: string[], maxBuffer = 2 * 1024 * 1024) => (await git("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer, timeout: 30000 })).stdout;
  const commit = (await runGit(["rev-parse", "HEAD"])).trim();
  const tree = await runGit(["ls-tree", "-r", "-z", "-l", commit]);
  const documents: Array<{ path: string; text: string }> = [];
  let bytes = 0;
  for (const record of tree.split("\0")) {
    const match = /^(100644|100755) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/u.exec(record);
    if (!match) continue; // Symlinks (120000), submodules and directories are never read.
    const [, , oid, size, path] = match;
    if (!validRelativePath(path) || ![".ts", ".tsx", ".js", ".md", ".json", ".yaml", ".yml"].includes(extname(path)) ||
      path.startsWith(".nitely/") || path.startsWith("node_modules/") || path.startsWith("dist/") || path.endsWith("lock.yaml") ||
      evaluateLocalPath(policy, path).decision !== "allowed" || Number(size) > Math.min(64 * 1024, input.readPolicy?.maxFileBytes ?? 64 * 1024) ||
      input.readPolicy?.deny.some((pattern) => globMatches(pattern, path))) continue;
    bytes += Number(size);
    if (documents.length >= 2000 || bytes > 16 * 1024 * 1024) throw new Error("hybrid repository corpus exceeds bounded retrieval limits");
    const text = await runGit(["cat-file", "blob", oid], 128 * 1024);
    if (!text || text.includes("\0") || sensitiveRetrievalText(text, input.redactionSecrets) || sensitiveRetrievalText(path, input.redactionSecrets)) continue;
    documents.push({ path, text });
  }
  const indexes = await indexesForDocuments(documents, commit, digest(JSON.stringify(policy)));
  const result = await searchIndex(indexes.hybrid, input.query, input.tokenBudget);
  return result.matches;
}

export interface PrepareContextInput<E, H> {
  env?: Record<string, string | undefined>;
  existingFlowEvidence: E;
  hybridPacker: () => H | Promise<H>;
}
export async function prepareContext<E, H>(input: PrepareContextInput<E, H>): Promise<E | { existingFlowEvidence: E; hybridContext: H }> {
  if ((input.env ?? process.env).NITELY_HYBRID_RETRIEVAL !== "1") return input.existingFlowEvidence;
  return { existingFlowEvidence: input.existingFlowEvidence, hybridContext: await input.hybridPacker() };
}
