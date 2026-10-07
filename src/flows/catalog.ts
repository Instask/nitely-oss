import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import {
  BuiltinFlowPathError,
  bundledFlowsRoot,
  resolveBuiltinFlowPath,
  resolveRepositoryFlowPath,
} from "./paths.js";
import {
  flowRecordCustomized,
  openFlowStore,
  type FlowRecord,
  type FlowSeed,
  type FlowSeedReconciliation,
  type FlowStore,
} from "./store.js";
import { validateFlowDocument, type FlowValidationReport } from "./validate.js";
import { DEFAULT_WORK_ITEM_TYPE } from "../flow/schema.js";
import { WebInputError, WebNotFoundError } from "../web/errors.js";

/**
 * The Flow catalog: every runtime Flow lookup resolves through the Flow store.
 *
 * Flow documents shipped with this installation and checked into the
 * repository's `flows/` are seed material. Each lookup first reconciles them
 * into `system` records (see {@link FlowStore.reconcileSeeds}), then reads the
 * stored document, so a customized system Flow is what runs and a disabled
 * Flow does not run at all.
 *
 * System Flows keep their `flows/<name>.json` seed key as their public id, so
 * existing work items, runs, and links that name a built-in Flow by path keep
 * resolving.
 */

const seedKeyPattern = /^flows\/[^/\\]+\.json$/;

export class CatalogFlowNotFoundError extends WebNotFoundError {
  constructor(readonly reference: string) {
    super("flow not found");
    this.name = "CatalogFlowNotFoundError";
  }
}

export class CatalogFlowDisabledError extends Error {
  constructor(readonly reference: string) {
    super(`flow is disabled: ${reference}. Enable it in the Flow catalog before starting work from it.`);
    this.name = "CatalogFlowDisabledError";
  }
}

/** Whether `reference` names a seeded Flow by its `flows/<name>.json` key. */
export function isFlowSeedKey(reference: string): boolean {
  return seedKeyPattern.test(reference) && !reference.includes("..");
}

async function flowEntries(root: string): Promise<string[]> {
  try {
    return await readdir(join(resolve(root), "flows"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Metadata the store keeps beside a Flow document, derived from it. */
export interface FlowStoredMetadata {
  name: string;
  /** `null` when the document declares none, so a replacement clears it. */
  workItemType: string | null;
}

/**
 * The one derivation of stored Flow metadata from a Flow document. The
 * document is the canonical source: every write that replaces a document
 * stores exactly this, so a value removed from the document is removed from
 * the record too.
 */
export function flowStoredMetadata(document: string, fallbackName: string): FlowStoredMetadata {
  let metadata: { name?: unknown; workItemType?: unknown } | undefined;
  try {
    metadata = (JSON.parse(document) as { metadata?: typeof metadata }).metadata;
  } catch {
    metadata = undefined;
  }
  return {
    name: typeof metadata?.name === "string" && metadata.name.trim() ? metadata.name : fallbackName,
    workItemType:
      typeof metadata?.workItemType === "string" && metadata.workItemType.trim()
        ? metadata.workItemType
        : null,
  };
}

function seedMetadata(document: string, key: string): { name: string; workItemType?: string } {
  const meta = flowStoredMetadata(document, key);
  return { name: meta.name, ...(meta.workItemType ? { workItemType: meta.workItemType } : {}) };
}

/**
 * Validate a Flow document against `repoPath` and derive what the store keeps
 * for it. Throws {@link CatalogFlowInvalidError} with the validator's report.
 */
export async function prepareCatalogFlowDocument(
  repoPath: string,
  document: string,
  fallbackName: string,
): Promise<{ document: string } & FlowStoredMetadata> {
  const report = await validateFlowDocument(repoPath, document);
  if (!report.valid) throw new CatalogFlowInvalidError(report);
  return { document, ...flowStoredMetadata(document, fallbackName) };
}

/**
 * Read the seed set: top-level `flows/*.json` in the repository and in this
 * installation, the repository's copy winning, with the same traversal and
 * symlink checks as the path resolvers.
 */
export async function readFlowSeeds(
  repoPath: string,
  bundledRoot: string = bundledFlowsRoot(),
): Promise<FlowSeed[]> {
  const repositoryRoot = resolve(repoPath);
  const entries = [
    ...new Set([...(await flowEntries(repositoryRoot)), ...(await flowEntries(bundledRoot))]),
  ]
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  const seeds = await Promise.all(
    entries.map(async (entry): Promise<FlowSeed | undefined> => {
      const key = `flows/${entry}`;
      let resolved;
      try {
        resolved = await resolveBuiltinFlowPath(repositoryRoot, key, bundledRoot);
      } catch (error) {
        // An entry that escapes the flows directory (a traversal or symlink
        // the path resolver rejects) is not a seed, as it was never a listed
        // built-in Flow before the catalog.
        if (error instanceof BuiltinFlowPathError) return undefined;
        throw error;
      }
      let document: string;
      try {
        document = await readFile(resolved.absolutePath, "utf8");
      } catch (error) {
        // The file vanished between listing and reading: it is not shipped.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        // Any other failure (permissions, I/O) must fail the sync instead of
        // looking like a removed seed and retiring an untouched built-in Flow.
        throw error;
      }
      const source = resolved.absolutePath === resolve(repositoryRoot, key) ? "repository" : "bundled";
      return { key, document, source, ...seedMetadata(document, key) };
    }),
  );
  return seeds.filter((seed): seed is FlowSeed => seed !== undefined);
}

export interface FlowCatalogOptions {
  bundledRoot?: string;
  now?: () => Date;
}

/** Reconcile the shipped seeds into `store`. */
export async function syncSystemFlows(
  store: FlowStore,
  repoPath: string,
  options: FlowCatalogOptions = {},
): Promise<FlowSeedReconciliation> {
  const seeds = await readFlowSeeds(repoPath, options.bundledRoot);
  return store.reconcileSeeds(seeds, options.now ? { now: options.now } : {});
}

/**
 * A system record whose seed stopped shipping and that the operator never
 * customized has nothing left to offer; it leaves the catalog the way the file
 * used to. Customized records stay as the operator's fork.
 */
function retiredSeedRecord(record: FlowRecord): boolean {
  return Boolean(record.seed?.removedAt) && !flowRecordCustomized(record);
}

/** The public id of a catalog record: the seed key for system Flows. */
export function catalogFlowId(record: FlowRecord): string {
  return record.origin === "system" && record.seed ? record.seed.key : record.id;
}

/** Every Flow in the catalog, seeded first. Callers apply access rules. */
export async function listCatalogFlows(
  repoPath: string,
  options: FlowCatalogOptions = {},
): Promise<FlowRecord[]> {
  const store = openFlowStore(repoPath);
  try {
    await syncSystemFlows(store, repoPath, options);
    return store.listFlows().filter((record) => !retiredSeedRecord(record));
  } finally {
    store.close();
  }
}

export interface ResolvedCatalogFlow {
  record: FlowRecord;
  document: string;
  /** Public catalog id: the seed key for system Flows, the store id otherwise. */
  id: string;
}

export interface ResolveCatalogFlowOptions extends FlowCatalogOptions {
  /** Reject a disabled Flow. Defaults to true; reads for display pass false. */
  requireEnabled?: boolean;
}

/**
 * Resolve a Flow by catalog reference: a `flows/<name>.json` seed key or a
 * store id. Throws {@link CatalogFlowNotFoundError} or
 * {@link CatalogFlowDisabledError}.
 */
export async function resolveCatalogFlow(
  repoPath: string,
  reference: string,
  options: ResolveCatalogFlowOptions = {},
): Promise<ResolvedCatalogFlow> {
  const store = openFlowStore(repoPath);
  let record: FlowRecord | undefined;
  try {
    if (isFlowSeedKey(reference)) {
      await syncSystemFlows(store, repoPath, options);
      record = store.findBySeedKey(reference);
    } else {
      try {
        record = store.getFlow(reference);
      } catch {
        record = undefined;
      }
    }
  } finally {
    store.close();
  }
  if (!record || retiredSeedRecord(record)) {
    throw new CatalogFlowNotFoundError(reference);
  }
  if ((options.requireEnabled ?? true) && !record.enabled) {
    throw new CatalogFlowDisabledError(reference);
  }
  return { record, document: record.document, id: catalogFlowId(record) };
}

/**
 * A run's flow label for a catalog Flow. System Flows keep the label runs had
 * before the catalog existed, the resolved seed file path, so run listings and
 * rework links that match on it keep working; the executed document is still
 * the stored one, snapshotted with its digest by the run.
 */
export async function catalogFlowRunLabel(
  repoPath: string,
  resolved: ResolvedCatalogFlow,
): Promise<string> {
  if (resolved.record.origin !== "system" || !resolved.record.seed) {
    return resolved.record.id;
  }
  try {
    return (await resolveRepositoryFlowPath(repoPath, resolved.record.seed.key)).absolutePath;
  } catch {
    return resolved.record.seed.key;
  }
}

/** A catalog entry as shown by the CLI and other management surfaces. */
export interface CatalogFlowSummary {
  /** Public id: `flows/<name>.json` for built-in Flows, the store id otherwise. */
  id: string;
  storeId: string;
  name: string;
  origin: FlowRecord["origin"];
  enabled: boolean;
  seedKey?: string;
  /** A built-in Flow whose document differs from the shipped version it came from. */
  edited: boolean;
  /** A newer shipped version exists and was not applied because of the edits. */
  newerShippedVersion: boolean;
  /** The shipped file is gone; the edited record is kept. */
  shippedVersionRemoved: boolean;
  /** The work item type new work gets: the document's, else the runtime default. */
  workItemType: string;
  updatedAt: string;
}

export function catalogFlowSummary(record: FlowRecord): CatalogFlowSummary {
  return {
    id: catalogFlowId(record),
    storeId: record.id,
    name: record.name,
    origin: record.origin,
    enabled: record.enabled,
    ...(record.seed ? { seedKey: record.seed.key } : {}),
    edited: record.origin === "system" && flowRecordCustomized(record),
    newerShippedVersion: Boolean(record.seed?.availableHash),
    shippedVersionRemoved: Boolean(record.seed?.removedAt),
    workItemType: record.workItemType ?? DEFAULT_WORK_ITEM_TYPE,
    updatedAt: record.updatedAt,
  };
}

/** Thrown when a Flow document fails validation; carries the report. */
export class CatalogFlowInvalidError extends Error {
  constructor(readonly report: FlowValidationReport) {
    super(`invalid flow document: ${report.errors.join("; ") || "unknown error"}`);
    this.name = "CatalogFlowInvalidError";
  }
}

function withStore<T>(repoPath: string, action: (store: FlowStore) => T): T {
  const store = openFlowStore(repoPath);
  try {
    return action(store);
  } finally {
    store.close();
  }
}

/** Enable or disable a catalog Flow. */
export async function setCatalogFlowEnabled(
  repoPath: string,
  reference: string,
  enabled: boolean,
  options: FlowCatalogOptions = {},
): Promise<FlowRecord> {
  const { record } = await resolveCatalogFlow(repoPath, reference, {
    ...options,
    requireEnabled: false,
  });
  return withStore(repoPath, (store) => store.updateFlow(record.id, { enabled }));
}

/**
 * Replace a catalog Flow's document after validating it with the same
 * validator the Web Console uses. Editing a built-in Flow marks it edited, so
 * later shipped versions no longer overwrite it.
 */
export async function updateCatalogFlowDocument(
  repoPath: string,
  reference: string,
  document: string,
  options: FlowCatalogOptions = {},
): Promise<FlowRecord> {
  const { record } = await resolveCatalogFlow(repoPath, reference, {
    ...options,
    requireEnabled: false,
  });
  return await replaceCatalogFlowDocument(repoPath, record, document);
}

/**
 * Replace `record`'s document in `repoPath`'s store: validate it there, then
 * write the document together with the metadata derived from it (clearing
 * metadata the new document no longer declares). The enabled flag and
 * ownership are untouched. Shared by `nitely flow update` and the Web API.
 */
export async function replaceCatalogFlowDocument(
  repoPath: string,
  record: FlowRecord,
  document: string,
): Promise<FlowRecord> {
  const prepared = await prepareCatalogFlowDocument(repoPath, document, record.name);
  return withStore(repoPath, (store) =>
    store.updateFlow(record.id, {
      name: prepared.name,
      document: prepared.document,
      workItemType: prepared.workItemType,
    }),
  );
}

/**
 * Replace a built-in Flow with the version shipped now. This both discards
 * local edits and accepts a newer shipped version: they are the same write.
 */
export async function resetCatalogFlow(
  repoPath: string,
  reference: string,
  options: FlowCatalogOptions = {},
): Promise<FlowRecord> {
  const { record } = await resolveCatalogFlow(repoPath, reference, {
    ...options,
    requireEnabled: false,
  });
  if (record.origin !== "system" || !record.seed) {
    throw new WebInputError("only built-in flows have a shipped version to reset to");
  }
  const seedKey = record.seed.key;
  const seed = (await readFlowSeeds(repoPath, options.bundledRoot)).find(
    (candidate) => candidate.key === seedKey,
  );
  if (!seed) {
    throw new WebInputError(`no shipped version of ${seedKey} is available`);
  }
  return withStore(repoPath, (store) =>
    store.resetToSeed(record.id, seed, options.now ? { now: options.now } : {}),
  );
}

/** Delete a user Flow. Built-in Flows cannot be deleted, only disabled. */
export async function deleteCatalogFlow(
  repoPath: string,
  reference: string,
  options: FlowCatalogOptions = {},
): Promise<FlowRecord> {
  const { record } = await resolveCatalogFlow(repoPath, reference, {
    ...options,
    requireEnabled: false,
  });
  if (record.origin === "system") {
    throw new WebInputError("built-in flows cannot be deleted; disable them instead");
  }
  withStore(repoPath, (store) => store.deleteFlow(record.id));
  return record;
}

/** The Flow a run executes, resolved from a CLI or runtime Flow reference. */
export interface RunFlowSource {
  /** The run's flow label (`RunFlowInput.flowPath`). */
  flowPath: string;
  /** The exact document the run executes and snapshots. */
  flowDocument: string;
  /** Catalog id when the reference named a catalog Flow. */
  catalogId?: string;
}

/**
 * The catalog seed key a Flow file reference names, if any. A reference is a
 * catalog Flow when it is `flows/<name>.json` relative to the repository, or
 * an absolute/cwd-relative path to the repository's or this installation's
 * `flows/<name>.json`. Anything else is an explicit Flow file.
 */
export function catalogSeedKeyForFlowReference(
  repoPath: string,
  reference: string,
  options: { cwd?: string; bundledRoot?: string } = {},
): string | undefined {
  if (isFlowSeedKey(reference)) return reference;
  const absolute = resolve(options.cwd ?? process.cwd(), reference);
  for (const root of [repoPath, options.bundledRoot ?? bundledFlowsRoot()]) {
    const fromRoot = relative(resolve(root), absolute).replaceAll("\\", "/");
    if (isFlowSeedKey(fromRoot)) return fromRoot;
  }
  return undefined;
}

/**
 * Resolve the Flow a CLI/runtime entry point runs against `repoPath`. Catalog
 * references read the stored document (edited built-ins honored, disabled
 * Flows refused); explicit non-catalog files are read as given. The label
 * stays the caller's reference so run labels are unchanged.
 */
export async function resolveRunFlowSource(
  repoPath: string,
  reference: string,
  options: FlowCatalogOptions & { cwd?: string } = {},
): Promise<RunFlowSource> {
  const seedKey = catalogSeedKeyForFlowReference(repoPath, reference, options);
  if (seedKey) {
    const resolved = await resolveCatalogFlow(repoPath, seedKey, options);
    return { flowPath: reference, flowDocument: resolved.document, catalogId: resolved.id };
  }
  return {
    flowPath: reference,
    flowDocument: await readFile(resolve(options.cwd ?? process.cwd(), reference), "utf8"),
  };
}
