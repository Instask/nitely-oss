import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_PING_PONG_CYCLES,
  DEFAULT_MAX_SAME_EDGE_REPEATS,
  detectReworkOscillation,
  reworkEdgeFromRequestedPayload,
} from "../../src/run/rework-oscillation.js";
import { detectReworkOscillation as detectFromStageExecution } from "../../src/run/stage-execution.js";

describe("detectReworkOscillation", () => {
  it("uses conservative defaults so a single rework is not oscillating", () => {
    expect(DEFAULT_MAX_SAME_EDGE_REPEATS).toBe(3);
    expect(DEFAULT_MAX_PING_PONG_CYCLES).toBe(2);
    expect(
      detectReworkOscillation({
        priorEdges: [],
        nextEdge: { from: "review", to: "implement" },
      }),
    ).toEqual({ oscillating: false });
  });

  it("allows the same edge twice and fails on the third repeat", () => {
    const edge = { from: "review", to: "implement" };
    expect(
      detectReworkOscillation({
        priorEdges: [edge],
        nextEdge: edge,
      }),
    ).toEqual({ oscillating: false });

    const third = detectReworkOscillation({
      priorEdges: [edge, edge],
      nextEdge: edge,
    });
    expect(third).toEqual({
      oscillating: true,
      from: "review",
      to: "implement",
      count: 3,
      window: 3,
      edges: [edge, edge, edge],
      reason:
        "rework oscillation: review→implement repeated 3 times in window 3",
    });
  });

  it("detects two full A↔B ping-pong cycles and not a single reverse pair", () => {
    const ab = { from: "A", to: "B" };
    const ba = { from: "B", to: "A" };
    expect(
      detectReworkOscillation({
        priorEdges: [ab],
        nextEdge: ba,
      }),
    ).toEqual({ oscillating: false });
    expect(
      detectReworkOscillation({
        priorEdges: [ab, ba, ab],
        nextEdge: ba,
      }),
    ).toEqual({
      oscillating: true,
      from: "B",
      to: "A",
      count: 2,
      window: 4,
      edges: [ab, ba, ab, ba],
      reason: "rework oscillation: B↔A ping-pong 2 cycles in window 4",
    });
  });

  it("does not treat a self-loop as ping-pong", () => {
    const self = { from: "implement", to: "implement" };
    expect(
      detectReworkOscillation({
        priorEdges: [self, self, self, self],
        nextEdge: self,
      }),
    ).toMatchObject({
      oscillating: true,
      reason: expect.stringMatching(/implement→implement repeated/),
    });
  });

  it("honors stricter thresholds when provided", () => {
    const edge = { from: "test", to: "implement" };
    expect(
      detectReworkOscillation({
        priorEdges: [],
        nextEdge: edge,
        maxSameEdgeRepeats: 1,
      }),
    ).toMatchObject({ oscillating: true, count: 1 });
  });
});

describe("reworkEdgeFromRequestedPayload", () => {
  it("reads a from→to edge off stage.rework.requested", () => {
    expect(
      reworkEdgeFromRequestedPayload({
        stageId: "review",
        payload: { targetStage: "implement" },
      }),
    ).toEqual({ from: "review", to: "implement" });
    expect(
      reworkEdgeFromRequestedPayload({
        payload: { targetStage: "implement" },
      }),
    ).toBeUndefined();
  });
});

describe("stage-execution oscillation seam", () => {
  it("exposes the detector through stage-execution", () => {
    expect(detectFromStageExecution).toBe(detectReworkOscillation);
  });
});
