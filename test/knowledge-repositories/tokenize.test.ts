import { describe, expect, it } from "vitest";

import {
  estimateKnowledgeTokens,
  normalizeKnowledgeText,
  tokenizeKnowledgeText,
  truncateKnowledgeText,
} from "../../src/knowledge-repositories/tokenize.js";

describe("knowledge tokenizer", () => {
  it("normalizes Unicode with NFKC and retains non-ASCII words", () => {
    expect(normalizeKnowledgeText("  ＡＰＩ  Café\r\nPAYMENTS  ")).toBe(
      "api café payments",
    );
    expect(tokenizeKnowledgeText("ＡＰＩ Café payments")).toEqual([
      "api",
      "café",
      "payments",
    ]);
  });

  it("adds deterministic CJK unigrams, bigrams, and trigrams", () => {
    const tokens = tokenizeKnowledgeText("支付回调签名验证");

    expect(tokens).toEqual(
      expect.arrayContaining([
        "支付回调签名验证",
        "支",
        "支付",
        "支付回",
        "回调",
        "签名",
        "验证",
      ]),
    );
    expect(tokens).toEqual(tokenizeKnowledgeText("支付回调签名验证"));
  });

  it("estimates and truncates by Unicode code point without breaking text", () => {
    const text = "支付回调签名验证 and a long English suffix";
    const truncated = truncateKnowledgeText(text, 6);

    expect(estimateKnowledgeTokens(truncated.text)).toBeLessThanOrEqual(6);
    expect(truncated.truncated).toBe(true);
    expect(truncated.text).not.toContain("�");
  });
});
