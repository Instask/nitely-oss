import { describe, expect, it } from "vitest";

import { chunkKnowledgeDocument } from "../../src/knowledge-repositories/chunker.js";
import { estimateKnowledgeTokens } from "../../src/knowledge-repositories/tokenize.js";

const source = {
  attachmentId: "platform-standards",
  commitSha: "a".repeat(40),
  path: "docs/api.md",
};

describe("knowledge chunker", () => {
  it("creates bounded stable line chunks with overlap and provenance", () => {
    const text = [
      "# API rules",
      "All requests use request ids.",
      "",
      "Payment callbacks require signatures.",
      "Retries must be idempotent.",
      "Audit every rejected callback.",
    ].join("\n");

    const first = chunkKnowledgeDocument(
      { ...source, text },
      { maxTokens: 12, maxBytes: 256, overlapLines: 1 },
    );
    const second = chunkKnowledgeDocument(
      { ...source, text: text.replaceAll("\n", "\r\n") },
      { maxTokens: 12, maxBytes: 256, overlapLines: 1 },
    );

    expect(first.length).toBeGreaterThan(1);
    expect(second).toEqual(first);
    expect(first.map((chunk) => chunk.id)).toEqual(
      new Set(first.map((chunk) => chunk.id)).size === first.length
        ? first.map((chunk) => chunk.id)
        : [],
    );
    for (const chunk of first) {
      expect(chunk.id).toMatch(/^kbc-[0-9a-f]{64}$/);
      expect(chunk.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(chunk.startLine).toBeGreaterThan(0);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
      expect(chunk.approxTokens).toBe(estimateKnowledgeTokens(chunk.text));
      expect(chunk.approxTokens).toBeLessThanOrEqual(12);
      expect(Buffer.byteLength(chunk.text)).toBeLessThanOrEqual(256);
    }
    expect(first[1]!.startLine).toBeLessThanOrEqual(first[0]!.endLine);
  });

  it("changes chunk identity when immutable source identity changes", () => {
    const first = chunkKnowledgeDocument({ ...source, text: "One line." });
    const changedCommit = chunkKnowledgeDocument({
      ...source,
      commitSha: "b".repeat(40),
      text: "One line.",
    });

    expect(first[0]!.text).toBe(changedCommit[0]!.text);
    expect(first[0]!.id).not.toBe(changedCommit[0]!.id);
  });

  it("splits oversized single lines without breaking Unicode code points", () => {
    const chunks = chunkKnowledgeDocument(
      { ...source, text: "支付🚀".repeat(100) },
      { maxTokens: 10, maxBytes: 40, overlapLines: 0 },
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe("支付🚀".repeat(100));
    expect(chunks.some((chunk) => chunk.text.includes("�"))).toBe(false);
  });
});
