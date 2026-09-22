import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";

export interface SchedulerLeaseInput {
  taskId: string;
  owner: string;
  flowKey: string;
  resourceKeys: readonly string[];
  repositoryLimit: number;
  flowLimit: number;
  now: Date;
  ttlMs: number;
}

export interface SchedulerLease {
  taskId: string;
  owner: string;
  expiresAt: string;
}

interface LeaseRow {
  task_id: string;
  flow_key: string;
  resource_keys: string;
}

export function schedulerLeaseStorePath(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "scheduler-leases.db");
}

/**
 * Durable scheduler ownership. Resource matching is a bounded scan of active
 * rows; add indexed scopes only if measured scheduler throughput needs it.
 */
export class SchedulerLeaseStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") this.#database.exec("PRAGMA journal_mode = WAL;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_leases (
        task_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        flow_key TEXT NOT NULL,
        resource_keys TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  acquire(input: SchedulerLeaseInput): SchedulerLease | undefined {
    const expiresAt = new Date(input.now.getTime() + input.ttlMs);
    const resourceKeys = [...new Set(input.resourceKeys.filter(Boolean))].sort();
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#database
        .prepare("DELETE FROM scheduler_leases WHERE expires_at <= ?")
        .run(input.now.toISOString());
      const active = this.#database
        .prepare("SELECT task_id, flow_key, resource_keys FROM scheduler_leases")
        .all() as unknown as LeaseRow[];
      // A live lease on this task belongs to another scheduler: decline, the
      // same answer a limit or resource conflict gives. Inserting over it would
      // break the primary key and take the caller down with it.
      if (active.some((row) => row.task_id === input.taskId)) {
        this.#database.exec("ROLLBACK;");
        return undefined;
      }
      const conflicts = active.some((row) => {
        let keys: unknown;
        try {
          keys = JSON.parse(row.resource_keys);
        } catch {
          keys = [];
        }
        return Array.isArray(keys) && keys.some((key) => resourceKeys.includes(String(key)));
      });
      if (
        active.length >= input.repositoryLimit ||
        active.filter((row) => row.flow_key === input.flowKey).length >= input.flowLimit ||
        conflicts
      ) {
        this.#database.exec("ROLLBACK;");
        return undefined;
      }
      this.#database.prepare(`
        INSERT INTO scheduler_leases
          (task_id, owner, flow_key, resource_keys, acquired_at, heartbeat_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.taskId,
        input.owner,
        input.flowKey,
        JSON.stringify(resourceKeys),
        input.now.toISOString(),
        input.now.toISOString(),
        expiresAt.toISOString(),
      );
      this.#database.exec("COMMIT;");
      return { taskId: input.taskId, owner: input.owner, expiresAt: expiresAt.toISOString() };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  heartbeat(input: { taskId: string; owner: string; now: Date; ttlMs: number }): boolean {
    const expiresAt = new Date(input.now.getTime() + input.ttlMs).toISOString();
    const result = this.#database.prepare(`
      UPDATE scheduler_leases
      SET heartbeat_at = ?, expires_at = ?
      WHERE task_id = ? AND owner = ?
    `).run(input.now.toISOString(), expiresAt, input.taskId, input.owner);
    return Number(result.changes) === 1;
  }

  release(input: { taskId: string; owner: string }): boolean {
    const result = this.#database
      .prepare("DELETE FROM scheduler_leases WHERE task_id = ? AND owner = ?")
      .run(input.taskId, input.owner);
    return Number(result.changes) === 1;
  }

  close(): void {
    this.#database.close();
  }
}
