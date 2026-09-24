export const DEFAULT_MAX_SAME_EDGE_REPEATS = 3;
export const DEFAULT_MAX_PING_PONG_CYCLES = 2;

export interface ReworkEdge {
  from: string;
  to: string;
}

export interface ReworkOscillationDiagnostics {
  from: string;
  to: string;
  count: number;
  window: number;
  edges: ReworkEdge[];
}

export type ReworkOscillationDetection =
  | { oscillating: false }
  | ({ oscillating: true; reason: string } & ReworkOscillationDiagnostics);

function sameEdge(left: ReworkEdge, right: ReworkEdge): boolean {
  return left.from === right.from && left.to === right.to;
}

function reverseEdge(edge: ReworkEdge): ReworkEdge {
  return { from: edge.to, to: edge.from };
}

function formatSameEdgeReason(diagnostics: ReworkOscillationDiagnostics): string {
  return `rework oscillation: ${diagnostics.from}→${diagnostics.to} repeated ${diagnostics.count} times in window ${diagnostics.window}`;
}

function formatPingPongReason(diagnostics: ReworkOscillationDiagnostics): string {
  return `rework oscillation: ${diagnostics.from}↔${diagnostics.to} ping-pong ${diagnostics.count} cycles in window ${diagnostics.window}`;
}

function detectPingPong(
  sequence: readonly ReworkEdge[],
  maxPingPongCycles: number,
): ReworkOscillationDetection {
  const window = maxPingPongCycles * 2;
  if (maxPingPongCycles < 1 || sequence.length < window) {
    return { oscillating: false };
  }
  const edges = sequence.slice(-window);
  const first = edges[0];
  if (!first || first.from === first.to) {
    return { oscillating: false };
  }
  for (const [index, edge] of edges.entries()) {
    const expected = index % 2 === 0 ? first : reverseEdge(first);
    if (!edge || !sameEdge(edge, expected)) {
      return { oscillating: false };
    }
  }
  const last = edges[edges.length - 1] ?? first;
  const diagnostics: ReworkOscillationDiagnostics = {
    from: last.from,
    to: last.to,
    count: maxPingPongCycles,
    window,
    edges: [...edges],
  };
  return {
    oscillating: true,
    reason: formatPingPongReason(diagnostics),
    ...diagnostics,
  };
}

function detectSameEdgeRepeats(
  sequence: readonly ReworkEdge[],
  nextEdge: ReworkEdge,
  maxSameEdgeRepeats: number,
): ReworkOscillationDetection {
  if (maxSameEdgeRepeats < 1) {
    return { oscillating: false };
  }
  const edges = sequence.filter((edge) => sameEdge(edge, nextEdge));
  if (edges.length < maxSameEdgeRepeats) {
    return { oscillating: false };
  }
  const diagnostics: ReworkOscillationDiagnostics = {
    from: nextEdge.from,
    to: nextEdge.to,
    count: edges.length,
    window: sequence.length,
    edges,
  };
  return {
    oscillating: true,
    reason: formatSameEdgeReason(diagnostics),
    ...diagnostics,
  };
}

export function detectReworkOscillation(input: {
  priorEdges: readonly ReworkEdge[];
  nextEdge: ReworkEdge;
  maxSameEdgeRepeats?: number;
  maxPingPongCycles?: number;
}): ReworkOscillationDetection {
  const sequence = [...input.priorEdges, input.nextEdge];
  const pingPong = detectPingPong(
    sequence,
    input.maxPingPongCycles ?? DEFAULT_MAX_PING_PONG_CYCLES,
  );
  if (pingPong.oscillating) return pingPong;
  return detectSameEdgeRepeats(
    sequence,
    input.nextEdge,
    input.maxSameEdgeRepeats ?? DEFAULT_MAX_SAME_EDGE_REPEATS,
  );
}

export function reworkEdgeFromRequestedPayload(input: {
  stageId?: string;
  payload: unknown;
}): ReworkEdge | undefined {
  const from = input.stageId?.trim();
  if (!from) return undefined;
  const payload =
    typeof input.payload === "object" &&
    input.payload !== null &&
    !Array.isArray(input.payload)
      ? (input.payload as Record<string, unknown>)
      : {};
  const to =
    typeof payload.targetStage === "string" ? payload.targetStage.trim() : "";
  if (!to) return undefined;
  return { from, to };
}
