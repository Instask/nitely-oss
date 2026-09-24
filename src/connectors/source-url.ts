import { basename } from "node:path";

import type {
  Connector,
  FetchedResource,
  ResourceReference,
} from "./types.js";

function filenameFromUrl(url: URL): string {
  const filename = basename(url.pathname);
  return filename || "source";
}

function revisionFromHeaders(headers: Headers): string | undefined {
  const etag = headers.get("etag");
  if (etag) return `etag:${etag}`;
  const lastModified = headers.get("last-modified");
  if (lastModified) return `last-modified:${lastModified}`;
  return undefined;
}

export class SourceUrlConnector implements Connector {
  readonly type = "source-url";

  async fetch(reference: ResourceReference): Promise<FetchedResource> {
    let url: URL;
    try {
      url = new URL(reference.uri);
    } catch (error) {
      throw new Error(`invalid source URL: ${reference.uri}`, { cause: error });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`unsupported source URL protocol: ${url.protocol}`);
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `unable to fetch source URL ${reference.uri}: ${response.status} ${response.statusText}`.trim(),
      );
    }

    const mediaType =
      response.headers.get("content-type")?.split(";")[0]?.trim() ||
      "application/octet-stream";
    return {
      sourceUri: reference.uri,
      mediaType,
      content: Buffer.from(await response.arrayBuffer()),
      revision: revisionFromHeaders(response.headers),
      metadata: {
        filename: filenameFromUrl(url),
      },
    };
  }
}
