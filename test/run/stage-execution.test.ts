import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import type { Stage } from "../../src/flow/schema.js";
import {
  beginRuntimeCandidateAttempt,
  beginStageAttempt,
  maxAttemptsForStage,
  prepareStageAttempt,
} from "../../src/run/stage-execution.js";

describe("beginStageAttempt", () => {
  it.skipIf(process.platform !== "linux")(
    "creates the attempt directory and records the default stage.started runtime candidate",
    async () => {
      const eventStore = new EventStore(":memory:");
      const runDirectory = await mkdtemp(join(tmpdir(), "nitely-stage-execution-"));
      const stage: Stage = {
        id: "implement",
        type: "agent",
        runtime: "codex",
        prompt: "Implement the work",
        inputs: [],
        outputs: ["patch"],
        skills: [],
        required_mcp_servers: [],
        required_connectors: [],
      };

      try {
        const attempt = await beginStageAttempt({
          eventStore,
          runId: "run-1",
          runDirectory,
          stage,
          attempt: 1,
        });

        expect(attempt.attemptDirectory).toBe(
          join(runDirectory, "stages", "implement", "1"),
        );
        expect((await stat(attempt.attemptDirectory)).isDirectory()).toBe(true);
        expect(eventStore.list("run-1")).toMatchObject([
          {
            runId: "run-1",
            stageId: "implement",
            attempt: 1,
            type: "stage.started",
            payload: {
              attemptDirectory: attempt.attemptDirectory,
              type: "agent",
              runtime: "codex",
              runtimeCandidateIndex: 0,
              runtimeCandidateCount: 1,
            },
          },
        ]);
      } finally {
        eventStore.close();
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "records explicit runtime candidate metadata, resume source, and branch head",
    async () => {
      const eventStore = new EventStore(":memory:");
      const runDirectory = await mkdtemp(
        join(tmpdir(), "nitely-stage-execution-resume-"),
      );
      const stage: Stage = {
        id: "review",
        type: "gate",
        mode: "review",
        runtimes: [
          { runtime: "codex" },
          { runtime: "anthropic", model: "claude-sonnet-4" },
        ],
        prompt: "Review the output",
        inputs: ["patch"],
        outputs: ["review"],
        skills: [],
        required_mcp_servers: [],
        required_connectors: [],
      };

      try {
        const attempt = await beginStageAttempt({
          eventStore,
          runId: "run-2",
          runDirectory,
          stage,
          attempt: 2,
          resumedFrom: "blocked",
          branchHeadSha: "1234567890abcdef1234567890abcdef12345678",
          runtimeCandidate: {
            candidate: { runtime: "anthropic", model: "claude-sonnet-4" },
            index: 1,
            count: 2,
          },
        });

        expect(eventStore.list("run-2")).toMatchObject([
          {
            runId: "run-2",
            stageId: "review",
            attempt: 2,
            type: "stage.started",
            payload: {
              attemptDirectory: attempt.attemptDirectory,
              type: "gate",
              resumedFrom: "blocked",
              branchHeadSha: "1234567890abcdef1234567890abcdef12345678",
              runtime: "anthropic",
              model: "claude-sonnet-4",
              runtimeCandidateIndex: 1,
              runtimeCandidateCount: 2,
            },
          },
        ]);
      } finally {
        eventStore.close();
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "keeps create exclusive while ensure remains idempotent",
    async () => {
      const eventStore = new EventStore(":memory:");
      const runDirectory = await mkdtemp(join(tmpdir(), "nitely-stage-execution-mode-"));
      const stage = {
        id: "release",
        type: "command",
        command: "./scripts/nitely/release-production",
        inputs: [],
        outputs: ["release-report"],
      } as Stage;

      try {
        await beginStageAttempt({
          eventStore,
          runId: "run-mode",
          runDirectory,
          stage,
          attempt: 1,
        });
        await expect(
          beginStageAttempt({
            eventStore,
            runId: "run-mode",
            runDirectory,
            stage,
            attempt: 1,
          }),
        ).rejects.toMatchObject({ code: "EEXIST" });
        await expect(
          beginStageAttempt({
            eventStore,
            runId: "run-mode",
            runDirectory,
            stage,
            attempt: 1,
            directoryMode: "ensure",
          }),
        ).resolves.toMatchObject({
          attemptDirectory: join(runDirectory, "stages", "release", "1"),
        });
      } finally {
        eventStore.close();
      }
    },
  );

  it.skipIf(process.platform === "linux")(
    "fails closed when descriptor-relative anchoring is unavailable",
    async () => {
      const eventStore = new EventStore(":memory:");
      const runDirectory = await mkdtemp(join(tmpdir(), "nitely-stage-execution-portable-"));
      const stage = {
        id: "release",
        type: "command",
        command: "./scripts/nitely/release-production",
        inputs: [],
        outputs: ["release-report"],
      } as Stage;

      try {
        await expect(
          beginStageAttempt({
            eventStore,
            runId: "run-portable",
            runDirectory,
            stage,
            attempt: 1,
          }),
        ).rejects.toThrow(/requires Linux descriptor-relative path anchoring/);
        expect(eventStore.list("run-portable")).toEqual([]);
      } finally {
        eventStore.close();
      }
    },
  );

  it("rejects unsafe stage ids before creating an attempt directory", async () => {
    const eventStore = new EventStore(":memory:");
    const stage = {
      id: "../escape",
      type: "command",
      command: "true",
      inputs: [],
      outputs: [],
    } as Stage;

    try {
      await expect(
        beginStageAttempt({
          eventStore,
          runId: "run-3",
          runDirectory: await mkdtemp(join(tmpdir(), "nitely-stage-execution-bad-")),
          stage,
          attempt: 1,
        }),
      ).rejects.toThrow("stage id");
      expect(eventStore.list("run-3")).toEqual([]);
    } finally {
      eventStore.close();
    }
  });
});

describe("maxAttemptsForStage", () => {
  it("prefers stage attempts, then flow attempts, then one attempt", () => {
    const commandStage = {
      id: "test",
      type: "command",
      command: "pnpm test",
      inputs: [],
      outputs: [],
    } as Stage;

    expect(maxAttemptsForStage(commandStage, 4)).toBe(4);
    expect(maxAttemptsForStage({ ...commandStage, maxAttempts: 2 }, 4)).toBe(2);
    expect(maxAttemptsForStage(commandStage, undefined)).toBe(1);
  });
});

describe("beginRuntimeCandidateAttempt", () => {
  it.skipIf(process.platform !== "linux")(
    "shares candidate attempt creation for agent and review execution paths",
    async () => {
      const eventStore = new EventStore(":memory:");
      const runDirectory = await mkdtemp(join(tmpdir(), "nitely-runtime-candidate-"));
      const stage = {
        id: "implement",
        type: "agent",
        runtimes: [{ runtime: "codex" }, { runtime: "anthropic" }],
        prompt: "Implement",
        inputs: [],
        outputs: [],
        skills: [],
        required_mcp_servers: [],
        required_connectors: [],
      } as Extract<Stage, { type: "agent" }>;

      try {
        const first = await beginStageAttempt({
          eventStore,
          runId: "run-candidate",
          runDirectory,
          stage,
          attempt: 1,
        });
        const selected = await beginRuntimeCandidateAttempt({
          eventStore,
          runId: "run-candidate",
          runDirectory,
          stage,
          baseAttempt: 1,
          attemptDirectory: first.attemptDirectory,
          candidate: { runtime: "anthropic" },
          index: 1,
          count: 2,
          resumedFrom: "interrupted",
          branchHeadSha: "abc123",
        });

        expect(selected).toMatchObject({
          attempt: 2,
          stage: { runtime: "anthropic" },
          attemptDirectory: join(runDirectory, "stages", "implement", "2"),
        });
        expect(eventStore.list("run-candidate")).toMatchObject([
          {},
          {
            attempt: 2,
            type: "stage.started",
            payload: {
              resumedFrom: "interrupted",
              branchHeadSha: "abc123",
              runtime: "anthropic",
              runtimeCandidateIndex: 1,
              runtimeCandidateCount: 2,
            },
          },
        ]);
      } finally {
        eventStore.close();
      }
    },
  );
});

describe("prepareStageAttempt", () => {
  it.skipIf(process.platform !== "linux")(
    "prepares instructions before starting the attempt and checks cancellation after it starts",
    async () => {
      const eventStore = new EventStore(":memory:");
      const runDirectory = await mkdtemp(join(tmpdir(), "nitely-stage-prepare-"));
      const stage = {
        id: "implement",
        type: "command",
        command: "true",
        inputs: [],
        outputs: [],
      } as Stage;
      const events: string[] = [];

      try {
        const attempt = await prepareStageAttempt({
          begin: {
            eventStore,
            runId: "run-prepare",
            runDirectory,
            stage,
            attempt: 1,
          },
          prepare: async () => {
            events.push("prepare");
          },
          onStageChange: () => events.push("stage-change"),
          assertNotCancelled: () => events.push("checked"),
        });

        expect(attempt.attemptDirectory).toBe(
          join(runDirectory, "stages", "implement", "1"),
        );
        expect(events).toEqual(["prepare", "stage-change", "checked"]);
      } finally {
        eventStore.close();
      }
    },
  );
});
