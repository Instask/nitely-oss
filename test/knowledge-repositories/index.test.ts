import { describe, expect, it } from "vitest";

import { chunkKnowledgeDocument } from "../../src/knowledge-repositories/chunker.js";
import type {
  KnowledgeEmbeddingProvider,
  KnowledgeEmbeddingProviderIdentity,
} from "../../src/knowledge-repositories/embeddings.js";
import {
  assertKnowledgeIndexIntegrity,
  buildKnowledgeIndex,
} from "../../src/knowledge-repositories/index.js";

class TestSemanticProvider implements KnowledgeEmbeddingProvider {
  readonly identity: KnowledgeEmbeddingProviderIdentity = {
    id: "test-semantic",
    model: "fixture-v1",
    version: "1",
    configurationDigest: "sha256:" + "1".repeat(64),
    dimensions: 2,
    semantic: true,
  };

  async embedDocuments(texts: readonly string[]): Promise<readonly Float32Array[]> {
    return texts.map((text) => this.vector(text));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.vector(text);
  }

  private vector(text: string): Float32Array {
    return /automobile|car/u.test(text)
      ? new Float32Array([1, 0])
      : new Float32Array([0, 1]);
  }
}

function chunks() {
  return [
    ...chunkKnowledgeDocument({
      attachmentId: "standards",
      commitSha: "a".repeat(40),
      path: "docs/car.md",
      text: "Automobile maintenance and repair handbook.",
    }),
    ...chunkKnowledgeDocument({
      attachmentId: "standards",
      commitSha: "a".repeat(40),
      path: "docs/payments.md",
      text: "支付回调必须验证签名。",
    }),
  ];
}

describe("knowledge index", () => {
  it("builds deterministic BM25 metadata and semantic vectors", async () => {
    const provider = new TestSemanticProvider();
    const first = await buildKnowledgeIndex({
      attachmentId: "standards",
      attachmentName: "Platform standards",
      commitSha: "a".repeat(40),
      policyFingerprint: "sha256:" + "b".repeat(64),
      chunks: chunks(),
      embeddingProvider: provider,
      createdAt: "2026-07-21T00:00:00.000Z",
    });
    const second = await buildKnowledgeIndex({
      attachmentId: "standards",
      attachmentName: "Platform standards",
      commitSha: "a".repeat(40),
      policyFingerprint: "sha256:" + "b".repeat(64),
      chunks: chunks().reverse(),
      embeddingProvider: provider,
      createdAt: "2026-07-21T01:00:00.000Z",
    });

    expect(first.indexDigest).toBe(second.indexDigest);
    expect(first.createdAt).not.toBe(second.createdAt);
    expect(first.embedding).toMatchObject({
      id: "test-semantic",
      semantic: true,
      dimensions: 2,
    });
    expect(first.documentCount).toBe(2);
    expect(first.averageDocumentLength).toBeGreaterThan(0);
    expect(first.documentFrequency["支付"]).toBe(1);
    expect(first.chunks.every((chunk) => chunk.vector?.length === 2)).toBe(true);
    expect(() => assertKnowledgeIndexIntegrity(first)).not.toThrow();

    const tampered = structuredClone(first);
    tampered.chunks[0]!.text = "tampered after publication";
    expect(() => assertKnowledgeIndexIntegrity(tampered)).toThrow(/digest/);
  });
});
