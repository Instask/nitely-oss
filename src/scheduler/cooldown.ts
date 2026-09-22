import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseFlowDocument } from "../flow/load.js";
import { stageRuntimeCandidates } from "../flow/schema.js";
import type { RunFlowInput } from "../run/run-flow.js";

export interface SchedulerCooldown {
  runtime: string;
  until: string;
}

export interface SchedulerCooldownProjection {
  runtimes: Array<SchedulerCooldown & { waitingRunCount: number }>;
  nextWakeUp?: string;
}

export function schedulerCooldownStorePath(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "scheduler-cooldowns.db");
}

export function runtimeKey(runtime: string): string {
  return runtime.trim().toLowerCase();
}

export class SchedulerCooldownStore {
  readonly #database: DatabaseSync;

  constructor(path: string, options: { readOnly?: boolean } = {}) {
    this.#database = new DatabaseSync(path, { readOnly: options.readOnly });
    this.#database.exec("PRAGMA busy_timeout = 5000;");
    if (options.readOnly) return;
    if (path !== ":memory:") this.#database.exec("PRAGMA journal_mode = WAL;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_cooldowns (
        runtime TEXT PRIMARY KEY,
        until TEXT NOT NULL
      ) STRICT;
    `);
  }

  get(runtime: string): SchedulerCooldown | undefined {
    const row = this.#database
      .prepare("SELECT runtime, until FROM scheduler_cooldowns WHERE runtime = ?")
      .get(runtime) as { runtime: string; until: string } | undefined;
    return row ? { ...row } : undefined;
  }

  list(): SchedulerCooldown[] {
    return this.#database
      .prepare("SELECT runtime, until FROM scheduler_cooldowns ORDER BY runtime")
      .all() as unknown as SchedulerCooldown[];
  }

  set(runtime: string, until: Date): void {
    this.#database.prepare(`
      INSERT INTO scheduler_cooldowns (runtime, until) VALUES (?, ?)
      ON CONFLICT(runtime) DO UPDATE SET until = excluded.until
    `).run(runtime, until.toISOString());
  }

  clear(runtime: string): void {
    this.#database.prepare("DELETE FROM scheduler_cooldowns WHERE runtime = ?").run(runtime);
  }

  close(): void {
    this.#database.close();
  }
}

/** Read existing cooldown state without creating a scheduler database. */
export function readSchedulerCooldowns(repoPath: string): SchedulerCooldown[] {
  const path = schedulerCooldownStorePath(repoPath);
  if (!existsSync(path)) return [];
  let store: SchedulerCooldownStore | undefined;
  try {
    store = new SchedulerCooldownStore(path, { readOnly: true });
    return store.list();
  } catch (error) {
    if (
      error instanceof Error &&
      /no such table: scheduler_cooldowns|unable to open database file/.test(error.message)
    ) {
      return [];
    }
    throw error;
  } finally {
    store?.close();
  }
}

export function cooldownUntilForRunInput(
  input: RunFlowInput,
  cooldowns: ReadonlyMap<string, Date>,
): Date | undefined {
  if (!input.flowDocument) return undefined;
  const loaded = parseFlowDocument(input.flowDocument, {
    externalInputs: Object.keys(input.inputs),
  });
  const runtimeStages = loaded.flow.spec.stages.filter(
    (stage) =>
      stage.type === "agent" ||
      stage.type === "judge" ||
      (stage.type === "gate" && stage.mode === "review"),
  );
  if (runtimeStages.length === 0) return undefined;
  const stageCooldowns = runtimeStages.map((stage) => {
    const candidates = stageRuntimeCandidates(stage).filter(
      (candidate) => candidate.runtime,
    );
    const until = candidates
      .map((candidate) => cooldowns.get(runtimeKey(candidate.runtime)))
      .filter((value): value is Date => value !== undefined);
    return candidates.length > 0 && until.length === candidates.length
      ? Math.max(...until.map((value) => value.getTime()))
      : undefined;
  });
  const resolvedCooldowns = stageCooldowns.filter(
    (until): until is number => until !== undefined,
  );
  if (resolvedCooldowns.length !== stageCooldowns.length) return undefined;
  return new Date(Math.max(...resolvedCooldowns));
}

function blockingCooldownRuntimeKeys(
  input: RunFlowInput,
  cooldowns: ReadonlyMap<string, Date>,
  now: Date,
): string[] {
  if (!input.flowDocument) return [];
  const loaded = parseFlowDocument(input.flowDocument, {
    externalInputs: Object.keys(input.inputs),
  });
  const keys = new Set<string>();
  for (const stage of loaded.flow.spec.stages) {
    if (
      stage.type !== "agent" &&
      stage.type !== "judge" &&
      (stage.type !== "gate" || stage.mode !== "review")
    ) continue;
    const candidates = stageRuntimeCandidates(stage)
      .map((candidate) => runtimeKey(candidate.runtime))
      .filter(Boolean);
    if (candidates.length === 0) continue;
    if (candidates.every((runtime) => (cooldowns.get(runtime)?.getTime() ?? 0) > now.getTime())) {
      for (const runtime of candidates) keys.add(runtime);
    }
  }
  return [...keys];
}

/** Project active persisted cooldowns for read-only scheduler consumers. */
export function projectSchedulerCooldowns(input: {
  cooldowns: readonly SchedulerCooldown[];
  runInputs: Iterable<RunFlowInput>;
  now: Date;
}): SchedulerCooldownProjection {
  const active = input.cooldowns
    .map((cooldown) => ({ ...cooldown, at: new Date(cooldown.until) }))
    .filter((cooldown) => Number.isFinite(cooldown.at.getTime()) && cooldown.at > input.now);
  const byRuntime = new Map(active.map((cooldown) => [runtimeKey(cooldown.runtime), cooldown.at]));
  const waiting = new Map(active.map((cooldown) => [runtimeKey(cooldown.runtime), 0]));
  let nextWakeUp: Date | undefined;
  for (const runInput of input.runInputs) {
    const until = cooldownUntilForRunInput(runInput, byRuntime);
    if (!until || until <= input.now) continue;
    for (const runtime of blockingCooldownRuntimeKeys(runInput, byRuntime, input.now)) {
      waiting.set(runtime, (waiting.get(runtime) ?? 0) + 1);
    }
    if (!nextWakeUp || until < nextWakeUp) nextWakeUp = until;
  }
  return {
    runtimes: active.map(({ runtime, until }) => ({
      runtime,
      until,
      waitingRunCount: waiting.get(runtimeKey(runtime)) ?? 0,
    })),
    ...(nextWakeUp ? { nextWakeUp: nextWakeUp.toISOString() } : {}),
  };
}
