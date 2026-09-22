import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { KnowledgeRetrievalResult } from "../../src/knowledge-repositories/retrieval.js";
import type {
  KnowledgeRepositoryAttachment,
  KnowledgeRepositoryStatus,
} from "../../src/knowledge-repositories/schema.js";
import type { KnowledgeRepositoryView } from "../../src/knowledge-repositories/service.js";
import {
  startWebServer,
  type StartWebServerInput,
  type WebServer,
} from "../../src/web/server.js";
import { createApiToken } from "../../src/web/api-tokens.js";
import { updateTaskSpecApproval } from "../../src/web/tasks.js";
import { createUser } from "../../src/web/users.js";
import { createWorkItem } from "../../src/work-items/store.js";
import { createTokenOwner } from "../helpers/token-owner.js";

const servers: WebServer[] = [];
const repositories: string[] = [];
const commitSha = "a".repeat(40);
const citation = `kb://platform-standards/${commitSha}/docs/testing.md#L8-L12`;

async function createRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-web-knowledge-"));
  repositories.push(repoPath);
  await mkdir(join(repoPath, "flows"), { recursive: true });
  await writeFile(
    join(repoPath, "flows/implement-spec-bootstrap.json"),
    JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "implement-spec-bootstrap" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement the approved plan.",
            inputs: ["spec", "tech-design"],
            outputs: ["implementation"],
          },
        ],
      },
    }),
    "utf8",
  );
  return repoPath;
}

async function startTestServer(
  repoPath: string,
  options: Partial<StartWebServerInput> = {},
): Promise<WebServer> {
  const server = await startWebServer({
    repoPath,
    host: "127.0.0.1",
    port: 0,
    providerCommandStatus: async () => false,
    ...options,
    repositories: [
      { id: "home", name: "home", path: repoPath },
      ...(options.repositories ?? []),
    ],
  });
  servers.push(server);
  return server;
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function login(
  server: WebServer,
  email: string,
  password: string,
): Promise<string> {
  const response = await fetch(`${server.url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

function knowledgeFixture(): {
  attachment: KnowledgeRepositoryAttachment;
  status: KnowledgeRepositoryStatus;
  view: KnowledgeRepositoryView;
  queryResult: KnowledgeRetrievalResult;
} {
  const attachment: KnowledgeRepositoryAttachment = {
    id: "platform-standards",
    name: "Platform standards",
    source: { type: "local", path: "/private/knowledge/platform-standards" },
    ref: { type: "branch", value: "main" },
    paths: { include: ["docs/**"], exclude: [] },
    enabled: true,
    required: false,
    refreshPolicy: { mode: "manual" },
    budgets: {
      maxFiles: 5_000,
      maxFileBytes: 512 * 1024,
      maxTotalBytes: 64 * 1024 * 1024,
      maxChunks: 50_000,
      chunkTokens: 600,
      chunkOverlapTokens: 80,
      topK: 6,
      maxPromptTokens: 2_000,
    },
    retrieval: {
      mode: "hybrid",
      providerId: "local-hash",
      model: "unicode-hash-v1",
    },
    createdBy: "local",
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    generation: 1,
    refreshGeneration: 1,
  };
  const status: KnowledgeRepositoryStatus = {
    version: 1,
    attachmentId: attachment.id,
    state: "ready",
    retrievalMode: "hybrid",
    currentSnapshot: {
      snapshotId: "snapshot-platform-standards",
      commitSha,
      indexDigest: "sha256:index-digest",
      indexPath: "/private/runtime/indexes/platform-standards.json",
      attachmentFingerprint: "sha256:attachment",
      policyFingerprint: "sha256:policy",
      chunkerVersion: "knowledge-chunker-v1",
      providerId: "local-hash",
      model: "unicode-hash-v1",
      providerConfigurationDigest: "sha256:" + "1".repeat(64),
      fileCount: 1,
      chunkCount: 1,
      completedAt: "2026-07-21T00:01:00.000Z",
      refreshGeneration: 1,
    },
    lastAttemptAt: "2026-07-21T00:01:00.000Z",
    lastSuccessfulRefreshAt: "2026-07-21T00:01:00.000Z",
    staleReasons: [],
    refreshGeneration: 1,
  };
  const queryResult: KnowledgeRetrievalResult = {
    queryDigest: "hmac-sha256:query",
    mode: "lexical-hash",
    matches: [
      {
        rank: 1,
        chunkId: "chunk-1",
        attachmentId: attachment.id,
        attachmentName: attachment.name,
        snapshotId: status.currentSnapshot!.snapshotId,
        indexDigest: status.currentSnapshot!.indexDigest,
        commitSha,
        path: "docs/testing.md",
        startLine: 8,
        endLine: 12,
        contentDigest: "sha256:content",
        citation,
        text: "All changes must include focused regression tests.",
        approxTokens: 10,
        lexicalScore: 1,
        vectorScore: 0.5,
        semanticScore: 0,
        fusedScore: 1.5,
        combinedScore: 1.5,
        providerId: "local-hash",
        model: "unicode-hash-v1",
        providerConfigurationDigest:
          status.currentSnapshot!.providerConfigurationDigest,
        provider: "local-hash",
      },
    ],
    degradedAttachmentIds: [],
    warnings: [],
    selectedCount: 1,
    truncatedCount: 0,
    approxTokens: 10,
  };
  return { attachment, status, view: { attachment, status }, queryResult };
}

function mockKnowledgeService() {
  const fixture = knowledgeFixture();
  const service: NonNullable<StartWebServerInput["knowledgeRepositoryService"]> = {
    attach: vi.fn(async () => fixture.view),
    list: vi.fn(async () => [fixture.view]),
    status: vi.fn(async () => fixture.view),
    refresh: vi.fn(async () => fixture.status),
    query: vi.fn(async () => fixture.queryResult),
    detach: vi.fn(async () => fixture.attachment),
  };
  return { ...fixture, service };
}

describe("knowledge repository Web API", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(
      repositories.splice(0).map((repoPath) =>
        rm(repoPath, { recursive: true, force: true })
      ),
    );
    vi.restoreAllMocks();
  });

  it("lets a local admin manage and query attachments without exposing runtime paths", async () => {
    const repoPath = await createRepo();
    const { service } = mockKnowledgeService();
    const server = await startTestServer(repoPath, {
      knowledgeRepositoryService: service,
    });

    const requests = [
      await fetch(`${server.url}/api/knowledge-repositories`),
      await fetch(`${server.url}/api/knowledge-repositories`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attachment: {
            id: "platform-standards",
            name: "Platform standards",
            source: { type: "local", path: "/private/knowledge/platform-standards" },
            ref: { type: "branch", value: "main" },
          },
        }),
      }),
      await fetch(`${server.url}/api/knowledge-repositories/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "testing requirements", topK: 3 }),
      }),
      await fetch(
        `${server.url}/api/knowledge-repositories/platform-standards/status`,
      ),
      await fetch(
        `${server.url}/api/knowledge-repositories/platform-standards/refresh`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      ),
      await fetch(`${server.url}/api/knowledge-repositories/platform-standards`, {
        method: "DELETE",
      }),
    ];

    expect(requests.map((response) => response.status)).toEqual([
      200, 201, 200, 200, 200, 200,
    ]);
    const bodies = await Promise.all(requests.map(responseJson));
    expect(bodies[2]).toMatchObject({
      result: {
        queryDigest: "hmac-sha256:query",
        matches: [{
          citation,
          attachmentName: "Platform standards",
          snapshotId: "snapshot-platform-standards",
          indexDigest: "sha256:index-digest",
          providerId: "local-hash",
          model: "unicode-hash-v1",
        }],
      },
    });
    for (const body of bodies) {
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("/private/knowledge/platform-standards");
      expect(serialized).not.toContain("/private/runtime/indexes");
      expect(serialized).not.toContain("indexPath");
    }
    expect(service.attach).toHaveBeenCalledOnce();
    expect(service.list).toHaveBeenCalledTimes(2);
    expect(service.query).toHaveBeenCalledOnce();
    expect(service.status).toHaveBeenCalledTimes(3);
    expect(service.refresh).toHaveBeenCalledOnce();
    expect(service.detach).toHaveBeenCalledOnce();
  });

  it("rejects every knowledge management operation for a non-admin user", async () => {
    const repoPath = await createRepo();
    await createUser(repoPath, {
      email: "member@example.test",
      password: "member password passphrase",
      role: "user",
    });
    const { service } = mockKnowledgeService();
    const server = await startTestServer(repoPath, {
      authMode: "required",
      authEnv: {},
      knowledgeRepositoryService: service,
    });
    const cookie = await login(
      server,
      "member@example.test",
      "member password passphrase",
    );
    const jsonHeaders = {
      cookie,
      "content-type": "application/json",
    };
    const requests = await Promise.all([
      fetch(`${server.url}/api/knowledge-repositories`, { headers: { cookie } }),
      fetch(`${server.url}/api/knowledge-repositories`, {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      }),
      fetch(`${server.url}/api/knowledge-repositories/query`, {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      }),
      fetch(`${server.url}/api/knowledge-repositories/platform-standards/status`, {
        headers: { cookie },
      }),
      fetch(`${server.url}/api/knowledge-repositories/platform-standards/refresh`, {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      }),
      fetch(`${server.url}/api/knowledge-repositories/platform-standards`, {
        method: "DELETE",
        headers: { cookie },
      }),
    ]);

    for (const response of requests) {
      expect(response.status).toBe(403);
      await expect(responseJson(response)).resolves.toMatchObject({
        error: { code: "forbidden" },
      });
    }
    expect(service.attach).not.toHaveBeenCalled();
    expect(service.list).not.toHaveBeenCalled();
    expect(service.status).not.toHaveBeenCalled();
    expect(service.refresh).not.toHaveBeenCalled();
    expect(service.query).not.toHaveBeenCalled();
    expect(service.detach).not.toHaveBeenCalled();
  });

  it("does not let non-admin planning paths query optional or required knowledge", async () => {
    const repoPath = await createRepo();
    await createUser(repoPath, {
      email: "member@example.test",
      password: "member password passphrase",
      role: "user",
    });
    const { attachment, service } = mockKnowledgeService();
    const server = await startTestServer(repoPath, {
      authMode: "required",
      authEnv: {},
      knowledgeRepositoryService: service,
    });
    const cookie = await login(
      server,
      "member@example.test",
      "member password passphrase",
    );
    const optionalResponse = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "prompt",
        title: "Optional guidance",
        prompt: "Draft without privileged knowledge.",
      }),
    });
    expect(optionalResponse.status).toBe(201);
    expect(service.query).not.toHaveBeenCalled();

    attachment.required = true;
    const requiredResponse = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "prompt",
        title: "Required guidance",
        prompt: "Draft with required privileged knowledge.",
      }),
    });
    expect(requiredResponse.status).toBe(403);
    await expect(responseJson(requiredResponse)).resolves.toMatchObject({
      error: { code: "forbidden" },
    });
    expect(service.query).not.toHaveBeenCalled();
  });

  it("does not let an admin-owned API token bypass required knowledge either", async () => {
    const repoPath = await createRepo();
    const owner = await createTokenOwner(repoPath);
    const { attachment, service } = mockKnowledgeService();
    attachment.required = true;
    const created = await createApiToken(repoPath, {
      name: "admin token",
      capabilities: ["tasks:write"],
      ownerUserId: owner.id,
      allowHighImpact: true,
    });
    const server = await startTestServer(repoPath, {
      authMode: "required",
      authEnv: {},
      knowledgeRepositoryService: service,
    });

    // The token's owner is an admin, but a token is not the interactive
    // session this admin-only surface is reserved for.
    const requiredResponse = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sourceType: "prompt",
        title: "Required guidance",
        prompt: "Draft with required privileged knowledge.",
      }),
    });
    expect(requiredResponse.status).toBe(403);
    await expect(responseJson(requiredResponse)).resolves.toMatchObject({
      error: {
        message: "administrator access is required to use required external knowledge",
      },
    });
    expect(service.query).not.toHaveBeenCalled();
  });

  it("does not let an admin-owned API token bypass the run-start knowledge gate either", async () => {
    // POST /api/tasks/:id/runs only reaches requireWebKnowledgeRunAccess for
    // an id that is NOT a "task" record (getScopedTask fails closed and the
    // handler falls back to the generic runStoredWorkItem path, which is the
    // one that gates on external knowledge). A real task's dedicated run-start
    // branch does not call this gate at all, so a generic work item is the
    // only fixture that reaches it through this endpoint.
    const repoPath = await createRepo();
    await mkdir(join(repoPath, "seeds"), { recursive: true });
    await writeFile(
      join(repoPath, "seeds/knowledge-run.json"),
      '{"keyword":"knowledge"}',
      "utf8",
    );
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    await writeFile(
      join(repoPath, ".nitely", "work-item-policy.json"),
      JSON.stringify({ allowedTypes: ["autofarm.site"] }),
      "utf8",
    );
    await writeFile(
      join(repoPath, "flows/autofarm-knowledge.json"),
      JSON.stringify({
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: {
          name: "autofarm-knowledge",
          workItemType: "autofarm.site",
          inputs: [{ id: "seed", type: "keyword-seed" }],
        },
        spec: {
          stages: [
            {
              id: "implement",
              type: "agent",
              runtime: "mock",
              prompt: "Use available guidance.",
              inputs: ["seed"],
              outputs: ["keyword-set"],
              context: { externalKnowledge: true },
              // "autofarm.site" is high-risk and requires an explicit (even
              // if all-default) capability policy on every agent stage.
              capabilities: {},
            },
            // "autofarm.site" is a governed work item type that requires
            // these named approval gates regardless of the rest of the flow.
            { id: "approve-plan", type: "approval", prompt: "Approve", inputs: [], outputs: [] },
            { id: "approve-preview", type: "approval", prompt: "Approve", inputs: [], outputs: [] },
          ],
        },
      }),
      "utf8",
    );
    const owner = await createTokenOwner(repoPath);
    const { service } = mockKnowledgeService();
    const created = await createApiToken(repoPath, {
      name: "admin token",
      capabilities: ["tasks:write", "runs:start"],
      ownerUserId: owner.id,
      allowHighImpact: true,
    });
    const server = await startTestServer(repoPath, {
      authMode: "required",
      authEnv: {},
      knowledgeRepositoryService: service,
    });
    const workItem = await createWorkItem(repoPath, {
      title: "Needs external knowledge",
      workItemType: "autofarm.site",
      flowPath: "flows/autofarm-knowledge.json",
      inputs: {
        seed: { connector: "local-file", uri: "seeds/knowledge-run.json" },
      },
    });

    const runResponse = await fetch(
      `${server.url}/api/tasks/${workItem.id}/runs`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${created.token}`,
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    expect(runResponse.status).toBe(403);
    await expect(responseJson(runResponse)).resolves.toMatchObject({
      error: {
        message: "administrator access is required to run Flows with external knowledge",
      },
    });
  });

  it("fails planning when required knowledge is disabled", async () => {
    const repoPath = await createRepo();
    const { attachment, service } = mockKnowledgeService();
    attachment.required = true;
    attachment.enabled = false;
    const server = await startTestServer(repoPath, {
      knowledgeRepositoryService: service,
    });

    const response = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "prompt",
        title: "Required guidance",
        prompt: "Draft with required guidance.",
      }),
    });

    expect(response.status).toBe(400);
    await expect(responseJson(response)).resolves.toMatchObject({
      error: { message: "required external knowledge is unavailable" },
    });
    expect(service.query).not.toHaveBeenCalled();
  });

  it("rejects ambiguous attachment input instead of weakening policy", async () => {
    const repoPath = await createRepo();
    const { service } = mockKnowledgeService();
    const server = await startTestServer(repoPath, {
      knowledgeRepositoryService: service,
    });
    const base = {
      id: "platform-standards",
      name: "Platform standards",
      source: { type: "local", path: "/private/knowledge/platform-standards" },
      ref: "main",
    };
    const invalidAttachments = [
      { ...base, source: "" },
      { ...base, source: "http://github.com/example/standards.git" },
      { ...base, source: { type: "s3", path: "/private/knowledge" } },
      { ...base, refType: "release" },
      { ...base, required: "true" },
      { ...base, enabled: "false" },
    ];

    for (const attachment of invalidAttachments) {
      const response = await fetch(`${server.url}/api/knowledge-repositories`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attachment }),
      });
      expect(response.status).toBe(400);
    }
    expect(service.attach).not.toHaveBeenCalled();
  });

  it("does not expose source paths from repository service failures", async () => {
    const repoPath = await createRepo();
    const { service } = mockKnowledgeService();
    service.attach = vi.fn(async () => {
      throw new Error("ENOENT while resolving /private/secrets/knowledge-repo");
    });
    const server = await startTestServer(repoPath, {
      knowledgeRepositoryService: service,
    });
    const response = await fetch(`${server.url}/api/knowledge-repositories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attachment: {
          id: "platform-standards",
          name: "Platform standards",
          source: { type: "local", path: "/private/secrets/knowledge-repo" },
          ref: { type: "branch", value: "main" },
        },
      }),
    });
    expect(response.status).toBe(400);
    const serialized = JSON.stringify(await responseJson(response));
    expect(serialized).not.toContain("/private/secrets/knowledge-repo");
    expect(serialized).toContain("knowledge repository attach failed");
  });

  it("returns forbidden when a GitHub credential is scoped to another repository", async () => {
    const repoPath = await createRepo();
    const fixture = knowledgeFixture();
    const remoteView: KnowledgeRepositoryView = {
      ...fixture.view,
      attachment: {
        ...fixture.attachment,
        source: {
          type: "remote",
          providerId: "github",
          url: "https://github.com/example/platform-standards.git",
        },
      },
    };
    const { service } = mockKnowledgeService();
    service.status = vi.fn(async () => remoteView);
    const server = await startTestServer(repoPath, {
      providerStore: {
        getConnection: vi.fn(async () => {
          throw new Error("credential resolution must not run after scope denial");
        }),
        resolveEnv: vi.fn(async () => ({})),
        listStatuses: vi.fn(async () => [{
          id: "github" as const,
          name: "GitHub",
          configured: true,
          message: "configured",
          hints: [],
          reconnectRequired: false,
          authMethods: [],
          credential: {
            scope: "repo" as const,
            source: "web-console" as const,
            repositoryId: "another-repository",
          },
        }]),
      },
      knowledgeRepositoryService: service,
    });

    const attachResponse = await fetch(`${server.url}/api/knowledge-repositories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attachment: {
          id: "platform-standards",
          name: "Platform standards",
          source: "https://github.com/example/platform-standards.git",
          ref: { type: "branch", value: "main" },
        },
      }),
    });
    const refreshResponse = await fetch(
      `${server.url}/api/knowledge-repositories/platform-standards/refresh`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );

    for (const response of [attachResponse, refreshResponse]) {
      expect(response.status).toBe(403);
      await expect(responseJson(response)).resolves.toMatchObject({
        error: { code: "forbidden" },
      });
    }
    expect(service.attach).not.toHaveBeenCalled();
    expect(service.refresh).not.toHaveBeenCalled();
  });

  it("fails closed when scoped GitHub credential metadata is incomplete", async () => {
    const repoPath = await createRepo();
    const { service } = mockKnowledgeService();
    const server = await startTestServer(repoPath, {
      providerStore: {
        getConnection: vi.fn(async () => {
          throw new Error("credential resolution must not run without scope identity");
        }),
        resolveEnv: vi.fn(async () => ({})),
        listStatuses: vi.fn(async () => [{
          id: "github" as const,
          name: "GitHub",
          configured: true,
          message: "configured",
          hints: [],
          reconnectRequired: false,
          authMethods: [],
          credential: {
            scope: "repo" as const,
            source: "web-console" as const,
          },
        }]),
      },
      knowledgeRepositoryService: service,
    });

    const response = await fetch(`${server.url}/api/knowledge-repositories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attachment: {
          id: "platform-standards",
          name: "Platform standards",
          source: "https://github.com/example/platform-standards.git",
          ref: { type: "branch", value: "main" },
        },
      }),
    });

    expect(response.status).toBe(403);
    expect(service.attach).not.toHaveBeenCalled();
  });

  it("injects retrieved passages and immutable citations into draft spec and design", async () => {
    const repoPath = await createRepo();
    const secret = "web-knowledge-runtime-secret";
    const { queryResult, service } = mockKnowledgeService();
    queryResult.matches[0]!.text =
      `All changes must include focused tests. token=${secret}`;
    const server = await startTestServer(repoPath, {
      knowledgeRepositoryService: service,
      providerStore: {
        getConnection: vi.fn(async () => {
          throw new Error("not needed for local knowledge");
        }),
        resolveEnv: vi.fn(async () => ({ GITHUB_TOKEN: secret })),
        listStatuses: vi.fn(async () => []),
      },
    });

    const specResponse = await fetch(`${server.url}/api/draft-specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceType: "prompt",
        title: "Require regression tests",
        prompt: "Generate a delivery spec for the repository testing policy.",
      }),
    });
    expect(specResponse.status).toBe(201);
    const specBody = await responseJson(specResponse) as {
      task: { id: string };
      spec: string;
      externalKnowledge: Array<{ citation: string }>;
    };
    expect(specBody.spec).toContain("## Knowledge Sources");
    expect(specBody.spec).toContain(citation);
    expect(specBody.spec).not.toContain(secret);
    expect(specBody.externalKnowledge).toEqual([{ citation }]);

    await updateTaskSpecApproval(repoPath, specBody.task.id, "approved");
    const designResponse = await fetch(
      `${server.url}/api/tasks/${encodeURIComponent(specBody.task.id)}/draft-tech-design`,
      { method: "POST" },
    );
    expect(designResponse.status).toBe(200);
    const designBody = await responseJson(designResponse) as {
      techDesign: string;
      externalKnowledge: Array<{ citation: string }>;
    };
    expect(designBody.techDesign).toContain("## Knowledge Sources");
    expect(designBody.techDesign).toContain(citation);
    expect(designBody.externalKnowledge).toEqual([{ citation }]);
    expect(service.query).toHaveBeenCalledTimes(2);
    expect(service.query).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        targetRepoPath: repoPath,
        query: expect.stringContaining("repository testing policy"),
        topK: 6,
        maxPromptTokens: 1_800,
        allowDegraded: true,
      }),
      expect.objectContaining({ redactionSecrets: expect.any(Array) }),
    );
  });
});
