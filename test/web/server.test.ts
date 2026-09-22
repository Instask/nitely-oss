import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createContextKnowledgeEntry } from "../../src/context-kg/store.js";
import { EventStore } from "../../src/events/store.js";
import {
  SchedulerCooldownStore,
  schedulerCooldownStorePath,
} from "../../src/scheduler/cooldown.js";
import { RunAdmissionStore } from "../../src/run/admission-store.js";
import { eventStorePath, projectRun } from "../../src/run/project.js";
import { generateDraftSpec } from "../../src/spec-artifacts/draft.js";
import { validateStructuredSpec } from "../../src/spec-artifacts/parse.js";
import type {
  RunFlowDependencies,
  RunFlowInput,
  RunFlowResult,
} from "../../src/run/run-flow.js";
import type {
  ProviderConnectionStore,
  ProviderId,
  SetConnectionInput,
} from "../../src/providers/types.js";
import { MissingConnectionError } from "../../src/providers/types.js";
import type {
  ProviderConnectionRecord,
  SetConnectionInput as ProviderSetConnectionInput,
} from "../../src/providers/types.js";
import { FileProviderConnectionStore } from "../../src/providers/file-store.js";
import { startWebServer, type WebServer } from "../../src/web/server.js";
import {
  createTask,
  getTask,
  sourceSnapshotContentHash,
  updateTaskDependencies,
  updateTaskRunState,
  updateTaskSpecApproval,
  type TaskSourceSnapshot,
} from "../../src/web/tasks.js";
import { createUser } from "../../src/web/users.js";
import {
  addOrganizationMember,
  createOrganization,
  listPublicMemberships,
} from "../../src/web/organizations.js";
import {
  getNotification,
  listNotifications,
  listTaskNotificationDecisions,
  upsertNotification,
} from "../../src/web/notifications.js";
import { listNotificationDeliveryReceipts } from "../../src/web/notification-delivery.js";
import { createWorkItem, getWorkItem } from "../../src/work-items/store.js";
import {
  apiTokenAuditPath,
  apiTokenStorePath,
  createApiToken,
  revokeApiToken,
} from "../../src/web/api-tokens.js";
import { listSecurityAuditEvents } from "../../src/web/security-audit.js";
import { createTokenOwner } from "../helpers/token-owner.js";
import type {
  RepositoryIssueComment,
  ScmProvider,
} from "../../src/scm/types.js";

const servers: WebServer[] = [];

function admittedRunId(
  dependencies: RunFlowDependencies | undefined,
  fallback: string,
): string {
  return dependencies?.createRunId?.() ?? fallback;
}

async function createRepo() {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-server-"));
  await mkdir(join(repoPath, "flows"), { recursive: true });
  await writeFile(
    join(repoPath, "flows/implement-spec-bootstrap.json"),
    JSON.stringify(
      {
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "implement-spec-bootstrap" },
        spec: {
          stages: [
            {
              id: "implement",
              type: "agent",
              runtime: "mock",
              prompt: "Implement.",
              inputs: ["spec", "tech-design"],
              outputs: ["implementation"],
            },
          ],
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  // A sibling flow whose stages require the anthropic provider, for tests that
  // need preflight to block on a missing/owner-scoped runtime credential
  // rather than the always-available mock runtime above.
  await writeFile(
    join(repoPath, "flows/implement-spec-bootstrap-claude.json"),
    JSON.stringify(
      {
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "implement-spec-bootstrap-claude" },
        spec: {
          stages: [
            {
              id: "implement",
              type: "agent",
              runtime: "claude",
              prompt: "Implement.",
              inputs: ["spec", "tech-design"],
              outputs: ["implementation"],
            },
          ],
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return repoPath;
}

async function writeLocalSkillSource(
  root: string,
  id: string,
  description = "Imported from the Web Console.",
): Promise<string> {
  const directory = join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    [
      "---",
      `name: ${id}`,
      `description: ${description}`,
      "---",
      "",
      "Follow the imported skill instructions.",
    ].join("\n"),
    "utf8",
  );
  return directory;
}

async function writeApprovalFlow(repoPath: string) {
  await writeFile(
    join(repoPath, "flows/approval-work-item.json"),
    JSON.stringify(
      {
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: {
          name: "approval-work-item",
          workItemType: "dev.pr",
          inputs: [{ id: "intake" }],
        },
        spec: {
          stages: [
            {
              id: "draft-spec",
              type: "agent",
              runtime: "mock",
              prompt: "Draft a spec.",
              inputs: ["intake"],
              outputs: ["spec"],
            },
            {
              id: "approve-spec",
              type: "approval",
              prompt: "Approve generated spec before design",
              inputs: ["spec"],
              outputs: [],
            },
            {
              id: "implement",
              type: "agent",
              runtime: "mock",
              prompt: "Implement.",
              inputs: ["spec"],
              outputs: ["implementation"],
            },
          ],
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function writeTaskReworkFlow(repoPath: string) {
  await writeFile(
    join(repoPath, "flows/rework-pr-bootstrap.json"),
    JSON.stringify(
      {
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "rework-pr-bootstrap" },
        spec: {
          stages: [
            {
              id: "rework",
              type: "agent",
              runtime: "mock",
              prompt: "Rework the existing PR.",
              inputs: ["spec", "tech-design"],
              outputs: ["implementation"],
            },
          ],
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function homeRepository(path: string) {
  return { id: "home", name: "home", path };
}

async function startTestServer(
  repoPath: string,
  runFlow?: (
    input: RunFlowInput,
    dependencies?: RunFlowDependencies,
  ) => Promise<RunFlowResult>,
  providerStore?: ProviderConnectionStore,
  options: Partial<Parameters<typeof startWebServer>[0]> = {},
) {
  const server = await startWebServer({
    repoPath,
    host: "127.0.0.1",
    port: 0,
    runFlow,
    providerCommandStatus: async () => false,
    providerStore,
    readRepositoryOrigin: async () => undefined,
    ...options,
    repositories: [homeRepository(repoPath), ...(options.repositories ?? [])],
  });
  servers.push(server);
  return server;
}

async function json(response: Response) {
  return (await response.json()) as unknown;
}

async function expectWebInputError(response: Response, message: string) {
  expect(response.status).toBe(400);
  await expect(json(response)).resolves.toMatchObject({
    error: { message },
  });
}

function refinedSourceSpecificSpec(title = "Repository import") {
  return `# Feature Spec: ${title}

Status: draft
Source: prompt

## Background

Operators need a concrete approved product contract before Nitely can run implementation.

## User Stories

- **US-001:** As an operator, I can paste a GitHub issue URL and create a planning task linked to that issue.
- **US-002:** As a reviewer, I can approve the refined spec only after it names concrete behavior and verification.

## Acceptance Scenarios

- **US-001 / SC-001:** Given a GitHub issue URL, when draft planning runs, then the task stores the issue URL, title, and source snapshot.
- **US-002 / SC-002:** Given a refined draft, when the reviewer approves it, then the markdown status changes to approved and technical design drafting can start.

## Functional Requirements

- **FR-001:** Nitely must store the pasted source URL, fetched source title, and source snapshot on the task record.
- **FR-002:** Nitely must block implementation while the task spec status is draft.
- **FR-003:** Nitely must allow technical design drafting after a reviewer approves the refined spec.

## Success Criteria

- **SC-001:** A task created from source intake exposes the source URL and title in the task payload.
- **SC-002:** Approving the refined spec updates the persisted markdown status to approved.
- **SC-003:** Starting a run before technical design approval returns a validation error instead of launching the runner.

## Edge Cases And Failure Behavior

- Invalid source URLs must return a validation error without creating a task.
- Missing private issue credentials must return a provider setup error.

## Assumptions

- The repository has a configured implementation flow.

## Out Of Scope

- Automatically expanding source requirements with an LLM during deterministic draft generation.

## Open Questions

- None.
`;
}

async function writeRefinedSourceSpecificSpec(
  repoPath: string,
  task: { specPath: string },
  title?: string,
) {
  await writeFile(join(repoPath, task.specPath), refinedSourceSpecificSpec(title), "utf8");
}

function nonDevFlow(secretMarker?: string) {
  return {
    apiVersion: "nitely.dev/v1alpha1",
    kind: "Flow",
    metadata: {
      name: "autofarm-site",
      workItemType: "autofarm.site",
      inputs: [{ id: "seed", type: "keyword-seed" }],
      ...(secretMarker ? { secretMarker } : {}),
    },
    spec: {
      stages: [
        { id: "discover", type: "command", command: "true", inputs: ["seed"], outputs: ["keyword-set"] },
        { id: "approve-plan", type: "approval", prompt: "Approve", inputs: [], outputs: [] },
        { id: "approve-preview", type: "approval", prompt: "Approve", inputs: [], outputs: [] },
        { id: "deploy", type: "command", command: "true", inputs: [], outputs: ["deployment"] },
      ],
    },
  };
}

async function allowAutofarmWorkItems(repoPath: string) {
  await mkdir(join(repoPath, ".nitely"), { recursive: true });
  await writeFile(
    join(repoPath, ".nitely/work-item-policy.json"),
    JSON.stringify({ allowedTypes: ["autofarm.site"] }),
    "utf8",
  );
}

async function writeNonDevFlow(path: string, secretMarker?: string) {
  await writeFile(path, JSON.stringify(nonDevFlow(secretMarker)), "utf8");
}

async function workItemDirectoryEntries(repoPath: string): Promise<string[]> {
  try {
    return await readdir(join(repoPath, ".nitely/work-items"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function login(server: WebServer, email: string, password: string) {
  const response = await fetch(`${server.url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return {
    response,
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
    body: await json(response),
  };
}

async function waitFor<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
): Promise<T> {
  let latest = await read();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (matches(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 10));
    latest = await read();
  }
  return latest;
}


function fakeConnectionRecord(input: ProviderSetConnectionInput): ProviderConnectionRecord {
  return {
    id: input.connectionId ?? `conn_${input.providerId}`,
    providerId: input.providerId,
    authMethod: input.authMethod ?? "api_key",
    state: "active",
    isDefault: true,
    credentialRef: `sec_${input.providerId}`,
    refreshable: false,
    credential: { scope: "user", source: "web-console" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("web server API and HTML", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    vi.unstubAllGlobals();
  });

  it("reports a local admin session and preserves unauthenticated local API compatibility", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);

    const session = await json(await fetch(`${server.url}/api/session`));
    expect(session).toEqual({
      authRequired: false,
      user: { id: "local", email: "local", role: "admin" },
    });

    const response = await fetch(`${server.url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Local task",
        spec: "Spec body",
        techDesign: "Design body",
      }),
    });
    expect(response.status).toBe(201);
    expect(await json(response)).toMatchObject({
      task: { title: "Local task" },
    });
  });

  it("serves agent stability projection with zero counts and OSS candidates", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);

    const response = await fetch(`${server.url}/api/agent-stability`);
    expect(response.status).toBe(200);
    const body = (await json(response)) as {
      agentStability: {
        summary: {
          active: number;
          blocked: number;
          failed: number;
          incomplete: number;
          completed: number;
          total: number;
        };
        attention: unknown[];
        failureClusters: unknown[];
        runnerReadiness: unknown[];
        changeRecords: unknown[];
        verification: { totalStages: number };
        ossExtraction: Array<{ id: string; status: string }>;
      };
    };

    expect(body.agentStability.summary).toEqual({
      active: 0,
      blocked: 0,
      failed: 0,
      incomplete: 0,
      completed: 0,
      total: 0,
    });
    expect(body.agentStability.attention).toEqual([]);
    expect(body.agentStability.failureClusters).toEqual([]);
    expect(body.agentStability.runnerReadiness).toEqual([]);
    expect(body.agentStability.changeRecords).toEqual([]);
    expect(body.agentStability.verification.totalStages).toBe(0);
    expect(body.agentStability.ossExtraction.map((item) => item.id)).toEqual([
      "protocol",
      "runner-lifecycle",
      "evidence-metadata",
      "connector-interface",
      "doctor",
    ]);
    expect(body.agentStability.ossExtraction.every((item) => item.status === "candidate")).toBe(
      true,
    );
  });

  it("optionally creates supplied planning artifacts as drafts for external approval clients", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const response = await fetch(`${server.url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Externally planned task",
        spec: "Spec body",
        techDesign: "Design body",
        planningStatus: "draft",
      }),
    });
    expect(response.status).toBe(201);
    await expect(json(response)).resolves.toMatchObject({
      task: {
        title: "Externally planned task",
        status: "draft",
        specStatus: "draft",
        techDesignStatus: "draft",
      },
    });
  });

  it("refuses to approve a spec that was supplied already approved, and keeps the task startable", async () => {
    const repoPath = await createRepo();
    let runStarted = false;
    const server = await startTestServer(repoPath, async () => {
      runStarted = true;
      return { runId: "run-1", status: "running" } as never;
    });
    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Externally approved task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string; status: string } };
    expect(created.task.status).not.toBe("draft");

    const approval = await fetch(
      `${server.url}/api/tasks/${created.task.id}/approve-spec`,
      { method: "POST" },
    );

    await expectWebInputError(approval, "draft spec is required before approval");

    const run = await fetch(`${server.url}/api/tasks/${created.task.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(run.status).toBe(200);
    expect(runStarted).toBe(true);
  });

  it("enforces Bearer capabilities in local mode and audits success, denial, and domain failure", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const task = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Scoped token task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string } };
    const created = await createApiToken(repoPath, {
      name: "read-only agent",
      capabilities: ["tasks:read"],
      ownerUserId: (await createTokenOwner(repoPath)).id,
    });
    const authorization = `Bearer ${created.token}`;

    const listed = await fetch(`${server.url}/api/tasks`, {
      headers: { authorization },
    });
    expect(listed.status).toBe(200);

    const missing = await fetch(`${server.url}/api/tasks/missing-task`, {
      headers: { authorization },
    });
    expect(missing.status).toBe(404);

    const denied = await fetch(
      `${server.url}/api/tasks/${encodeURIComponent(task.task.id)}/runs`,
      { method: "POST", headers: { authorization } },
    );
    expect(denied.status).toBe(403);
    await expect(json(denied)).resolves.toEqual({
      error: {
        code: "capability_denied",
        message: "API token capability denied: runs:start is required",
      },
    });

    const unsupported = await fetch(`${server.url}/api/providers`, {
      headers: { authorization },
    });
    expect(unsupported.status).toBe(403);
    await expect(json(unsupported)).resolves.toEqual({
      error: {
        code: "capability_denied",
        message: "API tokens cannot access this endpoint",
      },
    });

    const last = created.token.at(-1);
    const invalidToken = `${created.token.slice(0, -1)}${last === "A" ? "B" : "A"}`;
    const invalid = await fetch(`${server.url}/api/tasks/invalid-token-target`, {
      headers: { authorization: `Bearer ${invalidToken}` },
    });
    expect(invalid.status).toBe(401);
    await expect(json(invalid)).resolves.toEqual({
      error: { code: "unauthorized", message: "invalid API token" },
    });

    const secretTarget = await fetch(
      `${server.url}/api/tasks/${encodeURIComponent(created.token)}`,
      { headers: { authorization } },
    );
    expect(secretTarget.status).toBe(404);

    await revokeApiToken(repoPath, created.record.id);
    const revoked = await fetch(`${server.url}/api/tasks`, {
      headers: { authorization },
    });
    expect(revoked.status).toBe(401);
    await expect(json(revoked)).resolves.toEqual({
      error: { code: "unauthorized", message: "invalid API token" },
    });

    const audit = await waitFor(
      async () =>
        (await readFile(apiTokenAuditPath(repoPath), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      (rows) => rows.length >= 9,
    );
    const requests = audit.filter((event) => event.event === "token.request");
    expect(requests).toEqual([
      expect.objectContaining({
        event: "token.request",
        tokenId: created.record.id,
        action: "tasks.list",
        capability: "tasks:read",
        decision: "allow",
        outcome: "success",
        httpStatus: 200,
        reasonCode: "ok",
      }),
      expect.objectContaining({
        action: "tasks.get",
        target: { taskId: "missing-task" },
        decision: "allow",
        outcome: "error",
        httpStatus: 404,
        reasonCode: "not_found",
      }),
      expect.objectContaining({
        action: "runs.start",
        capability: "runs:start",
        target: { taskId: task.task.id },
        decision: "deny",
        outcome: "error",
        httpStatus: 403,
        reasonCode: "capability_denied",
      }),
      expect.objectContaining({
        action: "api.unsupported",
        decision: "deny",
        outcome: "error",
        httpStatus: 403,
        reasonCode: "endpoint_not_allowed",
      }),
      expect.objectContaining({
        tokenId: created.record.id,
        action: "tasks.get",
        decision: "deny",
        outcome: "error",
        httpStatus: 401,
        reasonCode: "invalid_token",
      }),
      expect.objectContaining({
        tokenId: created.record.id,
        action: "tasks.get",
        decision: "allow",
        outcome: "error",
        httpStatus: 404,
        reasonCode: "not_found",
      }),
      expect.objectContaining({
        tokenId: created.record.id,
        action: "tasks.list",
        decision: "deny",
        outcome: "error",
        httpStatus: 401,
        reasonCode: "invalid_token",
      }),
    ]);
    expect(requests[5]).not.toHaveProperty("target");
    expect(JSON.stringify(audit)).not.toContain(created.token);
    expect(JSON.stringify(audit)).not.toContain("Spec body");

    const securityAudit = await waitFor(
      () => listSecurityAuditEvents(repoPath),
      (events) => events.some(
        (event) =>
          event.action === "tasks.view" &&
          event.actor.id === created.record.id &&
          event.target?.id === undefined,
      ),
    );
    expect(securityAudit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "runs.start",
          decision: "deny",
          reasonCode: "capability_denied",
          actor: { type: "api-token", id: created.record.id },
        }),
        expect.objectContaining({
          action: "tasks.view",
          target: { type: "task" },
          actor: { type: "api-token", id: created.record.id },
        }),
        expect.objectContaining({
          action: "tasks.view",
          decision: "deny",
          reasonCode: "invalid_token",
          target: { type: "task", id: "invalid-token-target" },
          actor: { type: "anonymous" },
        }),
      ]),
    );
    expect(JSON.stringify(securityAudit)).not.toContain(created.token);
    expect(JSON.stringify(securityAudit)).not.toContain("Spec body");
  });

  it("refuses a token that has no owner and one whose owner is gone", async () => {
    const repoPath = await createRepo();
    const owner = await createTokenOwner(repoPath);
    const created = await createApiToken(repoPath, {
      name: "orphan",
      capabilities: ["tasks:read"],
      ownerUserId: owner.id,
    });
    const server = await startTestServer(repoPath);

    // Legacy record: strip the owner the way a pre-ownership store looks.
    const storePath = apiTokenStorePath(repoPath);
    const file = JSON.parse(await readFile(storePath, "utf8")) as {
      tokens: Record<string, Record<string, unknown>>;
    };
    const withOwner = { ...file.tokens[created.record.id] };
    delete file.tokens[created.record.id].ownerUserId;
    await writeFile(storePath, JSON.stringify(file));

    const unowned = await fetch(`${server.url}/api/tasks`, {
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(unowned.status).toBe(401);
    await expect(json(unowned)).resolves.toMatchObject({
      error: { message: expect.stringContaining("re-issue it with nitely mcp token create --owner") },
    });

    // Owner deleted after minting.
    file.tokens[created.record.id] = { ...withOwner, ownerUserId: "usr_deleted" };
    await writeFile(storePath, JSON.stringify(file));
    const missing = await fetch(`${server.url}/api/tasks`, {
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(missing.status).toBe(401);

    const audit = await waitFor(
      async () =>
        (await readFile(apiTokenAuditPath(repoPath), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((event) => event.event === "token.request"),
      (events) => events.length >= 2,
    );
    expect(audit.map((event) => event.reasonCode)).toEqual([
      "token_unowned",
      "owner_missing",
    ]);
    expect(JSON.stringify(audit)).not.toContain(created.token);
  });

  it("acts as the token owner, with the owner's role and an audited on-behalf-of link", async () => {
    const repoPath = await createRepo();
    const member = await createUser(repoPath, {
      email: "member@example.test",
      password: "member password passphrase",
      role: "user",
    });
    const created = await createApiToken(repoPath, {
      name: "member token",
      capabilities: ["tasks:read"],
      ownerUserId: member.id,
    });
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      authEnv: {},
    });

    const listed = await fetch(`${server.url}/api/tasks`, {
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(listed.status).toBe(200);

    const audit = await waitFor(
      async () =>
        (await readFile(apiTokenAuditPath(repoPath), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((event) => event.event === "token.request"),
      (events) => events.length >= 1,
    );
    expect(audit).toEqual([
      expect.objectContaining({
        tokenId: created.record.id,
        action: "tasks.list",
        decision: "allow",
        onBehalfOf: { userId: member.id },
      }),
    ]);
  });

  it("bounds a token to its owner's role: a viewer can read but not create tasks", async () => {
    const repoPath = await createRepo();
    const member = await createUser(repoPath, {
      email: "viewer-member@example.test",
      password: "member password passphrase",
      role: "user",
    });
    // Every user is auto-joined to a default organization as "member" (which
    // can write). Downgrade to "viewer" to get a real non-writing role.
    const [membership] = await listPublicMemberships(repoPath, member.id);
    await addOrganizationMember(repoPath, membership!.organizationId, {
      userId: member.id,
      role: "viewer",
    });
    const created = await createApiToken(repoPath, {
      name: "viewer member token",
      capabilities: ["tasks:read", "tasks:write"],
      allowHighImpact: true,
      ownerUserId: member.id,
    });
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      authEnv: {},
    });
    const authorization = `Bearer ${created.token}`;

    const listed = await fetch(`${server.url}/api/tasks`, {
      headers: { authorization },
    });
    expect(listed.status).toBe(200);

    const createResponse = await fetch(`${server.url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({
        title: "Should be forbidden",
        spec: "Spec body",
        techDesign: "Design body",
      }),
    });
    expect(createResponse.status).toBe(403);
  });

  it("lets a token select the owner's organization with x-nitely-organization-id", async () => {
    const repoPath = await createRepo();
    const owner = await createUser(repoPath, {
      email: "multi-org-owner@example.test",
      password: "multi org password passphrase",
      role: "user",
    });
    // "Second Team" sorts after the auto-joined "Default Team", so the
    // owner's default membership is the one a header-less request gets.
    const second = await createOrganization(repoPath, { name: "Second Team" });
    await addOrganizationMember(repoPath, second.id, {
      userId: owner.id,
      role: "member",
    });
    const [defaultTeam] = await listPublicMemberships(repoPath, owner.id);
    const created = await createApiToken(repoPath, {
      name: "multi-org token",
      capabilities: ["tasks:read", "tasks:write"],
      allowHighImpact: true,
      ownerUserId: owner.id,
    });
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      authEnv: {},
    });
    const authorization = `Bearer ${created.token}`;
    const body = JSON.stringify({
      title: "Org-scoped task",
      spec: "Spec body",
      techDesign: "Design body",
    });

    // No header: the default membership, exactly as a session would resolve it.
    const pinned = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body,
      }),
    )) as { task: { organizationId: string } };
    expect(pinned.task.organizationId).toBe(defaultTeam!.organizationId);

    // The header selects the owner's other organization.
    const selected = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization,
          "x-nitely-organization-id": second.id,
        },
        body,
      }),
    )) as { task: { organizationId: string } };
    expect(selected.task.organizationId).toBe(second.id);

    // An organization the owner does not belong to is refused, and the
    // refusal is audited as a token request denial like any other.
    const outsider = await createOrganization(repoPath, { name: "Zebra Team" });
    const denied = await fetch(`${server.url}/api/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization,
        "x-nitely-organization-id": outsider.id,
      },
      body,
    });
    expect(denied.status).toBe(403);

    const audit = await waitFor(
      async () =>
        (await readFile(apiTokenAuditPath(repoPath), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((event) => event.event === "token.request"),
      (events) => events.length >= 3,
    );
    expect(audit.at(-1)).toMatchObject({
      decision: "deny",
      reasonCode: "organization_denied",
      onBehalfOf: { userId: owner.id },
    });
  });

  it("accepts scoped Bearer tokens independently of browser sessions in required mode", async () => {
    const repoPath = await createRepo();
    const created = await createApiToken(repoPath, {
      name: "required-mode agent",
      capabilities: ["tasks:read", "tasks:write"],
      ownerUserId: (await createTokenOwner(repoPath)).id,
      allowHighImpact: true,
    });
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      authEnv: {},
    });
    const authorization = `Bearer ${created.token}`;

    const response = await fetch(`${server.url}/api/tasks`, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Machine-local operator task",
        spec: "Spec body",
        techDesign: "Design body",
      }),
    });
    expect(response.status).toBe(201);
    await expect(json(response)).resolves.toMatchObject({
      task: { title: "Machine-local operator task" },
    });
    await expect(
      json(
        await fetch(`${server.url}/api/tasks`, {
          headers: { authorization },
        }),
      ),
    ).resolves.toMatchObject({
      tasks: [expect.objectContaining({ title: "Machine-local operator task" })],
    });
  });

  it("lets a token use the provider credential its owner entered in the Console", async () => {
    const repoPath = await createRepo();
    const owner = await createTokenOwner(repoPath);
    const stranger = await createUser(repoPath, {
      email: "stranger@example.test",
      password: "stranger password passphrase",
      role: "admin",
    });
    const token = await createApiToken(repoPath, {
      name: "owner laptop",
      capabilities: ["tasks:read", "tasks:write", "runs:start"],
      allowHighImpact: true,
      ownerUserId: owner.id,
    });
    let seenEnv: Record<string, string | undefined> = {};
    let runnerCalled = false;
    let credentialSources: string[] = [];
    const server = await startTestServer(
      repoPath,
      async (_input, dependencies) => {
        credentialSources =
          dependencies?.providerStore?.describeCredentialSources?.() ?? [];
        seenEnv = (await dependencies?.providerStore?.resolveEnv()) ?? {};
        // Flipped last: the assertions below wait on this flag and then read
        // what the two lines above captured.
        runnerCalled = true;
        const runId = admittedRunId(dependencies, "run-owner-cred");
        return {
          runId,
          branchName: `nitely/${runId}`,
          worktreePath: join(repoPath, ".nitely", "worktrees", runId),
        } satisfies RunFlowResult;
      },
      undefined,
      {
        authMode: "required",
        authEnv: {},
        providerEnv: {},
      },
    );
    const authorization = `Bearer ${token.token}`;

    const createdTask = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({
          title: "Owner credential task",
          spec: "Spec body",
          techDesign: "Design body",
          flowPath: "flows/implement-spec-bootstrap-claude.json",
        }),
      }),
    )) as { task: { id: string } };
    const detail = async () =>
      (await json(
        await fetch(`${server.url}/api/tasks/${createdTask.task.id}`, {
          headers: { authorization },
        }),
      )) as { preflight: { status: string; issues: Array<{ code: string; remediation: string }> } };

    // Nobody has configured anthropic: blocked, and the message names the owner's file.
    const before = await detail();
    expect(before.preflight.status).toBe("BLOCK");
    expect(
      before.preflight.issues.find((issue) => issue.code === "runtime-unavailable")?.remediation,
    ).toContain(join(repoPath, ".nitely", "users", owner.id, "connections.json"));

    // A different user's credential is invisible to this token.
    const strangerLogin = await login(server, stranger.email, "stranger password passphrase");
    expect(
      (
        await fetch(`${server.url}/api/providers/anthropic/connection`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: strangerLogin.cookie },
          body: JSON.stringify({ value: "sk-ant-oat-stranger" }),
        })
      ).status,
    ).toBe(200);
    expect((await detail()).preflight.status).toBe("BLOCK");

    const blockedStart = await fetch(
      `${server.url}/api/tasks/${createdTask.task.id}/runs`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: "{}",
      },
    );
    expect(blockedStart.status).toBe(400);
    expect(JSON.stringify(await json(blockedStart))).toMatch(
      /no configured runtime candidate/i,
    );

    // The owner's own Console entry is what the token runs with.
    const ownerLogin = await login(server, owner.email, owner.password);
    expect(
      (
        await fetch(`${server.url}/api/providers/anthropic/connection`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: ownerLogin.cookie },
          body: JSON.stringify({ value: "sk-ant-oat-owner" }),
        })
      ).status,
    ).toBe(200);
    const after = await detail();
    expect(after.preflight.issues.map((issue) => issue.code)).not.toContain("runtime-unavailable");

    const started = await fetch(
      `${server.url}/api/tasks/${createdTask.task.id}/runs`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: "{}",
      },
    );
    expect(started.status).toBe(200);
    await vi.waitFor(() => {
      expect(runnerCalled).toBe(true);
    });
    const ownerStorePath = join(
      repoPath,
      ".nitely",
      "users",
      owner.id,
      "connections.json",
    );
    expect(credentialSources[0]).toBe(ownerStorePath);
    const ownerStore = await readFile(ownerStorePath, "utf8");
    expect(JSON.parse(ownerStore).connections).toEqual([
      expect.objectContaining({ providerId: "anthropic", authMethod: "oauth_token" }),
    ]);
    // Connection metadata never carries the secret; the sibling secret store does.
    expect(ownerStore).not.toContain("sk-ant-oat-owner");
    // Console OAuth tokens are stored under CLAUDE_CODE_OAUTH_TOKEN, not ANTHROPIC_API_KEY.
    expect(seenEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-owner");
  });

  it("lets a token fall back to the repository-wide credential when its owner has none configured", async () => {
    const repoPath = await createRepo();
    const owner = await createTokenOwner(repoPath);
    // Nobody has configured the owner's own store; the shared repo-level
    // connections.json is the fallback `providerStoreForUser` reads.
    await new FileProviderConnectionStore({
      path: join(repoPath, ".nitely", "connections.json"),
      env: {},
    }).setConnection({
      providerId: "anthropic",
      value: "sk-ant-oat-shared",
      metadata: { scope: "repo", source: "web-console" },
    });
    const token = await createApiToken(repoPath, {
      name: "owner laptop",
      capabilities: ["tasks:read", "tasks:write", "runs:start"],
      allowHighImpact: true,
      ownerUserId: owner.id,
    });
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      authEnv: {},
      providerEnv: {},
    });
    const authorization = `Bearer ${token.token}`;

    const createdTask = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({
          title: "Repo-store fallback task",
          spec: "Spec body",
          techDesign: "Design body",
          flowPath: "flows/implement-spec-bootstrap-claude.json",
        }),
      }),
    )) as { task: { id: string } };
    const detail = (await json(
      await fetch(`${server.url}/api/tasks/${createdTask.task.id}`, {
        headers: { authorization },
      }),
    )) as { preflight: { status: string; issues: Array<{ code: string }> } };

    expect(detail.preflight.issues.map((issue) => issue.code)).not.toContain(
      "runtime-unavailable",
    );
  });

  it("creates and resolves approval inbox notifications for generated planning artifacts", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);

    const draftSpecResponse = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "prompt",
        title: "Add export button",
        prompt: "Users need an export button on the task page.",
      }),
    });
    expect(draftSpecResponse.status).toBe(201);
    const draftSpecBody = await json(draftSpecResponse) as {
      task: { id: string; specPath: string };
    };

    const specInbox = await json(await fetch(`${server.url}/api/notifications`));
    expect(specInbox).toMatchObject({
      summary: { pending: 1 },
      notifications: [
        expect.objectContaining({
          taskId: draftSpecBody.task.id,
          type: "review-spec",
          status: "pending",
          title: "Review draft spec",
          link: `/tasks/${draftSpecBody.task.id}`,
        }),
      ],
    });

    await writeRefinedSourceSpecificSpec(repoPath, draftSpecBody.task, "Add export button");
    const approveSpecResponse = await fetch(
      `${server.url}/api/tasks/${encodeURIComponent(draftSpecBody.task.id)}/approve-spec`,
      { method: "POST" },
    );
    expect(approveSpecResponse.status).toBe(200);

    const afterSpecApproval = await json(
      await fetch(`${server.url}/api/notifications?status=pending`),
    );
    expect(afterSpecApproval).toMatchObject({
      summary: { pending: 0 },
      notifications: [],
    });

    const draftTechDesignResponse = await fetch(
      `${server.url}/api/tasks/${encodeURIComponent(draftSpecBody.task.id)}/draft-tech-design`,
      { method: "POST" },
    );
    expect(draftTechDesignResponse.status).toBe(200);

    const techDesignInbox = await json(
      await fetch(`${server.url}/api/notifications?status=pending`),
    );
    expect(techDesignInbox).toMatchObject({
      summary: { pending: 1 },
      notifications: [
        expect.objectContaining({
          taskId: draftSpecBody.task.id,
          type: "review-tech-design",
          status: "pending",
          title: "Review draft technical design",
          link: `/tasks/${draftSpecBody.task.id}`,
        }),
      ],
    });

    const approveTechDesignResponse = await fetch(
      `${server.url}/api/tasks/${encodeURIComponent(draftSpecBody.task.id)}/approve-tech-design`,
      { method: "POST" },
    );
    expect(approveTechDesignResponse.status).toBe(200);

    const afterTechDesignApproval = await json(
      await fetch(`${server.url}/api/notifications?status=pending`),
    );
    expect(afterTechDesignApproval).toMatchObject({
      summary: { pending: 0 },
      notifications: [],
    });
    await expect(
      json(
        await fetch(
          `${server.url}/api/tasks/${encodeURIComponent(draftSpecBody.task.id)}`,
        ),
      ),
    ).resolves.toMatchObject({
      notificationDecisions: [
        expect.objectContaining({ action: "approve" }),
        expect.objectContaining({ action: "approve" }),
      ],
    });
  });

  it("dispatches newly created inbox items through configured notification targets", async () => {
    const repoPath = await createRepo();
    const deliveredSourceKeys: string[] = [];
    const server = await startTestServer(repoPath, undefined, undefined, {
      notificationDeliveryTargets: [
        {
          channel: "webhook",
          deliver: async (notification) => {
            deliveredSourceKeys.push(notification.sourceKey);
            return { externalId: "webhook-request-1" };
          },
        },
      ],
    });

    const response = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "prompt",
        title: "Delivery-aware planning",
        prompt: "Create a spec and notify reviewers.",
      }),
    });
    expect(response.status).toBe(201);
    const created = (await json(response)) as { task: { id: string } };
    const sourceKey = `task:${created.task.id}:draft-spec`;

    expect(deliveredSourceKeys).toEqual([sourceKey]);
    await expect(
      listNotificationDeliveryReceipts(repoPath, sourceKey),
    ).resolves.toEqual([
      expect.objectContaining({
        channel: "webhook",
        status: "delivered",
        attempts: 1,
        externalId: "webhook-request-1",
      }),
    ]);
    await expect(
      json(await fetch(`${server.url}/api/notifications?status=pending`)),
    ).resolves.toMatchObject({
      notifications: [
        expect.objectContaining({
          sourceKey,
          deliveries: [
            expect.objectContaining({
              channel: "webhook",
              status: "delivered",
              attempts: 1,
            }),
          ],
        }),
      ],
    });
  });

  it("requests planning changes with a required reason and exposes task evidence", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const created = (await json(
      await fetch(`${server.url}/api/draft-specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceType: "prompt",
          title: "Reviewable planning",
          prompt: "Generate a spec that can receive structured review feedback.",
        }),
      }),
    )) as { task: { id: string } };
    const inbox = (await json(
      await fetch(`${server.url}/api/notifications?status=pending`),
    )) as { notifications: Array<{ id: string }> };
    const notificationId = inbox.notifications[0]!.id;

    const missingReason = await fetch(
      `${server.url}/api/notifications/${encodeURIComponent(notificationId)}/actions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "request-changes" }),
      },
    );
    await expectWebInputError(
      missingReason,
      "reason is required for notification action request-changes",
    );

    const response = await fetch(
      `${server.url}/api/notifications/${encodeURIComponent(notificationId)}/actions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "request-changes",
          reason: "State the retry and rollback behavior explicitly.",
        }),
      },
    );
    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toMatchObject({
      notification: {
        id: notificationId,
        status: "resolved",
        resolution: "request-changes",
        reason: "State the retry and rollback behavior explicitly.",
      },
      decision: {
        action: "request-changes",
        taskId: created.task.id,
        reason: "State the retry and rollback behavior explicitly.",
      },
    });

    const detail = (await json(
      await fetch(`${server.url}/api/tasks/${encodeURIComponent(created.task.id)}`),
    )) as {
      task: {
        specStatus?: string;
        planningArtifacts?: {
          spec?: {
            currentVersionId: string;
            revisions: Array<{
              versionId: string;
              approvalState: string;
              decisions: Array<{ decision: string; reason?: string }>;
            }>;
          };
        };
      };
      notificationDecisions?: Array<{
        action: string;
        actorId: string;
        reason?: string;
      }>;
    };
    const currentSpec = detail.task.planningArtifacts?.spec;
    expect(detail.task.specStatus).toBe("draft");
    expect(
      currentSpec?.revisions.find(
        (revision) => revision.versionId === currentSpec.currentVersionId,
      ),
    ).toMatchObject({
      approvalState: "changes_requested",
      decisions: [
        {
          decision: "request_changes",
          reason: "State the retry and rollback behavior explicitly.",
        },
      ],
    });
    expect(detail.notificationDecisions).toEqual([
      expect.objectContaining({
        action: "request-changes",
        actorId: "local",
        reason: "State the retry and rollback behavior explicitly.",
      }),
    ]);
  });

  it("approves a draft planning artifact through its declared notification action", async () => {
    const repoPath = await createRepo();
    const task = await createTask(
      repoPath,
      {
        title: "Action-approved planning",
        spec: "A concrete, operator-authored specification.",
        techDesign: "A concrete technical design.",
      },
      {
        initialStatus: "draft",
        specStatus: "draft",
        techDesignStatus: "draft",
      },
    );
    const notification = await upsertNotification(repoPath, {
      sourceKey: `task:${task.id}:draft-spec`,
      type: "review-spec",
      severity: "info",
      title: "Review draft spec",
      taskId: task.id,
      link: `/tasks/${task.id}`,
    });
    const server = await startTestServer(repoPath);

    const response = await fetch(
      `${server.url}/api/notifications/${encodeURIComponent(notification.id)}/actions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      },
    );
    const responseBody = await json(response);
    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody).toMatchObject({
      notification: { status: "resolved", resolution: "approve" },
      decision: { action: "approve", taskId: task.id },
    });
    await expect(
      json(await fetch(`${server.url}/api/tasks/${encodeURIComponent(task.id)}`)),
    ).resolves.toMatchObject({
      task: { specStatus: "approved" },
      notificationDecisions: [expect.objectContaining({ action: "approve" })],
    });
  });

  it("approves a workflow gate through the same notification action contract", async () => {
    const repoPath = await createRepo();
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const store = new EventStore(join(repoPath, ".nitely", "events.db"));
    store.append({
      runId: "run-action-approval",
      stageId: "review-route",
      attempt: 1,
      type: "approval.requested",
      payload: {
        approvalId: "approve-route-1",
        prompt: "Approve the proposed rework route.",
        reviewedArtifactIds: ["review-route"],
      },
    });
    store.close();
    const notification = await upsertNotification(repoPath, {
      sourceKey: "task:task-action-approval:approval:run-action-approval:approve-route-1",
      type: "review-rework",
      severity: "warning",
      title: "Approval required",
      runId: "run-action-approval",
      artifactId: "review-route",
      link: "/tasks/task-action-approval",
    });
    const server = await startTestServer(repoPath);

    const response = await fetch(
      `${server.url}/api/notifications/${encodeURIComponent(notification.id)}/actions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      },
    );
    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toMatchObject({
      notification: { status: "resolved", resolution: "approve" },
      decision: {
        action: "approve",
        runId: "run-action-approval",
        artifactId: "review-route",
      },
    });

    const evidence = new EventStore(join(repoPath, ".nitely", "events.db"));
    expect(evidence.list("run-action-approval")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "approval.resolved",
          payload: expect.objectContaining({ decision: "approved" }),
        }),
        expect.objectContaining({
          type: "notification.decision",
          payload: expect.objectContaining({
            action: "approve",
            artifactId: "review-route",
          }),
        }),
      ]),
    );
    evidence.close();
  });

  it("cancels a blocked run once and records the explicit terminal decision", async () => {
    const repoPath = await createRepo();
    const task = await createTask(repoPath, {
      title: "Cancel blocked work",
      spec: "Spec body",
      techDesign: "Design body",
    });
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const store = new EventStore(join(repoPath, ".nitely", "events.db"));
    store.append({
      runId: "run-cancel-notification",
      type: "run.created",
      payload: { workItemId: task.id, flowName: "test" },
    });
    store.append({
      runId: "run-cancel-notification",
      type: "run.blocked",
      payload: { reason: "awaiting_operator_answer", message: "Input required" },
    });
    store.close();
    const notification = await upsertNotification(repoPath, {
      sourceKey: `task:${task.id}:run-blocked:run-cancel-notification`,
      type: "resolve-blocker",
      severity: "blocker",
      title: "Run needs human input",
      taskId: task.id,
      runId: "run-cancel-notification",
      link: `/tasks/${task.id}`,
    });
    const server = await startTestServer(repoPath);
    const actionUrl = `${server.url}/api/notifications/${encodeURIComponent(notification.id)}/actions`;
    const body = JSON.stringify({
      action: "cancel-run",
      reason: "The request is obsolete and should not be resumed.",
    });

    const first = await fetch(actionUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(first.status).toBe(200);
    await expect(json(first)).resolves.toMatchObject({
      notification: { status: "resolved", resolution: "cancel-run" },
      decision: {
        action: "cancel-run",
        runId: "run-cancel-notification",
        reason: "The request is obsolete and should not be resumed.",
      },
    });
    const retry = await fetch(actionUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(retry.status).toBe(200);

    const evidence = new EventStore(join(repoPath, ".nitely", "events.db"));
    const events = evidence.list("run-cancel-notification");
    expect(projectRun(events).status).toBe("cancelled");
    expect(events.filter((event) => event.type === "run.cancelled")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          actor: "local",
          notificationId: notification.id,
          reason: "The request is obsolete and should not be resumed.",
        }),
      }),
    ]);
    expect(events.filter((event) => event.type === "notification.decision")).toHaveLength(1);
    evidence.close();

    const completedStore = new EventStore(join(repoPath, ".nitely", "events.db"));
    completedStore.append({
      runId: "run-final-cancel-notification",
      type: "run.created",
      payload: { workItemId: task.id, flowName: "test" },
    });
    completedStore.append({
      runId: "run-final-cancel-notification",
      type: "run.completed",
      payload: {},
    });
    completedStore.close();
    const finalNotification = await upsertNotification(repoPath, {
      sourceKey: `task:${task.id}:run-blocked:run-final-cancel-notification`,
      type: "resolve-blocker",
      severity: "blocker",
      title: "Completed run cannot be cancelled",
      taskId: task.id,
      runId: "run-final-cancel-notification",
      link: `/tasks/${task.id}`,
    });
    const finalResponse = await fetch(
      `${server.url}/api/notifications/${encodeURIComponent(finalNotification.id)}/actions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "cancel-run",
          reason: "This should be rejected because completion is final.",
        }),
      },
    );
    await expectWebInputError(finalResponse, "linked run is already completed");
    await expect(getNotification(repoPath, finalNotification.id)).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("aborts an active run controller when a cancel-run notification is resolved", async () => {
    const repoPath = await createRepo();
    const task = await createTask(repoPath, {
      title: "Cancel active work",
      spec: "Spec body",
      techDesign: "Design body",
    });
    let capturedSignal: AbortSignal | undefined;
    let abortSeen: Promise<void> | undefined;
    const server = await startTestServer(repoPath, async (_input, dependencies) => {
      const runId = admittedRunId(dependencies, "run-active-cancel");
      capturedSignal = dependencies?.cancellation?.signal;
      dependencies?.cancellation?.onStageChange?.({ stageId: "implement", attempt: 1 });
      const store = new EventStore(join(repoPath, ".nitely", "events.db"));
      try {
        store.append({
          runId,
          type: "run.created",
          payload: { workItemId: task.id, flowName: "test" },
        });
        store.append({
          runId,
          stageId: "implement",
          attempt: 1,
          type: "stage.started",
          payload: {},
        });
      } finally {
        store.close();
      }
      abortSeen = new Promise((resolveAbort, rejectAbort) => {
        if (!capturedSignal) {
          rejectAbort(new Error("run cancellation signal was not provided"));
          return;
        }
        capturedSignal.addEventListener("abort", () => resolveAbort(), { once: true });
      });
      await abortSeen;
      throw new Error("run cancelled by test");
    });
    const start = await fetch(`${server.url}/api/tasks/${encodeURIComponent(task.id)}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(start.status).toBe(200);
    const started = (await json(start)) as { run: { runId: string } };
    const notification = await upsertNotification(repoPath, {
      sourceKey: `task:${task.id}:run-blocked:${started.run.runId}`,
      type: "resolve-blocker",
      severity: "blocker",
      title: "Run needs human input",
      taskId: task.id,
      runId: started.run.runId,
      link: `/tasks/${task.id}`,
    });

    const cancel = await fetch(
      `${server.url}/api/notifications/${encodeURIComponent(notification.id)}/actions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "cancel-run",
          reason: "Operator stopped the active run.",
        }),
      },
    );

    expect(cancel.status).toBe(200);
    await abortSeen;
    expect(capturedSignal?.aborted).toBe(true);
    expect(capturedSignal?.reason).toMatchObject({
      actor: "local",
      reason: "Operator stopped the active run.",
      source: "web-notification",
      notificationId: notification.id,
    });

    const evidence = new EventStore(join(repoPath, ".nitely", "events.db"));
    const events = evidence.list(started.run.runId);
    evidence.close();
    expect(projectRun(events).status).toBe("cancelled");
    expect(events.filter((event) => event.type === "run.cancelled")).toEqual([
      expect.objectContaining({
        stageId: "implement",
        attempt: 1,
        payload: expect.objectContaining({
          actor: "local",
          notificationId: notification.id,
          reason: "Operator stopped the active run.",
          affectedStage: "implement",
          affectedAttempt: 1,
          cleanup: expect.objectContaining({
            result: "abort-signal-dispatched",
            terminateWithinMs: 10_000,
          }),
        }),
      }),
    ]);
  });

  it("overrides an inbox blocker with a reason without pretending the run recovered", async () => {
    const repoPath = await createRepo();
    const task = await createTask(repoPath, {
      title: "Override notification only",
      spec: "Spec body",
      techDesign: "Design body",
    });
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const store = new EventStore(join(repoPath, ".nitely", "events.db"));
    store.append({
      runId: "run-override-notification",
      type: "run.created",
      payload: { workItemId: task.id, flowName: "test" },
    });
    store.append({
      runId: "run-override-notification",
      type: "run.blocked",
      payload: { reason: "provider_setup_required", message: "Provider missing" },
    });
    store.close();
    const notification = await upsertNotification(repoPath, {
      sourceKey: `task:${task.id}:run-blocked:run-override-notification`,
      type: "resolve-blocker",
      severity: "blocker",
      title: "Run needs human input",
      taskId: task.id,
      runId: "run-override-notification",
      link: `/tasks/${task.id}`,
    });
    const server = await startTestServer(repoPath);

    const response = await fetch(
      `${server.url}/api/notifications/${encodeURIComponent(notification.id)}/actions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "override",
          reason: "Track recovery outside this inbox item; do not resume automatically.",
        }),
      },
    );
    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toMatchObject({
      notification: { status: "resolved", resolution: "override" },
      decision: {
        action: "override",
        reason: "Track recovery outside this inbox item; do not resume automatically.",
      },
    });
    const evidence = new EventStore(join(repoPath, ".nitely", "events.db"));
    const events = evidence.list("run-override-notification");
    expect(projectRun(events).status).toBe("blocked");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "notification.decision",
          payload: expect.objectContaining({ action: "override" }),
        }),
      ]),
    );
    evidence.close();
  });

  it("approves and denies memory proposals through notification actions", async () => {
    const repoPath = await createRepo();
    const approveProposal = await createContextKnowledgeEntry(repoPath, {
      category: "decisions",
      title: "Keep decisions durable",
      body: "Record notification decisions alongside the task.",
      status: "proposed",
    });
    const denyProposal = await createContextKnowledgeEntry(repoPath, {
      category: "pitfalls",
      title: "Transient-only approvals",
      body: "Do not keep approvals only in process memory.",
      status: "proposed",
    });
    const approveNotification = await upsertNotification(repoPath, {
      sourceKey: `context-kg:${approveProposal.id}:proposal`,
      type: "review-memory",
      severity: "info",
      title: `Review memory proposal: ${approveProposal.title}`,
      link: `/context-kg?entry=${encodeURIComponent(approveProposal.id)}`,
      proposalId: approveProposal.id,
    });
    const denyNotification = await upsertNotification(repoPath, {
      sourceKey: `context-kg:${denyProposal.id}:proposal`,
      type: "review-memory",
      severity: "info",
      title: `Review memory proposal: ${denyProposal.title}`,
      link: `/context-kg?entry=${encodeURIComponent(denyProposal.id)}`,
      proposalId: denyProposal.id,
    });
    const server = await startTestServer(repoPath);

    const approve = await fetch(
      `${server.url}/api/notifications/${encodeURIComponent(approveNotification.id)}/actions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      },
    );
    expect(approve.status).toBe(200);
    await expect(json(approve)).resolves.toMatchObject({
      notification: { status: "resolved", resolution: "approve" },
      decision: { action: "approve" },
    });

    const deny = await fetch(
      `${server.url}/api/notifications/${encodeURIComponent(denyNotification.id)}/actions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "deny" }),
      },
    );
    expect(deny.status).toBe(200);
    await expect(json(deny)).resolves.toMatchObject({
      notification: { status: "resolved", resolution: "deny" },
      decision: { action: "deny" },
    });

    await expect(json(await fetch(`${server.url}/api/context-kg`))).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ id: approveProposal.id, status: "approved" }),
        expect.objectContaining({ id: denyProposal.id, status: "rejected" }),
      ]),
    });
  });

  it("rejects legacy resolutions that cannot produce a declared decision", async () => {
    const repoPath = await createRepo();
    const task = await createTask(repoPath, {
      title: "Declared legacy resolution",
      spec: "Spec body",
      techDesign: "Design body",
    });
    const notification = await upsertNotification(repoPath, {
      sourceKey: `task:${task.id}:restricted-review`,
      type: "review-spec",
      severity: "info",
      title: "Approve this review explicitly",
      taskId: task.id,
      link: `/tasks/${task.id}`,
      supportedActions: ["approve"],
      requiredReasonActions: [],
    });
    const server = await startTestServer(repoPath);

    const response = await fetch(
      `${server.url}/api/notifications/${encodeURIComponent(notification.id)}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resolution: "resolved" }),
      },
    );

    await expectWebInputError(
      response,
      "legacy notification resolution does not match a declared action",
    );
    await expect(getNotification(repoPath, notification.id)).resolves.toMatchObject({
      status: "pending",
    });
    await expect(
      listTaskNotificationDecisions(repoPath, task.id),
    ).resolves.toEqual([]);
  });

  it("routes compatible legacy approvals through the same action side effects", async () => {
    const repoPath = await createRepo();
    const proposal = await createContextKnowledgeEntry(repoPath, {
      category: "decisions",
      title: "One notification action service",
      body: "Compatibility routes must preserve the canonical action side effects.",
      status: "proposed",
    });
    const notification = await upsertNotification(repoPath, {
      sourceKey: `context-kg:${proposal.id}:proposal`,
      type: "review-memory",
      severity: "info",
      title: "Review notification action service memory",
      proposalId: proposal.id,
      link: `/context-kg?entry=${encodeURIComponent(proposal.id)}`,
    });
    const server = await startTestServer(repoPath);

    const response = await fetch(
      `${server.url}/api/notifications/${encodeURIComponent(notification.id)}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resolution: "approved" }),
      },
    );

    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toMatchObject({
      notification: { status: "resolved", resolution: "approve" },
      decision: { action: "approve" },
    });
    await expect(json(await fetch(`${server.url}/api/context-kg`))).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ id: proposal.id, status: "approved" }),
      ]),
    });
  });

  it("rejects action names passed as free-form legacy resolutions", async () => {
    const repoPath = await createRepo();
    const task = await createTask(repoPath, {
      title: "Strict legacy notification resolution",
      spec: "Spec body",
      techDesign: "Design body",
    });
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const store = new EventStore(join(repoPath, ".nitely", "events.db"));
    store.append({
      runId: "run-legacy-cancel",
      type: "run.created",
      payload: { workItemId: task.id, flowName: "test" },
    });
    store.append({
      runId: "run-legacy-cancel",
      type: "run.blocked",
      payload: { reason: "operator_input", message: "Input required" },
    });
    store.close();
    const cancelNotification = await upsertNotification(repoPath, {
      sourceKey: `task:${task.id}:run-blocked:run-legacy-cancel`,
      type: "resolve-blocker",
      severity: "blocker",
      title: "Do not bypass cancel reason",
      taskId: task.id,
      runId: "run-legacy-cancel",
      link: `/tasks/${task.id}`,
    });
    const overrideNotification = await upsertNotification(repoPath, {
      sourceKey: `task:${task.id}:run-blocked:run-legacy-override`,
      type: "resolve-blocker",
      severity: "blocker",
      title: "Do not bypass override reason",
      taskId: task.id,
      runId: "run-legacy-cancel",
      link: `/tasks/${task.id}`,
    });
    const server = await startTestServer(repoPath);

    for (const [notificationId, resolution] of [
      [cancelNotification.id, "cancel-run"],
      [overrideNotification.id, "override"],
    ] as const) {
      const response = await fetch(
        `${server.url}/api/notifications/${encodeURIComponent(notificationId)}/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ resolution }),
        },
      );
      await expectWebInputError(
        response,
        "legacy notification resolution does not match a declared action",
      );
      await expect(getNotification(repoPath, notificationId)).resolves.toMatchObject({
        status: "pending",
      });
    }

    const evidence = new EventStore(join(repoPath, ".nitely", "events.db"));
    expect(evidence.list("run-legacy-cancel").some((event) =>
      event.type === "run.cancelled" || event.type === "notification.decision"
    )).toBe(false);
    evidence.close();
  });

  it("records immutable planning artifact revisions through spec and technical design approval", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);

    const draftSpecResponse = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "prompt",
        title: "Versioned planning",
        prompt: "Generate immutable spec and technical design versions.",
      }),
    });
    expect(draftSpecResponse.status).toBe(201);
    const draftSpec = (await json(draftSpecResponse)) as {
      task: {
        id: string;
        specPath: string;
        planningArtifacts: {
          spec: {
            currentVersionId: string;
            approvedVersionId?: string;
            revisions: Array<{
              versionId: string;
              approvalState: string;
              parentVersionId?: string;
            }>;
          };
          techDesign: {
            currentVersionId: string;
            approvedVersionId?: string;
            revisions: Array<{
              versionId: string;
              approvalState: string;
              parentVersionId?: string;
            }>;
          };
        };
      };
    };
    expect(draftSpec.task.planningArtifacts.spec).toMatchObject({
      currentVersionId: "spec-r1",
      revisions: [{ versionId: "spec-r1", approvalState: "draft" }],
    });
    expect(draftSpec.task.planningArtifacts.spec.approvedVersionId).toBeUndefined();
    expect(draftSpec.task.planningArtifacts.techDesign).toMatchObject({
      currentVersionId: "tech-design-r1",
      revisions: [{ versionId: "tech-design-r1", approvalState: "draft" }],
    });

    await writeRefinedSourceSpecificSpec(repoPath, draftSpec.task, "Versioned planning");
    const approveSpecResponse = await fetch(
      `${server.url}/api/tasks/${encodeURIComponent(draftSpec.task.id)}/approve-spec`,
      { method: "POST" },
    );
    expect(approveSpecResponse.status).toBe(200);
    const approvedSpec = (await json(approveSpecResponse)) as {
      task: {
        planningArtifacts: {
          spec: {
            currentVersionId: string;
            approvedVersionId?: string;
            revisions: Array<{
              versionId: string;
              approvalState: string;
              parentVersionId?: string;
              decisions: Array<{ decision: string }>;
            }>;
          };
        };
      };
    };
    expect(approvedSpec.task.planningArtifacts.spec).toMatchObject({
      currentVersionId: "spec-r2",
      approvedVersionId: "spec-r2",
      revisions: [
        { versionId: "spec-r1", approvalState: "draft" },
        {
          versionId: "spec-r2",
          approvalState: "approved",
          parentVersionId: "spec-r1",
          decisions: [{ decision: "approve" }],
        },
      ],
    });

    const draftTechDesignResponse = await fetch(
      `${server.url}/api/tasks/${encodeURIComponent(draftSpec.task.id)}/draft-tech-design`,
      { method: "POST" },
    );
    expect(draftTechDesignResponse.status).toBe(200);
    const draftTechDesign = (await json(draftTechDesignResponse)) as {
      task: {
        planningArtifacts: {
          techDesign: {
            currentVersionId: string;
            approvedVersionId?: string;
            revisions: Array<{
              versionId: string;
              approvalState: string;
              parentVersionId?: string;
            }>;
          };
        };
      };
    };
    expect(draftTechDesign.task.planningArtifacts.techDesign).toMatchObject({
      currentVersionId: "tech-design-r2",
      revisions: [
        { versionId: "tech-design-r1", approvalState: "draft" },
        {
          versionId: "tech-design-r2",
          approvalState: "draft",
          parentVersionId: "tech-design-r1",
        },
      ],
    });
    expect(
      draftTechDesign.task.planningArtifacts.techDesign.approvedVersionId,
    ).toBeUndefined();

    const approveTechDesignResponse = await fetch(
      `${server.url}/api/tasks/${encodeURIComponent(draftSpec.task.id)}/approve-tech-design`,
      { method: "POST" },
    );
    expect(approveTechDesignResponse.status).toBe(200);
    const approvedTechDesign = (await json(approveTechDesignResponse)) as {
      task: {
        planningArtifacts: {
          techDesign: {
            currentVersionId: string;
            approvedVersionId?: string;
            revisions: Array<{
              versionId: string;
              approvalState: string;
              parentVersionId?: string;
              decisions: Array<{ decision: string }>;
            }>;
          };
        };
      };
    };
    expect(approvedTechDesign.task.planningArtifacts.techDesign).toMatchObject({
      currentVersionId: "tech-design-r3",
      approvedVersionId: "tech-design-r3",
      revisions: [
        { versionId: "tech-design-r1", approvalState: "draft" },
        { versionId: "tech-design-r2", approvalState: "draft" },
        {
          versionId: "tech-design-r3",
          approvalState: "approved",
          parentVersionId: "tech-design-r2",
          decisions: [{ decision: "approve" }],
        },
      ],
    });
  });

  it("includes blocker notifications in the action inbox", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const task = await createTask(repoPath, {
      title: "Blocked publish",
      spec: "Spec body",
      techDesign: "Design body",
    });

    await upsertNotification(repoPath, {
      sourceKey: `task:${task.id}:approval:run-approval:approve-spec-1`,
      type: "review-spec",
      severity: "warning",
      title: "Approval required",
      body: "Approve generated spec before design.",
      link: `/tasks/${task.id}`,
      taskId: task.id,
      runId: "run-approval",
    });
    await upsertNotification(repoPath, {
      sourceKey: `task:${task.id}:run-blocked:run-failed`,
      type: "resolve-blocker",
      severity: "blocker",
      title: "Run needs human input",
      body: "Command failed: gh pr create --draft",
      link: `/tasks/${task.id}`,
      taskId: task.id,
      runId: "run-failed",
    });

    const inbox = await json(await fetch(`${server.url}/api/notifications`));

    expect(inbox).toMatchObject({
      summary: { pending: 2 },
      notifications: expect.arrayContaining([
        expect.objectContaining({
          type: "resolve-blocker",
          taskId: task.id,
          runId: "run-failed",
        }),
        expect.objectContaining({
          type: "review-spec",
          taskId: task.id,
          runId: "run-approval",
        }),
      ]),
    });
    expect(JSON.stringify(inbox)).toContain("run-failed");
    expect(JSON.stringify(inbox)).toContain("resolve-blocker");
  });

  it("excludes stale approval notifications once the associated run is terminal", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const task = await createTask(repoPath, {
      title: "Failed approval run",
      spec: "Spec body",
      techDesign: "Design body",
    });
    const store = new EventStore(join(repoPath, ".nitely", "events.db"));
    try {
      store.append({
        runId: "run-failed-approval",
        type: "run.created",
        createdAt: "2026-06-26T14:13:59.000Z",
        payload: { flowName: "flow", workItemId: task.id },
      });
      store.append({
        runId: "run-failed-approval",
        type: "stage.started",
        stageId: "publish",
        attempt: 1,
        createdAt: "2026-06-26T14:14:00.000Z",
        payload: { type: "agent" },
      });
      store.append({
        runId: "run-failed-approval",
        type: "stage.failed",
        stageId: "publish",
        attempt: 1,
        createdAt: "2026-06-26T14:14:01.000Z",
        payload: { error: "gh pr create failed" },
      });
      store.append({
        runId: "run-failed-approval",
        type: "run.failed",
        createdAt: "2026-06-26T14:14:02.000Z",
        payload: { error: "publish failed" },
      });
    } finally {
      store.close();
    }
    await upsertNotification(repoPath, {
      sourceKey: `task:${task.id}:approval:run-failed-approval:approve-spec-1`,
      type: "review-spec",
      severity: "warning",
      title: "Approval required",
      body: "Approve generated spec before design.",
      link: `/tasks/${task.id}`,
      taskId: task.id,
      runId: "run-failed-approval",
    });

    const inbox = await json(await fetch(`${server.url}/api/notifications`));

    expect(inbox).toMatchObject({
      summary: { pending: 0 },
      notifications: [],
    });
  });

  it("does not treat PR review notifications as workflow approval actions", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const task = await createTask(repoPath, {
      title: "Review draft PR",
      spec: "Spec body",
      techDesign: "Design body",
    });
    await upsertNotification(repoPath, {
      sourceKey: `task:${task.id}:approval:run-pr-review:approve-spec-1`,
      type: "review-pr",
      severity: "info",
      title: "Review draft PR",
      body: "A draft PR has been published and needs human review.",
      link: "https://github.com/example/repo/pull/149",
      taskId: task.id,
      runId: "run-pr-review",
    });

    const inbox = (await json(await fetch(`${server.url}/api/notifications`))) as {
      notifications: Array<{ id: string; type: string }>;
    };
    expect(inbox.notifications[0]).toMatchObject({ type: "review-pr" });

    const resolveResponse = await fetch(
      `${server.url}/api/notifications/${encodeURIComponent(inbox.notifications[0].id)}/actions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "resolve" }),
      },
    );

    expect(resolveResponse.status).toBe(200);
    await expect(json(resolveResponse)).resolves.toMatchObject({
      notification: { status: "resolved", resolution: "resolve" },
      decision: { action: "resolve" },
    });
    const afterResolve = await json(
      await fetch(`${server.url}/api/notifications?status=pending`),
    );
    expect(afterResolve).toMatchObject({
      summary: { pending: 0 },
      notifications: [],
    });
  });

  it("auto-resolves pending PR review notifications when the linked PR is merged", async () => {
    const repoPath = await createRepo();
    const task = await createTask(repoPath, {
      title: "Review merged PR",
      spec: "Spec body",
      techDesign: "Design body",
    });
    await upsertNotification(repoPath, {
      sourceKey: `task:${task.id}:draft-pr:run-merged-pr`,
      type: "review-pr",
      severity: "info",
      title: "Review draft PR",
      body: "A draft PR has been published and needs human review.",
      link: "https://github.com/example/repo/pull/149",
      taskId: task.id,
      runId: "run-merged-pr",
    });
    const server = await startTestServer(repoPath, undefined, undefined, {
      getChangeRequestStatus: async () => ({
        provider: "github",
        state: "closed",
        merged: true,
      }),
    });

    await fetch(`${server.url}/api/notifications?status=pending`);
    const inbox = await waitFor(
      async () => await json(await fetch(`${server.url}/api/notifications?status=pending`)),
      (body) => ((body as { summary?: { pending?: number } }).summary?.pending ?? 1) === 0,
    );

    expect(inbox).toMatchObject({
      summary: { pending: 0 },
      notifications: [],
    });
    const all = await json(await fetch(`${server.url}/api/notifications`));
    expect(all).toMatchObject({
      summary: { resolved: 1 },
      notifications: [
        expect.objectContaining({
          type: "review-pr",
          status: "resolved",
          resolution: "change request merged",
        }),
      ],
    });
  });

  it("keeps approval-paused workflow runs pending and creates an approval inbox item", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, async (_input, dependencies) => {
      const runId = dependencies?.createRunId?.() ?? "run-approval";
      const store = new EventStore(join(repoPath, ".nitely", "events.db"));
      try {
        store.append({
          runId,
          stageId: "approve-tech-design",
          attempt: 1,
          type: "approval.requested",
          payload: {
            approvalId: "approve-tech-design-1",
            prompt: "Approve generated technical design before implementation",
            reviewedArtifactIds: ["tech-design"],
          },
        });
      } finally {
        store.close();
      }
      return {
        runId,
        branchName: `nitely/${runId}`,
        worktreePath: join(repoPath, ".nitely", "worktrees", runId),
        status: "awaiting-approval",
        approvalId: "approve-tech-design-1",
      };
    });
    const created = (await json(await fetch(`${server.url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Approval gated workflow",
        spec: "Spec body",
        techDesign: "Design body",
      }),
    }))) as { task: { id: string } };

    const runResponse = await fetch(
      `${server.url}/api/tasks/${encodeURIComponent(created.task.id)}/runs`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );

    expect(runResponse.status).toBe(200);
    const runBody = (await json(runResponse)) as {
      run: { status: string; runId: string; approvalId?: string };
    };
    expect(runBody.run).toMatchObject({
      status: "running",
    });

    const detail = await waitFor(
      async () =>
        (await json(await fetch(
          `${server.url}/api/tasks/${encodeURIComponent(created.task.id)}`,
        ))) as { task: { status: string; latestRunStatus?: string } },
      (body) => body.task.latestRunStatus === "awaiting-approval",
    );
    expect(detail.task).toMatchObject({
      status: "running",
      latestRunStatus: "awaiting-approval",
    });

    const inbox = await waitFor(
      async () => await json(await fetch(`${server.url}/api/notifications`)),
      (body) => (body as { summary?: { pending?: number } }).summary?.pending === 1,
    );
    expect(inbox).toMatchObject({
      summary: { pending: 1 },
      notifications: [
        expect.objectContaining({
          taskId: created.task.id,
          runId: runBody.run.runId,
          type: "review-tech-design",
          severity: "warning",
          title: "Approval required",
          body: "Approve generated technical design before implementation",
        }),
      ],
    });
  });

  it("creates and confirms implementation-scoped task rework requests against the existing PR", async () => {
    const repoPath = await createRepo();
    await writeTaskReworkFlow(repoPath);
    const task = await createTask(
      repoPath,
      {
        title: "Completed implementation",
        spec: "Spec body",
        techDesign: "Design body",
      },
      { createId: () => "task-request-changes" },
    );
    await updateTaskRunState(repoPath, task.id, {
      status: "completed",
      latestRunId: "run-original",
      changeRequestUrl: "https://github.com/Instask/nitely/pull/77",
    });
    const runInputs: RunFlowInput[] = [];
    const server = await startTestServer(
      repoPath,
      async (input, dependencies) => {
        runInputs.push(input);
        const runId = admittedRunId(dependencies, "run-rework");
        return {
          runId,
          branchName: `nitely/${runId}`,
          worktreePath: join(repoPath, ".nitely", "worktrees", runId),
          changeRequestUrl: "https://github.com/Instask/nitely/pull/77",
        };
      },
      undefined,
      { createRunId: () => "run-rework" },
    );

    const createResponse = await fetch(
      `${server.url}/api/tasks/${encodeURIComponent(task.id)}/rework-requests`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instruction: "Keep the same PR and update the implementation copy.",
          routeTarget: "implementation",
          idempotencyKey: "web-request-1",
        }),
      },
    );
    expect(createResponse.status).toBe(201);
    const createBody = (await json(createResponse)) as {
      reworkRequest: { id: string; status: string };
    };
    expect(createBody.reworkRequest).toMatchObject({
      status: "pending_confirmation",
    });

    await expect(
      json(await fetch(`${server.url}/api/tasks/${encodeURIComponent(task.id)}`)),
    ).resolves.toMatchObject({
      canRequestChanges: false,
      requestChangesDisabledReason: expect.stringContaining(
        createBody.reworkRequest.id,
      ),
      reworkRequests: [
        expect.objectContaining({
          id: createBody.reworkRequest.id,
          status: "pending_confirmation",
        }),
      ],
    });

    const confirmResponse = await fetch(
      `${server.url}/api/tasks/${encodeURIComponent(task.id)}/rework-requests/${encodeURIComponent(createBody.reworkRequest.id)}/confirm`,
      { method: "POST" },
    );
    expect(confirmResponse.status).toBe(200);
    await expect(json(confirmResponse)).resolves.toMatchObject({
      reworkRequest: {
        id: createBody.reworkRequest.id,
        runId: "run-rework",
      },
      run: {
        runId: "run-rework",
      },
    });
    expect(runInputs).toHaveLength(1);
    expect(runInputs[0]).toMatchObject({
      flowPath: "flows/rework-pr-bootstrap.json",
      workItemId: task.id,
      priorRunId: "run-original",
      trigger: {
        type: "task-rework-request",
        taskId: task.id,
        requestId: createBody.reworkRequest.id,
        routeTarget: "implementation",
        instruction: "Keep the same PR and update the implementation copy.",
        priorRunId: "run-original",
        changeRequestUrl: "https://github.com/Instask/nitely/pull/77",
        actorId: "local",
      },
      changeRequestTarget: {
        provider: "github-cli",
        target: "77",
      },
    });
    expect(runInputs[0]?.inputs).toMatchObject({
      spec: { connector: "local-file" },
      "tech-design": { connector: "local-file" },
    });
    await expect(
      readFile(runInputs[0]!.inputs.spec.uri, "utf8"),
    ).resolves.toContain("Keep the same PR and update the implementation copy.");

    const settled = await waitFor(
      async () =>
        (await json(
          await fetch(`${server.url}/api/tasks/${encodeURIComponent(task.id)}`),
        )) as { reworkRequests: Array<{ status: string; runId?: string }> },
      (body) => body.reworkRequests[0]?.status === "completed",
    );
    expect(settled.reworkRequests[0]).toMatchObject({
      status: "completed",
      runId: "run-rework",
    });

    const duplicateConfirmResponse = await fetch(
      `${server.url}/api/tasks/${encodeURIComponent(task.id)}/rework-requests/${encodeURIComponent(createBody.reworkRequest.id)}/confirm`,
      { method: "POST" },
    );
    expect(duplicateConfirmResponse.status).toBe(200);
    expect(runInputs).toHaveLength(1);
  });

  it("keeps generic work-item approval-paused runs pending and creates an inbox item", async () => {
    const repoPath = await createRepo();
    await writeApprovalFlow(repoPath);
    await writeFile(join(repoPath, "intake.md"), "Issue intake", "utf8");
    const server = await startTestServer(repoPath, async (_input, dependencies) => {
      const runId = dependencies?.createRunId?.() ?? "run-work-item-approval";
      const store = new EventStore(join(repoPath, ".nitely", "events.db"));
      try {
        store.append({
          runId,
          stageId: "approve-spec",
          attempt: 1,
          type: "approval.requested",
          payload: {
            approvalId: "approve-spec-1",
            prompt: "Approve generated spec before design",
            reviewedArtifactIds: ["spec"],
          },
        });
      } finally {
        store.close();
      }
      return {
        runId,
        branchName: `nitely/${runId}`,
        worktreePath: join(repoPath, ".nitely", "worktrees", runId),
        status: "awaiting-approval",
        approvalId: "approve-spec-1",
      };
    });
    const created = (await json(await fetch(`${server.url}/api/work-items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Generic approval workflow",
        flowPath: "flows/approval-work-item.json",
        inputs: {
          intake: { connector: "local-file", uri: "intake.md" },
        },
      }),
    }))) as { workItem: { id: string } };

    const runResponse = await fetch(
      `${server.url}/api/work-items/${encodeURIComponent(created.workItem.id)}/runs`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );

    expect(runResponse.status).toBe(200);
    const runBody = (await json(runResponse)) as {
      run: { status: string; runId: string; approvalId?: string };
    };
    expect(runBody.run).toMatchObject({
      status: "awaiting-approval",
      approvalId: "approve-spec-1",
    });

    const detail = await waitFor(
      async () =>
        (await json(await fetch(
          `${server.url}/api/work-items/${encodeURIComponent(created.workItem.id)}`,
        ))) as { workItem: { status: string; latestRunStatus?: string } },
      (body) => body.workItem.latestRunStatus === "awaiting-approval",
    );
    expect(detail.workItem).toMatchObject({
      status: "running",
      latestRunStatus: "awaiting-approval",
    });

    const inbox = await waitFor(
      async () => await json(await fetch(`${server.url}/api/notifications`)),
      (body) => (body as { summary?: { pending?: number } }).summary?.pending === 1,
    );
    expect(inbox).toMatchObject({
      summary: { pending: 1 },
      notifications: [
        expect.objectContaining({
          taskId: created.workItem.id,
          runId: runBody.run.runId,
          type: "review-spec",
          severity: "warning",
          title: "Approval required",
          body: "Approve generated spec before design",
        }),
      ],
    });
  });

  it("marks approval-paused workflow runs failed when the inbox approval is rejected", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, async (_input, dependencies) => {
      const runId = dependencies?.createRunId?.() ?? "run-approval";
      const store = new EventStore(join(repoPath, ".nitely", "events.db"));
      try {
        store.append({
          runId,
          stageId: "approve-spec",
          attempt: 1,
          type: "approval.requested",
          payload: {
            approvalId: "approve-spec-1",
            prompt: "Approve generated spec before design",
            reviewedArtifactIds: ["spec"],
          },
        });
      } finally {
        store.close();
      }
      return {
        runId,
        branchName: `nitely/${runId}`,
        worktreePath: join(repoPath, ".nitely", "worktrees", runId),
        status: "awaiting-approval",
        approvalId: "approve-spec-1",
      };
    });
    const created = (await json(await fetch(`${server.url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Reject approval workflow",
        spec: "Spec body",
        techDesign: "Design body",
      }),
    }))) as { task: { id: string } };

    const runResponse = await fetch(
      `${server.url}/api/tasks/${encodeURIComponent(created.task.id)}/runs`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(runResponse.status).toBe(200);
    const runBody = (await json(runResponse)) as { run: { runId: string } };

    const inbox = await waitFor(
      async () => await json(await fetch(`${server.url}/api/notifications`)),
      (body) => (body as { summary?: { pending?: number } }).summary?.pending === 1,
    ) as { notifications: Array<{ id: string; type: string }> };
    expect(inbox.notifications[0]).toMatchObject({ type: "review-spec" });

    const rejectResponse = await fetch(
      `${server.url}/api/notifications/${encodeURIComponent(inbox.notifications[0].id)}/actions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "deny" }),
      },
    );
    expect(rejectResponse.status).toBe(200);
    await expect(json(rejectResponse)).resolves.toMatchObject({
      notification: { status: "resolved", resolution: "deny" },
      decision: {
        action: "deny",
        taskId: created.task.id,
        runId: runBody.run.runId,
      },
    });

    const detail = (await json(await fetch(
      `${server.url}/api/tasks/${encodeURIComponent(created.task.id)}`,
    ))) as { task: { status: string; latestRunStatus?: string } };
    expect(detail.task).toMatchObject({
      status: "failed",
      latestRunStatus: "failed",
    });

    const store = new EventStore(join(repoPath, ".nitely", "events.db"));
    try {
      expect(projectRun(store.list(runBody.run.runId)).status).toBe("failed");
      expect(store.list(runBody.run.runId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "notification.decision",
            payload: expect.objectContaining({ action: "deny" }),
          }),
        ]),
      );
    } finally {
      store.close();
    }
    const admissions = new RunAdmissionStore(
      join(repoPath, ".nitely", "run-admissions.db"),
    );
    try {
      expect(admissions.get(runBody.run.runId)).toMatchObject({
        state: "settled",
      });
    } finally {
      admissions.close();
    }

    const retry = await fetch(
      `${server.url}/api/tasks/${encodeURIComponent(created.task.id)}/runs`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(retry.status).toBe(200);
  });

  it("requires authentication for protected APIs in required auth mode", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      authEnv: {
        NITELY_ADMIN_EMAIL: "admin@example.test",
        NITELY_ADMIN_PASSWORD: "admin password passphrase",
      },
    });

    const session = await json(await fetch(`${server.url}/api/session`));
    expect(session).toEqual({ authRequired: true, user: null });

    for (const request of [
      fetch(`${server.url}/api/tasks`),
      fetch(`${server.url}/api/tasks`, { method: "POST" }),
      fetch(`${server.url}/api/runs`),
      fetch(`${server.url}/api/providers`),
      fetch(`${server.url}/api/demo/golden-path`, { method: "POST" }),
    ]) {
      const response = await request;
      expect(response.status).toBe(401);
      expect(await json(response)).toEqual({
        error: {
          code: "unauthorized",
          message: "authentication required",
        },
      });
    }
  });

  it("returns a setup-specific login error when required auth has no initial admin", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      authEnv: {},
    });

    await expect(json(await fetch(`${server.url}/api/session`))).resolves.toEqual({
      authRequired: true,
      user: null,
    });

    const response = await fetch(`${server.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "admin@example.test",
        password: "admin password passphrase",
      }),
    });

    expect(response.status).toBe(503);
    const body = await json(response);
    expect(body).toEqual({
      error: {
        code: "setup_required",
        message: expect.stringContaining("NITELY_ADMIN_EMAIL"),
      },
    });
    expect(JSON.stringify(body)).toContain("NITELY_ADMIN_PASSWORD");
  });

  it("keeps invalid login generic once required auth has users", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      authEnv: {
        NITELY_ADMIN_EMAIL: "admin@example.test",
        NITELY_ADMIN_PASSWORD: "admin password passphrase",
      },
    });

    const response = await fetch(`${server.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "admin@example.test",
        password: "wrong password",
      }),
    });

    expect(response.status).toBe(401);
    expect(await json(response)).toEqual({
      error: {
        code: "unauthorized",
        message: "invalid email or password",
      },
    });
  });

  it("throttles repeated failed logins and audits only a subject fingerprint", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      authEnv: {
        NITELY_ADMIN_EMAIL: "admin@example.test",
        NITELY_ADMIN_PASSWORD: "admin password passphrase",
      },
      loginRateLimit: { maxFailures: 2, windowMs: 60_000 },
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failed = await login(server, "admin@example.test", "wrong password");
      expect(failed.response.status).toBe(401);
      expect(failed.body).toEqual({
        error: { code: "unauthorized", message: "invalid email or password" },
      });
    }
    const throttled = await login(server, " ADMIN@example.test ", "wrong password");
    expect(throttled.response.status).toBe(429);
    expect(throttled.response.headers.get("retry-after")).toBe("60");
    expect(throttled.body).toEqual({
      error: {
        code: "too_many_attempts",
        message: "too many login attempts; try again later",
      },
    });

    const events = await listSecurityAuditEvents(repoPath, { action: "auth.login" });
    expect(events.map((event) => event.reasonCode).sort()).toEqual([
      "invalid_credentials",
      "invalid_credentials",
      "throttled",
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          decision: "deny",
          httpStatus: 429,
          actor: expect.objectContaining({
            type: "anonymous",
            subjectHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          }),
        }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain("admin@example.test");
    expect(JSON.stringify(events)).not.toContain("wrong password");
  });

  it("treats malformed session cookies as unauthenticated required auth requests", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      authEnv: {
        NITELY_ADMIN_EMAIL: "admin@example.test",
        NITELY_ADMIN_PASSWORD: "admin password passphrase",
      },
    });

    const tasks = await fetch(`${server.url}/api/tasks`, {
      headers: { cookie: "nitely_session=%" },
    });
    expect(tasks.status).toBe(401);
    expect(await json(tasks)).toEqual({
      error: {
        code: "unauthorized",
        message: "authentication required",
      },
    });

    await expect(
      json(
        await fetch(`${server.url}/api/session`, {
          headers: { cookie: "nitely_session=%" },
        }),
      ),
    ).resolves.toEqual({
      authRequired: true,
      user: null,
    });
  });

  it("signs in with an HTTP-only cookie and signs out by clearing the session", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      authEnv: {
        NITELY_ADMIN_EMAIL: "admin@example.test",
        NITELY_ADMIN_PASSWORD: "admin password passphrase",
      },
    });

    const signedIn = await login(server, "admin@example.test", "admin password passphrase");

    expect(signedIn.response.status).toBe(200);
    expect(signedIn.body).toMatchObject({
      authRequired: true,
      user: { email: "admin@example.test", role: "admin" },
    });
    expect(signedIn.cookie).toMatch(/^nitely_session=sess_/);
    expect(signedIn.response.headers.get("set-cookie")).toContain("HttpOnly");

    await expect(
      json(
        await fetch(`${server.url}/api/session`, {
          headers: { cookie: signedIn.cookie },
        }),
      ),
    ).resolves.toMatchObject({
      authRequired: true,
      user: { email: "admin@example.test", role: "admin" },
    });

    const logout = await fetch(`${server.url}/api/session`, {
      method: "DELETE",
      headers: { cookie: signedIn.cookie },
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("nitely_session=;");
    expect(await json(logout)).toEqual({ ok: true });
  });

  it("supports secure cookies and audits login and logout without session secrets", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      authEnv: {
        NITELY_ADMIN_EMAIL: "secure-admin@example.test",
        NITELY_ADMIN_PASSWORD: "secure admin password passphrase",
        NITELY_WEB_SECURE_COOKIE: "true",
      },
    });

    const signedIn = await login(
      server,
      "secure-admin@example.test",
      "secure admin password passphrase",
    );
    expect(signedIn.response.headers.get("set-cookie")).toContain("; Secure");
    const logout = await fetch(`${server.url}/api/session`, {
      method: "DELETE",
      headers: { cookie: signedIn.cookie },
    });
    expect(logout.headers.get("set-cookie")).toContain("; Secure");

    const events = await listSecurityAuditEvents(repoPath);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "auth.login",
          decision: "allow",
          actor: expect.objectContaining({ type: "user" }),
        }),
        expect.objectContaining({
          action: "auth.logout",
          decision: "allow",
          actor: expect.objectContaining({ type: "user" }),
        }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain("nitely_session");
    expect(JSON.stringify(events)).not.toContain("secure admin password passphrase");
  });

  it("lets global admins revoke user sessions and inspect metadata-only audit", async () => {
    const repoPath = await createRepo();
    const admin = await createUser(repoPath, {
      email: "admin@example.test",
      password: "admin password passphrase",
      role: "admin",
    });
    const user = await createUser(repoPath, {
      email: "user@example.test",
      password: "user password passphrase",
      role: "user",
    });
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      authEnv: {},
    });
    const adminLogin = await login(
      server,
      "admin@example.test",
      "admin password passphrase",
    );
    const userLogin = await login(
      server,
      "user@example.test",
      "user password passphrase",
    );

    const deniedAudit = await fetch(`${server.url}/api/security/audit`, {
      headers: { cookie: userLogin.cookie },
    });
    expect(deniedAudit.status).toBe(403);

    const revoke = await fetch(`${server.url}/api/users/${user.id}/sessions`, {
      method: "DELETE",
      headers: { cookie: adminLogin.cookie },
    });
    expect(revoke.status).toBe(200);
    await expect(json(revoke)).resolves.toEqual({
      ok: true,
      userId: user.id,
      invalidatedSessions: 1,
    });
    await expect(
      json(
        await fetch(`${server.url}/api/session`, {
          headers: { cookie: userLogin.cookie },
        }),
      ),
    ).resolves.toEqual({ authRequired: true, user: null });

    const auditResponse = await fetch(
      `${server.url}/api/security/audit?action=sessions.revoke&limit=10`,
      { headers: { cookie: adminLogin.cookie } },
    );
    expect(auditResponse.status).toBe(200);
    const auditBody = (await json(auditResponse)) as {
      events: Array<{ action: string; actor: { id?: string }; target?: { id?: string } }>;
    };
    expect(auditBody.events).toEqual([
      expect.objectContaining({
        action: "sessions.revoke",
        actor: expect.objectContaining({ id: admin.id }),
        target: { type: "user", id: user.id },
      }),
    ]);
    expect(JSON.stringify(auditBody)).not.toContain(adminLogin.cookie);
    expect(JSON.stringify(auditBody)).not.toContain(userLogin.cookie);
  });

  it("isolates tasks and task-started runs between signed-in users", async () => {
    const repoPath = await createRepo();
    const userA = await createUser(repoPath, {
      email: "a@example.test",
      password: "password a long passphrase",
      role: "user",
    });
    await createUser(repoPath, {
      email: "b@example.test",
      password: "password b long passphrase",
      role: "user",
    });
    let runInput: RunFlowInput | undefined;
    const server = await startTestServer(
      repoPath,
      async (input, dependencies) => {
        runInput = input;
        const runId = admittedRunId(dependencies, "run-user-a");
        const runDirectory = join(repoPath, ".nitely/runs", runId);
        await mkdir(runDirectory, { recursive: true });
        await writeFile(
          join(runDirectory, "run.json"),
          JSON.stringify(
            {
              runId,
              status: "completed",
              ownerId: input.ownerId,
              completedStages: [],
              inputs: input.inputs,
            },
            null,
            2,
          ),
          "utf8",
        );
        return {
          runId,
          branchName: `nitely/${runId}`,
          worktreePath: join(runDirectory, "worktree"),
        };
      },
      undefined,
      { authMode: "required", providerEnv: {} },
    );
    const a = await login(server, "a@example.test", "password a long passphrase");
    const b = await login(server, "b@example.test", "password b long passphrase");

    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: a.cookie,
        },
        body: JSON.stringify({
          title: "A task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string; ownerId: string } };

    expect(created.task.ownerId).toBe(userA.id);
    await expect(
      json(await fetch(`${server.url}/api/tasks`, { headers: { cookie: a.cookie } })),
    ).resolves.toMatchObject({ tasks: [{ id: created.task.id }] });
    await expect(
      json(await fetch(`${server.url}/api/tasks`, { headers: { cookie: b.cookie } })),
    ).resolves.toEqual({ tasks: [] });

    const bDetail = await fetch(`${server.url}/api/tasks/${created.task.id}`, {
      headers: { cookie: b.cookie },
    });
    expect(bDetail.status).toBe(404);
    const bStart = await fetch(`${server.url}/api/tasks/${created.task.id}/runs`, {
      method: "POST",
      headers: { cookie: b.cookie },
    });
    expect(bStart.status).toBe(404);

    const aStart = await fetch(`${server.url}/api/tasks/${created.task.id}/runs`, {
      method: "POST",
      headers: { cookie: a.cookie },
    });
    expect(aStart.status).toBe(200);
    expect(runInput?.ownerId).toBe(userA.id);

    const startedRunId = ((await json(aStart)) as { run: { runId: string } }).run.runId;
    await expect(
      json(await fetch(`${server.url}/api/runs`, { headers: { cookie: a.cookie } })),
    ).resolves.toMatchObject({ runs: [{ runId: startedRunId, ownerId: userA.id }] });
    await expect(
      json(await fetch(`${server.url}/api/runs`, { headers: { cookie: b.cookie } })),
    ).resolves.toEqual({ runs: [] });
    const bRun = await fetch(`${server.url}/api/runs/${startedRunId}`, {
      headers: { cookie: b.cookie },
    });
    expect(bRun.status).toBe(404);
  });

  it("shares team-scoped tasks with organization members and hides them from other teams", async () => {
    const repoPath = await createRepo();
    const owner = await createUser(repoPath, {
      email: "owner@example.test",
      password: "owner password passphrase",
      role: "user",
    });
    const teammate = await createUser(repoPath, {
      email: "teammate@example.test",
      password: "teammate password passphrase",
      role: "user",
    });
    await createUser(repoPath, {
      email: "outsider@example.test",
      password: "outsider password passphrase",
      role: "user",
    });
    const [team] = await listPublicMemberships(repoPath, owner.id);
    await addOrganizationMember(repoPath, team.organizationId, {
      userId: teammate.id,
      role: "member",
    });
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      providerEnv: {},
    });
    const ownerLogin = await login(server, "owner@example.test", "owner password passphrase");
    const teammateLogin = await login(
      server,
      "teammate@example.test",
      "teammate password passphrase",
    );
    const outsiderLogin = await login(
      server,
      "outsider@example.test",
      "outsider password passphrase",
    );

    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: ownerLogin.cookie,
          "x-nitely-organization-id": team.organizationId,
        },
        body: JSON.stringify({
          title: "Team task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string; organizationId: string; ownerId: string } };

    expect(created.task.organizationId).toBe(team.organizationId);
    await expect(
      json(
        await fetch(`${server.url}/api/tasks`, {
          headers: { cookie: teammateLogin.cookie },
        }),
      ),
    ).resolves.toMatchObject({ tasks: [{ id: created.task.id }] });
    await expect(
      json(
        await fetch(`${server.url}/api/tasks`, {
          headers: { cookie: outsiderLogin.cookie },
        }),
      ),
    ).resolves.toEqual({ tasks: [] });
  });

  it("personalizes approval work while allowing maintainers to reassign team notifications", async () => {
    const repoPath = await createRepo();
    const assignee = await createUser(repoPath, {
      email: "assignee@example.test",
      password: "assignee password passphrase",
      role: "user",
    });
    const teammate = await createUser(repoPath, {
      email: "teammate@example.test",
      password: "teammate password passphrase",
      role: "user",
    });
    const maintainer = await createUser(repoPath, {
      email: "maintainer@example.test",
      password: "maintainer password passphrase",
      role: "user",
    });
    const stranger = await createUser(repoPath, {
      email: "stranger@example.test",
      password: "stranger password passphrase",
      role: "user",
    });
    const [team] = await listPublicMemberships(repoPath, assignee.id);
    await addOrganizationMember(repoPath, team.organizationId, {
      userId: teammate.id,
      role: "member",
    });
    await addOrganizationMember(repoPath, team.organizationId, {
      userId: maintainer.id,
      role: "maintainer",
    });
    const specNotification = await upsertNotification(repoPath, {
      sourceKey: "task:personal:draft-spec",
      type: "review-spec",
      severity: "info",
      title: "Review draft spec",
      link: "/tasks/task-personal",
      taskId: "task-personal",
      targetUserId: assignee.id,
      organizationId: team.organizationId,
    });
    await upsertNotification(repoPath, {
      sourceKey: "task:team:blocker",
      type: "resolve-blocker",
      severity: "blocker",
      title: "Run needs human input",
      link: "/tasks/task-blocked",
      taskId: "task-blocked",
      organizationId: team.organizationId,
    });
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      providerEnv: {},
    });
    const assigneeLogin = await login(server, "assignee@example.test", "assignee password passphrase");
    const teammateLogin = await login(server, "teammate@example.test", "teammate password passphrase");
    const maintainerLogin = await login(
      server,
      "maintainer@example.test",
      "maintainer password passphrase",
    );

    const maintainerDirectory = (await json(
      await fetch(`${server.url}/api/users`, {
        headers: { cookie: maintainerLogin.cookie },
      }),
    )) as { users: Array<{ id: string; email: string }>; canManageAssignments: boolean };
    expect(maintainerDirectory.canManageAssignments).toBe(true);
    expect(maintainerDirectory.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: assignee.id, email: "assignee@example.test" }),
        expect.objectContaining({ id: teammate.id, email: "teammate@example.test" }),
        expect.objectContaining({ id: maintainer.id, email: "maintainer@example.test" }),
      ]),
    );
    expect(maintainerDirectory.users).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: stranger.id }),
      ]),
    );

    const teammateDirectory = (await json(
      await fetch(`${server.url}/api/users`, {
        headers: { cookie: teammateLogin.cookie },
      }),
    )) as { users: Array<{ id: string; email: string }>; canManageAssignments: boolean };
    expect(teammateDirectory.canManageAssignments).toBe(false);
    expect(teammateDirectory.users).toEqual([
      expect.objectContaining({ id: teammate.id, email: "teammate@example.test" }),
    ]);

    const assigneeInbox = (await json(
      await fetch(`${server.url}/api/notifications?status=pending`, {
        headers: { cookie: assigneeLogin.cookie },
      }),
    )) as { notifications: Array<{ type: string; targetUserId?: string }> };
    expect(
      assigneeInbox.notifications
        .map((notification) => notification.type)
        .sort(),
    ).toEqual(["resolve-blocker", "review-spec"]);

    const teammateInbox = (await json(
      await fetch(`${server.url}/api/notifications?status=pending`, {
        headers: { cookie: teammateLogin.cookie },
      }),
    )) as { notifications: Array<{ type: string; targetUserId?: string; canManage?: boolean }> };
    expect(teammateInbox.notifications).toEqual([
      expect.objectContaining({ type: "resolve-blocker", canManage: false }),
    ]);

    const teammateReassign = await fetch(
      `${server.url}/api/notifications/${encodeURIComponent(specNotification.id)}/assign`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: teammateLogin.cookie,
        },
        body: JSON.stringify({ targetUserId: teammate.id }),
      },
    );
    expect(teammateReassign.status).toBe(404);

    const assigneeDashboard = (await json(
      await fetch(`${server.url}/api/dashboard`, {
        headers: { cookie: assigneeLogin.cookie },
      }),
    )) as { myWork: { pendingCount: number; reviewCount: number; blockerCount: number } };
    expect(assigneeDashboard.myWork).toMatchObject({
      pendingCount: 2,
      reviewCount: 1,
      blockerCount: 1,
    });

    const invalidReassign = await fetch(
      `${server.url}/api/notifications/${encodeURIComponent(specNotification.id)}/assign`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: maintainerLogin.cookie,
        },
        body: JSON.stringify({ targetUserId: stranger.id }),
      },
    );
    await expectWebInputError(invalidReassign, "targetUserId is not assignable to this organization");

    const reassign = await fetch(
      `${server.url}/api/notifications/${encodeURIComponent(specNotification.id)}/actions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: maintainerLogin.cookie,
        },
        body: JSON.stringify({ action: "assign", targetUserId: teammate.id }),
      },
    );
    expect(reassign.status).toBe(200);
    await expect(json(reassign)).resolves.toMatchObject({
      notification: {
        id: specNotification.id,
        status: "pending",
        targetUserId: teammate.id,
        assigneeUserId: teammate.id,
        organizationId: team.organizationId,
      },
      decision: {
        action: "assign",
        targetUserId: teammate.id,
      },
    });
    await expect(
      listTaskNotificationDecisions(repoPath, "task-personal"),
    ).resolves.toEqual([
      expect.objectContaining({
        notificationId: specNotification.id,
        actorId: maintainer.id,
        action: "assign",
        targetUserId: teammate.id,
      }),
    ]);

    const assigneeAfterReassign = (await json(
      await fetch(`${server.url}/api/notifications?status=pending`, {
        headers: { cookie: assigneeLogin.cookie },
      }),
    )) as { notifications: Array<{ type: string; targetUserId?: string }> };
    expect(assigneeAfterReassign.notifications).toEqual([
      expect.objectContaining({ type: "resolve-blocker" }),
    ]);

    const teammateAfterReassign = (await json(
      await fetch(`${server.url}/api/dashboard`, {
        headers: { cookie: teammateLogin.cookie },
      }),
    )) as { myWork: { pendingCount: number; reviewCount: number; items: Array<{ type: string }> } };
    expect(teammateAfterReassign.myWork.pendingCount).toBe(2);
    expect(teammateAfterReassign.myWork.reviewCount).toBe(1);
    expect(teammateAfterReassign.myWork.items.map((item) => item.type)).toEqual([
      "resolve-blocker",
      "review-spec",
    ]);

    const restrictedNotification = await upsertNotification(repoPath, {
      sourceKey: "task:restricted-assignment:review",
      type: "review-spec",
      severity: "info",
      title: "Restricted assignment",
      link: "/tasks/restricted-assignment",
      taskId: "restricted-assignment",
      targetUserId: assignee.id,
      organizationId: team.organizationId,
      supportedActions: ["approve"],
      requiredReasonActions: [],
    });
    const restrictedAssign = await fetch(
      `${server.url}/api/notifications/${encodeURIComponent(restrictedNotification.id)}/assign`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: maintainerLogin.cookie,
        },
        body: JSON.stringify({ targetUserId: teammate.id }),
      },
    );
    await expectWebInputError(
      restrictedAssign,
      "notification action assign is not supported",
    );
    await expect(
      getNotification(repoPath, restrictedNotification.id),
    ).resolves.toMatchObject({
      status: "pending",
      targetUserId: assignee.id,
    });
    await expect(
      listTaskNotificationDecisions(repoPath, "restricted-assignment"),
    ).resolves.toEqual([]);
  });

  it("allows team members to run work and denies viewer mutations", async () => {
    const repoPath = await createRepo();
    const owner = await createUser(repoPath, {
      email: "owner@example.test",
      password: "owner password passphrase",
      role: "user",
    });
    const member = await createUser(repoPath, {
      email: "member@example.test",
      password: "member password passphrase",
      role: "user",
    });
    const viewer = await createUser(repoPath, {
      email: "viewer@example.test",
      password: "viewer password passphrase",
      role: "user",
    });
    const [team] = await listPublicMemberships(repoPath, owner.id);
    await addOrganizationMember(repoPath, team.organizationId, {
      userId: member.id,
      role: "member",
    });
    await addOrganizationMember(repoPath, team.organizationId, {
      userId: viewer.id,
      role: "viewer",
    });
    const teamNotification = await upsertNotification(repoPath, {
      sourceKey: "task:team-rbac:blocker",
      type: "resolve-blocker",
      severity: "blocker",
      title: "Team blocker",
      link: "/tasks/team-rbac",
      taskId: "team-rbac",
      organizationId: team.organizationId,
    });
    let runInput: RunFlowInput | undefined;
    const server = await startTestServer(
      repoPath,
      async (input) => {
        runInput = input;
        return {
          runId: "run-team",
          branchName: "nitely/run-team",
          worktreePath: join(repoPath, ".nitely/runs/run-team/worktree"),
        };
      },
      undefined,
      { authMode: "required", providerEnv: {} },
    );
    const ownerLogin = await login(server, "owner@example.test", "owner password passphrase");
    const memberLogin = await login(server, "member@example.test", "member password passphrase");
    const viewerLogin = await login(server, "viewer@example.test", "viewer password passphrase");

    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: ownerLogin.cookie,
          "x-nitely-organization-id": team.organizationId,
        },
        body: JSON.stringify({
          title: "Runnable team task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string; organizationId: string } };

    const viewerCreate = await fetch(`${server.url}/api/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: viewerLogin.cookie,
        "x-nitely-organization-id": team.organizationId,
      },
      body: JSON.stringify({
        title: "Viewer task",
        spec: "Spec body",
        techDesign: "Design body",
      }),
    });
    expect(viewerCreate.status).toBe(403);

    const viewerDraft = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: viewerLogin.cookie,
        "x-nitely-organization-id": team.organizationId,
      },
      body: JSON.stringify({
        sourceType: "prompt",
        title: "Viewer draft",
        prompt: "A viewer must not create a planning task.",
      }),
    });
    expect(viewerDraft.status).toBe(403);

    const viewerResolve = await fetch(
      `${server.url}/api/notifications/${teamNotification.id}/resolve`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: viewerLogin.cookie,
        },
        body: JSON.stringify({ resolution: "resolved" }),
      },
    );
    expect(viewerResolve.status).toBe(403);

    const memberResolve = await fetch(
      `${server.url}/api/notifications/${teamNotification.id}/resolve`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: memberLogin.cookie,
        },
        body: JSON.stringify({ resolution: "resolved" }),
      },
    );
    expect(memberResolve.status).toBe(200);

    const viewerRun = await fetch(`${server.url}/api/tasks/${created.task.id}/runs`, {
      method: "POST",
      headers: { cookie: viewerLogin.cookie },
    });
    expect(viewerRun.status).toBe(403);
    expect(runInput).toBeUndefined();

    const memberRun = await fetch(`${server.url}/api/tasks/${created.task.id}/runs`, {
      method: "POST",
      headers: { cookie: memberLogin.cookie },
    });
    expect(memberRun.status).toBe(200);
    expect(runInput).toMatchObject({
      ownerId: owner.id,
      organizationId: team.organizationId,
    });

    const audit = await waitFor(
      () => listSecurityAuditEvents(repoPath),
      (events) => events.some(
        (event) =>
          event.action === "runs.start" &&
          event.decision === "allow" &&
          event.actor.id === member.id,
      ),
    );
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "tasks.create",
          permission: "tasks:write",
          decision: "deny",
          actor: expect.objectContaining({
            id: viewer.id,
            organizationRole: "viewer",
          }),
        }),
        expect.objectContaining({
          action: "tasks.draft",
          permission: "tasks:write",
          decision: "deny",
          actor: expect.objectContaining({ id: viewer.id }),
        }),
        expect.objectContaining({
          action: "runs.start",
          permission: "runs:start",
          decision: "deny",
          actor: expect.objectContaining({ id: viewer.id }),
        }),
        expect.objectContaining({
          action: "runs.start",
          permission: "runs:start",
          decision: "allow",
          actor: expect.objectContaining({ id: member.id }),
        }),
        expect.objectContaining({
          action: "notifications.resolve",
          permission: "notifications:resolve",
          decision: "deny",
          actor: expect.objectContaining({ id: viewer.id }),
        }),
        expect.objectContaining({
          action: "notifications.resolve",
          permission: "notifications:resolve",
          decision: "allow",
          actor: expect.objectContaining({ id: member.id }),
        }),
      ]),
    );
  });

  it("keeps legacy owner-scoped records writable by their owner", async () => {
    const repoPath = await createRepo();
    const owner = await createUser(repoPath, {
      email: "owner@example.test",
      password: "owner password passphrase",
      role: "user",
    });
    const task = await createTask(
      repoPath,
      {
        title: "Legacy owner task",
        spec: "Spec body",
        techDesign: "Design body",
      },
      { ownerId: owner.id, createId: () => "legacy-owner-task" },
    );
    let runInput: RunFlowInput | undefined;
    const server = await startTestServer(
      repoPath,
      async (input) => {
        runInput = input;
        return {
          runId: "run-legacy-owner",
          branchName: "nitely/run-legacy-owner",
          worktreePath: join(repoPath, ".nitely/runs/run-legacy-owner/worktree"),
        };
      },
      undefined,
      { authMode: "required", providerEnv: {} },
    );
    const signedIn = await login(server, "owner@example.test", "owner password passphrase");

    const response = await fetch(`${server.url}/api/tasks/${task.id}/runs`, {
      method: "POST",
      headers: { cookie: signedIn.cookie },
    });

    expect(response.status).toBe(200);
    expect(runInput).toMatchObject({ ownerId: owner.id });
    expect(runInput?.organizationId).toBeUndefined();
  });

  it("injects the authenticated owner into evaluated snapshots for unowned legacy and generic starts", async () => {
    const repoPath = await createRepo();
    await writeNonDevFlow(join(repoPath, "flows/autofarm-site.json"));
    await allowAutofarmWorkItems(repoPath);
    await mkdir(join(repoPath, "seeds"), { recursive: true });
    await writeFile(join(repoPath, "seeds/owner.json"), "{}", "utf8");
    const admin = await createUser(repoPath, {
      email: "snapshot-admin@example.test",
      password: "snapshot admin password passphrase",
      role: "admin",
    });
    const task = await createTask(repoPath, {
      title: "Unowned legacy snapshot",
      spec: "Spec body",
      techDesign: "Design body",
    });
    const workItem = await createWorkItem(repoPath, {
      title: "Unowned generic snapshot",
      workItemType: "autofarm.site",
      flowPath: "flows/autofarm-site.json",
      inputs: {
        seed: { connector: "local-file", uri: "seeds/owner.json" },
      },
    });
    const runInputs: RunFlowInput[] = [];
    const server = await startTestServer(
      repoPath,
      async (input, dependencies) => {
        runInputs.push(input);
        const runId = admittedRunId(
          dependencies,
          `run-${input.workItemId}`,
        );
        return {
          runId,
          branchName: `nitely/${runId}`,
          worktreePath: join(repoPath, ".nitely/runs", runId, "worktree"),
        };
      },
      undefined,
      { authMode: "required", providerEnv: {} },
    );
    const signedIn = await login(
      server,
      "snapshot-admin@example.test",
      "snapshot admin password passphrase",
    );

    const legacyResponse = await fetch(`${server.url}/api/tasks/${task.id}/runs`, {
      method: "POST",
      headers: { cookie: signedIn.cookie },
    });
    const genericResponse = await fetch(
      `${server.url}/api/work-items/${workItem.id}/runs`,
      { method: "POST", headers: { cookie: signedIn.cookie } },
    );

    expect(legacyResponse.status).toBe(200);
    expect(genericResponse.status).toBe(200);
    expect(runInputs).toHaveLength(2);
    expect(runInputs.map((input) => input.ownerId)).toEqual([
      admin.id,
      admin.id,
    ]);
  });

  it("rejects blocked task runs unless override is requested", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "Upstream", spec: "Spec body", techDesign: "Design body" },
      { createId: () => "upstream" },
    );
    await createTask(
      repoPath,
      { title: "Downstream", spec: "Spec body", techDesign: "Design body" },
      { createId: () => "downstream" },
    );
    await updateTaskRunState(repoPath, "upstream", {
      status: "completed",
      changeRequestUrl: "https://github.com/Instask/nitely/pull/1",
    });
    await updateTaskDependencies(repoPath, "downstream", ["upstream"]);
    let runCount = 0;
    const server = await startTestServer(
      repoPath,
      async () => {
        runCount += 1;
        return {
          runId: "run-override",
          branchName: "nitely/run-override",
          worktreePath: join(repoPath, ".nitely/runs/run-override/worktree"),
        };
      },
      undefined,
      {
        getChangeRequestStatus: async () => ({
          provider: "github",
          state: "closed",
          merged: false,
        }),
      },
    );

    const blocked = await fetch(`${server.url}/api/tasks/downstream/runs`, {
      method: "POST",
    });
    expect(blocked.status).toBe(400);
    await expect(json(blocked)).resolves.toMatchObject({
      error: {
        message: "task is blocked by dependencies: upstream is incomplete",
      },
    });
    expect(runCount).toBe(0);

    const override = await fetch(
      `${server.url}/api/tasks/downstream/runs?override=true`,
      { method: "POST" },
    );
    expect(override.status).toBe(200);
    expect(runCount).toBe(1);
  });

  it("manages task dependencies through the API and rejects cycles", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "A", spec: "Spec body", techDesign: "Design body" },
      { createId: () => "a" },
    );
    await createTask(
      repoPath,
      { title: "B", spec: "Spec body", techDesign: "Design body" },
      { createId: () => "b" },
    );
    const server = await startTestServer(repoPath);

    const add = await fetch(`${server.url}/api/tasks/b/dependencies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dependsOn: "a" }),
    });
    expect(add.status).toBe(200);
    await expect(json(add)).resolves.toMatchObject({
      task: { id: "b", dependsOn: ["a"] },
    });

    const cycle = await fetch(`${server.url}/api/tasks/a/dependencies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dependsOn: "b" }),
    });
    await expectWebInputError(cycle, "dependency would create a cycle");

    const remove = await fetch(`${server.url}/api/tasks/b/dependencies/a`, {
      method: "DELETE",
    });
    expect(remove.status).toBe(200);
    await expect(json(remove)).resolves.toMatchObject({
      task: { id: "b", dependsOn: [] },
    });
  });

  it("persists generic work-item priority and dependency metadata at creation", async () => {
    const repoPath = await createRepo();
    await writeApprovalFlow(repoPath);
    await writeFile(join(repoPath, "intake.md"), "Issue intake", "utf8");
    await createTask(
      repoPath,
      { title: "Legacy upstream", spec: "Spec body", techDesign: "Design body" },
      { createId: () => "legacy-upstream" },
    );
    const server = await startTestServer(repoPath);

    const create = await fetch(`${server.url}/api/work-items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Generic downstream",
        flowPath: "flows/approval-work-item.json",
        priority: "P1",
        dependsOn: ["legacy-upstream"],
        suggestedDependencies: [
          {
            dependsOn: "legacy-upstream",
            reason: "same issue plan",
            confidence: 0.92,
            source: "planner",
            suggestedAt: "2026-06-26T00:00:00.000Z",
          },
        ],
        inputs: {
          intake: { connector: "local-file", uri: "intake.md" },
        },
      }),
    });

    expect(create.status).toBe(201);
    const created = (await json(create)) as {
      workItem: { id: string; priority?: string; dependsOn?: string[] };
    };
    expect(created.workItem).toMatchObject({
      priority: "P1",
      dependsOn: ["legacy-upstream"],
    });
    await expect(getWorkItem(repoPath, created.workItem.id)).resolves.toMatchObject({
      priority: "P1",
      dependsOn: ["legacy-upstream"],
      suggestedDependencies: [
        expect.objectContaining({
          dependsOn: "legacy-upstream",
          reason: "same issue plan",
        }),
      ],
    });

    const scheduler = (await json(await fetch(`${server.url}/api/scheduler`))) as {
      scheduler: { edges: Array<{ from: string; to: string; kind: string }> };
    };
    expect(scheduler.scheduler.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "legacy-upstream",
          to: created.workItem.id,
          kind: "confirmed",
        }),
      ]),
    );
  });

  it("manages mixed legacy and generic work-item dependencies through the API", async () => {
    const repoPath = await createRepo();
    await writeApprovalFlow(repoPath);
    await writeFile(join(repoPath, "intake.md"), "Issue intake", "utf8");
    await createTask(
      repoPath,
      { title: "Legacy A", spec: "Spec body", techDesign: "Design body" },
      { createId: () => "legacy-a" },
    );
    const generic = await createWorkItem(
      repoPath,
      {
        title: "Generic B",
        workItemType: "dev.pr",
        flowPath: "flows/approval-work-item.json",
        inputs: {
          intake: { connector: "local-file", uri: "intake.md" },
        },
      },
      { createId: () => "generic-b" },
    );
    const server = await startTestServer(repoPath);

    const add = await fetch(`${server.url}/api/tasks/${generic.id}/dependencies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dependsOn: "legacy-a" }),
    });
    expect(add.status).toBe(200);
    await expect(json(add)).resolves.toMatchObject({
      task: { id: "generic-b", dependsOn: ["legacy-a"] },
    });

    const cycle = await fetch(`${server.url}/api/tasks/legacy-a/dependencies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dependsOn: "generic-b" }),
    });
    await expectWebInputError(cycle, "dependency would create a cycle");

    const remove = await fetch(`${server.url}/api/tasks/generic-b/dependencies/legacy-a`, {
      method: "DELETE",
    });
    expect(remove.status).toBe(200);
    await expect(json(remove)).resolves.toMatchObject({
      task: { id: "generic-b", dependsOn: [] },
    });
  });

  it("accepts and dismisses dependency suggestions through the task API", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "Legacy A", spec: "Spec body", techDesign: "Design body" },
      { createId: () => "legacy-a" },
    );
    const legacyB = await createTask(
      repoPath,
      {
        title: "Legacy B",
        spec: "Spec body",
        techDesign: "Design body",
      },
      { createId: () => "legacy-b" },
    );
    await writeFile(
      join(repoPath, ".nitely/tasks/legacy-b/task.json"),
      JSON.stringify(
        {
          ...legacyB,
          suggestedDependencies: [
            {
              dependsOn: "legacy-a",
              reason: "same milestone",
              confidence: 0.88,
              source: "planner",
              suggestedAt: "2026-07-08T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeApprovalFlow(repoPath);
    await writeFile(join(repoPath, "intake.md"), "Issue intake", "utf8");
    await createWorkItem(
      repoPath,
      {
        title: "Generic C",
        workItemType: "dev.pr",
        flowPath: "flows/approval-work-item.json",
        inputs: {
          intake: { connector: "local-file", uri: "intake.md" },
        },
        suggestedDependencies: [
          {
            dependsOn: "legacy-a",
            reason: "shared implementation path",
            confidence: 0.73,
            source: "planner",
            suggestedAt: "2026-07-08T00:00:00.000Z",
          },
        ],
      },
      { createId: () => "generic-c" },
    );
    const server = await startTestServer(repoPath);

    const accept = await fetch(`${server.url}/api/tasks/legacy-b/dependencies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dependsOn: "legacy-a" }),
    });
    expect(accept.status).toBe(200);
    await expect(json(accept)).resolves.toMatchObject({
      task: {
        id: "legacy-b",
        dependsOn: ["legacy-a"],
        suggestedDependencies: [],
      },
    });

    const dismiss = await fetch(
      `${server.url}/api/tasks/generic-c/dependency-suggestions/legacy-a/dismiss`,
      { method: "POST" },
    );
    expect(dismiss.status).toBe(200);
    await expect(json(dismiss)).resolves.toMatchObject({
      task: {
        id: "generic-c",
        suggestedDependencies: [],
      },
    });
  });

  it("refreshes dependency suggestions through the task API", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      {
        title: "Scheduler dependency foundation",
        spec: "Spec body",
        techDesign: "Design body",
        issueUrl: "https://github.com/Instask/nitely/issues/199",
      },
      {
        createId: () => "foundation",
        now: () => new Date("2026-07-08T00:00:00.000Z"),
        source: {
          type: "github-issue",
          uri: "https://github.com/Instask/nitely/issues/199",
          title: "Scheduler dependency foundation",
          snapshot: {
            uri: "https://github.com/Instask/nitely/issues/199",
            title: "Scheduler dependency foundation",
            body: "Foundation work",
            fetchedAt: "2026-07-08T00:00:00.000Z",
            labels: ["scheduler", "dependencies"],
            milestone: "M1",
          },
        },
      },
    );
    await createTask(
      repoPath,
      {
        title: "Scheduler dependency rollout",
        spec: "Spec body",
        techDesign: "Design body",
        issueUrl: "https://github.com/Instask/nitely/issues/200",
      },
      {
        createId: () => "rollout",
        now: () => new Date("2026-07-08T00:01:00.000Z"),
        source: {
          type: "github-issue",
          uri: "https://github.com/Instask/nitely/issues/200",
          title: "Scheduler dependency rollout",
          snapshot: {
            uri: "https://github.com/Instask/nitely/issues/200",
            title: "Scheduler dependency rollout",
            body: "Rollout work",
            fetchedAt: "2026-07-08T00:01:00.000Z",
            labels: ["scheduler", "dependencies"],
            milestone: "M1",
          },
        },
      },
    );
    await createTask(
      repoPath,
      {
        title: "Unrelated notification channel",
        spec: "Spec body",
        techDesign: "Design body",
      },
      {
        createId: () => "unrelated",
        now: () => new Date("2026-07-08T00:00:30.000Z"),
      },
    );
    const server = await startTestServer(repoPath);

    const refresh = await fetch(
      `${server.url}/api/tasks/rollout/suggestions:refresh`,
      { method: "POST" },
    );

    expect(refresh.status).toBe(200);
    await expect(json(refresh)).resolves.toMatchObject({
      task: {
        id: "rollout",
        suggestedDependencies: [
          expect.objectContaining({
            dependsOn: "foundation",
            source: "scheduler-context",
          }),
        ],
      },
    });

    const scheduler = (await json(await fetch(`${server.url}/api/scheduler`))) as {
      scheduler: { edges: Array<{ from: string; to: string; kind: string }> };
    };
    expect(scheduler.scheduler.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "foundation",
          to: "rollout",
          kind: "suggested",
        }),
      ]),
    );
    expect(scheduler.scheduler.edges).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "unrelated",
          to: "rollout",
          kind: "suggested",
        }),
      ]),
    );
  });

  it("projects persisted runtime cooldowns without running a scheduler cycle", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "Wait for mock", spec: "Spec body", techDesign: "Design body" },
      { createId: () => "waiting-on-mock" },
    );
    const cooldowns = new SchedulerCooldownStore(schedulerCooldownStorePath(repoPath));
    cooldowns.set("mock", new Date("2099-01-01T00:00:00.000Z"));
    cooldowns.close();
    const server = await startTestServer(repoPath);

    const response = await fetch(`${server.url}/api/scheduler`);

    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toMatchObject({
      scheduler: {
        cooldowns: {
          runtimes: [
            {
              runtime: "mock",
              until: "2099-01-01T00:00:00.000Z",
              waitingRunCount: 1,
            },
          ],
          nextWakeUp: "2099-01-01T00:00:00.000Z",
        },
      },
    });
  });

  it("returns a scheduler DAG and execution queue projection", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "Merged foundation", spec: "Spec body", techDesign: "Design body" },
      { createId: () => "foundation" },
    );
    await createTask(
      repoPath,
      { title: "Runnable implementation", spec: "Spec body", techDesign: "Design body" },
      { createId: () => "implementation" },
    );
    await createTask(
      repoPath,
      { title: "Blocked rollout", spec: "Spec body", techDesign: "Design body" },
      { createId: () => "rollout" },
    );
    await createTask(
      repoPath,
      { title: "Unmerged review", spec: "Spec body", techDesign: "Design body" },
      { createId: () => "review" },
    );
    await createTask(
      repoPath,
      { title: "Running release", spec: "Spec body", techDesign: "Design body" },
      { createId: () => "release" },
    );
    await updateTaskRunState(repoPath, "foundation", {
      status: "completed",
      changeRequestUrl: "https://github.com/Instask/nitely/pull/1",
    });
    await updateTaskRunState(repoPath, "review", {
      status: "completed",
      changeRequestUrl: "https://github.com/Instask/nitely/pull/2",
    });
    await updateTaskRunState(repoPath, "release", { status: "running" });
    await updateTaskDependencies(repoPath, "implementation", ["foundation"]);
    await updateTaskDependencies(repoPath, "rollout", ["review"]);
    const rolloutRecord = JSON.parse(
      await readFile(join(repoPath, ".nitely/tasks/rollout/task.json"), "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      join(repoPath, ".nitely/tasks/rollout/task.json"),
      JSON.stringify(
        {
          ...rolloutRecord,
          suggestedDependencies: [
            {
              dependsOn: "implementation",
              reason: "rollout should follow implementation",
              confidence: 0.8,
              source: "analysis",
              suggestedAt: "2026-06-26T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    const server = await startTestServer(repoPath, undefined, undefined, {
      getChangeRequestStatus: async (url) => ({
        provider: "github",
        state: "closed",
        merged: url.endsWith("/1"),
      }),
    });

    const response = await fetch(`${server.url}/api/scheduler`);

    expect(response.status).toBe(200);
    const body = (await json(response)) as {
      scheduler: {
        summary: {
          total: number;
          running: number;
          runnable: number;
          blocked: number;
          completed: number;
          suggestedEdges: number;
        };
        queue: {
          running: Array<{ id: string }>;
          runnable: Array<{ id: string }>;
          blocked: Array<{
            id: string;
            blockedReasons: Array<{ kind: string; upstreamId: string }>;
          }>;
        };
        nodes: Array<{ id: string; displayStatus: string }>;
        edges: Array<{ from: string; to: string; kind: string; reason?: string }>;
      };
    };
    expect(body.scheduler.summary).toMatchObject({
      total: 5,
      running: 1,
      runnable: 1,
      blocked: 1,
      completed: 2,
      suggestedEdges: 1,
    });
    expect(body.scheduler.queue.running.map((task) => task.id)).toEqual(["release"]);
    expect(body.scheduler.queue.runnable.map((task) => task.id)).toEqual([
      "implementation",
    ]);
    expect(body.scheduler.queue.blocked).toEqual([
      expect.objectContaining({
        id: "rollout",
        blockedReasons: [{ kind: "incomplete", upstreamId: "review" }],
      }),
    ]);
    expect(body.scheduler.nodes.find((node) => node.id === "rollout")).toMatchObject({
      displayStatus: "blocked",
    });
    expect(body.scheduler.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "foundation",
          to: "implementation",
          kind: "confirmed",
        }),
        expect.objectContaining({
          from: "implementation",
          to: "rollout",
          kind: "suggested",
          reason: "rollout should follow implementation",
        }),
      ]),
    );
  });

  it("excludes synthetic repositories from scheduler lookups and execution", async () => {
    const homeRepo = await createRepo();
    const demoRepo = await createRepo();
    await mkdir(join(homeRepo, ".nitely"), { recursive: true });
    await createTask(
      demoRepo,
      { title: "Synthetic completed task", spec: "Spec", techDesign: "Design" },
      { createId: () => "synthetic-task", initialStatus: "completed" },
    );
    await updateTaskRunState(demoRepo, "synthetic-task", {
      status: "completed",
      changeRequestUrl: "https://github.com/Instask/nitely/pull/1",
    });
    const getChangeRequestStatus = vi.fn(async (target: string) => ({
      provider: "github" as const,
      url: target,
      state: "closed",
      merged: true,
    }));
    const runFlow = vi.fn(async () => ({
      runId: "unexpected-synthetic-run",
      branchName: "nitely/unexpected-synthetic-run",
      worktreePath: "/tmp/unexpected-synthetic-run",
    }));
    const server = await startTestServer(homeRepo, runFlow, undefined, {
      repositories: [
        {
          id: "demo-golden-path",
          name: "Mocked golden path demo",
          path: demoRepo,
          synthetic: true,
        },
      ],
      getChangeRequestStatus,
    });

    const scheduler = (await json(await fetch(`${server.url}/api/scheduler`))) as {
      scheduler: { summary: { total: number } };
    };
    expect(scheduler.scheduler.summary.total).toBe(0);
    expect(getChangeRequestStatus).not.toHaveBeenCalled();

    const runResponse = await fetch(`${server.url}/api/scheduler/run`, {
      method: "POST",
    });
    expect(runResponse.status).toBe(200);
    await expect(json(runResponse)).resolves.toMatchObject({
      summary: { startedTaskIds: [], completedTaskIds: [] },
    });
    expect(runFlow).not.toHaveBeenCalled();
    expect(getChangeRequestStatus).not.toHaveBeenCalled();
  });

  it("runs one scheduler cycle through the web API", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "Runnable implementation", spec: "Spec body", techDesign: "Design body" },
      { createId: () => "implementation" },
    );
    const server = await startTestServer(
      repoPath,
      async (_input, dependencies) => {
        const runId = admittedRunId(dependencies, "run-implementation");
        return {
          runId,
          branchName: `nitely/${runId}`,
          worktreePath: "/tmp/worktree",
          changeRequestUrl: "https://github.com/Instask/nitely/pull/999",
        } satisfies RunFlowResult;
      },
    );

    const response = await fetch(`${server.url}/api/scheduler/run`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toMatchObject({
      summary: {
        startedTaskIds: ["implementation"],
        completedTaskIds: ["implementation"],
        awaitingApprovalTaskIds: [],
        failedTaskIds: [],
        blockedTaskIds: [],
        eligibility: {
          implementation: { decision: "eligible" },
        },
      },
    });
  });

  it("runs web API scheduler tasks concurrently when requested", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "A", spec: "Spec body", techDesign: "Design body" },
      { createId: () => "a", now: () => new Date("2026-06-26T00:00:00.000Z") },
    );
    await createTask(
      repoPath,
      { title: "B", spec: "Spec body", techDesign: "Design body" },
      { createId: () => "b", now: () => new Date("2026-06-26T00:01:00.000Z") },
    );

    let releaseRunner!: () => void;
    const releaseRunnerPromise = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    let bothStarted!: () => void;
    const bothStartedPromise = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    let inFlight = 0;

    const server = await startTestServer(
      repoPath,
      async (input, dependencies) => {
        inFlight += 1;
        if (inFlight === 2) {
          bothStarted();
        }
        await releaseRunnerPromise;
        inFlight -= 1;
        return {
          runId: admittedRunId(dependencies, `run-${input.workItemId}`),
          branchName: `nitely/run-${input.workItemId}`,
          worktreePath: `/tmp/run-${input.workItemId}`,
        } satisfies RunFlowResult;
      },
    );

    const responsePromise = fetch(`${server.url}/api/scheduler/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxConcurrentTasks: 2 }),
    });

    await expect(
      Promise.race([
        bothStartedPromise.then(() => "both-started"),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
      ]),
    ).resolves.toBe("both-started");

    releaseRunner();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toMatchObject({
      summary: {
        startedTaskIds: ["a", "b"],
        completedTaskIds: ["a", "b"],
        awaitingApprovalTaskIds: [],
        failedTaskIds: [],
        blockedTaskIds: [],
      },
    });
  });

  it("rejects invalid web API scheduler concurrency limits", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "Runnable implementation", spec: "Spec body", techDesign: "Design body" },
      { createId: () => "implementation" },
    );
    const server = await startTestServer(repoPath, async () => {
      throw new Error("scheduler should not run");
    });

    const response = await fetch(`${server.url}/api/scheduler/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxConcurrentTasks: 65 }),
    });

    await expectWebInputError(
      response,
      "maxConcurrentTasks must be an integer between 1 and 64",
    );
  });

  it("returns task-local scheduler errors without stranding later web API work", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "A", spec: "Spec body", techDesign: "Design body" },
      { createId: () => "a", now: () => new Date("2026-06-26T00:00:00.000Z") },
    );
    await createTask(
      repoPath,
      { title: "B", spec: "Spec body", techDesign: "Design body" },
      { createId: () => "b", now: () => new Date("2026-06-26T00:01:00.000Z") },
    );
    let runIdCalls = 0;
    const server = await startTestServer(
      repoPath,
      async (input, dependencies) => ({
        runId: admittedRunId(dependencies, `run-${input.workItemId}`),
        branchName: `nitely/run-${input.workItemId}`,
        worktreePath: `/tmp/run-${input.workItemId}`,
      }),
      undefined,
      {
        createRunId: () => {
          runIdCalls += 1;
          if (runIdCalls === 1) throw new Error("allocator unavailable");
          return `run-${runIdCalls}`;
        },
      },
    );

    const response = await fetch(`${server.url}/api/scheduler/run`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toMatchObject({
      summary: {
        startedTaskIds: ["b"],
        completedTaskIds: ["b"],
        taskErrors: {
          a: {
            code: "scheduler_task_processing_failed",
            message: "Scheduler could not process this Work item",
          },
        },
      },
    });
  });

  it("projects scheduler queue status from the latest run when task status is stale", async () => {
    const repoPath = await createRepo();
    await createTask(
      repoPath,
      { title: "Stale running task", spec: "Spec body", techDesign: "Design body" },
      { createId: () => "stale-running" },
    );
    await updateTaskRunState(repoPath, "stale-running", {
      status: "running",
      latestRunId: "run-stale-blocked",
    });
    await mkdir(join(repoPath, ".nitely/runs/run-stale-blocked"), { recursive: true });
    await writeFile(
      join(repoPath, ".nitely/runs/run-stale-blocked/run.json"),
      JSON.stringify(
        {
          runId: "run-stale-blocked",
          status: "blocked",
          flowName: "Implement task",
          flowPath: "flows/implement-spec-bootstrap.json",
          workItemId: "stale-running",
          workItemType: "dev.pr",
          completedStages: ["spec"],
          blocker: { reason: "needs-operator", stageId: "implementation" },
        },
        null,
        2,
      ),
      "utf8",
    );
    const server = await startTestServer(repoPath);

    const response = await fetch(`${server.url}/api/scheduler`);

    expect(response.status).toBe(200);
    const body = (await json(response)) as {
      scheduler: {
        summary: { running: number; blocked: number };
        queue: {
          running: Array<{ id: string }>;
          blocked: Array<{ id: string; status: string; displayStatus: string }>;
        };
        nodes: Array<{ id: string; displayStatus: string }>;
      };
    };
    expect(body.scheduler.summary).toMatchObject({
      running: 0,
      blocked: 1,
    });
    expect(body.scheduler.queue.running).toEqual([]);
    expect(body.scheduler.queue.blocked).toEqual([
      expect.objectContaining({
        id: "stale-running",
        status: "running",
        displayStatus: "blocked",
      }),
    ]);
    expect(body.scheduler.nodes.find((node) => node.id === "stale-running")).toMatchObject({
      displayStatus: "blocked",
    });
  });

  it("keeps web-saved provider credentials scoped to the signed-in user", async () => {
    const repoPath = await createRepo();
    await createUser(repoPath, {
      email: "a@example.test",
      password: "password a long passphrase",
      role: "user",
    });
    await createUser(repoPath, {
      email: "b@example.test",
      password: "password b long passphrase",
      role: "user",
    });
    let resolvedEnv: Record<string, string | undefined> | undefined;
    const server = await startTestServer(
      repoPath,
      async (_input, dependencies) => {
        resolvedEnv = await dependencies?.providerStore?.resolveEnv();
        const runId = admittedRunId(dependencies, "run-provider-a");
        return {
          runId,
          branchName: `nitely/${runId}`,
          worktreePath: join(repoPath, ".nitely/runs", runId, "worktree"),
        };
      },
      undefined,
      { authMode: "required", providerEnv: {} },
    );
    const a = await login(server, "a@example.test", "password a long passphrase");
    const b = await login(server, "b@example.test", "password b long passphrase");

    const save = await fetch(`${server.url}/api/providers/glm/connection`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: a.cookie,
      },
      body: JSON.stringify({ value: "glm-user-a-secret" }),
    });
    expect(save.status).toBe(200);

    await expect(
      json(await fetch(`${server.url}/api/providers`, { headers: { cookie: a.cookie } })),
    ).resolves.toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({ id: "glm", configured: true }),
      ]),
    });
    await expect(
      json(await fetch(`${server.url}/api/providers`, { headers: { cookie: b.cookie } })),
    ).resolves.toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({ id: "glm", configured: false }),
      ]),
    });

    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: a.cookie,
        },
        body: JSON.stringify({
          title: "Provider scoped run",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string } };
    await fetch(`${server.url}/api/tasks/${created.task.id}/runs`, {
      method: "POST",
      headers: { cookie: a.cookie },
    });

    await waitFor(
      async () => resolvedEnv,
      (env) => env?.NITELY_GLM_API_KEY === "glm-user-a-secret",
    );
  });

  it("denies provider credential writes for organization viewers and audits no secret", async () => {
    const repoPath = await createRepo();
    const owner = await createUser(repoPath, {
      email: "owner@example.test",
      password: "owner password passphrase",
      role: "user",
    });
    const viewer = await createUser(repoPath, {
      email: "viewer@example.test",
      password: "viewer password passphrase",
      role: "user",
    });
    const [team] = await listPublicMemberships(repoPath, owner.id);
    await addOrganizationMember(repoPath, team.organizationId, {
      userId: viewer.id,
      role: "viewer",
    });
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      providerEnv: {},
    });
    const signedIn = await login(
      server,
      "viewer@example.test",
      "viewer password passphrase",
    );

    const response = await fetch(`${server.url}/api/providers/glm/connection`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: signedIn.cookie,
        "x-nitely-organization-id": team.organizationId,
      },
      body: JSON.stringify({ value: "viewer-provider-secret" }),
    });

    expect(response.status).toBe(403);
    const audit = await waitFor(
      () => listSecurityAuditEvents(repoPath, { action: "providers.set" }),
      (events) => events.length > 0,
    );
    expect(audit).toEqual([
      expect.objectContaining({
        permission: "providers:write:personal",
        decision: "deny",
        actor: expect.objectContaining({
          id: viewer.id,
          organizationRole: "viewer",
        }),
        target: { type: "provider", id: "glm" },
      }),
    ]);
    expect(JSON.stringify(audit)).not.toContain("viewer-provider-secret");
  });

  it("lets admins inspect legacy unowned tasks and runs while hiding them from normal users", async () => {
    const repoPath = await createRepo();
    await createUser(repoPath, {
      email: "admin@example.test",
      password: "admin password passphrase",
      role: "admin",
    });
    await createUser(repoPath, {
      email: "user@example.test",
      password: "user password passphrase",
      role: "user",
    });
    const localServer = await startTestServer(repoPath);
    const legacy = (await json(
      await fetch(`${localServer.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Legacy task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string } };
    await localServer.close();
    servers.splice(servers.indexOf(localServer), 1);
    const runDirectory = join(repoPath, ".nitely/runs/run-legacy");
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      join(runDirectory, "run.json"),
      JSON.stringify({
        runId: "run-legacy",
        status: "completed",
        completedStages: [],
        inputs: {},
      }),
      "utf8",
    );
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
    });
    const admin = await login(server, "admin@example.test", "admin password passphrase");
    const user = await login(server, "user@example.test", "user password passphrase");

    await expect(
      json(await fetch(`${server.url}/api/tasks`, { headers: { cookie: admin.cookie } })),
    ).resolves.toMatchObject({
      tasks: expect.arrayContaining([
        expect.objectContaining({ id: legacy.task.id }),
        expect.objectContaining({ id: "inferred-run-run-legacy" }),
      ]),
    });
    await expect(
      json(await fetch(`${server.url}/api/runs`, { headers: { cookie: admin.cookie } })),
    ).resolves.toMatchObject({ runs: [{ runId: "run-legacy" }] });
    await expect(
      json(await fetch(`${server.url}/api/tasks`, { headers: { cookie: user.cookie } })),
    ).resolves.toEqual({ tasks: [] });
    await expect(
      json(await fetch(`${server.url}/api/runs`, { headers: { cookie: user.cookie } })),
    ).resolves.toEqual({ runs: [] });
  });

  it("returns enriched session fields from the backward-compatible run APIs", async () => {
    const repoPath = await createRepo();
    const runDirectory = join(repoPath, ".nitely/runs/run-session-api");
    await mkdir(join(runDirectory, "stages/review/1"), { recursive: true });
    await writeFile(
      join(runDirectory, "run.json"),
      JSON.stringify({
        runId: "run-session-api",
        status: "completed",
        ownerId: "local",
        flowName: "implement-spec-bootstrap",
        completedStages: ["review"],
        inputs: {
          spec: {
            sourceUri: ".nitely/tasks/task-api/spec.md",
            mediaType: "text/markdown",
          },
        },
        changeRequestUrl: "https://github.com/example/repo/pull/22",
      }),
      "utf8",
    );
    await writeFile(
      join(runDirectory, "stages/review/1/review.md"),
      "Review verdict: pass\n",
      "utf8",
    );
    const server = await startTestServer(repoPath);

    await expect(json(await fetch(`${server.url}/api/runs`))).resolves.toMatchObject({
      runs: [
        {
          runId: "run-session-api",
          sessionId: "run-session-api",
          taskId: "task-api",
          prNumber: 22,
          prUrl: "https://github.com/example/repo/pull/22",
        },
      ],
    });
    await expect(
      json(await fetch(`${server.url}/api/runs/run-session-api`)),
    ).resolves.toMatchObject({
      run: {
        runId: "run-session-api",
        sessionId: "run-session-api",
        contextManifest: [
          {
            id: "spec",
            sourceUri: ".nitely/tasks/task-api/spec.md",
            mediaType: "text/markdown",
          },
        ],
        timeline: [
          {
            stageId: "review",
            status: "completed",
          },
        ],
        reviewFindings: [
          {
            stageId: "review",
            severities: { none: 1 },
          },
        ],
        childRuns: [],
      },
    });
  });

  it("streams run logs over SSE and closes when the run is terminal", async () => {
    const repoPath = await createRepo();
    const runDirectory = join(repoPath, ".nitely/runs/run-log-stream");
    await mkdir(join(runDirectory, "stages/implement/1"), { recursive: true });
    await writeFile(
      join(runDirectory, "run.json"),
      JSON.stringify({
        runId: "run-log-stream",
        status: "completed",
        completedStages: ["implement"],
        flowName: "implement-spec-bootstrap",
      }),
      "utf8",
    );
    await writeFile(
      join(runDirectory, "stages/implement/1/stdout.log"),
      "hello from agent\n",
      "utf8",
    );
    await writeFile(
      join(runDirectory, "stages/implement/1/stderr.log"),
      "diag\n",
      "utf8",
    );
    const server = await startTestServer(repoPath);

    const response = await fetch(
      `${server.url}/api/runs/run-log-stream/logs/stream`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain(
      "text/event-stream",
    );
    const body = await response.text();
    expect(body).toContain("event: logs");
    expect(body).toContain("hello from agent");
    expect(body).toContain("diag");
    expect(body).toContain("event: done");
    expect(body).toContain("\"status\":\"completed\"");
  });

  it("answers the active structured operator question through the run API", async () => {
    const repoPath = await createRepo();
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const store = new EventStore(join(repoPath, ".nitely", "events.db"));
    store.append({
      runId: "run-question-api",
      type: "run.created",
      payload: {
        ownerId: "local",
        flowName: "question-flow",
        repoPath,
      },
    });
    store.append({
      runId: "run-question-api",
      stageId: "implement",
      attempt: 1,
      type: "stage.started",
      payload: { type: "agent" },
    });
    store.append({
      runId: "run-question-api",
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
      runId: "run-question-api",
      stageId: "implement",
      attempt: 1,
      type: "stage.blocked",
      payload: blocker,
    });
    store.append({
      runId: "run-question-api",
      type: "run.blocked",
      payload: blocker,
    });
    store.close();
    const server = await startTestServer(repoPath);

    await expect(
      json(await fetch(`${server.url}/api/runs/run-question-api`)),
    ).resolves.toMatchObject({
      run: {
        activeQuestion: {
          id: "implement-1",
          status: "pending",
          question: "Keep history?",
        },
        evidenceTimeline: expect.arrayContaining([
          expect.objectContaining({ label: "Question: implement-1" }),
        ]),
      },
    });

    const response = await fetch(
      `${server.url}/api/runs/run-question-api/questions/implement-1/answer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ optionId: "keep" }),
      },
    );
    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toMatchObject({
      question: {
        id: "implement-1",
        status: "answered",
        answer: { optionId: "keep", actor: "local" },
      },
    });

    const duplicate = await fetch(
      `${server.url}/api/runs/run-question-api/questions/implement-1/answer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "again" }),
      },
    );
    expect(duplicate.status).toBe(400);
    await expect(json(duplicate)).resolves.toMatchObject({
      error: { message: "question implement-1 is already answered" },
    });
  });

  it("attaches a server-attributed operator review verdict through the run API", async () => {
    const repoPath = await createRepo();
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const flowDocument = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "operator-review-api",
        inputs: [{ id: "implementation" }],
      },
      spec: {
        stages: [
          {
            id: "review",
            type: "gate",
            mode: "review",
            runtime: "codex",
            prompt: "Review the implementation.",
            inputs: ["implementation"],
            outputs: ["review-result"],
          },
        ],
      },
    });
    const attemptDirectory = join(
      repoPath,
      ".nitely",
      "runs",
      "run-review-api",
      "stages",
      "review",
      "1",
    );
    const store = new EventStore(join(repoPath, ".nitely", "events.db"));
    store.append({
      runId: "run-review-api",
      type: "run.created",
      payload: {
        ownerId: "local",
        flowName: "operator-review-api",
        flowPath: "unused.json",
        flowDocument,
        repoPath,
        inputs: {
          implementation: { connector: "local-file", uri: "README.md" },
        },
      },
    });
    store.append({
      runId: "run-review-api",
      stageId: "review",
      attempt: 1,
      type: "stage.started",
      payload: { type: "gate", attemptDirectory, runtime: "codex" },
    });
    const blocker = {
      reason: "agent_usage_limit",
      stageId: "review",
      runtime: "codex",
      message: "quota exceeded",
    };
    store.append({
      runId: "run-review-api",
      stageId: "review",
      attempt: 1,
      type: "stage.blocked",
      payload: blocker,
    });
    store.append({
      runId: "run-review-api",
      type: "run.blocked",
      payload: blocker,
    });
    store.close();
    const server = await startTestServer(repoPath);

    const response = await fetch(
      `${server.url}/api/runs/run-review-api/review-verdict`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actor: "forged-client-actor",
          content: "Review verdict: pass\nReason: manually checked",
          reviewedArtifactIds: ["implementation"],
        }),
      },
    );
    expect(response.status).toBe(201);
    await expect(json(response)).resolves.toMatchObject({
      gate: {
        stageId: "review",
        status: "passed",
        runtime: "operator",
        attempt: 1,
        operatorReview: {
          actor: "local",
          reviewedArtifactIds: ["implementation"],
          blocker: { reason: "agent_usage_limit", stageId: "review" },
        },
      },
    });

    await expect(
      json(await fetch(`${server.url}/api/runs/run-review-api`)),
    ).resolves.toMatchObject({
      run: {
        status: "blocked",
        gates: [
          expect.objectContaining({
            runtime: "operator",
            operatorReview: expect.objectContaining({ actor: "local" }),
          }),
        ],
        evidenceTimeline: expect.arrayContaining([
          expect.objectContaining({
            kind: "gate",
            label: "Operator review: review",
            detail: expect.objectContaining({
              source: "operator",
              actor: "local",
              reviewedArtifactIds: ["implementation"],
            }),
          }),
        ]),
      },
    });

    const duplicate = await fetch(
      `${server.url}/api/runs/run-review-api/review-verdict`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Review verdict: pass",
          reviewedArtifactIds: ["implementation"],
        }),
      },
    );
    expect(duplicate.status).toBe(400);
    await expect(json(duplicate)).resolves.toMatchObject({
      error: { message: expect.stringContaining("already submitted") },
    });
  });

  it("creates, lists, and edits repository context-kg entries through the Web API", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);

    const createResponse = await fetch(`${server.url}/api/context-kg`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        category: "pitfalls",
        title: "Preflight stays local",
        body: "Run preflight doctor commands against the local checkout before publishing.",
        status: "proposed",
        tags: ["preflight", "preflight"],
        keywords: ["doctor"],
        source: { type: "operator", uri: "https://github.com/example/repo/issues/225" },
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = (await json(createResponse)) as {
      entry: { id: string; repoPath: string; version: number };
    };
    expect(created.entry).toMatchObject({
      category: "pitfalls",
      title: "Preflight stays local",
      status: "proposed",
      tags: ["preflight"],
      keywords: ["doctor"],
      source: { type: "operator", uri: "https://github.com/example/repo/issues/225" },
      version: 1,
    });

    await expect(
      json(await fetch(`${server.url}/api/context-kg`)),
    ).resolves.toMatchObject({
      entries: [
        {
          id: created.entry.id,
          category: "pitfalls",
          title: "Preflight stays local",
        },
      ],
    });

    const updateResponse = await fetch(
      `${server.url}/api/context-kg/${encodeURIComponent(created.entry.id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "approved",
          title: "Preflight doctor stays local",
          keywords: ["doctor", "local"],
        }),
      },
    );

    expect(updateResponse.status).toBe(200);
    await expect(json(updateResponse)).resolves.toMatchObject({
      entry: {
        id: created.entry.id,
        status: "approved",
        title: "Preflight doctor stays local",
        keywords: ["doctor", "local"],
        version: 2,
      },
    });

    const rejectResponse = await fetch(
      `${server.url}/api/context-kg/${encodeURIComponent(created.entry.id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "rejected" }),
      },
    );

    expect(rejectResponse.status).toBe(200);
    await expect(json(rejectResponse)).resolves.toMatchObject({
      entry: {
        id: created.entry.id,
        status: "rejected",
        version: 3,
      },
    });
  });

  it("loads an exact context-kg proposal from a configured repository", async () => {
    const defaultRepo = await createRepo();
    const docsRepo = await createRepo();
    const proposal = await createContextKnowledgeEntry(docsRepo, {
      category: "feedback",
      title: "Keep review rationale",
      body: "Persist the operator rationale with the proposal decision.",
      status: "proposed",
      source: {
        type: "review",
        uri: "https://github.com/example/repo/pull/241#discussion_r1",
      },
    });
    const server = await startTestServer(defaultRepo, undefined, undefined, {
      repositories: [{ id: "docs", name: "Docs repo", path: docsRepo }],
    });

    const response = await fetch(
      `${server.url}/api/context-kg/${encodeURIComponent(proposal.id)}`,
    );

    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toMatchObject({
      entry: {
        id: proposal.id,
        repoId: "docs",
        repoName: "Docs repo",
        status: "proposed",
        title: "Keep review rationale",
      },
    });

    const missing = await fetch(`${server.url}/api/context-kg/ctx-missing`);
    expect(missing.status).toBe(404);
  });

  it("exposes injected context-kg entries on run summaries and details", async () => {
    const repoPath = await createRepo();
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const store = new EventStore(join(repoPath, ".nitely", "events.db"));
    try {
      store.append({
        runId: "run-context-kg-web",
        type: "run.created",
        createdAt: "2026-06-24T09:00:00.000Z",
        payload: {
          flowName: "implement",
          workItemId: "task-225",
          inputs: {},
        },
      });
      store.append({
        runId: "run-context-kg-web",
        type: "context-kg.injected",
        createdAt: "2026-06-24T09:00:01.000Z",
        payload: {
          linkedTaskId: "task-225",
          query: ["implement", "task-225", "preflight"],
          entries: [
            {
              id: "ctx-web-preflight",
              category: "pitfalls",
              title: "Preflight stays local",
              version: 3,
              tags: ["preflight"],
              keywords: ["doctor"],
            },
          ],
        },
      });
      store.append({
        runId: "run-context-kg-web",
        type: "run.completed",
        createdAt: "2026-06-24T09:00:02.000Z",
        payload: {},
      });
    } finally {
      store.close();
    }
    const server = await startTestServer(repoPath);

    await expect(json(await fetch(`${server.url}/api/runs`))).resolves.toMatchObject({
      runs: [
        {
          runId: "run-context-kg-web",
          contextKnowledge: [
            {
              id: "ctx-web-preflight",
              category: "pitfalls",
              title: "Preflight stays local",
              linkedTaskId: "task-225",
              injectedAt: "2026-06-24T09:00:01.000Z",
            },
          ],
        },
      ],
    });
    await expect(
      json(await fetch(`${server.url}/api/runs/run-context-kg-web`)),
    ).resolves.toMatchObject({
      run: {
        runId: "run-context-kg-web",
        contextKnowledge: [
          {
            id: "ctx-web-preflight",
            category: "pitfalls",
            title: "Preflight stays local",
            version: 3,
            tags: ["preflight"],
            keywords: ["doctor"],
            linkedTaskId: "task-225",
            injectedAt: "2026-06-24T09:00:01.000Z",
          },
        ],
      },
    });
  });

  it("redacts provider-store-only secrets from durable context manifests in run detail", async () => {
    const repoPath = await createRepo();
    const user = await createUser(repoPath, {
      email: "provider@example.test",
      password: "provider password passphrase",
      role: "user",
    });
    const providerOnlySecret = "provider-only-manifest-secret";
    expect(Object.values(process.env)).not.toContain(providerOnlySecret);
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      providerEnv: {},
    });
    const signedIn = await login(server, "provider@example.test", "provider password passphrase");
    const save = await fetch(`${server.url}/api/providers/glm/connection`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: signedIn.cookie,
      },
      body: JSON.stringify({ value: providerOnlySecret }),
    });
    expect(save.status).toBe(200);

    const runDirectory = join(repoPath, ".nitely/runs/run-provider-manifest");
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      join(runDirectory, "run.json"),
      JSON.stringify({
        runId: "run-provider-manifest",
        status: "completed",
        ownerId: user.id,
        completedStages: [],
        inputs: {},
      }),
      "utf8",
    );
    await writeFile(
      join(runDirectory, "context-manifest.json"),
      JSON.stringify(
        {
          version: 1,
          runId: "run-provider-manifest",
          generatedAt: "2026-06-20T00:00:00.000Z",
          entries: [
            {
              id: "provider",
              kind: "external-input",
              connector: "local-file",
              sourceUri: `secrets/${providerOnlySecret}.txt`,
              mediaType: "text/plain",
              filename: `${providerOnlySecret}.txt`,
              revision: `rev-${providerOnlySecret}`,
              policy: {
                decision: "warned",
                reason: `matched ${providerOnlySecret}`,
                matchedPattern: `secrets/*${providerOnlySecret}*`,
              },
              nested: { label: providerOnlySecret },
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const response = await fetch(`${server.url}/api/runs/run-provider-manifest`, {
      headers: { cookie: signedIn.cookie },
    });

    expect(response.status).toBe(200);
    const body = await json(response);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(providerOnlySecret);
    expect(serialized).toContain("[REDACTED]");
  });

  it("returns stable JSON validation errors", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);

    const response = await fetch(`${server.url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "", spec: "", techDesign: "" }),
    });

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      error: {
        code: "invalid_input",
        message: "title is required",
      },
    });
  });

  it("redacts unknown internal error messages from generic JSON errors", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, async () => {
      throw new Error("command failed: stderr contains secret-token");
    });
    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Redaction task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string } };

    const response = await fetch(
      `${server.url}/api/tasks/${created.task.id}/runs`,
      { method: "POST" },
    );

    expect(response.status).toBe(500);
    const body = await json(response);
    expect(body).toEqual({
      error: {
        code: "internal_error",
        message: "internal server error",
      },
    });
    expect(JSON.stringify(body)).not.toContain("secret-token");
    expect(JSON.stringify(body)).not.toContain("stderr");
  });

  it("creates tasks through the API and serves the Design Component frontend", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);

    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Browser task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string; title: string } };

    expect(created.task.title).toBe("Browser task");
    await expect(
      readFile(join(repoPath, ".nitely/tasks", created.task.id, "spec.md"), "utf8"),
    ).resolves.toBe("Spec body");

    const html = await (await fetch(server.url)).text();
    expect(html).toContain("<x-dc>");
    expect(html).toContain("DCLogic");
    expect(html).toContain("class Component extends");
  });

  it("enriches dashboard merge metrics while isolating lookup failures", async () => {
    let cacheNow = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => cacheNow);
    const repoPath = await createRepo();
    const changeRequestUrl = "https://github.com/Instask/nitely/pull/41";
    const unavailableUrl = "https://github.com/Instask/nitely/pull/42";
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const store = new EventStore(join(repoPath, ".nitely/events.db"));
    try {
      store.append({
        runId: "run-merged",
        type: "run.created",
        createdAt: "2026-06-23T10:00:00.000Z",
        payload: {
          flowName: "implement",
          branchName: "nitely/run-merged",
          inputs: {},
        },
      });
      store.append({
        runId: "run-merged",
        type: "run.completed",
        createdAt: "2026-06-23T10:01:00.000Z",
        payload: { changeRequestUrl },
      });
      store.append({
        runId: "run-merged-files",
        type: "run.created",
        createdAt: "2026-06-23T10:01:30.000Z",
        payload: {
          flowName: "rework",
          branchName: "nitely/run-merged",
          priorRunId: "run-merged",
          inputs: {},
        },
      });
      store.append({
        runId: "run-merged-files",
        type: "run.completed",
        createdAt: "2026-06-23T10:01:45.000Z",
        payload: { changeRequestUrl: `${changeRequestUrl}/files?diff=split` },
      });
      store.append({
        runId: "run-unavailable",
        type: "run.created",
        createdAt: "2026-06-23T10:02:00.000Z",
        payload: {
          flowName: "implement",
          branchName: "nitely/run-unavailable",
          inputs: {},
        },
      });
      store.append({
        runId: "run-unavailable",
        type: "run.completed",
        createdAt: "2026-06-23T10:03:00.000Z",
        payload: { changeRequestUrl: unavailableUrl },
      });
    } finally {
      store.close();
    }
    const getChangeRequestStatus = vi.fn(async (target: string) => {
      if (target === unavailableUrl) throw new Error("provider unavailable");
      return {
        provider: "github" as const,
        url: target,
        state: "closed",
        merged: true,
      };
    });
    const server = await startTestServer(repoPath, undefined, undefined, {
      getChangeRequestStatus,
    });

    const body = (await json(await fetch(`${server.url}/api/dashboard`))) as {
      dashboard: {
        pilotRoi: {
          mergedPrs: number;
          mergeRate: number;
          mergeStatusCoverage: number;
          mergedRunIds: string[];
        };
        outcomeBreakdown: Array<{
          key: string;
          tracking: string;
          count?: number;
        }>;
      };
    };
    expect((await fetch(`${server.url}/api/dashboard`)).status).toBe(200);

    expect(getChangeRequestStatus).toHaveBeenCalledTimes(2);
    expect(getChangeRequestStatus).toHaveBeenCalledWith(changeRequestUrl);
    expect(getChangeRequestStatus).toHaveBeenCalledWith(unavailableUrl);
    expect(body.dashboard.pilotRoi).toMatchObject({
      mergedPrs: 1,
      mergeRate: 1,
      mergeStatusCoverage: 0.5,
      mergedRunIds: ["run-merged-files", "run-merged"],
    });
    expect(body.dashboard.outcomeBreakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "merged-prs",
          tracking: "partial",
          count: 1,
        }),
      ]),
    );

    cacheNow += 60_001;
    expect((await fetch(`${server.url}/api/dashboard`)).status).toBe(200);
    expect(getChangeRequestStatus).toHaveBeenCalledTimes(4);
  });

  it("bounds dashboard status lookup latency and true in-flight concurrency", async () => {
    const repoPath = await createRepo();
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const store = new EventStore(join(repoPath, ".nitely/events.db"));
    try {
      for (let number = 1; number <= 5; number += 1) {
        const runId = `run-hung-${number}`;
        const changeRequestUrl = `https://github.com/Instask/nitely/pull/${number}`;
        store.append({
          runId,
          type: "run.created",
          payload: { flowName: "implement", inputs: {} },
        });
        store.append({
          runId,
          type: "run.completed",
          payload: { changeRequestUrl },
        });
        await upsertNotification(repoPath, {
          sourceKey: `${runId}:draft-pr`,
          type: "review-pr",
          severity: "info",
          title: "Review PR",
          link: changeRequestUrl,
          runId,
        });
      }
    } finally {
      store.close();
    }
    let active = 0;
    let maxActive = 0;
    const getChangeRequestStatus = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return await new Promise<never>(() => {});
    });
    const server = await startTestServer(repoPath, undefined, undefined, {
      getChangeRequestStatus,
    });

    const startedAt = performance.now();
    const response = await fetch(`${server.url}/api/dashboard`);
    const elapsedMs = performance.now() - startedAt;

    expect(response.status).toBe(200);
    expect(elapsedMs).toBeLessThan(7_500);
    expect(getChangeRequestStatus).toHaveBeenCalledTimes(4);
    expect(maxActive).toBe(4);

    const cachedStartedAt = performance.now();
    expect((await fetch(`${server.url}/api/dashboard`)).status).toBe(200);
    expect(performance.now() - cachedStartedAt).toBeLessThan(1_000);
    expect(getChangeRequestStatus).toHaveBeenCalledTimes(4);
  }, 15_000);

  it("isolates dashboard status caches by repository, user, and server input", async () => {
    const homeRepo = await createRepo();
    const otherRepo = await createRepo();
    const changeRequestUrl = "https://github.com/Instask/nitely/pull/77";
    for (const [repoPath, runId] of [
      [homeRepo, "run-shared"],
      [otherRepo, "run-shared"],
    ] as const) {
      await mkdir(join(repoPath, ".nitely"), { recursive: true });
      const store = new EventStore(join(repoPath, ".nitely/events.db"));
      try {
        store.append({
          runId,
          type: "run.created",
          payload: { flowName: "implement", inputs: {} },
        });
        store.append({
          runId,
          type: "run.completed",
          payload: { changeRequestUrl },
        });
      } finally {
        store.close();
      }
    }
    await createUser(homeRepo, {
      email: "first-admin@example.test",
      password: "first admin password passphrase",
      role: "admin",
    });
    await createUser(homeRepo, {
      email: "second-admin@example.test",
      password: "second admin password passphrase",
      role: "admin",
    });
    const getChangeRequestStatus = vi.fn(async (target: string) => ({
      provider: "github" as const,
      url: target,
      state: "open",
      merged: false,
    }));
    const options = {
      authMode: "required" as const,
      providerEnv: {},
      repositories: [{ id: "other", name: "Other", path: otherRepo }],
      getChangeRequestStatus,
    };
    const firstServer = await startTestServer(homeRepo, undefined, undefined, options);
    const secondServer = await startTestServer(homeRepo, undefined, undefined, options);
    const firstUser = await login(
      firstServer,
      "first-admin@example.test",
      "first admin password passphrase",
    );
    const secondUser = await login(
      firstServer,
      "second-admin@example.test",
      "second admin password passphrase",
    );
    const firstUserOtherServer = await login(
      secondServer,
      "first-admin@example.test",
      "first admin password passphrase",
    );

    const firstHeaders = { cookie: firstUser.cookie };
    expect((await fetch(`${firstServer.url}/api/dashboard`, { headers: firstHeaders })).status)
      .toBe(200);
    expect(getChangeRequestStatus).toHaveBeenCalledTimes(2);
    expect((await fetch(`${firstServer.url}/api/dashboard`, { headers: firstHeaders })).status)
      .toBe(200);
    expect(getChangeRequestStatus).toHaveBeenCalledTimes(2);

    expect((await fetch(`${firstServer.url}/api/dashboard?repo=other`, {
      headers: { cookie: secondUser.cookie },
    })).status).toBe(200);
    expect(getChangeRequestStatus).toHaveBeenCalledTimes(3);

    expect((await fetch(`${secondServer.url}/api/dashboard?repo=home`, {
      headers: { cookie: firstUserOtherServer.cookie },
    })).status).toBe(200);
    expect(getChangeRequestStatus).toHaveBeenCalledTimes(4);
  });

  it("does not reuse dashboard status state when the same input starts a new server", async () => {
    const repoPath = await createRepo();
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    const store = new EventStore(join(repoPath, ".nitely/events.db"));
    try {
      store.append({
        runId: "run-restarted-server",
        type: "run.created",
        payload: { flowName: "implement", inputs: {} },
      });
      store.append({
        runId: "run-restarted-server",
        type: "run.completed",
        payload: {
          changeRequestUrl: "https://github.com/Instask/nitely/pull/88",
        },
      });
    } finally {
      store.close();
    }
    const getChangeRequestStatus = vi.fn(async (target: string) => ({
      provider: "github" as const,
      url: target,
      state: "open",
      merged: false,
    }));
    const sharedInput = {
      repoPath,
      host: "127.0.0.1",
      port: 0,
      providerCommandStatus: async () => false,
      getChangeRequestStatus,
      readRepositoryOrigin: async () => undefined,
      repositories: [homeRepository(repoPath)],
    };
    const first = await startWebServer(sharedInput);
    servers.push(first);
    expect((await fetch(`${first.url}/api/dashboard`)).status).toBe(200);
    expect(getChangeRequestStatus).toHaveBeenCalledTimes(1);
    await first.close();
    servers.splice(servers.indexOf(first), 1);

    const second = await startWebServer(sharedInput);
    servers.push(second);
    expect((await fetch(`${second.url}/api/dashboard`)).status).toBe(200);
    expect(getChangeRequestStatus).toHaveBeenCalledTimes(2);
  });

  it("shares the provider lookup limit across restarted server instances", async () => {
    const repoPath = await createRepo();
    for (let number = 1; number <= 4; number += 1) {
      await upsertNotification(repoPath, {
        sourceKey: `restart-limit:${number}`,
        type: "review-pr",
        severity: "info",
        title: `Review PR ${number}`,
        link: `https://github.com/Instask/nitely/pull/${number}`,
      });
    }
    let active = 0;
    let maxActive = 0;
    const getChangeRequestStatus = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return await new Promise<never>(() => {});
    });
    const sharedInput = {
      repoPath,
      host: "127.0.0.1",
      port: 0,
      providerCommandStatus: async () => false,
      getChangeRequestStatus,
      readRepositoryOrigin: async () => undefined,
      repositories: [homeRepository(repoPath)],
    };

    const first = await startWebServer(sharedInput);
    servers.push(first);
    expect((await fetch(`${first.url}/api/notifications`)).status).toBe(200);
    expect(getChangeRequestStatus).toHaveBeenCalledTimes(4);
    await first.close();
    servers.splice(servers.indexOf(first), 1);

    const second = await startWebServer(sharedInput);
    servers.push(second);
    expect((await fetch(`${second.url}/api/notifications`)).status).toBe(200);
    expect(getChangeRequestStatus).toHaveBeenCalledTimes(4);
    expect(maxActive).toBe(4);
  });

  it("returns a manager dashboard across configured repositories", async () => {
    const homeRepo = await createRepo();
    const otherRepo = await createRepo();
    await createTask(
      homeRepo,
      {
        title: "Blocked home task",
        spec: "Spec",
        techDesign: "Design",
      },
      {
        createId: () => "task-home",
        initialStatus: "failed",
        now: () => new Date("2026-06-22T12:00:00.000Z"),
      },
    );
    await createTask(
      otherRepo,
      {
        title: "Ready other task",
        spec: "Spec",
        techDesign: "Design",
      },
      {
        createId: () => "task-other",
        repoId: "other",
        initialStatus: "ready",
        now: () => new Date("2026-06-23T12:00:00.000Z"),
      },
    );
    await mkdir(join(otherRepo, ".nitely"), { recursive: true });
    const store = new EventStore(join(otherRepo, ".nitely/events.db"));
    try {
      store.append({
        runId: "run-other",
        type: "run.created",
        createdAt: "2026-06-23T10:00:00.000Z",
        payload: {
          flowName: "implement",
          workItemId: "task-other",
          workItemType: "dev.pr",
          repoId: "other",
          repoName: "Other",
          branchName: "nitely/run-other",
          inputs: {},
        },
      });
      store.append({
        runId: "run-other",
        stageId: "implement",
        attempt: 1,
        type: "stage.started",
        createdAt: "2026-06-23T10:00:01.000Z",
        payload: { type: "agent", runtime: "codex" },
      });
      store.append({
        runId: "run-other",
        stageId: "implement",
        attempt: 1,
        type: "stage.context.usage",
        createdAt: "2026-06-23T10:00:02.000Z",
        payload: {
          promptBytes: 1200,
          approxTokens: 300,
          inputBytesInlined: 800,
          inputBytesSaved: 400,
          inputCount: 2,
        },
      });
      store.append({
        runId: "run-other",
        stageId: "implement",
        attempt: 1,
        type: "stage.runtime.usage",
        createdAt: "2026-06-23T10:00:03.000Z",
        payload: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          cost: {
            classification: "estimated",
            usd: 0.02,
            method: "pinned dashboard fixture price",
          },
          provenance: {
            provider: "fixture-provider",
            model: "fixture-model",
            observedAt: "2026-06-23T10:00:03.000Z",
            source: {
              kind: "calculated",
              reference: "dashboard.fixture-price",
            },
          },
        },
      });
      store.append({
        runId: "run-other",
        stageId: "implement",
        attempt: 1,
        type: "stage.completed",
        createdAt: "2026-06-23T10:01:00.000Z",
        payload: {},
      });
      store.append({
        runId: "run-other",
        type: "run.completed",
        createdAt: "2026-06-23T10:01:01.000Z",
        payload: {},
      });
    } finally {
      store.close();
    }
    const server = await startTestServer(homeRepo, undefined, undefined, {
      repositories: [
        { id: "other", name: "Other", path: otherRepo },
      ],
    });

    const body = (await json(
      await fetch(`${server.url}/api/dashboard`),
    )) as {
      dashboard: {
        taskCount: number;
        runCount: number;
        repositoryCount: number;
        throughput: {
          blockedItems: number;
          tasks: Array<{ label: string; taskIds: string[] }>;
          runs: Array<{ label: string; runIds: string[] }>;
        };
        cost: {
          runtimeTokens?: number;
          contextTokens?: number;
          estimatedCostUsd?: number;
          runtimeRunIds: string[];
          contextRunIds: string[];
          costRunIds: string[];
        };
        outcomes: { completedRunIds: string[] };
        repositories: Array<{
          repoId: string;
          taskCount: number;
          runCount: number;
          taskIds: string[];
          runIds: string[];
        }>;
        flowTemplates: Array<{ flowKey: string; flowName: string; runCount: number; runIds: string[] }>;
        lifecycle: Array<{ key: string; taskIds: string[]; runIds: string[] }>;
        phaseDurations: Array<{
          key: string;
          count: number;
          averageMs?: number;
          runIds: string[];
          taskIds: string[];
        }>;
      };
    };

    expect(body.dashboard).toMatchObject({
      taskCount: 2,
      runCount: 1,
      repositoryCount: 2,
      throughput: { blockedItems: 1 },
      cost: {
        runtimeTokens: 150,
        contextTokens: 300,
        estimatedCostUsd: 0.02,
        runtimeRunIds: ["run-other"],
        contextRunIds: ["run-other"],
        costRunIds: ["run-other"],
      },
    });
    expect(body.dashboard.throughput.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "completed", taskIds: ["task-other"] }),
        expect.objectContaining({ label: "failed", taskIds: ["task-home"] }),
      ]),
    );
    expect(body.dashboard.throughput.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "completed", runIds: ["run-other"] }),
      ]),
    );
    expect(body.dashboard.outcomes.completedRunIds).toEqual(["run-other"]);
    expect(body.dashboard.repositories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repoId: "home", taskCount: 1, taskIds: ["task-home"] }),
        expect.objectContaining({ repoId: "other", taskCount: 1, runCount: 1, taskIds: ["task-other"], runIds: ["run-other"] }),
      ]),
    );
    expect(body.dashboard.flowTemplates).toEqual([
      expect.objectContaining({
        flowKey: "implement",
        flowName: "implement",
        runCount: 1,
        runIds: ["run-other"],
      }),
    ]);
    expect(body.dashboard.lifecycle).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "blocked", taskIds: ["task-home"] }),
        expect.objectContaining({ key: "completed", taskIds: ["task-other"], runIds: ["run-other"] }),
      ]),
    );
    expect(body.dashboard.phaseDurations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "execution", count: 1, runIds: ["run-other"] }),
      ]),
    );

    const filtered = (await json(
      await fetch(
        `${server.url}/api/dashboard?repo=other&flow=implement&status=completed&priority=P2&owner=unassigned&start=2026-06-23&end=2026-06-23`,
      ),
    )) as {
      dashboard: {
        taskCount: number;
        runCount: number;
        filters: {
          activeCount: number;
          selected: Record<string, string>;
        };
        pilotRoi: { reviewableRunIds: string[] };
      };
    };
    expect(filtered.dashboard.taskCount).toBe(0);
    expect(filtered.dashboard.runCount).toBe(1);
    expect(filtered.dashboard.filters.activeCount).toBe(7);
    expect(filtered.dashboard.filters.selected).toMatchObject({
      repo: "other",
      flow: "implement",
      status: "completed",
      priority: "P2",
      owner: "unassigned",
      start: "2026-06-23",
      end: "2026-06-23",
    });
  });

  it("returns task detail data through the API and serves the Design Component for task routes", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Detail task",
          spec: "Spec <body>",
          techDesign: "Design body",
          issueUrl: "https://github.com/Instask/nitely/issues/12",
        }),
      }),
    )) as { task: { id: string; specPath: string; techDesignPath: string } };

    const detail = (await json(
      await fetch(`${server.url}/api/tasks/${created.task.id}`),
    )) as {
      task: { id: string; specPath: string; techDesignPath: string };
      spec: string;
      techDesign: string;
      preflight: { status: string; requiredInputs: string[] };
    };
    expect(detail).toMatchObject({
      task: {
        id: created.task.id,
        specPath: created.task.specPath,
        techDesignPath: created.task.techDesignPath,
      },
      spec: "Spec <body>",
      techDesign: "Design body",
      preflight: {
        status: "PASS",
        requiredInputs: ["spec", "tech-design"],
      },
    });

    const preflight = (await json(
      await fetch(`${server.url}/api/tasks/${created.task.id}/preflight`),
    )) as {
      preflight: {
        status: string;
        flowName: string;
        issues: Array<{ code: string }>;
      };
    };
    expect(preflight.preflight).toMatchObject({
      status: "PASS",
      flowName: "implement-spec-bootstrap",
    });
    expect(preflight.preflight.issues).toEqual([]);

    const html = await (
      await fetch(`${server.url}/tasks/${created.task.id}`)
    ).text();
    expect(html).toContain("<x-dc>");
    expect(html).toContain("DCLogic");
  });

  it("preserves a 400 response when a Task Flow disappears before preflight", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Missing Flow preflight",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string } };
    await rm(join(repoPath, "flows/implement-spec-bootstrap.json"));

    await expectWebInputError(
      await fetch(`${server.url}/api/tasks/${created.task.id}/preflight`),
      "flow path must exist inside the repository",
    );
  });

  it("serves JavaScript assets correctly from nested task and run route reloads", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Nested route asset task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string } };
    const runDirectory = join(repoPath, ".nitely/runs/run-direct-route");
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      join(runDirectory, "run.json"),
      JSON.stringify({
        runId: "run-direct-route",
        status: "completed",
        completedStages: ["implement"],
        inputs: {},
      }),
      "utf8",
    );

    for (const route of [
      `/tasks/${created.task.id}`,
      "/runs/run-direct-route",
    ]) {
      const pageResponse = await fetch(`${server.url}${route}`);
      expect(pageResponse.status).toBe(200);
      expect(pageResponse.headers.get("content-type")).toContain("text/html");
      const html = await pageResponse.text();
      expect(html).toContain('src="/support.js"');
      const scriptSources = Array.from(html.matchAll(/<script[^>]+src="([^"]+)"/g))
        .map((match) => match[1]);
      expect(scriptSources).toContain("/support.js");

      for (const scriptSource of scriptSources) {
        const scriptUrl = new URL(scriptSource, pageResponse.url);
        const scriptResponse = await fetch(scriptUrl);
        expect(scriptResponse.status).toBe(200);
        expect(scriptResponse.headers.get("content-type")).toContain(
          "application/javascript",
        );
        const scriptBody = await scriptResponse.text();
        expect(scriptBody).toContain("DCLogic");
        expect(scriptBody).not.toContain("<!DOCTYPE html>");
      }
    }
  });

  it("serves the Design Component shell for shipped Web Console routes", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Console route task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string } };

    for (const route of [
      "/",
      "/dashboard",
      "/agent-stability",
      "/scheduler",
      "/tasks",
      `/tasks/${created.task.id}`,
      "/runs/run-debug-route",
      "/context-kg?entry=ctx-proposal",
      "/repositories",
      "/skills",
      "/providers",
    ]) {
      const response = await fetch(`${server.url}${route}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      const html = await response.text();
      expect(html).toContain("<x-dc>");
      expect(html).toContain("DCLogic");
      expect(html).not.toContain("Nitely Console</div>");
    }
  });

  it("serves the Agent Stability console at the /agent-stability page route", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);

    const response = await fetch(`${server.url}/agent-stability`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain('data-screen-label="Agent Stability"');
    expect(html).toContain('path === "/agent-stability"');
  });

  it("enriches task APIs with additive work-item run fields", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Enriched API task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string; specPath: string } };
    const runDirectory = join(repoPath, ".nitely/runs/run-api-1");
    await mkdir(join(runDirectory, "stages/implement/1"), { recursive: true });
    await writeFile(
      join(runDirectory, "run.json"),
      JSON.stringify(
        {
          runId: "run-api-1",
          status: "completed",
          completedStages: ["implement"],
          inputs: { spec: { sourceUri: created.task.specPath } },
          changeRequestUrl: "https://github.com/example/repo/pull/12",
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      join(runDirectory, "stages/implement/1/stdout.log"),
      "installing\nchecks passed\n",
      "utf8",
    );

    const tasksBody = (await json(await fetch(`${server.url}/api/tasks`))) as {
      tasks: Array<{
        id: string;
        title: string;
        latestRun?: { runId: string; recentLogSummary?: string };
        runCount?: number;
        currentStage?: string;
        latestChangeRequestUrl?: string;
      }>;
    };
    expect(tasksBody.tasks[0]).toMatchObject({
      id: created.task.id,
      title: "Enriched API task",
      latestRun: {
        runId: "run-api-1",
        recentLogSummary: "checks passed",
      },
      runCount: 1,
      currentStage: "implement",
      latestChangeRequestUrl: "https://github.com/example/repo/pull/12",
    });

    const detailBody = (await json(
      await fetch(`${server.url}/api/tasks/${created.task.id}`),
    )) as {
      task: { id: string };
      spec: string;
      techDesign: string;
      runs?: Array<{ runId: string; recentLogSummary?: string }>;
    };
    expect(detailBody).toMatchObject({
      task: { id: created.task.id },
      spec: "Spec body",
      techDesign: "Design body",
      runs: [{ runId: "run-api-1", recentLogSummary: "checks passed" }],
    });
  });

  it("starts a task run with materialized local-file inputs", async () => {
    const repoPath = await createRepo();
    let runInput: RunFlowInput | undefined;
    const server = await startTestServer(
      repoPath,
      async (input) => {
        runInput = input;
        return {
          runId: "run-web",
          branchName: "nitely/run-web",
          worktreePath: join(repoPath, ".nitely/runs/run-web/worktree"),
          changeRequestUrl: "https://github.com/example/repo/pull/2",
        };
      },
      undefined,
      { createRunId: () => "run-web" },
    );
    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Run from browser",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as {
      task: {
        id: string;
        planningArtifacts: {
          spec: {
            approvedVersionId: string;
            revisions: Array<{
              versionId: string;
              contentPath: string;
              contentHash: string;
              approvalState: string;
            }>;
          };
          techDesign: {
            approvedVersionId: string;
            revisions: Array<{
              versionId: string;
              contentPath: string;
              contentHash: string;
              approvalState: string;
            }>;
          };
        };
      };
    };
    expect(created.task.planningArtifacts.spec.approvedVersionId).toBe("spec-r1");
    expect(created.task.planningArtifacts.spec.revisions[0]).toMatchObject({
      versionId: "spec-r1",
      contentPath: `.nitely/tasks/${created.task.id}/versions/spec/r1.md`,
      approvalState: "approved",
    });
    expect(created.task.planningArtifacts.spec.revisions[0].contentHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(created.task.planningArtifacts.techDesign.approvedVersionId).toBe(
      "tech-design-r1",
    );
    expect(created.task.planningArtifacts.techDesign.revisions[0]).toMatchObject({
      versionId: "tech-design-r1",
      contentPath: `.nitely/tasks/${created.task.id}/versions/tech-design/r1.md`,
      approvalState: "approved",
    });
    await expect(
      readFile(
        join(
          repoPath,
          created.task.planningArtifacts.spec.revisions[0].contentPath,
        ),
        "utf8",
      ),
    ).resolves.toBe("Spec body");
    await expect(
      readFile(
        join(
          repoPath,
          created.task.planningArtifacts.techDesign.revisions[0].contentPath,
        ),
        "utf8",
      ),
    ).resolves.toBe("Design body");

    const response = await fetch(
      `${server.url}/api/tasks/${created.task.id}/runs`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      run: {
        runId: "run-web",
        branchName: "nitely/run-web",
      },
    });
    await expect(
      waitFor(
        () => getTask(repoPath, created.task.id),
        (record) => record.status === "completed",
      ),
    ).resolves.toMatchObject({
      latestRunId: "run-web",
      changeRequestUrl: "https://github.com/example/repo/pull/2",
    });
    expect(runInput).toEqual({
      flowPath: join(repoPath, "flows/implement-spec-bootstrap.json"),
      flowDocument: await readFile(
        join(repoPath, "flows/implement-spec-bootstrap.json"),
        "utf8",
      ),
      executionBackend: "local",
      repoPath,
      inputs: {
        spec: {
          connector: "local-file",
          uri: `.nitely/tasks/${created.task.id}/versions/spec/r1.md`,
        },
        "tech-design": {
          connector: "local-file",
          uri: `.nitely/tasks/${created.task.id}/versions/tech-design/r1.md`,
        },
        "workflow-metadata": {
          connector: "local-file",
          uri: expect.stringMatching(
            /^\.nitely\/tasks\/[^/]+\/execution\/candidates\/[a-f0-9]{64}\/workflow-metadata\.json$/,
          ),
        },
      },
      repoId: "home",
      repoName: expect.any(String),
      workItemId: created.task.id,
      workItemType: "dev.pr",
      planningApproval: {
        artifacts: {
          spec: {
            path: `.nitely/tasks/${created.task.id}/versions/spec/r1.md`,
            state: "spec_approved",
            versionId: "spec-r1",
            contentHash: created.task.planningArtifacts.spec.revisions[0].contentHash,
          },
          techDesign: {
            path: `.nitely/tasks/${created.task.id}/versions/tech-design/r1.md`,
            state: "tech_design_approved",
            versionId: "tech-design-r1",
            contentHash:
              created.task.planningArtifacts.techDesign.revisions[0].contentHash,
          },
        },
        events: [
          expect.objectContaining({
            artifact: "spec",
            artifactPath: `.nitely/tasks/${created.task.id}/versions/spec/r1.md`,
            decision: "approve",
            previousState: "draft_spec",
            nextState: "spec_approved",
          }),
          expect.objectContaining({
            artifact: "tech-design",
            artifactPath: `.nitely/tasks/${created.task.id}/versions/tech-design/r1.md`,
            decision: "approve",
            previousState: "draft_tech_design",
            nextState: "tech_design_approved",
          }),
        ],
      },
    });

    const detail = (await json(
      await fetch(`${server.url}/api/tasks/${created.task.id}`),
    )) as {
      task: {
        activePlanningBaseline?: {
          specVersionId?: string;
          specContentHash?: string;
          techDesignVersionId?: string;
          techDesignContentHash?: string;
        };
      };
      runs: Array<{
        planningApproval?: {
          artifacts: {
            spec?: { versionId?: string; contentHash?: string };
            techDesign?: { versionId?: string; contentHash?: string };
          };
        };
      }>;
    };
    expect(detail.task.activePlanningBaseline).toMatchObject({
      specVersionId: "spec-r1",
      specContentHash: created.task.planningArtifacts.spec.revisions[0].contentHash,
      techDesignVersionId: "tech-design-r1",
      techDesignContentHash:
        created.task.planningArtifacts.techDesign.revisions[0].contentHash,
    });
    expect(detail.runs[0]?.planningApproval?.artifacts).toMatchObject({
      spec: {
        versionId: "spec-r1",
        contentHash: created.task.planningArtifacts.spec.revisions[0].contentHash,
      },
      techDesign: {
        versionId: "tech-design-r1",
        contentHash:
          created.task.planningArtifacts.techDesign.revisions[0].contentHash,
      },
    });
  });

  it("rejects a legacy Run when its planning candidate changes during preflight", async () => {
    const repoPath = await createRepo();
    const task = await createTask(repoPath, {
      title: "Stable evaluated planning snapshot",
      spec: "Spec A",
      techDesign: "Design body",
    });
    const specA = task.planningArtifacts?.spec?.revisions[0];
    expect(specA).toBeDefined();
    const specBPath = `.nitely/tasks/${task.id}/versions/spec/r2.md`;
    await writeFile(join(repoPath, specBPath), "Spec B", "utf8");
    let mutated = false;
    const providerStore: ProviderConnectionStore = {
      getConnection: async () => {
        throw new Error("unused");
      },
      resolveEnv: async () => ({}),
      listStatuses: async () => {
        if (!mutated) {
          mutated = true;
          const taskPath = join(repoPath, `.nitely/tasks/${task.id}/task.json`);
          const persisted = JSON.parse(await readFile(taskPath, "utf8")) as {
            planningArtifacts: {
              spec: {
                currentVersionId: string;
                approvedVersionId: string;
                revisions: Array<Record<string, unknown>>;
              };
            };
          };
          persisted.planningArtifacts.spec.currentVersionId = "spec-r2";
          persisted.planningArtifacts.spec.approvedVersionId = "spec-r2";
          persisted.planningArtifacts.spec.revisions.push({
            ...persisted.planningArtifacts.spec.revisions[0],
            versionId: "spec-r2",
            contentPath: specBPath,
            contentHash: "b".repeat(64),
          });
          await writeFile(taskPath, JSON.stringify(persisted, null, 2), "utf8");
        }
        return [];
      },
    };
    let runInput: RunFlowInput | undefined;
    const server = await startTestServer(
      repoPath,
      async (input, dependencies) => {
        runInput = input;
        const runId =
          dependencies?.createRunId?.() ?? "run-legacy-evaluated-snapshot";
        return {
          runId,
          branchName: `nitely/${runId}`,
          worktreePath: join(
            repoPath,
            `.nitely/runs/${runId}/worktree`,
          ),
        };
      },
      providerStore,
    );

    const response = await fetch(`${server.url}/api/tasks/${task.id}/runs`, {
      method: "POST",
    });

    expect(response.status).toBe(409);
    await expect(json(response)).resolves.toMatchObject({
      error: {
        code: "run_start_conflict",
        message:
          "Work item changed after Run eligibility was evaluated; refresh and retry",
      },
    });
    expect(runInput).toBeUndefined();
    const persisted = JSON.parse(
      await readFile(join(repoPath, `.nitely/tasks/${task.id}/task.json`), "utf8"),
    ) as {
      planningArtifacts: { spec: { approvedVersionId: string } };
      activePlanningBaseline?: { specVersionId?: string };
    };
    expect(persisted.planningArtifacts.spec.approvedVersionId).toBe("spec-r2");
    expect(persisted.activePlanningBaseline).toBeUndefined();
  });

  it("rejects a legacy Run when planning appears during preflight", async () => {
    const repoPath = await createRepo();
    const task = await createTask(repoPath, {
      title: "Legacy task without versioned planning",
      spec: "Legacy spec",
      techDesign: "Legacy design",
    });
    const taskPath = join(repoPath, `.nitely/tasks/${task.id}/task.json`);
    const legacyRecord = JSON.parse(await readFile(taskPath, "utf8")) as {
      planningArtifacts?: {
        spec?: { approvedVersionId?: string };
      };
      activePlanningBaseline?: unknown;
    };
    const planningArtifactsB = legacyRecord.planningArtifacts;
    expect(planningArtifactsB?.spec?.approvedVersionId).toBe("spec-r1");
    delete legacyRecord.planningArtifacts;
    legacyRecord.activePlanningBaseline = {
      specVersionId: "stale-spec-version",
      specContentHash: "stale-spec-hash",
      recordedAt: "2026-07-01T00:00:00.000Z",
    };
    await writeFile(taskPath, JSON.stringify(legacyRecord, null, 2), "utf8");

    let upgraded = false;
    const providerStore: ProviderConnectionStore = {
      getConnection: async () => {
        throw new Error("unused");
      },
      resolveEnv: async () => ({}),
      listStatuses: async () => {
        if (!upgraded) {
          upgraded = true;
          const persisted = JSON.parse(
            await readFile(taskPath, "utf8"),
          ) as Record<string, unknown>;
          await writeFile(
            taskPath,
            JSON.stringify(
              {
                ...persisted,
                planningArtifacts: planningArtifactsB,
              },
              null,
              2,
            ),
            "utf8",
          );
        }
        return [];
      },
    };
    let runInput: RunFlowInput | undefined;
    const server = await startTestServer(
      repoPath,
      async (input, dependencies) => {
        runInput = input;
        const runId =
          dependencies?.createRunId?.() ?? "run-absent-planning-baseline";
        return {
          runId,
          branchName: `nitely/${runId}`,
          worktreePath: join(repoPath, `.nitely/runs/${runId}/worktree`),
          status: "awaiting-approval",
          approvalId: "approval-absent-planning-baseline",
        };
      },
      providerStore,
    );

    const response = await fetch(`${server.url}/api/tasks/${task.id}/runs`, {
      method: "POST",
    });
    expect(response.status).toBe(409);
    await expect(json(response)).resolves.toMatchObject({
      error: { code: "run_start_conflict" },
    });
    expect(runInput).toBeUndefined();
    const persisted = JSON.parse(await readFile(taskPath, "utf8")) as {
      planningArtifacts?: {
        spec?: { approvedVersionId?: string };
      };
      activePlanningBaseline?: unknown;
    };
    expect(persisted.planningArtifacts?.spec?.approvedVersionId).toBe("spec-r1");
    expect(persisted.activePlanningBaseline).toMatchObject({
      specVersionId: "stale-spec-version",
    });
  });

  it("blocks stale source tasks unless override is acknowledged and supplies execution metadata", async () => {
    const repoPath = await createRepo();
    let runInput: RunFlowInput | undefined;
    const server = await startTestServer(
      repoPath,
      async (input) => {
        runInput = input;
        return {
          runId: "run-stale-source-override",
          branchName: "nitely/run-stale-source-override",
          worktreePath: join(
            repoPath,
            ".nitely/runs/run-stale-source-override/worktree",
          ),
        };
      },
      undefined,
      { createRunId: () => "run-stale-source-override" },
    );
    const task = await createTask(
      repoPath,
      {
        title: "Stale source execution",
        spec: "Spec body",
        techDesign: "Design body",
        issueUrl: "https://github.com/Instask/nitely/issues/228",
      },
      {
        source: {
          type: "github-issue",
          uri: "https://github.com/Instask/nitely/issues/228",
          title: "Original title",
          snapshot: {
            uri: "https://github.com/Instask/nitely/issues/228",
            title: "Original title",
            body: "Original body",
            fetchedAt: "2026-06-28T00:00:00.000Z",
            updatedAt: "2026-06-28T00:00:00.000Z",
          },
          drift: {
            status: "changed",
            checkedAt: "2026-06-28T01:00:00.000Z",
            changedFields: ["body"],
            latestSnapshot: {
              uri: "https://github.com/Instask/nitely/issues/228",
              title: "Original title",
              body: "Updated body",
              fetchedAt: "2026-06-28T01:00:00.000Z",
              updatedAt: "2026-06-28T01:00:00.000Z",
            },
          },
        },
      },
    );

    const blocked = await fetch(`${server.url}/api/tasks/${task.id}/runs`, {
      method: "POST",
    });

    await expectWebInputError(
      blocked,
      "source issue changed since planning; refresh planning or start with override=true",
    );
    expect(runInput).toBeUndefined();

    const override = await fetch(`${server.url}/api/tasks/${task.id}/runs?override=true`, {
      method: "POST",
    });

    expect(override.status).toBe(200);
    expect(runInput?.inputs).toMatchObject({
      source: {
        connector: "local-file",
        uri: expect.stringMatching(
          /^\.nitely\/tasks\/[^/]+\/execution\/candidates\/[a-f0-9]{64}\/source\.json$/,
        ),
      },
      "workflow-metadata": {
        connector: "local-file",
        uri: expect.stringMatching(
          /^\.nitely\/tasks\/[^/]+\/execution\/candidates\/[a-f0-9]{64}\/workflow-metadata\.json$/,
        ),
      },
    });
    const candidateSourceUri = runInput?.inputs.source?.uri;
    const candidateMetadataUri = runInput?.inputs["workflow-metadata"]?.uri;
    expect(candidateSourceUri).toBeTypeOf("string");
    expect(candidateMetadataUri).toBeTypeOf("string");
    await expect(
      readFile(join(repoPath, candidateSourceUri!), "utf8"),
    ).resolves.toContain("Updated body");
    const metadata = JSON.parse(
      await readFile(
        join(repoPath, candidateMetadataUri!),
        "utf8",
      ),
    ) as {
      taskId: string;
      flowPath: string;
      status: string;
      sourceDrift?: { status: string };
      sourceDriftOverride?: { actor?: string; reason: string; changedFields: string[] };
      planningBaseline?: { specVersionId?: string };
    };
    expect(metadata).toMatchObject({
      taskId: task.id,
      flowPath: "flows/implement-spec-bootstrap.json",
      status: "running",
      sourceDrift: { status: "changed" },
      sourceDriftOverride: {
        actor: "local",
        reason: "operator acknowledged source drift and started with override=true",
        changedFields: ["body"],
      },
      planningBaseline: { specVersionId: "spec-r1" },
    });
  });

  it("returns source drift title body and state diffs in task detail", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const task = await createTask(
      repoPath,
      {
        title: "Source drift diff",
        spec: "Spec body",
        techDesign: "Design body",
        issueUrl: "https://github.com/Instask/nitely/issues/316",
      },
      {
        source: {
          type: "github-issue",
          uri: "https://github.com/Instask/nitely/issues/316",
          title: "Old source drift issue",
          snapshot: {
            uri: "https://github.com/Instask/nitely/issues/316",
            title: "Old source drift issue",
            body: "Old issue body with enough detail for the original plan.",
            state: "open",
            fetchedAt: "2026-06-28T00:00:00.000Z",
            updatedAt: "2026-06-28T00:00:00.000Z",
          },
          drift: {
            status: "changed",
            checkedAt: "2026-06-28T01:00:00.000Z",
            changedFields: ["title", "body", "state", "updatedAt"],
            latestSnapshot: {
              uri: "https://github.com/Instask/nitely/issues/316",
              title: "New source drift issue",
              body: "New issue body that changes the requested behavior.",
              state: "closed",
              fetchedAt: "2026-06-28T01:00:00.000Z",
              updatedAt: "2026-06-28T01:00:00.000Z",
            },
          },
        },
      },
    );

    const response = await fetch(`${server.url}/api/tasks/${task.id}`);

    expect(response.status).toBe(200);
    const detail = (await json(response)) as {
      sourceDriftDiff?: Array<{
        field?: string;
        label?: string;
        previous?: string;
        latest?: string;
      }>;
    };
    expect(detail.sourceDriftDiff).toEqual([
      {
        field: "title",
        label: "Title",
        previous: "Old source drift issue",
        latest: "New source drift issue",
      },
      {
        field: "body",
        label: "Body",
        previous: "Old issue body with enough detail for the original plan.",
        latest: "New issue body that changes the requested behavior.",
      },
      {
        field: "state",
        label: "State",
        previous: "open",
        latest: "closed",
      },
    ]);
  });

  it("blocks spec-readiness failures unless operator override is acknowledged", async () => {
    const repoPath = await createRepo();
    let runStarted = false;
    const server = await startTestServer(repoPath, async () => {
      runStarted = true;
      return {
        runId: "run-readiness-override",
        branchName: "nitely/run-readiness-override",
        worktreePath: join(repoPath, ".nitely/runs/run-readiness-override/worktree"),
      };
    });
    const draft = generateDraftSpec({
      type: "github-issue",
      uri: "https://github.com/Instask/nitely/issues/228",
      title: "Spec readiness override",
      body: "Block generic generated specs before implementation.",
    });
    const task = await createTask(
      repoPath,
      {
        title: "Spec readiness override",
        spec: draft.markdown,
        techDesign: "Design body",
        issueUrl: "https://github.com/Instask/nitely/issues/228",
      },
      {
        createId: () => "readiness-override-task",
        source: {
          type: "github-issue",
          uri: "https://github.com/Instask/nitely/issues/228",
          title: "Spec readiness override",
          snapshot: {
            uri: "https://github.com/Instask/nitely/issues/228",
            title: "Spec readiness override",
            body: "Block generic generated specs before implementation.",
            fetchedAt: "2026-06-28T00:00:00.000Z",
          },
        },
      },
    );

    const blocked = await fetch(`${server.url}/api/tasks/${task.id}/runs`, {
      method: "POST",
    });

    expect(blocked.status).toBe(400);
    const blockedBody = (await json(blocked)) as {
      error?: { message?: unknown };
    };
    expect(String(blockedBody.error?.message)).toContain(
      "spec readiness blocks execution",
    );
    expect(runStarted).toBe(false);

    const detailResponse = await fetch(`${server.url}/api/tasks/${task.id}`);
    expect(detailResponse.status).toBe(200);
    const detail = (await json(detailResponse)) as {
      specReadiness?: { status?: string; issues?: Array<{ code?: string }> };
    };
    expect(detail.specReadiness?.status).toBe("BLOCK");
    expect(detail.specReadiness?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "generic-functional-requirement",
        }),
      ]),
    );

    const override = await fetch(`${server.url}/api/tasks/${task.id}/runs?override=true`, {
      method: "POST",
      body: JSON.stringify({
        reason: "operator accepted spec readiness risk for emergency run",
      }),
    });

    expect(override.status).toBe(200);
    expect(runStarted).toBe(true);
    const metadata = JSON.parse(
      await readFile(
        join(repoPath, `.nitely/tasks/${task.id}/execution/workflow-metadata.json`),
        "utf8",
      ),
    ) as {
      specReadinessOverride?: {
        reason?: string;
        status?: string;
        issueCodes?: string[];
      };
    };
    expect(metadata.specReadinessOverride).toMatchObject({
      reason: "operator accepted spec readiness risk for emergency run",
      status: "BLOCK",
      issueCodes: expect.arrayContaining(["generic-functional-requirement"]),
    });
  });

  it("refreshes stale GitHub source planning from the latest snapshot", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const task = await createTask(
      repoPath,
      {
        title: "Refresh source planning",
        spec: "Approved old spec",
        techDesign: "Approved old design",
        issueUrl: "https://github.com/Instask/nitely/issues/308",
      },
      {
        source: {
          type: "github-issue",
          uri: "https://github.com/Instask/nitely/issues/308",
          title: "Old issue title",
          snapshot: {
            uri: "https://github.com/Instask/nitely/issues/308",
            title: "Old issue title",
            body: "Old issue body",
            fetchedAt: "2026-06-28T00:00:00.000Z",
            updatedAt: "2026-06-28T00:00:00.000Z",
          },
          drift: {
            status: "changed",
            checkedAt: "2026-06-28T01:00:00.000Z",
            changedFields: ["title", "body"],
            latestSnapshot: {
              uri: "https://github.com/Instask/nitely/issues/308",
              title: "Updated source drift issue",
              body: "Show source drift blockers with refresh and override actions.",
              fetchedAt: "2026-06-28T01:00:00.000Z",
              updatedAt: "2026-06-28T01:00:00.000Z",
            },
          },
        },
      },
    );

    const response = await fetch(
      `${server.url}/api/tasks/${task.id}/refresh-source-planning`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    const refreshed = (await json(response)) as {
      task: {
        status: string;
        specStatus?: string;
        techDesignStatus?: string;
        source?: {
          title?: string;
          snapshot?: { title?: string; body?: string };
          drift?: { status?: string; changedFields?: string[] };
        };
      };
      spec: string;
    };
    expect(refreshed.task).toMatchObject({
      status: "draft",
      specStatus: "draft",
      techDesignStatus: "draft",
      source: {
        title: "Updated source drift issue",
        snapshot: {
          title: "Updated source drift issue",
          body: "Show source drift blockers with refresh and override actions.",
        },
        drift: { status: "unchanged", changedFields: [] },
      },
    });
    expect(refreshed.spec).toContain("Updated source drift issue");
    await expect(readFile(join(repoPath, task.specPath), "utf8")).resolves.toContain(
      "Show source drift blockers with refresh and override actions.",
    );
  });

  it("creates a draft spec task from prompt intake and blocks implementation runs", async () => {
    const repoPath = await createRepo();
    let runStarted = false;
    const server = await startTestServer(repoPath, async () => {
      runStarted = true;
      throw new Error("draft tasks must not start");
    });

    const response = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "prompt",
        prompt: "Add repository import from a pasted GitHub URL.",
        title: "Repository import",
      }),
    });

    expect(response.status).toBe(201);
    const created = (await json(response)) as {
      task: {
        id: string;
        status: string;
        specStatus?: string;
        source?: { type: string };
        specPath: string;
      };
      spec: string;
    };
    expect(created.task).toMatchObject({
      status: "draft",
      specStatus: "draft",
      source: { type: "prompt" },
    });
    expect(created.spec).toContain("Status: draft");
    await expect(readFile(join(repoPath, created.task.specPath), "utf8")).resolves.toBe(
      created.spec,
    );

    const runResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/runs`,
      { method: "POST" },
    );

    await expectWebInputError(
      runResponse,
      "draft spec must be approved before starting a run",
    );
    expect(runStarted).toBe(false);
  });

  it("uses relevant context-kg entries when generating draft specs", async () => {
    const repoPath = await createRepo();
    await createContextKnowledgeEntry(
      repoPath,
      {
        category: "conventions",
        title: "Repository import validates before cloning",
        body: "Repository import specs must include duplicate URL and missing path validation before implementation.",
        tags: ["planning"],
        keywords: ["repository import"],
      },
      {
        createId: () => "ctx-repository-import",
        now: () => "2026-07-07T01:00:00.000Z",
      },
    );
    const server = await startTestServer(repoPath);

    const response = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "prompt",
        prompt: "Add repository import from a pasted GitHub URL.",
        title: "Repository import",
      }),
    });

    expect(response.status).toBe(201);
    const created = (await json(response)) as {
      task: { id: string; specPath: string };
      spec: string;
      contextKnowledge?: Array<{ id: string; title: string; category: string }>;
    };
    expect(created.contextKnowledge).toEqual([
      {
        id: "ctx-repository-import",
        title: "Repository import validates before cloning",
        category: "conventions",
      },
    ]);
    expect(created.spec).toContain("## Repository Context Knowledge");
    expect(created.spec).toContain("ctx-repository-import");
    expect(created.spec).toContain(
      "Repository import specs must include duplicate URL and missing path validation before implementation.",
    );
    await expect(readFile(join(repoPath, created.task.specPath), "utf8")).resolves.toBe(
      created.spec,
    );
  });

  it("rejects approving source-backed generated specs until requirements are source-specific", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);

    const created = (await json(
      await fetch(`${server.url}/api/draft-specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceType: "prompt",
          prompt: "Add repository import from a pasted GitHub URL.",
          title: "Repository import",
        }),
      }),
    )) as { task: { id: string; specStatus?: string } };
    expect(created.task.specStatus).toBe("draft");

    const response = await fetch(
      `${server.url}/api/tasks/${created.task.id}/approve-spec`,
      { method: "POST" },
    );

    expect(response.status).toBe(400);
    const body = (await json(response)) as { error?: { message?: string } };
    expect(body.error?.message).toContain(
      "source-specific requirements are required before approving this generated spec",
    );
    expect(body.error?.message).toContain("FR-001");
  });

  it("returns source-specific spec approval diagnostics before approval", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);

    const created = (await json(
      await fetch(`${server.url}/api/draft-specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceType: "prompt",
          prompt: "Add repository import from a pasted GitHub URL.",
          title: "Repository import",
        }),
      }),
    )) as { task: { id: string; specStatus?: string } };

    const response = await fetch(`${server.url}/api/tasks/${created.task.id}`);

    expect(response.status).toBe(200);
    const detail = (await json(response)) as {
      task?: { specStatus?: string };
      specApprovalReadiness?: {
        ready?: boolean;
        summary?: string;
        hint?: string;
        issues?: Array<{
          code?: string;
          id?: string;
          line?: number;
          message?: string;
          remediation?: string;
        }>;
      };
    };
    expect(detail.task?.specStatus).toBe("draft");
    expect(detail.specApprovalReadiness).toMatchObject({
      ready: false,
      summary: "source-specific requirements are required before approval",
      hint: expect.stringContaining("Replace generated FR/SC placeholders"),
    });
    expect(detail.specApprovalReadiness?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "generic-functional-requirement",
          id: "FR-001",
          line: expect.any(Number),
          remediation: expect.stringContaining("source-specific behavior"),
        }),
        expect.objectContaining({
          code: "generic-success-criterion",
          id: "SC-001",
          line: expect.any(Number),
          remediation: expect.stringContaining("verification check"),
        }),
        expect.objectContaining({
          code: "default-open-question",
          line: expect.any(Number),
          remediation: expect.stringContaining("open question"),
        }),
      ]),
    );
  });

  it("replaces a generated draft spec through the API with revision provenance", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const created = (await json(
      await fetch(`${server.url}/api/draft-specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceType: "prompt",
          title: "Replaceable planning",
          prompt: "Add a source-specific planning refinement action.",
        }),
      }),
    )) as { task: { id: string } };
    const replacement = refinedSourceSpecificSpec("Replaceable planning");

    const response = await fetch(
      `${server.url}/api/tasks/${encodeURIComponent(created.task.id)}/replace-spec`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spec: replacement }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await json(response)) as {
      task: {
        status: string;
        specStatus?: string;
        techDesignStatus?: string;
        planningArtifacts?: {
          spec?: {
            currentVersionId: string;
            revisions: Array<{
              versionId: string;
              contentPath: string;
              producer: string;
              parentVersionId?: string;
              approvalState: string;
            }>;
          };
        };
      };
      spec: string;
    };
    expect(body.spec).toBe(replacement);
    expect(body.task).toMatchObject({
      status: "draft",
      specStatus: "draft",
      techDesignStatus: "draft",
      planningArtifacts: {
        spec: {
          currentVersionId: "spec-r2",
          revisions: [
            { versionId: "spec-r1", producer: "web-task-create" },
            {
              versionId: "spec-r2",
              producer: "web-spec-replacement",
              parentVersionId: "spec-r1",
              approvalState: "draft",
            },
          ],
        },
      },
    });
    await expect(readFile(join(repoPath, body.task.planningArtifacts!.spec!.revisions[1]!.contentPath), "utf8")).resolves.toBe(
      replacement,
    );

    const approved = await fetch(
      `${server.url}/api/tasks/${encodeURIComponent(created.task.id)}/approve-spec`,
      { method: "POST" },
    );
    expect(approved.status).toBe(200);
    const rejected = await fetch(
      `${server.url}/api/tasks/${encodeURIComponent(created.task.id)}/replace-spec`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spec: replacement }),
      },
    );
    await expectWebInputError(rejected, "only a draft spec can be replaced");
  });

  it("creates a draft spec task from GitHub issue intake", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, undefined, undefined, {
      githubIssueFetcher: async (reference) => {
        expect(reference).toMatchObject({
          owner: "Instask",
          repo: "nitely",
          number: 111,
        });
        return {
          title: "Generate draft specs",
          body: "Convert messy intake into a structured draft spec.",
          url: reference.url,
        };
      },
    });

    const response = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "github-issue",
        issue: "https://github.com/Instask/nitely/issues/111",
        guidance:
          "Focus on the smallest pilot-ready slice and call out any product risks before implementation.",
      }),
    });

    expect(response.status).toBe(201);
    const created = (await json(response)) as {
      task: {
        title: string;
        status: string;
        issueUrl?: string;
        source?: { type: string; uri?: string; title?: string };
        planningNotes?: { guidance?: string };
      };
      spec: string;
    };
    expect(created.task).toMatchObject({
      title: "Generate draft specs",
      status: "draft",
      issueUrl: "https://github.com/Instask/nitely/issues/111",
      source: {
        type: "github-issue",
        uri: "https://github.com/Instask/nitely/issues/111",
        title: "Generate draft specs",
      },
      planningNotes: {
        guidance:
          "Focus on the smallest pilot-ready slice and call out any product risks before implementation.",
      },
    });
    expect(created.spec).toContain("Source: github-issue https://github.com/Instask/nitely/issues/111");
    expect(created.spec).toContain("## Planning Guidance");
    expect(created.spec).toContain(
      "Focus on the smallest pilot-ready slice and call out any product risks before implementation.",
    );
  });

  it("mirrors GitHub-source inbox items when source status sync is enabled", async () => {
    const repoPath = await createRepo();
    const comments: RepositoryIssueComment[] = [];
    const notificationProvider: ScmProvider = {
      type: "github",
      publishChange: async () => {
        throw new Error("not used by notification delivery");
      },
      listRepositoryIssueComments: async () => [...comments],
      createRepositoryIssueComment: async (input) => {
        const comment: RepositoryIssueComment = {
          provider: "github",
          id: `comment-${comments.length + 1}`,
          url: `https://github.com/Instask/nitely/issues/112#issuecomment-${comments.length + 1}`,
          body: input.body,
          authorLogin: "nitely-bot",
          createdAt: "2026-07-14T04:30:00.000Z",
        };
        comments.push(comment);
        return comment;
      },
      updateRepositoryIssueComment: async (input) => {
        const existing = comments.find((comment) => comment.id === input.commentId);
        if (!existing) throw new Error("comment not found");
        existing.body = input.body;
        return existing;
      },
    };
    const server = await startTestServer(repoPath, undefined, undefined, {
      githubIssueFetcher: async (reference) => ({
        title: "Mirror planning status",
        body: "Keep the source issue linked to review work.",
        url: reference.url,
      }),
      notificationScmProvider: notificationProvider,
    });
    const requestBody = {
      sourceType: "github-issue",
      issue: "https://github.com/Instask/nitely/issues/112",
      syncStatus: true,
      publicBaseUrl: "https://nitely.example.test",
    };

    const first = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    expect(first.status).toBe(201);
    const firstBody = (await json(first)) as {
      task: { source?: { statusSync?: { enabled?: boolean } } };
    };
    expect(firstBody.task.source?.statusSync?.enabled).toBe(true);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("nitely-notification:");
    expect(comments[0]?.body).toContain("https://nitely.example.test/tasks/");

    const second = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    expect(second.status).toBe(200);
    expect(comments).toHaveLength(1);
  });

  it("mirrors a GitHub-source PR review item to the pull request", async () => {
    const repoPath = await createRepo();
    const mirroredIssueNumbers: number[] = [];
    const notificationProvider: ScmProvider = {
      type: "github",
      publishChange: async () => {
        throw new Error("not used by notification delivery");
      },
      listRepositoryIssueComments: async () => [],
      createRepositoryIssueComment: async (input) => {
        mirroredIssueNumbers.push(input.issueNumber);
        return {
          provider: "github",
          id: "pull-review-comment-1",
          url: `https://github.com/acme/widgets/pull/${input.issueNumber}#issuecomment-1`,
          body: input.body,
          authorLogin: "nitely-bot",
          createdAt: "2026-07-14T04:35:00.000Z",
        };
      },
      updateRepositoryIssueComment: async () => {
        throw new Error("not used by notification delivery");
      },
    };
    const task = await createTask(
      repoPath,
      {
        title: "Mirror pull request review",
        spec: refinedSourceSpecificSpec("Mirror pull request review"),
        techDesign: "Design body",
        issueUrl: "https://github.com/acme/widgets/issues/112",
      },
      {
        source: {
          type: "github-issue",
          uri: "https://github.com/acme/widgets/issues/112",
          statusSync: {
            enabled: true,
            publicBaseUrl: "https://nitely.example.test",
          },
        },
      },
    );
    const server = await startTestServer(
      repoPath,
      async () => ({
        runId: "run-github-pr-mirror",
        branchName: "nitely/run-github-pr-mirror",
        worktreePath: join(
          repoPath,
          ".nitely/runs/run-github-pr-mirror/worktree",
        ),
        changeRequestUrl: "https://github.com/acme/widgets/pull/42",
      }),
      undefined,
      {
        notificationScmProvider: notificationProvider,
        providerEnv: {},
        createRunId: () => "run-github-pr-mirror",
      },
    );

    const response = await fetch(
      `${server.url}/api/tasks/${encodeURIComponent(task.id)}/runs`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    await waitFor(
      async () => [...mirroredIssueNumbers],
      (numbers) => numbers.length > 0,
    );
    expect(mirroredIssueNumbers).toEqual([42]);
  });

  it("approves a GitHub issue draft spec artifact before drafting technical design", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, undefined, undefined, {
      githubIssueFetcher: async (reference) => ({
        title: "Generated spec approval drift",
        body: "Keep task approval state and persisted spec markdown status in sync.",
        url: reference.url,
      }),
    });

    const created = (await json(
      await fetch(`${server.url}/api/draft-specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceType: "github-issue",
          issue: "https://github.com/Instask/nitely/issues/291",
        }),
      }),
    )) as { task: { id: string; specPath: string; specStatus?: string } };
    expect(created.task.specStatus).toBe("draft");

    await writeRefinedSourceSpecificSpec(
      repoPath,
      created.task,
      "Generated spec approval drift",
    );
    const approvedResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/approve-spec`,
      { method: "POST" },
    );

    expect(approvedResponse.status).toBe(200);
    const approved = (await json(approvedResponse)) as {
      task: { specStatus?: string };
    };
    expect(approved.task.specStatus).toBe("approved");
    const persistedSpec = await readFile(join(repoPath, created.task.specPath), "utf8");
    expect(validateStructuredSpec(persistedSpec).status).toBe("approved");

    const designResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/draft-tech-design`,
      { method: "POST" },
    );
    expect(designResponse.status).toBe(200);
    const design = (await json(designResponse)) as {
      task: { techDesignStatus?: string };
      techDesign: string;
    };
    expect(design.task.techDesignStatus).toBe("draft");
    expect(design.techDesign).toContain("Status: draft");
  });

  it("creates a draft spec task from GitHub issue intake using configured GitHub provider credentials", async () => {
    const repoPath = await createRepo();
    const providerStore: ProviderConnectionStore = {
      getConnection: async (providerId) => ({
        providerId,
        getAccessToken: async () => "stored-web-github-token",
      }),
      resolveEnv: async () => ({}),
      listStatuses: async () => [],
    };
    const server = await startTestServer(repoPath, undefined, providerStore);
    const realFetch = globalThis.fetch;
    const githubFetches: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
        const requestUrl =
          typeof request === "string"
            ? request
            : request instanceof URL
              ? request.toString()
              : request.url;
        if (requestUrl.startsWith(server.url)) {
          return realFetch(request, init);
        }
        githubFetches.push({ url: requestUrl, init });
        expect(init?.headers).toMatchObject({
          authorization: "Bearer stored-web-github-token",
        });
        if (requestUrl.endsWith("/comments")) {
          return new Response(
            JSON.stringify([{ body: "Include comments in the source snapshot." }]),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            title: "Credential-backed intake",
            body: "Use configured Web credentials for private issue intake.",
            html_url: "https://github.com/Instask/nitely/issues/290",
            state: "open",
            comments_url:
              "https://api.github.com/repos/Instask/nitely/issues/290/comments",
          }),
          { status: 200 },
        );
      }),
    );

    const response = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "github-issue",
        issue: "https://github.com/Instask/nitely/issues/290",
      }),
    });

    expect(response.status).toBe(201);
    const created = (await json(response)) as {
      task: {
        source?: {
          snapshot?: { comments?: Array<{ body?: string }> };
        };
      };
    };
    expect(created.task.source?.snapshot?.comments).toEqual([
      { body: "Include comments in the source snapshot." },
    ]);
    expect(githubFetches).toHaveLength(2);
    expect(githubFetches[0]?.init).toMatchObject({
      headers: {
        authorization: "Bearer stored-web-github-token",
      },
    });
    expect(githubFetches[1]?.init).toMatchObject({
      headers: {
        authorization: "Bearer stored-web-github-token",
      },
    });
  });

  it("reuses an existing GitHub issue planning task and keeps the source snapshot", async () => {
    const repoPath = await createRepo();
    let fetchCount = 0;
    const server = await startTestServer(repoPath, undefined, undefined, {
      githubIssueFetcher: async (reference) => {
        fetchCount += 1;
        return {
          title: "Import GitHub issues",
          body: "Create one planning task per source issue.",
          url: reference.url,
          state: "open",
          updatedAt: "2026-06-27T10:00:00Z",
          labels: ["priority:P0", "enhancement"],
          comments: [
            {
              author: "jerry",
              body: "Please keep this linked to the original issue.",
              createdAt: "2026-06-27T10:01:00Z",
            },
          ],
        };
      },
    });
    const request = {
      sourceType: "github-issue",
      issue: "https://github.com/Instask/nitely/issues/227",
    };

    const firstResponse = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(firstResponse.status).toBe(201);
    const first = (await json(firstResponse)) as {
      task: { id: string; source?: { snapshot?: unknown } };
    };
    const taskRecordPath = join(
      repoPath,
      ".nitely",
      "tasks",
      first.task.id,
      "task.json",
    );
    const legacyTask = JSON.parse(await readFile(taskRecordPath, "utf8")) as {
      source?: {
        externalId?: string;
        snapshot?: { externalId?: string };
      };
    };
    delete legacyTask.source?.externalId;
    delete legacyTask.source?.snapshot?.externalId;
    await writeFile(taskRecordPath, JSON.stringify(legacyTask, null, 2), "utf8");

    const secondResponse = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });

    expect(secondResponse.status).toBe(200);
    const second = (await json(secondResponse)) as {
      task: {
        id: string;
        source?: {
          snapshot?: {
            title?: string;
            body?: string;
            state?: string;
            externalId?: string;
            labels?: string[];
            comments?: Array<{ author?: string; body?: string }>;
          };
          drift?: { status?: string; changedFields?: string[] };
        };
      };
      ingestion?: { created?: boolean; reused?: boolean; driftStatus?: string };
    };
    expect(second.task.id).toBe(first.task.id);
    expect(second.ingestion).toMatchObject({
      created: false,
      reused: true,
      driftStatus: "unchanged",
    });
    expect(second.task.source?.snapshot).toMatchObject({
      title: "Import GitHub issues",
      body: "Create one planning task per source issue.",
      state: "open",
      externalId: "Instask/nitely#227",
      labels: ["priority:P0", "enhancement"],
      comments: [
        {
          author: "jerry",
          body: "Please keep this linked to the original issue.",
        },
      ],
    });
    expect(second.task.source?.drift).toMatchObject({
      status: "unchanged",
      changedFields: [],
    });
    expect(fetchCount).toBe(2);

    const listResponse = await fetch(`${server.url}/api/tasks`);
    const list = (await json(listResponse)) as { tasks: Array<{ id: string }> };
    expect(list.tasks.filter((task) => task.id === first.task.id)).toHaveLength(1);
    expect(list.tasks).toHaveLength(1);
  });

  it("does not let another organization re-ingest and mutate an existing issue task", async () => {
    const repoPath = await createRepo();
    const owner = await createUser(repoPath, {
      email: "issue-owner@example.test",
      password: "issue owner password passphrase",
      role: "user",
    });
    const outsider = await createUser(repoPath, {
      email: "issue-outsider@example.test",
      password: "issue outsider password passphrase",
      role: "user",
    });
    const [ownerTeam] = await listPublicMemberships(repoPath, owner.id);
    const [outsiderTeam] = await listPublicMemberships(repoPath, outsider.id);
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      providerEnv: {},
      githubIssueFetcher: async (reference) => ({
        title: "Organization-scoped issue",
        body: "Only the owning organization can refresh this source.",
        url: reference.url,
        state: "open",
        updatedAt: "2026-07-14T00:00:00Z",
      }),
    });
    const ownerLogin = await login(
      server,
      "issue-owner@example.test",
      "issue owner password passphrase",
    );
    const outsiderLogin = await login(
      server,
      "issue-outsider@example.test",
      "issue outsider password passphrase",
    );
    const request = {
      sourceType: "github-issue",
      issue: "https://github.com/Instask/nitely/issues/277",
    };

    const created = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: ownerLogin.cookie,
        "x-nitely-organization-id": ownerTeam.organizationId,
      },
      body: JSON.stringify(request),
    });
    expect(created.status).toBe(201);

    const denied = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: outsiderLogin.cookie,
        "x-nitely-organization-id": outsiderTeam.organizationId,
      },
      body: JSON.stringify(request),
    });
    expect(denied.status).toBe(404);
    await expect(json(denied)).resolves.toEqual({
      error: { code: "not_found", message: "task not found" },
    });
  });

  it("marks drift on a re-ingested GitHub issue when the source changed", async () => {
    const repoPath = await createRepo();
    let body = "Original source issue body.";
    const server = await startTestServer(repoPath, undefined, undefined, {
      githubIssueFetcher: async (reference) => ({
        title: "Issue drift",
        body,
        url: reference.url,
        state: "open",
        updatedAt:
          body === "Original source issue body."
            ? "2026-06-27T10:00:00Z"
            : "2026-06-27T11:00:00Z",
      }),
    });
    const request = {
      sourceType: "github-issue",
      issue: "https://github.com/Instask/nitely/issues/227",
    };

    const first = (await json(
      await fetch(`${server.url}/api/draft-specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      }),
    )) as { task: { id: string } };
    body = "Changed source issue body with new constraints.";
    const driftResponse = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });

    expect(driftResponse.status).toBe(200);
    const drifted = (await json(driftResponse)) as {
      task: {
        id: string;
        source?: {
          snapshot?: { body?: string };
          drift?: {
            status?: string;
            changedFields?: string[];
            latestSnapshot?: { body?: string; updatedAt?: string };
          };
        };
      };
      ingestion?: { created?: boolean; reused?: boolean; driftStatus?: string };
    };
    expect(drifted.task.id).toBe(first.task.id);
    expect(drifted.ingestion).toMatchObject({
      created: false,
      reused: true,
      driftStatus: "changed",
    });
    expect(drifted.task.source?.snapshot?.body).toBe("Original source issue body.");
    expect(drifted.task.source?.drift).toMatchObject({
      status: "changed",
      changedFields: ["body", "updatedAt"],
      latestSnapshot: {
        body: "Changed source issue body with new constraints.",
        updatedAt: "2026-06-27T11:00:00Z",
      },
    });
  });

  it("creates a governed draft task from external document intake with hashed source provenance", async () => {
    const repoPath = await createRepo();
    let runStarted = false;
    const server = await startTestServer(repoPath, async () => {
      runStarted = true;
      throw new Error("draft tasks must not start");
    });

    const response = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "external-document",
        documentUrl: "https://example.feishu.cn/docx/ABC123?token=should-not-persist",
        documentVersion: "rev-42",
        title: "Nightly release policy",
        text: "Every release must publish a draft PR that links back to run evidence.",
      }),
    });

    expect(response.status).toBe(201);
    const created = (await json(response)) as {
      task: {
        id: string;
        status: string;
        specStatus?: string;
        techDesignStatus?: string;
        specPath: string;
        source?: {
          type?: string;
          uri?: string;
          externalId?: string;
          version?: string;
          snapshot?: TaskSourceSnapshot;
          drift?: { status?: string };
        };
      };
      spec: string;
    };
    expect(created.task).toMatchObject({
      status: "draft",
      specStatus: "draft",
      source: {
        type: "external-document",
        uri: "https://example.feishu.cn/docx/ABC123",
        externalId: "example.feishu.cn/docx/ABC123",
        version: "rev-42",
        drift: { status: "unchanged" },
      },
    });
    // A technical design is generated from the approved spec, so intake leaves
    // the design unstated rather than pre-approving a placeholder.
    expect(created.task.techDesignStatus).toBeUndefined();
    const snapshot = created.task.source?.snapshot;
    expect(snapshot?.body).toBe(
      "Every release must publish a draft PR that links back to run evidence.",
    );
    expect(snapshot?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot?.contentHash).toBe(
      sourceSnapshotContentHash(snapshot as TaskSourceSnapshot),
    );
    expect(JSON.stringify(created.task.source)).not.toContain("should-not-persist");
    expect(created.spec).toContain("Status: draft");
    expect(created.spec).toContain("https://example.feishu.cn/docx/ABC123");
    await expect(readFile(join(repoPath, created.task.specPath), "utf8")).resolves.toBe(
      created.spec,
    );

    const runResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/runs`,
      { method: "POST" },
    );
    await expectWebInputError(
      runResponse,
      "draft spec must be approved before starting a run",
    );
    expect(runStarted).toBe(false);
  });

  it("rejects external document intake that would lose provenance or store credentials", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);

    await expectWebInputError(
      await fetch(`${server.url}/api/draft-specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceType: "external-document",
          documentUrl: "https://docs.example.com/policy",
        }),
      }),
      "external document body is required so the snapshot can be reviewed and hashed",
    );
    await expectWebInputError(
      await fetch(`${server.url}/api/draft-specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceType: "external-document",
          documentUrl: "https://operator:hunter2@docs.example.com/policy",
          text: "Body",
        }),
      }),
      "external document url must not embed credentials",
    );
    await expectWebInputError(
      await fetch(`${server.url}/api/draft-specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceType: "prompt",
          prompt: "Add repository import.",
          documentUrl: "https://docs.example.com/policy",
        }),
      }),
      "documentUrl is only supported for external-document intake",
    );
  });

  it("blocks an approved planning baseline when its external document changes and refreshes on request", async () => {
    const repoPath = await createRepo();
    let runStarted = false;
    const server = await startTestServer(repoPath, async () => {
      runStarted = true;
      throw new Error("drifted sources must not start runs");
    });
    const intake = {
      sourceType: "external-document",
      documentUrl: "https://docs.example.com/specs/nightly-release",
      title: "Nightly release policy",
      text: "Every release must publish a draft PR that links back to run evidence.",
    };

    const created = (await json(
      await fetch(`${server.url}/api/draft-specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(intake),
      }),
    )) as { task: { id: string; specPath: string } };
    await writeRefinedSourceSpecificSpec(
      repoPath,
      created.task,
      "Nightly release policy",
    );
    expect(
      (
        await fetch(`${server.url}/api/tasks/${created.task.id}/approve-spec`, {
          method: "POST",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(
          `${server.url}/api/tasks/${created.task.id}/draft-tech-design`,
          { method: "POST" },
        )
      ).status,
    ).toBe(200);
    const approvedDesign = (await json(
      await fetch(
        `${server.url}/api/tasks/${created.task.id}/approve-tech-design`,
        { method: "POST" },
      ),
    )) as { task: { status: string; techDesignStatus?: string } };
    expect(approvedDesign.task).toMatchObject({
      status: "ready",
      techDesignStatus: "approved",
    });

    const driftResponse = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...intake,
        text: "Every release must publish a draft PR and a rollback note.",
      }),
    });

    expect(driftResponse.status).toBe(200);
    const drifted = (await json(driftResponse)) as {
      task: {
        id: string;
        source?: {
          snapshot?: { body?: string; contentHash?: string };
          drift?: {
            status?: string;
            changedFields?: string[];
            latestSnapshot?: { body?: string; contentHash?: string };
          };
        };
      };
      ingestion?: { created?: boolean; reused?: boolean; driftStatus?: string };
    };
    expect(drifted.task.id).toBe(created.task.id);
    expect(drifted.ingestion).toMatchObject({
      created: false,
      reused: true,
      driftStatus: "changed",
    });
    expect(drifted.task.source?.snapshot?.body).toBe(
      "Every release must publish a draft PR that links back to run evidence.",
    );
    expect(drifted.task.source?.drift).toMatchObject({
      status: "changed",
      changedFields: ["body"],
    });
    expect(drifted.task.source?.drift?.latestSnapshot?.contentHash).not.toBe(
      drifted.task.source?.snapshot?.contentHash,
    );

    const blockedRun = await fetch(
      `${server.url}/api/tasks/${created.task.id}/runs`,
      { method: "POST" },
    );
    await expectWebInputError(
      blockedRun,
      "source issue changed since planning; refresh planning or start with override=true",
    );
    expect(runStarted).toBe(false);

    const refreshed = (await json(
      await fetch(
        `${server.url}/api/tasks/${created.task.id}/refresh-source-planning`,
        { method: "POST" },
      ),
    )) as {
      task: {
        status: string;
        specStatus?: string;
        techDesignStatus?: string;
        source?: {
          snapshot?: { body?: string };
          drift?: { status?: string; changedFields?: string[] };
        };
      };
      spec: string;
    };
    expect(refreshed.task).toMatchObject({
      status: "draft",
      specStatus: "draft",
      techDesignStatus: "draft",
      source: {
        snapshot: {
          body: "Every release must publish a draft PR and a rollback note.",
        },
        drift: { status: "unchanged", changedFields: [] },
      },
    });
    expect(refreshed.spec).toContain("rollback note");
  });

  it("persists conversation intake turns on the task for auditability", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);

    const response = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "prompt",
        title: "Repository import",
        conversation: [
          { role: "operator", text: "Operators should paste a GitHub URL to import." },
          { role: "agent", text: "Which providers does the first slice cover?" },
          { role: "operator", text: "GitHub only, and reject duplicate URLs." },
        ],
      }),
    });

    expect(response.status).toBe(201);
    const created = (await json(response)) as {
      task: {
        id: string;
        status: string;
        specStatus?: string;
        source?: {
          type?: string;
          conversation?: {
            summary?: string;
            recordedAt?: string;
            turns?: Array<{ role: string; text: string }>;
          };
        };
      };
      spec: string;
    };
    expect(created.task).toMatchObject({
      status: "draft",
      specStatus: "draft",
      source: { type: "prompt" },
    });
    expect(created.task.source?.conversation?.turns).toEqual([
      { role: "operator", text: "Operators should paste a GitHub URL to import." },
      { role: "agent", text: "Which providers does the first slice cover?" },
      { role: "operator", text: "GitHub only, and reject duplicate URLs." },
    ]);
    expect(created.task.source?.conversation?.summary).toBe(
      "Operators should paste a GitHub URL to import.\n\nGitHub only, and reject duplicate URLs.",
    );
    expect(created.task.source?.conversation?.recordedAt).toBeTruthy();
    expect(created.spec).toContain("## Conversation Intake");
    expect(created.spec).toContain("Which providers does the first slice cover?");

    const stored = await getTask(repoPath, created.task.id);
    expect(stored.source?.conversation?.turns).toHaveLength(3);
  });

  it("rejects conversation intake that cannot be audited or attached to a source", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);

    await expectWebInputError(
      await fetch(`${server.url}/api/draft-specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceType: "prompt",
          conversation: [{ role: "operator", text: "" }],
        }),
      }),
      "conversation turn 1 text is required",
    );
    await expectWebInputError(
      await fetch(`${server.url}/api/draft-specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceType: "prompt",
          conversation: [{ role: "agent", text: "Planner-only transcript." }],
        }),
      }),
      "conversation intake requires at least one operator turn or an explicit prompt",
    );
    await expectWebInputError(
      await fetch(`${server.url}/api/draft-specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceType: "github-issue",
          issue: "https://github.com/Instask/nitely/issues/227",
          conversation: [{ role: "operator", text: "Ticket plus transcript." }],
        }),
      }),
      "conversation is only supported for prompt or text intake",
    );
  });

  it("reports GitHub issue fetch permission errors during draft spec intake", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, undefined, undefined, {
      githubIssueFetcher: async () => {
        throw new Error("GitHub issue fetch failed with 403");
      },
    });

    const response = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "github-issue",
        issue: "https://github.com/Instask/nitely/issues/227",
      }),
    });

    await expectWebInputError(response, "GitHub issue fetch failed with 403");
  });

  it("distinguishes restricted GitHub issue fetch guidance from malformed issue URLs", async () => {
    const repoPath = await createRepo();
    const providerStore: ProviderConnectionStore = {
      getConnection: async () => {
        throw new MissingConnectionError("github", "missing test credentials");
      },
      resolveEnv: async () => ({}),
      listStatuses: async () => [],
    };
    const server = await startTestServer(repoPath, undefined, providerStore);
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
        const requestUrl =
          typeof request === "string"
            ? request
            : request instanceof URL
              ? request.toString()
              : request.url;
        if (requestUrl.startsWith(server.url)) {
          return realFetch(request, init);
        }
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
        });
      }),
    );

    const restrictedResponse = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "github-issue",
        issue: "https://github.com/Instask/nitely/issues/292",
      }),
    });
    const malformedResponse = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "github-issue",
        issue: "not-a-github-issue",
      }),
    });

    await expectWebInputError(
      restrictedResponse,
      "GitHub issue could not be fetched. It may be private or restricted; configure GitHub credentials with NITELY_GITHUB_TOKEN, GITHUB_TOKEN, or the Web Console GitHub provider connection.",
    );
    await expectWebInputError(
      malformedResponse,
      "GitHub issue reference must be an issue number or URL",
    );
  });

  it("rejects a closed GitHub issue when creating a new planning task", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, undefined, undefined, {
      githubIssueFetcher: async (reference) => ({
        title: "Closed issue",
        body: "This issue should not start new planning.",
        url: reference.url,
        state: "closed",
        updatedAt: "2026-06-27T12:00:00Z",
      }),
    });

    const response = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "github-issue",
        issue: "https://github.com/Instask/nitely/issues/999",
      }),
    });

    await expectWebInputError(response, "GitHub issue is closed");
    const listResponse = await fetch(`${server.url}/api/tasks`);
    const list = (await json(listResponse)) as { tasks: unknown[] };
    expect(list.tasks).toHaveLength(0);
  });

  it("approves planner drafts before allowing implementation runs", async () => {
    const repoPath = await createRepo();
    let runStarted = false;
    const server = await startTestServer(repoPath, async () => {
      runStarted = true;
      return {
        runId: "run-planner-approved",
        branchName: "nitely/run-planner-approved",
        worktreePath: join(repoPath, ".nitely/runs/run-planner-approved/worktree"),
        completedStages: ["implement"],
      };
    });

    const created = (await json(
      await fetch(`${server.url}/api/draft-specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceType: "prompt",
          prompt: "Add a planner approval workflow to the Web Console.",
          title: "Planner approval workflow",
        }),
      }),
    )) as {
      task: { id: string; specPath: string; status: string; specStatus?: string };
    };

    await writeRefinedSourceSpecificSpec(
      repoPath,
      created.task,
      "Planner approval workflow",
    );
    const approvedSpecResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/approve-spec`,
      { method: "POST" },
    );
    expect(approvedSpecResponse.status).toBe(200);
    const approvedSpec = (await json(approvedSpecResponse)) as {
      task: { status: string; specStatus?: string };
    };
    expect(approvedSpec.task).toMatchObject({
      status: "draft",
      specStatus: "approved",
    });

    const blockedBeforeDraftResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/runs`,
      { method: "POST" },
    );
    await expectWebInputError(
      blockedBeforeDraftResponse,
      "draft technical design is required before starting a run",
    );
    expect(runStarted).toBe(false);

    const draftDesignResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/draft-tech-design`,
      { method: "POST" },
    );
    expect(draftDesignResponse.status).toBe(200);
    const draftDesign = (await json(draftDesignResponse)) as {
      task: {
        status: string;
        techDesignStatus?: string;
        planningNotes?: { openQuestions?: string[] };
      };
      openQuestions: string[];
    };
    expect(draftDesign.task.status).toBe("draft");
    expect(draftDesign.task.techDesignStatus).toBe("draft");
    expect(draftDesign.openQuestions.length).toBeGreaterThan(0);
    expect(draftDesign.task.planningNotes?.openQuestions).toEqual(
      draftDesign.openQuestions,
    );

    const blockedRunResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/runs`,
      { method: "POST" },
    );
    await expectWebInputError(
      blockedRunResponse,
      "draft technical design must be approved before starting a run",
    );
    expect(runStarted).toBe(false);

    const approvedDesignResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/approve-tech-design`,
      { method: "POST" },
    );
    expect(approvedDesignResponse.status).toBe(200);
    const approvedDesign = (await json(approvedDesignResponse)) as {
      task: {
        status: string;
        techDesignStatus?: string;
        planningNotes?: { openQuestions?: string[] };
      };
    };
    expect(approvedDesign.task).toMatchObject({
      status: "ready",
      techDesignStatus: "approved",
    });
    expect(approvedDesign.task.planningNotes?.openQuestions).toEqual(
      draftDesign.openQuestions,
    );

    const runResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/runs`,
      { method: "POST" },
    );
    expect(runResponse.status).toBe(200);
    expect(runStarted).toBe(true);
  });

  it("rejects technical design approval until a draft design has been generated", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const created = (await json(
      await fetch(`${server.url}/api/draft-specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceType: "prompt",
          prompt: "Add a planner approval workflow to the Web Console.",
        }),
      }),
    )) as { task: { id: string; specPath: string } };

    const blockedBeforeSpecApproval = await fetch(
      `${server.url}/api/tasks/${created.task.id}/approve-tech-design`,
      { method: "POST" },
    );
    await expectWebInputError(
      blockedBeforeSpecApproval,
      "approved spec is required before approving a technical design",
    );

    await writeRefinedSourceSpecificSpec(
      repoPath,
      created.task,
      "Planner approval workflow",
    );
    await fetch(`${server.url}/api/tasks/${created.task.id}/approve-spec`, {
      method: "POST",
    });
    const blockedBeforeDraft = await fetch(
      `${server.url}/api/tasks/${created.task.id}/approve-tech-design`,
      { method: "POST" },
    );
    await expectWebInputError(
      blockedBeforeDraft,
      "draft technical design is required before approval",
    );
  });

  it("rejects implementation runs after spec approval until a technical design is drafted", async () => {
    const repoPath = await createRepo();
    let runStarted = false;
    const server = await startTestServer(repoPath, async () => {
      runStarted = true;
      throw new Error("runs must not start before a technical design draft");
    });
    const created = (await json(
      await fetch(`${server.url}/api/draft-specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceType: "prompt",
          prompt: "Add a planner approval workflow to the Web Console.",
        }),
      }),
    )) as { task: { id: string; specPath: string } };

    await writeRefinedSourceSpecificSpec(
      repoPath,
      created.task,
      "Planner approval workflow",
    );
    await fetch(`${server.url}/api/tasks/${created.task.id}/approve-spec`, {
      method: "POST",
    });

    const response = await fetch(
      `${server.url}/api/tasks/${created.task.id}/runs`,
      { method: "POST" },
    );

    await expectWebInputError(
      response,
      "draft technical design is required before starting a run",
    );
    expect(runStarted).toBe(false);
  });

  it("creates a draft technical design from an approved structured spec and blocks runs", async () => {
    const repoPath = await createRepo();
    await mkdir(join(repoPath, "src"), { recursive: true });
    await mkdir(join(repoPath, "test"), { recursive: true });
    await writeFile(
      join(repoPath, "package.json"),
      JSON.stringify({ scripts: { "test:run": "vitest run" } }),
      "utf8",
    );
    await writeFile(join(repoPath, "src/repositories.ts"), "", "utf8");
    await writeFile(join(repoPath, "test/repositories.test.ts"), "", "utf8");
    let runStarted = false;
    const server = await startTestServer(repoPath, async () => {
      runStarted = true;
      throw new Error("draft technical designs must not start");
    });
    const spec = `# Feature Spec

## Background
Problem.

## User Stories
- **US-001:** As an operator, I can import repositories.

## Acceptance Scenarios
- **US-001 / SC-001:** Import succeeds.

## Functional Requirements
- **FR-001:** Import repositories from URLs.

## Success Criteria
- **SC-001:** Import is verified by a test.

## Edge Cases
None.

## Assumptions
None.

## Out Of Scope
None.
`;
    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Approved spec task",
          spec,
          techDesign: "Technical design pending",
        }),
      }),
    )) as { task: { id: string; techDesignPath: string } };

    const response = await fetch(
      `${server.url}/api/tasks/${created.task.id}/draft-tech-design`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    const result = (await json(response)) as {
      task: { techDesignStatus?: string };
      techDesign: string;
      openQuestions: string[];
    };
    expect(result.task.techDesignStatus).toBe("draft");
    expect(result.techDesign).toContain("Status: draft");
    expect(result.techDesign).toContain("src/repositories.ts");
    expect(result.techDesign).toContain("pnpm test:run");
    await expect(
      readFile(join(repoPath, created.task.techDesignPath), "utf8"),
    ).resolves.toBe(result.techDesign);

    const runResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/runs`,
      { method: "POST" },
    );
    expect(runResponse.status).toBe(400);
    expect(runStarted).toBe(false);
  });

  it("rejects draft technical design generation from an unapproved draft spec", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const created = (await json(
      await fetch(`${server.url}/api/draft-specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceType: "prompt",
          prompt: "Add import support.",
        }),
      }),
    )) as { task: { id: string } };

    const response = await fetch(
      `${server.url}/api/tasks/${created.task.id}/draft-tech-design`,
      { method: "POST" },
    );

    expect(response.status).toBe(400);
    await expect(json(response)).resolves.toMatchObject({
      error: {
        message: "approved spec is required before drafting a technical design",
      },
    });
  });

  it("lists configured repositories and routes task creation and runs by repository", async () => {
    const defaultRepo = await createRepo();
    const docsRepo = await createRepo();
    let runInput: RunFlowInput | undefined;
    const server = await startTestServer(defaultRepo, async (input) => {
      runInput = input;
      return {
        runId: "run-docs",
        branchName: "nitely/run-docs",
        worktreePath: join(docsRepo, ".nitely/runs/run-docs/worktree"),
      };
    }, undefined, {
      repositories: [{ id: "docs", name: "Docs repo", path: docsRepo }],
    });

    await expect(json(await fetch(`${server.url}/api/repositories`))).resolves.toEqual({
      repositories: [
        expect.objectContaining({ id: "home", name: expect.any(String) }),
        expect.objectContaining({ id: "docs", name: "Docs repo" }),
      ],
    });

    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repoId: "docs",
          title: "Docs task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string; repoId?: string; repoName?: string; repoPath?: string } };

    expect(created.task).toMatchObject({
      title: "Docs task",
      repoId: "docs",
      repoName: "Docs repo",
    });
    await expect(readFile(join(docsRepo, ".nitely/tasks", created.task.id, "task.json"), "utf8"))
      .resolves.toContain('"repoId": "docs"');

    const list = (await json(await fetch(`${server.url}/api/tasks`))) as {
      tasks: Array<{ id: string; repoId?: string; repoName?: string; repoPath?: string }>;
    };
    expect(list.tasks.find((task) => task.id === created.task.id)).toMatchObject({
      repoId: "docs",
      repoName: "Docs repo",
    });

    await mkdir(join(docsRepo, ".nitely/runs/run-doc-history"), { recursive: true });
    await writeFile(
      join(docsRepo, ".nitely/runs/run-doc-history/run.json"),
      JSON.stringify({
        runId: "run-doc-history",
        status: "completed",
        flowName: "docs-flow",
        completedStages: [],
        inputs: {},
      }),
      "utf8",
    );
    await expect(json(await fetch(`${server.url}/api/runs`))).resolves.toMatchObject({
      runs: expect.arrayContaining([
        expect.objectContaining({
          runId: "run-doc-history",
          repoId: "docs",
          repoName: "Docs repo",
        }),
      ]),
    });
    await expect(
      json(await fetch(`${server.url}/api/runs/run-doc-history`)),
    ).resolves.toMatchObject({
      run: {
        runId: "run-doc-history",
        repoId: "docs",
        repoName: "Docs repo",
      },
    });

    const runResponse = await fetch(`${server.url}/api/tasks/${created.task.id}/runs`, {
      method: "POST",
    });
    expect(runResponse.status).toBe(200);
    expect(runInput).toMatchObject({
      repoId: "docs",
      repoPath: resolve(docsRepo),
      workItemId: created.task.id,
    });
    expect(runInput?.flowPath).toBe(join(resolve(docsRepo), "flows/implement-spec-bootstrap.json"));
  });

  it("runs a mocked golden path demo from the Web API and registers its isolated repository", async () => {
    const defaultRepo = await createRepo();
    let receivedOutputDir = "";
    let runCount = 0;
    const getChangeRequestStatus = vi.fn(async (target: string) => ({
      provider: "github" as const,
      url: target,
      state: "closed",
      merged: true,
    }));
    const server = await startTestServer(defaultRepo, undefined, undefined, {
      getChangeRequestStatus,
      runGoldenPathDemo: async ({ outputDir }) => {
        runCount += 1;
        receivedOutputDir = outputDir;
        const repoPath = join(outputDir, "fixture-repo");
        await mkdir(repoPath, { recursive: true });
        if (runCount === 1) {
          await mkdir(join(repoPath, ".nitely"), { recursive: true });
          const store = new EventStore(join(repoPath, ".nitely/events.db"));
          try {
            store.append({
              runId: "run-golden-implementation",
              type: "run.created",
              createdAt: "2026-06-23T10:00:00.000Z",
              payload: {
                flowName: "golden-path-implementation",
                branchName: "nitely/golden-path-implementation",
                inputs: {},
              },
            });
            store.append({
              runId: "run-golden-implementation",
              type: "run.completed",
              createdAt: "2026-06-23T10:01:00.000Z",
              payload: {
                changeRequestUrl: "https://github.com/Instask/nitely/pull/1",
              },
            });
          } finally {
            store.close();
          }
        }
        return {
          outputDir,
          repoPath,
          taskId: "golden-path-task",
          implementationRunId: "run-golden-implementation",
          implementationEvidencePath: join(
            repoPath,
            ".nitely/runs/run-golden-implementation/evidence.md",
          ),
          draftPullRequestUrl: "https://github.com/Instask/nitely/pull/1",
          reworkRunId: "run-golden-rework",
          reworkEvidencePath: join(repoPath, ".nitely/runs/run-golden-rework/evidence.md"),
          updatedPullRequestUrl: "https://github.com/Instask/nitely/pull/1",
          proof: {
            approvedPlanning: true,
            eligibleImplementationStart: true,
            verifiedImplementation: true,
            draftPullRequest: true,
            evidenceBacked: true,
            controlledSamePullRequestRework: true,
          },
        };
      },
    });

    const response = await fetch(`${server.url}/api/demo/golden-path`, {
      method: "POST",
    });

    expect(response.status).toBe(201);
    const body = (await json(response)) as {
      demo: {
        mocked: boolean;
        outputDir: string;
        taskId: string;
        taskRoute: string;
        implementationRunId: string;
        implementationRunRoute: string;
        implementationEvidenceRoute: string;
        reworkRunId: string;
        reworkRunRoute: string;
        reworkEvidenceRoute: string;
        proof: Record<string, boolean>;
        repository: {
          repoId: string;
          repoName: string;
          repoSynthetic?: boolean;
        };
      };
      repositories: Array<{
        id: string;
        name: string;
        synthetic?: boolean;
      }>;
    };
    const expectedOutputDir = join(
      resolve(defaultRepo),
      ".nitely",
      "demo",
      "golden-path",
    );
    expect(receivedOutputDir).toBe(expectedOutputDir);
    expect(body.demo).toMatchObject({
      mocked: true,
      outputDir: expectedOutputDir,
      taskId: "golden-path-task",
      taskRoute: "/tasks/golden-path-task",
      implementationRunId: "run-golden-implementation",
      implementationRunRoute: "/runs/run-golden-implementation",
      implementationEvidenceRoute: "/runs/run-golden-implementation#evidence",
      reworkRunId: "run-golden-rework",
      reworkRunRoute: "/runs/run-golden-rework",
      reworkEvidenceRoute: "/runs/run-golden-rework#evidence",
      proof: {
        approvedPlanning: true,
        eligibleImplementationStart: true,
        verifiedImplementation: true,
        draftPullRequest: true,
        evidenceBacked: true,
        controlledSamePullRequestRework: true,
      },
      repository: {
        repoId: "demo-golden-path",
        repoName: "Mocked golden path demo",
        repoSynthetic: true,
      },
    });
    expect(body.repositories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "demo-golden-path",
          name: "Mocked golden path demo",
          synthetic: true,
        }),
      ]),
    );

    const repositoriesPath = join(defaultRepo, ".nitely/repositories.json");
    const legacyRepositories = JSON.parse(
      await readFile(repositoriesPath, "utf8"),
    ) as { repositories: Array<{ id?: string; synthetic?: boolean }> };
    for (const repository of legacyRepositories.repositories) {
      if (repository.id === "demo-golden-path") delete repository.synthetic;
    }
    await writeFile(
      repositoriesPath,
      JSON.stringify(legacyRepositories, null, 2),
      "utf8",
    );

    const dashboard = (await json(await fetch(`${server.url}/api/dashboard`))) as {
      dashboard: {
        repositoryCount: number;
        runCount: number;
        pilotRoi: {
          reviewablePrsCreated: number;
          acceptedPrs: number;
          mergedPrs: number;
          estimatedCleanupMinutesAvoided: number;
        };
      };
    };
    expect(getChangeRequestStatus).not.toHaveBeenCalled();
    expect(dashboard.dashboard).toMatchObject({
      repositoryCount: 1,
      runCount: 0,
      pilotRoi: {
        reviewablePrsCreated: 0,
        acceptedPrs: 0,
        mergedPrs: 0,
        estimatedCleanupMinutesAvoided: 0,
      },
    });

    const secondResponse = await fetch(`${server.url}/api/demo/golden-path`, {
      method: "POST",
    });
    expect(secondResponse.status).toBe(201);
    const repositories = (await json(await fetch(`${server.url}/api/repositories`))) as {
      repositories: Array<{ id: string; synthetic?: boolean }>;
    };
    expect(repositories.repositories.filter((repo) => repo.id === "demo-golden-path"))
      .toEqual([expect.objectContaining({ synthetic: true })]);
    expect(runCount).toBe(2);
  });

  it("migrates legacy demo repositories through symlinked home paths", async () => {
    const realHome = await createRepo();
    const linkRoot = await mkdtemp(join(tmpdir(), "nitely-web-home-link-"));
    const linkedHome = join(linkRoot, "home");
    await symlink(realHome, linkedHome, "dir");
    const demoRepo = join(
      realHome,
      ".nitely",
      "demo",
      "golden-path",
      "fixture-repo",
    );
    await mkdir(join(demoRepo, ".nitely"), { recursive: true });
    const store = new EventStore(join(demoRepo, ".nitely/events.db"));
    try {
      store.append({
        runId: "run-legacy-demo",
        type: "run.created",
        payload: { flowName: "golden-path", inputs: {} },
      });
      store.append({
        runId: "run-legacy-demo",
        type: "run.completed",
        payload: {
          changeRequestUrl: "https://github.com/Instask/nitely/pull/1",
        },
      });
    } finally {
      store.close();
    }
    await writeFile(
      join(realHome, ".nitely/repositories.json"),
      JSON.stringify(
        {
          version: 1,
          repositories: [
            {
              id: "demo-golden-path",
              name: "Mocked golden path demo",
              path: demoRepo,
              defaultBranch: "master",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    const getChangeRequestStatus = vi.fn(async (target: string) => ({
      provider: "github" as const,
      url: target,
      state: "closed",
      merged: true,
    }));
    const server = await startTestServer(linkedHome, undefined, undefined, {
      getChangeRequestStatus,
    });

    expect((await fetch(`${server.url}/api/dashboard`)).status).toBe(200);
    expect(getChangeRequestStatus).not.toHaveBeenCalled();
    await expect(json(await fetch(`${server.url}/api/repositories`))).resolves
      .toEqual({
        repositories: expect.arrayContaining([
          expect.objectContaining({
            id: "demo-golden-path",
            synthetic: true,
          }),
        ]),
      });
    await expect(
      readFile(join(realHome, ".nitely/repositories.json"), "utf8"),
    ).resolves.toContain('"synthetic": true');
  });

  it("requires admin access before running the mocked golden path demo from the Web API", async () => {
    const repoPath = await createRepo();
    await createUser(repoPath, {
      email: "admin@example.test",
      password: "admin password passphrase",
      role: "admin",
    });
    await createUser(repoPath, {
      email: "user@example.test",
      password: "user password passphrase",
      role: "user",
    });
    let called = false;
    const server = await startTestServer(repoPath, undefined, undefined, {
      authMode: "required",
      providerEnv: {},
      runGoldenPathDemo: async ({ outputDir }) => {
        called = true;
        const repoPath = join(outputDir, "fixture-repo");
        await mkdir(repoPath, { recursive: true });
        return {
          outputDir,
          repoPath,
          taskId: "golden-path-task",
          implementationRunId: "run-golden-implementation",
          implementationEvidencePath: join(
            repoPath,
            ".nitely/runs/run-golden-implementation/evidence.md",
          ),
          draftPullRequestUrl: "https://github.com/Instask/nitely/pull/1",
          reworkRunId: "run-golden-rework",
          reworkEvidencePath: join(repoPath, ".nitely/runs/run-golden-rework/evidence.md"),
          updatedPullRequestUrl: "https://github.com/Instask/nitely/pull/1",
          proof: {
            approvedPlanning: true,
            eligibleImplementationStart: true,
            verifiedImplementation: true,
            draftPullRequest: true,
            evidenceBacked: true,
            controlledSamePullRequestRework: true,
          },
        };
      },
    });
    const user = await login(server, "user@example.test", "user password passphrase");

    const response = await fetch(`${server.url}/api/demo/golden-path`, {
      method: "POST",
      headers: { cookie: user.cookie },
    });

    expect(response.status).toBe(403);
    expect(called).toBe(false);
  });

  it("lists custom skills across configured repositories", async () => {
    const defaultRepo = await createRepo();
    const docsRepo = await createRepo();
    await mkdir(join(defaultRepo, ".nitely/skills/planner"), { recursive: true });
    await writeFile(
      join(defaultRepo, ".nitely/skills/planner/SKILL.md"),
      [
        "---",
        "name: planner",
        "description: Draft high quality implementation plans.",
        "---",
        "",
        "Use this before implementation planning.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(defaultRepo, ".nitely/skills/planner/example.md"),
      "example",
      "utf8",
    );
    await mkdir(join(docsRepo, ".nitely/skills/docs-review"), { recursive: true });
    await writeFile(
      join(docsRepo, ".nitely/skills/docs-review/SKILL.md"),
      [
        "---",
        "name: docs-review",
        "description: Review public documentation for release readiness.",
        "---",
        "",
        "Check examples and references.",
      ].join("\n"),
      "utf8",
    );
    const server = await startTestServer(defaultRepo, undefined, undefined, {
      repositories: [{ id: "docs", name: "Docs repo", path: docsRepo }],
    });

    await expect(json(await fetch(`${server.url}/api/skills`))).resolves.toEqual({
      skills: expect.arrayContaining([
        expect.objectContaining({
          id: "planner",
          repoId: "home",
          repoName: expect.any(String),
          sourcePath: ".nitely/skills/planner/SKILL.md",
          description: "Draft high quality implementation plans.",
          resourceCount: 1,
        }),
        expect.objectContaining({
          id: "docs-review",
          repoId: "docs",
          repoName: "Docs repo",
          sourcePath: ".nitely/skills/docs-review/SKILL.md",
          description: "Review public documentation for release readiness.",
          resourceCount: 0,
        }),
      ]),
    });
  });

  it("previews and imports local skills through the Web API", async () => {
    const repoPath = await createRepo();
    const sourceRoot = await mkdtemp(join(tmpdir(), "nitely-web-skill-source-"));
    const source = await writeLocalSkillSource(
      sourceRoot,
      "web-review",
      "Review Web Console changes before shipping.",
    );
    await mkdir(join(source, "docs"), { recursive: true });
    await writeFile(join(source, "docs", "checklist.md"), "Check the preview.\n", "utf8");
    const server = await startTestServer(repoPath);

    const previewResponse = await fetch(`${server.url}/api/skills/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "home", sourcePath: source }),
    });
    expect(previewResponse.status).toBe(200);
    const previewBody = await json(previewResponse) as {
      preview: {
        id: string;
        name: string;
        description: string;
        contentHash: string;
        resourceCount: number;
        repoId: string;
        repoName: string;
        targetPath: string;
        targetExists: boolean;
        overwriteRequired: boolean;
      };
    };
    expect(previewBody.preview).toMatchObject({
      id: "web-review",
      name: "web-review",
      description: "Review Web Console changes before shipping.",
      repoId: "home",
      repoName: expect.any(String),
      targetPath: ".nitely/skills/web-review",
      resourceCount: 1,
      targetExists: false,
      overwriteRequired: false,
    });
    expect(previewBody.preview.contentHash).toMatch(/^[a-f0-9]{64}$/);

    const importResponse = await fetch(`${server.url}/api/skills/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "home", sourcePath: source }),
    });
    expect(importResponse.status).toBe(201);
    await expect(json(importResponse)).resolves.toMatchObject({
      skill: {
        id: "web-review",
        repoId: "home",
        targetPath: ".nitely/skills/web-review",
        resourceCount: 1,
      },
      skills: expect.arrayContaining([
        expect.objectContaining({
          id: "web-review",
          sourcePath: ".nitely/skills/web-review/SKILL.md",
          resourceCount: 1,
        }),
      ]),
    });
    await expect(
      readFile(join(repoPath, ".nitely", "skills", "web-review", "docs", "checklist.md"), "utf8"),
    ).resolves.toBe("Check the preview.\n");

    const existingPreview = await fetch(`${server.url}/api/skills/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "home", sourcePath: source }),
    });
    await expect(json(existingPreview)).resolves.toMatchObject({
      preview: {
        id: "web-review",
        targetExists: true,
        overwriteRequired: true,
      },
    });
  });

  it("requires admin access before previewing or importing local skills", async () => {
    const repoPath = await createRepo();
    await createUser(repoPath, {
      email: "admin@example.test",
      password: "admin password passphrase",
      role: "admin",
    });
    await createUser(repoPath, {
      email: "user@example.test",
      password: "user password passphrase",
      role: "user",
    });
    const sourceRoot = await mkdtemp(join(tmpdir(), "nitely-web-skill-source-"));
    const source = await writeLocalSkillSource(sourceRoot, "restricted");
    const server = await startTestServer(
      repoPath,
      undefined,
      undefined,
      { authMode: "required", providerEnv: {} },
    );
    const admin = await login(server, "admin@example.test", "admin password passphrase");
    const user = await login(server, "user@example.test", "user password passphrase");

    const userPreview = await fetch(`${server.url}/api/skills/preview`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: user.cookie,
      },
      body: JSON.stringify({ sourcePath: source }),
    });
    expect(userPreview.status).toBe(403);

    const userImport = await fetch(`${server.url}/api/skills/import`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: user.cookie,
      },
      body: JSON.stringify({ sourcePath: source }),
    });
    expect(userImport.status).toBe(403);

    const adminPreview = await fetch(`${server.url}/api/skills/preview`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: admin.cookie,
      },
      body: JSON.stringify({ sourcePath: source }),
    });
    expect(adminPreview.status).toBe(200);
    await expect(json(adminPreview)).resolves.toMatchObject({
      preview: { id: "restricted" },
    });
  });

  it("persists repositories added through the Web API and routes tasks to them", async () => {
    const defaultRepo = await createRepo();
    const server = await startTestServer(defaultRepo, undefined, undefined, {
      cloneRepository: async ({ targetPath }) => {
        await mkdir(join(targetPath, "flows"), { recursive: true });
        await writeFile(
          join(targetPath, "flows/implement-spec-bootstrap.json"),
          "{}",
          "utf8",
        );
      },
    });

    const addResponse = await fetch(`${server.url}/api/repositories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "app",
        name: "App repo",
        githubUrl: "https://github.com/acme/app",
        defaultBranch: "main",
        // The HTTP layer must ignore synthetic: a client must not be able to register an arbitrary path.
        synthetic: true,
      }),
    });
    expect(addResponse.status).toBe(201);
    const added = (await json(addResponse)) as {
      repository: { synthetic?: boolean; organizationId?: string };
    };
    expect(added).toMatchObject({
      repository: {
        id: "app",
        name: "App repo",
        defaultBranch: "main",
        sourceUrl: "https://github.com/acme/app.git",
      },
    });
    expect(added.repository.synthetic).toBeUndefined();
    expect(added.repository.organizationId).toBeUndefined();
    const repositoriesFile = await readFile(
      join(defaultRepo, ".nitely", "repositories.json"),
      "utf8",
    );
    expect(repositoriesFile).toContain('"id": "app"');
    expect(repositoriesFile).not.toContain('"synthetic"');

    await expect(json(await fetch(`${server.url}/api/repositories`))).resolves.toEqual({
      repositories: [
        expect.objectContaining({ id: "home" }),
        expect.objectContaining({ id: "app", name: "App repo" }),
      ],
    });

    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repoId: "app",
          title: "App task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string; repoId?: string; repoName?: string; repoPath?: string } };
    expect(created.task).toMatchObject({
      repoId: "app",
      repoName: "App repo",
    });
    const appRepoPath = join(resolve(defaultRepo), ".nitely", "repositories", "app");
    await expect(
      readFile(join(appRepoPath, ".nitely", "tasks", created.task.id, "task.json"), "utf8"),
    ).resolves.toContain('"repoId": "app"');
  });

  it("scopes stored repositories to team workspaces and hides them from other organizations", async () => {
    const homeRepo = await createRepo();
    const teamAAppPath = join(
      resolve(homeRepo),
      ".nitely",
      "repositories",
      "team-a-app",
    );
    const teamBAppPath = join(
      resolve(homeRepo),
      ".nitely",
      "repositories",
      "team-b-app",
    );
    const ownerA = await createUser(homeRepo, {
      email: "repo-owner-a@example.test",
      password: "owner a password passphrase",
      role: "user",
    });
    const ownerB = await createUser(homeRepo, {
      email: "repo-owner-b@example.test",
      password: "owner b password passphrase",
      role: "user",
    });
    const memberA = await createUser(homeRepo, {
      email: "repo-member-a@example.test",
      password: "member a password passphrase",
      role: "user",
    });
    const viewerA = await createUser(homeRepo, {
      email: "repo-viewer-a@example.test",
      password: "viewer a password passphrase",
      role: "user",
    });
    const maintainerA = await createUser(homeRepo, {
      email: "repo-maintainer-a@example.test",
      password: "maintainer a password passphrase",
      role: "user",
    });
    const [orgA] = await listPublicMemberships(homeRepo, ownerA.id);
    const [orgB] = await listPublicMemberships(homeRepo, ownerB.id);
    await addOrganizationMember(homeRepo, orgA.organizationId, {
      userId: ownerA.id,
      role: "owner",
    });
    await addOrganizationMember(homeRepo, orgB.organizationId, {
      userId: ownerB.id,
      role: "owner",
    });
    await addOrganizationMember(homeRepo, orgA.organizationId, {
      userId: memberA.id,
      role: "member",
    });
    await addOrganizationMember(homeRepo, orgA.organizationId, {
      userId: viewerA.id,
      role: "viewer",
    });
    await addOrganizationMember(homeRepo, orgA.organizationId, {
      userId: maintainerA.id,
      role: "maintainer",
    });
    const server = await startTestServer(homeRepo, undefined, undefined, {
      authMode: "required",
      providerEnv: {},
      cloneRepository: async ({ targetPath }) => {
        await mkdir(join(targetPath, "flows"), { recursive: true });
        await writeFile(
          join(targetPath, "flows/implement-spec-bootstrap.json"),
          "{}",
          "utf8",
        );
      },
    });
    const loginA = await login(
      server,
      "repo-owner-a@example.test",
      "owner a password passphrase",
    );
    const loginB = await login(
      server,
      "repo-owner-b@example.test",
      "owner b password passphrase",
    );
    const memberLogin = await login(
      server,
      "repo-member-a@example.test",
      "member a password passphrase",
    );
    const viewerLogin = await login(
      server,
      "repo-viewer-a@example.test",
      "viewer a password passphrase",
    );
    const maintainerLogin = await login(
      server,
      "repo-maintainer-a@example.test",
      "maintainer a password passphrase",
    );
    const orgHeaders = (cookie: string, organizationId: string) => ({
      "content-type": "application/json",
      cookie,
      "x-nitely-organization-id": organizationId,
    });

    const addedA = await fetch(`${server.url}/api/repositories`, {
      method: "POST",
      headers: orgHeaders(loginA.cookie, orgA.organizationId),
      body: JSON.stringify({
        id: "team-a-app",
        name: "Team A App",
        githubUrl: "https://github.com/team-a/app",
        organizationId: orgB.organizationId,
      }),
    });
    expect(addedA.status).toBe(201);
    const createdA = (await json(addedA)) as {
      repository: { id: string; name: string; path: string; organizationId?: string };
    };
    expect(createdA.repository).toMatchObject({
      id: "team-a-app",
      name: "Team A App",
      organizationId: orgA.organizationId,
    });

    const addedB = await fetch(`${server.url}/api/repositories`, {
      method: "POST",
      headers: orgHeaders(loginB.cookie, orgB.organizationId),
      body: JSON.stringify({
        id: "team-b-app",
        name: "Team B App",
        githubUrl: "https://github.com/team-b/app",
      }),
    });
    expect(addedB.status).toBe(201);
    const createdB = (await json(addedB)) as {
      repository: { id: string; name: string; path: string; organizationId?: string };
    };
    expect(createdB.repository.organizationId).toBe(orgB.organizationId);

    const storedCatalog = JSON.parse(
      await readFile(join(homeRepo, ".nitely", "repositories.json"), "utf8"),
    ) as {
      repositories: Array<{ id: string; organizationId?: string; path: string }>;
    };
    expect(storedCatalog.repositories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "team-a-app",
          organizationId: orgA.organizationId,
          path: teamAAppPath,
        }),
        expect.objectContaining({
          id: "team-b-app",
          organizationId: orgB.organizationId,
          path: teamBAppPath,
        }),
      ]),
    );

    const listedA = (await json(
      await fetch(`${server.url}/api/repositories`, {
        headers: { cookie: loginA.cookie },
      }),
    )) as { repositories: Array<{ id: string; name: string; path: string }> };
    expect(listedA.repositories.map((repository) => repository.id).sort()).toEqual(
      ["home", "team-a-app"].sort(),
    );
    const listedAText = JSON.stringify(listedA);
    expect(listedAText).not.toContain("team-b-app");
    expect(listedAText).not.toContain("Team B App");
    expect(listedAText).not.toContain(teamBAppPath);

    const listedB = (await json(
      await fetch(`${server.url}/api/repositories`, {
        headers: { cookie: loginB.cookie },
      }),
    )) as { repositories: Array<{ id: string }> };
    expect(listedB.repositories.map((repository) => repository.id).sort()).toEqual(
      ["home", "team-b-app"].sort(),
    );
    expect(JSON.stringify(listedB)).not.toContain("team-a-app");
    expect(JSON.stringify(listedB)).not.toContain("Team A App");
    expect(JSON.stringify(listedB)).not.toContain(teamAAppPath);

    const crossTask = await fetch(`${server.url}/api/tasks`, {
      method: "POST",
      headers: orgHeaders(loginA.cookie, orgA.organizationId),
      body: JSON.stringify({
        repoId: "team-b-app",
        title: "Cross-team task",
        spec: "Spec body",
        techDesign: "Design body",
      }),
    });
    expect(crossTask.status).toBe(404);
    const crossTaskBody = await json(crossTask);
    expect(crossTaskBody).toEqual({
      error: { code: "not_found", message: "repository not found" },
    });
    expect(JSON.stringify(crossTaskBody)).not.toContain("Team B App");
    expect(JSON.stringify(crossTaskBody)).not.toContain(teamBAppPath);

    const crossRead = await fetch(
      `${server.url}/api/context-kg?repoId=team-b-app`,
      { headers: { cookie: loginA.cookie } },
    );
    expect(crossRead.status).toBe(404);
    const crossReadBody = await json(crossRead);
    expect(crossReadBody).toEqual({
      error: { code: "not_found", message: "repository not found" },
    });
    expect(JSON.stringify(crossReadBody)).not.toContain("Team B App");
    expect(JSON.stringify(crossReadBody)).not.toContain(teamBAppPath);

    const memberList = (await json(
      await fetch(`${server.url}/api/repositories`, {
        headers: { cookie: memberLogin.cookie },
      }),
    )) as { repositories: Array<{ id: string }> };
    expect(memberList.repositories.map((repository) => repository.id)).toEqual(
      expect.arrayContaining(["home", "team-a-app"]),
    );
    expect(JSON.stringify(memberList)).not.toContain("team-b-app");

    const memberCreate = await fetch(`${server.url}/api/repositories`, {
      method: "POST",
      headers: orgHeaders(memberLogin.cookie, orgA.organizationId),
      body: JSON.stringify({
        id: "team-a-member",
        name: "Member should not onboard",
        githubUrl: "https://github.com/team-a/member",
      }),
    });
    expect(memberCreate.status).toBe(403);
    await expect(json(memberCreate)).resolves.toEqual({
      error: {
        code: "forbidden",
        message: "repositories:manage permission required",
      },
    });

    const viewerCreate = await fetch(`${server.url}/api/repositories`, {
      method: "POST",
      headers: orgHeaders(viewerLogin.cookie, orgA.organizationId),
      body: JSON.stringify({
        id: "team-a-viewer",
        name: "Viewer should not onboard",
        githubUrl: "https://github.com/team-a/viewer",
      }),
    });
    expect(viewerCreate.status).toBe(403);
    await expect(json(viewerCreate)).resolves.toEqual({
      error: {
        code: "forbidden",
        message: "repositories:manage permission required",
      },
    });

    const maintainerCreate = await fetch(`${server.url}/api/repositories`, {
      method: "POST",
      headers: orgHeaders(maintainerLogin.cookie, orgA.organizationId),
      body: JSON.stringify({
        id: "team-a-docs",
        name: "Team A Docs",
        githubUrl: "https://github.com/team-a/docs",
      }),
    });
    expect(maintainerCreate.status).toBe(201);
    await expect(json(maintainerCreate)).resolves.toMatchObject({
      repository: {
        id: "team-a-docs",
        organizationId: orgA.organizationId,
      },
    });

    const createdTask = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: orgHeaders(loginA.cookie, orgA.organizationId),
        body: JSON.stringify({
          repoId: "team-a-app",
          title: "Team A task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string; organizationId?: string; repoId?: string } };
    expect(createdTask.task).toMatchObject({
      repoId: "team-a-app",
      organizationId: orgA.organizationId,
    });

    await addOrganizationMember(homeRepo, orgB.organizationId, {
      userId: ownerA.id,
      role: "member",
    });
    const mismatchedOrg = await fetch(`${server.url}/api/tasks`, {
      method: "POST",
      headers: orgHeaders(loginA.cookie, orgB.organizationId),
      body: JSON.stringify({
        repoId: "team-a-app",
        title: "Should not attach A-repo to B-task",
        spec: "Spec body",
        techDesign: "Design body",
      }),
    });
    expect(mismatchedOrg.status).toBe(404);
    const mismatchedBody = await json(mismatchedOrg);
    expect(mismatchedBody).toEqual({
      error: { code: "not_found", message: "repository not found" },
    });
    expect(JSON.stringify(mismatchedBody)).not.toContain("Team A App");
    expect(JSON.stringify(mismatchedBody)).not.toContain(teamAAppPath);
  });

  it("keeps legacy unowned stored repositories admin-only until assigned", async () => {
    const homeRepo = await createRepo();
    const legacyRepo = await createRepo();
    await mkdir(join(homeRepo, ".nitely"), { recursive: true });
    await writeFile(
      join(homeRepo, ".nitely", "repositories.json"),
      JSON.stringify(
        {
          version: 1,
          repositories: [
            {
              id: "legacy-unowned",
              name: "Legacy Unowned Catalog",
              path: legacyRepo,
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    await createUser(homeRepo, {
      email: "legacy-owner@example.test",
      password: "legacy owner password passphrase",
      role: "user",
    });
    await createUser(homeRepo, {
      email: "legacy-admin@example.test",
      password: "legacy admin password passphrase",
      role: "admin",
    });
    const server = await startTestServer(homeRepo, undefined, undefined, {
      authMode: "required",
      providerEnv: {},
    });
    const ownerLogin = await login(
      server,
      "legacy-owner@example.test",
      "legacy owner password passphrase",
    );
    const adminLogin = await login(
      server,
      "legacy-admin@example.test",
      "legacy admin password passphrase",
    );

    const ownerList = (await json(
      await fetch(`${server.url}/api/repositories`, {
        headers: { cookie: ownerLogin.cookie },
      }),
    )) as { repositories: Array<{ id: string }> };
    expect(ownerList.repositories.map((repository) => repository.id)).toEqual([
      "home",
    ]);
    expect(JSON.stringify(ownerList)).not.toContain("legacy-unowned");
    expect(JSON.stringify(ownerList)).not.toContain("Legacy Unowned Catalog");
    expect(JSON.stringify(ownerList)).not.toContain(resolve(legacyRepo));

    const adminList = (await json(
      await fetch(`${server.url}/api/repositories`, {
        headers: { cookie: adminLogin.cookie },
      }),
    )) as { repositories: Array<{ id: string; name: string }> };
    expect(adminList.repositories.map((repository) => repository.id)).toEqual(
      expect.arrayContaining(["home", "legacy-unowned"]),
    );
    expect(adminList.repositories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "legacy-unowned",
          name: "Legacy Unowned Catalog",
        }),
      ]),
    );
  });

  it("reserves the synthetic demo repository identity for the internal demo route", async () => {
    const defaultRepo = await createRepo();
    const candidateRepo = await createRepo();
    const server = await startTestServer(defaultRepo);

    const response = await fetch(`${server.url}/api/repositories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: " demo-golden-path ",
        name: "Mocked golden path demo",
        path: candidateRepo,
        synthetic: true,
      }),
    });

    await expectWebInputError(
      response,
      "repository id is reserved for the mocked demo",
    );
  });

  it("clones GitHub repositories from URL input before registering them", async () => {
    const defaultRepo = await createRepo();
    const clonedTargets: Array<{ url: string; targetPath: string }> = [];
    const server = await startTestServer(defaultRepo, undefined, undefined, {
      cloneRepository: async ({ url, targetPath }) => {
        clonedTargets.push({ url, targetPath });
        await mkdir(join(targetPath, "flows"), { recursive: true });
        await writeFile(
          join(targetPath, "flows/implement-spec-bootstrap.json"),
          "{}",
          "utf8",
        );
      },
    });

    const addResponse = await fetch(`${server.url}/api/repositories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        githubUrl: "https://github.com/Instask/nitely/issues/79",
      }),
    });
    expect(addResponse.status).toBe(201);
    const expectedPath = join(resolve(defaultRepo), ".nitely", "repositories", "instask-nitely");
    await expect(json(addResponse)).resolves.toMatchObject({
      repository: {
        id: "instask-nitely",
        name: "Instask/nitely",
        sourceUrl: "https://github.com/Instask/nitely.git",
      },
    });
    expect(clonedTargets).toEqual([
      {
        url: "https://github.com/Instask/nitely.git",
        targetPath: expectedPath,
      },
    ]);
    await expect(
      readFile(join(defaultRepo, ".nitely", "repositories.json"), "utf8"),
    ).resolves.toContain('"sourceUrl": "https://github.com/Instask/nitely.git"');

    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repoId: "instask-nitely",
          title: "Cloned repo task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { repoId?: string; repoName?: string; repoPath?: string } };
    expect(created.task).toMatchObject({
      repoId: "instask-nitely",
      repoName: "Instask/nitely",
    });
  });

  it("registers the home checkout from its origin and routes unscoped requests to it", async () => {
    const home = await createRepo();
    const server = await startWebServer({
      repoPath: home,
      host: "127.0.0.1",
      port: 0,
      providerCommandStatus: async () => false,
      readRepositoryOrigin: async () => "https://github.com/acme/home.git",
    });
    servers.push(server);

    await expect(json(await fetch(`${server.url}/api/repositories`))).resolves.toEqual({
      repositories: [
        { id: "acme-home", name: "acme/home", sourceUrl: "https://github.com/acme/home.git" },
      ],
    });

    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Unscoped task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { repoId?: string } };
    expect(created.task.repoId).toBe("acme-home");
  });

  it("warns when pre-upgrade home state has no registered repository", async () => {
    const home = await createRepo();
    await mkdir(join(home, ".nitely", "runs"), { recursive: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const server = await startWebServer({
        repoPath: home,
        host: "127.0.0.1",
        port: 0,
        providerCommandStatus: async () => false,
        readRepositoryOrigin: async () => undefined,
      });
      servers.push(server);

      expect(
        warnSpy.mock.calls.some(([message]) =>
          typeof message === "string" &&
          message.includes("no registered repository (reason: no-origin)"),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("requires a repoId when nothing is registered at the home directory", async () => {
    const home = await createRepo();
    const server = await startWebServer({
      repoPath: home,
      host: "127.0.0.1",
      port: 0,
      providerCommandStatus: async () => false,
      readRepositoryOrigin: async () => undefined,
    });
    servers.push(server);

    const response = await fetch(`${server.url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Orphan", spec: "s", techDesign: "d" }),
    });
    await expectWebInputError(response, "repoId is required");
  });

  it("rejects repository registration by server path", async () => {
    const defaultRepo = await createRepo();
    const server = await startTestServer(defaultRepo);

    const response = await fetch(`${server.url}/api/repositories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "app", path: defaultRepo }),
    });

    await expectWebInputError(
      response,
      "repository path is not accepted; register a GitHub URL",
    );
  });

  it("requires a GitHub URL to register a repository", async () => {
    const defaultRepo = await createRepo();
    const server = await startTestServer(defaultRepo);

    const response = await fetch(`${server.url}/api/repositories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "app", name: "App" }),
    });

    await expectWebInputError(response, "githubUrl is required");
  });

  it("rejects duplicate GitHub repository imports before cloning again", async () => {
    const defaultRepo = await createRepo();
    const clonedTargets: Array<{ url: string; targetPath: string }> = [];
    const server = await startTestServer(defaultRepo, undefined, undefined, {
      cloneRepository: async ({ url, targetPath }) => {
        clonedTargets.push({ url, targetPath });
        await mkdir(join(targetPath, "flows"), { recursive: true });
      },
    });

    const firstResponse = await fetch(`${server.url}/api/repositories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        githubUrl: "https://github.com/Instask/nitely",
      }),
    });
    const duplicateResponse = await fetch(`${server.url}/api/repositories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "nitely-again",
        githubUrl: "git@github.com:Instask/nitely.git",
      }),
    });

    expect(firstResponse.status).toBe(201);
    expect(duplicateResponse.status).toBe(400);
    await expect(json(duplicateResponse)).resolves.toEqual({
      error: {
        code: "invalid_input",
        message: "duplicate repository source: git@github.com:Instask/nitely.git",
      },
    });
    expect(clonedTargets).toHaveLength(1);
  });

  it("lists dev tasks as dev.pr work items through the generic work item API", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    await fetch(`${server.url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Dev item",
        spec: "Spec body",
        techDesign: "Design body",
      }),
    });

    const body = (await json(
      await fetch(`${server.url}/api/work-items`),
    )) as { workItems: { workItemType: string; inputs: Record<string, unknown> }[] };

    expect(body.workItems).toHaveLength(1);
    expect(body.workItems[0]?.workItemType).toBe("dev.pr");
    expect(body.workItems[0]?.inputs.spec).toBeDefined();
  });

  it("lists legacy tasks, generic work items, and inferred historical work items through the task API", async () => {
    const repoPath = await createRepo();
    await writeNonDevFlow(join(repoPath, "flows/autofarm-site.json"));
    await allowAutofarmWorkItems(repoPath);
    const server = await startTestServer(repoPath);

    const createdTask = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Legacy task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string } };
    const createdWorkItem = (await json(
      await fetch(`${server.url}/api/work-items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Generic task",
          flowPath: "flows/autofarm-site.json",
          inputs: { seed: { connector: "local-file", uri: "inputs/seed.json" } },
        }),
      }),
    )) as { workItem: { id: string } };
    await mkdir(join(repoPath, ".nitely/runs/run-historical"), { recursive: true });
    await writeFile(
      join(repoPath, ".nitely/runs/run-historical/run.json"),
      JSON.stringify(
        {
          runId: "run-historical",
          status: "completed",
          flowName: "Historical flow",
          flowPath: "flows/autofarm-site.json",
          workItemId: "historical-task",
          workItemType: "autofarm.site",
          completedStages: ["discover"],
          inputs: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    const body = (await json(await fetch(`${server.url}/api/tasks`))) as {
      tasks: Array<{ id: string; title: string; workItemType?: string; runCount?: number }>;
    };

    expect(body.tasks.map((task) => task.id)).toEqual(
      expect.arrayContaining([
        createdTask.task.id,
        createdWorkItem.workItem.id,
        "historical-task",
      ]),
    );
    expect(body.tasks.find((task) => task.id === "historical-task")).toMatchObject({
      title: "Historical flow",
      workItemType: "autofarm.site",
      runCount: 1,
    });
  });

  it("returns generic task detail with input content, runs, and artifacts", async () => {
    const repoPath = await createRepo();
    await writeNonDevFlow(join(repoPath, "flows/autofarm-site.json"));
    await allowAutofarmWorkItems(repoPath);
    await mkdir(join(repoPath, "inputs"), { recursive: true });
    await writeFile(join(repoPath, "inputs/spec.md"), "Generic spec", "utf8");
    await writeFile(join(repoPath, "inputs/tech.md"), "Generic design", "utf8");
    const server = await startTestServer(repoPath);

    const created = (await json(
      await fetch(`${server.url}/api/work-items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Generic detail",
          flowPath: "flows/autofarm-site.json",
          inputs: {
            seed: { connector: "local-file", uri: "inputs/seed.json" },
            spec: { connector: "local-file", uri: "inputs/spec.md" },
            "tech-design": { connector: "local-file", uri: "inputs/tech.md" },
          },
        }),
      }),
    )) as { workItem: { id: string } };
    const runDirectory = join(repoPath, ".nitely/runs/run-generic-detail");
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      join(runDirectory, "run.json"),
      JSON.stringify(
        {
          runId: "run-generic-detail",
          status: "completed",
          workItemId: created.workItem.id,
          workItemType: "autofarm.site",
          completedStages: ["discover", "deploy"],
          inputs: {},
          changeRequestUrl: "https://github.com/example/repo/pull/44",
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      join(runDirectory, "artifacts.json"),
      JSON.stringify(
        {
          runId: "run-generic-detail",
          artifacts: [
            {
              id: "site-plan",
              type: "autofarm.site-plan",
              producer: "discover",
              mediaType: "application/json",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const response = await fetch(`${server.url}/api/tasks/${created.workItem.id}`);
    expect(response.status).toBe(200);
    const detail = (await json(response)) as {
      task: { id: string; workItemType: string };
      spec?: string;
      techDesign?: string;
      inputContents?: Record<string, string>;
      runs?: Array<{ runId: string; changeRequestUrl?: string }>;
      artifactsByType?: Array<{ type: string }>;
      eligibility?: {
        decision: string;
        blockers: Array<{ code: string; message: string }>;
      };
    };

    expect(detail).toMatchObject({
      task: { id: created.workItem.id, workItemType: "autofarm.site" },
      spec: "Generic spec",
      techDesign: "Generic design",
      inputContents: {
        spec: "Generic spec",
        "tech-design": "Generic design",
      },
      runs: [
        {
          runId: "run-generic-detail",
          changeRequestUrl: "https://github.com/example/repo/pull/44",
        },
      ],
      artifactsByType: [{ type: "autofarm.site-plan" }],
    });

    const canonical = (await json(
      await fetch(`${server.url}/api/work-items/${created.workItem.id}`),
    )) as {
      workItem: { id: string };
      eligibility?: {
        decision: string;
        blockers: Array<{ code: string; message: string }>;
      };
    };
    expect(canonical.workItem.id).toBe(created.workItem.id);
    expect(canonical.eligibility).toEqual(detail.eligibility);
  });

  it("returns inferred historical task detail as read-only with preserved latest run status", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    await mkdir(join(repoPath, ".nitely/runs/run-historical-blocked"), { recursive: true });
    await writeFile(
      join(repoPath, ".nitely/runs/run-historical-blocked/run.json"),
      JSON.stringify(
        {
          runId: "run-historical-blocked",
          status: "blocked",
          flowName: "Historical blocked flow",
          flowPath: "flows/implement-spec-bootstrap.json",
          workItemId: "historical-blocked-task",
          workItemType: "autofarm.site",
          completedStages: ["discover"],
          inputs: { seed: { sourceUri: "inputs/seed.json" } },
          blocker: { reason: "approval-required", stageId: "approve-plan" },
        },
        null,
        2,
      ),
      "utf8",
    );

    const response = await fetch(
      `${server.url}/api/tasks/historical-blocked-task`,
    );

    expect(response.status).toBe(200);
    const body = (await json(response)) as {
      readOnly: boolean;
      task: {
        id: string;
        status: string;
        displayStatus?: string;
        latestRunStatus?: string;
        readOnly?: boolean;
      };
      runs: Array<{ runId: string; status: string }>;
    };
    expect(body.readOnly).toBe(true);
    expect(body.task).toMatchObject({
      id: "historical-blocked-task",
      status: "failed",
      displayStatus: "blocked",
      latestRunStatus: "blocked",
      readOnly: true,
    });
    expect(body.runs).toEqual([
      expect.objectContaining({
        runId: "run-historical-blocked",
        status: "blocked",
      }),
    ]);
  });

  it("starts a generic stored work item through the unified task run route", async () => {
    const repoPath = await createRepo();
    await writeNonDevFlow(join(repoPath, "flows/autofarm-site.json"));
    await allowAutofarmWorkItems(repoPath);
    await mkdir(join(repoPath, "seeds"), { recursive: true });
    await writeFile(join(repoPath, "seeds/k.json"), "{\"keyword\":\"night\"}", "utf8");
    let runInput: RunFlowInput | undefined;
    const server = await startTestServer(
      repoPath,
      async (input) => {
        runInput = input;
        return {
          runId: "run-generic-task-route",
          branchName: "nitely/run-generic-task-route",
          worktreePath: join(repoPath, ".nitely/runs/run-generic-task-route/worktree"),
        };
      },
      undefined,
      { createRunId: () => "run-generic-task-route" },
    );
    const created = (await json(
      await fetch(`${server.url}/api/work-items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Generic via task route",
          flowPath: "flows/autofarm-site.json",
          inputs: { seed: { connector: "local-file", uri: "seeds/k.json" } },
        }),
      }),
    )) as { workItem: { id: string; workItemType: string } };

    const response = await fetch(
      `${server.url}/api/tasks/${created.workItem.id}/runs`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      run: { runId: "run-generic-task-route" },
    });
    expect(runInput).toMatchObject({
      flowPath: join(repoPath, "flows/autofarm-site.json"),
      repoPath,
      inputs: { seed: { connector: "local-file", uri: "seeds/k.json" } },
      workItemId: created.workItem.id,
      workItemType: "autofarm.site",
    });
    const detail = (await json(
      await fetch(`${server.url}/api/tasks/${created.workItem.id}`),
    )) as { task: { status: string; latestRunId?: string } };
    expect(detail.task).toMatchObject({
      status: "completed",
      latestRunId: "run-generic-task-route",
    });
  });

  it("returns the admitted Run when concurrent generic start routes race", async () => {
    const repoPath = await createRepo();
    await writeNonDevFlow(join(repoPath, "flows/autofarm-site.json"));
    await allowAutofarmWorkItems(repoPath);
    await mkdir(join(repoPath, "seeds"), { recursive: true });
    await writeFile(
      join(repoPath, "seeds/concurrent.json"),
      '{"keyword":"night"}',
      "utf8",
    );
    let releaseRunner!: () => void;
    const runnerGate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    let reportRunnerStarted!: () => void;
    const runnerStarted = new Promise<void>((resolve) => {
      reportRunnerStarted = resolve;
    });
    let runnerCalls = 0;
    const server = await startTestServer(
      repoPath,
      async (_input, dependencies) => {
        runnerCalls += 1;
        const runId = dependencies?.createRunId?.() ?? "missing-admission";
        reportRunnerStarted();
        await runnerGate;
        return {
          runId,
          branchName: `nitely/${runId}`,
          worktreePath: join(repoPath, ".nitely", "runs", runId, "worktree"),
        };
      },
      undefined,
      { createRunId: () => "run-concurrent-start" },
    );
    const created = await createWorkItem(repoPath, {
      title: "Concurrent start",
      workItemType: "autofarm.site",
      flowPath: "flows/autofarm-site.json",
      inputs: {
        seed: { connector: "local-file", uri: "seeds/concurrent.json" },
      },
    });

    const winningRequest = fetch(
      `${server.url}/api/tasks/${created.id}/runs`,
      { method: "POST" },
    );
    await runnerStarted;
    const conflict = await fetch(
      `${server.url}/api/work-items/${created.id}/runs`,
      { method: "POST" },
    );

    expect(conflict.status).toBe(409);
    await expect(json(conflict)).resolves.toMatchObject({
      error: {
        code: "run_start_conflict",
        runId: "run-concurrent-start",
      },
    });
    expect(runnerCalls).toBe(1);
    releaseRunner();
    expect((await winningRequest).status).toBe(200);
    await expect(getWorkItem(repoPath, created.id)).resolves.toMatchObject({
      status: "completed",
      latestRunId: "run-concurrent-start",
    });
  });

  it("keeps an admitted generic Run active when the runner records a blocker", async () => {
    const repoPath = await createRepo();
    await writeNonDevFlow(join(repoPath, "flows/autofarm-site.json"));
    await allowAutofarmWorkItems(repoPath);
    await mkdir(join(repoPath, "seeds"), { recursive: true });
    await writeFile(join(repoPath, "seeds/blocked.json"), '{"keyword":"night"}', "utf8");
    const server = await startTestServer(
      repoPath,
      async (_input, dependencies) => {
        const runId = dependencies?.createRunId?.() ?? "missing-admission";
        const events = new EventStore(eventStorePath(repoPath));
        const blocker = {
          reason: "agent_usage_limit",
          stageId: "implement",
          message: "usage limit",
          retryAfter: "2026-07-16T00:00:00.000Z",
        };
        try {
          events.append({ runId, type: "run.blocked", payload: blocker });
        } finally {
          events.close();
        }
        throw new Error("runner blocked");
      },
      undefined,
      { createRunId: () => "run-generic-blocked" },
    );
    const workItem = await createWorkItem(repoPath, {
      title: "Blocked generic Run",
      workItemType: "autofarm.site",
      flowPath: "flows/autofarm-site.json",
      inputs: {
        seed: { connector: "local-file", uri: "seeds/blocked.json" },
      },
    });

    const response = await fetch(`${server.url}/api/work-items/${workItem.id}/runs`, {
      method: "POST",
    });
    expect(response.status).toBe(500);
    await expect(getWorkItem(repoPath, workItem.id)).resolves.toMatchObject({
      status: "running",
      latestRunId: "run-generic-blocked",
    });
    const events = new EventStore(eventStorePath(repoPath));
    try {
      expect(projectRun(events.list("run-generic-blocked")).status).toBe("blocked");
      expect(
        events
          .list("run-generic-blocked")
          .some((event) => event.type === "run.failed"),
      ).toBe(false);
    } finally {
      events.close();
    }
    const admissions = new RunAdmissionStore(
      join(repoPath, ".nitely", "run-admissions.db"),
    );
    try {
      expect(admissions.get("run-generic-blocked")).toMatchObject({ state: "active" });
    } finally {
      admissions.close();
    }
    const conflict = await fetch(
      `${server.url}/api/tasks/${workItem.id}/runs`,
      { method: "POST" },
    );
    expect(conflict.status).toBe(409);
    await expect(json(conflict)).resolves.toMatchObject({
      error: { code: "run_start_conflict", runId: "run-generic-blocked" },
    });
  });

  it("rejects a generic Run when its input candidate changes during preflight", async () => {
    const repoPath = await createRepo();
    await writeNonDevFlow(join(repoPath, "flows/autofarm-site.json"));
    await allowAutofarmWorkItems(repoPath);
    await mkdir(join(repoPath, "seeds"), { recursive: true });
    await writeFile(join(repoPath, "seeds/a.json"), "{\"keyword\":\"A\"}", "utf8");
    await writeFile(join(repoPath, "seeds/b.json"), "{\"keyword\":\"B\"}", "utf8");
    const workItem = await createWorkItem(repoPath, {
      title: "Stable evaluated input snapshot",
      workItemType: "autofarm.site",
      flowPath: "flows/autofarm-site.json",
      inputs: {
        seed: { connector: "local-file", uri: "seeds/a.json" },
      },
    });
    let mutated = false;
    const providerStore: ProviderConnectionStore = {
      getConnection: async () => {
        throw new Error("unused");
      },
      resolveEnv: async () => ({}),
      listStatuses: async () => {
        if (!mutated) {
          mutated = true;
          const recordPath = join(
            repoPath,
            `.nitely/work-items/${workItem.id}/work-item.json`,
          );
          const persisted = JSON.parse(await readFile(recordPath, "utf8")) as {
            inputs: Record<string, unknown>;
          };
          persisted.inputs = {
            seed: { connector: "local-file", uri: "seeds/b.json" },
          };
          await writeFile(recordPath, JSON.stringify(persisted, null, 2), "utf8");
        }
        return [];
      },
    };
    let runInput: RunFlowInput | undefined;
    const server = await startTestServer(
      repoPath,
      async (input) => {
        runInput = input;
        return {
          runId: "run-generic-evaluated-snapshot",
          branchName: "nitely/run-generic-evaluated-snapshot",
          worktreePath: join(
            repoPath,
            ".nitely/runs/run-generic-evaluated-snapshot/worktree",
          ),
        };
      },
      providerStore,
    );

    const response = await fetch(
      `${server.url}/api/work-items/${workItem.id}/runs`,
      { method: "POST" },
    );

    expect(response.status).toBe(409);
    await expect(json(response)).resolves.toMatchObject({
      error: { code: "run_start_conflict" },
    });
    expect(runInput).toBeUndefined();
    await expect(getWorkItem(repoPath, workItem.id)).resolves.toMatchObject({
      inputs: { seed: { connector: "local-file", uri: "seeds/b.json" } },
    });
  });

  it("rejects generic work-item runs while a dependency is incomplete", async () => {
    const repoPath = await createRepo();
    await writeNonDevFlow(join(repoPath, "flows/autofarm-site.json"));
    await allowAutofarmWorkItems(repoPath);
    await mkdir(join(repoPath, "seeds"), { recursive: true });
    await writeFile(
      join(repoPath, "seeds/k.json"),
      "{\"keyword\":\"night\"}",
      "utf8",
    );
    await createWorkItem(
      repoPath,
      {
        title: "Generic upstream",
        workItemType: "autofarm.site",
        flowPath: "flows/autofarm-site.json",
        inputs: {
          seed: { connector: "local-file", uri: "seeds/k.json" },
        },
      },
      { createId: () => "generic-upstream" },
    );
    await createWorkItem(
      repoPath,
      {
        title: "Generic downstream",
        workItemType: "autofarm.site",
        flowPath: "flows/autofarm-site.json",
        inputs: {
          seed: { connector: "local-file", uri: "seeds/k.json" },
        },
        dependsOn: ["generic-upstream"],
      },
      { createId: () => "generic-downstream" },
    );
    let started = false;
    let runInput: RunFlowInput | undefined;
    const server = await startTestServer(
      repoPath,
      async (input) => {
        started = true;
        runInput = input;
        return {
          runId: "run-must-not-start",
          branchName: "nitely/run-must-not-start",
          worktreePath: join(repoPath, ".nitely/runs/run-must-not-start/worktree"),
        };
      },
      undefined,
      { createRunId: () => "run-must-not-start" },
    );

    const response = await fetch(
      `${server.url}/api/tasks/generic-downstream/runs`,
      { method: "POST" },
    );

    await expectWebInputError(
      response,
      "task is blocked by dependencies: generic-upstream is incomplete",
    );
    expect(started).toBe(false);
    await expect(
      getWorkItem(repoPath, "generic-downstream"),
    ).resolves.toMatchObject({ status: "ready" });

    const canonicalBlocked = await fetch(
      `${server.url}/api/work-items/generic-downstream/runs`,
      { method: "POST" },
    );
    await expectWebInputError(
      canonicalBlocked,
      "task is blocked by dependencies: generic-upstream is incomplete",
    );
    expect(started).toBe(false);

    const override = await fetch(
      `${server.url}/api/tasks/generic-downstream/runs?override=true`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: "operator accepted the incomplete dependency",
        }),
      },
    );
    expect(override.status).toBe(200);
    expect(started).toBe(true);
    expect(runInput?.runEligibilityOverride).toEqual({
      actor: "local",
      reason: "operator accepted the incomplete dependency",
      acceptedReasonCodes: ["dependency.incomplete:generic-upstream"],
    });
  });

  it("uses one governance decision for detail, scheduler, and both run routes", async () => {
    const repoPath = await createRepo();
    await writeNonDevFlow(join(repoPath, "flows/autofarm-site.json"));
    await allowAutofarmWorkItems(repoPath);
    await mkdir(join(repoPath, "seeds"), { recursive: true });
    await writeFile(join(repoPath, "seeds/k.json"), "{\"keyword\":\"night\"}", "utf8");
    let runnerCalls = 0;
    const server = await startTestServer(repoPath, async () => {
      runnerCalls += 1;
      return {
        runId: "run-must-not-start",
        branchName: "nitely/run-must-not-start",
        worktreePath: join(repoPath, ".nitely/runs/run-must-not-start/worktree"),
      };
    });
    const created = (await json(
      await fetch(`${server.url}/api/work-items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Governance drift",
          flowPath: "flows/autofarm-site.json",
          inputs: {
            seed: { connector: "local-file", uri: "seeds/k.json" },
          },
        }),
      }),
    )) as { workItem: { id: string } };
    await writeFile(
      join(repoPath, ".nitely/work-item-policy.json"),
      JSON.stringify({ allowedTypes: [] }),
      "utf8",
    );
    const expectedMessage =
      'work item type "autofarm.site" is high-risk and must be added to .nitely/work-item-policy.json allowedTypes';

    const taskDetail = (await json(
      await fetch(`${server.url}/api/tasks/${created.workItem.id}`),
    )) as { eligibility: { blockers: Array<{ code: string; message: string }> } };
    const canonicalDetail = (await json(
      await fetch(`${server.url}/api/work-items/${created.workItem.id}`),
    )) as { eligibility: { blockers: Array<{ code: string; message: string }> } };
    expect(taskDetail.eligibility.blockers).toEqual([
      expect.objectContaining({
        code: "governance.policy-denied",
        message: expectedMessage,
      }),
    ]);
    expect(canonicalDetail.eligibility).toEqual(taskDetail.eligibility);

    const scheduler = (await json(
      await fetch(`${server.url}/api/scheduler`),
    )) as {
      scheduler: {
        queue: { blocked: Array<{ blockedReasons: Array<{ kind: string; message: string }> }> };
      };
    };
    expect(scheduler.scheduler.queue.blocked[0]?.blockedReasons).toEqual([
      { kind: "governance", message: expectedMessage },
    ]);

    for (const route of ["tasks", "work-items"]) {
      const response = await fetch(
        `${server.url}/api/${route}/${created.workItem.id}/runs`,
        { method: "POST" },
      );
      await expectWebInputError(response, expectedMessage);
    }
    expect(runnerCalls).toBe(0);
    await expect(getWorkItem(repoPath, created.workItem.id)).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("prepares legacy workflow metadata consistently and preserves already-running snapshots", async () => {
    const repoPath = await createRepo();
    await writeFile(
      join(repoPath, "flows/workflow-metadata-required.json"),
      JSON.stringify(
        {
          apiVersion: "nitely.dev/v1alpha1",
          kind: "Flow",
          metadata: {
            name: "workflow-metadata-required",
            workItemType: "dev.pr",
          },
          spec: {
            stages: [
              {
                id: "implement",
                type: "agent",
                runtime: "mock",
                prompt: "Implement.",
                inputs: ["spec", "tech-design", "workflow-metadata"],
                outputs: ["implementation"],
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    let runInput: RunFlowInput | undefined;
    const server = await startTestServer(repoPath, async (input) => {
      runInput = input;
      return {
        runId: "run-prepared-legacy-metadata",
        branchName: "nitely/run-prepared-legacy-metadata",
        worktreePath: join(
          repoPath,
          ".nitely/runs/run-prepared-legacy-metadata/worktree",
        ),
      };
    });
    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Prepared legacy metadata",
          spec: "Spec body",
          techDesign: "Design body",
          flowPath: "flows/workflow-metadata-required.json",
        }),
      }),
    )) as { task: { id: string } };
    const metadataPath = join(
      repoPath,
      ".nitely/tasks",
      created.task.id,
      "execution/workflow-metadata.json",
    );

    await expect(readFile(metadataPath, "utf8")).resolves.toContain(
      '"taskId"',
    );

    await rm(metadataPath, { force: true });
    const preflight = (await json(
      await fetch(`${server.url}/api/tasks/${created.task.id}/preflight`),
    )) as {
      preflight: {
        status: string;
        requiredInputs: string[];
        issues: unknown[];
      };
    };
    expect(preflight.preflight).toMatchObject({
      status: "PASS",
      requiredInputs: ["spec", "tech-design", "workflow-metadata"],
      issues: [],
    });
    await expect(readFile(metadataPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await rm(metadataPath, { force: true });
    const taskDetail = (await json(
      await fetch(`${server.url}/api/tasks/${created.task.id}`),
    )) as { eligibility: { decision: string; blockers: unknown[] } };
    expect(taskDetail.eligibility).toMatchObject({
      decision: "eligible",
      blockers: [],
    });
    await expect(readFile(metadataPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await rm(metadataPath, { force: true });
    const canonicalDetail = (await json(
      await fetch(`${server.url}/api/work-items/${created.task.id}`),
    )) as { eligibility: { decision: string; blockers: unknown[] } };
    expect(canonicalDetail.eligibility).toEqual(taskDetail.eligibility);
    await expect(readFile(metadataPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await rm(metadataPath, { force: true });
    const scheduler = (await json(
      await fetch(`${server.url}/api/scheduler`),
    )) as {
      scheduler: {
        queue: {
          runnable: Array<{ id: string }>;
          blocked: Array<{ id: string }>;
        };
      };
    };
    expect(scheduler.scheduler.queue.runnable).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.task.id })]),
    );
    expect(scheduler.scheduler.queue.blocked).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.task.id })]),
    );
    await expect(readFile(metadataPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const runningMetadata = JSON.stringify({ snapshot: "active-run" });
    await writeFile(metadataPath, runningMetadata, "utf8");
    await updateTaskRunState(repoPath, created.task.id, { status: "running" });
    const runningReads = await Promise.all([
      fetch(`${server.url}/api/tasks/${created.task.id}/preflight`),
      fetch(`${server.url}/api/tasks/${created.task.id}`),
      fetch(`${server.url}/api/work-items/${created.task.id}`),
      fetch(`${server.url}/api/scheduler`),
    ]);
    expect(runningReads.every((response) => response.status === 200)).toBe(true);
    await expect(readFile(metadataPath, "utf8")).resolves.toBe(runningMetadata);
    await updateTaskRunState(repoPath, created.task.id, { status: "ready" });

    await rm(metadataPath, { force: true });
    const started = await fetch(`${server.url}/api/tasks/${created.task.id}/runs`, {
      method: "POST",
    });
    expect(started.status).toBe(200);
    expect(runInput?.inputs["workflow-metadata"]).toEqual({
      connector: "local-file",
      uri: expect.stringMatching(
        /^\.nitely\/tasks\/[^/]+\/execution\/candidates\/[a-f0-9]{64}\/workflow-metadata\.json$/,
      ),
    });
    await expect(readFile(metadataPath, "utf8")).resolves.toContain(
      '"status": "running"',
    );
  });

  it("blocks generic task runs when preflight fails", async () => {
    const repoPath = await createRepo();
    await writeFile(
      join(repoPath, "flows/preflight-block.json"),
      JSON.stringify(
        {
          apiVersion: "nitely.dev/v1alpha1",
          kind: "Flow",
          metadata: { name: "preflight-block", inputs: [{ id: "intake" }] },
          spec: {
            stages: [
              {
                id: "implement",
                type: "agent",
                runtime: "mock",
                prompt: "Implement.",
                inputs: ["intake"],
                outputs: ["implementation"],
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    let started = false;
    const server = await startTestServer(repoPath, async () => {
      started = true;
      return {
        runId: "run-should-not-start",
        branchName: "nitely/run-should-not-start",
        worktreePath: join(repoPath, ".nitely/runs/run-should-not-start/worktree"),
      };
    });
    await createWorkItem(
      repoPath,
      {
        title: "Missing intake",
        workItemType: "dev.pr",
        flowPath: "flows/preflight-block.json",
        inputs: {},
      },
      { createId: () => "missing-intake" },
    );

    const response = await fetch(`${server.url}/api/tasks/missing-intake/runs`, {
      method: "POST",
    });

    await expectWebInputError(
      response,
      "run preflight blocks execution: required input is missing: intake",
    );
    expect(started).toBe(false);

    const schedulerResponse = await fetch(`${server.url}/api/scheduler`);
    expect(schedulerResponse.status).toBe(200);
    const scheduler = (await json(schedulerResponse)) as {
      scheduler: {
        summary: { runnable: number; blocked: number };
        queue: {
          runnable: Array<{ id: string }>;
          blocked: Array<{
            id: string;
            displayStatus: string;
            blockedReasons: Array<{ kind: string; message?: string }>;
          }>;
        };
      };
    };
    expect(scheduler.scheduler.summary).toMatchObject({
      runnable: 0,
      blocked: 1,
    });
    expect(scheduler.scheduler.queue.runnable).toEqual([]);
    expect(scheduler.scheduler.queue.blocked).toEqual([
      expect.objectContaining({
        id: "missing-intake",
        displayStatus: "blocked",
        blockedReasons: [
          {
            kind: "preflight",
            message: "required input is missing: intake",
          },
        ],
      }),
    ]);

    const detailResponse = await fetch(
      `${server.url}/api/tasks/missing-intake`,
    );
    expect(detailResponse.status).toBe(200);
    const detail = (await json(detailResponse)) as {
      eligibility?: {
        decision: string;
        blockers: Array<{ code: string; kind: string }>;
      };
    };
    expect(detail.eligibility).toMatchObject({
      decision: "blocked",
      blockers: [
        expect.objectContaining({
          code: "preflight.missing-input",
          kind: "preflight",
        }),
      ],
    });
  });

  it("accepts task runs before a delayed runner resolves and keeps final run detail observable", async () => {
    const repoPath = await createRepo();
    let releaseRunner!: () => void;
    let runnerStarted!: () => void;
    const runnerStartedPromise = new Promise<void>((resolve) => {
      runnerStarted = resolve;
    });
    const releaseRunnerPromise = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const server = await startTestServer(repoPath, async (_input, dependencies) => {
      const runId = dependencies?.createRunId?.() ?? "run-delayed";
      runnerStarted();
      await releaseRunnerPromise;
      return {
        runId,
        branchName: `nitely/${runId}`,
        worktreePath: join(repoPath, ".nitely/runs", runId, "worktree"),
        changeRequestUrl: "https://github.com/example/repo/pull/149",
        changeRequest: {
          provider: "github",
          url: "https://github.com/example/repo/pull/149",
          number: 149,
          owner: "example",
          repository: "repo",
          baseBranch: "master",
          headBranch: `nitely/${runId}`,
          draft: false,
        },
      };
    });
    const upstream = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Async upstream",
          spec: "Upstream spec",
          techDesign: "Upstream design",
        }),
      }),
    )) as { task: { id: string } };
    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Async task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string } };
    const dependencyResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/dependencies`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dependsOn: upstream.task.id }),
      },
    );
    expect(dependencyResponse.status).toBe(200);

    const runResponsePromise = fetch(
      `${server.url}/api/tasks/${created.task.id}/runs?override=true`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: "operator accepted the incomplete dependency",
        }),
      },
    );
    await runnerStartedPromise;
    const responseState = await Promise.race([
      runResponsePromise.then(() => "responded"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    let acceptedRunId = "";
    try {
      expect(responseState).toBe("responded");
      const runResponse = await runResponsePromise;
      expect(runResponse.status).toBe(200);
      const accepted = (await json(runResponse)) as {
        run: { runId: string; status: string; taskId?: string; branchName?: string };
      };
      acceptedRunId = accepted.run.runId;
      expect(accepted.run).toMatchObject({
        status: "running",
        taskId: created.task.id,
        branchName: `nitely/${accepted.run.runId}`,
      });

      const promptTaskDetail = (await json(
        await fetch(`${server.url}/api/tasks/${created.task.id}`),
      )) as { task: { status: string; latestRunId?: string } };
      expect(promptTaskDetail.task).toMatchObject({
        status: "running",
        latestRunId: acceptedRunId,
      });

      const acceptedRunDetail = (await json(
        await fetch(`${server.url}/api/runs/${acceptedRunId}`),
      )) as {
        run: { runEligibilityOverride?: unknown };
      };
      expect(acceptedRunDetail.run.runEligibilityOverride).toEqual({
        actor: "local",
        reason: "operator accepted the incomplete dependency",
        acceptedReasonCodes: [`dependency.incomplete:${upstream.task.id}`],
      });
    } finally {
      releaseRunner();
    }

    const finalTaskDetail = await waitFor(
      async () =>
        (await json(
          await fetch(`${server.url}/api/tasks/${created.task.id}`),
        )) as { task: { status: string; latestRunId?: string; changeRequestUrl?: string } },
      (body) => body.task.status === "completed",
    );
    expect(finalTaskDetail.task).toMatchObject({
      status: "completed",
      latestRunId: acceptedRunId,
      changeRequestUrl: "https://github.com/example/repo/pull/149",
    });

    const runDetail = (await json(
      await fetch(`${server.url}/api/runs/${acceptedRunId}`),
    )) as { run: { status: string; changeRequestUrl?: string } };
    expect(runDetail.run).toMatchObject({
      status: "completed",
      changeRequestUrl: "https://github.com/example/repo/pull/149",
    });

    const inbox = await waitFor(
      async () => await json(await fetch(`${server.url}/api/notifications`)),
      (body) =>
        ((body as { notifications?: Array<{ type?: string }> }).notifications ?? [])
          .some((notification) => notification.type === "review-pr"),
    ) as {
      notifications: Array<{
        type: string;
        taskId: string;
        runId: string;
        link: string;
        title: string;
        body: string;
      }>;
    };
    expect(inbox.notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "review-pr",
          taskId: created.task.id,
          runId: acceptedRunId,
          link: "https://github.com/example/repo/pull/149",
          title: "Review PR",
          body: "A ready PR has been published and can be reviewed before merge.",
        }),
      ]),
    );
  });

  it("serves the tasks console at the legacy /work-items page route", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);

    const response = await fetch(`${server.url}/work-items`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain('data-screen-label="Tasks"');
    expect(html).toContain('path === "/work-items"');
  });

  it("serves the Web preview console at the /preview page route", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);

    const response = await fetch(`${server.url}/preview`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain('data-screen-label="Preview"');
    expect(html).toContain('path === "/preview"');
  });

  it("creates and runs a non-dev work item without spec or tech-design inputs", async () => {
    const repoPath = await createRepo();
    await writeNonDevFlow(join(repoPath, "flows/autofarm-site.json"));
    await allowAutofarmWorkItems(repoPath);
    await mkdir(join(repoPath, "seeds"), { recursive: true });
    await writeFile(join(repoPath, "seeds/k.json"), "{\"keyword\":\"night\"}", "utf8");

    let runInput: RunFlowInput | undefined;
    const server = await startTestServer(
      repoPath,
      async (input) => {
        runInput = input;
        return {
          runId: "run-autofarm",
          branchName: "nitely/run-autofarm",
          worktreePath: join(repoPath, ".nitely/runs/run-autofarm/worktree"),
        };
      },
      undefined,
      { createRunId: () => "run-autofarm" },
    );

    const created = (await json(
      await fetch(`${server.url}/api/work-items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Launch site",
          flowPath: "flows/autofarm-site.json",
          inputs: { seed: { connector: "local-file", uri: "seeds/k.json" } },
        }),
      }),
    )) as { workItem: { id: string; workItemType: string } };
    expect(created.workItem.workItemType).toBe("autofarm.site");

    const runResponse = await fetch(
      `${server.url}/api/work-items/${created.workItem.id}/runs`,
      { method: "POST" },
    );
    expect(runResponse.status).toBe(200);
    expect(runInput?.workItemId).toBe(created.workItem.id);
    expect(runInput?.inputs.spec).toBeUndefined();
    expect(runInput?.inputs.seed).toEqual({
      connector: "local-file",
      uri: "seeds/k.json",
    });
  });

  it("blocks unapproved planning artifacts before running a work item", async () => {
    const repoPath = await createRepo();
    await writeNonDevFlow(join(repoPath, "flows/autofarm-site.json"));
    await allowAutofarmWorkItems(repoPath);
    const workItem = await createWorkItem(
      repoPath,
      {
        title: "Launch site",
        workItemType: "autofarm.site",
        flowPath: "flows/autofarm-site.json",
        inputs: { seed: { connector: "local-file", uri: "seeds/k.json" } },
        planning: {
          artifacts: {
            spec: { path: "spec.md", state: "spec_approved" },
            techDesign: { path: "tech-design.md", state: "draft_tech_design" },
          },
          events: [],
        },
      },
      { createId: () => "wi-unapproved" },
    );

    let called = false;
    const server = await startTestServer(repoPath, async () => {
      called = true;
      throw new Error("runner must not be called");
    });

    const runResponse = await fetch(
      `${server.url}/api/work-items/${workItem.id}/runs`,
      { method: "POST" },
    );

    expect(runResponse.status).toBe(400);
    expect(await json(runResponse)).toEqual({
      error: {
        code: "invalid_input",
        message: expect.stringMatching(/tech design must be approved/i),
      },
    });
    expect(called).toBe(false);
  });

  it("blocks work item runs after spec approval until technical design exists", async () => {
    const repoPath = await createRepo();
    await writeNonDevFlow(join(repoPath, "flows/autofarm-site.json"));
    await allowAutofarmWorkItems(repoPath);
    const workItem = await createWorkItem(
      repoPath,
      {
        title: "Launch site",
        workItemType: "autofarm.site",
        flowPath: "flows/autofarm-site.json",
        inputs: { seed: { connector: "local-file", uri: "seeds/k.json" } },
        planning: {
          artifacts: {
            spec: { path: "spec.md", state: "spec_approved" },
          },
          events: [],
        },
      },
      { createId: () => "wi-missing-tech-design" },
    );

    let called = false;
    const server = await startTestServer(repoPath, async () => {
      called = true;
      throw new Error("runner must not be called");
    });

    const runResponse = await fetch(
      `${server.url}/api/work-items/${workItem.id}/runs`,
      { method: "POST" },
    );

    await expectWebInputError(
      runResponse,
      "draft technical design is required before starting a run",
    );
    expect(called).toBe(false);
  });

  it("passes task scope from work item run API requests to the runner", async () => {
    const repoPath = await createRepo();
    await writeNonDevFlow(join(repoPath, "flows/autofarm-site.json"));
    await allowAutofarmWorkItems(repoPath);
    await mkdir(join(repoPath, "seeds"), { recursive: true });
    await mkdir(join(repoPath, "docs"), { recursive: true });
    await writeFile(join(repoPath, "seeds/k.json"), "{\"keyword\":\"night\"}", "utf8");
    await writeFile(join(repoPath, "docs/tasks.md"), "- [ ] T001\n- [ ] T002\n- [ ] T003\n", "utf8");

    let runInput: RunFlowInput | undefined;
    const server = await startTestServer(
      repoPath,
      async (input) => {
        runInput = input;
        return {
          runId: "run-scoped-api",
          branchName: "nitely/run-scoped-api",
          worktreePath: join(repoPath, ".nitely/runs/run-scoped-api/worktree"),
        };
      },
      undefined,
      { createRunId: () => "run-scoped-api" },
    );

    const created = (await json(
      await fetch(`${server.url}/api/work-items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Launch site",
          flowPath: "flows/autofarm-site.json",
          inputs: {
            seed: { connector: "local-file", uri: "seeds/k.json" },
            tasks: { connector: "local-file", uri: "docs/tasks.md" },
          },
        }),
      }),
    )) as { workItem: { id: string } };

    const runResponse = await fetch(
      `${server.url}/api/work-items/${created.workItem.id}/runs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskScope: { inputId: "tasks", expression: "T001-T003" },
        }),
      },
    );

    expect(runResponse.status).toBe(200);
    expect(runInput?.taskScope).toEqual({
      inputId: "tasks",
      expression: "T001-T003",
    });
  });

  it.each([
    {
      name: "traverses outside flows",
      flowPath: "flows/../outside.json",
      prepare: async (repoPath: string, secretMarker: string) => {
        await writeNonDevFlow(join(repoPath, "outside.json"), secretMarker);
      },
    },
    {
      name: "uses an absolute path",
      flowPath: (repoPath: string) => resolve(repoPath, "flows/absolute.json"),
      prepare: async (repoPath: string, secretMarker: string) => {
        await writeNonDevFlow(
          join(repoPath, "flows/absolute.json"),
          secretMarker,
        );
      },
    },
    {
      name: "uses a symlink that escapes flows",
      flowPath: "flows/escape.json",
      prepare: async (repoPath: string, secretMarker: string) => {
        const outside = await mkdtemp(join(tmpdir(), "nitely-web-server-flow-"));
        await writeNonDevFlow(join(outside, "escape.json"), secretMarker);
        await symlink(join(outside, "escape.json"), join(repoPath, "flows/escape.json"));
      },
    },
  ])(
    "rejects POST /api/work-items when flowPath $name",
    async ({ flowPath, prepare }) => {
      const repoPath = await createRepo();
      const secretMarker = `escaped-flow-secret-${randomUUID()}`;
      await allowAutofarmWorkItems(repoPath);
      await prepare(repoPath, secretMarker);
      const server = await startTestServer(repoPath);

      const response = await fetch(`${server.url}/api/work-items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Launch site",
          flowPath: typeof flowPath === "function" ? flowPath(repoPath) : flowPath,
          inputs: { seed: { connector: "local-file", uri: "seeds/k.json" } },
        }),
      });
      const body = await json(response);

      expect(response.status).toBe(400);
      expect(JSON.stringify(body)).not.toContain(secretMarker);
      expect(await workItemDirectoryEntries(repoPath)).toEqual([]);
    },
  );

  it("returns a client error when a work item flow fails validation", async () => {
    const repoPath = await createRepo();
    await writeFile(
      join(repoPath, "flows/broken.json"),
      JSON.stringify({
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "broken", workItemType: "some.experimental" },
        spec: {
          stages: [
            { id: "build", type: "command", command: "true", inputs: ["missing"], outputs: ["out"] },
          ],
        },
      }),
      "utf8",
    );
    const server = await startTestServer(repoPath);

    const response = await fetch(`${server.url}/api/work-items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Broken",
        flowPath: "flows/broken.json",
        inputs: {},
      }),
    });

    expect(response.status).toBe(400);
  });

  it("allows starting another run after a task already has a completed run", async () => {
    const repoPath = await createRepo();
    const runIds = ["run-first", "run-second"];
    const server = await startTestServer(repoPath, async (_input, dependencies) => {
      const runId = dependencies?.createRunId?.() ?? "run-extra";
      return {
        runId,
        branchName: `nitely/${runId}`,
        worktreePath: join(repoPath, ".nitely/runs", runId, "worktree"),
      };
    }, undefined, { createRunId: () => runIds.shift() ?? "run-extra" });
    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Repeatable run task",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string } };

    expect(
      (await json(
        await fetch(`${server.url}/api/tasks/${created.task.id}/runs`, {
          method: "POST",
        }),
      )) as unknown,
    ).toMatchObject({ run: { runId: "run-first" } });
    await waitFor(
      () => getTask(repoPath, created.task.id),
      (record) => record.status === "completed",
    );

    const secondResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/runs`,
      { method: "POST" },
    );

    expect(secondResponse.status).toBe(200);
    expect(await json(secondResponse)).toMatchObject({
      run: { runId: "run-second" },
    });
    const detailBody = (await json(
      await fetch(`${server.url}/api/tasks/${created.task.id}`),
    )) as { task: { latestRunId?: string } };
    expect(detailBody.task.latestRunId).toBe("run-second");
  });

  it("uses an injected provider store for provider statuses and writes without echoing secrets", async () => {
    const repoPath = await createRepo();
    const writes: SetConnectionInput[] = [];
    const clears: ProviderId[] = [];
    const providerStore: ProviderConnectionStore = {
      getConnection: async () => {
        throw new Error("unused");
      },
      resolveEnv: async () => ({}),
      listStatuses: async () => [
        {
          id: "glm",
          name: "GLM / Zhipu",
          configured: true,
          message: "Configured in injected test store.",
          hints: ["NITELY_GLM_API_KEY"],
          reconnectRequired: false,
          authMethods: [],
        },
      ],
      setConnection: async (input) => {
        writes.push(input);
        return fakeConnectionRecord(input);
      },
      clearConnection: async (providerId) => {
        clears.push(providerId);
      },
    };
    const server = await startTestServer(repoPath, undefined, providerStore);

    const statuses = await json(await fetch(`${server.url}/api/providers`));
    expect(statuses).toEqual({
      providers: [
        {
          id: "glm",
          name: "GLM / Zhipu",
          configured: true,
          message: "Configured in injected test store.",
          hints: ["NITELY_GLM_API_KEY"],
          reconnectRequired: false,
          authMethods: [],
        },
      ],
    });

    const secret = "sk-injected-secret";
    const postResponse = await fetch(`${server.url}/api/providers/glm/connection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: secret }),
    });
    expect(postResponse.status).toBe(200);
    const postBody = await json(postResponse);
    expect(postBody).toMatchObject({ ok: true, connection: { authMethod: "api_key" } });
    expect(JSON.stringify(postBody)).not.toContain(secret);
    expect(writes).toEqual([
      {
        providerId: "glm",
        value: secret,
        metadata: {
          scope: "user",
          source: "web-console",
          ownerId: "local",
        },
      },
    ]);

    const deleteResponse = await fetch(`${server.url}/api/providers/glm/connection`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);
    expect(await json(deleteResponse)).toEqual({ ok: true });
    expect(clears).toEqual(["glm"]);
  });

  it("returns provider credential metadata without exposing secrets and gates org scope writes", async () => {
    const repoPath = await createRepo();
    await createUser(repoPath, {
      email: "admin@example.test",
      password: "admin password passphrase",
      role: "admin",
    });
    await createUser(repoPath, {
      email: "user@example.test",
      password: "user password passphrase",
      role: "user",
    });
    const organizationOwner = await createUser(repoPath, {
      email: "org-owner@example.test",
      password: "organization owner password passphrase",
      role: "user",
    });
    const [ownerTeam] = await listPublicMemberships(repoPath, organizationOwner.id);
    await addOrganizationMember(repoPath, ownerTeam.organizationId, {
      userId: organizationOwner.id,
      role: "owner",
    });
    const server = await startTestServer(
      repoPath,
      undefined,
      undefined,
      { authMode: "required", providerEnv: {} },
    );
    const admin = await login(server, "admin@example.test", "admin password passphrase");
    const user = await login(server, "user@example.test", "user password passphrase");
    const owner = await login(
      server,
      "org-owner@example.test",
      "organization owner password passphrase",
    );
    const secret = "sk-org-secret";

    const ownerSpoofDenied = await fetch(
      `${server.url}/api/providers/github/connection`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: user.cookie,
        },
        body: JSON.stringify({
          value: secret,
          metadata: { scope: "user", ownerId: organizationOwner.id },
        }),
      },
    );
    expect(ownerSpoofDenied.status).toBe(403);
    expect(JSON.stringify(await json(ownerSpoofDenied))).not.toContain(secret);

    const denied = await fetch(`${server.url}/api/providers/github/connection`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: user.cookie,
      },
      body: JSON.stringify({
        value: secret,
        metadata: {
          scope: "org",
          ownerId: "engineering",
          rotationHint: "Rotate monthly",
        },
      }),
    });
    expect(denied.status).toBe(403);
    expect(JSON.stringify(await json(denied))).not.toContain(secret);

    const vaultDenied = await fetch(`${server.url}/api/providers/github/connection`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: user.cookie,
      },
      body: JSON.stringify({
        value: secret,
        metadata: {
          scope: "external-vault-backed",
          source: "external-vault",
          vaultRef: "vault://engineering/github",
        },
      }),
    });
    expect(vaultDenied.status).toBe(403);
    expect(JSON.stringify(await json(vaultDenied))).not.toContain(secret);

    const ownerSaved = await fetch(`${server.url}/api/providers/github/connection`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: owner.cookie,
        "x-nitely-organization-id": ownerTeam.organizationId,
      },
      body: JSON.stringify({
        value: secret,
        metadata: { scope: "org", ownerId: "engineering-owner" },
      }),
    });
    expect(ownerSaved.status).toBe(200);
    const ownerStatuses = (await json(
      await fetch(`${server.url}/api/providers`, {
        headers: { cookie: owner.cookie },
      }),
    )) as { providers: Array<{ id: string; credential?: unknown }> };
    expect(
      ownerStatuses.providers.find((provider) => provider.id === "github")?.credential,
    ).toMatchObject({
      scope: "org",
      ownerId: "engineering-owner",
      organizationId: ownerTeam.organizationId,
    });

    await addOrganizationMember(repoPath, ownerTeam.organizationId, {
      userId: organizationOwner.id,
      role: "member",
    });
    const demotedOwnerClear = await fetch(
      `${server.url}/api/providers/github/connection`,
      {
        method: "DELETE",
        headers: { cookie: owner.cookie },
      },
    );
    expect(demotedOwnerClear.status).toBe(403);

    const saved = await fetch(`${server.url}/api/providers/github/connection`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: admin.cookie,
      },
      body: JSON.stringify({
        value: secret,
        metadata: {
          scope: "org",
          ownerId: "engineering",
          rotationHint: "Rotate monthly",
        },
      }),
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(await json(saved))).not.toContain(secret);

    const statuses = await json(
      await fetch(`${server.url}/api/providers`, {
        headers: { cookie: admin.cookie },
      }),
    ) as { providers: Array<{ id: string; credential?: unknown }> };
    const github = statuses.providers.find((provider) => provider.id === "github");
    expect(github?.credential).toMatchObject({
      scope: "org",
      ownerId: "engineering",
      source: "web-console",
      rotationHint: "Rotate monthly",
    });
    expect(JSON.stringify(statuses)).not.toContain(secret);
  });

  it("rejects unknown provider connection writes with a JSON 404 error", async () => {
    const repoPath = await createRepo();
    const writes: SetConnectionInput[] = [];
    const providerStore: ProviderConnectionStore = {
      getConnection: async () => {
        throw new Error("unused");
      },
      resolveEnv: async () => ({}),
      listStatuses: async () => [],
      setConnection: async (input) => {
        writes.push(input);
        return fakeConnectionRecord(input);
      },
      clearConnection: async () => {
        throw new Error("unused");
      },
    };
    const server = await startTestServer(repoPath, undefined, providerStore);
    const secret = "sk-unknown-provider";

    const response = await fetch(`${server.url}/api/providers/unknown/connection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: secret }),
    });

    expect(response.status).toBe(404);
    const body = await json(response);
    expect(body).toEqual({
      error: {
        code: "not_found",
        message: "provider not found",
      },
    });
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(writes).toEqual([]);
  });

  it("rejects non-writable provider connection writes with a JSON 400 error", async () => {
    const repoPath = await createRepo();
    const writes: SetConnectionInput[] = [];
    const providerStore: ProviderConnectionStore = {
      getConnection: async () => {
        throw new Error("unused");
      },
      resolveEnv: async () => ({}),
      listStatuses: async () => [],
      setConnection: async (input) => {
        writes.push(input);
        return fakeConnectionRecord(input);
      },
      clearConnection: async () => {
        throw new Error("unused");
      },
    };
    const server = await startTestServer(repoPath, undefined, providerStore);
    const secret = "sk-codex-provider";

    const response = await fetch(`${server.url}/api/providers/codex/connection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: secret }),
    });

    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body).toEqual({
      error: {
        code: "invalid_input",
        message: "provider does not support Web Console connection writes",
      },
    });
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(writes).toEqual([]);
  });

  it("rejects provider connection writes when the store is read-only", async () => {
    const repoPath = await createRepo();
    const providerStore: ProviderConnectionStore = {
      getConnection: async () => {
        throw new Error("unused");
      },
      resolveEnv: async () => ({}),
      listStatuses: async () => [],
    };
    const server = await startTestServer(repoPath, undefined, providerStore);
    const secret = "sk-read-only-store";

    const response = await fetch(`${server.url}/api/providers/glm/connection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: secret }),
    });

    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body).toEqual({
      error: {
        code: "invalid_input",
        message: "provider connection store is read-only",
      },
    });
    expect(JSON.stringify(body)).not.toContain(secret);
  });

  it("passes the injected provider store into task runs", async () => {
    const repoPath = await createRepo();
    const providerStore: ProviderConnectionStore = {
      getConnection: async () => {
        throw new Error("unused");
      },
      resolveEnv: async () => ({ NITELY_GLM_API_KEY: "stored-glm" }),
      listStatuses: async () => [],
    };
    let runDependencies: RunFlowDependencies | undefined;
    const server = await startTestServer(
      repoPath,
      async (_input, dependencies) => {
        runDependencies = dependencies;
        return {
          runId: "run-web-provider-store",
          branchName: "nitely/run-web-provider-store",
          worktreePath: join(repoPath, ".nitely/runs/run-web-provider-store/worktree"),
        };
      },
      providerStore,
    );
    const created = (await json(
      await fetch(`${server.url}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Run with provider store",
          spec: "Spec body",
          techDesign: "Design body",
        }),
      }),
    )) as { task: { id: string } };

    const response = await fetch(
      `${server.url}/api/tasks/${created.task.id}/runs`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(runDependencies?.providerStore).toBe(providerStore);
  });

  it("creates Jira planning tasks with normalized snapshots and source provenance", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, undefined, undefined, {
      jiraTicketFetcher: async (reference) => ({
        sourceType: "jira-ticket",
        externalId: reference.key,
        title: "Import Jira tickets",
        body: "Create a planning task from a normalized Jira ticket snapshot.",
        url: reference.url,
        state: "In Progress",
        stateCategory: "indeterminate",
        updatedAt: "2026-07-14T02:00:00.000Z",
        reporter: "Product owner",
        assignees: ["Engineer"],
        labels: ["pilot"],
        comments: [{ author: "Reviewer", body: "Keep source provenance." }],
        attachments: [
          {
            id: "att-1",
            filename: "failure.log",
            mediaType: "text/plain",
            size: 42,
            url: `${reference.baseUrl}/rest/api/3/attachment/content/att-1`,
          },
        ],
        linkedIssues: [
          {
            relationship: "blocks",
            key: "ENG-99",
            title: "Repository setup",
            state: "Done",
            url: `${reference.baseUrl}/browse/ENG-99`,
          },
        ],
      }),
    });

    const response = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "jira-ticket",
        issue: "https://acme.atlassian.net/browse/ENG-123",
      }),
    });

    expect(response.status).toBe(201);
    const created = (await json(response)) as {
      task: {
        id: string;
        specPath: string;
        source?: {
          type?: string;
          externalId?: string;
          statusSync?: { enabled?: boolean };
          snapshot?: Record<string, unknown>;
        };
        planningArtifacts?: {
          spec?: { revisions?: Array<{ sourceInputs?: string[] }> };
        };
      };
      spec: string;
    };
    expect(created.task.source).toMatchObject({
      type: "jira-ticket",
      externalId: "ENG-123",
      statusSync: { enabled: false },
      snapshot: {
        externalId: "ENG-123",
        state: "In Progress",
        stateCategory: "indeterminate",
        reporter: "Product owner",
        assignees: ["Engineer"],
        labels: ["pilot"],
        comments: [{ author: "Reviewer", body: "Keep source provenance." }],
        attachments: [{ filename: "failure.log", size: 42 }],
        linkedIssues: [{ relationship: "blocks", key: "ENG-99" }],
      },
    });
    expect(created.spec).toContain(
      "Source: jira-ticket https://acme.atlassian.net/browse/ENG-123",
    );
    const sourcePath = `.nitely/tasks/${created.task.id}/execution/source.json`;
    expect(
      created.task.planningArtifacts?.spec?.revisions?.[0]?.sourceInputs,
    ).toContain(sourcePath);
    await expect(readFile(join(repoPath, sourcePath), "utf8")).resolves.toContain(
      '"externalId": "ENG-123"',
    );

    await writeRefinedSourceSpecificSpec(
      repoPath,
      created.task,
      "Import Jira tickets",
    );
    const approved = await fetch(
      `${server.url}/api/tasks/${created.task.id}/approve-spec`,
      { method: "POST" },
    );
    expect(approved.status).toBe(200);
    const designResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/draft-tech-design`,
      { method: "POST" },
    );
    expect(designResponse.status).toBe(200);
    const design = (await json(designResponse)) as {
      task: {
        planningArtifacts?: {
          techDesign?: { revisions?: Array<{ sourceInputs?: string[] }> };
        };
      };
      techDesign: string;
    };
    expect(design.techDesign).toContain(
      "Source snapshot:** jira-ticket · ENG-123 · https://acme.atlassian.net/browse/ENG-123",
    );
    expect(
      design.task.planningArtifacts?.techDesign?.revisions?.at(-1)?.sourceInputs,
    ).toContain(sourcePath);
  });

  it("reuses Jira tickets, records normalized drift, and refreshes planning", async () => {
    const repoPath = await createRepo();
    let changed = false;
    const server = await startTestServer(repoPath, undefined, undefined, {
      jiraTicketFetcher: async (reference) => ({
        sourceType: "jira-ticket",
        externalId: reference.key,
        title: changed ? "Updated Jira ticket" : "Original Jira ticket",
        body: changed
          ? "Updated Jira constraints with a new acceptance boundary."
          : "Original Jira constraints.",
        url: reference.url,
        state: changed ? "In Progress" : "To Do",
        stateCategory: changed ? "indeterminate" : "new",
        reporter: "Product owner",
        attachments: [
          {
            filename: changed ? "updated.log" : "original.log",
          },
        ],
        linkedIssues: [
          {
            relationship: changed ? "blocks" : "relates to",
            key: "ENG-9",
          },
        ],
      }),
    });
    const request = {
      sourceType: "jira-ticket",
      issue: "https://acme.atlassian.net/browse/ENG-124",
    };

    const firstResponse = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    changed = true;
    const secondResponse = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(200);
    const first = (await json(firstResponse)) as { task: { id: string } };
    const second = (await json(secondResponse)) as {
      task: {
        id: string;
        source?: {
          snapshot?: { title?: string };
          drift?: {
            status?: string;
            changedFields?: string[];
            latestSnapshot?: { title?: string };
          };
        };
      };
      ingestion?: { reused?: boolean; driftStatus?: string };
    };
    expect(second.task.id).toBe(first.task.id);
    expect(second.ingestion).toMatchObject({ reused: true, driftStatus: "changed" });
    expect(second.task.source?.snapshot?.title).toBe("Original Jira ticket");
    expect(second.task.source?.drift).toMatchObject({
      status: "changed",
      changedFields: expect.arrayContaining([
        "title",
        "body",
        "state",
        "stateCategory",
        "attachments",
        "linkedIssues",
      ]),
      latestSnapshot: { title: "Updated Jira ticket" },
    });
    const list = (await json(await fetch(`${server.url}/api/tasks`))) as {
      tasks: Array<{ id: string }>;
    };
    expect(list.tasks).toHaveLength(1);

    const refreshedResponse = await fetch(
      `${server.url}/api/tasks/${first.task.id}/refresh-source-planning`,
      { method: "POST" },
    );
    expect(refreshedResponse.status).toBe(200);
    const refreshed = (await json(refreshedResponse)) as {
      task: {
        source?: {
          type?: string;
          snapshot?: { title?: string };
          drift?: { status?: string; changedFields?: string[] };
        };
      };
      spec: string;
    };
    expect(refreshed.task.source).toMatchObject({
      type: "jira-ticket",
      snapshot: { title: "Updated Jira ticket" },
      drift: { status: "unchanged", changedFields: [] },
    });
    expect(refreshed.spec).toContain(
      "Updated Jira constraints with a new acceptance boundary.",
    );
  });

  it("surfaces Jira fetch permission failures through draft-spec intake", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, undefined, undefined, {
      jiraTicketFetcher: async () => {
        throw new Error(
          "Jira ticket could not be fetched because configured Jira credentials were rejected or do not have access.",
        );
      },
    });

    const response = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "jira-ticket",
        issue: "https://acme.atlassian.net/browse/ENG-125",
      }),
    });

    await expectWebInputError(
      response,
      "Jira ticket could not be fetched because configured Jira credentials were rejected or do not have access.",
    );
  });

  it("keeps identical Jira keys on different sites as separate planning tasks", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, undefined, undefined, {
      jiraTicketFetcher: async (reference) => ({
        sourceType: "jira-ticket",
        externalId: reference.key,
        title: `${reference.baseUrl} ${reference.key}`,
        body: "The Jira site is part of the stable source identity.",
        url: reference.url,
      }),
    });

    const createFrom = async (issue: string) =>
      await fetch(`${server.url}/api/draft-specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceType: "jira-ticket", issue }),
      });
    const first = await createFrom(
      "https://first-company.atlassian.net/browse/ENG-42",
    );
    const second = await createFrom(
      "https://second-company.atlassian.net/browse/ENG-42",
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = (await json(first)) as { task: { id: string } };
    const secondBody = (await json(second)) as { task: { id: string } };
    expect(secondBody.task.id).not.toBe(firstBody.task.id);
    const listed = (await json(await fetch(`${server.url}/api/tasks`))) as {
      tasks: Array<{ id: string }>;
    };
    expect(listed.tasks).toHaveLength(2);
  });

  it("keeps Jira status sync optional, idempotent, and retryable", async () => {
    const repoPath = await createRepo();
    const updates: Array<{ summary: string; links: Array<{ label: string; url: string }> }> = [];
    const notificationUpdates = () =>
      updates.filter((update) => update.summary.startsWith("[nitely-notification:"));
    const statusUpdates = () =>
      updates.filter((update) => !update.summary.startsWith("[nitely-notification:"));
    let failPublish = true;
    const server = await startTestServer(repoPath, undefined, undefined, {
      jiraTicketFetcher: async (reference) => ({
        sourceType: "jira-ticket",
        externalId: reference.key,
        title: `Status sync ${reference.key}`,
        body: "Publish bounded Nitely status back to Jira.",
        url: reference.url,
        state: "To Do",
      }),
      jiraStatusPublisher: async (_reference, update) => {
        updates.push(update);
        if (failPublish) {
          throw new Error("Jira status comment failed because comments are denied.");
        }
        return {
          id: `comment-${updates.length}`,
          url: `https://acme.atlassian.net/comment/${updates.length}`,
        };
      },
    });

    const createdResponse = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "jira-ticket",
        issue: "https://acme.atlassian.net/browse/ENG-126",
        syncStatus: true,
        publicBaseUrl: "https://nitely.example.test/",
      }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await json(createdResponse)) as {
      task: {
        id: string;
        source?: { statusSync?: { enabled?: boolean; lastError?: string } };
      };
      statusSync?: { synced?: boolean; error?: string };
    };
    expect(created.statusSync).toMatchObject({
      synced: false,
      error: "Jira status comment failed because comments are denied.",
    });
    expect(created.task.source?.statusSync).toMatchObject({
      enabled: true,
      lastError: "Jira status comment failed because comments are denied.",
    });
    expect(notificationUpdates()).toEqual([
      expect.objectContaining({
        summary: expect.stringContaining("Review draft spec"),
      }),
    ]);
    expect(statusUpdates()).toHaveLength(1);

    failPublish = false;
    const retryResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/sync-source-status`,
      { method: "POST" },
    );
    expect(retryResponse.status).toBe(200);
    const retried = (await json(retryResponse)) as {
      task: { source?: { statusSync?: { lastError?: string } } };
      statusSync?: { synced?: boolean; unchanged?: boolean };
    };
    expect(retried.statusSync).toEqual({
      synced: true,
      unchanged: false,
      commentUrl: "https://acme.atlassian.net/comment/3",
    });
    expect(retried.task.source?.statusSync?.lastError).toBeUndefined();
    expect(statusUpdates()[1]).toMatchObject({
      summary: expect.stringContaining("is draft"),
      links: expect.arrayContaining([
        {
          label: "Task",
          url: `https://nitely.example.test/tasks/${created.task.id}`,
        },
      ]),
    });

    const unchangedResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/sync-source-status`,
      { method: "POST" },
    );
    expect(unchangedResponse.status).toBe(200);
    await expect(json(unchangedResponse)).resolves.toMatchObject({
      statusSync: { synced: false, unchanged: true },
    });
    expect(statusUpdates()).toHaveLength(2);

    await updateTaskSpecApproval(repoPath, created.task.id, "approved");
    const planningResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/sync-source-status`,
      { method: "POST" },
    );
    expect(planningResponse.status).toBe(200);
    expect(statusUpdates()).toHaveLength(3);
    expect(statusUpdates()[2]?.summary).toContain(
      "spec is approved; technical design is draft",
    );

    await updateTaskRunState(repoPath, created.task.id, {
      status: "completed",
      latestRunId: "run-jira-status",
      changeRequestUrl: "https://github.com/example/repo/pull/7",
    });
    const completedResponse = await fetch(
      `${server.url}/api/tasks/${created.task.id}/sync-source-status`,
      { method: "POST" },
    );
    expect(completedResponse.status).toBe(200);
    expect(statusUpdates()).toHaveLength(4);
    expect(statusUpdates()[3]).toMatchObject({
      summary: expect.stringContaining("is completed"),
      links: expect.arrayContaining([
        {
          label: "Latest run",
          url: "https://nitely.example.test/runs/run-jira-status",
        },
        {
          label: "Change request",
          url: "https://github.com/example/repo/pull/7",
        },
      ]),
    });

    const disabledResponse = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "jira-ticket",
        issue: "https://acme.atlassian.net/browse/ENG-127",
      }),
    });
    const disabled = (await json(disabledResponse)) as { task: { id: string } };
    const denied = await fetch(
      `${server.url}/api/tasks/${disabled.task.id}/sync-source-status`,
      { method: "POST" },
    );
    await expectWebInputError(denied, "Jira status sync is disabled for this task");
    expect(statusUpdates()).toHaveLength(4);
  });

  it("redacts unexpected Jira publisher failures from manual sync responses", async () => {
    const repoPath = await createRepo();
    const secret = "publisher-internal-secret";
    const server = await startTestServer(repoPath, undefined, undefined, {
      jiraTicketFetcher: async (reference) => ({
        sourceType: "jira-ticket",
        externalId: reference.key,
        title: `Redacted sync ${reference.key}`,
        body: "Keep internal publisher failures out of API responses.",
        url: reference.url,
      }),
      jiraStatusPublisher: async () => {
        throw new Error(secret);
      },
    });

    const createdResponse = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "jira-ticket",
        issue: "https://acme.atlassian.net/browse/ENG-128",
        syncStatus: true,
        publicBaseUrl: "https://nitely.example.test",
      }),
    });
    const created = (await json(createdResponse)) as {
      task: { id: string };
      statusSync?: { error?: string };
    };
    expect(created.statusSync?.error).toBe(
      "Jira status sync failed; inspect provider configuration and retry",
    );

    const retry = await fetch(
      `${server.url}/api/tasks/${created.task.id}/sync-source-status`,
      { method: "POST" },
    );
    expect(retry.status).toBe(400);
    const retryBody = await json(retry);
    expect(retryBody).toMatchObject({
      error: {
        code: "invalid_input",
        message: "Jira status sync failed; inspect provider configuration and retry",
      },
    });
    expect(JSON.stringify(retryBody)).not.toContain(secret);
  });
});
