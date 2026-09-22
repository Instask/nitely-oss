import { describe, expect, it } from "vitest";

import { chunkKnowledgeDocument } from "../../src/knowledge-repositories/chunker.js";
import type {
  KnowledgeEmbeddingProvider,
  KnowledgeEmbeddingProviderIdentity,
} from "../../src/knowledge-repositories/embeddings.js";
import { LocalHashEmbeddingProvider } from "../../src/knowledge-repositories/embeddings.js";
import { buildKnowledgeIndex } from "../../src/knowledge-repositories/index.js";
import { renderExternalKnowledgePrompt } from "../../src/knowledge-repositories/prompt.js";
import {
  knowledgeCitation,
  queryKnowledgeIndexes,
} from "../../src/knowledge-repositories/retrieval.js";
import { estimateKnowledgeTokens } from "../../src/knowledge-repositories/tokenize.js";

class SemanticFixtureProvider implements KnowledgeEmbeddingProvider {
  queryCalls = 0;

  constructor(
    readonly identity: KnowledgeEmbeddingProviderIdentity,
    private readonly automobileAxis: 0 | 1,
  ) {}

  async embedDocuments(texts: readonly string[]): Promise<readonly Float32Array[]> {
    return texts.map((text) => this.vector(text));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    this.queryCalls += 1;
    return this.vector(text);
  }

  private vector(text: string): Float32Array {
    const automobile = /automobile|car|vehicle/u.test(text);
    return this.automobileAxis === 0
      ? new Float32Array(automobile ? [1, 0] : [0, 1])
      : new Float32Array(automobile ? [0, 1] : [1, 0]);
  }
}

async function indexFor(input: {
  attachmentId: string;
  commit?: string;
  documents: Array<{ path: string; text: string }>;
  provider?: KnowledgeEmbeddingProvider;
}) {
  const commitSha = input.commit ?? "a".repeat(40);
  const chunks = input.documents.flatMap((document) =>
    chunkKnowledgeDocument({
      attachmentId: input.attachmentId,
      commitSha,
      ...document,
    })
  );
  return await buildKnowledgeIndex({
    attachmentId: input.attachmentId,
    commitSha,
    policyFingerprint: "sha256:" + "c".repeat(64),
    chunks,
    embeddingProvider: input.provider,
  });
}

describe("hybrid knowledge retrieval", () => {
  it("retrieves Chinese passages with Unicode lexical BM25", async () => {
    const index = await indexFor({
      attachmentId: "standards",
      documents: [
        { path: "docs/payment.md", text: "支付回调必须验证签名并检查时间戳。" },
        { path: "docs/logging.md", text: "服务必须输出结构化日志。" },
      ],
    });

    const result = await queryKnowledgeIndexes({
      indexes: [index],
      query: "支付回调签名验证",
      topK: 2,
      maxPromptTokens: 300,
    });

    expect(result.mode).toBe("lexical");
    expect(result.matches[0]).toMatchObject({
      attachmentId: "standards",
      path: "docs/payment.md",
    });
    expect(result.matches[0]!.lexicalScore).toBeGreaterThan(0);
    expect(result.matches[0]!.citation).toContain("#L1-L1");
  });

  it("uses semantic provider groups once per query and RRF finds lexical synonyms", async () => {
    const firstProvider = new SemanticFixtureProvider({
      id: "semantic-a",
      model: "a",
      version: "1",
      configurationDigest: "sha256:" + "1".repeat(64),
      dimensions: 2,
      semantic: true,
    }, 0);
    const secondProvider = new SemanticFixtureProvider({
      id: "semantic-b",
      model: "b",
      version: "1",
      configurationDigest: "sha256:" + "2".repeat(64),
      dimensions: 2,
      semantic: true,
    }, 1);
    const [first, second] = await Promise.all([
      indexFor({
        attachmentId: "cars-a",
        provider: firstProvider,
        documents: [
          { path: "manual.md", text: "Automobile maintenance handbook." },
          { path: "other.md", text: "Database backup policy." },
        ],
      }),
      indexFor({
        attachmentId: "cars-b",
        provider: secondProvider,
        documents: [{ path: "vehicle.md", text: "Vehicle repair standards." }],
      }),
    ]);

    const result = await queryKnowledgeIndexes({
      indexes: [first, second],
      query: "car fix",
      embeddingProviders: [firstProvider, secondProvider],
      topK: 3,
      maxPromptTokens: 300,
    });

    expect(firstProvider.queryCalls).toBe(1);
    expect(secondProvider.queryCalls).toBe(1);
    expect(result.mode).toBe("hybrid-semantic");
    expect(result.matches.map((match) => match.path)).toEqual(
      expect.arrayContaining(["manual.md", "vehicle.md"]),
    );
    expect(result.matches.some((match) => match.semanticScore > 0)).toBe(true);
  });

  it("keeps one intact highest-scoring duplicate and filters attachments", async () => {
    const [zeta, alpha] = await Promise.all([
      indexFor({
        attachmentId: "zeta",
        documents: [{ path: "same.md", text: "Shared callback policy." }],
      }),
      indexFor({
        attachmentId: "alpha",
        documents: [
          { path: "same.md", text: "Shared callback policy." },
          { path: "unique.md", text: "Shared callback audit policy." },
        ],
      }),
    ]);

    const all = await queryKnowledgeIndexes({
      indexes: [zeta, alpha],
      query: "shared callback policy",
      topK: 10,
      maxPromptTokens: 500,
    });
    const duplicate = all.matches.filter(
      (match) => match.text === "Shared callback policy.",
    );
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]!.attachmentId).toBe("zeta");
    expect(duplicate[0]!.citation).toContain("kb://zeta/");

    const filtered = await queryKnowledgeIndexes({
      indexes: [zeta, alpha],
      query: "shared callback policy",
      attachmentIds: ["zeta"],
      topK: 10,
      maxPromptTokens: 500,
    });
    expect(filtered.matches.every((match) => match.attachmentId === "zeta")).toBe(true);
  });

  it("uses immutable locator order to break equal duplicate scores", async () => {
    const [zeta, alpha] = await Promise.all([
      indexFor({
        attachmentId: "zeta",
        documents: [{ path: "same.md", text: "Equal callback policy." }],
      }),
      indexFor({
        attachmentId: "alpha",
        documents: [{ path: "same.md", text: "Equal callback policy." }],
      }),
    ]);

    const result = await queryKnowledgeIndexes({
      indexes: [zeta, alpha],
      query: "equal callback policy",
      topK: 10,
      maxPromptTokens: 500,
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.attachmentId).toBe("alpha");
    expect(result.matches[0]!.citation).toContain("kb://alpha/");
  });

  it("packs top-k passages into a token budget and derives safe citations", async () => {
    const index = await indexFor({
      attachmentId: "standards",
      documents: [
        { path: "docs/api rules.md", text: "callback ".repeat(100) },
        { path: "docs/short.md", text: "callback policy" },
      ],
    });

    const result = await queryKnowledgeIndexes({
      indexes: [index],
      query: "callback",
      topK: 5,
      maxPromptTokens: 180,
    });

    expect(result.approxTokens).toBeLessThanOrEqual(180);
    expect(result.truncatedCount).toBeGreaterThan(0);
    expect(result.matches.every((match) => match.citation === knowledgeCitation(match))).toBe(true);
    expect(result.matches.some((match) => match.citation.includes("api%20rules.md"))).toBe(true);
  });

  it("budgets the final escaped prompt representation", async () => {
    const index = await indexFor({
      attachmentId: "escaped",
      documents: [{
        path: "docs/entities.md",
        text: `callback policy ${"&".repeat(2_000)}`,
      }],
    });

    const result = await queryKnowledgeIndexes({
      indexes: [index],
      query: "callback policy",
      topK: 1,
      maxPromptTokens: 240,
    });
    const rendered = renderExternalKnowledgePrompt(result.matches).join("\n");

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.truncated).toBe(true);
    expect(rendered).toContain("&amp;");
    expect(estimateKnowledgeTokens(rendered)).toBeLessThanOrEqual(240);
  });

  it("preserves case and line structure while applying prompt budgets", async () => {
    const source = "POST /v1/Foo\n  YAMLKey: MixedCase";
    const index = await indexFor({
      attachmentId: "case-sensitive",
      documents: [{ path: "docs/api.md", text: source }],
    });
    const result = await queryKnowledgeIndexes({
      indexes: [index],
      query: "foo yamlkey",
      topK: 1,
      maxPromptTokens: 300,
    });

    expect(result.matches[0]?.text).toBe(source);
  });

  it("reports local feature hashing as lexical-only rather than semantic", async () => {
    const provider = new LocalHashEmbeddingProvider({ dimensions: 32 });
    const index = await indexFor({
      attachmentId: "fallback",
      provider,
      documents: [{ path: "policy.md", text: "Callback signing policy." }],
    });

    const result = await queryKnowledgeIndexes({
      indexes: [index],
      query: "callback signing",
      topK: 2,
      maxPromptTokens: 200,
    });

    expect(result.mode).toBe("lexical-hash");
    expect(result.degradedAttachmentIds).toEqual([]);
    expect(result.matches[0]!.semanticScore).toBe(0);
  });
});
