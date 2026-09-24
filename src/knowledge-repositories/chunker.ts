import { createHash } from "node:crypto";
import { isAbsolute, posix } from "node:path";

import {
  DEFAULT_KNOWLEDGE_BUDGETS,
  normalizeKnowledgeAttachmentId,
  type KnowledgeChunk,
} from "./schema.js";
import {
  estimateKnowledgeTokens,
  truncateKnowledgeText,
} from "./tokenize.js";

export const KNOWLEDGE_CHUNKER_VERSION = "nitely.knowledge-chunker.v1";

const DEFAULT_MAX_CHUNK_BYTES = 16 * 1024;
const GIT_OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

export interface ChunkKnowledgeDocumentInput {
  attachmentId: string;
  commitSha: string;
  path: string;
  text: string;
}

export interface ChunkKnowledgeDocumentOptions {
  maxTokens?: number;
  maxBytes?: number;
  overlapLines?: number;
  overlapTokens?: number;
}

interface LineUnit {
  line: number;
  text: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeSourcePath(value: string): string {
  if (!value || isAbsolute(value) || value.includes("\\") || /\p{Cc}/u.test(value)) {
    throw new Error("knowledge chunk path must be a safe repository-relative path");
  }
  const normalized = posix.normalize(value.replace(/^\.\//u, ""));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error("knowledge chunk path escapes the repository");
  }
  return normalized;
}

function positiveInteger(value: number, field: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`knowledge chunk ${field} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
  }
  return value;
}

function boundedPrefixByBytes(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const characters = [...value];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = characters.slice(0, middle).join("");
    if (Buffer.byteLength(candidate, "utf8") <= maximumBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return characters.slice(0, low).join("");
}

function boundedLinePrefix(value: string, maxTokens: number, maxBytes: number): string {
  const tokenBounded = truncateKnowledgeText(value, maxTokens).text;
  return boundedPrefixByBytes(tokenBounded, maxBytes);
}

function splitLine(line: string, lineNumber: number, maxTokens: number, maxBytes: number): LineUnit[] {
  if (line.length === 0) return [{ line: lineNumber, text: "" }];
  const units: LineUnit[] = [];
  let remaining = line;
  while (remaining.length > 0) {
    const prefix = boundedLinePrefix(remaining, maxTokens, maxBytes);
    if (!prefix) {
      throw new Error("knowledge chunk limits cannot fit one Unicode code point");
    }
    units.push({ line: lineNumber, text: prefix });
    remaining = remaining.slice(prefix.length);
  }
  return units;
}

function renderUnits(units: readonly LineUnit[]): string {
  let rendered = "";
  let previousLine: number | undefined;
  for (const unit of units) {
    if (previousLine !== undefined && unit.line !== previousLine) rendered += "\n";
    rendered += unit.text;
    previousLine = unit.line;
  }
  return rendered;
}

function fits(text: string, maxTokens: number, maxBytes: number): boolean {
  return estimateKnowledgeTokens(text) <= maxTokens &&
    Buffer.byteLength(text, "utf8") <= maxBytes;
}

function nextStartForOverlap(input: {
  units: readonly LineUnit[];
  start: number;
  end: number;
  overlapLines: number;
  overlapTokens?: number;
}): number {
  if (input.end >= input.units.length) return input.end;
  let candidate = input.end;
  if (input.overlapLines > 0) {
    const endLine = input.units[input.end - 1]!.line;
    const firstOverlapLine = Math.max(1, endLine - input.overlapLines + 1);
    while (
      candidate > input.start + 1 &&
      input.units[candidate - 1]!.line >= firstOverlapLine
    ) {
      candidate -= 1;
    }
  }
  if (input.overlapTokens !== undefined && input.overlapTokens > 0) {
    let tokenCandidate = input.end;
    while (tokenCandidate > input.start + 1) {
      const proposed = tokenCandidate - 1;
      const text = renderUnits(input.units.slice(proposed, input.end));
      if (estimateKnowledgeTokens(text) > input.overlapTokens) break;
      tokenCandidate = proposed;
    }
    candidate = Math.min(candidate, tokenCandidate);
  }
  return candidate <= input.start ? input.end : candidate;
}

/**
 * Split committed text into deterministic, bounded, line-addressable chunks.
 * Newlines are canonicalized to LF before IDs and content digests are computed.
 */
export function chunkKnowledgeDocument(
  input: ChunkKnowledgeDocumentInput,
  options: ChunkKnowledgeDocumentOptions = {},
): KnowledgeChunk[] {
  const attachmentId = normalizeKnowledgeAttachmentId(input.attachmentId);
  const commitSha = input.commitSha.toLowerCase();
  if (!GIT_OBJECT_ID_PATTERN.test(commitSha)) {
    throw new Error("knowledge chunk commit must be a full Git object id");
  }
  const path = normalizeSourcePath(input.path);
  const maxTokens = positiveInteger(
    options.maxTokens ?? DEFAULT_KNOWLEDGE_BUDGETS.chunkTokens,
    "maxTokens",
  );
  const maxBytes = positiveInteger(
    options.maxBytes ?? DEFAULT_MAX_CHUNK_BYTES,
    "maxBytes",
  );
  const overlapLines = positiveInteger(options.overlapLines ?? 0, "overlapLines", true);
  const overlapTokens = options.overlapTokens === undefined
    ? undefined
    : positiveInteger(options.overlapTokens, "overlapTokens", true);
  if (overlapTokens !== undefined && overlapTokens >= maxTokens) {
    throw new Error("knowledge chunk overlapTokens must be smaller than maxTokens");
  }

  const normalizedText = input.text.replace(/\r\n?/gu, "\n");
  if (!normalizedText) return [];
  const units = normalizedText
    .split("\n")
    .flatMap((line, index) => splitLine(line, index + 1, maxTokens, maxBytes));
  const chunks: KnowledgeChunk[] = [];
  let start = 0;
  let sequence = 0;
  while (start < units.length) {
    let end = start + 1;
    while (end < units.length) {
      const candidate = renderUnits(units.slice(start, end + 1));
      if (!fits(candidate, maxTokens, maxBytes)) break;
      end += 1;
    }
    const selected = units.slice(start, end);
    const text = renderUnits(selected);
    if (!fits(text, maxTokens, maxBytes)) {
      throw new Error("knowledge chunk exceeded its configured bounds");
    }
    if (text.trim()) {
      const startLine = selected[0]!.line;
      const endLine = selected[selected.length - 1]!.line;
      const digest = sha256(text);
      const identity = [
        KNOWLEDGE_CHUNKER_VERSION,
        attachmentId,
        commitSha,
        path,
        String(startLine),
        String(endLine),
        String(sequence),
        digest,
      ].join("\0");
      chunks.push({
        id: `kbc-${sha256(identity)}`,
        attachmentId,
        commitSha,
        path,
        startLine,
        endLine,
        text,
        contentDigest: `sha256:${digest}`,
        approxTokens: estimateKnowledgeTokens(text),
      });
      sequence += 1;
    }
    start = nextStartForOverlap({
      units,
      start,
      end,
      overlapLines,
      overlapTokens,
    });
  }
  return chunks;
}
