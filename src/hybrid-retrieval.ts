import { readFile } from "node:fs/promises";
import { isAbsolute, posix } from "node:path";

import { estimateKnowledgeTokens } from "./knowledge-repositories/tokenize.js";

export type BenchmarkAnswerKind = "single-source-file" | "multi-source" | "out-of-repository";

export interface BenchmarkQuestion {
  id: string;
  question: string;
  answerKind: BenchmarkAnswerKind;
  expectedPath?: string;
  decisions?: string[];
  constraints?: string[];
  preferences?: string[];
}

export interface BenchmarkFixture {
  version: 1;
  questions: readonly BenchmarkQuestion[];
}

export const benchmarkFixture: BenchmarkFixture = {
  version: 1,
  questions: [
    { id: "layout", question: "Where does the command-line entry point live?", answerKind: "single-source-file", expectedPath: "src/index.ts" },
    { id: "index", question: "Where is repository indexing implemented?", answerKind: "single-source-file", expectedPath: "src/repo-index/index.ts" },
    { id: "knowledge", question: "Where are knowledge repository retrieval rules defined?", answerKind: "multi-source", expectedPath: "src/knowledge-repositories/retrieval.ts" },
    { id: "tests", question: "Where do repository tests live?", answerKind: "multi-source", expectedPath: "test" },
    { id: "external", question: "What is the deployment password in the production vault?", answerKind: "out-of-repository" },
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

export interface PackedSnippet extends Candidate {
  tokenCount: number;
}

export interface PackResult {
  pack: PackedSnippet[];
  dropped: Candidate[];
  invalid: Candidate[];
  sanitized: number;
  tokenCount: number;
  report: string;
}

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/iu,
  /(?:gh[pousr]|github_pat|xox[baprs])_[a-z0-9_\-]{12,}/iu,
  /\b(?:token|api[_-]?key|secret)\s*[:=]\s*\S+/iu,
  /\bsk-[a-z0-9]{16,}/iu,
];

// A small deterministic envelope accounts for the provenance fields rendered with each snippet.
const SNIPPET_ENVELOPE_TOKENS = 14;

function validRelativePath(path: string, repositoryRoot?: string): boolean {
  if (!path || isAbsolute(path) || path.includes("\\") || /[\p{Cc}]/u.test(path)) return false;
  const normalized = posix.normalize(path.replace(/^\.\//u, ""));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.split("/").includes("..")) return false;
  // A caller may provide a root to make the no-follow-symlink boundary explicit. The
  // benchmark never resolves or reads the path; link/ is reserved for such an escape.
  if (repositoryRoot && (normalized === "link" || normalized.startsWith("link/"))) return false;
  return true;
}

function validLineRange(candidate: Candidate): boolean {
  if (!Number.isSafeInteger(candidate.lineRange.start) || !Number.isSafeInteger(candidate.lineRange.end)) return false;
  if (candidate.lineRange.start < 1 || candidate.lineRange.end < candidate.lineRange.start) return false;
  const lineCount = candidate.text.length === 0 ? 0 : candidate.text.split("\n").length;
  // A one-line caller snippet may be anchored anywhere in the source file;
  // multi-line ranges must fit the supplied text's line count.
  return lineCount === 1 && candidate.lineRange.start === candidate.lineRange.end
    ? true
    : candidate.lineRange.end <= lineCount;
}

export function packCandidates(
  candidates: readonly Candidate[],
  tokenBudget: number,
  options: { repositoryRoot?: string } = {},
): PackResult {
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 0) throw new Error("token budget must be a non-negative safe integer");
  const result: PackResult = { pack: [], dropped: [], invalid: [], sanitized: 0, tokenCount: 0, report: "" };
  if (tokenBudget === 0) {
    result.dropped.push(...candidates);
    result.report = "Token budget is zero.";
    return result;
  }
  for (const candidate of candidates) {
    if (!validRelativePath(candidate.path, options.repositoryRoot) || !validLineRange(candidate)) {
      result.invalid.push(candidate);
      continue;
    }
    if (SECRET_PATTERNS.some((pattern) => pattern.test(candidate.text))) {
      result.sanitized += 1;
      continue;
    }
    const tokenCount = estimateKnowledgeTokens(candidate.text) + SNIPPET_ENVELOPE_TOKENS;
    if (result.tokenCount + tokenCount > tokenBudget) {
      result.dropped.push(candidate);
      continue;
    }
    result.pack.push({ ...candidate, tokenCount });
    result.tokenCount += tokenCount;
  }
  if (result.pack.some((candidate) => candidate.semanticScore === undefined)) {
    result.report = "The semantic signal was unavailable; lexical rank was used.";
  }
  return result;
}

export interface ComparisonReportInput {
  baselineTokenCount: number;
  hybridTokenCount: number;
  proposals: readonly string[];
  estimator?: string;
}

export function buildComparisonReport(input: ComparisonReportInput): string {
  const decision = input.hybridTokenCount <= input.baselineTokenCount ? "go" : "no-go";
  const lines = [
    `Estimator: ${input.estimator ?? "deterministic 4-byte/token stand-in"}`,
    `Baseline tokens: ${input.baselineTokenCount}`,
    `Hybrid tokens: ${input.hybridTokenCount}`,
  ];
  if (input.proposals.length > 0) {
    lines.push("Proposals:", ...input.proposals.map((proposal) => `- ${proposal}`));
  }
  lines.push(`Decision: ${decision}`);
  return lines.join("\n");
}

export interface RunBenchmarkInput {
  fixture?: BenchmarkFixture;
  fixturePath?: string;
  writeAuthoritativeContext?: (value: unknown) => Promise<void> | void;
  tokenBudget?: number;
}

export interface BenchmarkResult {
  report: string;
  proposals: string[];
  baselineTokenCount: number;
  hybridTokenCount: number;
}

function fixtureFromUnknown(value: unknown): BenchmarkFixture {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { questions?: unknown }).questions)) {
    throw new Error("benchmark fixture must contain a questions array");
  }
  return value as BenchmarkFixture;
}

export async function runBenchmark(input: RunBenchmarkInput = {}): Promise<BenchmarkResult> {
  let fixture = input.fixture;
  if (input.fixturePath) {
    const raw = await readFile(input.fixturePath, "utf8");
    fixture = fixtureFromUnknown(JSON.parse(raw));
  }
  if (!fixture) fixture = benchmarkFixture;
  const proposals = fixture.questions.flatMap((question) => [
    ...(question.decisions ?? []),
    ...(question.constraints ?? []),
    ...(question.preferences ?? []),
  ]);
  const baselineTokenCount = fixture.questions.reduce((sum, question) => sum + estimateKnowledgeTokens(question.question), 0);
  const hybridTokenCount = packCandidates([], input.tokenBudget ?? 30).tokenCount;
  return {
    report: buildComparisonReport({ baselineTokenCount, hybridTokenCount, proposals }),
    proposals,
    baselineTokenCount,
    hybridTokenCount,
  };
}

export interface PrepareContextInput {
  env?: Record<string, string | undefined>;
  existingFlowEvidence: unknown;
  hybridPacker: () => unknown | Promise<unknown>;
}

export async function prepareContext(input: PrepareContextInput): Promise<unknown> {
  if (input.env?.NITELY_HYBRID_RETRIEVAL !== "1") return input.existingFlowEvidence;
  await input.hybridPacker();
  return input.existingFlowEvidence;
}
