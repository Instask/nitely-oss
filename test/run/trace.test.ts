import { describe, expect, it } from "vitest";

import { buildRunTrace } from "../../src/run/trace.js";
import type { StoredRunEvent } from "../../src/events/types.js";

function event(
  sequence: number,
  type: StoredRunEvent["type"],
  patch: Partial<StoredRunEvent> = {},
): StoredRunEvent {
  return {
    sequence,
    runId: "run-trace",
    type,
    payload: {},
    createdAt: `2026-07-08T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    ...patch,
  };
}

describe("run trace checkpoints", () => {
  it("projects stage attempt checkpoints and recovery candidates", () => {
    const trace = buildRunTrace([
      event(1, "run.created"),
      event(2, "workspace.created", {
        payload: { worktreePath: "/tmp/worktree" },
      }),
      event(3, "context.manifest.updated", {
        stageId: "implement",
        attempt: 1,
      }),
      event(4, "stage.started", {
        stageId: "implement",
        attempt: 1,
        payload: { type: "agent" },
      }),
      event(5, "stage.blocked", {
        stageId: "implement",
        attempt: 1,
        payload: { reason: "usage-limit" },
      }),
      event(6, "run.blocked", {
        payload: { reason: "usage-limit" },
      }),
    ]);

    expect(trace.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "run:run-trace", status: "blocked" }),
        expect.objectContaining({
          id: "stage:implement",
          status: "blocked",
        }),
        expect.objectContaining({
          id: "attempt:implement:1",
          status: "blocked",
        }),
      ]),
    );
    expect(trace.checkpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "run-created" }),
        expect.objectContaining({ kind: "workspace-created" }),
        expect.objectContaining({ kind: "input-snapshot" }),
        expect.objectContaining({
          kind: "stage-attempt",
          status: "candidate",
          action: "resume-run",
          stageId: "implement",
          attempt: 1,
        }),
        expect.objectContaining({ kind: "terminal", status: "terminal" }),
      ]),
    );
    expect(trace.resumableCheckpoints).toEqual([
      expect.objectContaining({ kind: "stage-attempt", stageId: "implement" }),
    ]);
  });

  it("projects unresolved approval waits as operator action candidates", () => {
    const trace = buildRunTrace([
      event(1, "run.created"),
      event(2, "stage.started", {
        stageId: "approval",
        attempt: 1,
      }),
      event(3, "approval.requested", {
        stageId: "approval",
        attempt: 1,
        payload: { id: "approval-1" },
      }),
    ]);

    expect(trace.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "run:run-trace",
          status: "awaiting-approval",
        }),
        expect.objectContaining({
          id: "approval:approval-1",
          status: "awaiting-approval",
        }),
      ]),
    );
    expect(trace.resumableCheckpoints).toEqual([
      expect.objectContaining({
        kind: "stage-attempt",
        action: "resume-run",
      }),
      expect.objectContaining({
        kind: "approval-wait",
        action: "resolve-approval",
      }),
    ]);
  });

  it("keeps resolved approvals informational", () => {
    const trace = buildRunTrace([
      event(1, "run.created"),
      event(2, "approval.requested", {
        stageId: "approval",
        attempt: 1,
        payload: { id: "approval-1" },
      }),
      event(3, "approval.resolved", {
        stageId: "approval",
        attempt: 1,
        payload: { id: "approval-1" },
      }),
      event(4, "run.completed"),
    ]);

    expect(trace.checkpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "approval-wait",
          status: "informational",
          action: "inspect-only",
        }),
      ]),
    );
    expect(trace.resumableCheckpoints).toEqual([]);
  });

  it("does not keep stale resume candidates after a resumed run completes", () => {
    const trace = buildRunTrace([
      event(1, "run.created"),
      event(2, "stage.started", {
        stageId: "implement",
        attempt: 1,
      }),
      event(3, "stage.blocked", {
        stageId: "implement",
        attempt: 1,
      }),
      event(4, "run.blocked"),
      event(5, "resume.selected", {
        stageId: "implement",
        attempt: 1,
        payload: {
          checkpointId: "stage-attempt:2",
          checkpointKind: "stage-attempt",
          checkpointLabel: "Stage implement attempt 1",
        },
      }),
      event(6, "stage.started", {
        stageId: "implement",
        attempt: 2,
      }),
      event(7, "stage.completed", {
        stageId: "implement",
        attempt: 2,
      }),
      event(8, "run.completed"),
    ]);

    expect(trace.checkpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "stage-attempt",
          stageId: "implement",
          attempt: 1,
          status: "informational",
          action: "inspect-only",
        }),
        expect.objectContaining({
          kind: "resume-selection",
          eventType: "resume.selected",
        }),
      ]),
    );
    expect(trace.resumableCheckpoints).toEqual([]);
  });
});
