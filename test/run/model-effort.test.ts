import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseFlowDocument } from "../../src/flow/load.js";
import { stageRuntimeCandidates } from "../../src/flow/schema.js";
import { canonicalOpenRouterModelId, resolveRuntimeEffort } from "../../src/run/execution/effort.js";
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

function recordingSpawn(calls: string[][]) {
  return (_command: string, args: readonly string[]) => {
    calls.push([...args]);
    const child = new EventEmitter() as EventEmitter & { stdin: Writable };
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) { callback(); },
      final(callback) { queueMicrotask(() => child.emit("close", 0)); callback(); },
    });
    return child;
  };
}

async function preflight(fields: Record<string, unknown>, options: {
  overrides?: { runtime?: string; model?: string; effort?: (typeof efforts)[number] };
  env?: NodeJS.ProcessEnv;
} = {}) {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-effort-preflight-"));
  await writeFile(join(repoPath, "flow.json"), document([stage(fields)]));
  return evaluateRunPreflight({
    repoPath,
    flowPath: "flow.json",
    inputs: {},
    ...(options.overrides ? { overrides: options.overrides } : {}),
    providerStore: new FileProviderConnectionStore({
      path: join(repoPath, "connections.json"),
      commandStatus: async () => true,
      env: options.env ?? {},
    }),
  });
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

  it("maps Nitely effort onto each runtime's native token", () => {
    expect(canonicalOpenRouterModelId("openrouter/qwen/qwen3-coder-next:free")).toBe("qwen/qwen3-coder-next");
    expect(canonicalOpenRouterModelId("~qwen/qwen3-coder-next:free")).toBe("qwen/qwen3-coder-next");
    expect(canonicalOpenRouterModelId("qwen/qwen3-coder-next")).toBe("qwen/qwen3-coder-next");
    expect(resolveRuntimeEffort({ runtime: "codex", effort: "off" })).toEqual({
      selection: { requestedEffort: "off", nativeEffort: "none", effortStatus: "configured" },
    });
    expect(resolveRuntimeEffort({ runtime: "codex", effort: "max" }).selection.nativeEffort).toBe("max");
    expect(resolveRuntimeEffort({ runtime: "claude", effort: "low" }).selection.nativeEffort).toBe("low");
    expect(resolveRuntimeEffort({ runtime: "claude", effort: "off" }).problem).toMatch(/runtime-effort-unsupported/);
    expect(resolveRuntimeEffort({ runtime: "claude", effort: "minimal" }).problem).toMatch(/cannot represent effort minimal/);
    expect(resolveRuntimeEffort({ runtime: "pi", effort: "off" }).selection.nativeEffort).toBe("off");
    expect(resolveRuntimeEffort({ runtime: "glm", effort: "high" }).problem).toMatch(/no effort mapping/);
    expect(resolveRuntimeEffort({
      runtime: "openrouter",
      model: "~qwen/qwen3-coder-next",
      effort: "xhigh",
    })).toEqual({
      selection: { requestedEffort: "xhigh", effortStatus: "not-applicable" },
    });
  });

  it.each([
    ["codex", "gpt-5", "off", "-c", "model_reasoning_effort=none"],
    ["codex", "gpt-5", "max", "-c", "model_reasoning_effort=max"],
    ["claude", "claude-sonnet-4-5", "low", "--effort", "low"],
    ["claude", "claude-sonnet-4-5", "max", "--effort", "max"],
    ["pi", "openai/gpt-oss-120b", "off", "--thinking", "off"],
    ["pi", "openai/gpt-oss-120b", "minimal", "--thinking", "minimal"],
    ["openrouter", "openai/gpt-oss-120b", "xhigh", "--thinking", "xhigh"],
    ["together", "moonshotai/Kimi-K3", "medium", "--thinking", "medium"],
  ] as const)("launches %s %s effort %s via %s %s", async (runtime, model, effort, flag, value) => {
    const calls: string[][] = [];
    const backend = new LocalExecutionBackend({
      env: { ANTHROPIC_API_KEY: "test", OPENROUTER_API_KEY: "test", TOGETHER_API_KEY: "test" },
      spawn: recordingSpawn(calls),
    });
    const parsed = parseFlowDocument(document([stage({ runtime, model, effort })])).flow.spec.stages[0];
    if (parsed.type !== "agent") throw new Error("expected agent stage");
    await backend.runAgent({ runId: "effort", path: "/repo/worktree" }, {
      stage: parsed, prompt: "Implement", attemptDirectory: "/repo/.nitely/runs/effort/stages/implement/1",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]![calls[0]!.indexOf(flag) + 1]).toBe(value);
    expect(calls[0]!.join(" ")).not.toContain("model_reasoning_effort=off");
  });

  it("resumes Codex with the same native effort token as the original launch", async () => {
    const calls: string[][] = [];
    const backend = new LocalExecutionBackend({ spawn: recordingSpawn(calls) });
    const parsed = parseFlowDocument(document([stage({ runtime: "codex", model: "gpt-5", effort: "off" })])).flow.spec.stages[0];
    if (parsed.type !== "agent") throw new Error("expected agent stage");
    const launch = { stage: parsed, prompt: "Implement", attemptDirectory: "/repo/.nitely/runs/effort/stages/implement/1" };
    await backend.runAgent({ runId: "effort", path: "/repo/worktree" }, launch);
    await backend.runAgent({ runId: "effort", path: "/repo/worktree" }, {
      ...launch,
      session: { resumeSessionId: "019bffff-1111-7111-8111-111111111111" },
    });
    expect(calls).toHaveLength(2);
    for (const argv of calls) {
      expect(argv).toContain("model_reasoning_effort=none");
      expect(argv.join(" ")).not.toContain("model_reasoning_effort=off");
    }
    expect(calls[1]).toContain("resume");
  });

  it.each(["off", "minimal"] as const)("does not launch Claude when effort %s cannot be represented", async (effort) => {
    const calls: string[][] = [];
    const backend = new LocalExecutionBackend({
      env: { ANTHROPIC_API_KEY: "test" },
      spawn: recordingSpawn(calls),
    });
    const parsed = parseFlowDocument(document([stage({ runtime: "claude", model: "claude-sonnet-4-5", effort })])).flow.spec.stages[0];
    if (parsed.type !== "agent") throw new Error("expected agent stage");
    await expect(backend.runAgent(
      { runId: "effort", path: "/repo/worktree" },
      { stage: parsed, prompt: "Implement", attemptDirectory: "/repo/.nitely/runs/effort/stages/implement/1" },
    )).rejects.toThrow(/runtime-effort-unsupported/);
    expect(calls).toHaveLength(0);
    const report = await preflight(
      { runtime: "claude", model: "claude-sonnet-4-5", effort },
      { env: { ANTHROPIC_API_KEY: "test" } },
    );
    expect(report.status).toBe("BLOCK");
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "blocking", code: "runtime-effort-unsupported" }),
    ]));
  });

  it.each([
    { runtime: "codex", model: "gpt-5", effort: "off" as const, env: {} },
    { runtime: "pi", model: "openai/gpt-oss-120b", effort: "minimal" as const, env: {} },
    { runtime: "claude", model: "claude-sonnet-4-5", effort: "high" as const, env: { ANTHROPIC_API_KEY: "test" } },
    { runtime: "openrouter", model: "openai/gpt-oss-120b", effort: "xhigh" as const, env: { OPENROUTER_API_KEY: "test" } },
    { runtime: "together", model: "moonshotai/Kimi-K3", effort: "low" as const, env: { TOGETHER_API_KEY: "test" } },
  ])("passes preflight for $runtime effort $effort when the runtime can represent it", async ({ runtime, model, effort, env }) => {
    const report = await preflight({ runtime, model, effort }, { env });
    expect(report.status).toBe("PASS");
    expect(report.issues).toEqual([]);
  });

  it.each([
    "qwen/qwen3-coder-next",
    "qwen/qwen3-coder-next:free",
    "~qwen/qwen3-coder-next",
    "~qwen/qwen3-coder-next:free",
  ])("keeps %s unchanged and omits --thinking", async (model) => {
    const calls: string[][] = [];
    const backend = new LocalExecutionBackend({
      env: { OPENROUTER_API_KEY: "test" },
      spawn: recordingSpawn(calls),
    });
    const parsed = parseFlowDocument(document([stage({ runtime: "openrouter", model, effort: "high" })])).flow.spec.stages[0];
    if (parsed.type !== "agent") throw new Error("expected agent stage");
    await backend.runAgent({ runId: "effort", path: "/repo/worktree" }, {
      stage: parsed, prompt: "Implement", attemptDirectory: "/repo/.nitely/runs/effort/stages/implement/1",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`openrouter/${model}`);
    expect(calls[0]).not.toContain("--thinking");
    expect(resolveRuntimeEffort({ runtime: "openrouter", model, effort: "high" })).toEqual({
      selection: { requestedEffort: "high", effortStatus: "not-applicable" },
    });
  });

  it("blocks when every fallback candidate cannot represent the overridden effort", async () => {
    const report = await preflight(
      { runtime: undefined, model: undefined, runtimes: [{ runtime: "glm" }, { runtime: "grok" }] },
      { overrides: { effort: "high" }, env: { NITELY_GLM_API_KEY: "test", NITELY_GROK_API_KEY: "test" } },
    );
    expect(report.status).toBe("BLOCK");
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "blocking",
        code: "runtime-effort-unsupported",
        runtime: "glm",
        message: expect.stringMatching(/zero viable runtime candidates/),
      }),
      expect.objectContaining({
        severity: "blocking",
        code: "runtime-effort-unsupported",
        runtime: "grok",
        message: expect.stringMatching(/zero viable runtime candidates/),
      }),
    ]));
  });

  it("keeps a stage runnable when one fallback candidate can represent effort", async () => {
    const report = await preflight(
      { runtime: undefined, model: undefined, runtimes: [{ runtime: "glm" }, { runtime: "codex" }] },
      { overrides: { effort: "high" }, env: { NITELY_GLM_API_KEY: "test" } },
    );
    expect(report.status).toBe("WARN");
    expect(report.issues).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "runtime-effort-unsupported",
        runtime: "glm",
      }),
    ]);
    expect(report.issues.some((issue) => issue.severity === "blocking")).toBe(false);
    expect(report.issues.some((issue) => /zero viable/.test(issue.message))).toBe(false);
  });

  it("blocks when every fallback model is invalid and warns when one remains valid", async () => {
    const blocked = await preflight(
      {
        runtime: undefined,
        model: undefined,
        runtimes: [
          { runtime: "openrouter", model: "not-a-model" },
          { runtime: "together", model: "not-a-model" },
        ],
      },
      { env: { OPENROUTER_API_KEY: "test", TOGETHER_API_KEY: "test" } },
    );
    expect(blocked.status).toBe("BLOCK");
    expect(blocked.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "blocking",
        code: "runtime-model-unsupported",
        message: expect.stringMatching(/zero viable runtime candidates/),
      }),
    ]));
    expect(blocked.issues.filter((issue) => issue.code === "runtime-model-unsupported")).toHaveLength(2);

    const runnable = await preflight(
      {
        runtime: undefined,
        model: undefined,
        runtimes: [
          { runtime: "openrouter", model: "not-a-model" },
          { runtime: "codex", model: "gpt-5" },
        ],
      },
      { env: { OPENROUTER_API_KEY: "test" } },
    );
    expect(runnable.status).toBe("WARN");
    expect(runnable.issues).toEqual([
      expect.objectContaining({ severity: "warning", code: "runtime-model-unsupported", runtime: "openrouter" }),
    ]);
  });
});
