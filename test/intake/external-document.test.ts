import { describe, expect, it } from "vitest";

import {
  ExternalDocumentInputError,
  MAX_EXTERNAL_DOCUMENT_BODY_LENGTH,
  normalizeExternalDocument,
  normalizeExternalDocumentUrl,
} from "../../src/intake/external-document.js";

describe("external document intake", () => {
  it("normalizes a provider document into provider-neutral source provenance", () => {
    const document = normalizeExternalDocument({
      url: "https://example.feishu.cn/docx/ABC123 ",
      title: "  Nightly release policy  ",
      body: "The release train must publish a draft PR before merge.",
      version: "rev-42",
      author: "ops@example.com",
      updatedAt: "2026-09-18T04:00:00.000Z",
    });

    expect(document).toEqual({
      sourceType: "external-document",
      externalId: "example.feishu.cn/docx/ABC123",
      title: "Nightly release policy",
      body: "The release train must publish a draft PR before merge.",
      url: "https://example.feishu.cn/docx/ABC123",
      version: "rev-42",
      author: "ops@example.com",
      updatedAt: "2026-09-18T04:00:00.000Z",
    });
  });

  it("derives a title and external id when the provider supplies neither", () => {
    const document = normalizeExternalDocument({
      url: "https://docs.example.com/specs/import/",
      body: "# Repository import\n\nOperators paste a repository URL.",
    });

    expect(document.title).toBe("Repository import");
    expect(document.externalId).toBe("docs.example.com/specs/import");
  });

  it("keeps caller-supplied external ids so a connector can own document identity", () => {
    const document = normalizeExternalDocument({
      url: "https://docs.example.com/a?pageId=771",
      body: "Body",
      externalId: "confluence:771",
    });

    expect(document.externalId).toBe("confluence:771");
    expect(document.url).toBe("https://docs.example.com/a?pageId=771");
  });

  it("rejects urls Nitely must not store as provenance", () => {
    expect(() => normalizeExternalDocumentUrl("")).toThrow(
      ExternalDocumentInputError,
    );
    expect(() => normalizeExternalDocumentUrl("not-a-url")).toThrow(
      "external document url must be an absolute http or https URL",
    );
    expect(() =>
      normalizeExternalDocumentUrl("file:///etc/passwd"),
    ).toThrow("external document url must be an absolute http or https URL");
    expect(() =>
      normalizeExternalDocumentUrl("https://user:secret@docs.example.com/a"),
    ).toThrow("external document url must not embed credentials");
  });

  it("drops secret-bearing query parameters and fragments from stored urls", () => {
    expect(
      normalizeExternalDocumentUrl(
        "https://docs.example.com/a?pageId=7&access_token=abc123&api_key=zzz#section-3",
      ),
    ).toBe("https://docs.example.com/a?pageId=7");
  });

  it("requires a snapshot body so the baseline can be reviewed and hashed", () => {
    expect(() =>
      normalizeExternalDocument({ url: "https://docs.example.com/a", body: "   " }),
    ).toThrow(
      "external document body is required so the snapshot can be reviewed and hashed",
    );
    expect(() =>
      normalizeExternalDocument({
        url: "https://docs.example.com/a",
        body: "x".repeat(MAX_EXTERNAL_DOCUMENT_BODY_LENGTH + 1),
      }),
    ).toThrow(
      `external document body must be at most ${MAX_EXTERNAL_DOCUMENT_BODY_LENGTH} characters`,
    );
  });
});
