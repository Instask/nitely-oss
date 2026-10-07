import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { EventStore } from "../../src/events/store.js";
import { runFlow } from "../../src/run/run-flow.js";
import { projectRun } from "../../src/run/project.js";
import { LocalExecutionBackend } from "../../src/run/execution/local.js";
import type { ExecutionBackend } from "../../src/run/execution/types.js";

const execFileAsync = promisify(execFile);

async function fixture() {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-override-run-"));
  for (const args of [["init", "-b", "master"], ["config", "user.email", "nitely@example.test"], ["config", "user.name", "Nitely Test"]]) await execFileAsync("git", args, { cwd: repoPath });
  await writeFile(join(repoPath, "README.md"), "# Test\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repoPath });
  const original = {
    apiVersion: "nitely.dev/v1alpha1", kind: "Flow", metadata: { name: "override-all-stages" },
    spec: { stages: [
      { id: "implement", type: "agent", runtimes: [{ runtime: "codex", model: "gpt-original", effort: "low" }, { runtime: "claude", model: "claude-original", effort: "medium" }], prompt: "Implement.", inputs: [], outputs: ["implementation"] },
      { id: "judge", type: "judge", runtime: "codex", model: "gpt-original", effort: "low", prompt: "Judge.", criteria: ["correct"], inputs: ["implementation"], outputs: [{ id: "judge-result", mediaType: "application/json" }] },
      { id: "review", type: "gate", mode: "review", runtime: "codex", model: "gpt-original", effort: "low", prompt: "Review.", inputs: ["judge-result"], outputs: ["review"] },
    ] },
  };
  const flowDocument = JSON.stringify(original);
  const flowPath = join(repoPath, "flow.json");
  await writeFile(flowPath, flowDocument);
  return { repoPath, flowPath, flowDocument, original };
}

describe("run model and effort override evidence", () => {
  it.each([
    { runtime: "codex", model: "gpt-evaluation", effortStatus: "configured" },
    { runtime: "openrouter", model: "qwen/qwen3-coder-next", effortStatus: "not-applicable" },
  ])("records all agent overrides and effective effort for $model", async ({ runtime, model, effortStatus }) => {
    const { repoPath, flowPath, flowDocument, original } = await fixture();
    const observed: unknown[] = [];
    const local = new LocalExecutionBackend();
    const backend: ExecutionBackend = {
      createWorkspace: local.createWorkspace.bind(local),
      runCommand: local.runCommand.bind(local),
      commitAll: local.commitAll.bind(local),
      async runAgent(_workspace, { stage, attemptDirectory }) {
        observed.push({ id: stage.id, runtime: stage.runtime, model: stage.model, effort: stage.effort });
        const name = stage.id === "implement" ? "implementation.md" : stage.id === "judge" ? "judge-result.json" : "review.md";
        const content = stage.id === "judge" ? JSON.stringify({ verdict: "PASS", findings: [], evidence: ["implementation"] }) : stage.id === "review" ? "Review verdict: pass\nNo findings.\n" : "Implemented.\n";
        await writeFile(join(attemptDirectory, name), content);
        return { stdout: content, stderr: "" };
      },
    };
    const overrides = { runtime, model, effort: "high" as const };
    await runFlow({ repoPath, flowPath, inputs: {}, overrides }, { createRunId: () => "run-model-effort", backend });
    expect(observed).toEqual(["implement", "judge", "review"].map((id) => ({ id, ...overrides })));
    expect(await readFile(flowPath, "utf8")).toBe(flowDocument);
    const store = new EventStore(join(repoPath, ".nitely", "events.db"));
    const events = store.list("run-model-effort");
    store.close();
    expect(projectRun(events).status).toBe("completed");
    const created = events.find((event) => event.type === "run.created");
    expect(created?.payload).toMatchObject({ overrides });
    const createdPayload = created?.payload as { flowDocument: string };
    expect(JSON.parse(createdPayload.flowDocument)).toEqual(original);
    const selected = events.filter((event) => event.type === "stage.runtime.selected");
    expect(selected).toHaveLength(3);
    for (const event of selected) {
      expect(event.payload).toMatchObject({ model, effortStatus, requestedEffort: "high" });
      expect(event.payload).not.toHaveProperty("effort");
      if (effortStatus === "configured") expect(event.payload).toMatchObject({ nativeEffort: "high" });
      else expect(event.payload).not.toHaveProperty("nativeEffort");
    }
    const runDirectory = join(repoPath, ".nitely", "runs", "run-model-effort");
    const reproducibility = JSON.parse(await readFile(join(runDirectory, "reproducibility.json"), "utf8"));
    expect(reproducibility.flow).toMatchObject({ overrides });
    expect(reproducibility.runtimes).toHaveLength(3);
    for (const recorded of reproducibility.runtimes) {
      for (const choice of [recorded.selected, ...recorded.candidates]) {
        expect(choice).toMatchObject({ model, effortStatus, requestedEffort: "high" });
        expect(choice).not.toHaveProperty("effort");
        if (effortStatus === "configured") expect(choice).toMatchObject({ nativeEffort: "high" });
        else expect(choice).not.toHaveProperty("nativeEffort");
      }
    }
    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toContain(model);
    expect(evidence).toMatch(effortStatus === "configured" ? /effort[^\n]*high/i : /effort[^\n]*not-applicable/i);
  });

  it("records Codex off as native none in events, projection, reproducibility, and evidence", async () => {
    const { repoPath, flowPath, flowDocument, original } = await fixture();
    const local = new LocalExecutionBackend();
    const backend: ExecutionBackend = {
      createWorkspace: local.createWorkspace.bind(local),
      runCommand: local.runCommand.bind(local),
      commitAll: local.commitAll.bind(local),
      async runAgent(_workspace, { stage, attemptDirectory }) {
        const name = stage.id === "implement" ? "implementation.md" : stage.id === "judge" ? "judge-result.json" : "review.md";
        const content = stage.id === "judge" ? JSON.stringify({ verdict: "PASS", findings: [], evidence: ["implementation"] }) : stage.id === "review" ? "Review verdict: pass\nNo findings.\n" : "Implemented.\n";
        await writeFile(join(attemptDirectory, name), content);
        return { stdout: content, stderr: "" };
      },
    };
    const overrides = { runtime: "codex" as const, model: "gpt-5", effort: "off" as const };
    await runFlow({ repoPath, flowPath, inputs: {}, overrides }, { createRunId: () => "run-codex-off", backend });
    expect(await readFile(flowPath, "utf8")).toBe(flowDocument);
    const store = new EventStore(join(repoPath, ".nitely", "events.db"));
    const events = store.list("run-codex-off");
    store.close();
    const recorded = events.filter((event) => event.type === "stage.started" || event.type === "stage.runtime.selected");
    expect(recorded.length).toBeGreaterThan(0);
    for (const event of recorded) {
      expect(event.payload).toMatchObject({
        runtime: "codex",
        model: "gpt-5",
        requestedEffort: "off",
        nativeEffort: "none",
        effortStatus: "configured",
      });
      expect(event.payload).not.toHaveProperty("effort");
    }
    const projection = projectRun(events);
    const attempts = projection.stages.flatMap((stage) => stage.attempts).filter((attempt) => attempt.runtime);
    expect(attempts.length).toBeGreaterThan(0);
    for (const attempt of attempts) {
      expect(attempt).toMatchObject({
        requestedEffort: "off",
        nativeEffort: "none",
        effortStatus: "configured",
      });
    }
    const created = events.find((event) => event.type === "run.created");
    const createdPayload = created?.payload as { flowDocument: string };
    expect(JSON.parse(createdPayload.flowDocument)).toEqual(original);
    const runDirectory = join(repoPath, ".nitely", "runs", "run-codex-off");
    const reproducibility = JSON.parse(await readFile(join(runDirectory, "reproducibility.json"), "utf8"));
    expect(reproducibility.flow.overrides).toEqual(overrides);
    for (const recordedRuntime of reproducibility.runtimes) {
      for (const choice of [recordedRuntime.selected, ...recordedRuntime.candidates]) {
        expect(choice).toMatchObject({
          runtime: "codex",
          requestedEffort: "off",
          nativeEffort: "none",
          effortStatus: "configured",
        });
        expect(choice).not.toHaveProperty("effort");
      }
    }
    const evidence = await readFile(join(runDirectory, "evidence.md"), "utf8");
    expect(evidence).toMatch(/native none/);
    expect(evidence).toMatch(/requested off/);
    expect(evidence).not.toMatch(/model_reasoning_effort=off/);
  });
});
