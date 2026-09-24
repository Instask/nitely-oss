import { describe, expect, it, vi } from "vitest";

import {
  LocalHashEmbeddingProvider,
  OllamaEmbeddingProvider,
  OpenAICompatibleEmbeddingProvider,
} from "../../src/knowledge-repositories/embeddings.js";

describe("knowledge embedding providers", () => {
  it("marks local hash vectors as deterministic but non-semantic", async () => {
    const provider = new LocalHashEmbeddingProvider({ dimensions: 32 });
    const [first, second] = await provider.embedDocuments([
      "支付回调签名",
      "支付回调签名",
    ]);

    expect(provider.identity).toMatchObject({
      id: "local-hash",
      semantic: false,
      dimensions: 32,
    });
    expect(first).toEqual(second);
    expect(first).toHaveLength(32);
    expect(Math.hypot(...first!)).toBeCloseTo(1, 6);
  });

  it("uses a bounded loopback-only Ollama embedding endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "nomic-embed-text",
        input: ["one", "two"],
      });
      return new Response(
        JSON.stringify({ embeddings: [[3, 4], [0, 2]] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const provider = new OllamaEmbeddingProvider({
      baseUrl: "http://127.0.0.1:11434",
      model: "nomic-embed-text",
      fetch: fetchMock,
    });

    const vectors = await provider.embedDocuments(["one", "two"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/embed",
      expect.objectContaining({ method: "POST" }),
    );
    expect(vectors[0]).toEqual(new Float32Array([0.6, 0.8]));
    expect(vectors[1]).toEqual(new Float32Array([0, 1]));
    expect(provider.identity.semantic).toBe(true);
  });

  it("rejects non-loopback Ollama URLs and malformed vectors", async () => {
    expect(
      () => new OllamaEmbeddingProvider({
        baseUrl: "https://embedding.example.com",
        model: "model",
      }),
    ).toThrow(/loopback/);

    const provider = new OllamaEmbeddingProvider({
      baseUrl: "http://localhost:11434",
      model: "model",
      fetch: async () => new Response(
        JSON.stringify({ embeddings: [[1, Number.NaN]] }),
        { status: 200 },
      ),
    });
    await expect(provider.embedQuery("query")).rejects.toThrow(/finite/);
  });

  it("pins vector-space configuration without including credentials", () => {
    const firstOllama = new OllamaEmbeddingProvider({
      baseUrl: "http://127.0.0.1:11434",
      model: "embed-v1",
    });
    const secondOllama = new OllamaEmbeddingProvider({
      baseUrl: "http://localhost:11434",
      model: "embed-v1",
    });
    expect(firstOllama.identity.configurationDigest).not.toBe(
      secondOllama.identity.configurationDigest,
    );

    const firstOpenAi = new OpenAICompatibleEmbeddingProvider({
      model: "embed-v1",
      env: {
        NITELY_EMBEDDINGS_BASE_URL: "https://embeddings.internal.example/v1",
        NITELY_EMBEDDINGS_ALLOWED_HOSTS: "embeddings.internal.example",
        NITELY_EMBEDDINGS_API_KEY: "first-runtime-secret",
      },
    });
    const secondOpenAi = new OpenAICompatibleEmbeddingProvider({
      model: "embed-v1",
      env: {
        NITELY_EMBEDDINGS_BASE_URL: "https://embeddings.internal.example/v1",
        NITELY_EMBEDDINGS_ALLOWED_HOSTS: "embeddings.internal.example",
        NITELY_EMBEDDINGS_API_KEY: "second-runtime-secret",
      },
    });
    expect(firstOpenAi.identity.configurationDigest).toBe(
      secondOpenAi.identity.configurationDigest,
    );
    expect(JSON.stringify(firstOpenAi.identity)).not.toContain(
      "first-runtime-secret",
    );
  });

  it("reads OpenAI-compatible URL only from env and enforces HTTPS allowlisting", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      expect((init?.headers as Record<string, string>).authorization).toBe(
        "Bearer runtime-only-secret",
      );
      return new Response(JSON.stringify({
        data: [
          { index: 1, embedding: [0, 5] },
          { index: 0, embedding: [2, 0] },
        ],
      }), { status: 200 });
    });
    const provider = new OpenAICompatibleEmbeddingProvider({
      model: "embed-v1",
      env: {
        NITELY_EMBEDDINGS_BASE_URL: "https://embeddings.internal.example/v1",
        NITELY_EMBEDDINGS_ALLOWED_HOSTS: "embeddings.internal.example",
        NITELY_EMBEDDINGS_API_KEY: "runtime-only-secret",
      },
      fetch: fetchMock,
    });

    const vectors = await provider.embedDocuments(["first", "second"]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://embeddings.internal.example/v1/embeddings",
    );
    expect(vectors[0]).toEqual(new Float32Array([1, 0]));
    expect(vectors[1]).toEqual(new Float32Array([0, 1]));
    expect(JSON.stringify(provider.identity)).not.toContain("runtime-only-secret");

    expect(() => new OpenAICompatibleEmbeddingProvider({
      model: "embed-v1",
      env: {
        NITELY_EMBEDDINGS_BASE_URL: "http://embeddings.internal.example/v1",
        NITELY_EMBEDDINGS_ALLOWED_HOSTS: "embeddings.internal.example",
      },
    })).toThrow(/HTTPS/);
    expect(() => new OpenAICompatibleEmbeddingProvider({
      model: "embed-v1",
      env: {
        NITELY_EMBEDDINGS_BASE_URL: "https://evil.example/v1",
        NITELY_EMBEDDINGS_ALLOWED_HOSTS: "embeddings.internal.example",
      },
    })).toThrow(/allowlist/);
  });
});
