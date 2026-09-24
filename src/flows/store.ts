import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { WebInputError, WebNotFoundError } from "../web/errors.js";
import type { FlowTemplateLineage } from "./templates.js";

const flowIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface FlowRecord {
  id: string;
  name: string;
  workItemType?: string;
  document: string;
  ownerId?: string;
  template?: FlowTemplateLineage;
  organizationId?: string;
  createdAt: string;
  updatedAt: string;
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
  created_at: string;
  updated_at: string;
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
    ] as const) {
      if (!columnNames.has(name)) {
        this.#database.exec(`ALTER TABLE flows ADD COLUMN ${definition};`);
      }
    }
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
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  listFlows(): FlowRecord[] {
    const rows = this.#database
      .prepare("SELECT * FROM flows ORDER BY created_at DESC, id DESC")
      .all() as unknown as FlowRow[];
    return rows.map(toRecord);
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
    const updatedAt = (options.now?.() ?? new Date()).toISOString();
    this.#database
      .prepare(`
        UPDATE flows SET name = ?, work_item_type = ?, document = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(name, workItemType ?? null, document, updatedAt, id);
    return this.getFlow(id);
  }

  deleteFlow(id: string): void {
    validateFlowId(id);
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
