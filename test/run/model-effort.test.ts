import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseFlowDocument } from "../../src/flow/load.js";
import { stageRuntimeCandidates } from "../../src/flow/schema.js";
import { LocalExecutionBackend } from "../../src/run/execution/local.js";
import { evaluateRunPreflight } from "../../src/run/preflight.js";
import { FileProviderConnectionStore } from "../../src/providers/file-store.js";

const efforts = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function document(stages: unknown[]) {
  return JSON.stringify({ apiVersion: "nitely.dev/v1alpha1", kind: "Flow", metadata: { name: "model-effort" }, spec: { stages } });
}

function stage(fields: Record<string, unknown> = {}) {
  return { id: "implement", type: "agent", runtime: "codex", model: "original-model", prompt: "Implement.", inputs: [], outputs: ["implementation"], ...fields };
}

describe("model evaluation effort contract", () => {
  it.each(efforts)("preserves %s on agent, judge, review gate and ordered candidates", (effort) => {
    for (const fields of [
      {},
      { type: "judge", criteria: ["correct"] },
      { type: "gate", mode: "review" },
      { runtime: undefined, model: undefined, runtimes: [{ runtime: "codex", model: "candidate-model", effort }] },
    ]) {
      const loaded = parseFlowDocument(document([stage({ ...fields, ...(fields.runtimes ? {} : { effort }) })]));
      if (!fields.runtimes) expect(loaded.flow.spec.stages[0]).toMatchObject({ effort });
      const parsed = loaded.flow.spec.stages[0];
      if (parsed.type !== "agent" && parsed.type !== "judge" && !(parsed.type === "gate" && parsed.mode === "review")) throw new Error("expected agent runnable stage");
      expect(stageRuntimeCandidates(parsed)).toEqual([
        expect.objectContaining({ effort }),
      ]);
    }
  });

  it.each(["ultra", "HIGH", "", 42, null])("rejects invalid effort %j with an effort diagnostic", (effort) => {
    expect(() => parseFlowDocument(document([stage({ effort })]))).toThrow(/effort/i);
    expect(() => parseFlowDocument(document([stage({ runtime: undefined, model: undefined, runtimes: [{ runtime: "codex", effort }] })]))).toThrow(/effort/i);
  });

  it("rejects effort on command stages instead of discarding it", () => {
    expect(() => parseFlowDocument(document([{ id: "test", type: "command", command: "true", effort: "high", inputs: [], outputs: ["report"] }]))).toThrow(/effort/i);
  });

  it.each([
    ["openrouter", "openai/gpt-oss-120b:free", "--thinking", "high"],
    ["pi", "openai/gpt-oss-120b", "--thinking", "high"],
    ["together", "openai/gpt-oss-120b", "--thinking", "high"],
    ["claude", "claude-sonnet-4-5", "--effort", "high"],
    ["codex", "gpt-5", "-c", "model_reasoning_effort=high"],
  ])("launches %s with explicit effort argv, preserving the model id", async (runtime, model, flag, value) => {
    const calls: string[][] = [];
    const backend = new LocalExecutionBackend({
      env: { ANTHROPIC_API_KEY: "test", OPENROUTER_API_KEY: "test", TOGETHER_API_KEY: "test", NITELY_TOGETHER_API_KEY: "test" },
      spawn: (_command, args) => {
        calls.push([...args]);
        const child = new EventEmitter() as EventEmitter & { stdin: Writable };
        child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); }, final(callback) { queueMicrotask(() => child.emit("close", 0)); callback(); } });
        return child;
      },
    });
    const parsed = parseFlowDocument(document([stage({ runtime, model, effort: "high" })])).flow.spec.stages[0];
    if (parsed.type !== "agent") throw new Error("expected agent stage");
    await backend.runAgent({ runId: "effort", path: "/repo/worktree" }, { stage: parsed, prompt: "Implement", attemptDirectory: "/repo/.nitely/runs/effort/stages/implement/1" });
    expect(calls).toHaveLength(1);
    const argv = calls[0];
    expect(argv[argv.indexOf(flag) + 1]).toBe(value);
    expect(argv).toContain(runtime === "openrouter" ? `openrouter/${model}` : model);
    expect(argv.join(" ")).not.toContain(`${model}:high`);
  });

  it("does not send a thinking flag to Qwen Coder Next even when effort was requested", async () => {
    const calls: string[][] = [];
    const backend = new LocalExecutionBackend({
      env: { OPENROUTER_API_KEY: "test" },
      spawn: (_command, args) => {
        calls.push([...args]);
        const child = new EventEmitter() as EventEmitter & { stdin: Writable };
        child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); }, final(callback) { queueMicrotask(() => child.emit("close", 0)); callback(); } });
        return child;
      },
    });
    const parsed = parseFlowDocument(document([stage({ runtime: "openrouter", model: "qwen/qwen3-coder-next:free", effort: "high" })])).flow.spec.stages[0];
    if (parsed.type !== "agent") throw new Error("expected agent stage");
    await backend.runAgent({ runId: "effort", path: "/repo/worktree" }, { stage: parsed, prompt: "Implement", attemptDirectory: "/repo/.nitely/runs/effort/stages/implement/1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("openrouter/qwen/qwen3-coder-next:free");
    expect(calls[0]).not.toContain("--thinking");
  });

  it.each(["mock", "glm", "grok"])("blocks effort on unsupported %s runtime during preflight", async (runtime) => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-effort-preflight-"));
    await writeFile(join(repoPath, "flow.json"), document([stage({ runtime, effort: "high" })]));
    const report = await evaluateRunPreflight({ repoPath, flowPath: "flow.json", inputs: {}, providerStore: new FileProviderConnectionStore({ path: join(repoPath, "connections.json"), commandStatus: async () => true, env: { NITELY_GLM_API_KEY: "test", NITELY_GROK_API_KEY: "test" } }) });
    expect(report.status).toBe("BLOCK");
    expect(report.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "runtime-effort-unsupported" })]));
  });

  it("validates an overridden model against the overridden runtime during preflight", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-model-preflight-"));
    await writeFile(join(repoPath, "flow.json"), document([stage()]));
    const report = await evaluateRunPreflight({
      repoPath, flowPath: "flow.json", inputs: {},
      overrides: { runtime: "openrouter", model: "invalid-model-without-author", effort: "high" },
      providerStore: new FileProviderConnectionStore({ path: join(repoPath, "connections.json"), commandStatus: async () => true, env: { OPENROUTER_API_KEY: "test" } }),
    });
    expect(report.status).toBe("BLOCK");
    expect(report.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "runtime-model-unsupported", runtime: "openrouter" })]));
  });
});
