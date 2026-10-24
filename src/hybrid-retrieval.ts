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
import { FrozenSemanticEmbeddingProvider, LocalHashEmbeddingProvider, type KnowledgeEmbeddingProvider } from "./knowledge-repositories/embeddings.js";
import { FROZEN_SEMANTIC_DIMENSIONS, FROZEN_SEMANTIC_MODEL, FROZEN_SEMANTIC_SOURCE_DIGEST } from "./knowledge-repositories/frozen-semantic-table.js";
import { buildKnowledgeIndex, type KnowledgeIndexArtifact } from "./knowledge-repositories/index.js";
import { escapeKnowledgePromptText, queryKnowledgeIndexes, type KnowledgeRetrievalMatch } from "./knowledge-repositories/retrieval.js";
import { estimateKnowledgeTokens, normalizeKnowledgeText, tokenizeKnowledgeText } from "./knowledge-repositories/tokenize.js";

const git = promisify(execFile);
const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const sourceRevision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64}|sha256:[a-f0-9]{64})$/u);
const relativePath = z.string().refine((path) => validRelativePath(path));
const unitInterval = z.number().min(0).max(1);
const questionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), question: z.string().min(1).max(16000),
  answerKind: z.enum(["single-source-file", "multi-source", "out-of-repository"]),
  expectedPaths: z.array(relativePath).default([]),
  expectedOutcome: z.string().min(1).max(500).optional(),
  decisions: z.array(z.string()).default([]), constraints: z.array(z.string()).default([]), preferences: z.array(z.string()).default([]),
}).superRefine((question, ctx) => {
  if ((question.answerKind === "out-of-repository") !== (question.expectedPaths.length === 0)) {
    ctx.addIssue({ code: "custom", message: "repository questions require expected paths; external questions must have none" });
  }
});
const documentSchema = z.object({
  path: relativePath,
  text: z.string().min(1).max(64000),
  symbol: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,120}$/u).optional(),
  recency: unitInterval.optional(),
  importance: unitInterval.optional(),
});
const fixtureSchema = z.object({
  version: z.literal(1),
  documents: z.array(documentSchema).min(1).max(100),
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

// Public-code-shaped corpus. Paraphrase questions share little wording with the
// passage that contains the expected outcome; lexical distractors reuse the question's words.
export const benchmarkFixture: BenchmarkFixture = {
  version: 1,
  documents: [
    { path: "src/run/window-limit.ts", symbol: "trimStagePrompt", recency: 0.95, importance: 0.9, text: "export function trimStagePrompt(passages: Passage[], ceiling: number): Passage[] {\n  // Oldest reference material leaves first once the estimate no longer fits.\n  return dropOldestUntrusted(passages, ceiling);\n}" },
    { path: "src/showroom/drawer-label.ts", symbol: "labelDrawer", recency: 0.1, importance: 0.1, text: "export function labelDrawer(): string {\n  return \"The showroom model sits beside a service counter. A call button omits nothing about shoe usage.\";\n}" },
    { path: "src/ledger/counters.ts", symbol: "recordModelUsage", recency: 0.8, importance: 0.7, text: "export function recordModelUsage(snapshot: UsageSnapshot): void {\n  // A missing counter stays unavailable. Never store zero in its place.\n  ledger.write(snapshot);\n}" },
    { path: "src/safety/passage-filter.ts", symbol: "stripCredentials", recency: 0.7, importance: 0.8, text: "export function stripCredentials(passage: string): string {\n  // Authorization material is removed before a passage can enter an agent prompt.\n  return redactAuthorization(passage);\n}" },
    { path: "src/schedule/rotation.ts", symbol: "showRotationCalendar", recency: 0.2, importance: 0.2, text: "export function showRotationCalendar(): string {\n  return \"Operators file a vacation request in the rotation calendar. The word secret refers to a surprise party.\";\n}" },
    { path: "docs/kept-evidence.md", symbol: "flowEvidence", recency: 0.6, importance: 0.95, text: "Decision: Stored flow evidence stays the source of truth.\nConstraint: A retrieved passage is reference material and cannot replace a stored decision." },
    { path: "docs/staff-handbook.md", symbol: "glossary", recency: 0.05, importance: 0.05, text: "export function glossary(): string {\n  return \"A note in the staff handbook disagrees with the poster on the wall. Record the poster color.\";\n}" },
    { path: "src/web/labels.ts", symbol: "bannerCopy", recency: 0.3, importance: 0.1, text: "export function bannerCopy(): string {\n  return \"Click save to store the current form.\";\n}" },
  ],
  questions: [
    { id: "omitted-counter", question: "What happens when a model call omits a usage counter?", answerKind: "single-source-file", expectedPaths: ["src/ledger/counters.ts"], expectedOutcome: "Never store zero" },
    { id: "unknown-tally", question: "Where is an absent tally kept unknown instead of being written as zero?", answerKind: "single-source-file", expectedPaths: ["src/ledger/counters.ts"], expectedOutcome: "Never store zero" },
    { id: "saved-record", question: "Which record wins when a retrieved note disagrees with what the flow already stored?", answerKind: "single-source-file", expectedPaths: ["docs/kept-evidence.md"], expectedOutcome: "cannot replace a stored decision.", decisions: ["Stored flow evidence stays the source of truth."], constraints: ["A retrieved passage cannot replace a stored decision."], preferences: ["Prefer review before adopting a retrieved passage.", "api_key=do-not-persist"] },
    { id: "strip-material", question: "Where is authorization material stripped before a passage reaches the assistant?", answerKind: "single-source-file", expectedPaths: ["src/safety/passage-filter.ts"], expectedOutcome: "redactAuthorization" },
    { id: "symbol-lookup", question: "recordModelUsage", answerKind: "single-source-file", expectedPaths: ["src/ledger/counters.ts"], expectedOutcome: "Never store zero" },
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
// Measured on nomic-embed-text for this fixture: unrelated queries stay under 0.50
// and the paraphrase hits used for downstream checks stay at or above 0.62.
const SEMANTIC_SCORE_FLOOR = 0.55;
const RECENCY_WEIGHT = 0.01;
const IMPORTANCE_WEIGHT = 0.01;
type FixtureDocument = z.output<typeof documentSchema>;

export function benchmarkEmbeddingTexts(fixture: BenchmarkFixture): string[] {
  const parsed = fixtureSchema.parse(fixture);
  const chunks = parsed.documents.flatMap((document) => chunkKnowledgeDocument({
    attachmentId: "task-repository", commitSha: FIXTURE_COMMIT, path: document.path, text: document.text,
  }, { maxTokens: 400 }));
  return [...chunks.map((chunk) => normalizeKnowledgeText(chunk.text)), ...parsed.questions.map((question) => normalizeKnowledgeText(question.question))];
}
async function indexesForDocuments(documents: readonly { path: string; text: string }[], commitSha: string, policyFingerprint: string, embeddingProvider?: KnowledgeEmbeddingProvider) {
  const chunks = documents.flatMap((document) => chunkKnowledgeDocument({ attachmentId: "task-repository", commitSha, path: document.path, text: document.text }, { maxTokens: 400 }));
  const base = { attachmentId: "task-repository", commitSha, policyFingerprint, chunks, createdAt: "2026-01-01T00:00:00.000Z" };
  const lexical = await buildKnowledgeIndex(base);
  const hybrid = await buildKnowledgeIndex({ ...base, embeddingProvider: embeddingProvider ?? new LocalHashEmbeddingProvider() });
  return { lexical, hybrid };
}
async function searchIndex(index: KnowledgeIndexArtifact, query: string, budget: number, embeddingProvider?: KnowledgeEmbeddingProvider) {
  return queryKnowledgeIndexes({
    indexes: [index], query, topK: 6, maxPromptTokens: budget, allowDegraded: !embeddingProvider,
    ...(embeddingProvider ? { embeddingProviders: [embeddingProvider] } : {}),
  });
}
function citedText(text: string): { text: string; start: number; end: number } {
  const normalized = text.replace(/\r\n?/gu, "\n").replace(/\n$/u, "");
  return { text: normalized, start: 1, end: normalized.split("\n").length };
}
function overlapRank(documents: readonly FixtureDocument[], query: string): Array<{ document: FixtureDocument; overlap: number }> {
  const terms = new Set(tokenizeKnowledgeText(query));
  return documents.flatMap((document) => {
    const overlap = new Set(tokenizeKnowledgeText(document.text).filter((token) => terms.has(token))).size;
    return overlap > 0 ? [{ document, overlap }] : [];
  }).sort((left, right) => right.overlap - left.overlap || left.document.path.localeCompare(right.document.path));
}
function repoIndexRank(documents: readonly FixtureDocument[], query: string): Array<{ document: FixtureDocument; score: number }> {
  const lowered = query.trim().toLowerCase();
  if (!lowered) return [];
  return documents.flatMap((document) => {
    const symbolHit = (document.symbol ?? "").toLowerCase().includes(lowered);
    const pathHit = document.path.toLowerCase().includes(lowered);
    if (!symbolHit && !pathHit) return [];
    return [{ document, score: (pathHit ? 100 : 0) + (symbolHit ? 90 : 0) }];
  }).sort((left, right) => right.score - left.score || left.document.path.localeCompare(right.document.path));
}
function packDocuments(items: readonly { path: string; text: string; score: number; reason: string; semanticScore?: number; lineRange?: { start: number; end: number } }[], budget: number): PackResult {
  return packCandidates(items.map((item) => {
    const cited = citedText(item.text);
    return {
      path: item.path, text: cited.text, lineRange: item.lineRange ?? { start: cited.start, end: cited.end },
      sourceRevision: FIXTURE_COMMIT, relevanceScore: Math.max(0, item.score), reason: item.reason,
      ...(item.semanticScore === undefined ? {} : { semanticScore: item.semanticScore }),
    };
  }), budget);
}
function outcomePass(question: BenchmarkQuestion, path: string | undefined, text: string | undefined): boolean {
  if (question.answerKind === "out-of-repository") return !path;
  if (!question.expectedOutcome || !path || !text) return false;
  return question.expectedPaths.includes(path) && text.includes(question.expectedOutcome);
}
function recallOf(question: BenchmarkQuestion, paths: readonly string[]): number {
  return question.expectedPaths.length
    ? question.expectedPaths.filter((path) => paths.includes(path)).length / question.expectedPaths.length
    : Number(paths.length === 0);
}
function selectHybridMatches(matches: readonly KnowledgeRetrievalMatch[], semantic: boolean): KnowledgeRetrievalMatch[] {
  const selected = semantic
    ? matches.filter((match) => match.semanticScore >= SEMANTIC_SCORE_FLOOR || match.lexicalScore > 0)
    : [...matches];
  return selected;
}
function rerankHybrid(matches: readonly KnowledgeRetrievalMatch[], documents: readonly FixtureDocument[]): { matches: KnowledgeRetrievalMatch[]; reordered: boolean } {
  const score = (match: KnowledgeRetrievalMatch) => {
    const document = documents.find((item) => item.path === match.path);
    return match.fusedScore * (1 + RECENCY_WEIGHT * (document?.recency ?? 0) + IMPORTANCE_WEIGHT * (document?.importance ?? 0));
  };
  const ordered = [...matches].sort((left, right) => score(right) - score(left) || left.path.localeCompare(right.path) || left.startLine - right.startLine);
  const key = (items: readonly KnowledgeRetrievalMatch[]) => items.map((match) => `${match.path}:${match.startLine}`).join("\0");
  return { matches: ordered, reordered: key(matches) !== key(ordered) };
}

export interface BenchmarkMeasurement {
  id: string;
  question: string;
  baselinePaths: string[]; hybridPaths: string[]; fileGrepPaths: string[]; repoIndexPaths: string[];
  baselineRecall: number; hybridRecall: number; fileGrepRecall: number; repoIndexRecall: number;
  baselineTokens: number; hybridTokens: number; fileGrepTokens: number; repoIndexTokens: number;
  fileGrepHits: number;
  baselineLatencyMs: number; hybridLatencyMs: number; fileGrepLatencyMs: number; repoIndexLatencyMs: number;
  provenanceValid: boolean;
  downstreamMeasured: boolean;
  outOfRepository: boolean;
  fileGrepPass: boolean; repoIndexPass: boolean; baselinePass: boolean; hybridPass: boolean;
  fileGrepTop: string; repoIndexTop: string; baselineTop: string; hybridTop: string;
  hybridLines: string; hybridDigest: string;
  recencyBefore: string;
  recencyReordered: boolean;
}
export interface ComparisonReportInput {
  baselineTokenCount: number; hybridTokenCount: number; fileGrepTokenCount?: number; repoIndexTokenCount?: number;
  proposals: readonly string[]; estimator?: string;
  measurements?: readonly BenchmarkMeasurement[];
  semantic?: { id: string; model: string; sourceDigest: string; dimensions: number };
  sanitized?: number; invalid?: number; withheldProposals?: number;
  budgetHeld?: boolean; externalAbstained?: boolean;
  fileGrepPasses?: number; repoIndexPasses?: number; lexicalPasses?: number; hybridPasses?: number;
}
function counted(value: number | undefined): string {
  return value === undefined ? "unavailable" : String(value);
}
function gateDecision(input: ComparisonReportInput): "go" | "no-go" {
  const measurements = input.measurements ?? [];
  const measured = measurements.length > 0 && measurements.every((measurement) => measurement.downstreamMeasured && measurement.provenanceValid);
  const ahead = (input.hybridPasses ?? -1) > (input.fileGrepPasses ?? Number.POSITIVE_INFINITY) &&
    (input.hybridPasses ?? -1) > (input.repoIndexPasses ?? Number.POSITIVE_INFINITY) &&
    (input.hybridPasses ?? -1) > (input.lexicalPasses ?? Number.POSITIVE_INFINITY);
  return input.semantic && input.budgetHeld === true && input.externalAbstained === true && measured && ahead ? "go" : "no-go";
}
export function buildComparisonReport(input: ComparisonReportInput): string {
  const decision = gateDecision(input);
  const lines = [
    `Estimator: ${input.estimator ?? "nitely.knowledge-tokenizer.v1 (UTF-8/4 plus CJK)"}`,
    "Arms: file-grep content-token overlap; repo-index path and exported-symbol substring; BM25 lexical; hybrid BM25 + semantic cosine fused with reciprocal rank and a bounded recency/importance adjustment",
    `Semantic floor: ${SEMANTIC_SCORE_FLOOR}`, `Recency weight: ${RECENCY_WEIGHT}`, `Importance weight: ${IMPORTANCE_WEIGHT}`,
    input.semantic
      ? `Semantic provider: ${input.semantic.id} ${input.semantic.model} semantic=true dimensions=${input.semantic.dimensions} source=${input.semantic.sourceDigest}`
      : "Semantic provider: unavailable",
    `File-grep tokens: ${counted(input.fileGrepTokenCount)}`, `Repo-index tokens: ${counted(input.repoIndexTokenCount)}`,
    `BM25 tokens: ${input.baselineTokenCount}`, `Hybrid tokens: ${input.hybridTokenCount}`,
    `Sanitized: ${input.sanitized ?? 0}`, `Invalid: ${input.invalid ?? 0}`, `Proposals withheld: ${input.withheldProposals ?? 0}`,
    `Token budget held: ${input.budgetHeld === undefined ? "unavailable" : input.budgetHeld}`,
    `Out-of-repository abstained: ${input.externalAbstained === undefined ? "unavailable" : input.externalAbstained}`,
    `Downstream passes: file-grep ${counted(input.fileGrepPasses)}, repo-index ${counted(input.repoIndexPasses)}, BM25 ${counted(input.lexicalPasses)}, hybrid ${counted(input.hybridPasses)}`,
    "Latency is recorded per question and is excluded from the decision.",
    "id | file-grep top/pass/hits | repo-index top/pass | bm25 top/pass | hybrid top/lines/pass | recalls grep/index/bm25/hybrid | tokens grep/index/bm25/hybrid | ms grep/index/bm25/hybrid | provenance | recency reordered",
    ...(input.measurements ?? []).map((measurement) => [
      measurement.id,
      `${measurement.fileGrepTop || "none"}/${measurement.fileGrepPass}/${measurement.fileGrepHits}`,
      `${measurement.repoIndexTop || "none"}/${measurement.repoIndexPass}`,
      `${measurement.baselineTop || "none"}/${measurement.baselinePass}`,
      `${measurement.hybridTop || "none"}/${measurement.hybridLines || "none"}/${measurement.hybridPass}`,
      `${measurement.fileGrepRecall.toFixed(3)}/${measurement.repoIndexRecall.toFixed(3)}/${measurement.baselineRecall.toFixed(3)}/${measurement.hybridRecall.toFixed(3)}`,
      `${measurement.fileGrepTokens}/${measurement.repoIndexTokens}/${measurement.baselineTokens}/${measurement.hybridTokens}`,
      `${measurement.fileGrepLatencyMs.toFixed(3)}/${measurement.repoIndexLatencyMs.toFixed(3)}/${measurement.baselineLatencyMs.toFixed(3)}/${measurement.hybridLatencyMs.toFixed(3)}`,
      measurement.provenanceValid,
      measurement.recencyReordered ? `${measurement.recencyBefore || "none"}->${measurement.hybridTop || "none"}` : "unchanged",
    ].join(" | ")),
    ...(input.measurements ?? []).flatMap((measurement) => [
      `Question ${measurement.id}: ${measurement.question}`,
      `Provenance ${measurement.id} hybrid ${measurement.hybridTop || "none"} ${measurement.hybridLines || "none"} ${measurement.hybridDigest || "none"}`,
    ]),
    "Go gate requires a semantic provider, valid provenance, a held token budget, out-of-repository abstention, and strictly more downstream passes than file-grep, repo-index, and BM25.",
    "Review-only proposals are not written to authoritative memory.",
  ];
  if (input.proposals.length) lines.push(...input.proposals.map((proposal) => `- ${JSON.stringify(redactText(proposal) ?? "")}`));
  lines.push(`Decision: ${decision}`);
  return lines.join("\n");
}
export interface RunBenchmarkInput {
  fixture?: BenchmarkFixture; fixturePath?: string;
  writeAuthoritativeContext?: (value: unknown) => Promise<void> | void;
  tokenBudget?: number;
}
export interface BenchmarkResult {
  report: string; proposals: string[]; baselineTokenCount: number; hybridTokenCount: number;
  decision: "go" | "no-go"; measurements: BenchmarkMeasurement[]; fixtureDigest: string;
}
export async function runBenchmark(input: RunBenchmarkInput = {}): Promise<BenchmarkResult> {
  const fixture = fixtureSchema.parse(input.fixturePath ? JSON.parse(await readFile(input.fixturePath, "utf8")) : input.fixture ?? benchmarkFixture);
  const budget = input.tokenBudget ?? 1800;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 32768) throw new Error("benchmark budget must be between 1 and 32768 tokens");
  if (fixture.documents.some((document) => sensitiveRetrievalText(document.text) || sensitiveRetrievalText(document.path))) throw new Error("fixture contains sensitive source material");
  const fixtureDigest = digest(JSON.stringify(fixture));
  const needed = benchmarkEmbeddingTexts(fixture);
  const semanticProvider = new FrozenSemanticEmbeddingProvider();
  const semantic = needed.every((text) => semanticProvider.has(text)) ? semanticProvider : undefined;
  const { lexical, hybrid } = await indexesForDocuments(fixture.documents, FIXTURE_COMMIT, fixtureDigest, semantic);
  const measurements: BenchmarkMeasurement[] = [];
  let sanitized = 0;
  let invalid = 0;
  let semanticModesValid = Boolean(semantic);
  for (const question of fixture.questions) {
    const grepStarted = performance.now();
    const grepHits = overlapRank(fixture.documents, question.question);
    const grepLatency = performance.now() - grepStarted;
    const indexStarted = performance.now();
    const indexHits = repoIndexRank(fixture.documents, question.question);
    const indexLatency = performance.now() - indexStarted;
    const baselineStarted = performance.now();
    const baseline = await searchIndex(lexical, question.question, budget);
    const baselineLatency = performance.now() - baselineStarted;
    const hybridStarted = performance.now();
    const ranked = await searchIndex(hybrid, question.question, budget, semantic);
    if (semantic && ranked.mode !== "hybrid-semantic") semanticModesValid = false;
    const selected = selectHybridMatches(ranked.matches, Boolean(semantic));
    const recencyBefore = selected[0]?.path ?? "";
    const reranked = semantic ? rerankHybrid(selected, fixture.documents) : { matches: selected, reordered: false };
    const hybridLatency = performance.now() - hybridStarted;
    const grepPack = packDocuments(grepHits.slice(0, 6).map((hit) => ({ path: hit.document.path, text: hit.document.text, score: hit.overlap, reason: "file-grep" })), budget);
    const indexPack = packDocuments(indexHits.slice(0, 6).map((hit) => ({ path: hit.document.path, text: hit.document.text, score: hit.score, reason: "repo-index" })), budget);
    const baselinePack = packDocuments(baseline.matches.map((match) => ({
      path: match.path, text: match.text, score: match.fusedScore, reason: "bm25", lineRange: { start: match.startLine, end: match.endLine },
    })), budget);
    const hybridPack = packDocuments(reranked.matches.map((match) => ({
      path: match.path, text: match.text, score: match.fusedScore, reason: semantic ? "hybrid-semantic" : "lexical-hash",
      lineRange: { start: match.startLine, end: match.endLine }, ...(semantic ? { semanticScore: match.semanticScore } : {}),
    })), budget);
    sanitized += hybridPack.sanitized;
    invalid += hybridPack.invalid.length;
    const provenanceValid = [...baseline.matches, ...ranked.matches].every((match) => {
      const document = fixture.documents.find((item) => item.path === match.path);
      const chunk = lexical.chunks.find((item) => item.id === match.chunkId);
      return document !== undefined && chunk !== undefined && match.commitSha === FIXTURE_COMMIT &&
        chunk.path === match.path && chunk.startLine === match.startLine && chunk.endLine === match.endLine &&
        digest(chunk.text) === match.contentDigest &&
        document.text.replace(/\r\n?/gu, "\n").split("\n").slice(chunk.startLine - 1, chunk.endLine).join("\n").includes(chunk.text) &&
        (match.truncated === true ? chunk.text.startsWith(match.text) : chunk.text === match.text);
    }) && [...grepHits, ...indexHits].every((hit) => {
      const cited = citedText(hit.document.text);
      return validRelativePath(hit.document.path) && cited.end === cited.text.split("\n").length && cited.text.length > 0;
    });
    const grepTop = grepHits[0];
    const indexTop = indexHits[0];
    const baselineTop = baseline.matches[0];
    const hybridTop = reranked.matches[0];
    const measured = question.answerKind === "out-of-repository" || Boolean(question.expectedOutcome);
    measurements.push({
      id: question.id, question: question.question,
      baselinePaths: baseline.matches.map((match) => match.path), hybridPaths: reranked.matches.map((match) => match.path),
      fileGrepPaths: grepHits.map((hit) => hit.document.path), repoIndexPaths: indexHits.map((hit) => hit.document.path),
      baselineRecall: recallOf(question, baseline.matches.map((match) => match.path)), hybridRecall: recallOf(question, reranked.matches.map((match) => match.path)),
      fileGrepRecall: recallOf(question, grepHits.map((hit) => hit.document.path)), repoIndexRecall: recallOf(question, indexHits.map((hit) => hit.document.path)),
      baselineTokens: baselinePack.invalid.length > 0 ? baseline.approxTokens : baselinePack.tokenCount,
      hybridTokens: hybridPack.invalid.length > 0 ? ranked.approxTokens : hybridPack.tokenCount,
      fileGrepTokens: grepPack.tokenCount, repoIndexTokens: indexPack.tokenCount, fileGrepHits: grepHits.length,
      baselineLatencyMs: baselineLatency, hybridLatencyMs: hybridLatency, fileGrepLatencyMs: grepLatency, repoIndexLatencyMs: indexLatency,
      provenanceValid, downstreamMeasured: measured, outOfRepository: question.answerKind === "out-of-repository",
      fileGrepPass: outcomePass(question, grepTop?.document.path, grepTop?.document.text),
      repoIndexPass: outcomePass(question, indexTop?.document.path, indexTop?.document.text),
      baselinePass: outcomePass(question, baselineTop?.path, baselineTop?.text),
      hybridPass: outcomePass(question, hybridTop?.path, hybridTop?.text),
      fileGrepTop: grepTop?.document.path ?? "", repoIndexTop: indexTop?.document.path ?? "",
      baselineTop: baselineTop?.path ?? "", hybridTop: hybridTop?.path ?? "",
      hybridLines: hybridTop ? `L${hybridTop.startLine}-L${hybridTop.endLine}` : "",
      hybridDigest: hybridTop?.contentDigest ?? "", recencyBefore, recencyReordered: reranked.reordered,
    });
  }
  const rawProposals = fixture.questions.flatMap((question) => [...question.decisions, ...question.constraints, ...question.preferences]);
  const proposals = rawProposals.filter((text) => !sensitiveRetrievalText(text));
  const passCount = (key: "fileGrepPass" | "repoIndexPass" | "baselinePass" | "hybridPass") =>
    measurements.filter((measurement) => measurement.downstreamMeasured && measurement[key]).length;
  const external = measurements.filter((measurement) => measurement.outOfRepository);
  const reportInput: ComparisonReportInput = {
    baselineTokenCount: measurements.reduce((sum, measurement) => sum + measurement.baselineTokens, 0),
    hybridTokenCount: measurements.reduce((sum, measurement) => sum + measurement.hybridTokens, 0),
    fileGrepTokenCount: measurements.reduce((sum, measurement) => sum + measurement.fileGrepTokens, 0),
    repoIndexTokenCount: measurements.reduce((sum, measurement) => sum + measurement.repoIndexTokens, 0),
    proposals, measurements, sanitized, invalid, withheldProposals: rawProposals.length - proposals.length,
    budgetHeld: measurements.every((measurement) => measurement.hybridTokens <= budget && measurement.baselineTokens <= budget && measurement.fileGrepTokens <= budget && measurement.repoIndexTokens <= budget),
    externalAbstained: external.length > 0 && external.every((measurement) => measurement.hybridPass && measurement.hybridPaths.length === 0),
    fileGrepPasses: passCount("fileGrepPass"), repoIndexPasses: passCount("repoIndexPass"),
    lexicalPasses: passCount("baselinePass"), hybridPasses: passCount("hybridPass"),
    ...(semantic && semanticModesValid ? {
      semantic: { id: semantic.identity.id, model: FROZEN_SEMANTIC_MODEL, sourceDigest: FROZEN_SEMANTIC_SOURCE_DIGEST, dimensions: FROZEN_SEMANTIC_DIMENSIONS },
    } : {}),
  };
  return {
    decision: gateDecision(reportInput), measurements, fixtureDigest, proposals,
    baselineTokenCount: reportInput.baselineTokenCount, hybridTokenCount: reportInput.hybridTokenCount,
    report: [`Fixture digest: ${fixtureDigest}`, `Per-query budget: ${budget}`, buildComparisonReport(reportInput)].join("\n"),
  };
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
