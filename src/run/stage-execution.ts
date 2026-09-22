import { join } from "node:path";

import type { EventStore } from "../events/store.js";
import {
  stageRuntimeCandidates,
  type RuntimeCandidate,
  type Stage,
} from "../flow/schema.js";
import type { AgentRunnableStage } from "./execution/types.js";
import {
  createRunOwnedDirectory,
  ensureRunOwnedDirectory,
} from "./owned-file.js";

export {
  DEFAULT_MAX_PING_PONG_CYCLES,
  DEFAULT_MAX_SAME_EDGE_REPEATS,
  detectReworkOscillation,
  reworkEdgeFromRequestedPayload,
} from "./rework-oscillation.js";
export type {
  ReworkEdge,
  ReworkOscillationDetection,
  ReworkOscillationDiagnostics,
} from "./rework-oscillation.js";

export interface StageAttempt {
  attemptDirectory: string;
}

export type StageAttemptDirectoryMode = "create" | "ensure";

function assertSafePathSegment(kind: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,160}$/.test(value)) {
    throw new Error(`invalid ${kind}: ${value}`);
  }
}

function stageHasRuntimeCandidates(
  stage: Stage,
): stage is
  | Extract<Stage, { type: "agent" }>
  | Extract<Stage, { type: "judge" }>
  | Extract<Stage, { type: "gate"; mode: "review" }> {
  return stage.type === "agent" || stage.type === "judge" || (stage.type === "gate" && stage.mode === "review");
}

export function runtimeCandidateEventPayload(input: {
  candidate: RuntimeCandidate;
  index: number;
  count: number;
}): {
  runtime: string;
  model?: string;
  runtimeCandidateIndex: number;
  runtimeCandidateCount: number;
} {
  return {
    runtime: input.candidate.runtime,
    ...(input.candidate.model ? { model: input.candidate.model } : {}),
    runtimeCandidateIndex: input.index,
    runtimeCandidateCount: input.count,
  };
}

export function stageWithRuntimeCandidate<T extends AgentRunnableStage>(
  stage: T,
  candidate: RuntimeCandidate,
): T {
  return {
    ...stage,
    runtime: candidate.runtime,
    ...(candidate.model ? { model: candidate.model } : { model: undefined }),
  };
}

export async function beginRuntimeCandidateAttempt<T extends AgentRunnableStage>(input: {
  eventStore: EventStore;
  runId: string;
  runDirectory: string;
  stage: T;
  baseAttempt: number;
  attemptDirectory: string;
  candidate: RuntimeCandidate;
  index: number;
  count: number;
  resumedFrom?: string;
  branchHeadSha?: string;
  onAttemptSelected?: (attempt: number) => void;
}): Promise<{
  stage: T;
  attempt: number;
  attemptDirectory: string;
}> {
  const attempt = input.baseAttempt + input.index;
  input.onAttemptSelected?.(attempt);
  const stage = stageWithRuntimeCandidate(input.stage, input.candidate);
  const attemptDirectory =
    input.index === 0
      ? input.attemptDirectory
      : (
          await beginStageAttempt({
            eventStore: input.eventStore,
            runId: input.runId,
            runDirectory: input.runDirectory,
            stage: input.stage,
            attempt,
            ...(input.resumedFrom ? { resumedFrom: input.resumedFrom } : {}),
            ...(input.branchHeadSha ? { branchHeadSha: input.branchHeadSha } : {}),
            runtimeCandidate: {
              candidate: input.candidate,
              index: input.index,
              count: input.count,
            },
          })
        ).attemptDirectory;
  return { stage, attempt, attemptDirectory };
}

async function createStageAttemptDirectory(input: {
  runDirectory: string;
  stageId: string;
  attempt: number;
  mode: StageAttemptDirectoryMode;
}): Promise<string> {
  assertSafePathSegment("stage id", input.stageId);
  const attemptPath = join("stages", input.stageId, String(input.attempt));
  const attemptDirectory = join(input.runDirectory, attemptPath);
  const directoryInput = {
    runDirectory: input.runDirectory,
    path: attemptPath,
    subject: `stage ${input.stageId} attempt directory`,
  };
  if (input.mode === "ensure") {
    await ensureRunOwnedDirectory(directoryInput);
  } else {
    await createRunOwnedDirectory(directoryInput);
  }
  return attemptDirectory;
}

export async function beginStageAttempt(input: {
  eventStore: EventStore;
  runId: string;
  runDirectory: string;
  stage: Stage;
  attempt: number;
  resumedFrom?: string;
  branchHeadSha?: string;
  runtimeCandidate?: {
    candidate: RuntimeCandidate;
    index: number;
    count: number;
  };
  directoryMode?: StageAttemptDirectoryMode;
}): Promise<StageAttempt> {
  const attemptDirectory = await createStageAttemptDirectory({
    runDirectory: input.runDirectory,
    stageId: input.stage.id,
    attempt: input.attempt,
    mode: input.directoryMode ?? "create",
  });
  const runtimeCandidate =
    input.runtimeCandidate ??
    (stageHasRuntimeCandidates(input.stage)
      ? {
          candidate: stageRuntimeCandidates(input.stage)[0]!,
          index: 0,
          count: stageRuntimeCandidates(input.stage).length,
        }
      : undefined);

  input.eventStore.append({
    runId: input.runId,
    stageId: input.stage.id,
    attempt: input.attempt,
    type: "stage.started",
    payload: {
      attemptDirectory,
      type: input.stage.type,
      ...(input.stage.costClass ? { costClass: input.stage.costClass } : {}),
      ...(input.resumedFrom ? { resumedFrom: input.resumedFrom } : {}),
      ...(input.branchHeadSha ? { branchHeadSha: input.branchHeadSha } : {}),
      ...(runtimeCandidate ? runtimeCandidateEventPayload(runtimeCandidate) : {}),
    },
  });
  return { attemptDirectory };
}

export interface PrepareStageAttemptInput {
  begin: Parameters<typeof beginStageAttempt>[0];
  prepare?: () => Promise<void>;
  onStageChange?: () => void;
  assertNotCancelled?: () => void;
}

export async function prepareStageAttempt(
  input: PrepareStageAttemptInput,
): Promise<StageAttempt> {
  await input.prepare?.();
  const attempt = await beginStageAttempt(input.begin);
  input.onStageChange?.();
  input.assertNotCancelled?.();
  return attempt;
}

export function maxAttemptsForStage(
  stage: Stage,
  flowMaxAttempts?: number,
): number {
  if (
    stage.type === "judge" &&
    stage.maxAttempts === undefined &&
    flowMaxAttempts === undefined &&
    stage.maxRework !== undefined
  ) {
    return stage.maxRework + 1;
  }
  return stage.maxAttempts ?? flowMaxAttempts ?? 1;
}
