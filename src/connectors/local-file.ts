import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  open,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
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
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const DEFAULT_MAX_LOCAL_FILE_BYTES = 16 * 1024 * 1024;

function expectedSha256(reference: ResourceReference): string | undefined {
  const value = reference.options?.expectedSha256;
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error("local resource has invalid expected sha256");
  }
  const match = /^(?:sha256:)?([A-Fa-f0-9]{64})$/u.exec(value);
  if (!match?.[1]) {
    throw new Error("local resource has invalid expected sha256");
  }
  return match[1].toLowerCase();
}

function isWithin(base: string, candidate: string): boolean {
  const path = relative(base, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function candidatePath(
  baseDirectory: string,
  reference: ResourceReference,
  allowedRoots: string[] = [],
): { baseDirectory: string; candidate: string; allowedRoots: string[] } {
  const resolvedBaseDirectory = resolve(baseDirectory);
  const resolvedAllowedRoots = allowedRoots.map((root) => resolve(root));
  const candidate = reference.uri.startsWith("file:")
    ? fileURLToPath(reference.uri)
    : resolve(resolvedBaseDirectory, reference.uri);
  const withinBase = isWithin(resolvedBaseDirectory, candidate);
  const withinAllowed = resolvedAllowedRoots.some((root) =>
    isWithin(root, candidate),
  );
  if (!withinBase && !withinAllowed) {
    throw new Error(
      `resource is outside local-file base directory: ${reference.uri}`,
    );
  }
  return {
    baseDirectory: resolvedBaseDirectory,
    candidate,
    allowedRoots: resolvedAllowedRoots,
  };
}

async function isWithinResolvedRoots(
  candidate: string,
  roots: string[],
): Promise<boolean> {
  for (const root of roots) {
    try {
      const resolvedRoot = await realpath(root);
      if (isWithin(resolvedRoot, candidate)) {
        return true;
      }
    } catch {
      // Skip unreadable or missing allowed roots.
    }
  }
  return false;
}

function assertRegularFile(
  metadata: BigIntStats,
  reference: ResourceReference,
): void {
  if (metadata.isSymbolicLink()) {
    throw new Error(`local resource is a symbolic link: ${reference.uri}`);
  }
  if (!metadata.isFile()) {
    throw new Error(`local resource is not a regular file: ${reference.uri}`);
  }
}

function assertSingleLink(
  metadata: BigIntStats,
  reference: ResourceReference,
): void {
  if (metadata.nlink !== 1n) {
    throw new Error(
      `local resource must have exactly one directory entry: ${reference.uri}`,
    );
  }
}

function assertSameIdentity(
  expected: BigIntStats,
  actual: BigIntStats,
  reference: ResourceReference,
): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
    throw new Error(`local resource changed while it was being read: ${reference.uri}`);
  }
}

function assertStableFile(
  expected: BigIntStats,
  actual: BigIntStats,
  reference: ResourceReference,
): void {
  assertSameIdentity(expected, actual, reference);
  if (
    expected.size !== actual.size ||
    expected.mtimeNs !== actual.mtimeNs ||
    expected.ctimeNs !== actual.ctimeNs
  ) {
    throw new Error(`local resource changed while it was being read: ${reference.uri}`);
  }
}

async function assertCurrentPath(
  input: {
    candidate: string;
    absolutePath: string;
    expected: BigIntStats;
    reference: ResourceReference;
  },
): Promise<void> {
  try {
    const [resolved, current] = await Promise.all([
      realpath(input.candidate),
      lstat(input.absolutePath, { bigint: true }),
    ]);
    if (resolved !== input.absolutePath) {
      throw new Error(
        `local resource changed while it was being read: ${input.reference.uri}`,
      );
    }
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new Error(
        `local resource changed while it was being read: ${input.reference.uri}`,
      );
    }
    assertStableFile(input.expected, current, input.reference);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("local resource changed while it was being read:")
    ) {
      throw error;
    }
    throw new Error(
      `local resource changed while it was being read: ${input.reference.uri}`,
      { cause: error },
    );
  }
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // Preserve the read or validation error.
  }
}

async function readBoundedFile(
  handle: FileHandle,
  metadata: BigIntStats,
  reference: ResourceReference,
  maximumBytes: number,
): Promise<Buffer> {
  if (metadata.size > BigInt(maximumBytes)) {
    throw new Error(
      `local resource exceeds the ${maximumBytes}-byte read limit: ${reference.uri}`,
    );
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const stream = handle.createReadStream({ autoClose: false, start: 0 });
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maximumBytes) {
      throw new Error(
        `local resource exceeds the ${maximumBytes}-byte read limit: ${reference.uri}`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes);
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
  options: { allowedRoots?: string[] } = {},
): Promise<ResolvedLocalFileResource> {
  const normalized = candidatePath(
    baseDirectory,
    reference,
    options.allowedRoots ?? [],
  );
  const resolvedBaseDirectory = normalized.baseDirectory;
  const candidate = normalized.candidate;

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

  const withinBase = isWithin(resolvedBase, resolvedFile);
  if (
    !withinBase &&
    !(await isWithinResolvedRoots(resolvedFile, normalized.allowedRoots))
  ) {
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
    repoRelativePath: withinBase
      ? relative(resolvedBase, resolvedFile).replaceAll("\\", "/")
      : resolvedFile,
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
  readonly #options: LocalFileConnectorOptions;

  constructor(
    baseDirectory: string,
    options: LocalFileConnectorOptions = {},
  ) {
    this.#baseDirectory = resolve(baseDirectory);
    if (
      options.maximumBytes !== undefined &&
      (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes <= 0)
    ) {
      throw new Error("local-file maximumBytes must be a positive safe integer");
    }
    this.#options = options;
  }

  async fetch(reference: ResourceReference): Promise<FetchedResource> {
    const expected = expectedSha256(reference);
    const candidate = candidatePath(
      this.#baseDirectory,
      reference,
      this.#options.allowedRoots ?? [],
    ).candidate;
    const resolved = await resolveLocalFileResource(
      this.#baseDirectory,
      reference,
      { allowedRoots: this.#options.allowedRoots },
    );
    let handle: FileHandle | undefined;
    let content: Buffer;
    try {
      const beforeOpen = await lstat(resolved.absolutePath, { bigint: true });
      assertRegularFile(beforeOpen, reference);
      if (this.#options.requireSingleLink) {
        const canonicalBaseDirectory = await realpath(this.#baseDirectory);
        const directAbsolutePath = resolve(
          canonicalBaseDirectory,
          relative(this.#baseDirectory, candidate),
        );
        if (directAbsolutePath !== resolved.absolutePath) {
          throw new Error(`local resource is a symbolic link: ${reference.uri}`);
        }
        const directPath = await lstat(directAbsolutePath, { bigint: true });
        assertRegularFile(directPath, reference);
        assertSameIdentity(directPath, beforeOpen, reference);
        assertSingleLink(directPath, reference);
        assertSingleLink(beforeOpen, reference);
      }
      await assertCurrentPath({
        candidate,
        absolutePath: resolved.absolutePath,
        expected: beforeOpen,
        reference,
      });
      try {
        handle = await open(resolved.absolutePath, READ_FLAGS);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ELOOP" || code === "ENOENT" || code === "ENOTDIR") {
          throw new Error(
            `local resource changed while it was being read: ${reference.uri}`,
            { cause: error },
          );
        }
        throw error;
      }
      const opened = await handle.stat({ bigint: true });
      assertRegularFile(opened, reference);
      if (this.#options.requireSingleLink) {
        assertSingleLink(opened, reference);
      }
      assertStableFile(beforeOpen, opened, reference);
      await assertCurrentPath({
        candidate,
        absolutePath: resolved.absolutePath,
        expected: opened,
        reference,
      });
      await this.#options.afterFileOpened?.({
        absolutePath: resolved.absolutePath,
        repoRelativePath: resolved.repoRelativePath,
        reference,
      });
      content = await readBoundedFile(
        handle,
        opened,
        reference,
        this.#options.maximumBytes ?? DEFAULT_MAX_LOCAL_FILE_BYTES,
      );
      const afterRead = await handle.stat({ bigint: true });
      assertRegularFile(afterRead, reference);
      if (this.#options.requireSingleLink) {
        assertSingleLink(afterRead, reference);
      }
      assertStableFile(opened, afterRead, reference);
      await assertCurrentPath({
        candidate,
        absolutePath: resolved.absolutePath,
        expected: opened,
        reference,
      });
    } finally {
      await closeQuietly(handle);
    }
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (expected !== undefined && expected !== sha256) {
      throw new Error("local resource sha256 does not match expected sha256");
    }

    return {
      sourceUri: reference.uri,
      mediaType: resolved.mediaType,
      content,
      revision: `sha256:${sha256}`,
      metadata: {
        filename: resolved.filename,
      },
    };
  }
}

export interface LocalFileConnectorOptions {
  maximumBytes?: number;
  requireSingleLink?: boolean;
  /**
   * Additional realpath roots that may contain local-file inputs.
   * Absolute paths under these roots are accepted even when outside
   * the connector base directory (typically the target repo).
   */
  allowedRoots?: string[];
  afterFileOpened?: (input: {
    absolutePath: string;
    repoRelativePath: string;
    reference: ResourceReference;
  }) => Promise<void> | void;
}
