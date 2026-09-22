import { DatabaseSync } from "node:sqlite";

import type {
  NewRunEvent,
  RunEventType,
  StoredRunEvent,
} from "./types.js";

interface EventRow {
  sequence: number;
  run_id: string;
  stage_id: string | null;
  attempt: number | null;
  type: string;
  payload_json: string;
  created_at: string;
}

export type SynchronousTransactionOperation<T> = (() => T) & (
  [T] extends [never]
    ? unknown
    : [Extract<T, PromiseLike<unknown>>] extends [never]
      ? unknown
      : never
);

function toStoredEvent(row: EventRow): StoredRunEvent {
  return {
    sequence: Number(row.sequence),
    runId: row.run_id,
    stageId: row.stage_id ?? undefined,
    attempt: row.attempt ?? undefined,
    type: row.type as RunEventType,
    payload: JSON.parse(row.payload_json) as unknown,
    createdAt: row.created_at,
  };
}

export class EventStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    if (path !== ":memory:") {
      this.#database.exec("PRAGMA journal_mode = WAL;");
    }
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        stage_id TEXT,
        attempt INTEGER,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_run_sequence
        ON events(run_id, sequence);
    `);
  }

  append(event: NewRunEvent): StoredRunEvent {
    const createdAt = event.createdAt ?? new Date().toISOString();
    const result = this.#database
      .prepare(`
        INSERT INTO events (
          run_id,
          stage_id,
          attempt,
          type,
          payload_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.runId,
        event.stageId ?? null,
        event.attempt ?? null,
        event.type,
        JSON.stringify(event.payload),
        createdAt,
      );
    const sequence = Number(result.lastInsertRowid);
    const row = this.#database
      .prepare("SELECT * FROM events WHERE sequence = ?")
      .get(sequence) as unknown as EventRow;
    return toStoredEvent(row);
  }

  transaction<T>(
    operation: SynchronousTransactionOperation<T>,
  ): T {
    if (Object.prototype.toString.call(operation) === "[object AsyncFunction]") {
      throw new Error("EventStore transaction callback must be synchronous");
    }
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      if (
        ((typeof result === "object" && result !== null) ||
          typeof result === "function") &&
        typeof (result as unknown as PromiseLike<unknown>).then === "function"
      ) {
        void Promise.resolve(result as unknown as PromiseLike<unknown>).catch(
          () => undefined,
        );
        throw new Error("EventStore transaction callback must be synchronous");
      }
      this.#database.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK;");
      } catch {
        // Preserve the operation failure; rollback is best-effort if SQLite
        // has already ended the transaction.
      }
      throw error;
    }
  }

  list(runId: string): StoredRunEvent[] {
    const rows = this.#database
      .prepare("SELECT * FROM events WHERE run_id = ? ORDER BY sequence")
      .all(runId) as unknown as EventRow[];
    return rows.map(toStoredEvent);
  }

  latest(runId: string): StoredRunEvent | undefined {
    const row = this.#database
      .prepare(
        "SELECT * FROM events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1",
      )
      .get(runId) as unknown as EventRow | undefined;
    return row ? toStoredEvent(row) : undefined;
  }

  listRunIds(): string[] {
    const rows = this.#database
      .prepare(`
        SELECT run_id
        FROM events
        GROUP BY run_id
        ORDER BY MAX(sequence) DESC
      `)
      .all() as unknown as Array<{ run_id: string }>;
    return rows.map((row) => row.run_id);
  }

  deleteRun(runId: string): number {
    const result = this.#database
      .prepare("DELETE FROM events WHERE run_id = ?")
      .run(runId);
    return Number(result.changes);
  }

  close(): void {
    this.#database.close();
  }
}
