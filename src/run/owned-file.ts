import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats, type Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export interface RunOwnedFileReference {
  runDirectory: string;
  path: string;
  subject: string;
}

interface ExpectedRunOwnedFileIntegrity {
  expectedSha256?: string;
  expectedSize?: number;
}

export interface ReadRunOwnedFileInput extends RunOwnedFileReference,
  ExpectedRunOwnedFileIntegrity {
  maximumBytes?: number;
}

export interface CopyRunOwnedFileInput extends RunOwnedFileReference,
  ExpectedRunOwnedFileIntegrity {
  destinationPath: string;
}

export interface WriteRunOwnedFileInput extends RunOwnedFileReference {
  content: string | Buffer;
}

export type RemoveRunOwnedFileInput = RunOwnedFileReference;
export type RemoveRunOwnedDirectoryInput = RunOwnedFileReference;
export type ListRunOwnedDirectoryInput = RunOwnedFileReference;
export type CreateRunOwnedDirectoryInput = RunOwnedFileReference;
export type EnsureRunOwnedDirectoryInput = RunOwnedFileReference;
export type RequireRunOwnedDirectoryInput = RunOwnedFileReference;

export interface RunOwnedFileResult {
  relativePath: string;
  filename: string;
}

export interface CopiedRunOwnedFileResult extends RunOwnedFileResult {
  sha256: string;
  size: number;
}

export class UnsafeRunOwnedFileError extends Error {
  override readonly name = "UnsafeRunOwnedFileError";
}

export class RunOwnedFileIntegrityError extends Error {
  override readonly name = "RunOwnedFileIntegrityError";
}

interface NormalizedRunPath extends RunOwnedFileResult {
  logicalRunDirectory: string;
  segments: string[];
  subject: string;
}

interface RunPathAnchor extends RunOwnedFileResult {
  canonicalRunDirectory: string;
  leafPath: string;
  parentPath: string;
  linuxAnchored: boolean;
  validateParent: () => Promise<void>;
  syncParent: () => Promise<void>;
  close: () => Promise<void>;
}

interface OpenedRunOwnedFile extends RunOwnedFileResult {
  metadata: BigIntStats;
}

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const DIRECTORY_FLAGS = READ_FLAGS | constants.O_DIRECTORY;
const COPY_DESTINATION_FLAGS =
  constants.O_RDWR |
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW;
const MAX_RUN_PATH_SEGMENTS = 64;
const REMOVAL_QUARANTINE_SUFFIX_PATTERN =
  /^(.*)\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.removing$/u;
const TEMPORARY_FILE_SUFFIX_PATTERN =
  /^(.*)\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/u;

export function runOwnedTemporaryOriginalFilename(
  filename: string,
): string | undefined {
  const prefixedOriginal = TEMPORARY_FILE_SUFFIX_PATTERN.exec(filename)?.[1];
  return prefixedOriginal?.startsWith(".") && prefixedOriginal.length > 1
    ? prefixedOriginal.slice(1)
    : undefined;
}

export function runOwnedRemovalOriginalFilename(
  filename: string,
): string | undefined {
  let candidate = filename;
  let removedLayer = false;
  while (true) {
    const match = REMOVAL_QUARANTINE_SUFFIX_PATTERN.exec(candidate);
    const prefixedOriginal = match?.[1];
    if (!prefixedOriginal?.startsWith(".")) {
      return removedLayer ? candidate : undefined;
    }
    candidate = prefixedOriginal.slice(1);
    if (candidate.length === 0) return undefined;
    removedLayer = true;
  }
}

function unsafe(subject: string, detail: string): UnsafeRunOwnedFileError {
  return new UnsafeRunOwnedFileError(`${subject} ${detail}`);
}

function normalizedExpectedSha256(
  input: ExpectedRunOwnedFileIntegrity & { subject: string },
): string | undefined {
  const value = (input as { expectedSha256?: unknown }).expectedSha256;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/iu.test(value)) {
    throw new RunOwnedFileIntegrityError(
      `${input.subject} has invalid sha256 registry metadata`,
    );
  }
  return value.toLowerCase();
}

function normalizedExpectedSize(
  input: ExpectedRunOwnedFileIntegrity & { subject: string },
): number | undefined {
  const value = (input as { expectedSize?: unknown }).expectedSize;
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new RunOwnedFileIntegrityError(
      `${input.subject} has invalid size registry metadata`,
    );
  }
  return value;
}

function assertExpectedFileMetadata(
  input: ExpectedRunOwnedFileIntegrity & { subject: string },
  metadata: BigIntStats,
): void {
  normalizedExpectedSha256(input);
  const expectedSize = normalizedExpectedSize(input);
  if (expectedSize !== undefined && metadata.size !== BigInt(expectedSize)) {
    throw new RunOwnedFileIntegrityError(
      `${input.subject} size does not match its registry metadata`,
    );
  }
}

function assertExpectedIntegrity(
  input: ExpectedRunOwnedFileIntegrity & { subject: string },
  actual: { sha256?: string; size: number },
): void {
  const expectedSize = normalizedExpectedSize(input);
  if (
    expectedSize !== undefined &&
    expectedSize !== actual.size
  ) {
    throw new RunOwnedFileIntegrityError(
      `${input.subject} size does not match its registry metadata`,
    );
  }
  const expectedSha256 = normalizedExpectedSha256(input);
  if (
    expectedSha256 !== undefined &&
    expectedSha256 !== actual.sha256
  ) {
    throw new RunOwnedFileIntegrityError(
      `${input.subject} sha256 does not match its registry metadata`,
    );
  }
}

function isPathInside(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return !(
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function normalizeRunPath(
  input: RunOwnedFileReference,
): NormalizedRunPath {
  const logicalRunDirectory = resolve(input.runDirectory);
  const candidate = resolve(logicalRunDirectory, input.path);
  if (!isPathInside(logicalRunDirectory, candidate)) {
    throw unsafe(input.subject, "escapes its run directory");
  }
  const relativePath = relative(logicalRunDirectory, candidate);
  if (!relativePath) {
    throw unsafe(input.subject, "does not name a file");
  }
  const segments = relativePath.split(sep);
  if (segments.length > MAX_RUN_PATH_SEGMENTS) {
    throw unsafe(
      input.subject,
      `has more than ${MAX_RUN_PATH_SEGMENTS} path components`,
    );
  }
  return {
    logicalRunDirectory,
    relativePath,
    filename: basename(candidate),
    segments,
    subject: input.subject,
  };
}

function assertDirectory(metadata: BigIntStats, subject: string): void {
  if (metadata.isSymbolicLink()) {
    throw unsafe(subject, "is a symbolic link");
  }
  if (!metadata.isDirectory()) {
    throw unsafe(subject, "is not a directory");
  }
}

function assertRunOwnedRegularFile(
  metadata: BigIntStats,
  subject: string,
): void {
  if (metadata.isSymbolicLink()) {
    throw unsafe(subject, "is a symbolic link");
  }
  if (!metadata.isFile()) {
    throw unsafe(subject, "is not a regular file");
  }
  if (metadata.nlink > 1n) {
    throw unsafe(subject, "has multiple hard links");
  }
  if (metadata.nlink !== 1n) {
    throw unsafe(subject, "is no longer linked into its run directory");
  }
}

function assertSameIdentity(
  expected: BigIntStats,
  actual: BigIntStats,
  subject: string,
): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
    throw unsafe(subject, "changed while it was being opened");
  }
}

function assertStableFile(
  expected: BigIntStats,
  actual: BigIntStats,
  subject: string,
): void {
  assertSameIdentity(expected, actual, subject);
  if (
    expected.size !== actual.size ||
    expected.mtimeNs !== actual.mtimeNs ||
    expected.ctimeNs !== actual.ctimeNs
  ) {
    throw unsafe(subject, "changed while it was being read");
  }
}

function rethrowUnsafeLookup(error: unknown, subject: string): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ELOOP" || code === "ENOTDIR") {
    throw unsafe(subject, "traverses a symbolic link or non-directory");
  }
  throw error;
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // Preserve the operation error when cleanup races with stream teardown.
  }
}

async function closeAll(handles: FileHandle[]): Promise<void> {
  for (const handle of [...handles].reverse()) {
    await closeQuietly(handle);
  }
}

async function removeIfSameFile(
  path: string,
  expected: BigIntStats | undefined,
): Promise<void> {
  if (!expected) return;
  try {
    const current = await lstat(path, { bigint: true });
    if (current.dev === expected.dev && current.ino === expected.ino) {
      await rm(path);
    }
  } catch {
    // Cleanup is best-effort and must not hide the ownership failure.
  }
}

async function assertCanonicalRunDirectoryStable(
  path: NormalizedRunPath,
  canonicalRunDirectory: string,
  handle: FileHandle,
): Promise<void> {
  try {
    const currentLogical = await lstat(path.logicalRunDirectory, {
      bigint: true,
    });
    assertDirectory(currentLogical, `${path.subject} run directory`);
    const currentCanonicalRunDirectory = await realpath(
      path.logicalRunDirectory,
    );
    if (currentCanonicalRunDirectory !== canonicalRunDirectory) {
      throw unsafe(path.subject, "run directory changed while it was opened");
    }
    const [opened, current] = await Promise.all([
      handle.stat({ bigint: true }),
      stat(currentCanonicalRunDirectory, { bigint: true }),
    ]);
    assertDirectory(opened, `${path.subject} run directory`);
    assertSameIdentity(
      opened,
      currentLogical,
      `${path.subject} run directory`,
    );
    assertSameIdentity(
      opened,
      current,
      `${path.subject} run directory`,
    );

    if (process.platform === "linux") {
      const descriptorPath = `/proc/self/fd/${handle.fd}`;
      let descriptorTarget: string;
      try {
        descriptorTarget = await realpath(descriptorPath);
      } catch (error) {
        throw unsafe(
          path.subject,
          `cannot anchor its run directory through /proc/self/fd: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (descriptorTarget !== canonicalRunDirectory) {
        throw unsafe(path.subject, "run directory changed while it was opened");
      }
    }
  } catch (error) {
    if (error instanceof UnsafeRunOwnedFileError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw unsafe(path.subject, "run directory changed while it was opened");
    }
    rethrowUnsafeLookup(error, `${path.subject} run directory`);
  }
}

async function openCanonicalRunDirectory(
  path: NormalizedRunPath,
): Promise<{ canonicalRunDirectory: string; handle: FileHandle }> {
  let handle: FileHandle | undefined;
  try {
    const expected = await lstat(path.logicalRunDirectory, { bigint: true });
    assertDirectory(expected, `${path.subject} run directory`);
    handle = await open(path.logicalRunDirectory, DIRECTORY_FLAGS);
    const opened = await handle.stat({ bigint: true });
    assertDirectory(opened, `${path.subject} run directory`);
    assertSameIdentity(
      expected,
      opened,
      `${path.subject} run directory`,
    );
    const canonicalRunDirectory = await realpath(
      process.platform === "linux"
        ? `/proc/self/fd/${handle.fd}`
        : path.logicalRunDirectory,
    );
    const canonical = await stat(canonicalRunDirectory, { bigint: true });
    assertDirectory(canonical, `${path.subject} run directory`);
    assertSameIdentity(
      opened,
      canonical,
      `${path.subject} run directory`,
    );
    const currentLogical = await lstat(path.logicalRunDirectory, {
      bigint: true,
    });
    assertDirectory(currentLogical, `${path.subject} run directory`);
    assertSameIdentity(
      opened,
      currentLogical,
      `${path.subject} run directory`,
    );

    await assertCanonicalRunDirectoryStable(
      path,
      canonicalRunDirectory,
      handle,
    );

    return { canonicalRunDirectory, handle };
  } catch (error) {
    await closeQuietly(handle);
    rethrowUnsafeLookup(error, `${path.subject} run directory`);
  }
}

async function openLinuxParent(
  path: NormalizedRunPath,
  root: { canonicalRunDirectory: string; handle: FileHandle },
): Promise<{
  parent: FileHandle;
  validate: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const handles = [root.handle];
  const hops: Array<{
    parent: FileHandle;
    child: FileHandle;
    segment: string;
    metadata: BigIntStats;
  }> = [];
  try {
    for (const segment of path.segments.slice(0, -1)) {
      const parent = handles.at(-1)!;
      const childPath = join(`/proc/self/fd/${parent.fd}`, segment);
      const expected = await lstat(childPath, { bigint: true });
      assertDirectory(expected, `${path.subject} parent directory`);

      let child: FileHandle;
      try {
        child = await open(childPath, DIRECTORY_FLAGS);
      } catch (error) {
        rethrowUnsafeLookup(error, `${path.subject} parent directory`);
      }
      try {
        const opened = await child.stat({ bigint: true });
        assertDirectory(opened, `${path.subject} parent directory`);
        assertSameIdentity(
          expected,
          opened,
          `${path.subject} parent directory`,
        );
        const current = await lstat(childPath, { bigint: true });
        assertDirectory(current, `${path.subject} parent directory`);
        assertSameIdentity(
          opened,
          current,
          `${path.subject} parent directory`,
        );
      } catch (error) {
        await closeQuietly(child);
        throw error;
      }
      handles.push(child);
      hops.push({ parent, child, segment, metadata: expected });
    }
    return {
      parent: handles.at(-1)!,
      validate: async () => {
        await assertCanonicalRunDirectoryStable(
          path,
          root.canonicalRunDirectory,
          root.handle,
        );
        for (const hop of hops) {
          const childPath = join(
            `/proc/self/fd/${hop.parent.fd}`,
            hop.segment,
          );
          let current: BigIntStats;
          try {
            current = await lstat(childPath, { bigint: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              throw unsafe(
                path.subject,
                "parent directory changed while it was open",
              );
            }
            rethrowUnsafeLookup(error, `${path.subject} parent directory`);
          }
          assertDirectory(current, `${path.subject} parent directory`);
          const opened = await hop.child.stat({ bigint: true });
          assertDirectory(opened, `${path.subject} parent directory`);
          assertSameIdentity(
            hop.metadata,
            opened,
            `${path.subject} parent directory`,
          );
          assertSameIdentity(
            opened,
            current,
            `${path.subject} parent directory`,
          );
        }
      },
      close: async () => closeAll(handles),
    };
  } catch (error) {
    await closeAll(handles);
    rethrowUnsafeLookup(error, `${path.subject} parent directory`);
  }
}

async function openRunPathAnchor(
  path: NormalizedRunPath,
): Promise<RunPathAnchor> {
  const root = await openCanonicalRunDirectory(path);
  if (process.platform !== "linux") {
    await closeQuietly(root.handle);
    throw unsafe(
      path.subject,
      "requires Linux descriptor-relative path anchoring",
    );
  }
  if (process.platform === "linux") {
    const anchored = await openLinuxParent(path, root);
    const parentPath = `/proc/self/fd/${anchored.parent.fd}`;
    return {
      canonicalRunDirectory: root.canonicalRunDirectory,
      parentPath,
      leafPath: join(parentPath, path.filename),
      relativePath: path.relativePath,
      filename: path.filename,
      linuxAnchored: true,
      validateParent: anchored.validate,
      syncParent: () => anchored.parent.sync(),
      close: anchored.close,
    };
  }

  const parentSegments = path.segments.slice(0, -1);
  const parentPath = resolve(root.canonicalRunDirectory, ...parentSegments);
  const anchor: RunPathAnchor = {
    canonicalRunDirectory: root.canonicalRunDirectory,
    parentPath,
    leafPath: join(parentPath, path.filename),
    relativePath: path.relativePath,
    filename: path.filename,
    linuxAnchored: false,
    validateParent: async () => {
      await assertCanonicalRunDirectoryStable(
        path,
        root.canonicalRunDirectory,
        root.handle,
      );
      await assertPortableParentResolution(anchor, path.subject);
    },
    syncParent: () => root.handle.sync(),
    close: async () => closeQuietly(root.handle),
  };
  return anchor;
}

async function assertPortableParentResolution(
  anchor: RunPathAnchor,
  subject: string,
): Promise<void> {
  if (anchor.linuxAnchored) return;
  const resolvedParent = await realpath(anchor.parentPath);
  if (!isPathInside(anchor.canonicalRunDirectory, resolvedParent)) {
    throw unsafe(subject, "parent directory resolves outside its run directory");
  }
  const expectedParent = relative(
    anchor.canonicalRunDirectory,
    anchor.parentPath,
  );
  const actualParent = relative(
    anchor.canonicalRunDirectory,
    resolvedParent,
  );
  if (portablePath(expectedParent) !== portablePath(actualParent)) {
    throw unsafe(subject, "traverses a symbolic link");
  }
}

async function assertPortableFileResolution(
  anchor: RunPathAnchor,
  subject: string,
): Promise<void> {
  if (anchor.linuxAnchored) return;
  const resolvedPath = await realpath(anchor.leafPath);
  if (!isPathInside(anchor.canonicalRunDirectory, resolvedPath)) {
    throw unsafe(subject, "resolves outside its run directory");
  }
  const actualPath = relative(anchor.canonicalRunDirectory, resolvedPath);
  if (portablePath(anchor.relativePath) !== portablePath(actualPath)) {
    throw unsafe(subject, "traverses a symbolic link");
  }
}

async function withRunOwnedFile<T>(
  input: RunOwnedFileReference & ExpectedRunOwnedFileIntegrity,
  use: (
    handle: FileHandle,
    file: OpenedRunOwnedFile,
  ) => Promise<T>,
): Promise<{ result: T; file: RunOwnedFileResult }> {
  const path = normalizeRunPath(input);
  const anchor = await openRunPathAnchor(path);
  let handle: FileHandle | undefined;
  try {
    await anchor.validateParent();
    const expected = await lstat(anchor.leafPath, { bigint: true });
    assertRunOwnedRegularFile(expected, input.subject);
    await assertPortableFileResolution(anchor, input.subject);

    try {
      handle = await open(anchor.leafPath, READ_FLAGS);
    } catch (error) {
      rethrowUnsafeLookup(error, input.subject);
    }
    const opened = await handle.stat({ bigint: true });
    assertRunOwnedRegularFile(opened, input.subject);
    assertStableFile(expected, opened, input.subject);
    assertExpectedFileMetadata(input, opened);
    await anchor.validateParent();
    await assertPortableFileResolution(anchor, input.subject);

    const result = await use(handle, {
      relativePath: anchor.relativePath,
      filename: anchor.filename,
      metadata: opened,
    });

    const afterRead = await handle.stat({ bigint: true });
    assertRunOwnedRegularFile(afterRead, input.subject);
    assertStableFile(opened, afterRead, input.subject);
    let current: BigIntStats;
    try {
      current = await lstat(anchor.leafPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw unsafe(input.subject, "changed while it was being read");
      }
      throw error;
    }
    assertRunOwnedRegularFile(current, input.subject);
    assertStableFile(opened, current, input.subject);
    await anchor.validateParent();
    await assertPortableFileResolution(anchor, input.subject);

    return {
      result,
      file: {
        relativePath: anchor.relativePath,
        filename: anchor.filename,
      },
    };
  } catch (error) {
    rethrowUnsafeLookup(error, input.subject);
  } finally {
    await closeQuietly(handle);
    await anchor.close();
  }
}

async function readHandle(
  handle: FileHandle,
  input: ReadRunOwnedFileInput,
  metadata: BigIntStats,
): Promise<Buffer> {
  if (
    input.maximumBytes !== undefined &&
    metadata.size > BigInt(input.maximumBytes)
  ) {
    throw new Error(
      `${input.subject} exceeds the ${input.maximumBytes}-byte read limit`,
    );
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const stream = handle.createReadStream({ autoClose: false, start: 0 });
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (
      input.maximumBytes !== undefined &&
      totalBytes > input.maximumBytes
    ) {
      throw new Error(
        `${input.subject} exceeds the ${input.maximumBytes}-byte read limit`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes);
}

async function createOrEnsureRunOwnedDirectory(
  input:
    | CreateRunOwnedDirectoryInput
    | EnsureRunOwnedDirectoryInput
    | RequireRunOwnedDirectoryInput,
  mode: "create" | "ensure" | "require",
): Promise<void> {
  const path = normalizeRunPath(input);
  const root = await openCanonicalRunDirectory(path);
  const handles = [root.handle];
  const hops: Array<{
    parent: FileHandle;
    child: FileHandle;
    segment: string;
    metadata: BigIntStats;
  }> = [];
  try {
    if (process.platform !== "linux") {
      throw unsafe(
        input.subject,
        "requires Linux descriptor-relative path anchoring",
      );
    }
    for (const [index, segment] of path.segments.entries()) {
      const parent = handles.at(-1)!;
      const childPath = join(`/proc/self/fd/${parent.fd}`, segment);
      let expected: BigIntStats;
      const createLeaf =
        mode === "create" && index === path.segments.length - 1;
      if (createLeaf) {
        try {
          await mkdir(childPath, { mode: 0o700 });
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code === "EEXIST") {
            const existing = await lstat(childPath, { bigint: true });
            if (existing.isSymbolicLink()) {
              throw unsafe(`${input.subject} directory`, "is a symbolic link");
            }
          }
          rethrowUnsafeLookup(mkdirError, `${input.subject} directory`);
        }
        expected = await lstat(childPath, { bigint: true });
      } else {
        try {
          expected = await lstat(childPath, { bigint: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            rethrowUnsafeLookup(error, `${input.subject} directory`);
          }
          if (mode === "require") throw error;
          try {
            await mkdir(childPath, { mode: 0o700 });
          } catch (mkdirError) {
            if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
              rethrowUnsafeLookup(mkdirError, `${input.subject} directory`);
            }
          }
          expected = await lstat(childPath, { bigint: true });
        }
      }
      assertDirectory(expected, `${input.subject} directory`);

      let child: FileHandle;
      try {
        child = await open(childPath, DIRECTORY_FLAGS);
      } catch (error) {
        rethrowUnsafeLookup(error, `${input.subject} directory`);
      }
      try {
        const opened = await child.stat({ bigint: true });
        assertDirectory(opened, `${input.subject} directory`);
        assertSameIdentity(expected, opened, `${input.subject} directory`);
        const current = await lstat(childPath, { bigint: true });
        assertDirectory(current, `${input.subject} directory`);
        assertSameIdentity(opened, current, `${input.subject} directory`);
      } catch (error) {
        await closeQuietly(child);
        throw error;
      }
      handles.push(child);
      hops.push({ parent, child, segment, metadata: expected });
    }

    await assertCanonicalRunDirectoryStable(
      path,
      root.canonicalRunDirectory,
      root.handle,
    );
    for (const hop of hops) {
      const childPath = join(`/proc/self/fd/${hop.parent.fd}`, hop.segment);
      const current = await lstat(childPath, { bigint: true });
      assertDirectory(current, `${input.subject} directory`);
      const opened = await hop.child.stat({ bigint: true });
      assertDirectory(opened, `${input.subject} directory`);
      assertSameIdentity(hop.metadata, opened, `${input.subject} directory`);
      assertSameIdentity(opened, current, `${input.subject} directory`);
    }
  } catch (error) {
    rethrowUnsafeLookup(error, input.subject);
  } finally {
    await closeAll(handles);
  }
}

export async function createRunOwnedDirectory(
  input: CreateRunOwnedDirectoryInput,
): Promise<void> {
  await createOrEnsureRunOwnedDirectory(input, "create");
}

export async function ensureRunOwnedDirectory(
  input: EnsureRunOwnedDirectoryInput,
): Promise<void> {
  await createOrEnsureRunOwnedDirectory(input, "ensure");
}

export async function requireRunOwnedDirectory(
  input: RequireRunOwnedDirectoryInput,
): Promise<void> {
  await createOrEnsureRunOwnedDirectory(input, "require");
}

export async function listRunOwnedDirectory(
  input: ListRunOwnedDirectoryInput,
): Promise<Dirent[]> {
  const path = normalizeRunPath(input);
  const anchor = await openRunPathAnchor(path);
  let handle: FileHandle | undefined;
  try {
    await anchor.validateParent();
    const expected = await lstat(anchor.leafPath, { bigint: true });
    assertDirectory(expected, input.subject);

    try {
      handle = await open(anchor.leafPath, DIRECTORY_FLAGS);
    } catch (error) {
      rethrowUnsafeLookup(error, input.subject);
    }
    const opened = await handle.stat({ bigint: true });
    assertDirectory(opened, input.subject);
    assertSameIdentity(expected, opened, input.subject);
    await anchor.validateParent();
    await assertPortableFileResolution(anchor, input.subject);

    const entries = await readdir(
      process.platform === "linux"
        ? `/proc/self/fd/${handle.fd}`
        : anchor.leafPath,
      { withFileTypes: true },
    );
    const afterRead = await handle.stat({ bigint: true });
    assertDirectory(afterRead, input.subject);
    assertSameIdentity(opened, afterRead, input.subject);
    const current = await lstat(anchor.leafPath, { bigint: true });
    assertDirectory(current, input.subject);
    assertSameIdentity(opened, current, input.subject);
    await anchor.validateParent();
    await assertPortableFileResolution(anchor, input.subject);
    return entries;
  } catch (error) {
    rethrowUnsafeLookup(error, input.subject);
  } finally {
    await closeQuietly(handle);
    await anchor.close();
  }
}

export async function readRunOwnedFile(
  input: ReadRunOwnedFileInput,
): Promise<RunOwnedFileResult & { content: Buffer }> {
  const opened = await withRunOwnedFile(
    input,
    async (handle, file) =>
      readHandle(handle, input, file.metadata),
  );
  const expectedSha256 = normalizedExpectedSha256(input);
  assertExpectedIntegrity(input, {
    size: opened.result.byteLength,
    ...(expectedSha256 !== undefined
      ? { sha256: createHash("sha256").update(opened.result).digest("hex") }
      : {}),
  });
  return { ...opened.file, content: opened.result };
}

export async function copyRunOwnedFile(
  input: CopyRunOwnedFileInput,
): Promise<CopiedRunOwnedFileResult> {
  normalizedExpectedSha256(input);
  let destination: FileHandle | undefined;
  let destinationMetadata: BigIntStats | undefined;
  let copiedIntegrity: { sha256: string; size: number } | undefined;
  let destinationCreated = false;
  let completed = false;
  try {
    const opened = await withRunOwnedFile(input, async (source) => {
      destination = await open(
        input.destinationPath,
        COPY_DESTINATION_FLAGS,
        0o600,
      );
      destinationCreated = true;
      destinationMetadata = await destination.stat({ bigint: true });
      let destinationPosition = 0;
      const sourceHash = createHash("sha256");
      const stream = source.createReadStream({ autoClose: false, start: 0 });
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        sourceHash.update(buffer);
        let offset = 0;
        while (offset < buffer.byteLength) {
          const { bytesWritten } = await destination.write(
            buffer,
            offset,
            buffer.byteLength - offset,
            destinationPosition,
          );
          if (bytesWritten === 0) {
            throw new Error(`could not copy ${input.subject}`);
          }
          offset += bytesWritten;
          destinationPosition += bytesWritten;
        }
      }
      const sourceSha256 = sourceHash.digest("hex");
      assertExpectedIntegrity(input, {
        size: destinationPosition,
        sha256: sourceSha256,
      });
      await destination.sync();
      const beforeVerification = await destination.stat({ bigint: true });
      assertRunOwnedRegularFile(
        beforeVerification,
        `${input.subject} copy destination`,
      );
      if (beforeVerification.size !== BigInt(destinationPosition)) {
        throw unsafe(input.subject, "copy destination content changed");
      }

      const destinationHash = createHash("sha256");
      let verifiedBytes = 0;
      const destinationStream = destination.createReadStream({
        autoClose: false,
        start: 0,
      });
      for await (const chunk of destinationStream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        destinationHash.update(buffer);
        verifiedBytes += buffer.byteLength;
      }
      const afterVerification = await destination.stat({ bigint: true });
      assertRunOwnedRegularFile(
        afterVerification,
        `${input.subject} copy destination`,
      );
      assertStableFile(
        beforeVerification,
        afterVerification,
        `${input.subject} copy destination`,
      );
      if (
        verifiedBytes !== destinationPosition ||
        destinationHash.digest("hex") !== sourceSha256
      ) {
        throw unsafe(input.subject, "copy destination content changed");
      }
      destinationMetadata = afterVerification;
      copiedIntegrity = {
        sha256: sourceSha256,
        size: destinationPosition,
      };
    });
    if (!destinationMetadata || !copiedIntegrity) {
      throw unsafe(input.subject, "copy destination was not created");
    }
    const currentDestination = await lstat(input.destinationPath, {
      bigint: true,
    });
    assertRunOwnedRegularFile(
      currentDestination,
      `${input.subject} copy destination`,
    );
    assertStableFile(
      destinationMetadata,
      currentDestination,
      `${input.subject} copy destination`,
    );
    completed = true;
    return { ...opened.file, ...copiedIntegrity };
  } finally {
    await closeQuietly(destination);
    if (destinationCreated && !completed) {
      await removeIfSameFile(input.destinationPath, destinationMetadata);
    }
  }
}

async function quarantineRunEntry(input: {
  anchor: RunPathAnchor;
  expected: BigIntStats;
  subject: string;
  validate: (metadata: BigIntStats) => void;
}): Promise<string> {
  const quarantinePath = join(
    input.anchor.parentPath,
    `.${input.anchor.filename}.${randomUUID()}.removing`,
  );
  try {
    await lstat(quarantinePath);
    throw unsafe(input.subject, "could not reserve a removal quarantine name");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await input.anchor.validateParent();
  try {
    await rename(input.anchor.leafPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw unsafe(input.subject, "changed before it could be quarantined");
    }
    throw error;
  }
  const quarantined = await lstat(quarantinePath, { bigint: true });
  input.validate(quarantined);
  assertSameIdentity(input.expected, quarantined, input.subject);
  await input.anchor.validateParent();
  return quarantinePath;
}

export async function removeRunOwnedFile(
  input: RemoveRunOwnedFileInput,
): Promise<boolean> {
  const path = normalizeRunPath(input);
  const anchor = await openRunPathAnchor(path);
  let handle: FileHandle | undefined;
  try {
    await anchor.validateParent();
    let expected: BigIntStats;
    try {
      expected = await lstat(anchor.leafPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    assertRunOwnedRegularFile(expected, input.subject);
    await assertPortableFileResolution(anchor, input.subject);

    try {
      handle = await open(anchor.leafPath, READ_FLAGS);
    } catch (error) {
      rethrowUnsafeLookup(error, input.subject);
    }
    const opened = await handle.stat({ bigint: true });
    assertRunOwnedRegularFile(opened, input.subject);
    assertStableFile(expected, opened, input.subject);
    const current = await lstat(anchor.leafPath, { bigint: true });
    assertRunOwnedRegularFile(current, input.subject);
    assertStableFile(opened, current, input.subject);
    await anchor.validateParent();
    await assertPortableFileResolution(anchor, input.subject);

    const quarantinePath = await quarantineRunEntry({
      anchor,
      expected: opened,
      subject: input.subject,
      validate: (metadata) => assertRunOwnedRegularFile(metadata, input.subject),
    });
    const quarantined = await lstat(quarantinePath, { bigint: true });
    assertRunOwnedRegularFile(quarantined, input.subject);
    assertSameIdentity(opened, quarantined, input.subject);
    await rm(quarantinePath);
    await anchor.syncParent();
    await anchor.validateParent();
    return true;
  } catch (error) {
    rethrowUnsafeLookup(error, input.subject);
  } finally {
    await closeQuietly(handle);
    await anchor.close();
  }
}

export async function removeRunOwnedDirectoryRecursively(
  input: RemoveRunOwnedDirectoryInput,
): Promise<boolean> {
  const path = normalizeRunPath(input);
  const anchor = await openRunPathAnchor(path);
  let handle: FileHandle | undefined;
  try {
    await anchor.validateParent();
    let expected: BigIntStats;
    try {
      expected = await lstat(anchor.leafPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    assertDirectory(expected, input.subject);

    try {
      handle = await open(anchor.leafPath, DIRECTORY_FLAGS);
    } catch (error) {
      rethrowUnsafeLookup(error, input.subject);
    }
    const opened = await handle.stat({ bigint: true });
    assertDirectory(opened, input.subject);
    assertSameIdentity(expected, opened, input.subject);
    const current = await lstat(anchor.leafPath, { bigint: true });
    assertDirectory(current, input.subject);
    assertSameIdentity(opened, current, input.subject);
    await anchor.validateParent();

    const quarantinePath = await quarantineRunEntry({
      anchor,
      expected: opened,
      subject: input.subject,
      validate: (metadata) => assertDirectory(metadata, input.subject),
    });
    const quarantined = await lstat(quarantinePath, { bigint: true });
    assertDirectory(quarantined, input.subject);
    assertSameIdentity(opened, quarantined, input.subject);
    await rm(quarantinePath, { recursive: true });
    await anchor.syncParent();
    await anchor.validateParent();
    return true;
  } catch (error) {
    rethrowUnsafeLookup(error, input.subject);
  } finally {
    await closeQuietly(handle);
    await anchor.close();
  }
}

export async function writeRunOwnedFileAtomically(
  input: WriteRunOwnedFileInput,
): Promise<void> {
  const path = normalizeRunPath(input);
  const anchor = await openRunPathAnchor(path);
  const temporaryPath = join(
    anchor.parentPath,
    `.${anchor.filename}.${randomUUID()}.tmp`,
  );
  let temporary: FileHandle | undefined;
  let temporaryMetadata: BigIntStats | undefined;
  let temporaryCreated = false;
  let renamed = false;
  let renamedFileSafeToRetain = false;
  try {
    await anchor.validateParent();
    try {
      const existing = await lstat(anchor.leafPath, { bigint: true });
      if (existing.isSymbolicLink()) {
        throw unsafe(input.subject, "is a symbolic link");
      }
      if (!existing.isFile()) {
        throw unsafe(input.subject, "is not a regular file");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    temporary = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    temporaryMetadata = await temporary.stat({ bigint: true });
    await temporary.chmod(0o600);
    await temporary.writeFile(input.content);
    await temporary.sync();
    await closeQuietly(temporary);
    temporary = undefined;

    await anchor.validateParent();
    await rename(temporaryPath, anchor.leafPath);
    temporaryCreated = false;
    renamed = true;

    const written = await lstat(anchor.leafPath, { bigint: true });
    assertRunOwnedRegularFile(written, input.subject);
    assertSameIdentity(temporaryMetadata, written, input.subject);
    await anchor.validateParent();
    renamedFileSafeToRetain = true;
    await anchor.syncParent();
  } catch (error) {
    rethrowUnsafeLookup(error, input.subject);
  } finally {
    await closeQuietly(temporary);
    if (temporaryCreated) {
      await removeIfSameFile(temporaryPath, temporaryMetadata);
    }
    if (renamed && !renamedFileSafeToRetain) {
      await removeIfSameFile(anchor.leafPath, temporaryMetadata);
    }
    await anchor.close();
  }
}
