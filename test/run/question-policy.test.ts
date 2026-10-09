import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { EventStore } from "../../src/events/store.js";
import { FlowValidationError, loadFlow } from "../../src/flow/load.js";
import type { ExecutionBackend } from "../../src/run/execution/types.js";
import { projectRun } from "../../src/run/project.js";
import {
  AUTO_ANSWER_ACTOR,
  DEFAULT_QUESTION_TIMEOUT_MS,
  answerExpiredQuestions,
  answerQuestion,
  appendAutoAnswer,
  questionPolicyResumeDue,
  resolveQuestionPolicy,
} from "../../src/run/questions.js";
import { resumeRun, runFlow } from "../../src/run/run-flow.js";

import { runSchedulerOnce } from "../../src/scheduler/run.js";
import { listUnifiedWorkItems } from "../../src/work-items/access.js";
import { runWebUsageLimitRecovery } from "../../src/web/server.js";
import { createTask, updateTaskRunState } from "../../src/web/tasks.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  return await execFileAsync("git", args, { cwd });
}

async function createRepo() {
  const repo = await mkdtemp(join(tmpdir(), "nitely-question-policy-"));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "nitely@example.test"]);
  await git(repo, ["config", "user.name", "Nitely Test"]);
  await writeFile(join(repo, "README.md"), "# Test Repo\n", "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

function backend(repo: string, runAgent: ExecutionBackend["runAgent"]): ExecutionBackend {
  return {
    async createWorkspace({ runId, branchName, worktreePath }) {
      await git(repo, ["worktree", "add", "-b", branchName, worktreePath, "HEAD"]);
      return { runId, path: worktreePath };
    },
    runAgent,
    async runCommand() {
      throw new Error("command should not run");
    },
    async commitAll() {
      return { committed: false };
    },
  };
}

async function writeFlow(
  repo: string,
  name: string,
  questions: { flow?: unknown; stage?: unknown },
  maxAttempts = 1,
) {
  const flowPath = join(repo, "flows", `${name}.json`);
  await writeJson(flowPath, {
    apiVersion: "nitely.dev/v1alpha1",
    kind: "Flow",
    metadata: { name },
    spec: {
      maxAttempts,
      ...(questions.flow ? { questions: questions.flow } : {}),
      stages: [
        {
          id: "implement",
          type: "agent",
          runtime: "mock",
          prompt: "Implement safely.",
          inputs: [],
          outputs: ["implementation"],
          ...(questions.stage ? { questions: questions.stage } : {}),
        },
      ],
    },
  });
  return flowPath;
}

const recommendedQuestion = {
  version: 1,
  question: "Continue writing tests without modifying src/?",
  options: [
    { id: "continue", label: "Continue", recommended: true },
    { id: "wait", label: "Wait for permissions" },
  ],
};

const unrecommendedQuestion = {
  version: 1,
  question: "Which retention policy?",
  options: [
    { id: "keep", label: "Keep" },
    { id: "purge", label: "Purge" },
  ],
};

/** Asks on the first call, then writes the output on later calls. */
function askThenImplement(repo: string, question: unknown, prompts: string[]) {
  return backend(repo, async (_workspace, input) => {
    prompts.push(input.prompt);
    if (prompts.length === 1) {
      await writeJson(join(input.attemptDirectory, "question.json"), question);
      return { stdout: "asked\n", stderr: "" };
    }
    await writeFile(join(input.attemptDirectory, "implementation.md"), "done\n", "utf8");
    return { stdout: "done\n", stderr: "" };
  });
}

function events(repo: string, runId: string) {
  const store = new EventStore(join(repo, ".nitely", "events.db"));
  try {
    return store.list(runId);
  } finally {
    store.close();
  }
}

describe("question policy schema", () => {
  it("accepts flow and stage policies and lets the stage override the flow", async () => {
    const repo = await createRepo();
    const flowPath = await writeFlow(repo, "valid-policy", {
      flow: { mode: "ask", timeoutMs: 1000, onTimeout: "fail" },
      stage: { mode: "auto" },
    });
    const loaded = await loadFlow(flowPath);
    const stage = loaded.flow.spec.stages[0] as { questions?: unknown };
    expect(
      resolveQuestionPolicy(
        loaded.flow.spec.questions,
        stage.questions as Parameters<typeof resolveQuestionPolicy>[1],
      ),
    ).toEqual({ mode: "auto", timeoutMs: 1000, onTimeout: "fail" });
  });

  it("defaults to ask with a 30 minute timeout adopting the recommended option", () => {
    expect(resolveQuestionPolicy(undefined, undefined)).toEqual({
      mode: "ask",
      timeoutMs: DEFAULT_QUESTION_TIMEOUT_MS,
      onTimeout: "recommended",
    });
    expect(DEFAULT_QUESTION_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  it.each([
    { flow: { mode: "sometimes" } },
    { flow: { timeoutMs: 0 } },
    { stage: { onTimeout: "retry" } },
    { stage: { mode: "auto", extra: true } },
  ])("rejects invalid policy %j", async (questions) => {
    const repo = await createRepo();
    const flowPath = await writeFlow(repo, "invalid-policy", questions);
    await expect(loadFlow(flowPath)).rejects.toBeInstanceOf(FlowValidationError);
  });
});

describe("question policy runtime", () => {
  it("auto adopts the single recommended option and continues without resume", async () => {
    const repo = await createRepo();
    const flowPath = await writeFlow(repo, "auto-policy", { flow: { mode: "auto" } }, 2);
    const prompts: string[] = [];
    const runId = "run-auto-policy";
    await runFlow(
      { flowPath, repoPath: repo, inputs: {} },
      { createRunId: () => runId, backend: askThenImplement(repo, recommendedQuestion, prompts) },
    );

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Selected option: continue — Continue");
    expect(prompts[1]).toContain(`Answered by: ${AUTO_ANSWER_ACTOR}`);
    const runEvents = events(repo, runId);
    const autoAnswered = runEvents.find(
      (event) => event.type === "operator.question.auto-answered",
    );
    expect(autoAnswered?.payload).toMatchObject({
      questionId: "implement-1",
      optionId: "continue",
      reason: "auto-policy",
    });
    const projection = projectRun(runEvents);
    expect(projection.status).toBe("completed");
    expect(projection.questions?.[0]).toMatchObject({
      status: "answered",
      answer: { optionId: "continue", actor: AUTO_ANSWER_ACTOR, reason: "auto-policy" },
    });
    const evidence = await readFile(join(repo, ".nitely", "runs", runId, "evidence.md"), "utf8");
    expect(evidence).toContain("Auto-answered: auto-policy");
  });

  it("auto fails the stage when no single option is recommended", async () => {
    const repo = await createRepo();
    const flowPath = await writeFlow(repo, "auto-no-recommended", { flow: { mode: "auto" } });
    const runId = "run-auto-no-recommended";
    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        { createRunId: () => runId, backend: askThenImplement(repo, unrecommendedQuestion, []) },
      ),
    ).rejects.toThrow(/without a single recommended option/);
    const types = events(repo, runId).map((event) => event.type);
    expect(types).toContain("stage.failed");
    expect(types).not.toContain("run.blocked");
    expect(types).not.toContain("operator.question.auto-answered");
  });

  it("deny removes the question instruction and fails a stage that asks anyway", async () => {
    const repo = await createRepo();
    const flowPath = await writeFlow(repo, "deny-policy", { stage: { mode: "deny" } });
    const prompts: string[] = [];
    const runId = "run-deny-policy";
    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        { createRunId: () => runId, backend: askThenImplement(repo, recommendedQuestion, prompts) },
      ),
    ).rejects.toThrow(/question policy is deny/);
    expect(prompts[0]).not.toContain("## Structured Operator Question");
    const types = events(repo, runId).map((event) => event.type);
    expect(types).toContain("stage.failed");
    expect(types).not.toContain("run.blocked");
  });

  it("ask records the policy and resumes with the recommended option after the timeout", async () => {
    const repo = await createRepo();
    const flowPath = await writeFlow(repo, "ask-timeout", {}, 2);
    const prompts: string[] = [];
    const runId = "run-ask-timeout";
    const agent = askThenImplement(repo, recommendedQuestion, prompts);
    await expect(
      runFlow({ flowPath, repoPath: repo, inputs: {} }, { createRunId: () => runId, backend: agent }),
    ).rejects.toThrow(/awaiting_operator_answer/);
    expect(prompts[0]).toContain("## Structured Operator Question");

    const blocked = projectRun(events(repo, runId));
    const question = blocked.questions?.[0];
    expect(question?.policy).toEqual({
      mode: "ask",
      timeoutMs: DEFAULT_QUESTION_TIMEOUT_MS,
      onTimeout: "recommended",
    });
    const askedAt = Date.parse(question!.askedAt);
    expect(Date.parse(question!.expiresAt!)).toBe(askedAt + DEFAULT_QUESTION_TIMEOUT_MS);

    const early = new Date(askedAt + DEFAULT_QUESTION_TIMEOUT_MS - 1);
    expect(questionPolicyResumeDue(blocked, early)).toBe(false);
    expect(answerExpiredQuestions({ repoPath: repo, runIds: [runId], now: early })).toEqual([]);

    const late = new Date(askedAt + DEFAULT_QUESTION_TIMEOUT_MS + 1);
    expect(questionPolicyResumeDue(blocked, late)).toBe(true);
    expect(answerExpiredQuestions({ repoPath: repo, runIds: [runId], now: late })).toEqual([runId]);
    const answered = projectRun(events(repo, runId));
    expect(answered.questions?.[0]?.answer).toMatchObject({
      optionId: "continue",
      actor: AUTO_ANSWER_ACTOR,
      reason: "timeout",
    });
    expect(questionPolicyResumeDue(answered, late)).toBe(true);

    await resumeRun({ repoPath: repo, runId }, { backend: agent });
    expect(prompts[1]).toContain("Selected option: continue — Continue");
    expect(projectRun(events(repo, runId)).status).toBe("completed");
  });

  it("ask timeout without a recommended option fails the stage on resume", async () => {
    const repo = await createRepo();
    const flowPath = await writeFlow(repo, "ask-timeout-fail", {
      flow: { timeoutMs: 1000 },
    });
    const runId = "run-ask-timeout-fail";
    const prompts: string[] = [];
    const agent = askThenImplement(repo, unrecommendedQuestion, prompts);
    await expect(
      runFlow({ flowPath, repoPath: repo, inputs: {} }, { createRunId: () => runId, backend: agent }),
    ).rejects.toThrow(/awaiting_operator_answer/);
    const askedAt = Date.parse(projectRun(events(repo, runId)).questions![0]!.askedAt);
    expect(
      answerExpiredQuestions({ repoPath: repo, runIds: [runId], now: new Date(askedAt + 2000) }),
    ).toEqual([runId]);
    const autoAnswered = events(repo, runId).find(
      (event) => event.type === "operator.question.auto-answered",
    );
    expect(autoAnswered?.payload).toMatchObject({ reason: "timeout", outcome: "fail-stage" });

    await expect(resumeRun({ repoPath: repo, runId }, { backend: agent })).rejects.toThrow();
    expect(prompts).toHaveLength(1);
    const types = events(repo, runId).map((event) => event.type);
    expect(types.filter((type) => type === "stage.failed")).toHaveLength(1);
    expect(projectRun(events(repo, runId)).status).toBe("failed");
  });

  it("does not auto-answer a question a human already answered or a non-ask policy", async () => {
    const repo = await createRepo();
    const flowPath = await writeFlow(repo, "ask-human", { flow: { onTimeout: "fail" } });
    const runId = "run-ask-human";
    await expect(
      runFlow(
        { flowPath, repoPath: repo, inputs: {} },
        { createRunId: () => runId, backend: askThenImplement(repo, recommendedQuestion, []) },
      ),
    ).rejects.toThrow(/awaiting_operator_answer/);
    const late = new Date(Date.now() + DEFAULT_QUESTION_TIMEOUT_MS * 2);
    expect(answerExpiredQuestions({ repoPath: repo, runIds: [runId], now: late })).toEqual([runId]);
    // onTimeout=fail never adopts the recommended option.
    expect(projectRun(events(repo, runId)).questions?.[0]?.answer).toMatchObject({
      failStage: true,
      reason: "timeout",
    });
    // A second sweep is a no-op because the question is no longer pending.
    expect(answerExpiredQuestions({ repoPath: repo, runIds: [runId], now: late })).toEqual([]);
  });
});

async function blockedQuestionRun(maxAttempts = 2, question: unknown = recommendedQuestion) {
  const repo = await createRepo();
  const flowPath = await writeFlow(repo, "recovery", { flow: { timeoutMs: 1000 } }, maxAttempts);
  const runId = "run-recovery";
  const prompts: string[] = [];
  const agent = askThenImplement(repo, question, prompts);
  await expect(runFlow({ flowPath, repoPath: repo, inputs: {} }, {
    createRunId: () => runId, backend: agent,
  })).rejects.toThrow(/awaiting_operator_answer/);
  const pending = projectRun(events(repo, runId)).questions![0]!;
  return { repo, runId, prompts, agent, pending, late: new Date(Date.parse(pending.expiresAt!) + 1) };
}

describe("question answer recovery invariants", () => {
  it("scheduler discovers standalone runs repository-wide, leaves non-expired runs untouched, and resumes once", async () => {
    const { repo, runId, prompts, agent, pending, late } = await blockedQuestionRun();
    expect(await listUnifiedWorkItems(repo)).toEqual([]);
    const resumer = vi.fn((input: Parameters<typeof resumeRun>[0]) => resumeRun(input, { backend: agent }));
    await runSchedulerOnce({ repoPath: repo, now: () => new Date(Date.parse(pending.expiresAt!) - 1), resumeRun: resumer });
    expect(resumer).not.toHaveBeenCalled();
    expect(projectRun(events(repo, runId)).questions![0]!.status).toBe("pending");
    await runSchedulerOnce({ repoPath: repo, now: () => late, resumeRun: resumer });
    await runSchedulerOnce({ repoPath: repo, now: () => late, resumeRun: resumer });
    expect(resumer).toHaveBeenCalledTimes(1);
    expect(prompts[1]).toContain("Selected option: continue — Continue");
    expect(projectRun(events(repo, runId)).status).toBe("completed");
    expect(events(repo, runId).filter((e) => e.type === "operator.answer")).toHaveLength(1);
  });

  it.each(["human", "policy"] as const)("%s wins against another connection's stale pending observation", async (winner) => {
    const { repo, runId, agent, prompts, pending, late } = await blockedQuestionRun();
    const policyStore = new EventStore(join(repo, ".nitely", "events.db"));
    try {
      // Both paths have observed pending before either claims the answer.
      expect(projectRun(policyStore.list(runId)).questions![0]!.status).toBe("pending");
      const human = () => answerQuestion({ repoPath: repo, runId, questionId: pending.id, answer: { optionId: "wait" }, actor: "human" });
      const policy = () => appendAutoAnswer({ store: policyStore, runId, questionId: pending.id, reason: "timeout", now: late });
      if (winner === "human") {
        await human();
        expect(policy()).toBeUndefined();
      } else {
        expect(policy()?.answer?.optionId).toBe("continue");
        await expect(human()).rejects.toThrow(/already answered/);
      }
      expect(answerExpiredQuestions({ repoPath: repo, now: late })).toEqual([]);
      const history = events(repo, runId);
      expect(history.filter((e) => e.type === "operator.answer")).toHaveLength(1);
      expect(history.filter((e) => e.type === "operator.question.auto-answered")).toHaveLength(winner === "policy" ? 1 : 0);
      const label = winner === "human" ? "wait — Wait for permissions" : "continue — Continue";
      await resumeRun({ repoPath: repo, runId }, { backend: agent });
      expect(prompts[1]).toContain(`Selected option: ${label}`);
      expect(projectRun(events(repo, runId)).questions![0]!.answer?.optionId).toBe(winner === "human" ? "wait" : "continue");
      const evidence = await readFile(join(repo, ".nitely", "runs", runId, "evidence.md"), "utf8");
      expect(evidence).toContain(winner === "human" ? "Wait for permissions" : "Continue");
    } finally { policyStore.close(); }
  });

  it("rolls back the answer when writing its audit fails, then commits both together", async () => {
    const { repo, runId, pending, late } = await blockedQuestionRun();
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    const observer = new EventStore(join(repo, ".nitely", "events.db"));
    try {
      const append = store.append.bind(store);
      const spy = vi.spyOn(store, "append").mockImplementation((event) => {
        if (event.type === "operator.question.auto-answered") {
          expect(observer.list(runId).some((e) => e.type === "operator.answer")).toBe(false);
          throw new Error("audit write failed");
        }
        return append(event);
      });
      expect(() => appendAutoAnswer({ store, runId, questionId: pending.id, reason: "timeout", now: late })).toThrow("audit write failed");
      expect(observer.list(runId).filter((e) => e.type.startsWith("operator."))).toEqual([]);
      spy.mockRestore();
      appendAutoAnswer({ store, runId, questionId: pending.id, reason: "timeout", now: late });
      expect(observer.list(runId).filter((e) => e.type.startsWith("operator.")).map((e) => e.type)).toEqual(["operator.answer", "operator.question.auto-answered"]);
    } finally { store.close(); observer.close(); }
  });

  it("consumes timeout failure once and really runs the retry agent", async () => {
    const { repo, runId, prompts, agent, late } = await blockedQuestionRun(3, unrecommendedQuestion);
    answerExpiredQuestions({ repoPath: repo, now: late });
    await resumeRun({ repoPath: repo, runId }, {
      backend: agent,
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).not.toContain("## Operator Question And Answer");
    const history = events(repo, runId);
    expect(history.filter((e) => e.type === "stage.failed")).toHaveLength(1);
    expect(history.find((e) => e.type === "orchestrator.decision")?.payload).toMatchObject({ action: "retry" });
    expect(projectRun(history).status).toBe("completed");
    expect(projectRun(history).questions![0]!.answer?.failStage).toBe(true);
    expect(await readFile(join(repo, ".nitely", "runs", runId, "evidence.md"), "utf8")).toContain("stage failed");
  });

  it("redacts immediate auto audit from persisted runtime data, including backend secrets", async () => {
    const repo = await createRepo();
    const flowPath = await writeFlow(repo, "redacted-auto", { flow: { mode: "auto" } }, 2);
    const secret = "runtime-only-private-value";
    const prompts: string[] = [];
    const agent = askThenImplement(repo, {
      version: 1, question: `Continue with ${secret}?`, context: `Use ${secret}`,
      options: [{ id: "continue", label: `Adopt ${secret}`, recommended: true }],
    }, prompts);
    agent.redactionSecrets = () => [secret];
    const runId = "run-redacted-auto";
    await runFlow({ flowPath, repoPath: repo, inputs: {} }, { createRunId: () => runId, backend: agent });
    const history = events(repo, runId);
    for (const type of ["stage.question", "operator.answer", "operator.question.auto-answered"]) {
      const event = history.find((e) => e.type === type);
      expect(event).toBeDefined();
      expect(JSON.stringify(event)).not.toContain(secret);
    }
    expect(history.find((e) => e.type === "operator.question.auto-answered")?.payload).toMatchObject({
      question: "Continue with [REDACTED]?", optionLabel: "Adopt [REDACTED]",
    });
    expect(prompts[1]).toContain("Adopt [REDACTED]");
    expect(await readFile(join(repo, ".nitely", "runs", runId, "evidence.md"), "utf8")).not.toContain(secret);
  });

  it("Web and scheduler double observation claims a standalone continuation only once", async () => {
    const { repo, runId, pending, agent, late } = await blockedQuestionRun();
    // A sweep may have committed the answer and exited before dispatching resume.
    expect(answerExpiredQuestions({ repoPath: repo, now: late })).toEqual([runId]);
    let started!: () => void;
    let release!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const resumer = vi.fn(async (input: Parameters<typeof resumeRun>[0]) => {
      started();
      await releasePromise;
      return resumeRun(input, { backend: agent });
    });
    const first = runSchedulerOnce({ repoPath: repo, now: () => late, resumeRun: resumer });
    await startedPromise;
    try {
      await runWebUsageLimitRecovery({ repoPath: repo, repositories: [{ id: "test-repo", path: repo }], host: "127.0.0.1", port: 0, authMode: "local", resumeRun: resumer });
      expect(resumer).toHaveBeenCalledTimes(1);
    } finally { release(); await first; }
    expect(projectRun(events(repo, runId)).status).toBe("completed");
    expect(events(repo, runId).filter((e) => e.type === "operator.answer")).toHaveLength(1);
    expect(events(repo, runId).filter((e) => e.type === "operator.question.auto-answered")).toHaveLength(1);
    expect(pending.id).toBe("implement-1");
  });

  it("Web discovers and recovers an expired standalone pending question", async () => {
    const { repo, runId, agent } = await blockedQuestionRun();
    // Persist an expired timestamp without relying on a wall-clock sleep.
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    try {
      const question = store.list(runId).find((e) => e.type === "stage.question")!;
      store.append({ runId, stageId: question.stageId, attempt: question.attempt, type: "stage.question", payload: question.payload, createdAt: new Date(Date.now() - 2000).toISOString() });
    } finally { store.close(); }
    const resumer = vi.fn((input: Parameters<typeof resumeRun>[0]) => resumeRun(input, { backend: agent }));
    await runWebUsageLimitRecovery({ repoPath: repo, repositories: [{ id: "test-repo", path: repo }], host: "127.0.0.1", port: 0, authMode: "local", resumeRun: resumer });
    expect(resumer).toHaveBeenCalledTimes(1);
    expect(projectRun(events(repo, runId)).status).toBe("completed");
  });

  it("Web recovery skips a task whose latest run has no events instead of abandoning the sweep", async () => {
    const { repo, runId, agent } = await blockedQuestionRun();
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    try {
      const question = store.list(runId).find((e) => e.type === "stage.question")!;
      store.append({ runId, stageId: question.stageId, attempt: question.attempt, type: "stage.question", payload: question.payload, createdAt: new Date(Date.now() - 2000).toISOString() });
    } finally { store.close(); }
    // An imported or historical task can point at a run this repository's
    // event store never recorded; projecting it throws.
    const orphan = await createTask(repo, { title: "Historical task", spec: "Spec", techDesign: "Design" });
    await updateTaskRunState(repo, orphan.id, { status: "failed", latestRunId: "run-imported-without-events" });
    const resumer = vi.fn((input: Parameters<typeof resumeRun>[0]) => resumeRun(input, { backend: agent }));
    await runWebUsageLimitRecovery({ repoPath: repo, repositories: [{ id: "test-repo", path: repo }], host: "127.0.0.1", port: 0, authMode: "local", resumeRun: resumer });
    expect(resumer).toHaveBeenCalledTimes(1);
    expect(projectRun(events(repo, runId)).status).toBe("completed");
  });
});
