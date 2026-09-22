# JSON Flow and Connectors Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make JSON the only flow format and add a connector boundary that can snapshot local files now and Google Drive documents later.

**Architecture:** Parse flow definitions with the platform JSON parser, preserving the existing Zod schema and artifact-derived DAG. Resolve named external resources through a connector registry before execution and persist fetched bytes plus sanitized metadata as immutable input artifacts.

**Tech Stack:** Node.js 24, TypeScript, Zod, Vitest, built-in filesystem APIs.

---

### Task 1: Migrate flow definitions from YAML to JSON

**Files:**
- Modify: `src/flow/load.ts`
- Modify: `test/flow/load.test.ts`
- Delete: `test/fixtures/valid-flow.yaml`
- Delete: `test/fixtures/invalid-flow.yaml`
- Create: `test/fixtures/valid-flow.json`
- Create: `test/fixtures/invalid-flow.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Step 1: Convert test helpers and fixtures to JSON**

Use `JSON.stringify(flow, null, 2)` and `.json` temporary files. Add a test that
invalid JSON reports `flow is not valid JSON`.

**Step 2: Run the flow tests and verify failure**

Run:

```bash
pnpm exec vitest run test/flow/load.test.ts
```

Expected: FAIL because the loader still parses YAML or references YAML fixtures.

**Step 3: Implement JSON-only loading**

Replace the YAML parser with:

```ts
try {
  document = JSON.parse(source);
} catch (error) {
  throw new FlowValidationError([
    `flow is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
  ]);
}
```

Remove the `yaml` dependency.

**Step 4: Run verification**

```bash
pnpm exec vitest run test/flow/load.test.ts test/cli.test.ts
pnpm run check
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/flow test/flow test/fixtures package.json pnpm-lock.yaml
git commit -m "refactor: use json flow definitions"
```

### Task 2: Define connector contracts and registry

**Files:**
- Create: `src/connectors/types.ts`
- Create: `src/connectors/registry.ts`
- Create: `test/connectors/registry.test.ts`

**Step 1: Write failing registry tests**

Cover:

- Register and retrieve a connector by type.
- Reject duplicate connector types.
- Reject an unknown connector type.
- Resolve a resource through the selected connector.

Use:

```ts
const registry = new ConnectorRegistry([connector]);
const result = await registry.fetch({
  connector: "memory",
  uri: "memory://spec",
});
expect(result.content.toString("utf8")).toBe("spec content");
```

**Step 2: Run the test and verify failure**

```bash
pnpm exec vitest run test/connectors/registry.test.ts
```

Expected: FAIL because connector modules do not exist.

**Step 3: Implement minimal contracts**

```ts
export interface ResourceReference {
  connector: string;
  uri: string;
  options?: Record<string, unknown>;
}

export interface FetchedResource {
  sourceUri: string;
  mediaType: string;
  content: Buffer;
  revision?: string;
  metadata?: Record<string, string>;
}

export interface Connector {
  readonly type: string;
  fetch(reference: ResourceReference): Promise<FetchedResource>;
}
```

Implement `ConnectorRegistry.fetch(reference)` with explicit duplicate and
unknown connector errors.

**Step 4: Run verification**

```bash
pnpm exec vitest run test/connectors/registry.test.ts
pnpm run check
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/connectors test/connectors
git commit -m "feat: add connector registry"
```

### Task 3: Add the local-file connector

**Files:**
- Create: `src/connectors/local-file.ts`
- Create: `test/connectors/local-file.test.ts`

**Step 1: Write failing local-file tests**

Cover:

- Fetch a relative file from a configured base directory.
- Return file bytes and a useful media type.
- Reject paths outside the configured base directory.
- Reject directories and missing files.

**Step 2: Run the test and verify failure**

```bash
pnpm exec vitest run test/connectors/local-file.test.ts
```

Expected: FAIL because `LocalFileConnector` does not exist.

**Step 3: Implement the connector**

Resolve references against an absolute base directory, compare the resolved path
with the base path, call `stat`, then `readFile`. Support `file:` URLs and plain
relative paths. Do not follow a path outside the configured base.

**Step 4: Run verification**

```bash
pnpm exec vitest run test/connectors/local-file.test.ts
pnpm exec vitest run
pnpm run check
pnpm run build
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/connectors test/connectors
git commit -m "feat: fetch local input resources"
```

### Task 4: Snapshot connector resources as input artifacts

This task is executed after the Git worktree workspace task in the main bootstrap
plan because it writes into the run directory owned by that workspace provider.

**Files:**
- Create: `src/inputs/snapshot.ts`
- Create: `test/inputs/snapshot.test.ts`
- Modify: `src/events/types.ts`

The snapshotter will resolve each named reference once, write `content` and
`metadata.json` atomically, and append an `input.snapshotted` event. It must
sanitize connector metadata and never persist credentials or connector options.

