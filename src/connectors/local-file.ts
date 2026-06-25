import { readFile, realpath, stat } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Connector,
  FetchedResource,
  ResourceReference,
} from "./types.js";

const mediaTypes: Record<string, string> = {
  ".json": "application/json",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
};

function isWithin(base: string, candidate: string): boolean {
  const path = relative(base, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export interface ResolvedLocalFileResource {
  absolutePath: string;
  repoRelativePath: string;
  filename: string;
  mediaType: string;
  revision: string;
}

export async function resolveLocalFileResource(
  baseDirectory: string,
  reference: ResourceReference,
): Promise<ResolvedLocalFileResource> {
  const resolvedBaseDirectory = resolve(baseDirectory);
  const candidate = reference.uri.startsWith("file:")
    ? fileURLToPath(reference.uri)
    : resolve(resolvedBaseDirectory, reference.uri);

  if (!isWithin(resolvedBaseDirectory, candidate)) {
    throw new Error(
      `resource is outside local-file base directory: ${reference.uri}`,
    );
  }

  let resolvedBase: string;
  let resolvedFile: string;
  try {
    [resolvedBase, resolvedFile] = await Promise.all([
      realpath(resolvedBaseDirectory),
      realpath(candidate),
    ]);
  } catch (error) {
    throw new Error(
      `unable to read local resource: ${reference.uri}`,
      { cause: error },
    );
  }

  if (!isWithin(resolvedBase, resolvedFile)) {
    throw new Error(
      `resource is outside local-file base directory: ${reference.uri}`,
    );
  }

  const details = await stat(resolvedFile);
  if (!details.isFile()) {
    throw new Error(`local resource is not a regular file: ${reference.uri}`);
  }

  return {
    absolutePath: resolvedFile,
    repoRelativePath: relative(resolvedBase, resolvedFile).replaceAll("\\", "/"),
    filename: basename(resolvedFile),
    mediaType:
      mediaTypes[extname(resolvedFile).toLowerCase()] ??
      "application/octet-stream",
    revision: `${details.mtimeMs}-${details.size}`,
  };
}

export class LocalFileConnector implements Connector {
  readonly type = "local-file";
  readonly #baseDirectory: string;

  constructor(baseDirectory: string) {
    this.#baseDirectory = resolve(baseDirectory);
  }

  async fetch(reference: ResourceReference): Promise<FetchedResource> {
    const resolved = await resolveLocalFileResource(this.#baseDirectory, reference);

    return {
      sourceUri: reference.uri,
      mediaType: resolved.mediaType,
      content: await readFile(resolved.absolutePath),
      revision: resolved.revision,
      metadata: {
        filename: resolved.filename,
      },
    };
  }
}
