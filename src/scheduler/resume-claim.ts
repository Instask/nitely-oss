import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";

export interface StoredResumeClaim {
  runId: string;
  token: string;
  acquiredAt: string;
}

interface ResumeClaimRow {
  run_id: string;
  token: string;
  acquired_at: string;
}

function toStoredResumeClaim(row: ResumeClaimRow): StoredResumeClaim {
  return {
    runId: row.run_id,
    token: row.token,
    acquiredAt: row.acquired_at,
  };
}

export function resumeClaimStorePath(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "scheduler-resume-claims.db");
}

/**
 * Durable, non-expiring ownership for continuation dispatch. Resume execution
 * can write events, mutate a worktree, and publish changes before returning,
 * so elapsed wall time cannot safely fence a still-running owner. A crashed
 * owner's claim therefore remains fail-closed until an operator has confirmed
 * that the process is gone and explicitly releases it.
 */
export class ResumeClaimStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") {
      this.#database.exec("PRAGMA journal_mode = WAL;");
    }
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_resume_claims (
        run_id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        acquired_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  claim(input: { runId: string; token: string; now: Date }): boolean {
    const result = this.#database
      .prepare(`
        INSERT INTO scheduler_resume_claims (run_id, token, acquired_at)
        VALUES (?, ?, ?)
        ON CONFLICT(run_id) DO NOTHING
      `)
      .run(input.runId, input.token, input.now.toISOString());
    return Number(result.changes) === 1;
  }

  release(runId: string, token: string): boolean {
    const result = this.#database
      .prepare(
        "DELETE FROM scheduler_resume_claims WHERE run_id = ? AND token = ?",
      )
      .run(runId, token);
    return Number(result.changes) === 1;
  }

  get(runId: string): StoredResumeClaim | undefined {
    const row = this.#database
      .prepare("SELECT * FROM scheduler_resume_claims WHERE run_id = ?")
      .get(runId) as unknown as ResumeClaimRow | undefined;
    return row ? toStoredResumeClaim(row) : undefined;
  }

  close(): void {
    this.#database.close();
  }
}
