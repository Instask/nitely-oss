import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";

import {
  MAX_CI_REPAIR_REMOTE_OBSERVATIONS,
  type CiRepairCycleResult,
  type RedactedCiFailureObservation,
} from "../ci-repair.js";
import type { CiRepairEvidenceRecord } from "../evidence/catalog.js";

export interface StoredCiRepairEvidence extends CiRepairEvidenceRecord {
  state: "running" | "completed";
  result?: CiRepairCycleResult;
}

interface Row {
  idempotency_key: string;
  payload_json: string;
}

export function ciRepairStorePath(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "ci-repair.db");
}

export function ciRepairEventStorePath(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "ci-repair-events.db");
}

export function initialCiRepairEvidence(input: {
  idempotencyKey: string;
  sourceIdentity: string;
  observation: RedactedCiFailureObservation;
  now?: string;
}): StoredCiRepairEvidence {
  return {
    schemaVersion: "nitely.ci-repair-evidence.v1",
    idempotencyKey: input.idempotencyKey,
    sourceIdentity: input.sourceIdentity,
    provider: input.observation.provider,
    repository: input.observation.repository,
    pullRequest: input.observation.pullRequest,
    ...(input.observation.checkSuiteId ? { checkSuiteId: input.observation.checkSuiteId } : {}),
    ...(input.observation.workflowRunId ? { workflowRunId: input.observation.workflowRunId } : {}),
    checkRunId: input.observation.checkRunId,
    checkName: input.observation.checkName,
    headSha: input.observation.headSha,
    failureOutput: input.observation.failureOutput,
    outputTruncated: input.observation.outputTruncated,
    remoteObservationCount: 0,
    remoteObservationBudget: {
      used: 0,
      remaining: MAX_CI_REPAIR_REMOTE_OBSERVATIONS,
    },
    remoteObservations: [],
    terminal: false,
    updatedAt: input.now ?? new Date().toISOString(),
    state: "running",
  };
}

export class CiRepairStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA busy_timeout = 5000;");
    this.#database.exec("PRAGMA journal_mode = WAL;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS ci_repairs (
        idempotency_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL
      ) STRICT;
    `);
  }

  claim(evidence: StoredCiRepairEvidence): { evidence: StoredCiRepairEvidence; inserted: boolean } {
    const result = this.#database.prepare(
      "INSERT OR IGNORE INTO ci_repairs (idempotency_key, payload_json) VALUES (?, ?)",
    ).run(evidence.idempotencyKey, JSON.stringify(evidence));
    const stored = this.get(evidence.idempotencyKey);
    if (!stored) throw new Error("could not claim CI repair submission");
    return { evidence: stored, inserted: Number(result.changes) === 1 };
  }

  save(evidence: StoredCiRepairEvidence): void {
    this.#database.prepare(`
      INSERT INTO ci_repairs (idempotency_key, payload_json) VALUES (?, ?)
      ON CONFLICT(idempotency_key) DO UPDATE SET payload_json = excluded.payload_json
    `).run(evidence.idempotencyKey, JSON.stringify(evidence));
  }

  get(idempotencyKey: string): StoredCiRepairEvidence | undefined {
    const row = this.#database.prepare(
      "SELECT idempotency_key, payload_json FROM ci_repairs WHERE idempotency_key = ?",
    ).get(idempotencyKey) as unknown as Row | undefined;
    return row ? JSON.parse(row.payload_json) as StoredCiRepairEvidence : undefined;
  }

  list(): StoredCiRepairEvidence[] {
    const rows = this.#database.prepare(
      "SELECT idempotency_key, payload_json FROM ci_repairs ORDER BY idempotency_key",
    ).all() as unknown as Row[];
    return rows.map((row) => JSON.parse(row.payload_json) as StoredCiRepairEvidence);
  }

  close(): void {
    this.#database.close();
  }
}
