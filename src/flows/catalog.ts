import { WebNotFoundError } from "../web/errors.js";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
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

function seedMetadata(document: string, key: string): { name: string; workItemType?: string } {
  try {
    const parsed = JSON.parse(document) as {
      metadata?: { name?: unknown; workItemType?: unknown };
    };
    return {
      name: typeof parsed.metadata?.name === "string" && parsed.metadata.name.trim()
        ? parsed.metadata.name
        : key,
      ...(typeof parsed.metadata?.workItemType === "string"
        ? { workItemType: parsed.metadata.workItemType }
        : {}),
    };
  } catch {
    return { name: key };
  }
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
      try {
        const resolved = await resolveBuiltinFlowPath(repositoryRoot, key, bundledRoot);
        const document = await readFile(resolved.absolutePath, "utf8");
        const source = resolved.absolutePath === resolve(repositoryRoot, key) ? "repository" : "bundled";
        return { key, document, source, ...seedMetadata(document, key) };
      } catch {
        // An unreadable or escaping entry is not a seed, as it was never a
        // listed built-in Flow before the catalog.
        return undefined;
      }
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
