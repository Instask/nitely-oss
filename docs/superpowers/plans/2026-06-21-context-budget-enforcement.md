# Context Budget Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in per-stage `maxInputTokens` context budget that auto-shrinks oversized prompts (dropping the largest inputs to path-only) and fails the attempt only when minimal context still overflows.

**Architecture:** A `fitPromptToBudget` gate wraps prompt assembly at the three prompt-bearing call sites (agent stage, review-gate, resume agent stage). It re-renders the prompt forcing the largest inputs to path-only until `approxTokens ≤ budget` (emitting `budget.trimmed`), or fails with `budget.exceeded`. Builds on the #65 MVP's `renderInputContext` / `renderPrompt` / `ContextUsage` and event→projection→web pipeline.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node, Zod, Vitest. Web SPA is `src/web/static/console.dc.html`.

## Global Constraints

- ESM imports use `.js` extensions even for `.ts` sources.
- Tests run with Vitest: `npx vitest run <file>`.
- macOS: integration tests creating run dirs must use a non-symlinked tmpdir — prefix `TMPDIR=/Users/leo/.tmptest` (run `mkdir -p /Users/leo/.tmptest` first). Pure-function unit tests don't need this.
- Budget unit is `approxTokens = ceil(promptBytes/4)` (existing `ContextUsage.approxTokens`). Compare `approxTokens` against `maxInputTokens`.
- `maxInputTokens` is opt-in: a no-op when unresolved. Resolution: `stage.maxInputTokens ?? spec.maxInputTokens`. No global default.
- `maxInputTokens` is valid ONLY on agent and review-gate stages and the flow `spec`; reject it elsewhere (`.never()`), mirroring how `skills`/`timeoutMs` are scoped.
- The shrink lever is path-only: a trimmed textual input keeps metadata + path + the mandatory-read instruction; never a finer head re-trim.
- Branch: `impl/issue-65-budget-enforcement` (worktree `.worktrees/issue-65-enforce`), stacked on PR #74.

---

### Task 1: Schema field `maxInputTokens` + resolution helper

**Files:**
- Modify: `src/flow/schema.ts`
- Modify: `src/run/run-flow.ts` (add `resolveMaxInputTokens` near `maxAttemptsForStage` at line 1397)
- Test: `test/flow/load.test.ts` (schema), `test/run/run-flow.test.ts` (resolution — or a focused unit if `resolveMaxInputTokens` is exported; see step)

**Interfaces:**
- Produces:
  - Flow `spec.maxInputTokens?: number`; `agentStageSchema`/`reviewGateStageSchema` gain `maxInputTokens?: number`; other stages reject it.
  - `export function resolveMaxInputTokens(stage: Stage, flowMaxInputTokens: number | undefined): number | undefined`

- [ ] **Step 1: Write the failing schema tests**

Add to `test/flow/load.test.ts` (match the file's existing flow-parsing helper/imports):

```ts
it("accepts maxInputTokens on agent stages and flow spec", () => {
  const flow = parseFlowDocument(`
apiVersion: nitely.dev/v1alpha1
kind: Flow
metadata:
  name: budgeted
spec:
  maxInputTokens: 4000
  stages:
    - id: implement
      type: agent
      runtime: codex
      prompt: do it
      maxInputTokens: 2000
      outputs: [impl]
`);
  expect(flow.spec.maxInputTokens).toBe(4000);
  const stage = flow.spec.stages[0];
  expect("maxInputTokens" in stage && stage.maxInputTokens).toBe(2000);
});

it("rejects maxInputTokens on command stages", () => {
  expect(() =>
    parseFlowDocument(`
apiVersion: nitely.dev/v1alpha1
kind: Flow
metadata:
  name: bad
spec:
  stages:
    - id: build
      type: command
      command: make
      maxInputTokens: 1000
`),
  ).toThrow(/maxInputTokens is only valid on agent and review gate stages/);
});
```

Use the real parse function name from `test/flow/load.test.ts` (it parses a flow document string and throws on invalid input — match the existing cases in that file).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/flow/load.test.ts -t "maxInputTokens"`
Expected: FAIL — field not recognized / no error thrown for command stage.

- [ ] **Step 3: Add the schema field + rejection**

In `src/flow/schema.ts`:

Add a rejection schema next to `nonAgentSkillsSchema` (after line 56):

```ts
const nonBudgetedMaxInputTokensSchema = z
  .never({ error: "maxInputTokens is only valid on agent and review gate stages" })
  .optional();
```

Add `maxInputTokens: z.number().int().positive().optional(),` to `agentStageSchema`'s `.extend({...})` (alongside `prompt`) and to `reviewGateStageSchema`'s `.extend({...})`.

Add `maxInputTokens: nonBudgetedMaxInputTokensSchema,` to each non-prompt stage's `.extend({...})`: `commandStageSchema`, `deterministicGateStageSchema`, `approvalStageSchema`, `publishChangeStageSchema`, `updateChangeStageSchema`, `syncChangeStageSchema`.

Add `maxInputTokens: z.number().int().positive().optional(),` to the flow `spec` object (alongside `maxAttempts`, line 157).

- [ ] **Step 4: Add the resolution helper**

In `src/run/run-flow.ts`, directly below `maxAttemptsForStage` (line 1397-1399):

```ts
export function resolveMaxInputTokens(
  stage: Stage,
  flowMaxInputTokens: number | undefined,
): number | undefined {
  const stageMax = "maxInputTokens" in stage ? stage.maxInputTokens : undefined;
  return stageMax ?? flowMaxInputTokens;
}
```

- [ ] **Step 5: Add the resolution unit test**

Add to `test/run/run-flow.test.ts` (it can import `resolveMaxInputTokens` directly — pure function, no tmpdir):

```ts
import { resolveMaxInputTokens } from "../../src/run/run-flow.js";

describe("resolveMaxInputTokens", () => {
  const base = { id: "s", type: "agent", runtime: "codex", prompt: "p", inputs: [], outputs: ["o"], skills: [] } as unknown as import("../../src/flow/schema.js").Stage;
  it("prefers stage over flow, falls back to flow, else undefined", () => {
    expect(resolveMaxInputTokens({ ...base, maxInputTokens: 10 } as never, 99)).toBe(10);
    expect(resolveMaxInputTokens(base, 99)).toBe(99);
    expect(resolveMaxInputTokens(base, undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run test/flow/load.test.ts -t "maxInputTokens"` → PASS
Run: `TMPDIR=/Users/leo/.tmptest npx vitest run test/run/run-flow.test.ts -t "resolveMaxInputTokens"` → PASS
Run: `npm run check` → no errors

- [ ] **Step 7: Commit**

```bash
git add src/flow/schema.ts src/run/run-flow.ts test/flow/load.test.ts test/run/run-flow.test.ts
git commit -m "feat: add opt-in maxInputTokens schema field and resolution"
```

---

### Task 2: `forcePathOnly` rendering option

**Files:**
- Modify: `src/run/run-flow.ts` (`renderInputContext` 1013, `renderInputs` 1104, `renderPrompt` 1199)
- Test: `test/run/render-input-context.test.ts`

**Interfaces:**
- Consumes: `renderInputContext(input, context)` from the MVP (returns `{ block, usage }`).
- Produces:
  - `renderInputContext(input, context, options?: { forcePathOnly?: boolean })` — when `forcePathOnly` is true on a textual input, render metadata + path + mandatory-read instruction, `usage = { inlinedBytes: 0, savedBytes: <full redacted bytes> }`.
  - `renderInputs(inputs, context, forcedPathOnlyIds?: Set<string>)` — unchanged return shape `{ text, inputBytesInlined, inputBytesSaved, inputCount }`.
  - `renderPrompt(stage, flowName, inputs, attemptDirectory, context, skills, previousFailures?, forcedPathOnlyIds?)` — unchanged return shape `{ prompt, contextUsage }`.

- [ ] **Step 1: Write the failing test**

Add to `test/run/render-input-context.test.ts` (reuse its `context()` and `input()` helpers):

```ts
it("forcePathOnly renders a textual input as path-only with mandatory read", () => {
  const { block, usage } = renderInputContext(input("a short body"), context(), { forcePathOnly: true });
  expect(block).toContain("Full content: /repo/.nitely/runs/run-1/inputs/spec/content");
  expect(block).toContain("MUST read the full file");
  expect(block).not.toContain("a short body");
  expect(usage.inlinedBytes).toBe(0);
  expect(usage.savedBytes).toBe(Buffer.byteLength("a short body"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/run/render-input-context.test.ts -t "forcePathOnly"`
Expected: FAIL — third arg ignored; content still inlined.

- [ ] **Step 3: Implement `forcePathOnly` in `renderInputContext`**

Change the signature and add a forced branch. The current textual region (after the binary check, around line 1074) computes `redactedFull`/`fullBytes`. Insert a forced-path-only branch immediately before the `fullBytes <= INPUT_INLINE_FULL_LIMIT` check.

Signature:

```ts
export function renderInputContext(
  input: InputArtifact,
  context: RuntimeContext,
  options?: { forcePathOnly?: boolean },
): { block: string; usage: InputContextUsage } {
```

After `const fullBytes = Buffer.byteLength(redactedFull, "utf8");`, add:

```ts
  if (options?.forcePathOnly) {
    return {
      block: [
        ...header,
        "",
        "Content omitted to fit the stage context budget — full content at the path above.",
        `You MUST read the full file at ${fullPath} before using this input. Do not proceed without it.`,
      ].join("\n"),
      usage: { inlinedBytes: 0, savedBytes: fullBytes },
    };
  }
```

(The omitted-by-policy and binary early-returns above are unaffected; `forcePathOnly` only changes textual inputs that would otherwise inline.)

- [ ] **Step 4: Thread the flag through `renderInputs` and `renderPrompt`**

`renderInputs` (line 1104):

```ts
function renderInputs(
  inputs: Map<string, InputArtifact>,
  context: RuntimeContext,
  forcedPathOnlyIds?: Set<string>,
): { text: string; inputBytesInlined: number; inputBytesSaved: number; inputCount: number } {
  const blocks: string[] = [];
  let inputBytesInlined = 0;
  let inputBytesSaved = 0;
  let inputCount = 0;
  for (const input of inputs.values()) {
    const { block, usage } = renderInputContext(input, context, {
      forcePathOnly: forcedPathOnlyIds?.has(input.id) ?? false,
    });
    blocks.push(block);
    inputBytesInlined += usage.inlinedBytes;
    inputBytesSaved += usage.savedBytes;
    inputCount += 1;
  }
  return { text: blocks.join("\n\n"), inputBytesInlined, inputBytesSaved, inputCount };
}
```

`renderPrompt` (line 1199): add a trailing parameter and pass it to `renderInputs`. Locate the `renderInputs(inputs, context)` call inside `renderPrompt` and change it to `renderInputs(inputs, context, forcedPathOnlyIds)`. Add the parameter to the signature:

```ts
function renderPrompt(
  stage: ...,            // unchanged existing params
  flowName: string,
  inputs: Map<string, InputArtifact>,
  attemptDirectory: string,
  context: RuntimeContext,
  skills: LoadedSkill[],
  previousFailures: PreviousFailure[] = [],
  forcedPathOnlyIds?: Set<string>,
): { prompt: string; contextUsage: ContextUsage } {
```

(Match the existing exact parameter list/types in the file; only append `forcedPathOnlyIds?: Set<string>`.)

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run test/run/render-input-context.test.ts` → PASS (all, incl. new)
Run: `TMPDIR=/Users/leo/.tmptest npx vitest run test/run/run-flow.test.ts` → PASS (renderPrompt callers still compile/behave; default forced set is undefined → unchanged)
Run: `npm run check` → no errors

- [ ] **Step 6: Commit**

```bash
git add src/run/run-flow.ts test/run/render-input-context.test.ts
git commit -m "feat: add forcePathOnly rendering option for budget trimming"
```

---

### Task 3: `fitPromptToBudget` gate + budget events

**Files:**
- Modify: `src/events/types.ts` (event union)
- Modify: `src/run/run-flow.ts` (add `BudgetOutcome`, `fitPromptToBudget`)
- Test: `test/run/run-flow.test.ts` (unit, pure — uses a fake `render`)

**Interfaces:**
- Consumes: `renderInputContext` (Task 2), `ContextUsage`, `InputArtifact`, `RuntimeContext`.
- Produces:
  - `"budget.trimmed"`, `"budget.exceeded"` added to `RunEventType`.
  - `export interface BudgetOutcome { status: "ok" | "trimmed" | "exceeded"; budget?: number; approxTokensBefore?: number; approxTokensAfter?: number; approxTokens?: number; trimmedInputIds?: string[] }`
  - `export function fitPromptToBudget(input: { inputs: Map<string, InputArtifact>; context: RuntimeContext; budget: number | undefined; render: (forcedPathOnlyIds: Set<string>) => { prompt: string; contextUsage: ContextUsage } }): { prompt: string; contextUsage: ContextUsage; outcome: BudgetOutcome }`

- [ ] **Step 1: Write the failing unit test**

Add to `test/run/run-flow.test.ts` (pure — no tmpdir). It uses a fake `render` whose `approxTokens` drops as inputs are forced:

```ts
import { fitPromptToBudget, renderInputContext as _ric } from "../../src/run/run-flow.js";

describe("fitPromptToBudget", () => {
  function ctx() {
    return { runId: "r", runDirectory: "/repo/.nitely/runs/r", manifestEntries: [], manifestEntryIndexes: new Map(), artifactEntries: [], artifactEntryIndexes: new Map(), redactionSecrets: [] };
  }
  function art(id: string, body: string) {
    return { id, reference: { connector: "generated", uri: "/x" }, resource: { sourceUri: id, mediaType: "text/markdown", content: Buffer.from(body), metadata: { filename: id } }, contentPath: `/repo/.nitely/runs/r/inputs/${id}/content` } as never;
  }
  const inputs = new Map<string, never>([["big", art("big", "x".repeat(40000))], ["small", art("small", "y".repeat(100))]]);
  // fake render: base 100 tokens + 100 tokens per non-forced input
  const render = (forced: Set<string>) => {
    const live = [...inputs.keys()].filter((id) => !forced.has(id)).length;
    const approxTokens = 100 + live * 100;
    return { prompt: `forced=${[...forced].join(",")}`, contextUsage: { promptBytes: approxTokens * 4, approxTokens, inputBytesInlined: 0, inputBytesSaved: 0, inputCount: inputs.size } };
  };

  it("returns ok when under budget", () => {
    const r = fitPromptToBudget({ inputs: inputs as never, context: ctx(), budget: 1000, render });
    expect(r.outcome.status).toBe("ok");
  });
  it("trims the largest input first until it fits", () => {
    const r = fitPromptToBudget({ inputs: inputs as never, context: ctx(), budget: 250, render });
    expect(r.outcome.status).toBe("trimmed");
    expect(r.outcome.trimmedInputIds).toEqual(["big"]); // big has more inlined bytes, forced first
    expect(r.outcome.approxTokensAfter).toBeLessThanOrEqual(250);
  });
  it("reports exceeded when minimal context still overflows", () => {
    const r = fitPromptToBudget({ inputs: inputs as never, context: ctx(), budget: 50, render });
    expect(r.outcome.status).toBe("exceeded");
    expect(r.outcome.approxTokens).toBe(100); // both forced, base remains
  });
  it("is a no-op when budget is undefined", () => {
    const r = fitPromptToBudget({ inputs: inputs as never, context: ctx(), budget: undefined, render });
    expect(r.outcome.status).toBe("ok");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `TMPDIR=/Users/leo/.tmptest npx vitest run test/run/run-flow.test.ts -t "fitPromptToBudget"`
Expected: FAIL — `fitPromptToBudget` is not exported.

- [ ] **Step 3: Add the event types**

In `src/events/types.ts`, add to `RunEventType` (after `"stage.context.usage"`):

```ts
  | "budget.trimmed"
  | "budget.exceeded"
```

- [ ] **Step 4: Implement `fitPromptToBudget`**

In `src/run/run-flow.ts`, after `appendContextUsageEvent` (line 1268 area):

```ts
export interface BudgetOutcome {
  status: "ok" | "trimmed" | "exceeded";
  budget?: number;
  approxTokensBefore?: number;
  approxTokensAfter?: number;
  approxTokens?: number;
  trimmedInputIds?: string[];
}

export function fitPromptToBudget(input: {
  inputs: Map<string, InputArtifact>;
  context: RuntimeContext;
  budget: number | undefined;
  render: (forcedPathOnlyIds: Set<string>) => {
    prompt: string;
    contextUsage: ContextUsage;
  };
}): { prompt: string; contextUsage: ContextUsage; outcome: BudgetOutcome } {
  const forced = new Set<string>();
  let { prompt, contextUsage } = input.render(forced);
  if (input.budget === undefined || contextUsage.approxTokens <= input.budget) {
    return { prompt, contextUsage, outcome: { status: "ok" } };
  }
  const before = contextUsage.approxTokens;
  // Order inputs by how many bytes they currently inline (largest first).
  const candidates = [...input.inputs.values()]
    .map((artifact) => ({
      id: artifact.id,
      inlinedBytes: renderInputContext(artifact, input.context).usage.inlinedBytes,
    }))
    .filter((entry) => entry.inlinedBytes > 0)
    .sort((left, right) => right.inlinedBytes - left.inlinedBytes);
  const trimmedInputIds: string[] = [];
  for (const candidate of candidates) {
    forced.add(candidate.id);
    trimmedInputIds.push(candidate.id);
    ({ prompt, contextUsage } = input.render(forced));
    if (contextUsage.approxTokens <= input.budget) {
      return {
        prompt,
        contextUsage,
        outcome: {
          status: "trimmed",
          budget: input.budget,
          approxTokensBefore: before,
          approxTokensAfter: contextUsage.approxTokens,
          trimmedInputIds,
        },
      };
    }
  }
  return {
    prompt,
    contextUsage,
    outcome: {
      status: "exceeded",
      budget: input.budget,
      approxTokens: contextUsage.approxTokens,
    },
  };
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `TMPDIR=/Users/leo/.tmptest npx vitest run test/run/run-flow.test.ts -t "fitPromptToBudget"` → PASS (4)
Run: `npm run check` → no errors

- [ ] **Step 6: Commit**

```bash
git add src/events/types.ts src/run/run-flow.ts test/run/run-flow.test.ts
git commit -m "feat: add fitPromptToBudget gate and budget event types"
```

---

### Task 4: Wire the gate into the three call sites (trim + fail)

**Files:**
- Modify: `src/run/run-flow.ts` (`executeGateStage` input type + 2 callers; the 3 `renderPrompt` call sites at 693, 2812, 3909)
- Test: `test/run/run-flow.test.ts` (integration — needs `TMPDIR`)

**Interfaces:**
- Consumes: `fitPromptToBudget`, `resolveMaxInputTokens`, the `budget.trimmed`/`budget.exceeded` event types.
- Produces: budget events emitted per attempt; attempt fails on `exceeded`. Adds a private `appendBudgetEvent` helper.

- [ ] **Step 1: Write the failing integration tests**

Add to `test/run/run-flow.test.ts` (match the existing agent-flow harness with a fake `executeAgent` + `EventStore`; the agent must write the required outputs so the stage completes). Two cases:

```ts
it("auto-trims an oversized input to fit maxInputTokens and records budget.trimmed", async () => {
  // Build a flow with an agent stage: maxInputTokens small, plus one large input artifact.
  // Run it; the fake executeAgent writes the required output and captures the prompt.
  const { events, capturedPrompt, runId } = await runAgentFlowWithBudget({ maxInputTokens: 200, inputBody: "x".repeat(40000) });
  const trimmed = events.find((e) => e.type === "budget.trimmed");
  expect(trimmed).toBeDefined();
  expect((trimmed!.payload as { trimmedInputIds: string[] }).trimmedInputIds.length).toBeGreaterThan(0);
  // The prompt handed to the agent must reference the path, not the 40k body.
  expect(capturedPrompt).not.toContain("x".repeat(1000));
  expect(capturedPrompt).toContain("MUST read the full file");
});

it("fails the attempt with budget.exceeded when minimal context overflows", async () => {
  // maxInputTokens tiny enough that the fixed prompt (instructions/outputs) alone exceeds it.
  const { events, runStatus } = await runAgentFlowWithBudget({ maxInputTokens: 1, inputBody: "small" });
  expect(events.find((e) => e.type === "budget.exceeded")).toBeDefined();
  expect(runStatus).toBe("failed");
});
```

Implement `runAgentFlowWithBudget` inline using the file's existing flow-run helpers (the same pattern the MVP usage-event test used to build a flow, supply `executeAgent`, run `runFlow`, and list events). The fake `executeAgent` should capture `prompt` and write the stage's required output file so the non-failing case completes.

- [ ] **Step 2: Run to verify it fails**

Run: `TMPDIR=/Users/leo/.tmptest npx vitest run test/run/run-flow.test.ts -t "budget"`
Expected: FAIL — no `budget.trimmed`/`budget.exceeded` events; oversized body still inlined.

- [ ] **Step 3: Add the budget-event helper**

In `src/run/run-flow.ts`, near `appendContextUsageEvent`:

```ts
function appendBudgetEvent(input: {
  eventStore: EventStore;
  runId: string;
  stageId: string;
  attempt: number;
  outcome: BudgetOutcome;
  context: RuntimeContext;
}): void {
  if (input.outcome.status === "trimmed") {
    input.eventStore.append({
      runId: input.runId,
      stageId: input.stageId,
      attempt: input.attempt,
      type: "budget.trimmed",
      payload: redactRuntimeUnknown(
        {
          budget: input.outcome.budget,
          approxTokensBefore: input.outcome.approxTokensBefore,
          approxTokensAfter: input.outcome.approxTokensAfter,
          trimmedInputIds: input.outcome.trimmedInputIds,
        },
        input.context,
      ),
    });
  } else if (input.outcome.status === "exceeded") {
    input.eventStore.append({
      runId: input.runId,
      stageId: input.stageId,
      attempt: input.attempt,
      type: "budget.exceeded",
      payload: redactRuntimeUnknown(
        { budget: input.outcome.budget, approxTokens: input.outcome.approxTokens },
        input.context,
      ),
    });
  }
}
```

- [ ] **Step 4: Thread the flow-level budget into `executeGateStage`**

Add `flowMaxInputTokens?: number;` to the `executeGateStage` input type (after `flowName: string;`, line 601). At its two callers (line ~2887 and ~4052) add `flowMaxInputTokens: loaded.flow.spec.maxInputTokens,` alongside the existing `flowName: loaded.flow.metadata.name,`.

- [ ] **Step 5: Replace each of the three `renderPrompt` call sites**

Each site currently does:

```ts
const { prompt, contextUsage } = renderPrompt(stage, flowName, scopedInputs, attemptDir, ctx, skills, prevFailures?);
appendContextUsageEvent({ ... usage: contextUsage ... });
```

Replace with the budget-aware form. Hoist the scoped inputs to a local, compute the budget, fit, emit events, and fail on exceeded. Site B (agent in `runFlow`, line 2812) — `stage`, `loaded.flow.spec.maxInputTokens`, `runtimeContext`, `eventStore`, `runId`, `attempt`, `skills`, `previousFailures` are in scope:

```ts
              const scopedInputs = stageScopedInputs(inputArtifacts, stage);
              const budget = resolveMaxInputTokens(stage, loaded.flow.spec.maxInputTokens);
              const fitted = fitPromptToBudget({
                inputs: scopedInputs,
                context: runtimeContext,
                budget,
                render: (forced) =>
                  renderPrompt(
                    stage,
                    loaded.flow.metadata.name,
                    scopedInputs,
                    attemptDirectory,
                    runtimeContext,
                    skills,
                    previousFailures,
                    forced,
                  ),
              });
              const { prompt, contextUsage, outcome } = fitted;
              appendContextUsageEvent({
                eventStore,
                runId,
                stageId: stage.id,
                attempt,
                usage: contextUsage,
                context: runtimeContext,
              });
              appendBudgetEvent({
                eventStore,
                runId,
                stageId: stage.id,
                attempt,
                outcome,
                context: runtimeContext,
              });
              if (outcome.status === "exceeded") {
                throw new Error(
                  `stage "${stage.id}" minimal context ${outcome.approxTokens} tokens exceeds budget ${outcome.budget}`,
                );
              }
```

Apply the same transformation at Site C (resume agent stage, line 3909) using that site's in-scope names (it omits `previousFailures` — drop that argument to `renderPrompt`, matching the current call there). Apply at Site A (`executeGateStage`, line 693) using `input.*` names, `resolveMaxInputTokens(input.stage, input.flowMaxInputTokens)`, and `input.previousFailures ?? []`. Each site already passes `prompt` to `runAgentInWorkspace` immediately after — that still refers to the destructured `prompt`.

The thrown error propagates into the existing attempt-failure handling (same path as `validateAttemptOutputs` throwing), recording the attempt failed and entering retry/escalation; `budget.exceeded` was already emitted before the throw.

- [ ] **Step 6: Run tests + typecheck**

Run: `TMPDIR=/Users/leo/.tmptest npx vitest run test/run/run-flow.test.ts -t "budget"` → PASS
Run: `TMPDIR=/Users/leo/.tmptest npx vitest run test/run/run-flow.test.ts` → PASS (full file)
Run: `npm run check` → no errors

- [ ] **Step 7: Commit**

```bash
git add src/run/run-flow.ts test/run/run-flow.test.ts
git commit -m "feat: enforce maxInputTokens via shrink-or-fail at prompt assembly"
```

---

### Task 5: Project `attempt.budget`

**Files:**
- Modify: `src/run/project.ts`
- Test: `test/run/project.test.ts`

**Interfaces:**
- Consumes: `budget.trimmed`/`budget.exceeded` events.
- Produces: `ProjectedAttempt.budget?: ProjectedAttemptBudget` where
  `export interface ProjectedAttemptBudget { status: "trimmed" | "exceeded"; budget: number; approxTokensBefore?: number; approxTokensAfter?: number; approxTokens?: number; trimmedInputIds?: string[] }`

- [ ] **Step 1: Write the failing test**

Add to `test/run/project.test.ts` (use the file's `event()` helper as the Task-3 MVP test did):

```ts
it("folds budget.trimmed and budget.exceeded onto attempts", () => {
  const trimmedRun = projectRun([
    event(1, "stage.started", { type: "agent", attemptDirectory: "/d" }, { runId: "r1", stageId: "impl", attempt: 1, createdAt: "2026-06-21T00:00:00Z" }),
    event(2, "budget.trimmed", { budget: 200, approxTokensBefore: 900, approxTokensAfter: 180, trimmedInputIds: ["big"] }, { runId: "r1", stageId: "impl", attempt: 1, createdAt: "2026-06-21T00:00:01Z" }),
  ]);
  expect(trimmedRun.stages[0].attempts[0].budget).toEqual({ status: "trimmed", budget: 200, approxTokensBefore: 900, approxTokensAfter: 180, trimmedInputIds: ["big"] });

  const exceededRun = projectRun([
    event(1, "stage.started", { type: "agent", attemptDirectory: "/d" }, { runId: "r2", stageId: "impl", attempt: 1, createdAt: "2026-06-21T00:00:00Z" }),
    event(2, "budget.exceeded", { budget: 1, approxTokens: 120 }, { runId: "r2", stageId: "impl", attempt: 1, createdAt: "2026-06-21T00:00:01Z" }),
  ]);
  expect(exceededRun.stages[0].attempts[0].budget).toEqual({ status: "exceeded", budget: 1, approxTokens: 120 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/run/project.test.ts -t "budget"`
Expected: FAIL — `attempt.budget` undefined.

- [ ] **Step 3: Add the type + reducer handlers**

In `src/run/project.ts`, add the interface near `ProjectedContextUsage`:

```ts
export interface ProjectedAttemptBudget {
  status: "trimmed" | "exceeded";
  budget: number;
  approxTokensBefore?: number;
  approxTokensAfter?: number;
  approxTokens?: number;
  trimmedInputIds?: string[];
}
```

Add `budget?: ProjectedAttemptBudget;` to `ProjectedAttempt`.

Add two handlers in `projectRun` (next to the `stage.context.usage` handler):

```ts
    if (event.type === "budget.trimmed" && event.stageId && event.attempt) {
      const stage = ensureStage(stages, event.stageId);
      const attempt = ensureAttempt(stage, event.attempt);
      attempt.budget = {
        status: "trimmed",
        budget: asNumber(payload.budget) ?? 0,
        approxTokensBefore: asNumber(payload.approxTokensBefore),
        approxTokensAfter: asNumber(payload.approxTokensAfter),
        trimmedInputIds: Array.isArray(payload.trimmedInputIds)
          ? payload.trimmedInputIds.filter((id): id is string => typeof id === "string")
          : undefined,
      };
      continue;
    }

    if (event.type === "budget.exceeded" && event.stageId && event.attempt) {
      const stage = ensureStage(stages, event.stageId);
      const attempt = ensureAttempt(stage, event.attempt);
      attempt.budget = {
        status: "exceeded",
        budget: asNumber(payload.budget) ?? 0,
        approxTokens: asNumber(payload.approxTokens),
      };
      continue;
    }
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run test/run/project.test.ts -t "budget"` → PASS
Run: `npm run check` → no errors

- [ ] **Step 5: Commit**

```bash
git add src/run/project.ts test/run/project.test.ts
git commit -m "feat: project attempt budget status from budget events"
```

---

### Task 6: Surface budget status in the web console

**Files:**
- Modify: `src/web/runs.ts` (timeline item)
- Modify: `src/web/static/console.dc.html`
- Test: `test/web/runs.test.ts`

**Interfaces:**
- Consumes: `ProjectedAttempt.budget` (Task 5), `ProjectedAttemptBudget` type.
- Produces: `WebSessionTimelineItem.budget?: ProjectedAttemptBudget` (the latest attempt's budget); SPA renders a `budget: trimmed (N→M tok)` / `budget exceeded` marker.

- [ ] **Step 1: Write the failing test**

Add to `test/web/runs.test.ts` (reuse the file's run-detail builder, same approach as the MVP context-usage test). Seed `stage.started` + `budget.trimmed` events for stage `implement`, build the detail, and assert:

```ts
it("surfaces per-stage budget status in the timeline", async () => {
  const detail = await buildDetailWithBudgetTrimmed(); // build via the file's real run-detail helper + seeded events
  const stage = detail.timeline.find((item) => item.stageId === "implement");
  expect(stage?.budget?.status).toBe("trimmed");
  expect(stage?.budget?.approxTokensAfter).toBe(180);
});
```

Match the real builder/helper names in `test/web/runs.test.ts`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/web/runs.test.ts -t "budget"`
Expected: FAIL — `budget` not on timeline item.

- [ ] **Step 3: Add the view-model field**

In `src/web/runs.ts`: add `ProjectedAttemptBudget` to the import from `../run/project.js`. Add `budget?: ProjectedAttemptBudget;` to `WebSessionTimelineItem`. In the timeline-builder `.map((stage) => {...})` (where `attempt = latestAttempt(stage)` is computed), add to the returned object:

```ts
      ...(attempt?.budget ? { budget: attempt.budget } : {}),
```

- [ ] **Step 4: Render in the SPA**

In `src/web/static/console.dc.html`, add a formatter near `formatContextUsage`:

```js
  formatBudget(b) {
    if (!b) return "";
    if (b.status === "exceeded") return "budget exceeded";
    return "budget: trimmed (" + (b.approxTokensBefore || 0) + "→" + (b.approxTokensAfter || 0) + " tok)";
  }
```

In the stage mapping (`stages = (rd.timeline || ...).map(...)`), pass through `budget: stage.budget,`. In `decorateStage`, append the marker to `metaLabel`:

```js
    const budgetLabel = this.formatBudget(s.budget);
    const metaLabel = [s.duration, attempts, usageLabel, budgetLabel].filter(Boolean).join(" · ") || (displayState === "pending" ? "queued" : "");
```

(`usageLabel` already exists from the MVP; just add `budgetLabel` to the same `filter(Boolean)` join.)

- [ ] **Step 5: Verify**

Run: `npx vitest run test/web/runs.test.ts -t "budget"` → PASS
Run: `npm run check` → no errors
Manual (optional): `TMPDIR=/Users/leo/.tmptest npm run dev`, open a run with a budgeted stage, confirm the marker shows.

- [ ] **Step 6: Commit**

```bash
git add src/web/runs.ts src/web/static/console.dc.html test/web/runs.test.ts
git commit -m "feat: show per-stage budget status in the web console"
```

---

## Self-Review

**Spec coverage:**
- `maxInputTokens` schema field + stage→flow resolution → Task 1. ✓
- Shrink-or-fail gate (greedy largest-first to path-only; fail when minimal still over) → Task 3 (`fitPromptToBudget`) + Task 4 (wiring). ✓
- `forcePathOnly` rendering with mandatory-read → Task 2. ✓
- `budget.trimmed` / `budget.exceeded` events → Task 3 (types) + Task 4 (emission). ✓
- Projection `attempt.budget` → Task 5. ✓
- Console surfacing + graceful absence → Task 6. ✓
- Opt-in / no-op when unresolved → Task 3 (`budget === undefined` → ok) + Task 1 (resolution). ✓
- Reject `maxInputTokens` on non-prompt stages → Task 1. ✓

**Placeholder scan:** No TBD/TODO. Integration tests (Task 4, Task 6) intentionally instruct reuse of the file's existing run/detail harness rather than copying unknown helper code — assertion bodies are concrete. The `runAgentFlowWithBudget` / `buildDetailWithBudgetTrimmed` helpers are described as "build via the file's real helpers" because those harnesses already exist in those test files (the MVP tasks used them).

**Type consistency:** `BudgetOutcome` (run-flow: `status` ok|trimmed|exceeded, optional `budget`/`approxTokensBefore`/`approxTokensAfter`/`approxTokens`/`trimmedInputIds`) is the gate's return; the emitted event payloads carry the subset per status; `ProjectedAttemptBudget` (project.ts: `status` trimmed|exceeded only) is the stored projection and the web type — deliberately narrower (no `ok`, which emits no event), consistent with the spec. `fitPromptToBudget` and `renderPrompt`'s new `forcedPathOnlyIds?: Set<string>` align across Tasks 2–4. `resolveMaxInputTokens(stage, flowMax)` signature is consistent between Task 1 (definition) and Task 4 (use).
