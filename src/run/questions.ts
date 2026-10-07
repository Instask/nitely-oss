import { join } from "node:path";

import { z } from "zod";

import { redactText } from "../context/redaction.js";
import { EventStore } from "../events/store.js";
import {
  eventStorePath,
  projectRun,
  type ProjectedOperatorQuestion,
} from "./project.js";
import { readRunOwnedFile } from "./owned-file.js";

const MAX_OPERATOR_QUESTION_BYTES = 64 * 1024;

const operatorQuestionOptionSchema = z
  .object({
    id: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/),
    label: z.string().trim().min(1).max(500),
    recommended: z.boolean().optional(),
  })
  .strict();

export const operatorQuestionSchema = z
  .object({
    version: z.literal(1),
    question: z.string().trim().min(1).max(4_000),
    options: z.array(operatorQuestionOptionSchema).max(20).optional().default([]),
    context: z.string().trim().min(1).max(4_000).optional(),
  })
  .strict()
  .superRefine((question, context) => {
    const seen = new Set<string>();
    for (const [index, option] of question.options.entries()) {
      if (seen.has(option.id)) {
        context.addIssue({
          code: "custom",
          path: ["options", index, "id"],
          message: `duplicate option id: ${option.id}`,
        });
      }
      seen.add(option.id);
    }
    if (question.options.filter((option) => option.recommended).length > 1) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "at most one option may be recommended",
      });
    }
  });

export type OperatorQuestion = z.infer<typeof operatorQuestionSchema>;
export type OperatorQuestionOption = OperatorQuestion["options"][number];

export interface OperatorAnswerInput {
  optionId?: string;
  text?: string;
}

export interface ReadAttemptQuestionResult {
  path: string;
  raw: string;
  question: OperatorQuestion;
}

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "question";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export function parseOperatorQuestion(value: unknown): OperatorQuestion {
  const parsed = operatorQuestionSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`invalid structured question: ${validationMessage(parsed.error)}`);
  }
  return parsed.data;
}

export async function readAttemptQuestion(
  runDirectory: string,
  attemptDirectory: string,
): Promise<ReadAttemptQuestionResult | undefined> {
  const path = join(attemptDirectory, "question.json");
  let raw: string;
  try {
    const materialized = await readRunOwnedFile({
      runDirectory,
      path,
      subject: "structured question artifact path",
      maximumBytes: MAX_OPERATOR_QUESTION_BYTES,
    });
    raw = materialized.content.toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `invalid structured question: malformed JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return { path, raw, question: parseOperatorQuestion(value) };
}

export function questionIdForStageAttempt(stageId: string, attempt: number): string {
  return `${stageId}-${attempt}`;
}

export async function listQuestions(
  repoPath: string,
  runId: string,
): Promise<ProjectedOperatorQuestion[]> {
  const store = new EventStore(eventStorePath(repoPath));
  try {
    const events = store.list(runId);
    if (events.length === 0) throw new Error(`run not found: ${runId}`);
    return projectRun(events).questions ?? [];
  } finally {
    store.close();
  }
}

export async function answerQuestion(input: {
  repoPath: string;
  runId: string;
  questionId: string;
  answer: OperatorAnswerInput;
  actor?: string;
}): Promise<ProjectedOperatorQuestion> {
  const optionId = input.answer.optionId?.trim() || undefined;
  const text = input.answer.text?.trim() || undefined;
  if ((optionId ? 1 : 0) + (text ? 1 : 0) !== 1) {
    throw new Error("answer must provide exactly one of optionId or text");
  }
  const actor = redactText(input.actor?.trim() || "cli") ?? "cli";
  if (actor === AUTO_ANSWER_ACTOR) {
    throw new Error(`answer actor is reserved for the question policy: ${actor}`);
  }
  const redactedText = redactText(text);

  const store = new EventStore(eventStorePath(input.repoPath));
  try {
    return claimAndAnswerQuestion({
      store,
      runId: input.runId,
      questionId: input.questionId,
      answer: { actor, optionId, text: redactedText },
    })!;
  } finally {
    store.close();
  }
}

export function renderOperatorQuestionAnswer(
  question: ProjectedOperatorQuestion | undefined,
): string[] {
  if (!question || question.status !== "answered" || !question.answer) return [];
  const selected = question.answer.optionId
    ? question.options.find((option) => option.id === question.answer?.optionId)
    : undefined;
  return [
    "## Operator Question And Answer",
    "",
    `Question: ${question.question}`,
    ...(question.context ? [`Context: ${question.context}`] : []),
    ...(selected
      ? [`Selected option: ${selected.id} — ${selected.label}`]
      : question.answer.text
        ? [`Answer: ${question.answer.text}`]
        : []),
    `Answered by: ${question.answer.actor}`,
    `Answered at: ${question.answer.answeredAt}`,
    "",
    "Treat this operator answer as the authoritative decision for this attempt.",
    "",
  ];
}

export const DEFAULT_QUESTION_TIMEOUT_MS = 30 * 60 * 1000;
export const AUTO_ANSWER_ACTOR = "nitely:question-policy";

export interface ResolvedQuestionPolicy {
  mode: "ask" | "auto" | "deny";
  timeoutMs: number;
  onTimeout: "recommended" | "fail";
}

type QuestionPolicyInput = {
  mode?: "ask" | "auto" | "deny";
  timeoutMs?: number;
  onTimeout?: "recommended" | "fail";
};

/** Stage policy overrides flow policy field by field; unset fields use defaults. */
export function resolveQuestionPolicy(
  flowPolicy: QuestionPolicyInput | undefined,
  stagePolicy: QuestionPolicyInput | undefined,
): ResolvedQuestionPolicy {
  return {
    mode: stagePolicy?.mode ?? flowPolicy?.mode ?? "ask",
    timeoutMs:
      stagePolicy?.timeoutMs ?? flowPolicy?.timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS,
    onTimeout: stagePolicy?.onTimeout ?? flowPolicy?.onTimeout ?? "recommended",
  };
}

export function singleRecommendedOption(
  options: readonly OperatorQuestionOption[],
): OperatorQuestionOption | undefined {
  const recommended = options.filter((option) => option.recommended === true);
  return recommended.length === 1 ? recommended[0] : undefined;
}

export type AutoAnswerReason = "timeout" | "auto-policy";

type PolicyAnswerClaim =
  | { reason: "timeout"; now: Date }
  | { reason: "auto-policy" };

/**
 * All answer writers recheck the active pending question under SQLite's write lock.
 * Policy audit text comes exclusively from the persisted, runtime-redacted question.
 */
function claimAndAnswerQuestion(input: {
  store: EventStore;
  runId: string;
  questionId: string;
  answer?: { actor: string; optionId?: string; text?: string };
  policy?: PolicyAnswerClaim;
}): ProjectedOperatorQuestion | undefined {
  return input.store.transaction(() => {
    const events = input.store.list(input.runId);
    if (!events.length) throw new Error(`run not found: ${input.runId}`);
    const projection = projectRun(events);
    const question = projection.questions?.find((q) => q.id === input.questionId);
    if (!question) throw new Error(`question not found: ${input.questionId}`);
    if (question.status !== "pending") {
      if (input.policy) return undefined;
      throw new Error(`question ${input.questionId} is already answered`);
    }
    if (
      projection.status !== "blocked" ||
      projection.blocker?.reason !== "awaiting_operator_answer" ||
      projection.blocker.questionId !== question.id
    ) {
      if (input.policy) return undefined;
      throw new Error(`question is not the active run blocker: ${input.questionId}`);
    }
    const policy = input.policy;
    if (
      policy?.reason === "timeout" &&
      (question.policy?.mode !== "ask" || !question.expiresAt ||
        !Number.isFinite(Date.parse(question.expiresAt)) ||
        Date.parse(question.expiresAt) > policy.now.getTime())
    ) return undefined;
    if (policy?.reason === "auto-policy" && question.policy?.mode !== "auto") return undefined;
    const option = policy &&
      (policy.reason === "auto-policy" || question.policy?.onTimeout === "recommended")
      ? singleRecommendedOption(question.options) : undefined;
    if (policy?.reason === "auto-policy" && !option) {
      throw new Error(`stage ${question.stageId} asked a question without a single recommended option under question policy auto`);
    }
    const answer: {
      actor: string;
      optionId?: string;
      text?: string;
      reason?: AutoAnswerReason;
      failStage?: boolean;
    } = policy ? {
      actor: AUTO_ANSWER_ACTOR,
      reason: policy.reason,
      ...(option ? { optionId: option.id } : {
        text: `No answer adopted (${policy.reason}); failing stage per question policy.`,
        failStage: true,
      }),
    } : input.answer!;
    if (answer.optionId && !question.options.some((o) => o.id === answer.optionId)) {
      throw new Error(`question option not found: ${answer.optionId}`);
    }
    input.store.append({
      runId: input.runId,
      stageId: question.stageId,
      attempt: question.attempt,
      type: "operator.answer",
      payload: { questionId: question.id, ...answer },
    });
    if (policy) {
      input.store.append({
        runId: input.runId,
        stageId: question.stageId,
        attempt: question.attempt,
        type: "operator.question.auto-answered",
        payload: {
          questionId: question.id,
          question: question.question,
          reason: policy.reason,
          ...(option
            ? { optionId: option.id, optionLabel: option.label }
            : { outcome: "fail-stage" }),
        },
      });
    }
    const answered = projectRun(input.store.list(input.runId)).questions?.find((q) => q.id === question.id);
    if (!answered) throw new Error(`question not found after answering: ${question.id}`);
    return answered;
  });
}

export function appendAutoAnswer(input: {
  store: EventStore;
  runId: string;
  questionId: string;
} & PolicyAnswerClaim): ProjectedOperatorQuestion | undefined {
  return claimAndAnswerQuestion({
    store: input.store,
    runId: input.runId,
    questionId: input.questionId,
    policy: input,
  });
}

/**
 * Answers every expired `ask` question blocker in the repository according
 * to its recorded policy. Returns the run ids that are now ready to resume.
 */
export function answerExpiredQuestions(input: {
  repoPath: string;
  runIds?: readonly string[];
  now: Date;
}): string[] {
  const store = new EventStore(eventStorePath(input.repoPath));
  const ready: string[] = [];
  try {
    for (const runId of input.runIds ?? store.listRunIds()) {
      const events = store.list(runId);
      if (events.length === 0) continue;
      const projection = projectRun(events);
      if (
        projection.status !== "blocked" ||
        projection.blocker?.reason !== "awaiting_operator_answer"
      ) {
        continue;
      }
      const question = (projection.questions ?? []).find(
        (candidate) => candidate.id === projection.blocker?.questionId,
      );
      if (!question || question.status !== "pending" || !question.policy) continue;
      if (question.policy.mode !== "ask" || !question.expiresAt) continue;
      if (Date.parse(question.expiresAt) > input.now.getTime()) continue;
      if (appendAutoAnswer({ store, runId, questionId: question.id, reason: "timeout", now: input.now })) {
        ready.push(runId);
      }
    }
  } finally {
    store.close();
  }
  return ready;
}

/**
 * True when a run blocked on an operator question should be handed to the
 * scheduler: the policy already answered it, or its `ask` timeout expired.
 */
export function questionPolicyResumeDue(
  projection: ReturnType<typeof projectRun>,
  now: Date,
): boolean {
  if (
    projection.status !== "blocked" ||
    projection.blocker?.reason !== "awaiting_operator_answer"
  ) {
    return false;
  }
  const question = (projection.questions ?? []).find(
    (candidate) => candidate.id === projection.blocker?.questionId,
  );
  if (!question) return false;
  if (question.status === "answered") return question.answer?.actor === AUTO_ANSWER_ACTOR;
  return (
    question.policy?.mode === "ask" &&
    question.expiresAt !== undefined &&
    Date.parse(question.expiresAt) <= now.getTime()
  );
}

/** Includes answered policy blockers so recovery can retry after an interrupted sweep. */
export function questionPolicyResumeRunIds(repoPath: string, now: Date): string[] {
  const store = new EventStore(eventStorePath(repoPath));
  try {
    return store.listRunIds().filter((runId) => questionPolicyResumeDue(projectRun(store.list(runId)), now));
  } finally {
    store.close();
  }
}
