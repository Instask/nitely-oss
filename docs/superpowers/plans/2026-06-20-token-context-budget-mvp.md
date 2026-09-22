# Token & Context Budget Harness MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop inlining full artifact content into every agent prompt; instead pass metadata + a readable path + a compact head preview (with a mandatory-read instruction when truncated), and record per-attempt context-usage for the Web Console.

**Architecture:** Refactor the per-input prompt rendering in `src/run/run-flow.ts` into a pure `renderInputContext` helper that applies a size gate (full inline ≤ 8 KB, else head + mandatory-read), returning byte accounting. `renderPrompt` aggregates this into a `ContextUsage`, which the three agent/review-gate call sites emit as a new `stage.context.usage` event. `projectRun` folds those events onto attempts and a run total; the web layer and SPA surface them.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node, Zod, Vitest. Web SPA is a single Design-Component HTML file (`src/web/static/console.dc.html`).

## Global Constraints

- ESM imports use `.js` extensions even for `.ts` sources.
- Tests run with Vitest: `npx vitest run <file>`.
- On macOS, integration tests that create run directories must run with a non-symlinked tmpdir to avoid `/var`→`/private/var` path-escape false failures: prefix with `TMPDIR=/Users/leo/.tmptest` (create the dir first: `mkdir -p /Users/leo/.tmptest`). Pure-function unit tests do not need this.
- `INPUT_INLINE_FULL_LIMIT = 8 * 1024` (8 KB) is the full-inline threshold.
- `approxTokens = Math.ceil(promptBytes / 4)` — labeled approximate, no tokenizer dependency.
- All previewed text and paths continue to pass through `redactRuntimeText`.
- Branch: `impl/issue-65-context-budget` (already checked out in worktree `.worktrees/issue-65`).

---

### Task 1: `renderInputContext` helper + context-delivery change

Replace the 64 KB full-content inlining with the size-gated delivery (path + preview + mandatory-read), as a pure, exported, unit-testable function. After this task the token savings are live.

**Files:**
- Modify: `src/run/run-flow.ts` (constants near line 185-187; `renderInputs` at lines 971-1050)
- Test: `test/run/render-input-context.test.ts` (create)

**Interfaces:**
- Consumes: `InputArtifact` (existing, `run-flow.ts:228`), `RuntimeContext` (existing, `run-flow.ts:273`), `redactRuntimeText`, `manifestRunRelativePath`, `basename`.
- Produces:
  - `export interface InputContextUsage { inlinedBytes: number; savedBytes: number }`
  - `export function renderInputContext(input: InputArtifact, context: RuntimeContext): { block: string; usage: InputContextUsage }`
  - `renderInputs(inputs, context)` now returns `{ text: string; inputBytesInlined: number; inputBytesSaved: number; inputCount: number }`
  - module-private: `isTextualMediaType`, `headWithinBytes`, `INPUT_INLINE_FULL_LIMIT`

- [ ] **Step 1: Write the failing test**

Create `test/run/render-input-context.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderInputContext } from "../../src/run/run-flow.js";

function context() {
  return {
    runId: "run-1",
    runDirectory: "/repo/.nitely/runs/run-1",
    manifestEntries: [],
    manifestEntryIndexes: new Map(),
    artifactEntries: [],
    artifactEntryIndexes: new Map(),
    redactionSecrets: [],
  };
}

function input(content: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "spec",
    reference: { connector: "generated", uri: "/x" },
    resource: {
      sourceUri: "spec.md",
      mediaType: "text/markdown",
      content: Buffer.from(content, "utf8"),
      metadata: { filename: "spec.md" },
    },
    contentPath: "/repo/.nitely/runs/run-1/inputs/spec/content",
    ...overrides,
  } as Parameters<typeof renderInputContext>[0];
}

describe("renderInputContext", () => {
  it("inlines small content fully with no savings and includes the readable path", () => {
    const { block, usage } = renderInputContext(input("short body"), context());
    expect(block).toContain("Full content: /repo/.nitely/runs/run-1/inputs/spec/content");
    expect(block).toContain("Content preview:");
    expect(block).toContain("short body");
    expect(block).not.toContain("MUST read");
    expect(usage).toEqual({ inlinedBytes: Buffer.byteLength("short body"), savedBytes: 0 });
  });

  it("truncates large content to a head and demands a mandatory read", () => {
    const big = "x".repeat(20 * 1024);
    const { block, usage } = renderInputContext(input(big), context());
    expect(block).toContain("Content preview (truncated");
    expect(block).toContain("MUST read the full file");
    expect(usage.inlinedBytes).toBeLessThanOrEqual(8 * 1024);
    expect(usage.savedBytes).toBe(Buffer.byteLength(big) - usage.inlinedBytes);
  });

  it("emits metadata + path only for binary media types", () => {
    const { block, usage } = renderInputContext(
      input("\x00\x01\x02 binary", { resource: { sourceUri: "b.bin", mediaType: "application/octet-stream", content: Buffer.from("\x00\x01\x02 binary"), metadata: { filename: "b.bin" } } }),
      context(),
    );
    expect(block).toContain("Binary artifact");
    expect(block).not.toContain("Content preview");
    expect(usage.inlinedBytes).toBe(0);
    expect(usage.savedBytes).toBeGreaterThan(0);
  });

  it("keeps omitted-by-policy rendering with zero usage", () => {
    const { block, usage } = renderInputContext(
      input("ignored", { omittedByPolicy: { reason: "matched", matchedPattern: "*.env" } }),
      context(),
    );
    expect(block).toContain("Omitted by context policy.");
    expect(usage).toEqual({ inlinedBytes: 0, savedBytes: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/run/render-input-context.test.ts`
Expected: FAIL — `renderInputContext` is not exported / not a function.

- [ ] **Step 3: Implement the helper and rewrite `renderInputs`**

In `src/run/run-flow.ts`, replace the constant `MAX_INPUT_ARTIFACT_PREVIEW_LENGTH = 64 * 1024;` (line 187) with:

```ts
const INPUT_INLINE_FULL_LIMIT = 8 * 1024;
```

Add these module-private helpers above `renderInputs`:

```ts
function isTextualMediaType(mediaType: string | undefined): boolean {
  if (!mediaType) return true;
  const type = mediaType.toLowerCase();
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}

function headWithinBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let slice = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > 0) slice = slice.slice(0, lastNewline);
  return slice;
}
```

Add the exported types and function (place `renderInputContext` directly above `renderInputs`):

```ts
export interface InputContextUsage {
  inlinedBytes: number;
  savedBytes: number;
}

export function renderInputContext(
  input: InputArtifact,
  context: RuntimeContext,
): { block: string; usage: InputContextUsage } {
  const artifact = context.artifactEntries.find(
    (candidate) => candidate.id === input.id,
  );
  const filename =
    artifact?.filename ??
    input.resource.metadata?.filename ??
    basename(input.contentPath);
  const runPath =
    artifact?.path ??
    manifestRunRelativePath(context.runDirectory, input.contentPath);
  const metadataLines = [
    `Artifact: ${input.id}`,
    artifact?.name ? `Name: ${redactRuntimeText(artifact.name, context) ?? ""}` : undefined,
    artifact?.type ? `Type: ${redactRuntimeText(artifact.type, context) ?? ""}` : undefined,
    artifact?.version ? `Version: ${redactRuntimeText(artifact.version, context) ?? ""}` : undefined,
    artifact?.description ? `Description: ${redactRuntimeText(artifact.description, context) ?? ""}` : undefined,
    artifact?.producer ? `Producer: ${redactRuntimeText(artifact.producer, context) ?? ""}` : undefined,
    `Media type: ${redactRuntimeText(artifact?.mediaType ?? input.resource.mediaType, context) ?? ""}`,
    filename ? `Filename: ${redactRuntimeText(filename, context) ?? ""}` : undefined,
    runPath ? `Path: ${redactRuntimeText(runPath, context) ?? ""}` : undefined,
    runPath ? `Run-relative path: ${redactRuntimeText(runPath, context) ?? ""}` : undefined,
    artifact?.sourceUri ? `Source URI: ${redactRuntimeText(artifact.sourceUri, context) ?? ""}` : undefined,
  ].filter((line): line is string => line !== undefined);

  if (input.omittedByPolicy) {
    const block = [
      `## Input: ${input.id}`,
      "",
      ...metadataLines,
      `Source: ${redactRuntimeText(input.resource.sourceUri, context) ?? ""}`,
      "Omitted by context policy.",
      `Policy reason: ${redactRuntimeText(input.omittedByPolicy.reason, context) ?? "matched context policy"}`,
      input.omittedByPolicy.matchedPattern
        ? `Matched pattern: ${redactRuntimeText(input.omittedByPolicy.matchedPattern, context) ?? ""}`
        : undefined,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    return { block, usage: { inlinedBytes: 0, savedBytes: 0 } };
  }

  const fullPath = redactRuntimeText(input.contentPath, context) ?? input.contentPath;
  const redactedFull = redactRuntimeText(input.resource.content.toString("utf8"), context) ?? "";
  const fullBytes = Buffer.byteLength(redactedFull, "utf8");
  const header = [
    `## Input: ${input.id}`,
    "",
    ...metadataLines,
    `Source: ${redactRuntimeText(input.resource.sourceUri, context) ?? ""}`,
    `Snapshot: ${runPath ?? ""}`,
    `Full content: ${fullPath}`,
  ];

  if (!isTextualMediaType(artifact?.mediaType ?? input.resource.mediaType)) {
    return {
      block: [...header, "", "Binary artifact — not previewed. Read the file at the path above if needed."].join("\n"),
      usage: { inlinedBytes: 0, savedBytes: fullBytes },
    };
  }

  if (fullBytes <= INPUT_INLINE_FULL_LIMIT) {
    return {
      block: [...header, "", "Content preview:", "", "```", redactedFull, "```"].join("\n"),
      usage: { inlinedBytes: fullBytes, savedBytes: 0 },
    };
  }

  const preview = headWithinBytes(redactedFull, INPUT_INLINE_FULL_LIMIT);
  const inlinedBytes = Buffer.byteLength(preview, "utf8");
  return {
    block: [
      ...header,
      "",
      "Content preview (truncated — full content at the path above):",
      "",
      "```",
      preview,
      "```",
      "",
      `The preview above is truncated. You MUST read the full file at ${fullPath} before using this input. Do not rely on the preview alone for this artifact.`,
    ].join("\n"),
    usage: { inlinedBytes, savedBytes: fullBytes - inlinedBytes },
  };
}
```

Replace the body of `renderInputs` (lines 971-1050) with:

```ts
function renderInputs(
  inputs: Map<string, InputArtifact>,
  context: RuntimeContext,
): { text: string; inputBytesInlined: number; inputBytesSaved: number; inputCount: number } {
  const blocks: string[] = [];
  let inputBytesInlined = 0;
  let inputBytesSaved = 0;
  let inputCount = 0;
  for (const input of inputs.values()) {
    const { block, usage } = renderInputContext(input, context);
    blocks.push(block);
    inputBytesInlined += usage.inlinedBytes;
    inputBytesSaved += usage.savedBytes;
    inputCount += 1;
  }
  return {
    text: blocks.join("\n\n"),
    inputBytesInlined,
    inputBytesSaved,
    inputCount,
  };
}
```

In `renderPrompt` (line 1174), change the input line from `renderInputs(inputs, context),` to `renderInputs(inputs, context).text,` (the usage fields are threaded properly in Task 2; this keeps the build green now).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/run/render-input-context.test.ts`
Expected: PASS (4 tests).

Then confirm typecheck: `npm run check`
Expected: no errors.

- [ ] **Step 5: Run the existing run-flow suite and fix any prompt assertions**

Run: `mkdir -p /Users/leo/.tmptest && TMPDIR=/Users/leo/.tmptest npx vitest run test/run/run-flow.test.ts`
Expected: PASS. If any case asserted the old 64 KB "Content preview" of full content for a large input, update it to expect the truncated preview + `Full content:` path. (A grep for `Content preview` / `Snapshot` in the test currently returns nothing, so none are expected to break.)

- [ ] **Step 6: Commit**

```bash
git add src/run/run-flow.ts test/run/render-input-context.test.ts
git commit -m "feat: deliver input artifacts by path + head preview instead of full inline"
```

---

### Task 2: Thread `ContextUsage` out of `renderPrompt` and emit `stage.context.usage`

**Files:**
- Modify: `src/events/types.ts` (RunEventType union)
- Modify: `src/run/run-flow.ts` (`renderPrompt` return; 3 call sites at lines 693, 2707, 3796; add `appendContextUsageEvent`)
- Test: `test/run/run-flow.test.ts` (add a case)

**Interfaces:**
- Consumes: `renderInputs(...)` aggregate from Task 1; `EventStore` (existing import), `redactRuntimeUnknown` (existing).
- Produces:
  - `export interface ContextUsage { promptBytes: number; approxTokens: number; inputBytesInlined: number; inputBytesSaved: number; inputCount: number }`
  - `renderPrompt(...)` now returns `{ prompt: string; contextUsage: ContextUsage }`
  - `"stage.context.usage"` added to `RunEventType`
  - module-private `appendContextUsageEvent(input: { eventStore: EventStore; runId: string; stageId: string; attempt: number; usage: ContextUsage; context: RuntimeContext }): void`

- [ ] **Step 1: Write the failing test**

Add to `test/run/run-flow.test.ts` (follow the existing harness in that file: a flow with a fake `executeAgent`, an `EventStore`, and `runFlow`). Insert a focused test that asserts the event is recorded. Use the existing helpers in the file for building the flow/run; the assertion is:

```ts
it("records a stage.context.usage event per agent attempt", async () => {
  const { runDirectory, eventStore, runId } = await runMinimalAgentFlow(); // existing helper pattern in this file
  const events = eventStore.list(runId); // existing accessor used elsewhere in the suite
  const usage = events.find((event) => event.type === "stage.context.usage");
  expect(usage).toBeDefined();
  expect(usage?.stageId).toBe("implement");
  const payload = usage?.payload as Record<string, number>;
  expect(payload.promptBytes).toBeGreaterThan(0);
  expect(payload.approxTokens).toBe(Math.ceil(payload.promptBytes / 4));
  expect(typeof payload.inputBytesSaved).toBe("number");
  expect(payload.inputCount).toBeGreaterThanOrEqual(0);
});
```

Note: match the actual flow-construction and event-listing helpers already present in `test/run/run-flow.test.ts` (e.g., the setup used by the test at line ~150 that supplies `executeAgent`). Reuse them rather than inventing new ones.

- [ ] **Step 2: Run test to verify it fails**

Run: `TMPDIR=/Users/leo/.tmptest npx vitest run test/run/run-flow.test.ts -t "stage.context.usage"`
Expected: FAIL — no such event recorded.

- [ ] **Step 3: Add the event type**

In `src/events/types.ts`, add `"stage.context.usage"` to the `RunEventType` union (place it after `"stage.skills.loaded"`):

```ts
  | "stage.skills.loaded"
  | "stage.context.usage"
```

- [ ] **Step 4: Change `renderPrompt` to return usage, add the emit helper**

In `src/run/run-flow.ts`, add near the other interfaces:

```ts
export interface ContextUsage {
  promptBytes: number;
  approxTokens: number;
  inputBytesInlined: number;
  inputBytesSaved: number;
  inputCount: number;
}
```

In `renderPrompt`, capture the input aggregate and compute the prompt total. Replace the current `return [ ... ].join(...)`-style body so it ends like:

```ts
  const inputs_ = renderInputs(inputs, context);
  // ...assemble the array exactly as before, but use `inputs_.text` where
  // `renderInputs(inputs, context).text` was used in Task 1...
  const prompt = [
    // ...the same array elements as the current renderPrompt body...
    "## Available Inputs",
    "",
    inputs_.text,
    "",
    // ...remaining elements...
  ].join("\n");
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  return {
    prompt,
    contextUsage: {
      promptBytes,
      approxTokens: Math.ceil(promptBytes / 4),
      inputBytesInlined: inputs_.inputBytesInlined,
      inputBytesSaved: inputs_.inputBytesSaved,
      inputCount: inputs_.inputCount,
    },
  };
```

Add the emit helper:

```ts
function appendContextUsageEvent(input: {
  eventStore: EventStore;
  runId: string;
  stageId: string;
  attempt: number;
  usage: ContextUsage;
  context: RuntimeContext;
}): void {
  input.eventStore.append({
    runId: input.runId,
    stageId: input.stageId,
    attempt: input.attempt,
    type: "stage.context.usage",
    payload: redactRuntimeUnknown({ ...input.usage }, input.context),
  });
}
```

- [ ] **Step 5: Update the three call sites**

At each `renderPrompt(...)` call, destructure and emit. The three sites:

Site A — review gate, around line 693 (uses `input.*`):

```ts
    const { prompt, contextUsage } = renderPrompt(
      input.stage,
      input.flowName,
      stageScopedInputs(input.inputArtifacts, input.stage),
      input.attemptDirectory,
      input.context,
      skills,
      input.previousFailures ?? [],
    );
    appendContextUsageEvent({
      eventStore: input.eventStore,
      runId: input.runId,
      stageId: input.stage.id,
      attempt: input.attempt,
      usage: contextUsage,
      context: input.context,
    });
```

Site B — agent stage in `runFlow`, around line 2707 (uses outer `runId`, `eventStore`, `runtimeContext`, `stage`, `attempt`):

```ts
              const { prompt, contextUsage } = renderPrompt(
                stage,
                loaded.flow.metadata.name,
                stageScopedInputs(inputArtifacts, stage),
                attemptDirectory,
                runtimeContext,
                skills,
                previousFailures,
              );
              appendContextUsageEvent({
                eventStore,
                runId,
                stageId: stage.id,
                attempt,
                usage: contextUsage,
                context: runtimeContext,
              });
```

Site C — agent stage in `resumeRun`, around line 3796 (same outer names):

```ts
          const { prompt, contextUsage } = renderPrompt(
            stage,
            loaded.flow.metadata.name,
            stageScopedInputs(inputArtifacts, stage),
            attemptDirectory,
            runtimeContext,
            skills,
          );
          appendContextUsageEvent({
            eventStore,
            runId,
            stageId: stage.id,
            attempt,
            usage: contextUsage,
            context: runtimeContext,
          });
```

Each site already passed `prompt` to `runAgentInWorkspace`; that now refers to the destructured `prompt` const — no further change needed there.

- [ ] **Step 6: Run tests + typecheck**

Run: `TMPDIR=/Users/leo/.tmptest npx vitest run test/run/run-flow.test.ts -t "stage.context.usage"`
Expected: PASS.
Run: `npm run check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/events/types.ts src/run/run-flow.ts test/run/run-flow.test.ts
git commit -m "feat: emit stage.context.usage event with prompt size and bytes saved"
```

---

### Task 3: Project `contextUsage` onto attempts and a run total

**Files:**
- Modify: `src/run/project.ts` (types, `asNumber` helper, reducer handler, run-total finalization)
- Test: `test/run/project.test.ts` (add a case; file exists)

**Interfaces:**
- Consumes: `stage.context.usage` events from Task 2.
- Produces:
  - `export interface ProjectedContextUsage { promptBytes: number; approxTokens: number; inputBytesInlined: number; inputBytesSaved: number; inputCount: number }`
  - `ProjectedAttempt.contextUsage?: ProjectedContextUsage`
  - `ProjectedRun.contextUsage?: ProjectedContextUsage`

- [ ] **Step 1: Write the failing test**

Add to `test/run/project.test.ts`:

```ts
it("folds stage.context.usage onto attempts and a run total", () => {
  const events = [
    { sequence: 1, runId: "r1", type: "stage.started", stageId: "implement", attempt: 1, payload: { type: "agent", attemptDirectory: "/d" }, createdAt: "2026-06-20T00:00:00Z" },
    { sequence: 2, runId: "r1", type: "stage.context.usage", stageId: "implement", attempt: 1, payload: { promptBytes: 1200, approxTokens: 300, inputBytesInlined: 800, inputBytesSaved: 5000, inputCount: 2 }, createdAt: "2026-06-20T00:00:01Z" },
  ] as Parameters<typeof projectRun>[0];
  const run = projectRun(events);
  const attempt = run.stages[0].attempts[0];
  expect(attempt.contextUsage).toEqual({ promptBytes: 1200, approxTokens: 300, inputBytesInlined: 800, inputBytesSaved: 5000, inputCount: 2 });
  expect(run.contextUsage).toEqual({ promptBytes: 1200, approxTokens: 300, inputBytesInlined: 800, inputBytesSaved: 5000, inputCount: 2 });
});
```

(Import `projectRun` the same way other cases in the file do.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/run/project.test.ts -t "context.usage"`
Expected: FAIL — `attempt.contextUsage` is undefined.

- [ ] **Step 3: Add types + `asNumber`**

In `src/run/project.ts`, add the interface (near `ProjectedAttempt`):

```ts
export interface ProjectedContextUsage {
  promptBytes: number;
  approxTokens: number;
  inputBytesInlined: number;
  inputBytesSaved: number;
  inputCount: number;
}
```

Add `contextUsage?: ProjectedContextUsage;` to both `ProjectedAttempt` (after `error?`) and `ProjectedRun` (after `priorRunId?`).

Add a numeric coercion helper next to `asString` (around line 101):

```ts
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
```

- [ ] **Step 4: Add the reducer handler**

In `projectRun`, after the `stage.started` handler block (around line 359, before the `command.completed` handler), add:

```ts
    if (event.type === "stage.context.usage" && event.stageId && event.attempt) {
      const stage = ensureStage(stages, event.stageId);
      const attempt = ensureAttempt(stage, event.attempt);
      attempt.contextUsage = {
        promptBytes: asNumber(payload.promptBytes) ?? 0,
        approxTokens: asNumber(payload.approxTokens) ?? 0,
        inputBytesInlined: asNumber(payload.inputBytesInlined) ?? 0,
        inputBytesSaved: asNumber(payload.inputBytesSaved) ?? 0,
        inputCount: asNumber(payload.inputCount) ?? 0,
      };
      continue;
    }
```

- [ ] **Step 5: Compute the run total**

Immediately before `projection.stages = [...stages.values()];` (line 502), add:

```ts
  const usageTotal: ProjectedContextUsage = {
    promptBytes: 0,
    approxTokens: 0,
    inputBytesInlined: 0,
    inputBytesSaved: 0,
    inputCount: 0,
  };
  let sawUsage = false;
  for (const stage of stages.values()) {
    for (const attempt of stage.attempts) {
      if (!attempt.contextUsage) continue;
      sawUsage = true;
      usageTotal.promptBytes += attempt.contextUsage.promptBytes;
      usageTotal.approxTokens += attempt.contextUsage.approxTokens;
      usageTotal.inputBytesInlined += attempt.contextUsage.inputBytesInlined;
      usageTotal.inputBytesSaved += attempt.contextUsage.inputBytesSaved;
      usageTotal.inputCount += attempt.contextUsage.inputCount;
    }
  }
  if (sawUsage) {
    projection.contextUsage = usageTotal;
  }
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run test/run/project.test.ts -t "context.usage"`
Expected: PASS.
Run: `npm run check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/run/project.ts test/run/project.test.ts
git commit -m "feat: project context usage onto attempts and run total"
```

---

### Task 4: Expose context usage in the web run view model

**Files:**
- Modify: `src/web/runs.ts` (`WebSessionTimelineItem` interface + builder around line 824-865; `WebRunDetail` interface around line 148; detail assembly)
- Test: `test/web/runs.test.ts` (add a case; file exists)

**Interfaces:**
- Consumes: `ProjectedRun.contextUsage`, `ProjectedAttempt.contextUsage`, `ProjectedContextUsage` (Task 3).
- Produces:
  - `WebSessionTimelineItem.contextUsage?: ProjectedContextUsage` (per-stage sum across that stage's attempts)
  - `WebRunDetail.contextUsage?: ProjectedContextUsage` (run total, passed through from projection)

- [ ] **Step 1: Write the failing test**

Add to `test/web/runs.test.ts` a case that builds a run detail from a projection containing `stage.context.usage` events (reuse the file's existing run-detail construction helper) and asserts:

```ts
it("surfaces per-stage and run-total context usage in the detail view", async () => {
  const detail = await buildDetailWithContextUsage(); // reuse existing detail-builder helper in this file
  expect(detail.contextUsage?.inputBytesSaved).toBeGreaterThan(0);
  const stage = detail.timeline.find((item) => item.stageId === "implement");
  expect(stage?.contextUsage?.promptBytes).toBeGreaterThan(0);
});
```

Match the actual helper names used in `test/web/runs.test.ts`; if it builds details from an event list, append the two events from Task 3's test to that list.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/web/runs.test.ts -t "context usage"`
Expected: FAIL — `contextUsage` undefined on detail/timeline.

- [ ] **Step 3: Add the import and interface fields**

In `src/web/runs.ts`, add `ProjectedContextUsage` to the existing import from `../run/project.js` (joining `ProjectedAttempt` on line 19).

Add `contextUsage?: ProjectedContextUsage;` to `WebSessionTimelineItem` (after `generatedArtifactPaths`) and to `WebRunDetail` (after `childRuns`).

- [ ] **Step 4: Populate per-stage usage in the timeline builder**

In the timeline-builder `.map((stage) => { ... })` (around line 824), compute a per-stage sum and add it to the returned object:

```ts
    const stageUsage = stage.attempts.reduce<ProjectedContextUsage | undefined>((acc, a) => {
      if (!a.contextUsage) return acc;
      const base = acc ?? { promptBytes: 0, approxTokens: 0, inputBytesInlined: 0, inputBytesSaved: 0, inputCount: 0 };
      return {
        promptBytes: base.promptBytes + a.contextUsage.promptBytes,
        approxTokens: base.approxTokens + a.contextUsage.approxTokens,
        inputBytesInlined: base.inputBytesInlined + a.contextUsage.inputBytesInlined,
        inputBytesSaved: base.inputBytesSaved + a.contextUsage.inputBytesSaved,
        inputCount: base.inputCount + a.contextUsage.inputCount,
      };
    }, undefined);
```

Add `...(stageUsage ? { contextUsage: stageUsage } : {}),` to the returned timeline-item object.

- [ ] **Step 5: Pass the run total onto the detail**

Where `WebRunDetail` is assembled (the object that spreads the summary and adds `timeline`, `evidenceTimeline`, etc.), add:

```ts
    ...(projection.contextUsage ? { contextUsage: projection.contextUsage } : {}),
```

(Use the in-scope projection variable name at that assembly site.)

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run test/web/runs.test.ts -t "context usage"`
Expected: PASS.
Run: `npm run check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/web/runs.ts test/web/runs.test.ts
git commit -m "feat: expose context usage per stage and per run in web view model"
```

---

### Task 5: Render context usage in the Web Console SPA

No JS unit-test harness exists for the SPA; verify by building and viewing. Keep the change minimal: a per-stage chip and a run-level readout.

**Files:**
- Modify: `src/web/static/console.dc.html` (stage mapping around line 1528; `decorateStage` around line 1093; run header model around line 1572)

**Interfaces:**
- Consumes: `timeline[].contextUsage` and top-level `contextUsage` from Task 4's JSON.

- [ ] **Step 1: Add a formatting helper**

Near the other formatting helpers in the component (e.g., by `statusMeta`/`badge`), add a method:

```js
  formatContextUsage(u) {
    if (!u) return "";
    const tok = u.approxTokens >= 1000 ? Math.round(u.approxTokens / 100) / 10 + "k" : String(u.approxTokens || 0);
    const savedKb = Math.round((u.inputBytesSaved || 0) / 1024);
    return "~" + tok + " tok" + (savedKb > 0 ? " · " + savedKb + "KB saved" : "");
  }
```

- [ ] **Step 2: Pass usage through the stage mapping**

In the `stages = (rd.timeline || ...).map((stage) => { ... })` block (line 1528), add `contextUsage: stage.contextUsage,` to the `Object.assign({}, stage, { ... })` payload.

- [ ] **Step 3: Append the chip in `decorateStage`**

In `decorateStage` (line 1090-1094), extend `metaLabel`:

```js
    const usageLabel = this.formatContextUsage(s.contextUsage);
    const metaLabel = [s.duration, attempts, usageLabel].filter(Boolean).join(" · ") || (displayState === "pending" ? "queued" : "");
```

- [ ] **Step 4: Add the run-level readout**

In the `selectedRun = Object.assign({}, rd, { ... })` block (around line 1558-1572), add:

```js
          contextUsageLabel: this.formatContextUsage(rd.contextUsage),
```

Then render `contextUsageLabel` in the run header template where `duration`/`branchName` are shown (find the run-summary header markup that binds `duration` and add an adjacent `<span>` bound to `contextUsageLabel`, shown only when non-empty).

- [ ] **Step 5: Verify in the browser**

Run the app and open a completed run that had agent stages:

```bash
mkdir -p /Users/leo/.tmptest && TMPDIR=/Users/leo/.tmptest npm run dev
```

Open the Web Console, select a run, and confirm: each agent stage row shows a `~N tok · NKB saved` chip, and the run header shows the run total. (If the project has a `/run` skill or documented dev command, use that instead.)

- [ ] **Step 6: Commit**

```bash
git add src/web/static/console.dc.html
git commit -m "feat: show per-stage and run context usage in the web console"
```

---

## Self-Review

**Spec coverage:**
- Context delivery change (path + summary + mandatory read, 8 KB gate, binary handling, omitted-by-policy unchanged) → Task 1. ✓
- Thin observability event with promptBytes/approxTokens/inlined/saved/count → Task 2. ✓
- Projection onto attempts + run total → Task 3. ✓
- Web Console per-run + per-stage surfacing, graceful absence → Tasks 4 (view model) + 5 (render). ✓ (graceful absence: all fields optional and conditionally spread/rendered.)
- Testing: unit tests for `renderInputContext`, event emission, projection, web view model; SPA verified manually → covered. ✓
- Deferred items (schema budget fields, gates) → intentionally absent. ✓

**Placeholder scan:** No TBD/TODO; all code steps contain concrete code. Two integration tests (Task 2, Task 4) intentionally instruct reuse of existing test helpers in those files rather than copying unknown harness code — the assertion bodies are concrete.

**Type consistency:** `ContextUsage` (run-flow, with `promptBytes`/`approxTokens`/`inputBytesInlined`/`inputBytesSaved`/`inputCount`) and `ProjectedContextUsage` (project.ts, same fields) are deliberately separate types with identical shapes to respect the run-flow→project layering (project.ts must not import from run-flow). The event payload carries exactly those five numeric fields end to end. `renderInputContext` returns `{ block, usage }`; `renderInputs` returns `{ text, inputBytesInlined, inputBytesSaved, inputCount }`; `renderPrompt` returns `{ prompt, contextUsage }` — all consumed consistently.
