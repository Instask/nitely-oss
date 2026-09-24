import { link, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import {
  answerQuestion,
  parseOperatorQuestion,
  readAttemptQuestion,
} from "../../src/run/questions.js";

describe("structured operator questions", () => {
  it("parses the versioned question contract", () => {
    expect(
      parseOperatorQuestion({
        version: 1,
        question: "Keep history?",
        options: [
          { id: "keep", label: "Keep history", recommended: true },
          { id: "purge", label: "Purge history" },
        ],
        context: "Affects retention.",
      }),
    ).toEqual({
      version: 1,
      question: "Keep history?",
      options: [
        { id: "keep", label: "Keep history", recommended: true },
        { id: "purge", label: "Purge history" },
      ],
      context: "Affects retention.",
    });
  });

  it("rejects duplicate ids and multiple recommended options", () => {
    expect(() =>
      parseOperatorQuestion({
        version: 1,
        question: "Choose",
        options: [
          { id: "same", label: "One", recommended: true },
          { id: "same", label: "Two", recommended: true },
        ],
      }),
    ).toThrow(/duplicate option id.*at most one option may be recommended/);
  });

  it("distinguishes a missing question from malformed JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nitely-question-"));
    await expect(readAttemptQuestion(directory, directory)).resolves.toBeUndefined();
    await writeFile(join(directory, "question.json"), "{broken", "utf8");
    await expect(readAttemptQuestion(directory, directory)).rejects.toThrow(
      /invalid structured question: malformed JSON/,
    );
  });

  it("does not read a question.json symbolic link", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-question-"));
    const runDirectory = join(root, "run-1");
    const attemptDirectory = join(runDirectory, "stages", "implement", "1");
    const outsidePath = join(root, "outside.json");
    await mkdir(attemptDirectory, { recursive: true });
    await writeFile(
      outsidePath,
      JSON.stringify({ version: 1, question: "Outside question?" }),
      "utf8",
    );
    await symlink(outsidePath, join(attemptDirectory, "question.json"));

    await expect(
      readAttemptQuestion(runDirectory, attemptDirectory),
    ).rejects.toThrow(/symbolic link/i);
  });

  it("does not read a question.json hard link", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-question-"));
    const runDirectory = join(root, "run-1");
    const attemptDirectory = join(runDirectory, "stages", "implement", "1");
    const outsidePath = join(root, "outside.json");
    await mkdir(attemptDirectory, { recursive: true });
    await writeFile(
      outsidePath,
      JSON.stringify({ version: 1, question: "Outside question?" }),
      "utf8",
    );
    await link(outsidePath, join(attemptDirectory, "question.json"));

    await expect(
      readAttemptQuestion(runDirectory, attemptDirectory),
    ).rejects.toThrow(/hard link/i);
  });

  it("answers only the active pending question once", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-question-events-"));
    await mkdir(join(repo, ".nitely"), { recursive: true });
    const store = new EventStore(join(repo, ".nitely", "events.db"));
    store.append({ runId: "run-1", type: "run.created", payload: {} });
    store.append({
      runId: "run-1",
      stageId: "implement",
      attempt: 1,
      type: "stage.question",
      payload: {
        questionId: "implement-1",
        question: {
          version: 1,
          question: "Keep history?",
          options: [{ id: "keep", label: "Keep history" }],
        },
      },
    });
    const blocker = {
      reason: "awaiting_operator_answer",
      stageId: "implement",
      questionId: "implement-1",
      message: "Keep history?",
    };
    store.append({
      runId: "run-1",
      stageId: "implement",
      attempt: 1,
      type: "stage.blocked",
      payload: blocker,
    });
    store.append({ runId: "run-1", type: "run.blocked", payload: blocker });
    store.close();

    await expect(
      answerQuestion({
        repoPath: repo,
        runId: "run-1",
        questionId: "implement-1",
        answer: { optionId: "missing" },
        actor: "operator@example.test",
      }),
    ).rejects.toThrow(/question option not found/);

    const answered = await answerQuestion({
      repoPath: repo,
      runId: "run-1",
      questionId: "implement-1",
      answer: { optionId: "keep" },
      actor: "operator@example.test",
    });
    expect(answered).toMatchObject({
      status: "answered",
      answer: { optionId: "keep", actor: "operator@example.test" },
    });
    await expect(
      answerQuestion({
        repoPath: repo,
        runId: "run-1",
        questionId: "implement-1",
        answer: { text: "Again" },
      }),
    ).rejects.toThrow(/already answered/);
  });
});
