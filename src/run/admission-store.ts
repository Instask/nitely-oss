import { DatabaseSync } from "node:sqlite";

import type {
  WorkItemCandidateVersion,
  WorkItemStoreKind,
} from "../work-items/types.js";
import type {
  TaskPlanningBaseline,
  TaskSourceDriftOverride,
  TaskSpecReadinessOverride,
} from "../web/tasks.js";
import type { RunFlowInput } from "./run-flow.js";

export type StoredRunAdmissionState = "active" | "settled" | "rejected";

export interface StoredRunAdmission {
  runId: string;
  workItemId: string;
  candidateFingerprint: string;
  candidateVersion: WorkItemCandidateVersion;
  state: StoredRunAdmissionState;
  admittedAt: string;
  initializationToken?: string;
  projectedAt?: string;
  settledAt?: string;
  settlementToken?: string;
  settlementStartedAt?: string;
  settlementStatus?: "completed" | "failed";
  settlementChangeRequestUrl?: string;
  rejectionReason?: string;
  branchName: string;
  runInput: RunFlowInput;
  storeKind: WorkItemStoreKind;
  legacyState?: {
    activePlanningBaseline: TaskPlanningBaseline | undefined;
    sourceDriftOverride?: TaskSourceDriftOverride;
    specReadinessOverride?: TaskSpecReadinessOverride;
  };
}

interface AdmissionRow {
  run_id: string;
  work_item_id: string;
  candidate_fingerprint: string;
  candidate_version_json: string;
  state: StoredRunAdmissionState;
  admitted_at: string;
  initialization_token: string | null;
  projected_at: string | null;
  settled_at: string | null;
  settlement_token: string | null;
  settlement_started_at: string | null;
  settlement_status: "completed" | "failed" | null;
  settlement_change_request_url: string | null;
  rejection_reason: string | null;
  branch_name: string;
  run_input_json: string;
  store_kind: WorkItemStoreKind;
  legacy_state_json: string | null;
}

function toStoredAdmission(row: AdmissionRow): StoredRunAdmission {
  return {
    runId: row.run_id,
    workItemId: row.work_item_id,
    candidateFingerprint: row.candidate_fingerprint,
    candidateVersion: JSON.parse(
      row.candidate_version_json,
    ) as WorkItemCandidateVersion,
    state: row.state,
    admittedAt: row.admitted_at,
    ...(row.initialization_token
      ? { initializationToken: row.initialization_token }
      : {}),
    ...(row.projected_at ? { projectedAt: row.projected_at } : {}),
    ...(row.settled_at ? { settledAt: row.settled_at } : {}),
    ...(row.settlement_token
      ? { settlementToken: row.settlement_token }
      : {}),
    ...(row.settlement_started_at
      ? { settlementStartedAt: row.settlement_started_at }
      : {}),
    ...(row.settlement_status
      ? { settlementStatus: row.settlement_status }
      : {}),
    ...(row.settlement_change_request_url !== null
      ? { settlementChangeRequestUrl: row.settlement_change_request_url }
      : {}),
    ...(row.rejection_reason ? { rejectionReason: row.rejection_reason } : {}),
    branchName: row.branch_name,
    runInput: JSON.parse(row.run_input_json) as RunFlowInput,
    storeKind: row.store_kind,
    ...(row.legacy_state_json
      ? {
          legacyState: JSON.parse(row.legacy_state_json) as NonNullable<
            StoredRunAdmission["legacyState"]
          >,
        }
      : {}),
  };
}

export type ClaimRunAdmissionResult =
  | { claimed: true; admission: StoredRunAdmission }
  | {
      claimed: false;
      reason: "active-run" | "candidate-already-admitted";
      admission: StoredRunAdmission;
    };

export class RunAdmissionStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") {
      this.#database.exec("PRAGMA journal_mode = WAL;");
    }
    // A pre-intent settlement token cannot prove what was projected. Schema
    // migration happens during process startup, after the previous binary has
    // stopped, so release only those legacy, unrecoverable tokens.
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS run_admissions (
        run_id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        candidate_fingerprint TEXT NOT NULL,
        candidate_version_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'settled', 'rejected')),
        admitted_at TEXT NOT NULL,
        initialization_token TEXT,
        projected_at TEXT,
        settled_at TEXT,
        settlement_token TEXT,
        settlement_started_at TEXT,
        settlement_status TEXT CHECK (
          settlement_status IS NULL OR settlement_status IN ('completed', 'failed')
        ),
        settlement_change_request_url TEXT,
        rejection_reason TEXT,
        branch_name TEXT NOT NULL,
        run_input_json TEXT NOT NULL,
        store_kind TEXT NOT NULL CHECK (store_kind IN ('generic', 'legacy-dev-pr')),
        legacy_state_json TEXT
      ) STRICT;
    `);
    const columns = this.#database
      .prepare("PRAGMA table_info(run_admissions)")
      .all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "settlement_token")) {
      this.#database.exec(
        "ALTER TABLE run_admissions ADD COLUMN settlement_token TEXT;",
      );
    }
    if (!columns.some((column) => column.name === "initialization_token")) {
      this.#database.exec(
        "ALTER TABLE run_admissions ADD COLUMN initialization_token TEXT;",
      );
    }
    if (!columns.some((column) => column.name === "projected_at")) {
      this.#database.exec(
        "ALTER TABLE run_admissions ADD COLUMN projected_at TEXT;",
      );
    }
    if (!columns.some((column) => column.name === "settlement_started_at")) {
      this.#database.exec(
        "ALTER TABLE run_admissions ADD COLUMN settlement_started_at TEXT;",
      );
    }
    if (!columns.some((column) => column.name === "settlement_status")) {
      this.#database.exec(`
        ALTER TABLE run_admissions
        ADD COLUMN settlement_status TEXT CHECK (
          settlement_status IS NULL OR settlement_status IN ('completed', 'failed')
        );
      `);
    }
    if (
      !columns.some(
        (column) => column.name === "settlement_change_request_url",
      )
    ) {
      this.#database.exec(`
        ALTER TABLE run_admissions
        ADD COLUMN settlement_change_request_url TEXT;
      `);
    }
    this.#database.exec(`
      UPDATE run_admissions
      SET projected_at = admitted_at
      WHERE projected_at IS NULL AND state != 'active';

      UPDATE run_admissions
      SET settlement_token = NULL,
          settlement_started_at = NULL,
          settlement_status = NULL,
          settlement_change_request_url = NULL
      WHERE state = 'active'
        AND settlement_token IS NOT NULL
        AND (
          settlement_started_at IS NULL OR settlement_status IS NULL
        );
    `);
    this.#database.exec(`
      DROP INDEX IF EXISTS run_admissions_candidate;
      CREATE UNIQUE INDEX IF NOT EXISTS run_admissions_candidate_live
        ON run_admissions(work_item_id, candidate_fingerprint)
        WHERE state != 'rejected';
      CREATE UNIQUE INDEX IF NOT EXISTS run_admissions_one_active
        ON run_admissions(work_item_id)
        WHERE state = 'active';
    `);
  }

  claim(input: StoredRunAdmission): ClaimRunAdmissionResult {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const priorCandidate = this.#candidate(
        input.workItemId,
        input.candidateFingerprint,
      );
      if (priorCandidate) {
        this.#database.exec("COMMIT;");
        return {
          claimed: false,
          reason: "candidate-already-admitted",
          admission: priorCandidate,
        };
      }
      const active = this.#active(input.workItemId);
      if (active) {
        this.#database.exec("COMMIT;");
        return { claimed: false, reason: "active-run", admission: active };
      }
      this.#database
        .prepare(`
          INSERT INTO run_admissions (
            run_id,
            work_item_id,
            candidate_fingerprint,
            candidate_version_json,
            state,
            admitted_at,
            initialization_token,
            branch_name,
            run_input_json,
            store_kind,
            legacy_state_json
          ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.runId,
          input.workItemId,
          input.candidateFingerprint,
          JSON.stringify(input.candidateVersion),
          input.admittedAt,
          input.initializationToken ?? null,
          input.branchName,
          JSON.stringify(input.runInput),
          input.storeKind,
          input.legacyState ? JSON.stringify(input.legacyState) : null,
        );
      this.#database.exec("COMMIT;");
      return { claimed: true, admission: input };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  get(runId: string): StoredRunAdmission | undefined {
    const row = this.#database
      .prepare("SELECT * FROM run_admissions WHERE run_id = ?")
      .get(runId) as unknown as AdmissionRow | undefined;
    return row ? toStoredAdmission(row) : undefined;
  }

  activeForWorkItem(workItemId: string): StoredRunAdmission | undefined {
    return this.#active(workItemId);
  }

  reject(runId: string, reason: string, at: string): boolean {
    const result = this.#database
      .prepare(`
        UPDATE run_admissions
        SET state = 'rejected',
            settled_at = ?,
            rejection_reason = ?,
            initialization_token = NULL
        WHERE run_id = ? AND state = 'active' AND settlement_token IS NULL
      `)
      .run(at, reason, runId);
    return Number(result.changes) === 1;
  }

  markProjected(runId: string, initializationToken: string, at: string): boolean {
    const result = this.#database
      .prepare(`
        UPDATE run_admissions
        SET projected_at = ?, initialization_token = NULL
        WHERE run_id = ?
          AND state = 'active'
          AND projected_at IS NULL
          AND initialization_token = ?
      `)
      .run(at, runId, initializationToken);
    return Number(result.changes) === 1;
  }

  recoverLegacyProjection(runId: string, at: string): boolean {
    const result = this.#database
      .prepare(`
        UPDATE run_admissions
        SET projected_at = ?
        WHERE run_id = ?
          AND state = 'active'
          AND projected_at IS NULL
          AND initialization_token IS NULL
      `)
      .run(at, runId);
    return Number(result.changes) === 1;
  }

  beginSettlement(input: {
    runId: string;
    token: string;
    startedAt: string;
    status: "completed" | "failed";
    changeRequestUrl?: string;
  }): boolean {
    const result = this.#database
      .prepare(`
        UPDATE run_admissions
        SET settlement_token = ?,
            settlement_started_at = ?,
            settlement_status = ?,
            settlement_change_request_url = ?
        WHERE run_id = ?
          AND state = 'active'
          AND projected_at IS NOT NULL
          AND settlement_token IS NULL
      `)
      .run(
        input.token,
        input.startedAt,
        input.status,
        input.changeRequestUrl ?? null,
        input.runId,
      );
    return Number(result.changes) === 1;
  }

  completeSettlement(runId: string, token: string, at: string): boolean {
    const result = this.#database
      .prepare(`
        UPDATE run_admissions
        SET state = 'settled', settled_at = ?, settlement_token = NULL
        WHERE run_id = ? AND state = 'active' AND settlement_token = ?
      `)
      .run(at, runId, token);
    return Number(result.changes) === 1;
  }

  renewSettlementLease(runId: string, token: string, startedAt: string): boolean {
    const result = this.#database
      .prepare(`
        UPDATE run_admissions
        SET settlement_started_at = ?
        WHERE run_id = ? AND state = 'active' AND settlement_token = ?
      `)
      .run(startedAt, runId, token);
    return Number(result.changes) === 1;
  }

  abortSettlement(runId: string, token: string): boolean {
    const result = this.#database
      .prepare(`
        UPDATE run_admissions
        SET settlement_token = NULL,
            settlement_started_at = NULL,
            settlement_status = NULL,
            settlement_change_request_url = NULL
        WHERE run_id = ? AND state = 'active' AND settlement_token = ?
      `)
      .run(runId, token);
    return Number(result.changes) === 1;
  }

  // Lease age alone never authorizes recovery. The caller must prove that the
  // exact durable terminal intent is already projected before using this.
  recoverStaleSettlementAfterProof(
    runId: string,
    token: string,
    staleBefore: string,
    at: string,
  ): boolean {
    const result = this.#database
      .prepare(`
        UPDATE run_admissions
        SET state = 'settled', settled_at = ?, settlement_token = NULL
        WHERE run_id = ?
          AND state = 'active'
          AND settlement_token = ?
          AND settlement_started_at IS NOT NULL
          AND settlement_started_at <= ?
      `)
      .run(at, runId, token, staleBefore);
    return Number(result.changes) === 1;
  }

  withExclusive<T>(callback: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const result = callback();
      this.#database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }

  #candidate(
    workItemId: string,
    candidateFingerprint: string,
  ): StoredRunAdmission | undefined {
    const row = this.#database
      .prepare(`
        SELECT * FROM run_admissions
        WHERE work_item_id = ? AND candidate_fingerprint = ? AND state != 'rejected'
      `)
      .get(workItemId, candidateFingerprint) as unknown as
      | AdmissionRow
      | undefined;
    return row ? toStoredAdmission(row) : undefined;
  }

  #active(workItemId: string): StoredRunAdmission | undefined {
    const row = this.#database
      .prepare(`
        SELECT * FROM run_admissions
        WHERE work_item_id = ? AND state = 'active'
      `)
      .get(workItemId) as unknown as AdmissionRow | undefined;
    return row ? toStoredAdmission(row) : undefined;
  }
}
