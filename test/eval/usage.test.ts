import { describe, expect, it } from "vitest";

import {
  normalizeProviderUsage,
  normalizeRuntimeUsageForPersistence,
} from "../../src/eval/usage.js";

describe("provider usage normalization", () => {
  it("preserves provider-reported token and actual-cost provenance", () => {
    const usage = normalizeProviderUsage({
      provider: "openai",
      model: "gpt-5.1-codex",
      observedAt: "2026-07-16T00:00:00.000Z",
      source: {
        kind: "provider-reported",
        reference: "responses.usage",
      },
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      cost: {
        classification: "actual",
        usd: 0.042,
      },
      raw: { requestId: "resp_123" },
    });

    expect(usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      cost: { classification: "actual", usd: 0.042 },
      provenance: {
        provider: "openai",
        model: "gpt-5.1-codex",
        observedAt: "2026-07-16T00:00:00.000Z",
        source: {
          kind: "provider-reported",
          reference: "responses.usage",
        },
      },
      raw: { requestId: "resp_123" },
    });
  });

  it("keeps missing usage unknown and permits estimates only with an explicit method", () => {
    expect(normalizeProviderUsage(undefined)).toBeUndefined();

    expect(normalizeProviderUsage({
      provider: "anthropic",
      observedAt: "2026-07-16T00:00:00.000Z",
      source: { kind: "calculated", reference: "team-price-card-v4" },
      totalTokens: 100,
      cost: {
        classification: "estimated",
        usd: 0.01,
        method: "pinned team price card v4",
      },
    })?.cost).toEqual({
      classification: "estimated",
      usd: 0.01,
      method: "pinned team price card v4",
    });

    expect(() => normalizeProviderUsage({
      provider: "anthropic",
      observedAt: "2026-07-16T00:00:00.000Z",
      source: { kind: "calculated", reference: "guess" },
      cost: { classification: "actual", usd: 0.01 },
    })).toThrow(/actual cost requires provider-reported provenance/);
  });

  it("redacts secret-bearing provider metadata before persistence", () => {
    const secret = "provider-secret-value-123";
    const usage = normalizeProviderUsage({
      provider: "openai-abc",
      observedAt: "2026-07-16T00:00:00.000Z",
      source: { kind: "provider-reported", reference: "responses.usage/abc" },
      totalTokens: 10,
      raw: {
        apiKey: secret,
        password: "abc",
        credential: "opaque-private-value-123",
        nested: {
          authorization: `Bearer ${secret}`,
          note: `request completed with ${secret}`,
          shortPasswordCopy: "abc",
        },
      },
    });

    expect(usage?.raw).toEqual({
      apiKey: "[REDACTED]",
      password: "[REDACTED]",
      credential: "[REDACTED]",
      nested: {
        authorization: "Bearer [REDACTED]",
        note: "request completed with [REDACTED]",
        shortPasswordCopy: "[REDACTED]",
      },
    });
    expect(JSON.stringify(usage)).not.toContain(secret);
    expect(usage?.provenance.provider).toBe("openai-[REDACTED]");
    expect(usage?.provenance.source.reference).toBe(
      "responses.usage/[REDACTED]",
    );
  });

  it("redacts plural credential tokens while preserving raw usage counters", () => {
    const accessToken = "provider-access-token-value-123";
    const refreshToken = "provider-refresh-token-value-456";
    const listedAccessToken = "provider-listed-access-token-value-789";
    const fakeInputCount = "opaque-secret-in-provider-input-count";
    const usage = normalizeProviderUsage({
      provider: "openai",
      observedAt: "2026-07-16T00:00:00.000Z",
      source: { kind: "provider-reported", reference: "responses.usage" },
      raw: {
        accessTokens: [accessToken],
        refresh_tokens: refreshToken,
        accessTokensList: listedAccessToken,
        inputTokens: 12,
        outputTokens: 3,
        cachedInputTokens: 4,
        invalidUsage: { inputTokens: fakeInputCount },
        note: `copies ${accessToken} ${refreshToken} ${listedAccessToken} ${fakeInputCount}`,
      },
    });

    expect(usage?.raw).toEqual({
      accessTokens: "[REDACTED]",
      refresh_tokens: "[REDACTED]",
      accessTokensList: "[REDACTED]",
      inputTokens: 12,
      outputTokens: 3,
      cachedInputTokens: 4,
      invalidUsage: { inputTokens: "[REDACTED]" },
      note: "copies [REDACTED] [REDACTED] [REDACTED] [REDACTED]",
    });
  });

  it("redacts and bounds every persisted provenance string", () => {
    const secret = "provider-secret-value-789";
    const urlSecret = "basic-auth-secret-789";
    const rawKeySecret = "raw-key-secret-789";
    const usage = normalizeProviderUsage({
      provider: "openai",
      model: `model api_key=${secret}`,
      observedAt: "2026-07-16T00:00:00.000Z",
      source: {
        kind: "calculated",
        reference:
          `https://operator:${urlSecret}@billing.example/usage?token=${secret}`,
      },
      cost: {
        classification: "estimated",
        usd: 0.01,
        method: `price card authorization: Bearer ${secret}`,
      },
      raw: {
        [`Authorization: Bearer ${rawKeySecret}`]: "request metadata",
      },
    });

    expect(JSON.stringify(usage)).not.toContain(secret);
    expect(JSON.stringify(usage)).not.toContain(urlSecret);
    expect(JSON.stringify(usage)).not.toContain(rawKeySecret);
    expect(usage?.provenance.model).toContain("[REDACTED]");
    expect(usage?.provenance.source.reference).toContain("[REDACTED]");
    expect(usage?.cost).toMatchObject({
      classification: "estimated",
      method: expect.stringContaining("[REDACTED]"),
    });
    expect(Object.keys(usage?.raw as Record<string, unknown>)).toEqual([
      expect.stringContaining("[REDACTED]"),
    ]);

    expect(() => normalizeProviderUsage({
      provider: "p".repeat(129),
      observedAt: "2026-07-16T00:00:00.000Z",
      source: { kind: "provider-reported", reference: "responses.usage" },
    })).toThrow(/provider exceeds 128 characters/);
    expect(() => normalizeProviderUsage({
      provider: "openai",
      observedAt: "2026",
      source: { kind: "provider-reported", reference: "responses.usage" },
    })).toThrow(/canonical ISO timestamp/);
  });

  it("rejects malformed counts, inconsistent totals, and invalid cost provenance", () => {
    const base = {
      provider: "openai",
      observedAt: "2026-07-16T00:00:00.000Z",
      source: { kind: "provider-reported" as const, reference: "responses.usage" },
    };
    const invalid = [
      { ...base, inputTokens: -1 },
      { ...base, outputTokens: 1.5 },
      { ...base, totalTokens: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
      { ...base, inputTokens: 2, outputTokens: 3, totalTokens: 6 },
      { ...base, cost: { classification: "actual" as const, usd: -0.01 } },
      {
        ...base,
        source: { kind: "calculated" as const, reference: "price-card" },
        cost: { classification: "estimated" as const, usd: 0.01, method: "" },
      },
      { ...base, provider: "" },
      { ...base, observedAt: "yesterday" },
      { ...base, source: { kind: "provider-reported" as const, reference: "" } },
    ];

    for (const observation of invalid) {
      expect(() => normalizeProviderUsage(observation)).toThrow();
    }

    expect(() => normalizeProviderUsage({
      ...base,
      source: { kind: "forged", reference: "untrusted" },
      cost: { classification: "unknown" },
    } as any)).toThrow();
    expect(() => normalizeProviderUsage({
      ...base,
      cost: { classification: "unknown", usd: 99 },
    } as any)).toThrow();
  });

  it("bounds cyclic and oversized raw provider metadata before redaction", () => {
    const secret = "provider-secret-value-456";
    const cyclic: Record<string, unknown> = {
      ["oversized-key".repeat(20_000)]: "value",
      apiKey: secret,
    };
    cyclic.self = cyclic;
    cyclic.items = Array.from({ length: 2_000 }, (_, index) => ({
      index,
      message: "x".repeat(2_000),
    }));

    const usage = normalizeProviderUsage({
      provider: "openai",
      observedAt: "2026-07-16T00:00:00.000Z",
      source: { kind: "provider-reported", reference: "responses.usage" },
      raw: cyclic,
    });
    const serialized = JSON.stringify(usage?.raw);

    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[CIRCULAR]");
    expect(serialized).toContain("[TRUNCATED]");
    expect(serialized.length).toBeLessThan(100_000);

    const lateSecret = "late-provider-secret-value-987";
    const insertionOrderUsage = normalizeProviderUsage({
      provider: "openai",
      observedAt: "2026-07-16T00:00:00.000Z",
      source: { kind: "provider-reported", reference: "responses.usage" },
      raw: {
        note: `request completed with ${lateSecret}`,
        filler: "x".repeat(32_768),
        apiKey: lateSecret,
      },
    });
    expect(JSON.stringify(insertionOrderUsage?.raw)).not.toContain(lateSecret);
  });

  it("scans sensitive raw fields beyond the persisted collection limit", () => {
    const secret = "field-129-provider-secret-value-123";
    const raw: Record<string, unknown> = {
      note: `request copied ${secret}`,
    };
    for (let index = 0; index < 127; index += 1) {
      raw[`field-${index}`] = index;
    }
    raw.apiKey = secret;

    const usage = normalizeProviderUsage({
      provider: "openai",
      observedAt: "2026-07-16T00:00:00.000Z",
      source: { kind: "provider-reported", reference: "responses.usage" },
      raw,
    });

    expect(Object.keys(raw).indexOf("apiKey")).toBe(128);
    expect(JSON.stringify(usage?.raw)).not.toContain(secret);
    expect(usage?.raw).toMatchObject({
      note: "request copied [REDACTED]",
      __truncated__: "[TRUNCATED]",
    });
  });

  it("redacts passphrase and private-key raw values wherever they are copied", () => {
    const passphrase = "provider-passphrase-value-123";
    const privateKey = "provider-private-key-value-456";
    const usage = normalizeProviderUsage({
      provider: "openai",
      observedAt: "2026-07-16T00:00:00.000Z",
      source: { kind: "provider-reported", reference: "responses.usage" },
      raw: {
        passphrase,
        private_key: privateKey,
        note: `copies: ${passphrase} / ${privateKey}`,
      },
    });

    expect(usage?.raw).toEqual({
      passphrase: "[REDACTED]",
      private_key: "[REDACTED]",
      note: "copies: [REDACTED] / [REDACTED]",
    });
  });

  it("sanitizes the runtime event boundary and drops unproven legacy cost", () => {
    const secret = "runtime-private-credential-123";
    expect(normalizeRuntimeUsageForPersistence({
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: 10,
      estimatedCostUsd: 99,
      raw: {
        credential: secret,
        note: `echo ${secret}`,
      },
    })).toEqual({
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: 10,
      cost: { classification: "unknown" },
      raw: {
        credential: "[REDACTED]",
        note: "echo [REDACTED]",
      },
    });

    expect(() => normalizeRuntimeUsageForPersistence({
      totalTokens: -1,
    })).toThrow(/totalTokens must be a non-negative integer/);
    expect(() => normalizeRuntimeUsageForPersistence({
      totalTokens: 10,
      cost: { classification: "actual", usd: 1 },
    })).toThrow(/cost provenance is required/);
  });
});
