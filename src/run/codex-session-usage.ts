import type { StoredRunEvent } from "../events/types.js";

/**
 * Per-attempt usage for Codex attempts that continued an earlier session.
 *
 * `codex exec --json` reports `turn.completed.usage` as the thread's
 * cumulative total, and `codex exec resume <thread-id>` keeps that total. A
 * resumed attempt's snapshot therefore includes every earlier attempt on the
 * same thread: measured on codex-cli 0.162.0, a fresh one-word turn reported
 * 5 output tokens and the resumed one-word turn after it reported 10. Summing
 * attempts as recorded counts a task-plan loop of N resumed iterations about
 * N(N+1)/2 times over.
 *
 * The baseline for an attempt is the latest snapshot recorded earlier on the
 * same thread. The thread comes from the usage record itself
 * (`raw.threadId`) or, for records written before that field existed, from
 * the attempt's `stage.runtime.session` event when it says `resumed`. An
 * attempt whose snapshot is below its baseline in any count is unreliable:
 * its usage is dropped rather than guessed, so it counts as unknown.
 *
 * Records written before `raw.threadId` existed are only partly repaired. A
 * failed resumed attempt wrote usage without a session event, so it cannot be
 * tied to its thread and keeps its cumulative snapshot.
 */
export const CODEX_TURN_USAGE_REFERENCE = "codex.exec.turn.completed.usage";

interface UsageCounts {
  input: number;
  cached: number;
  output: number;
  cacheWrite?: number;
  reasoning?: number;
}

export type CodexSessionBaseline =
  | { kind: "subtract"; threadId: string; counts: UsageCounts }
  | { kind: "unreliable"; threadId: string };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function attemptKey(stageId: string, attempt: number): string {
  return `${stageId}:${attempt}`;
}

function isCodexTurnUsage(payload: Record<string, unknown>): boolean {
  const source = asRecord(asRecord(payload.provenance).source);
  return source.reference === CODEX_TURN_USAGE_REFERENCE;
}

function usageCounts(payload: Record<string, unknown>): UsageCounts | undefined {
  const input = count(payload.inputTokens);
  const cached = count(payload.cachedInputTokens);
  const output = count(payload.outputTokens);
  if (input === undefined || cached === undefined || output === undefined) {
    return undefined;
  }
  const raw = asRecord(payload.raw);
  const cacheWrite = count(raw.cacheWriteInputTokens);
  const reasoning = count(raw.reasoningOutputTokens);
  return {
    input,
    cached,
    output,
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}

function subtractCounts(
  next: UsageCounts,
  previous: UsageCounts,
): UsageCounts | undefined {
  const input = next.input - previous.input;
  const cached = next.cached - previous.cached;
  const output = next.output - previous.output;
  if (input < 0 || cached < 0 || output < 0 || cached > input) return undefined;
  const cacheWrite = (next.cacheWrite ?? 0) - (previous.cacheWrite ?? 0);
  const reasoning = (next.reasoning ?? 0) - (previous.reasoning ?? 0);
  if (cacheWrite < 0 || reasoning < 0) return undefined;
  return {
    input,
    cached,
    output,
    ...(next.cacheWrite !== undefined || previous.cacheWrite !== undefined
      ? { cacheWrite }
      : {}),
    ...(next.reasoning !== undefined || previous.reasoning !== undefined
      ? { reasoning }
      : {}),
  };
}

/**
 * Walk a run's events in sequence order and return, keyed by
 * `stageId:attempt`, what to subtract from each Codex attempt that continued
 * an earlier attempt's thread. Attempts that started their thread are absent.
 */
export function codexSessionBaselines(
  events: readonly StoredRunEvent[],
): Map<string, CodexSessionBaseline> {
  const sorted = [...events].sort((left, right) => left.sequence - right.sequence);
  const sessions = new Map<string, { mode?: string; sessionId?: string }>();
  for (const event of sorted) {
    if (event.type !== "stage.runtime.session" || !event.stageId || !event.attempt) {
      continue;
    }
    const payload = asRecord(event.payload);
    sessions.set(attemptKey(event.stageId, event.attempt), {
      ...(typeof payload.mode === "string" ? { mode: payload.mode } : {}),
      ...(typeof payload.sessionId === "string" ? { sessionId: payload.sessionId } : {}),
    });
  }

  const latestByThread = new Map<string, UsageCounts>();
  const baselines = new Map<string, CodexSessionBaseline>();
  for (const event of sorted) {
    if (event.type !== "stage.runtime.usage" || !event.stageId || !event.attempt) {
      continue;
    }
    const payload = asRecord(event.payload);
    if (!isCodexTurnUsage(payload)) continue;
    const counts = usageCounts(payload);
    if (!counts) continue;
    const key = attemptKey(event.stageId, event.attempt);
    const recordedThread = asRecord(payload.raw).threadId;
    const session = sessions.get(key);
    const threadId = typeof recordedThread === "string" && recordedThread.length > 0
      ? recordedThread
      : session?.sessionId;
    if (!threadId) continue;
    // Without a recorded thread, only an attempt the session event marks as
    // resumed is known to have continued the thread rather than started it.
    const continued = typeof recordedThread === "string" || session?.mode === "resumed";
    const previous = latestByThread.get(threadId);
    if (continued && previous) {
      const delta = subtractCounts(counts, previous);
      baselines.set(
        key,
        delta ? { kind: "subtract", threadId, counts: previous } : { kind: "unreliable", threadId },
      );
    }
    latestByThread.set(threadId, counts);
  }
  return baselines;
}

/**
 * The attempt's own share of a `stage.runtime.usage` payload, with the
 * session's cumulative snapshot kept under `raw.sessionCumulative`. Returns
 * undefined when the attempt's share cannot be known.
 */
export function attemptShareOfCodexUsage(
  payload: Record<string, unknown>,
  baseline: CodexSessionBaseline | undefined,
): Record<string, unknown> | undefined {
  if (!baseline) return payload;
  if (baseline.kind === "unreliable") return undefined;
  const counts = usageCounts(payload);
  const delta = counts ? subtractCounts(counts, baseline.counts) : undefined;
  if (!counts || !delta) return undefined;
  const raw = asRecord(payload.raw);
  return {
    ...payload,
    inputTokens: delta.input,
    cachedInputTokens: delta.cached,
    outputTokens: delta.output,
    totalTokens: delta.input + delta.output,
    raw: {
      ...raw,
      cachedInputTokens: delta.cached,
      ...(delta.cacheWrite !== undefined ? { cacheWriteInputTokens: delta.cacheWrite } : {}),
      ...(delta.reasoning !== undefined ? { reasoningOutputTokens: delta.reasoning } : {}),
      usageBaseline: "previous-attempt-on-session",
      sessionCumulative: {
        inputTokens: counts.input,
        cachedInputTokens: counts.cached,
        outputTokens: counts.output,
        ...(counts.cacheWrite !== undefined ? { cacheWriteInputTokens: counts.cacheWrite } : {}),
        ...(counts.reasoning !== undefined ? { reasoningOutputTokens: counts.reasoning } : {}),
      },
    },
  };
}

/**
 * The attempt's own share of a `stage.runtime.calls` payload. Codex turn
 * records are deltas from the start of the capture, so only the first one
 * carries the earlier attempts; it loses the baseline. When the share cannot
 * be known, every turn record is marked cumulative so nothing adds it up.
 */
export function attemptShareOfCodexCalls(
  payload: Record<string, unknown>,
  baseline: CodexSessionBaseline | undefined,
): Record<string, unknown> {
  if (!baseline || !Array.isArray(payload.calls)) return payload;
  const calls = payload.calls.map((call) => asRecord(call));
  const firstTurn = calls.findIndex(
    (call) => call.kind === "llm" && call.granularity === "turn",
  );
  if (firstTurn < 0) return payload;
  const markCumulative = () => ({
    ...payload,
    calls: calls.map((call) =>
      call.kind === "llm" && call.granularity === "turn"
        ? { ...call, accounting: "cumulative" }
        : call,
    ),
  });
  if (baseline.kind === "unreliable") return markCumulative();
  const turn = calls[firstTurn] as Record<string, unknown>;
  const turnCounts: UsageCounts | undefined = (() => {
    const input = count(turn.inputTokens);
    const cached = count(turn.cacheReadInputTokens);
    const output = count(turn.outputTokens);
    if (input === undefined || cached === undefined || output === undefined) return undefined;
    const cacheWrite = count(turn.cacheWriteInputTokens);
    const reasoning = count(turn.reasoningOutputTokens);
    return {
      input,
      cached,
      output,
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    };
  })();
  const delta = turnCounts ? subtractCounts(turnCounts, baseline.counts) : undefined;
  if (!delta) return markCumulative();
  const adjusted = calls.slice();
  adjusted[firstTurn] = {
    ...turn,
    inputTokens: delta.input,
    outputTokens: delta.output,
    totalTokens: delta.input + delta.output,
    cacheReadInputTokens: delta.cached,
    ...(delta.cacheWrite !== undefined ? { cacheWriteInputTokens: delta.cacheWrite } : {}),
    ...(delta.reasoning !== undefined ? { reasoningOutputTokens: delta.reasoning } : {}),
  };
  return { ...payload, calls: adjusted };
}

export function codexSessionBaselineKey(stageId: string, attempt: number): string {
  return attemptKey(stageId, attempt);
}
