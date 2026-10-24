import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { appendFile, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Work-level freshness and claims. Scheduler leases stay where they are.
 * A side effect runs only when every conflict domain is still at the cursor
 * the caller observed, and only one owner can hold those domains.
 */

const DOMAIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._#/@+-]{0,200}$/;
const HEAD_PATTERN = /^(?:none|[A-Za-z0-9._-]{1,64})$/;
const EVIDENCE_HEAD_PATTERN = /^(?:none|[0-9a-f]{7,64})$/i;
const DELTA_LIMIT = 8;
const WAKE_DELIVERY_LIMIT = 32;
const STRING_LIMIT = 160;

export interface ChangeMutationDomainInput {
  action: "publish" | "update" | "review" | "repair";
  branch?: string;
  worktreePath?: string;
  issue?: { owner: string; repository: string; number: number };
  pull?: { owner: string; repository: string; number: number };
  artifactIds?: readonly string[];
}

export interface StoredEffectRecord {
  url?: string;
  head: string;
}

export type GuardedMutation<T> =
  | { decision: "proceed"; result: T; replayed: false }
  | { decision: "replay"; record: StoredEffectRecord; replayed: true }
  | {
      decision: "hold";
      reason: "stale-cursor";
      nextCursor: string;
      delta: string[];
    }
  | {
      decision: "reevaluation-limit";
      reason: "reevaluation-limit";
      nextCursor: string;
      delta: string[];
    }
  | { decision: "conflict"; ownerRunId: string }
  | { decision: "unknown"; reason: "effect-started" };

export type WakeRole = "lead" | "duplicate" | "stale" | "coalesced";

export type WakeClaim = "process" | "skip" | "blocked" | "absent";

export type WakeFinish = "done" | "released" | "ignored";

interface WorldRow {
  domain: string;
  revision: number;
  head: string;
  summary: string;
}

interface ClaimRow {
  domain: string;
  idempotency_key: string;
  run_id: string;
  seen_cursor: string;
  status: "claimed" | "unknown" | "completed";
  result_json: string | null;
}

interface WakeRow {
  domain: string;
  cursor: string;
  lead_delivery_id: string;
  delivery_ids: string;
  state: "pending" | "leased" | "done";
  lease_owner: string | null;
  lease_until: string | null;
  attempts: number;
  rerun: number;
}

export function coordinationDbPath(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "coordination.db");
}

export function changeMutationDomains(input: ChangeMutationDomainInput): string[] {
  const target = input.pull
    ? githubTarget(input.pull)
    : input.issue
      ? githubTarget(input.issue)
      : input.branch
        ? sanitizeToken(input.branch, "branch")
        : "unscoped";
  const domains = [`action:${input.action}:${target}`];
  if (input.branch) domains.push(`branch:${sanitizeToken(input.branch, "branch")}`);
  if (input.worktreePath) {
    const digest = createHash("sha256").update(input.worktreePath).digest("hex").slice(0, 16);
    domains.push(`worktree:${digest}`);
  }
  if (input.issue) domains.push(`github-issue:${githubTarget(input.issue)}`);
  if (input.pull) domains.push(`github-pr:${githubTarget(input.pull)}`);
  for (const id of input.artifactIds ?? []) {
    if (/^[A-Za-z0-9._-]{1,80}$/.test(id)) domains.push(`artifact:${id}`);
  }
  const unique = [...new Set(domains)];
  for (const domain of unique) assertDomain(domain);
  return unique;
}

export function openCoordinationStore(repoPath: string): CoordinationStore {
  const path = coordinationDbPath(repoPath);
  mkdirSync(dirname(path), { recursive: true });
  return new CoordinationStore(path);
}

export class CoordinationStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA busy_timeout = 5000;");
    this.#database.exec("PRAGMA journal_mode = WAL;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS world (
        domain TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        head TEXT NOT NULL,
        summary TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS claims (
        domain TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        seen_cursor TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (domain, idempotency_key)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS claims_active
        ON claims(domain) WHERE status IN ('claimed', 'unknown');
      CREATE TABLE IF NOT EXISTS holds (
        domain TEXT NOT NULL,
        run_id TEXT NOT NULL,
        seen_cursor TEXT NOT NULL,
        PRIMARY KEY (domain, run_id, seen_cursor)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS wakes (
        domain TEXT PRIMARY KEY,
        cursor TEXT NOT NULL,
        lead_delivery_id TEXT NOT NULL,
        delivery_ids TEXT NOT NULL,
        state TEXT NOT NULL,
        lease_owner TEXT,
        lease_until TEXT,
        attempts INTEGER NOT NULL,
        rerun INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  close(): void {
    this.#database.close();
  }

  snapshot(domains: readonly string[], observedHead: string): Record<string, string> {
    const head = normalizeHead(observedHead);
    const cursors: Record<string, string> = {};
    for (const domain of domains) {
      assertDomain(domain);
      const world = this.#world(domain);
      cursors[domain] = world ? `${world.revision}:${head}` : `0:${head}`;
    }
    return cursors;
  }

  propose(input: {
    domains: readonly string[];
    seen: Record<string, string>;
    runId: string;
    idempotencyKey: string;
    now?: string;
  }): GuardedMutation<never> {
    const domains = [...input.domains];
    if (domains.length === 0) throw new Error("work claim requires a conflict domain");
    for (const domain of domains) assertDomain(domain);
    const actionDomain = domains.find((domain) => domain.startsWith("action:")) ?? domains[0]!;
    const now = input.now ?? new Date().toISOString();
    return this.#transaction(() => {
      const sameKey = this.#claim(actionDomain, input.idempotencyKey);
      if (sameKey?.status === "completed") {
        return { decision: "replay", record: parseRecord(sameKey.result_json), replayed: true };
      }
      if (sameKey?.status === "unknown") {
        return { decision: "unknown", reason: "effect-started" };
      }
      if (sameKey?.status === "claimed" && sameKey.run_id === input.runId) {
        return { decision: "proceed", result: undefined as never, replayed: false };
      }

      const stale: string[] = [];
      for (const domain of domains) {
        const world = this.#world(domain);
        const seen = input.seen[domain];
        const current = world ? `${world.revision}:${world.head}` : `0:${headOf(seen)}`;
        if (seen !== current) {
          stale.push(deltaLine(domain, world));
        }
      }
      if (stale.length > 0) {
        const seenCursor = input.seen[actionDomain] ?? "";
        const prior = this.#database.prepare(
          "SELECT 1 AS present FROM holds WHERE domain = ? AND run_id = ? AND seen_cursor = ?",
        ).get(actionDomain, input.runId, seenCursor) as { present: number } | undefined;
        const nextCursor = (() => {
          const world = this.#world(actionDomain);
          return world ? `${world.revision}:${world.head}` : `0:${headOf(seenCursor)}`;
        })();
        const delta = stale.slice(0, DELTA_LIMIT);
        if (prior) {
          return {
            decision: "reevaluation-limit",
            reason: "reevaluation-limit",
            nextCursor,
            delta,
          };
        }
        this.#database.prepare(
          "INSERT INTO holds (domain, run_id, seen_cursor) VALUES (?, ?, ?)",
        ).run(actionDomain, input.runId, seenCursor);
        return { decision: "hold", reason: "stale-cursor", nextCursor, delta };
      }

      for (const domain of domains) {
        const active = this.#database.prepare(
          `SELECT run_id, idempotency_key FROM claims
           WHERE domain = ? AND status IN ('claimed', 'unknown')`,
        ).get(domain) as { run_id: string; idempotency_key: string } | undefined;
        if (active && active.idempotency_key !== input.idempotencyKey) {
          return { decision: "conflict", ownerRunId: active.run_id };
        }
      }
      for (const domain of domains) {
        const seen = input.seen[domain] ?? "";
        this.#database.prepare(`
          INSERT INTO claims (
            domain, idempotency_key, run_id, seen_cursor, status, result_json, updated_at
          ) VALUES (?, ?, ?, ?, 'claimed', NULL, ?)
          ON CONFLICT(domain, idempotency_key) DO UPDATE SET
            status = 'claimed',
            seen_cursor = excluded.seen_cursor,
            updated_at = excluded.updated_at
          WHERE claims.status = 'claimed' AND claims.run_id = excluded.run_id
        `).run(domain, input.idempotencyKey, input.runId, seen, now);
      }
      return { decision: "proceed", result: undefined as never, replayed: false };
    });
  }

  markEffectStarted(input: {
    domains: readonly string[];
    idempotencyKey: string;
    runId: string;
    now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    this.#transaction(() => {
      for (const domain of input.domains) {
        const updated = this.#database.prepare(`
          UPDATE claims
          SET status = 'unknown', updated_at = ?
          WHERE domain = ? AND idempotency_key = ? AND run_id = ? AND status = 'claimed'
        `).run(now, domain, input.idempotencyKey, input.runId);
        if (Number(updated.changes) !== 1) {
          throw new Error(`work claim for ${domain} was not claimed by ${input.runId}`);
        }
      }
    });
  }

  complete(input: {
    domains: readonly string[];
    idempotencyKey: string;
    runId: string;
    head: string;
    record: StoredEffectRecord;
    now?: string;
  }): void {
    const head = normalizeHead(input.head);
    const now = input.now ?? new Date().toISOString();
    const record = JSON.stringify({ url: input.record.url, head });
    if (record.length > 500) throw new Error("work claim result is too large");
    this.#transaction(() => {
      for (const domain of input.domains) {
        const updated = this.#database.prepare(`
          UPDATE claims
          SET status = 'completed', result_json = ?, updated_at = ?
          WHERE domain = ? AND idempotency_key = ? AND run_id = ? AND status = 'unknown'
        `).run(record, now, domain, input.idempotencyKey, input.runId);
        if (Number(updated.changes) !== 1) {
          throw new Error(`work claim for ${domain} cannot be completed`);
        }
        const world = this.#world(domain);
        const revision = (world?.revision ?? 0) + 1;
        const summary = `head ${head}`;
        this.#database.prepare(`
          INSERT INTO world (domain, revision, head, summary, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(domain) DO UPDATE SET
            revision = excluded.revision,
            head = excluded.head,
            summary = excluded.summary,
            updated_at = excluded.updated_at
        `).run(domain, revision, head, summary, now);
      }
    });
  }

  abort(input: { domains: readonly string[]; idempotencyKey: string; runId: string }): void {
    this.#transaction(() => {
      for (const domain of input.domains) {
        this.#database.prepare(`
          DELETE FROM claims
          WHERE domain = ? AND idempotency_key = ? AND run_id = ? AND status = 'claimed'
        `).run(domain, input.idempotencyKey, input.runId);
      }
    });
  }

  recordWake(input: {
    domain: string;
    cursor: string;
    deliveryId: string;
    now?: string;
  }): WakeRole {
    assertDomain(input.domain);
    const cursor = bound(input.cursor);
    const deliveryId = bound(input.deliveryId);
    const now = input.now ?? new Date().toISOString();
    return this.#transaction(() => {
      const wake = this.#wake(input.domain);
      if (!wake) {
        this.#writeWake({
          domain: input.domain,
          cursor,
          lead_delivery_id: deliveryId,
          delivery_ids: JSON.stringify([deliveryId]),
          state: "pending",
          lease_owner: null,
          lease_until: null,
          attempts: 0,
          rerun: 0,
          updated_at: now,
        });
        return "lead";
      }
      const ids = parseIds(wake.delivery_ids);
      if (ids.includes(deliveryId)) {
        return deliveryId === wake.lead_delivery_id && wake.state !== "done"
          ? "lead"
          : "duplicate";
      }
      ids.push(deliveryId);
      const capped = ids.slice(-WAKE_DELIVERY_LIMIT);
      if (cursor < wake.cursor) {
        this.#writeWake({ ...wake, delivery_ids: JSON.stringify(capped), updated_at: now });
        return "stale";
      }
      if (cursor === wake.cursor) {
        this.#writeWake({ ...wake, delivery_ids: JSON.stringify(capped), updated_at: now });
        return "coalesced";
      }
      const rerun = wake.state === "leased" ? 1 : wake.rerun;
      const state = wake.state === "done" ? "pending" : wake.state;
      this.#writeWake({
        ...wake,
        cursor,
        lead_delivery_id: deliveryId,
        delivery_ids: JSON.stringify(capped),
        state,
        rerun,
        updated_at: now,
      });
      return "lead";
    });
  }

  claimWake(input: {
    domain: string;
    deliveryId: string;
    owner: string;
    now: string;
    leaseMs: number;
  }): WakeClaim {
    assertDomain(input.domain);
    return this.#transaction(() => {
      const wake = this.#wake(input.domain);
      if (!wake) return "absent";
      // A finished lead is claimable again when its delivery is still queued
      // or processing. Non-leads stay skipped so they cannot start a second task.
      if (wake.lead_delivery_id !== input.deliveryId) return "skip";
      if (
        wake.state === "leased" &&
        wake.lease_owner !== input.owner &&
        wake.lease_until !== null &&
        wake.lease_until > input.now
      ) {
        // The new lead is only waiting for the previous owner's lease.
        // That is not a stale event, and the caller must not complete it.
        return "blocked";
      }
      const until = new Date(Date.parse(input.now) + input.leaseMs).toISOString();
      this.#writeWake({
        ...wake,
        state: "leased",
        lease_owner: input.owner,
        lease_until: until,
        attempts: wake.attempts + 1,
        rerun: 0,
        updated_at: input.now,
      });
      return "process";
    });
  }

  finishWake(input: {
    domain: string;
    deliveryId: string;
    owner: string;
    now?: string;
  }): WakeFinish {
    const now = input.now ?? new Date().toISOString();
    return this.#transaction(() => {
      const wake = this.#wake(input.domain);
      if (!wake) return "ignored";
      const ownsLease = wake.state === "leased" && wake.lease_owner === input.owner;
      if (wake.state === "leased" && !ownsLease) return "ignored";
      if (wake.lead_delivery_id !== input.deliveryId) {
        if (!ownsLease) return "ignored";
        this.#writeWake({
          ...wake,
          state: "pending",
          lease_owner: null,
          lease_until: null,
          rerun: 0,
          updated_at: now,
        });
        return "released";
      }
      if (wake.rerun) {
        if (!ownsLease) return "ignored";
        this.#writeWake({
          ...wake,
          state: "pending",
          lease_owner: null,
          lease_until: null,
          rerun: 0,
          updated_at: now,
        });
        return "released";
      }
      this.#writeWake({
        ...wake,
        state: "done",
        lease_owner: null,
        lease_until: null,
        updated_at: now,
      });
      return "done";
    });
  }

  releaseWake(input: {
    domain: string;
    deliveryId: string;
    owner: string;
    now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    this.#transaction(() => {
      const wake = this.#wake(input.domain);
      if (!wake || wake.state !== "leased" || wake.lease_owner !== input.owner) return;
      this.#writeWake({
        ...wake,
        state: "pending",
        lease_owner: null,
        lease_until: null,
        rerun: 0,
        updated_at: now,
      });
    });
  }

  wakeAttempts(domain: string): number {
    return this.#wake(domain)?.attempts ?? 0;
  }

  #world(domain: string): WorldRow | undefined {
    return this.#database.prepare(
      "SELECT domain, revision, head, summary FROM world WHERE domain = ?",
    ).get(domain) as WorldRow | undefined;
  }

  #claim(domain: string, key: string): ClaimRow | undefined {
    return this.#database.prepare(
      `SELECT domain, idempotency_key, run_id, seen_cursor, status, result_json
       FROM claims WHERE domain = ? AND idempotency_key = ?`,
    ).get(domain, key) as ClaimRow | undefined;
  }

  #wake(domain: string): WakeRow | undefined {
    return this.#database.prepare(
      `SELECT domain, cursor, lead_delivery_id, delivery_ids, state, lease_owner,
              lease_until, attempts, rerun
       FROM wakes WHERE domain = ?`,
    ).get(domain) as WakeRow | undefined;
  }

  #writeWake(wake: WakeRow & { updated_at: string }): void {
    this.#database.prepare(`
      INSERT INTO wakes (
        domain, cursor, lead_delivery_id, delivery_ids, state, lease_owner,
        lease_until, attempts, rerun, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET
        cursor = excluded.cursor,
        lead_delivery_id = excluded.lead_delivery_id,
        delivery_ids = excluded.delivery_ids,
        state = excluded.state,
        lease_owner = excluded.lease_owner,
        lease_until = excluded.lease_until,
        attempts = excluded.attempts,
        rerun = excluded.rerun,
        updated_at = excluded.updated_at
    `).run(
      wake.domain,
      wake.cursor,
      wake.lead_delivery_id,
      wake.delivery_ids,
      wake.state,
      wake.lease_owner,
      wake.lease_until,
      wake.attempts,
      wake.rerun,
      wake.updated_at,
    );
  }

  #transaction<T>(body: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const value = body();
      this.#database.exec("COMMIT;");
      return value;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }
}

export function recordWorkWake(
  repoPath: string,
  input: { domain: string; cursor: string; deliveryId: string; now?: string },
): WakeRole {
  const store = openCoordinationStore(repoPath);
  try {
    return store.recordWake(input);
  } finally {
    store.close();
  }
}

export function claimWorkWake(
  repoPath: string,
  input: { domain: string; deliveryId: string; owner: string; now: string; leaseMs: number },
): WakeClaim {
  const store = openCoordinationStore(repoPath);
  try {
    return store.claimWake(input);
  } finally {
    store.close();
  }
}

export function finishWorkWake(
  repoPath: string,
  input: { domain: string; deliveryId: string; owner: string; now?: string },
): WakeFinish {
  const store = openCoordinationStore(repoPath);
  try {
    return store.finishWake(input);
  } finally {
    store.close();
  }
}

export function releaseWorkWake(
  repoPath: string,
  input: { domain: string; deliveryId: string; owner: string; now?: string },
): void {
  const store = openCoordinationStore(repoPath);
  try {
    store.releaseWake(input);
  } finally {
    store.close();
  }
}

export async function runGuardedMutation<T>(input: {
  repoPath: string;
  domains: readonly string[];
  observedHead: string;
  runId: string;
  idempotencyKey: string;
  attemptDirectory?: string;
  effect: () => Promise<T>;
  resultOf: (result: T) => StoredEffectRecord;
}): Promise<GuardedMutation<T>> {
  const store = openCoordinationStore(input.repoPath);
  try {
    const seen = store.snapshot(input.domains, input.observedHead);
    const decision = store.propose({
      domains: input.domains,
      seen,
      runId: input.runId,
      idempotencyKey: input.idempotencyKey,
    });
    if (decision.decision !== "proceed") {
      await writeCoordinationNote(input.attemptDirectory, decision);
      return decision;
    }
    store.markEffectStarted({
      domains: input.domains,
      idempotencyKey: input.idempotencyKey,
      runId: input.runId,
    });
    let result: T;
    try {
      result = await input.effect();
    } catch (error) {
      await writeCoordinationNote(input.attemptDirectory, {
        decision: "unknown",
        reason: "effect-started",
      });
      throw error;
    }
    const record = input.resultOf(result);
    store.complete({
      domains: input.domains,
      idempotencyKey: input.idempotencyKey,
      runId: input.runId,
      head: record.head,
      record,
    });
    await writeCoordinationNote(input.attemptDirectory, {
      decision: "proceed",
      record,
    });
    return { decision: "proceed", result, replayed: false };
  } finally {
    store.close();
  }
}

export async function collectCoordinationEvidence(runDirectory: string): Promise<string> {
  let stageNames: string[];
  try {
    stageNames = await readdir(join(runDirectory, "stages"));
  } catch {
    return "";
  }
  const blocks: string[] = [];
  for (const stage of stageNames.sort()) {
    let attempts: string[];
    try {
      attempts = await readdir(join(runDirectory, "stages", stage));
    } catch {
      continue;
    }
    for (const attempt of attempts.sort()) {
      let text: string;
      try {
        text = await readFile(
          join(runDirectory, "stages", stage, attempt, "coordination.jsonl"),
          "utf8",
        );
      } catch {
        continue;
      }
      const lines = coordinationLines(text);
      if (lines.length === 0) continue;
      blocks.push([`Stage ${stage} attempt ${attempt}:`, ...lines].join("\n"));
    }
  }
  return blocks.join("\n");
}

export function coordinationLines(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["decision", "reason", "ownerRunId", "nextCursor", "delta", "head"].includes(key))) {
      continue;
    }
    const decision = stringField(record.decision);
    if (!decision) continue;
    const reason = stringField(record.reason);
    const owner = stringField(record.ownerRunId);
    const nextCursor = stringField(record.nextCursor);
    const head = stringField(record.head);
    const delta = Array.isArray(record.delta)
      ? record.delta.map(stringField).filter((line): line is string => line !== undefined).slice(0, DELTA_LIMIT)
      : [];
    const parts = [decision.toUpperCase()];
    if (reason) parts.push(reason);
    if (owner) parts.push(`owner ${owner}`);
    if (nextCursor) parts.push(`next ${nextCursor}`);
    if (head && EVIDENCE_HEAD_PATTERN.test(head)) parts.push(`head ${head}`);
    lines.push(parts.join(" "));
    for (const line of delta) lines.push(`delta ${line}`);
  }
  return lines;
}

async function writeCoordinationNote(
  attemptDirectory: string | undefined,
  decision: GuardedMutation<unknown> | { decision: "unknown"; reason: "effect-started" } | { decision: "proceed"; record: StoredEffectRecord },
): Promise<void> {
  if (!attemptDirectory) return;
  const payload: Record<string, unknown> = { decision: decision.decision };
  if ("reason" in decision && decision.reason) payload.reason = decision.reason;
  if ("ownerRunId" in decision) payload.ownerRunId = decision.ownerRunId;
  if ("nextCursor" in decision) payload.nextCursor = decision.nextCursor;
  if ("delta" in decision) payload.delta = decision.delta;
  if ("record" in decision && decision.record.head) payload.head = decision.record.head;
  await appendFile(join(attemptDirectory, "coordination.jsonl"), `${JSON.stringify(payload)}\n`, "utf8");
}

function githubTarget(input: { owner: string; repository: string; number: number }): string {
  const owner = sanitizeToken(input.owner, "owner");
  const repository = sanitizeToken(input.repository, "repository");
  if (!Number.isSafeInteger(input.number) || input.number <= 0) {
    throw new Error("work claim number is invalid");
  }
  return `${owner}/${repository}#${input.number}`;
}

function sanitizeToken(value: string, label: string): string {
  const token = value.trim();
  if (!/^[A-Za-z0-9._+/-]{1,120}$/.test(token)) {
    throw new Error(`work claim ${label} is invalid`);
  }
  return token;
}

function assertDomain(domain: string): void {
  if (!DOMAIN_PATTERN.test(domain)) throw new Error(`work claim domain is invalid: ${domain}`);
}

function normalizeHead(head: string): string {
  const token = head.trim().toLowerCase();
  if (!HEAD_PATTERN.test(token)) return "none";
  return token;
}

function headOf(seen: string | undefined): string {
  const head = seen?.split(":").slice(1).join(":") ?? "none";
  return normalizeHead(head);
}

function deltaLine(domain: string, world: WorldRow | undefined): string {
  if (!world) return bound(`${domain} absent`);
  return bound(`${domain} ${world.summary}`);
}

function bound(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f]/g, " ").slice(0, STRING_LIMIT);
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = bound(value).trim();
  return text || undefined;
}

function parseRecord(value: string | null): StoredEffectRecord {
  if (!value) return { head: "none" };
  try {
    const parsed = JSON.parse(value) as { url?: unknown; head?: unknown };
    const head = typeof parsed.head === "string" ? normalizeHead(parsed.head) : "none";
    const url = typeof parsed.url === "string" && /^https:\/\/github\.com\/\S{1,200}$/.test(parsed.url)
      ? parsed.url
      : undefined;
    return { head, ...(url ? { url } : {}) };
  } catch {
    return { head: "none" };
  }
}

function parseIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}
