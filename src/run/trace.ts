import type { StoredRunEvent } from "../events/types.js";

export type RunTraceSpanKind =
  | "run"
  | "stage"
  | "attempt"
  | "approval"
  | "change"
  | "rollback"
  | "resume"
  | "terminal";

export type RunTraceSpanStatus =
  | "open"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "awaiting-approval";

export type RunCheckpointKind =
  | "run-admitted"
  | "run-created"
  | "input-snapshot"
  | "workspace-created"
  | "stage-attempt"
  | "approval-wait"
  | "change-published"
  | "change-updated"
  | "rollback-decision"
  | "resume-selection"
  | "terminal";

export type RunCheckpointStatus =
  | "candidate"
  | "informational"
  | "terminal";

export type RunCheckpointAction =
  | "resume-run"
  | "resolve-approval"
  | "inspect-only";

export interface RunTraceSpan {
  id: string;
  kind: RunTraceSpanKind;
  label: string;
  status: RunTraceSpanStatus;
  runId: string;
  stageId?: string;
  attempt?: number;
  startedAt: string;
  endedAt?: string;
  startSequence: number;
  endSequence?: number;
  eventTypes: string[];
}

export interface RunCheckpoint {
  id: string;
  kind: RunCheckpointKind;
  label: string;
  status: RunCheckpointStatus;
  action: RunCheckpointAction;
  runId: string;
  stageId?: string;
  attempt?: number;
  createdAt: string;
  eventSequence: number;
  eventType: string;
  preserves: string[];
  changes: string[];
}

export interface RunTraceProjection {
  spans: RunTraceSpan[];
  checkpoints: RunCheckpoint[];
  resumableCheckpoints: RunCheckpoint[];
}

interface MutableSpan extends RunTraceSpan {
  eventTypes: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stageAttemptKey(stageId: string | undefined, attempt: number | undefined): string | undefined {
  return stageId && typeof attempt === "number" ? `${stageId}:${attempt}` : undefined;
}

function approvalId(event: StoredRunEvent): string {
  const payload = asRecord(event.payload);
  return (
    asString(payload.id) ??
    asString(payload.approvalId) ??
    (event.stageId && event.attempt
      ? `${event.stageId}-${event.attempt}`
      : `approval-${event.sequence}`)
  );
}

function stageTerminalStatus(type: string): RunTraceSpanStatus | undefined {
  if (type === "stage.completed") return "completed";
  if (type === "stage.failed") return "failed";
  if (type === "stage.blocked") return "blocked";
  return undefined;
}

function runTerminalStatus(type: string): RunTraceSpanStatus | undefined {
  if (type === "run.completed") return "completed";
  if (type === "run.failed") return "failed";
  if (type === "run.blocked") return "blocked";
  if (type === "run.cancelled") return "cancelled";
  return undefined;
}

function recordEvent(span: MutableSpan, event: StoredRunEvent): void {
  span.endSequence = event.sequence;
  span.endedAt = event.createdAt;
  if (!span.eventTypes.includes(event.type)) {
    span.eventTypes.push(event.type);
  }
}

function basePreserves(): string[] {
  return [
    "append-only event history",
    "published artifacts and evidence",
  ];
}

function stageAttemptChanges(): string[] {
  return [
    "resume creates a new stage attempt when needed",
    "worktree and branch state are reused from recorded run metadata",
  ];
}

function checkpointForEvent(
  event: StoredRunEvent,
  input: {
    kind: RunCheckpointKind;
    label: string;
    status?: RunCheckpointStatus;
    action?: RunCheckpointAction;
    preserves?: string[];
    changes?: string[];
  },
): RunCheckpoint {
  return {
    id: `${input.kind}:${event.sequence}`,
    kind: input.kind,
    label: input.label,
    status: input.status ?? "informational",
    action: input.action ?? "inspect-only",
    runId: event.runId,
    ...(event.stageId ? { stageId: event.stageId } : {}),
    ...(typeof event.attempt === "number" ? { attempt: event.attempt } : {}),
    createdAt: event.createdAt,
    eventSequence: event.sequence,
    eventType: event.type,
    preserves: input.preserves ?? basePreserves(),
    changes: input.changes ?? [],
  };
}

function stageAttemptCheckpointLabel(event: StoredRunEvent): string {
  const attempt = typeof event.attempt === "number" ? ` attempt ${event.attempt}` : "";
  return `Stage ${event.stageId ?? "unknown"}${attempt}`;
}

function terminalCheckpointLabel(event: StoredRunEvent): string {
  const status = runTerminalStatus(event.type) ?? "terminal";
  return `Run ${status}`;
}

function rollbackDecisionLabel(event: StoredRunEvent): string {
  const payload = asRecord(event.payload);
  return asString(payload.checkpointLabel)
    ? `Rollback decision: ${asString(payload.checkpointLabel)}`
    : "Rollback decision recorded";
}

function rollbackDecisionChanges(event: StoredRunEvent): string[] {
  const payload = asRecord(event.payload);
  return Array.isArray(payload.changes)
    ? payload.changes.filter((item): item is string => typeof item === "string")
    : [
        "operator rollback decision is recorded for audit",
        "no worktree, branch, artifact, or pull request mutation is performed",
      ];
}

function rollbackDecisionPreserves(event: StoredRunEvent): string[] {
  const payload = asRecord(event.payload);
  return Array.isArray(payload.preserves)
    ? payload.preserves.filter((item): item is string => typeof item === "string")
    : [
        "append-only event history",
        "published artifacts and evidence",
        "existing worktree, branch, and change request state",
      ];
}

function rollbackApplicationLabel(event: StoredRunEvent): string {
  return event.type === "rollback.applied"
    ? "Rollback policy applied"
    : "Rollback policy apply failed";
}

function rollbackApplicationChanges(event: StoredRunEvent): string[] {
  const payload = asRecord(event.payload);
  const application = asRecord(payload.application);
  const mutations = Array.isArray(application.mutations)
    ? application.mutations.filter((item): item is string => typeof item === "string")
    : [];
  const failures = Array.isArray(application.failures)
    ? application.failures.filter((item): item is string => typeof item === "string")
    : [];
  if (event.type === "rollback.apply_failed") {
    return failures.length > 0
      ? failures.map((failure) => `blocked: ${failure}`)
      : ["rollback policy could not be applied"];
  }
  return mutations.length > 0
    ? mutations
    : ["rollback policy preserved existing worktree, branch, and change state"];
}

function rollbackApplicationPreserves(event: StoredRunEvent): string[] {
  const payload = asRecord(event.payload);
  return Array.isArray(payload.preserves)
    ? payload.preserves.filter((item): item is string => typeof item === "string")
    : [
        "append-only event history",
        "published artifacts and evidence",
      ];
}

function resumeSelectionLabel(event: StoredRunEvent): string {
  const payload = asRecord(event.payload);
  return asString(payload.checkpointLabel)
    ? `Resume selected: ${asString(payload.checkpointLabel)}`
    : "Resume checkpoint selected";
}

function resumeSelectionChanges(event: StoredRunEvent): string[] {
  const payload = asRecord(event.payload);
  return Array.isArray(payload.changes)
    ? payload.changes.filter((item): item is string => typeof item === "string")
    : [
        "resume execution starts from the selected checkpoint stage",
        "no worktree, branch, artifact, or pull request reset is performed",
      ];
}

function resumeSelectionPreserves(event: StoredRunEvent): string[] {
  const payload = asRecord(event.payload);
  return Array.isArray(payload.preserves)
    ? payload.preserves.filter((item): item is string => typeof item === "string")
    : [
        "append-only event history",
        "existing worktree and branch state",
        "published artifacts and evidence",
      ];
}

export function buildRunTrace(events: StoredRunEvent[]): RunTraceProjection {
  if (events.length === 0) {
    return { spans: [], checkpoints: [], resumableCheckpoints: [] };
  }

  const sorted = [...events].sort((left, right) => left.sequence - right.sequence);
  const first = sorted[0] as StoredRunEvent;
  const latestRunTerminal = [...sorted]
    .reverse()
    .find((event) => runTerminalStatus(event.type));
  const stageAttemptTerminals = new Map<string, StoredRunEvent>();
  const approvalResolutions = new Set<string>();
  for (const event of sorted) {
    const key = stageAttemptKey(event.stageId, event.attempt);
    if (key && stageTerminalStatus(event.type)) {
      stageAttemptTerminals.set(key, event);
    }
    if (event.type === "approval.resolved") {
      approvalResolutions.add(approvalId(event));
    }
  }

  const spans = new Map<string, MutableSpan>();
  const checkpoints: RunCheckpoint[] = [];
  const runSpan: MutableSpan = {
    id: `run:${first.runId}`,
    kind: "run",
    label: `Run ${first.runId}`,
    status: "open",
    runId: first.runId,
    startedAt: first.createdAt,
    startSequence: first.sequence,
    eventTypes: [],
  };
  spans.set(runSpan.id, runSpan);

  function ensureSpan(id: string, create: () => MutableSpan): MutableSpan {
    const existing = spans.get(id);
    if (existing) return existing;
    const span = create();
    spans.set(id, span);
    return span;
  }

  for (const event of sorted) {
    recordEvent(runSpan, event);
    const runStatus = runTerminalStatus(event.type);
    if (runStatus) {
      runSpan.status = runStatus;
    }

    if (event.stageId) {
      const stageSpan = ensureSpan(`stage:${event.stageId}`, () => ({
        id: `stage:${event.stageId}`,
        kind: "stage",
        label: `Stage ${event.stageId}`,
        status: "open",
        runId: event.runId,
        stageId: event.stageId,
        startedAt: event.createdAt,
        startSequence: event.sequence,
        eventTypes: [],
      }));
      recordEvent(stageSpan, event);
      const stageStatus = stageTerminalStatus(event.type);
      if (stageStatus) {
        stageSpan.status = stageStatus;
      }
    }

    const attemptKey = stageAttemptKey(event.stageId, event.attempt);
    if (attemptKey) {
      const attemptSpan = ensureSpan(`attempt:${attemptKey}`, () => ({
        id: `attempt:${attemptKey}`,
        kind: "attempt",
        label: `Attempt ${attemptKey}`,
        status: "open",
        runId: event.runId,
        stageId: event.stageId,
        attempt: event.attempt,
        startedAt: event.createdAt,
        startSequence: event.sequence,
        eventTypes: [],
      }));
      recordEvent(attemptSpan, event);
      const attemptStatus = stageTerminalStatus(event.type);
      if (attemptStatus) {
        attemptSpan.status = attemptStatus;
      }
    }

    if (event.type === "approval.requested" || event.type === "approval.resolved") {
      const id = approvalId(event);
      const approvalSpan = ensureSpan(`approval:${id}`, () => ({
        id: `approval:${id}`,
        kind: "approval",
        label: `Approval ${id}`,
        status: "awaiting-approval",
        runId: event.runId,
        stageId: event.stageId,
        attempt: event.attempt,
        startedAt: event.createdAt,
        startSequence: event.sequence,
        eventTypes: [],
      }));
      recordEvent(approvalSpan, event);
      if (event.type === "approval.resolved") {
        approvalSpan.status = "completed";
      }
    }

    if (
      event.type === "change.published" ||
      event.type === "change.updated" ||
      event.type === "change.sync.completed" ||
      event.type === "change.sync.conflicted"
    ) {
      const changeSpan = ensureSpan(`change:${event.stageId ?? event.sequence}`, () => ({
        id: `change:${event.stageId ?? event.sequence}`,
        kind: "change",
        label: event.stageId ? `Change ${event.stageId}` : "Change",
        status: "open",
        runId: event.runId,
        stageId: event.stageId,
        attempt: event.attempt,
        startedAt: event.createdAt,
        startSequence: event.sequence,
        eventTypes: [],
      }));
      recordEvent(changeSpan, event);
      changeSpan.status =
        event.type === "change.sync.conflicted" ? "blocked" : "completed";
    }

    if (
      event.type === "rollback.recorded" ||
      event.type === "rollback.applied" ||
      event.type === "rollback.apply_failed"
    ) {
      const rollbackSpan = ensureSpan(`rollback:${event.sequence}`, () => ({
        id: `rollback:${event.sequence}`,
        kind: "rollback",
        label:
          event.type === "rollback.recorded"
            ? rollbackDecisionLabel(event)
            : rollbackApplicationLabel(event),
        status: "completed",
        runId: event.runId,
        stageId: event.stageId,
        attempt: event.attempt,
        startedAt: event.createdAt,
        startSequence: event.sequence,
        eventTypes: [],
      }));
      recordEvent(rollbackSpan, event);
      rollbackSpan.status = "completed";
    }

    if (event.type === "resume.selected") {
      const resumeSpan = ensureSpan(`resume:${event.sequence}`, () => ({
        id: `resume:${event.sequence}`,
        kind: "resume",
        label: resumeSelectionLabel(event),
        status: "completed",
        runId: event.runId,
        stageId: event.stageId,
        attempt: event.attempt,
        startedAt: event.createdAt,
        startSequence: event.sequence,
        eventTypes: [],
      }));
      recordEvent(resumeSpan, event);
      resumeSpan.status = "completed";
    }

    if (event.type === "run.admitted") {
      checkpoints.push(
        checkpointForEvent(event, {
          kind: "run-admitted",
          label: "Run admitted",
          changes: ["Work item ownership and input references are recorded"],
        }),
      );
    } else if (event.type === "run.created") {
      checkpoints.push(
        checkpointForEvent(event, {
          kind: "run-created",
          label: "Run created",
          changes: ["run metadata and input references are recorded"],
        }),
      );
    } else if (
      event.type === "context.manifest.updated" ||
      event.type === "task.scope.selected"
    ) {
      checkpoints.push(
        checkpointForEvent(event, {
          kind: "input-snapshot",
          label:
            event.type === "task.scope.selected"
              ? "Task scope selected"
              : "Input manifest updated",
          changes: ["input snapshot is fixed for later evidence review"],
        }),
      );
    } else if (event.type === "workspace.created") {
      checkpoints.push(
        checkpointForEvent(event, {
          kind: "workspace-created",
          label: "Workspace created",
          changes: ["worktree path and branch become part of run recovery state"],
        }),
      );
    } else if (event.type === "stage.started") {
      const key = stageAttemptKey(event.stageId, event.attempt);
      const terminal = key ? stageAttemptTerminals.get(key) : undefined;
      const blockedOrFailed =
        terminal?.type === "stage.failed" || terminal?.type === "stage.blocked";
      const openAttempt = !terminal && !latestRunTerminal;
      const terminalAllowsResume =
        !latestRunTerminal || latestRunTerminal.type === "run.blocked";
      const resumeCandidate = (blockedOrFailed && terminalAllowsResume) || openAttempt;
      checkpoints.push(
        checkpointForEvent(event, {
          kind: "stage-attempt",
          label: stageAttemptCheckpointLabel(event),
          status: resumeCandidate ? "candidate" : "informational",
          action: resumeCandidate ? "resume-run" : "inspect-only",
          changes: stageAttemptChanges(),
        }),
      );
    } else if (event.type === "approval.requested") {
      const unresolved = !approvalResolutions.has(approvalId(event)) && !latestRunTerminal;
      checkpoints.push(
        checkpointForEvent(event, {
          kind: "approval-wait",
          label: `Approval requested for ${event.stageId ?? "run"}`,
          status: unresolved ? "candidate" : "informational",
          action: unresolved ? "resolve-approval" : "inspect-only",
          changes: ["operator decision is appended before execution continues"],
        }),
      );
    } else if (event.type === "change.published") {
      checkpoints.push(
        checkpointForEvent(event, {
          kind: "change-published",
          label: "Change request published",
          changes: ["future rework updates the recorded change request when policy allows"],
        }),
      );
    } else if (event.type === "change.updated") {
      checkpoints.push(
        checkpointForEvent(event, {
          kind: "change-updated",
          label: "Change request updated",
          changes: ["PR evidence is refreshed without mutating prior artifacts"],
        }),
      );
    } else if (event.type === "rollback.recorded") {
      checkpoints.push(
        checkpointForEvent(event, {
          kind: "rollback-decision",
          label: rollbackDecisionLabel(event),
          preserves: rollbackDecisionPreserves(event),
          changes: rollbackDecisionChanges(event),
        }),
      );
    } else if (
      event.type === "rollback.applied" ||
      event.type === "rollback.apply_failed"
    ) {
      checkpoints.push(
        checkpointForEvent(event, {
          kind: "rollback-decision",
          label: rollbackApplicationLabel(event),
          status: "informational",
          preserves: rollbackApplicationPreserves(event),
          changes: rollbackApplicationChanges(event),
        }),
      );
    } else if (event.type === "resume.selected") {
      checkpoints.push(
        checkpointForEvent(event, {
          kind: "resume-selection",
          label: resumeSelectionLabel(event),
          preserves: resumeSelectionPreserves(event),
          changes: resumeSelectionChanges(event),
        }),
      );
    } else if (runTerminalStatus(event.type)) {
      checkpoints.push(
        checkpointForEvent(event, {
          kind: "terminal",
          label: terminalCheckpointLabel(event),
          status: "terminal",
          changes: ["run is terminal; recovery starts a new recorded action"],
        }),
      );
    }
  }

  if (!latestRunTerminal && runSpan.status === "open") {
    runSpan.status = checkpoints.some(
      (checkpoint) =>
        checkpoint.kind === "approval-wait" && checkpoint.status === "candidate",
    )
      ? "awaiting-approval"
      : "open";
  }

  const projectedSpans = [...spans.values()].sort(
    (left, right) => left.startSequence - right.startSequence,
  );
  const resumableCheckpoints = checkpoints.filter(
    (checkpoint) => checkpoint.status === "candidate",
  );
  return { spans: projectedSpans, checkpoints, resumableCheckpoints };
}
