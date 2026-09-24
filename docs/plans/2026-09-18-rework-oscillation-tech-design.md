# Rework oscillation — Technical Design

Issue: https://github.com/jerryleooo/nitely/issues/472

## Seam

Keep the stage loop in `run-flow.ts`. Oscillation lives in
`src/run/rework-oscillation.ts` and is re-exported from `stage-execution.ts`.
`decideStagePolicy` calls the detector; run-flow only records edges.

```ts
detectReworkOscillation({ priorEdges, nextEdge })
  → { oscillating: false }
  | { oscillating: true, reason, from, to, count, window, edges }
```

Defaults: same directed edge **3** times, or **2** A↔B cycles (4 alternating
edges). Conservative enough that one normal rework still returns `rework`.

## Wiring

- `applyFailedStagePolicy` passes the in-memory edge log plus
  `{ from: sourceStage, to: targetStage }` as the proposal.
- On `action: "rework"`, append that edge after `stage.rework.requested`.
- On oscillation, emit `orchestrator.decision` (`action: "fail"`) with the
  diagnostics object, then `run.failed` with the same reason. Do not emit
  `stage.rework.requested`.
- Resume hydrates edges from `stage.rework.requested` via the same helper.

## Verification

- Detector tests: same-edge, ping-pong, single rework, custom thresholds
- Policy tests: fail closed vs a still-legal first rework
- Linux run-flow: A↔B loop fails before high `maxAttempts`; existing single
  rework test still completes
