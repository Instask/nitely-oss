import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { WebInputError, WebNotFoundError } from "../web/errors.js";
import type { FlowTemplateLineage } from "./templates.js";

const flowIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Where a stored Flow came from. `system` records are seeded from the Flow
 * documents shipped with Nitely or checked into the repository's `flows/`;
 * `user` records are authored in the store; `imported` is reserved for
 * explicit imports.
 */
export type FlowOrigin = "system" | "user" | "imported";

export type FlowSeedSource = "repository" | "bundled";

/** Seed lineage of a `system` record. */
export interface FlowSeedLineage {
  /** Stable seed identity, the `flows/<name>.json` path the document ships as. */
  key: string;
  /** Digest of the seed document this record was last seeded from. */
  hash: string;
  source: FlowSeedSource;
  /**
   * Digest of a newer seed that was not applied because the record was
   * customized after seeding.
   */
  availableHash?: string;
  /** When the seed stopped shipping; the record is kept, never deleted. */
  removedAt?: string;
}

export interface FlowRecord {
  id: string;
  name: string;
  workItemType?: string;
  document: string;
  ownerId?: string;
  template?: FlowTemplateLineage;
  organizationId?: string;
  origin: FlowOrigin;
  enabled: boolean;
  seed?: FlowSeedLineage;
  createdAt: string;
  updatedAt: string;
}

/** One shipped Flow document offered to {@link FlowStore.reconcileSeeds}. */
export interface FlowSeed {
  key: string;
  name: string;
  workItemType?: string;
  document: string;
  source: FlowSeedSource;
}

export interface FlowSeedReconciliation {
  inserted: string[];
  upgraded: string[];
  /** Customized records left alone although a newer seed exists. */
  preserved: string[];
  removed: string[];
  restored: string[];
  /** Existing records whose shipped version did not change (customized or not). */
  unchanged: string[];
}

export interface CreateFlowInput {
  name: string;
  document: string;
  workItemType?: string;
  ownerId?: string;
  template?: FlowTemplateLineage;
  organizationId?: string;
}

export interface UpdateFlowInput {
  name?: string;
  document?: string;
  workItemType?: string;
  enabled?: boolean;
}

export interface FlowStoreOptions {
  createId?: () => string;
  now?: () => Date;
}

export function validateFlowId(id: string): void {
  if (!flowIdPattern.test(id)) {
    throw new WebInputError("invalid flow id");
  }
}

interface FlowRow {
  id: string;
  name: string;
  work_item_type: string | null;
  document: string;
  owner_id: string | null;
  organization_id: string | null;
  template_id: string | null;
  template_version: string | null;
  template_source: string | null;
  template_source_flow_path: string | null;
  origin: string | null;
  enabled: number | null;
  seed_key: string | null;
  seed_hash: string | null;
  seed_source: string | null;
  seed_available_hash: string | null;
  seed_removed_at: string | null;
  created_at: string;
  updated_at: string;
}

export function flowDocumentHash(document: string): string {
  return `sha256:${createHash("sha256").update(document, "utf8").digest("hex")}`;
}

/**
 * A system record is customized once its document no longer matches the seed
 * it was last seeded from. Customized records are never overwritten by a
 * shipped update.
 */
export function flowRecordCustomized(record: Pick<FlowRecord, "document" | "seed">): boolean {
  return record.seed !== undefined && flowDocumentHash(record.document) !== record.seed.hash;
}

const seedSystemIdPattern = /[^A-Za-z0-9_-]+/g;

function systemFlowIdForSeed(key: string): string {
  const base = key.replace(/^flows\//, "").replace(/\.json$/, "");
  const slug = base.replace(seedSystemIdPattern, "-").replace(/^-+|-+$/g, "");
  const candidate = `system-${slug}`;
  if (slug && slug === base && flowIdPattern.test(candidate)) return candidate;
  // Keep ids stable and valid for names the id pattern cannot carry verbatim.
  const digest = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 12);
  return `system-${(slug || "flow").slice(0, 100)}-${digest}`;
}

function flowOrigin(value: string | null): FlowOrigin {
  return value === "system" || value === "imported" ? value : "user";
}

function flowSeedSource(value: string | null): FlowSeedSource {
  return value === "repository" ? "repository" : "bundled";
}

interface TableInfoRow {
  name: string;
}

function toRecord(row: FlowRow): FlowRecord {
  return {
    id: row.id,
    name: row.name,
    ...(row.work_item_type ? { workItemType: row.work_item_type } : {}),
    document: row.document,
    ...(row.owner_id ? { ownerId: row.owner_id } : {}),
    ...(row.organization_id ? { organizationId: row.organization_id } : {}),
    ...(row.template_id && row.template_version && row.template_source === "builtin"
      ? {
          template: {
            templateId: row.template_id,
            templateVersion: row.template_version,
            source: "builtin",
            ...(row.template_source_flow_path
              ? { sourceFlowPath: row.template_source_flow_path }
              : {}),
          },
        }
      : {}),
    origin: flowOrigin(row.origin),
    enabled: row.enabled !== 0,
    ...(row.seed_key && row.seed_hash
      ? {
          seed: {
            key: row.seed_key,
            hash: row.seed_hash,
            source: flowSeedSource(row.seed_source),
            ...(row.seed_available_hash ? { availableHash: row.seed_available_hash } : {}),
            ...(row.seed_removed_at ? { removedAt: row.seed_removed_at } : {}),
          },
        }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class FlowStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    if (path !== ":memory:") {
      this.#database.exec("PRAGMA journal_mode = WAL;");
    }
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS flows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        work_item_type TEXT,
        document TEXT NOT NULL,
        owner_id TEXT,
        organization_id TEXT,
        template_id TEXT,
        template_version TEXT,
        template_source TEXT,
        template_source_flow_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    this.#ensureColumns();
  }

  #ensureColumns(): void {
    const columns = this.#database
      .prepare("PRAGMA table_info(flows)")
      .all() as unknown as TableInfoRow[];
    const columnNames = new Set(columns.map((column) => column.name));
    for (const [name, definition] of [
      ["organization_id", "organization_id TEXT"],
      ["template_id", "template_id TEXT"],
      ["template_version", "template_version TEXT"],
      ["template_source", "template_source TEXT"],
      ["template_source_flow_path", "template_source_flow_path TEXT"],
      ["origin", "origin TEXT"],
      ["enabled", "enabled INTEGER NOT NULL DEFAULT 1"],
      ["seed_key", "seed_key TEXT"],
      ["seed_hash", "seed_hash TEXT"],
      ["seed_source", "seed_source TEXT"],
      ["seed_available_hash", "seed_available_hash TEXT"],
      ["seed_removed_at", "seed_removed_at TEXT"],
    ] as const) {
      if (!columnNames.has(name)) {
        this.#database.exec(`ALTER TABLE flows ADD COLUMN ${definition};`);
      }
    }
    // Every row written before origins existed was authored in the store.
    this.#database.exec("UPDATE flows SET origin = 'user' WHERE origin IS NULL;");
    this.#database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS flows_seed_key
      ON flows (seed_key) WHERE seed_key IS NOT NULL;
    `);
  }

  createFlow(input: CreateFlowInput, options: FlowStoreOptions = {}): FlowRecord {
    const name = input.name.trim();
    if (!name) {
      throw new WebInputError("flow name is required");
    }
    if (typeof input.document !== "string" || !input.document.trim()) {
      throw new WebInputError("flow document is required");
    }
    const id = options.createId?.() ?? `flow-${randomUUID()}`;
    validateFlowId(id);
    const createdAt = (options.now?.() ?? new Date()).toISOString();
    this.#database
      .prepare(`
        INSERT INTO flows (
          id,
          name,
          work_item_type,
          document,
          owner_id,
          organization_id,
          template_id,
          template_version,
          template_source,
          template_source_flow_path,
          origin,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?)
      `)
      .run(
        id,
        name,
        input.workItemType ?? null,
        input.document,
        input.ownerId ?? null,
        input.organizationId ?? null,
        input.template?.templateId ?? null,
        input.template?.templateVersion ?? null,
        input.template?.source ?? null,
        input.template?.sourceFlowPath ?? null,
        createdAt,
        createdAt,
      );
    return this.getFlow(id);
  }

  getFlow(id: string): FlowRecord {
    validateFlowId(id);
    const row = this.#database
      .prepare("SELECT * FROM flows WHERE id = ?")
      .get(id) as unknown as FlowRow | undefined;
    if (!row) {
      throw new WebNotFoundError("flow not found");
    }
    return toRecord(row);
  }

  /** Every stored Flow, system and user, newest first. */
  listFlows(): FlowRecord[] {
    const rows = this.#database
      .prepare("SELECT * FROM flows ORDER BY created_at DESC, id DESC")
      .all() as unknown as FlowRow[];
    return rows.map(toRecord);
  }

  /** The system record seeded from `key`, if it has ever been seeded. */
  findBySeedKey(key: string): FlowRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM flows WHERE seed_key = ?")
      .get(key) as unknown as FlowRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  /**
   * Bring system records in line with the shipped seeds.
   *
   * - A seed with no record is inserted as an enabled `system` record.
   * - A record still holding the document it was seeded from is upgraded to
   *   the new seed. Its enabled state is kept.
   * - A record whose document was changed after seeding is customized and is
   *   never overwritten; the newer seed's digest is recorded instead.
   * - A record whose seed no longer ships is marked removed but kept, so an
   *   operator's customization or disabled state is not lost. It is restored
   *   if the seed ships again.
   */
  #freeSystemFlowId(preferred: string): string {
    const taken = this.#database.prepare("SELECT 1 FROM flows WHERE id = ?");
    if (!taken.get(preferred)) return preferred;
    for (let n = 2; n < 1000; n += 1) {
      const suffix = `-${n}`;
      const candidate = `${preferred.slice(0, 128 - suffix.length)}${suffix}`;
      if (!taken.get(candidate)) return candidate;
    }
    throw new Error(`no free id for built-in flow ${preferred}`);
  }

  reconcileSeeds(seeds: FlowSeed[], options: FlowStoreOptions = {}): FlowSeedReconciliation {
    const result: FlowSeedReconciliation = {
      inserted: [],
      upgraded: [],
      preserved: [],
      removed: [],
      restored: [],
      unchanged: [],
    };
    const now = (options.now?.() ?? new Date()).toISOString();
    const keys = new Set(seeds.map((seed) => seed.key));
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      for (const seed of seeds) {
        const hash = flowDocumentHash(seed.document);
        const existing = this.findBySeedKey(seed.key);
        if (!existing) {
          // The id is only a handle; the seed is identified by seed_key. A
          // user Flow may already own the preferred id, so take the first free
          // id in a deterministic sequence and never touch that row. This runs
          // inside BEGIN IMMEDIATE, so the free id cannot be taken meanwhile,
          // and the INSERT has no conflict clause: any failure aborts the sync
          // instead of being silently skipped.
          const id = this.#freeSystemFlowId(systemFlowIdForSeed(seed.key));
          const inserted = this.#database
            .prepare(`
              INSERT INTO flows (
                id, name, work_item_type, document, origin, enabled,
                seed_key, seed_hash, seed_source, created_at, updated_at
              )
              VALUES (?, ?, ?, ?, 'system', 1, ?, ?, ?, ?, ?)
            `)
            .run(
              id,
              seed.name,
              seed.workItemType ?? null,
              seed.document,
              seed.key,
              hash,
              seed.source,
              now,
              now,
            );
          if (Number(inserted.changes) !== 1) {
            throw new Error(`failed to seed built-in flow ${seed.key}`);
          }
          result.inserted.push(seed.key);
          continue;
        }
        const lineage = existing.seed!;
        if (lineage.removedAt) {
          this.#database
            .prepare("UPDATE flows SET seed_removed_at = NULL WHERE id = ?")
            .run(existing.id);
          result.restored.push(seed.key);
        }
        if (lineage.hash === hash) {
          if (lineage.availableHash || lineage.source !== seed.source) {
            this.#database
              .prepare("UPDATE flows SET seed_available_hash = NULL, seed_source = ? WHERE id = ?")
              .run(seed.source, existing.id);
          }
          result.unchanged.push(seed.key);
          continue;
        }
        if (flowRecordCustomized(existing)) {
          if (lineage.availableHash !== hash) {
            this.#database
              .prepare("UPDATE flows SET seed_available_hash = ? WHERE id = ?")
              .run(hash, existing.id);
          }
          result.preserved.push(seed.key);
          continue;
        }
        this.#database
          .prepare(`
            UPDATE flows
            SET name = ?, work_item_type = ?, document = ?, seed_hash = ?,
                seed_source = ?, seed_available_hash = NULL, updated_at = ?
            WHERE id = ?
          `)
          .run(
            seed.name,
            seed.workItemType ?? null,
            seed.document,
            hash,
            seed.source,
            now,
            existing.id,
          );
        result.upgraded.push(seed.key);
      }
      const seeded = this.#database
        .prepare("SELECT id, seed_key FROM flows WHERE seed_key IS NOT NULL AND seed_removed_at IS NULL")
        .all() as unknown as Array<{ id: string; seed_key: string }>;
      for (const row of seeded) {
        if (keys.has(row.seed_key)) continue;
        this.#database
          .prepare("UPDATE flows SET seed_removed_at = ? WHERE id = ?")
          .run(now, row.id);
        result.removed.push(row.seed_key);
      }
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
    return result;
  }

  updateFlow(
    id: string,
    input: UpdateFlowInput,
    options: FlowStoreOptions = {},
  ): FlowRecord {
    const existing = this.getFlow(id);
    const name = input.name !== undefined ? input.name.trim() : existing.name;
    if (!name) {
      throw new WebInputError("flow name is required");
    }
    const document = input.document ?? existing.document;
    const workItemType =
      input.workItemType !== undefined
        ? input.workItemType
        : existing.workItemType;
    const enabled = input.enabled ?? existing.enabled;
    const updatedAt = (options.now?.() ?? new Date()).toISOString();
    this.#database
      .prepare(`
        UPDATE flows SET name = ?, work_item_type = ?, document = ?, enabled = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(name, workItemType ?? null, document, enabled ? 1 : 0, updatedAt, id);
    return this.getFlow(id);
  }

  /**
   * Replace a system record's document with the shipped seed, discarding
   * customizations and adopting that seed's version as the record's lineage.
   * The enabled flag is kept.
   */
  resetToSeed(id: string, seed: FlowSeed, options: FlowStoreOptions = {}): FlowRecord {
    const existing = this.getFlow(id);
    if (existing.origin !== "system" || existing.seed?.key !== seed.key) {
      throw new WebInputError("only a built-in flow can be reset to its shipped version");
    }
    const updatedAt = (options.now?.() ?? new Date()).toISOString();
    const result = this.#database
      .prepare(`
        UPDATE flows
        SET name = ?, work_item_type = ?, document = ?, seed_hash = ?, seed_source = ?,
            seed_available_hash = NULL, seed_removed_at = NULL, updated_at = ?
        WHERE id = ?
      `)
      .run(
        seed.name,
        seed.workItemType ?? null,
        seed.document,
        flowDocumentHash(seed.document),
        seed.source,
        updatedAt,
        id,
      );
    if (Number(result.changes) !== 1) {
      throw new WebNotFoundError("flow not found");
    }
    return this.getFlow(id);
  }

  deleteFlow(id: string): void {
    validateFlowId(id);
    if (this.getFlow(id).origin === "system") {
      // Deleting a seeded record would only re-seed it; disable it instead.
      throw new WebInputError("system flows cannot be deleted; disable them instead");
    }
    const result = this.#database
      .prepare("DELETE FROM flows WHERE id = ?")
      .run(id);
    if (result.changes === 0) {
      throw new WebNotFoundError("flow not found");
    }
  }

  close(): void {
    this.#database.close();
  }
}

export function flowStorePath(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "flows.db");
}

export function openFlowStore(repoPath: string): FlowStore {
  const directory = join(resolve(repoPath), ".nitely");
  mkdirSync(directory, { recursive: true });
  return new FlowStore(flowStorePath(repoPath));
}
