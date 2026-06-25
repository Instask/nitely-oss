import { beforeEach, describe, expect, it, vi } from "vitest";

import { GoogleDriveConnector } from "../../src/connectors/google-drive.js";
import type { ProviderConnection } from "../../src/providers/types.js";

const token = "test-access-token";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...init.headers },
    status: init.status ?? 200,
    statusText: init.statusText,
  });
}

function textResponse(body: string, init: ResponseInit = {}) {
  return new Response(body, {
    headers: { "content-type": "text/plain", ...init.headers },
    status: init.status ?? 200,
    statusText: init.statusText,
  });
}

function createFetchMock() {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestUrl(fetchMock: ReturnType<typeof createFetchMock>, index: number) {
  const [input] = fetchMock.mock.calls[index] ?? [];
  if (typeof input === "string") {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  throw new Error("unexpected fetch input");
}

describe("GoogleDriveConnector", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubEnv("NITELY_GOOGLE_ACCESS_TOKEN", token);
  });

  it("uses the google-drive connector type", () => {
    expect(new GoogleDriveConnector().type).toBe("google-drive");
  });

  it("parses a Google Docs URL and exports markdown when supported", async () => {
    const fetchMock = createFetchMock();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          id: "doc123",
          name: "Product Spec",
          mimeType: "application/vnd.google-apps.document",
          version: "12",
          modifiedTime: "2026-06-19T01:02:03.000Z",
          exportLinks: {
            "text/markdown": "https://example.test/export-markdown",
            "text/plain": "https://example.test/export-text",
          },
        }),
      )
      .mockResolvedValueOnce(
        textResponse("# Product Spec\n", {
          headers: { "content-type": "text/markdown; charset=UTF-8" },
        }),
      );

    const result = await new GoogleDriveConnector().fetch({
      connector: "google-drive",
      uri: "https://docs.google.com/document/d/doc123/edit",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestUrl(fetchMock, 0).pathname).toBe("/drive/v3/files/doc123");
    expect(requestUrl(fetchMock, 1).pathname).toBe("/drive/v3/files/doc123/export");
    expect(requestUrl(fetchMock, 1).searchParams.get("mimeType")).toBe("text/markdown");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      authorization: `Bearer ${token}`,
    });
    expect(result.sourceUri).toBe("https://docs.google.com/document/d/doc123/edit");
    expect(result.mediaType).toBe("text/markdown");
    expect(result.content).toEqual(Buffer.from("# Product Spec\n"));
    expect(result.revision).toBe("12");
    expect(result.metadata).toEqual({
      id: "doc123",
      name: "Product Spec",
      driveMimeType: "application/vnd.google-apps.document",
      exportMimeType: "text/markdown",
    });
  });

  it("uses an injected provider connection token for metadata and media requests", async () => {
    vi.stubEnv("NITELY_GOOGLE_ACCESS_TOKEN", "");
    const fetchMock = createFetchMock();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          id: "file123",
          name: "notes.txt",
          mimeType: "text/plain",
        }),
      )
      .mockResolvedValueOnce(textResponse("notes\n"));
    const connection: ProviderConnection = {
      providerId: "google-drive",
      getAccessToken: async () => "injected-drive-token",
    };

    await new GoogleDriveConnector({ connection }).fetch({
      connector: "google-drive",
      uri: "file123",
    });

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      authorization: "Bearer injected-drive-token",
    });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({
      authorization: "Bearer injected-drive-token",
    });
  });

  it("uses text/plain for Google Docs when markdown export is unsupported", async () => {
    const fetchMock = createFetchMock();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          id: "doc123",
          name: "Product Spec",
          mimeType: "application/vnd.google-apps.document",
          exportLinks: { "text/plain": "https://example.test/export-text" },
        }),
      )
      .mockResolvedValueOnce(textResponse("Product Spec\n"));

    await new GoogleDriveConnector().fetch({
      connector: "google-drive",
      uri: "https://docs.google.com/document/d/doc123/edit",
    });

    expect(requestUrl(fetchMock, 1).searchParams.get("mimeType")).toBe("text/plain");
  });

  it("applies an explicit export MIME type", async () => {
    const fetchMock = createFetchMock();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          id: "sheet123",
          name: "Revenue",
          mimeType: "application/vnd.google-apps.spreadsheet",
          version: "22",
          exportLinks: { "text/csv": "https://example.test/export-csv" },
        }),
      )
      .mockResolvedValueOnce(textResponse("month,revenue\nJune,42\n"));

    const result = await new GoogleDriveConnector().fetch({
      connector: "google-drive",
      uri: "https://docs.google.com/spreadsheets/d/sheet123/edit",
      options: { exportMimeType: "text/csv" },
    });

    expect(requestUrl(fetchMock, 1).searchParams.get("mimeType")).toBe("text/csv");
    expect(result.metadata?.exportMimeType).toBe("text/csv");
  });

  it("parses Drive file URLs and downloads binary content through media", async () => {
    const fetchMock = createFetchMock();
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          id: "file123",
          name: "brief.pdf",
          mimeType: "application/pdf",
          modifiedTime: "2026-06-19T01:02:03.000Z",
        }),
      )
      .mockResolvedValueOnce(
        new Response(bytes, { headers: { "content-type": "application/pdf" } }),
      );

    const result = await new GoogleDriveConnector().fetch({
      connector: "google-drive",
      uri: "https://drive.google.com/file/d/file123/view",
    });

    expect(requestUrl(fetchMock, 1).pathname).toBe("/drive/v3/files/file123");
    expect(requestUrl(fetchMock, 1).searchParams.get("alt")).toBe("media");
    expect(result.mediaType).toBe("application/pdf");
    expect(result.content).toEqual(Buffer.from(bytes));
    expect(result.revision).toBe("2026-06-19T01:02:03.000Z");
    expect(result.metadata).toEqual({
      id: "file123",
      name: "brief.pdf",
      driveMimeType: "application/pdf",
    });
  });

  it("parses raw file IDs", async () => {
    const fetchMock = createFetchMock();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "raw_file-123", name: "notes.txt", mimeType: "text/plain" }))
      .mockResolvedValueOnce(textResponse("notes\n"));

    await new GoogleDriveConnector().fetch({ connector: "google-drive", uri: "raw_file-123" });

    expect(requestUrl(fetchMock, 0).pathname).toBe("/drive/v3/files/raw_file-123");
  });

  it("fails before network access when the access token is missing", async () => {
    vi.stubEnv("NITELY_GOOGLE_ACCESS_TOKEN", "");
    const fetchMock = createFetchMock();

    await expect(
      new GoogleDriveConnector().fetch({ connector: "google-drive", uri: "raw_file-123" }),
    ).rejects.toThrow(/missing NITELY_GOOGLE_ACCESS_TOKEN for google-drive connector/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed resource references", async () => {
    await expect(
      new GoogleDriveConnector().fetch({ connector: "google-drive", uri: "bad/id" }),
    ).rejects.toThrow(new RegExp("invalid google-drive resource uri: bad/id"));
  });

  it("reports authentication failures without exposing tokens", async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(textResponse("Authorization: Bearer secret-token", { status: 403 }));

    let message = "";
    try {
      await new GoogleDriveConnector().fetch({ connector: "google-drive", uri: "raw_file-123" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/google-drive authentication failed with status 403/);
    expect(message).not.toContain(token);
    expect(message).not.toContain("secret-token");
  });

  it("reports missing files with the file ID", async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(textResponse("missing", { status: 404 }));

    await expect(
      new GoogleDriveConnector().fetch({ connector: "google-drive", uri: "missing123" }),
    ).rejects.toThrow(/google-drive resource not found: missing123/);
  });

  it("reports unsupported export types", async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "draw123", name: "Drawing", mimeType: "application/vnd.google-apps.drawing" }),
    );

    await expect(
      new GoogleDriveConnector().fetch({ connector: "google-drive", uri: "draw123" }),
    ).rejects.toThrow(/unsupported google-drive export type/);
  });

  it("includes safe response context for non-2xx API responses", async () => {
    const fetchMock = createFetchMock();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "file123", name: "brief.pdf", mimeType: "application/pdf" }))
      .mockResolvedValueOnce(
        textResponse("backend unavailable while serving file", {
          status: 503,
          statusText: "Service Unavailable",
        }),
      );

    await expect(
      new GoogleDriveConnector().fetch({ connector: "google-drive", uri: "file123" }),
    ).rejects.toThrow(/google-drive media download failed with status 503 for file123: backend unavailable/);
  });
});
