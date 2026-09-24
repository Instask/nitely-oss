import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { redactUnknown } from "../context/redaction.js";
import {
  readRunOwnedFile,
  removeRunOwnedFile,
  runOwnedRemovalOriginalFilename,
  UnsafeRunOwnedFileError,
  writeRunOwnedFileAtomically,
} from "../run/owned-file.js";
import type { ArtifactRegistry, RunArtifact } from "./types.js";

const PRIVATE_ARTIFACT_PATH_REF_PATTERN = /^[a-f0-9]{32}$/u;
const PRIVATE_ARTIFACT_PATH_FILENAME_PATTERN =
  /^artifact-paths\.private\.([a-f0-9]{32})\.json$/u;
const PRIVATE_ARTIFACT_PATH_TEMP_FILENAME_PATTERN =
  /^\.artifact-paths\.private\.([a-f0-9]{32})\.json\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/u;
const ARTIFACT_REGISTRY_TEMP_FILENAME_PATTERN =
  /^\.artifacts\.json\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/u;

function privateArtifactPathRefFromSidecarFilename(
  filename: string,
): string | undefined {
  const originalFilename = runOwnedRemovalOriginalFilename(filename) ??
    filename;
  return PRIVATE_ARTIFACT_PATH_FILENAME_PATTERN.exec(originalFilename)?.[1] ??
    PRIVATE_ARTIFACT_PATH_TEMP_FILENAME_PATTERN.exec(originalFilename)?.[1];
}

export function privateArtifactPathRegistryFilename(ref: string): string {
  if (!PRIVATE_ARTIFACT_PATH_REF_PATTERN.test(ref)) {
    throw new Error("invalid private Artifact path reference");
  }
  return `artifact-paths.private.${ref}.json`;
}

export function isPrivateArtifactPathRegistryFilename(
  filename: string,
): boolean {
  return PRIVATE_ARTIFACT_PATH_FILENAME_PATTERN.test(filename);
}

export function isPrivateArtifactPathRegistryTemporaryFilename(
  filename: string,
): boolean {
  return PRIVATE_ARTIFACT_PATH_TEMP_FILENAME_PATTERN.test(filename);
}

export function isPrivateArtifactPathRegistryRemovingFilename(
  filename: string,
): boolean {
  const originalFilename = runOwnedRemovalOriginalFilename(filename);
  return originalFilename !== undefined &&
    privateArtifactPathRefFromSidecarFilename(originalFilename) !== undefined;
}

export function isArtifactRegistryTemporaryFilename(
  filename: string,
): boolean {
  return ARTIFACT_REGISTRY_TEMP_FILENAME_PATTERN.test(filename);
}

export function isArtifactRegistryRemovingFilename(
  filename: string,
): boolean {
  const originalFilename = runOwnedRemovalOriginalFilename(filename);
  return originalFilename !== undefined &&
    (originalFilename === "artifacts.json" ||
      ARTIFACT_REGISTRY_TEMP_FILENAME_PATTERN.test(originalFilename));
}

interface PrivateArtifactPath {
  id: string;
  producer: string;
  path: string;
  publicPath: string;
  materializationSha256: string;
}

interface PublicRegistryBinding {
  generation: number;
  sha256: string;
}

interface PrivateArtifactPathRegistry {
  schemaVersion: 1;
  runId: string;
  privatePathRef: string;
  publicRegistry: PublicRegistryBinding;
  artifacts: PrivateArtifactPath[];
  historicalPaths: string[];
}

interface ArtifactRegistrySnapshot {
  registry: ArtifactRegistry;
  binding: PublicRegistryBinding;
}

interface BoundArtifactRegistrySnapshot extends ArtifactRegistrySnapshot {
  privateRegistry?: PrivateArtifactPathRegistry;
}

function artifactKey(
  artifact: Pick<RunArtifact, "producer" | "id">,
): string {
  return `${artifact.producer}\0${artifact.id}`;
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function materializationSha256(artifact: RunArtifact): string {
  return sha256(JSON.stringify({
    path: artifact.path ?? null,
    sha256: artifact.sha256 ?? null,
    size: artifact.size ?? null,
    stageId: artifact.stageId ?? null,
    attempt: artifact.attempt ?? null,
    createdByRunId: artifact.createdByRunId ?? null,
  }));
}

function materializationMetadataSha256(artifact: RunArtifact): string {
  return sha256(JSON.stringify({
    sha256: artifact.sha256 ?? null,
    size: artifact.size ?? null,
    stageId: artifact.stageId ?? null,
    attempt: artifact.attempt ?? null,
    createdByRunId: artifact.createdByRunId ?? null,
  }));
}

function assertUniqueArtifactIdentities(
  artifacts: Array<Pick<RunArtifact, "producer" | "id">>,
  subject: string,
): void {
  const identities = new Set<string>();
  for (const artifact of artifacts) {
    const key = artifactKey(artifact);
    if (identities.has(key)) {
      throw new Error(
        `${subject} contains duplicate Artifact identity producer=${JSON.stringify(artifact.producer)} id=${JSON.stringify(artifact.id)}`,
      );
    }
    identities.add(key);
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

function runOwnedReference(input: {
  runDirectory: string;
  boundaryRoot: string;
  path: string;
  subject: string;
}): { runDirectory: string; path: string } {
  const logicalRunDirectory = resolve(input.runDirectory);
  const candidate = resolve(logicalRunDirectory, input.path);
  if (!isPathInside(logicalRunDirectory, candidate)) {
    throw new UnsafeRunOwnedFileError(
      `${input.subject} escapes its run directory`,
    );
  }
  const boundaryRoot = resolve(input.boundaryRoot);
  if (!isPathInside(boundaryRoot, candidate)) {
    throw new UnsafeRunOwnedFileError(
      `${input.subject} escapes its boundary root`,
    );
  }
  return {
    runDirectory: boundaryRoot,
    path: relative(boundaryRoot, candidate),
  };
}

export function mergeArtifacts(artifacts: RunArtifact[]): RunArtifact[] {
  const indexes = new Map<string, number>();
  const merged: RunArtifact[] = [];
  for (const artifact of artifacts) {
    const key = artifactKey(artifact);
    const existing = indexes.get(key);
    if (existing === undefined) {
      indexes.set(key, merged.length);
      merged.push(artifact);
      continue;
    }
    merged[existing] = { ...merged[existing], ...artifact };
  }
  return merged;
}

function definedArtifactFields(artifact: RunArtifact): Partial<RunArtifact> {
  return Object.fromEntries(
    Object.entries(artifact).filter(([, value]) => value !== undefined),
  ) as Partial<RunArtifact>;
}

export function reconcileArtifactSources(input: {
  registry: RunArtifact[];
  eventProjection: RunArtifact[];
}): RunArtifact[] {
  const indexes = new Map<string, number>();
  const reconciled: RunArtifact[] = [];
  const upsert = (artifact: RunArtifact): void => {
    const key = artifactKey(artifact);
    const definedFields = definedArtifactFields(artifact);
    const existing = indexes.get(key);
    if (existing === undefined) {
      indexes.set(key, reconciled.length);
      reconciled.push(definedFields as RunArtifact);
      return;
    }
    reconciled[existing] = {
      ...reconciled[existing],
      ...definedFields,
    };
  };

  input.registry.forEach(upsert);
  input.eventProjection.forEach(upsert);
  return reconciled;
}

export function redactRunArtifact(
  artifact: RunArtifact,
  redactionSecrets: Iterable<string> = [],
): RunArtifact {
  const redacted = redactUnknown(artifact, redactionSecrets) as RunArtifact;
  return {
    ...redacted,
    // A digest is integrity metadata, not display content. Mutating it during
    // redaction makes the persisted registry inconsistent with the bytes.
    ...(artifact.sha256 !== undefined ? { sha256: artifact.sha256 } : {}),
  };
}

function privateArtifactPath(
  artifact: RunArtifact,
  redactedArtifact: RunArtifact,
): PrivateArtifactPath | undefined {
  if (!artifact.path || !redactedArtifact.path) return undefined;
  return {
    // The private index deliberately uses the public identity. Otherwise a
    // secret-bearing producer or id could not be joined back to its redacted
    // metadata without exposing that identity on a public surface.
    id: redactedArtifact.id,
    producer: redactedArtifact.producer,
    path: artifact.path,
    publicPath: redactedArtifact.path,
    materializationSha256: materializationSha256(redactedArtifact),
  };
}

async function readPrivateArtifactPathRegistry(input: {
  runDirectory: string;
  boundaryRoot: string;
  runId: string;
  privatePathRef: string;
  filename?: string;
}): Promise<PrivateArtifactPathRegistry | undefined> {
  try {
    const reference = runOwnedReference({
      ...input,
      path: input.filename ??
        privateArtifactPathRegistryFilename(input.privatePathRef),
      subject: "private artifact path registry",
    });
    const { content } = await readRunOwnedFile({
      ...reference,
      subject: "private artifact path registry",
    });
    const parsed = JSON.parse(content.toString("utf8")) as Partial<PrivateArtifactPathRegistry>;
    if (parsed.schemaVersion !== 1) {
      throw new Error("private artifact path registry has unsupported schemaVersion");
    }
    if (parsed.runId !== input.runId) {
      throw new Error(
        `private artifact path registry run id does not match ${input.runId}`,
      );
    }
    if (parsed.privatePathRef !== input.privatePathRef) {
      throw new Error("private artifact path registry reference does not match");
    }
    if (
      typeof parsed.publicRegistry !== "object" ||
      parsed.publicRegistry === null ||
      !Number.isSafeInteger(parsed.publicRegistry.generation) ||
      parsed.publicRegistry.generation < 1 ||
      typeof parsed.publicRegistry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(parsed.publicRegistry.sha256)
    ) {
      throw new Error("private artifact path registry has invalid public registry binding");
    }
    if (!Array.isArray(parsed.artifacts)) {
      throw new Error("private artifact path registry has invalid artifacts");
    }
    const artifacts: PrivateArtifactPath[] = [];
    for (const artifact of parsed.artifacts as unknown[]) {
      if (
        typeof artifact !== "object" ||
        artifact === null ||
        typeof (artifact as PrivateArtifactPath).id !== "string" ||
        typeof (artifact as PrivateArtifactPath).producer !== "string" ||
        typeof (artifact as PrivateArtifactPath).path !== "string" ||
        (artifact as PrivateArtifactPath).path.length === 0 ||
        typeof (artifact as PrivateArtifactPath).publicPath !== "string" ||
        typeof (artifact as PrivateArtifactPath).materializationSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(
          (artifact as PrivateArtifactPath).materializationSha256,
        )
      ) {
        throw new Error("private artifact path registry has invalid Artifact path entry");
      }
      artifacts.push(artifact as PrivateArtifactPath);
    }
    assertUniqueArtifactIdentities(artifacts, "private artifact path registry");
    if (
      parsed.historicalPaths !== undefined &&
      (!Array.isArray(parsed.historicalPaths) ||
        parsed.historicalPaths.some((path) =>
          typeof path !== "string" || path.length === 0
        ))
    ) {
      throw new Error(
        "private artifact path registry has invalid historical paths",
      );
    }
    return {
      schemaVersion: 1,
      runId: input.runId,
      privatePathRef: input.privatePathRef,
      publicRegistry: parsed.publicRegistry as PublicRegistryBinding,
      artifacts,
      historicalPaths: [...new Set(parsed.historicalPaths ?? [])],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function readPrivateArtifactPathsFromSidecar(input: {
  runDirectory: string;
  boundaryRoot: string;
  runId: string;
  filename: string;
}): Promise<string[]> {
  const privatePathRef = privateArtifactPathRefFromSidecarFilename(
    input.filename,
  );
  if (!privatePathRef) {
    throw new Error("invalid private Artifact path sidecar filename");
  }
  const registry = await readPrivateArtifactPathRegistry({
    ...input,
    privatePathRef,
    filename: input.filename,
  });
  return registry
    ? [...new Set([
        ...registry.artifacts.map((artifact) => artifact.path),
        ...registry.historicalPaths,
      ])]
    : [];
}

async function writePrivateArtifactPathRegistry(input: {
  runDirectory: string;
  boundaryRoot: string;
  runId: string;
  privatePathRef: string;
  publicRegistry: PublicRegistryBinding;
  artifacts: PrivateArtifactPath[];
  historicalPaths: string[];
}): Promise<void> {
  const registry: PrivateArtifactPathRegistry = {
    schemaVersion: 1,
    runId: input.runId,
    privatePathRef: input.privatePathRef,
    publicRegistry: input.publicRegistry,
    artifacts: input.artifacts,
    historicalPaths: input.historicalPaths,
  };
  const reference = runOwnedReference({
    ...input,
    path: privateArtifactPathRegistryFilename(input.privatePathRef),
    subject: "private artifact path registry",
  });
  await writeRunOwnedFileAtomically({
    ...reference,
    subject: "private artifact path registry",
    content: JSON.stringify(registry, null, 2),
  });
}

function assertPrivateRegistryMatchesPublic(
  privateRegistry: PrivateArtifactPathRegistry,
  publicSnapshot: ArtifactRegistrySnapshot,
): void {
  if (
    privateRegistry.privatePathRef !== publicSnapshot.registry.privatePathRef ||
    privateRegistry.publicRegistry.generation !== publicSnapshot.binding.generation ||
    privateRegistry.publicRegistry.sha256 !== publicSnapshot.binding.sha256
  ) {
    throw new Error("private artifact path registry binding does not match artifacts.json");
  }
}

function overlayPrivateArtifactPaths(input: {
  artifacts: RunArtifact[];
  publicArtifacts: RunArtifact[];
  privateArtifacts: PrivateArtifactPath[];
}): RunArtifact[] {
  assertUniqueArtifactIdentities(input.publicArtifacts, "artifact registry");
  const publicByKey = new Map(
    input.publicArtifacts.map((artifact) => [artifactKey(artifact), artifact]),
  );
  const restorable = new Map<string, PrivateArtifactPath>();
  for (const privateArtifact of input.privateArtifacts) {
    const publicArtifact = publicByKey.get(artifactKey(privateArtifact));
    if (!publicArtifact) continue;
    if (
      privateArtifact.publicPath !== publicArtifact.path ||
      privateArtifact.materializationSha256 !== materializationSha256(publicArtifact)
    ) {
      throw new Error(
        `private Artifact path binding does not match public Artifact ${privateArtifact.id}`,
      );
    }
    restorable.set(artifactKey(privateArtifact), privateArtifact);
  }
  return input.artifacts.map((artifact) => {
    const privateArtifact = restorable.get(artifactKey(artifact));
    if (
      !privateArtifact ||
      materializationSha256(artifact) !== privateArtifact.materializationSha256
    ) {
      return artifact;
    }
    return { ...artifact, path: privateArtifact.path };
  });
}

async function readArtifactRegistrySnapshot(input: {
  runDirectory: string;
  boundaryRoot: string;
}): Promise<ArtifactRegistrySnapshot | undefined> {
  try {
    const reference = runOwnedReference({
      ...input,
      path: "artifacts.json",
      subject: "artifact registry path",
    });
    const { content } = await readRunOwnedFile({
      ...reference,
      subject: "artifact registry path",
    });
    const parsed = JSON.parse(content.toString("utf8")) as ArtifactRegistry;
    const generation = (parsed as { generation?: unknown }).generation;
    const privatePathRef = (parsed as { privatePathRef?: unknown }).privatePathRef;
    if (
      generation !== undefined &&
      (!Number.isSafeInteger(generation) || (generation as number) < 1)
    ) {
      throw new Error("artifact registry has invalid generation");
    }
    if (
      privatePathRef !== undefined &&
      (typeof privatePathRef !== "string" ||
        !PRIVATE_ARTIFACT_PATH_REF_PATTERN.test(privatePathRef))
    ) {
      throw new Error("artifact registry has invalid private path reference");
    }
    const registry: ArtifactRegistry = {
      runId: typeof parsed.runId === "string" ? parsed.runId : "",
      ...(generation !== undefined ? { generation: generation as number } : {}),
      ...(privatePathRef !== undefined
        ? { privatePathRef: privatePathRef as string }
        : {}),
      artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
    };
    return {
      registry,
      binding: {
        generation: registry.generation ?? 0,
        sha256: sha256(content),
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function restorePrivateArtifactPathsFromSnapshot(input: {
  artifacts: RunArtifact[];
  snapshot: BoundArtifactRegistrySnapshot;
}): RunArtifact[] {
  if (!input.snapshot.privateRegistry) return input.artifacts;
  return overlayPrivateArtifactPaths({
    artifacts: input.artifacts,
    publicArtifacts: input.snapshot.registry.artifacts,
    privateArtifacts: input.snapshot.privateRegistry.artifacts,
  });
}

async function readBoundArtifactRegistrySnapshot(input: {
  runDirectory: string;
  boundaryRoot: string;
  runId: string;
}): Promise<BoundArtifactRegistrySnapshot | undefined> {
  let publicSnapshot = await readArtifactRegistrySnapshot(input);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!publicSnapshot) return undefined;
    if (publicSnapshot.registry.runId !== input.runId) {
      throw new Error(`artifact registry run id does not match ${input.runId}`);
    }
    const privatePathRef = publicSnapshot.registry.privatePathRef;
    if (!privatePathRef) return publicSnapshot;

    let failure: unknown;
    try {
      const privateRegistry = await readPrivateArtifactPathRegistry({
        ...input,
        privatePathRef,
      });
      if (!privateRegistry) {
        throw new Error(
          `referenced private artifact path registry is missing: ${privatePathRef}`,
        );
      }
      assertPrivateRegistryMatchesPublic(privateRegistry, publicSnapshot);
      // Validate every referenced entry against this public generation before
      // handing the pair to readers or a subsequent writer.
      overlayPrivateArtifactPaths({
        artifacts: publicSnapshot.registry.artifacts,
        publicArtifacts: publicSnapshot.registry.artifacts,
        privateArtifacts: privateRegistry.artifacts,
      });
      return { ...publicSnapshot, privateRegistry };
    } catch (error) {
      failure = error;
    }

    const reread = await readArtifactRegistrySnapshot(input);
    if (!reread) return undefined;
    if (reread.binding.sha256 === publicSnapshot.binding.sha256) {
      throw failure;
    }
    publicSnapshot = reread;
  }
  throw new Error("artifact registry changed during private path resolution");
}

export async function restorePrivateArtifactPaths(input: {
  runDirectory: string;
  boundaryRoot: string;
  runId: string;
  artifacts: RunArtifact[];
}): Promise<RunArtifact[]> {
  const snapshot = await readBoundArtifactRegistrySnapshot(input);
  // Orphan immutable sidecars have no authority without a public reference.
  if (!snapshot) return input.artifacts;
  return restorePrivateArtifactPathsFromSnapshot({
    artifacts: input.artifacts,
    snapshot,
  });
}

export async function writeArtifactRegistry(input: {
  runDirectory: string;
  boundaryRoot: string;
  runId: string;
  artifacts: RunArtifact[];
  redactionSecrets: Iterable<string>;
}): Promise<void> {
  const redactionSecrets = [...input.redactionSecrets];
  const mergedArtifacts = mergeArtifacts(input.artifacts);
  let existing: BoundArtifactRegistrySnapshot | undefined;
  try {
    existing = await readBoundArtifactRegistrySnapshot(input);
  } catch (error) {
    // Atomic replacement is intentionally allowed to detach an existing hard
    // link. Other unsafe reads (notably symbolic links) remain fatal.
    if (
      !(error instanceof UnsafeRunOwnedFileError) ||
      !/artifact registry path has multiple hard links/iu.test(error.message)
    ) {
      throw error;
    }
  }
  const existingPublicPaths = new Map(
    (existing?.registry.artifacts ?? [])
      .filter((artifact) => artifact.path !== undefined)
      .map((artifact) => [artifactKey(artifact), artifact]),
  );
  const existingPrivatePaths = new Map(
    (existing?.privateRegistry?.artifacts ?? [])
      .map((artifact) => [artifactKey(artifact), artifact]),
  );
  const redactedArtifacts = mergedArtifacts.map((artifact) => {
    const redacted = redactRunArtifact(artifact, redactionSecrets);
    const previousPrivate = existingPrivatePaths.get(artifactKey(redacted));
    if (
      previousPrivate &&
      (artifact.path === previousPrivate.path ||
        artifact.path === previousPrivate.publicPath)
    ) {
      return {
        ...redacted,
        path: redactUnknown(
          previousPrivate.publicPath,
          redactionSecrets,
        ) as string,
      };
    }
    return redacted;
  });
  assertUniqueArtifactIdentities(
    redactedArtifacts,
    "redacted artifact registry",
  );
  const nextPrivatePaths = redactedArtifacts.flatMap((redactedArtifact, index) => {
    const candidate = privateArtifactPath(mergedArtifacts[index], redactedArtifact);
    if (!candidate) return [];
    const key = artifactKey(candidate);
    const previousPrivate = existingPrivatePaths.get(key);
    const previousPublic = existingPublicPaths.get(key);
    // A caller that accidentally round-trips only the public registry supplies
    // the old redacted path verbatim. Preserve the private path in that case;
    // internal callers use restorePrivateArtifactPaths and supply the real path.
    if (
      previousPrivate &&
      candidate.path === previousPublic?.path &&
      candidate.path !== previousPrivate.path
    ) {
      const previousBinding = previousPublic
        ? materializationSha256(previousPublic)
        : undefined;
      return previousPrivate.materializationSha256 === previousBinding &&
          previousPublic !== undefined &&
          materializationMetadataSha256(redactedArtifact) ===
            materializationMetadataSha256(previousPublic)
        ? [{ ...candidate, path: previousPrivate.path }]
        : [];
    }
    return [candidate];
  });
  const currentPrivatePaths = new Set(
    nextPrivatePaths.map((artifact) => artifact.path),
  );
  const historicalPaths = [...new Set([
    ...(existing?.privateRegistry?.historicalPaths ?? []),
    ...(existing?.privateRegistry?.artifacts.map((artifact) => artifact.path) ?? []),
  ])].filter((path) => !currentPrivatePaths.has(path));
  const previousGeneration = existing?.binding.generation ?? 0;
  if (previousGeneration >= Number.MAX_SAFE_INTEGER) {
    throw new Error("artifact registry generation is exhausted");
  }
  const generation = previousGeneration + 1;
  const privatePathRef = randomUUID().replaceAll("-", "");
  const registry: ArtifactRegistry = {
    runId: input.runId,
    generation,
    privatePathRef,
    artifacts: redactedArtifacts,
  };
  const publicContent = JSON.stringify(registry, null, 2);
  const publicRegistry: PublicRegistryBinding = {
    generation,
    sha256: sha256(publicContent),
  };
  // Write the private path index first. It is inert without corresponding
  // public/event metadata, while the reverse order could permanently lose a
  // newly redacted path after a crash.
  await writePrivateArtifactPathRegistry({
    ...input,
    privatePathRef,
    publicRegistry,
    artifacts: nextPrivatePaths,
    historicalPaths,
  });
  const reference = runOwnedReference({
    ...input,
    path: "artifacts.json",
    subject: "artifact registry path",
  });
  await writeRunOwnedFileAtomically({
    ...reference,
    subject: "artifact registry path",
    content: publicContent,
  });
  const previousPrivatePathRef = existing?.registry.privatePathRef;
  if (previousPrivatePathRef && previousPrivatePathRef !== privatePathRef) {
    try {
      const previousReference = runOwnedReference({
        ...input,
        path: privateArtifactPathRegistryFilename(previousPrivatePathRef),
        subject: "previous private artifact path registry",
      });
      await removeRunOwnedFile({
        ...previousReference,
        subject: "previous private artifact path registry",
      });
    } catch {
      // The new immutable pair is authoritative. Cleanup is best-effort and a
      // retained previous version is an orphan for retention to remove.
    }
  }
}

export async function readArtifactRegistryWithPrivatePaths(input: {
  runDirectory: string;
  boundaryRoot: string;
  runId: string;
}): Promise<ArtifactRegistry | undefined> {
  const snapshot = await readBoundArtifactRegistrySnapshot(input);
  if (!snapshot) return undefined;
  return {
    ...snapshot.registry,
    artifacts: restorePrivateArtifactPathsFromSnapshot({
      artifacts: snapshot.registry.artifacts,
      snapshot,
    }),
  };
}

export async function readReconciledArtifactRegistryWithPrivatePaths(input: {
  runDirectory: string;
  boundaryRoot: string;
  runId: string;
  readEventProjection: () => Promise<RunArtifact[]>;
}): Promise<RunArtifact[]> {
  const snapshot = await readBoundArtifactRegistrySnapshot(input);
  const eventProjection = await input.readEventProjection();
  if (!snapshot) {
    return reconcileArtifactSources({
      registry: [],
      eventProjection,
    });
  }
  const artifacts = reconcileArtifactSources({
    registry: snapshot.registry.artifacts,
    eventProjection,
  });
  return restorePrivateArtifactPathsFromSnapshot({
    artifacts,
    snapshot,
  });
}

export async function readArtifactRegistry(input: {
  runDirectory: string;
  boundaryRoot: string;
}): Promise<ArtifactRegistry | undefined> {
  return (await readArtifactRegistrySnapshot(input))?.registry;
}

export async function readMaterializedArtifact(input: {
  runDirectory: string;
  boundaryRoot: string;
  artifact: RunArtifact;
}): Promise<{
  relativePath: string;
  filename: string;
  content: Buffer;
}> {
  if (!input.artifact.path) {
    throw new Error(
      `artifact ${input.artifact.id} does not have a materialized path`,
    );
  }
  const reference = runOwnedReference({
    runDirectory: input.runDirectory,
    boundaryRoot: input.boundaryRoot,
    path: input.artifact.path,
    subject: `artifact ${input.artifact.id} path`,
  });
  const materialized = await readRunOwnedFile({
    ...reference,
    subject: `artifact ${input.artifact.id} path`,
    expectedSha256: input.artifact.sha256,
    expectedSize: input.artifact.size,
  });
  const logicalRunDirectory = resolve(input.runDirectory);
  const candidate = resolve(logicalRunDirectory, input.artifact.path);
  return {
    ...materialized,
    relativePath: relative(logicalRunDirectory, candidate).split(sep).join("/"),
  };
}
