import type {
  Connector,
  FetchedResource,
  ResourceReference,
} from "./types.js";
import { EnvProviderConnectionStore } from "../providers/env-store.js";
import type {
  ProviderConnection,
  ProviderConnectionStore,
} from "../providers/types.js";

const driveApiBase = "https://www.googleapis.com/drive/v3/files";
const googleAppsMimePrefix = "application/vnd.google-apps.";

type DriveMetadata = {
  id?: unknown;
  name?: unknown;
  mimeType?: unknown;
  version?: unknown;
  modifiedTime?: unknown;
  exportLinks?: unknown;
};

export interface GoogleDriveConnectorOptions {
  env?: Record<string, string | undefined>;
  connection?: ProviderConnection;
  store?: ProviderConnectionStore;
}

function safeReference(value: string): string {
  return value.replaceAll("\r", " ").replaceAll("\n", " ").replaceAll("\t", " ").slice(0, 160);
}

function validateFileId(fileId: string, originalUri: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(fileId)) {
    throw new Error(`invalid google-drive resource uri: ${safeReference(originalUri)}`);
  }
  return fileId;
}

function segmentAfter(parts: string[], marker: string): string | undefined {
  const index = parts.indexOf(marker);
  if (index < 0) {
    return undefined;
  }
  return parts[index + 1];
}

function parseFileId(uri: string): string {
  const trimmed = uri.trim();
  if (!trimmed) {
    throw new Error(`invalid google-drive resource uri: ${safeReference(uri)}`);
  }

  if (!trimmed.includes("://")) {
    return validateFileId(trimmed, uri);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`invalid google-drive resource uri: ${safeReference(uri)}`);
  }

  const parts = url.pathname.split("/").filter(Boolean);
  let fileId: string | undefined;
  if (url.hostname === "docs.google.com") {
    fileId = segmentAfter(parts, "d");
  } else if (url.hostname === "drive.google.com") {
    fileId = segmentAfter(parts, "d") ?? url.searchParams.get("id") ?? undefined;
  }

  if (!fileId) {
    throw new Error(`invalid google-drive resource uri: ${safeReference(uri)}`);
  }
  return validateFileId(fileId, uri);
}

function metadataUrl(fileId: string): URL {
  const url = new URL(`${driveApiBase}/${encodeURIComponent(fileId)}`);
  url.searchParams.set("fields", "id,name,mimeType,version,modifiedTime,exportLinks");
  url.searchParams.set("supportsAllDrives", "true");
  return url;
}

function exportUrl(fileId: string, exportMimeType: string): URL {
  const url = new URL(`${driveApiBase}/${encodeURIComponent(fileId)}/export`);
  url.searchParams.set("mimeType", exportMimeType);
  return url;
}

function mediaUrl(fileId: string): URL {
  const url = new URL(`${driveApiBase}/${encodeURIComponent(fileId)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  return url;
}

function responseMediaType(response: Response, fallback: string): string {
  return response.headers.get("content-type")?.split(";")[0]?.trim() || fallback;
}

async function safeResponseContext(response: Response, token: string): Promise<string> {
  const text = await response.text();
  const redacted = text
    .replaceAll(token, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replaceAll("\t", " ")
    .slice(0, 200)
    .trim();
  return redacted ? `: ${redacted}` : "";
}

async function assertOk(
  response: Response,
  token: string,
  context: string,
  fileId: string,
): Promise<void> {
  if (response.ok) {
    return;
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`google-drive authentication failed with status ${response.status}`);
  }
  if (response.status === 404) {
    throw new Error(`google-drive resource not found: ${fileId}`);
  }
  throw new Error(
    `${context} failed with status ${response.status} for ${fileId}${await safeResponseContext(response, token)}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exportLinks(metadata: DriveMetadata): Record<string, unknown> | undefined {
  return isRecord(metadata.exportLinks) ? metadata.exportLinks : undefined;
}

function driveMimeType(metadata: DriveMetadata): string {
  return typeof metadata.mimeType === "string" ? metadata.mimeType : "application/octet-stream";
}

function defaultExportMimeType(metadata: DriveMetadata): string | undefined {
  const mimeType = driveMimeType(metadata);
  if (mimeType === "application/vnd.google-apps.document") {
    return exportLinks(metadata)?.["text/markdown"] ? "text/markdown" : "text/plain";
  }
  if (mimeType === "application/vnd.google-apps.spreadsheet") {
    return "text/csv";
  }
  if (mimeType === "application/vnd.google-apps.presentation") {
    return "text/plain";
  }
  return undefined;
}

function requestedExportMimeType(reference: ResourceReference): string | undefined {
  const value = reference.options?.exportMimeType;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function selectExportMimeType(metadata: DriveMetadata, reference: ResourceReference, fileId: string): string {
  const selected = requestedExportMimeType(reference) ?? defaultExportMimeType(metadata);
  if (!selected) {
    throw new Error(`unsupported google-drive export type for ${fileId}`);
  }
  const links = exportLinks(metadata);
  if (links && !(selected in links)) {
    throw new Error(`unsupported google-drive export type ${selected} for ${fileId}`);
  }
  return selected;
}

function revision(metadata: DriveMetadata): string | undefined {
  if (typeof metadata.version === "string" || typeof metadata.version === "number") {
    return String(metadata.version);
  }
  return typeof metadata.modifiedTime === "string" ? metadata.modifiedTime : undefined;
}

function metadataFor(
  fileId: string,
  metadata: DriveMetadata,
  exportMimeType?: string,
): Record<string, string> {
  const result: Record<string, string> = {
    id: typeof metadata.id === "string" ? metadata.id : fileId,
    driveMimeType: driveMimeType(metadata),
  };
  if (typeof metadata.name === "string") {
    result.name = metadata.name;
  }
  if (exportMimeType) {
    result.exportMimeType = exportMimeType;
  }
  return result;
}

export class GoogleDriveConnector implements Connector {
  readonly type = "google-drive";
  readonly #connection: ProviderConnection | undefined;
  readonly #store: ProviderConnectionStore;

  constructor(options: GoogleDriveConnectorOptions = {}) {
    this.#connection = options.connection;
    this.#store =
      options.store ??
      new EnvProviderConnectionStore({ env: options.env ?? process.env });
  }

  async #getAccessToken(): Promise<string> {
    return await (
      this.#connection ?? (await this.#store.getConnection("google-drive"))
    ).getAccessToken();
  }

  async fetch(reference: ResourceReference): Promise<FetchedResource> {
    const fileId = parseFileId(reference.uri);
    const token = await this.#getAccessToken();
    const headers = { authorization: `Bearer ${token}` };

    const metadataResponse = await fetch(metadataUrl(fileId), { headers });
    await assertOk(metadataResponse, token, "google-drive metadata fetch", fileId);
    const metadata = (await metadataResponse.json()) as DriveMetadata;
    const mimeType = driveMimeType(metadata);

    if (mimeType.startsWith(googleAppsMimePrefix)) {
      const exportMimeType = selectExportMimeType(metadata, reference, fileId);
      const exportResponse = await fetch(exportUrl(fileId, exportMimeType), { headers });
      await assertOk(
        exportResponse,
        token,
        `google-drive export ${exportMimeType}`,
        fileId,
      );
      return {
        sourceUri: reference.uri,
        mediaType: responseMediaType(exportResponse, exportMimeType),
        content: Buffer.from(await exportResponse.arrayBuffer()),
        revision: revision(metadata),
        metadata: metadataFor(fileId, metadata, exportMimeType),
      };
    }

    const mediaResponse = await fetch(mediaUrl(fileId), { headers });
    await assertOk(mediaResponse, token, "google-drive media download", fileId);
    return {
      sourceUri: reference.uri,
      mediaType: responseMediaType(mediaResponse, mimeType),
      content: Buffer.from(await mediaResponse.arrayBuffer()),
      revision: revision(metadata),
      metadata: metadataFor(fileId, metadata),
    };
  }
}
