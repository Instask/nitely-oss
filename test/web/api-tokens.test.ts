import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  API_TOKEN_CAPABILITIES,
  apiTokenAuditPath,
  apiTokenStorePath,
  appendApiTokenRequestAudit,
  authenticateApiToken,
  createApiToken,
  listApiTokens,
  revokeApiToken,
} from "../../src/web/api-tokens.js";
import { apiTokenActionForRequest } from "../../src/web/api-token-auth.js";

async function createRepo(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "nitely-api-token-"));
}

async function readAudit(repoPath: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(apiTokenAuditPath(repoPath), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("scoped API tokens", () => {
  it("maps only the MCP slice onto explicit API capabilities", () => {
    expect([
      apiTokenActionForRequest("GET", "/api/flows"),
      apiTokenActionForRequest("GET", "/api/tasks"),
      apiTokenActionForRequest("GET", "/api/tasks/task%201"),
      apiTokenActionForRequest("POST", "/api/tasks"),
      apiTokenActionForRequest("POST", "/api/draft-specs"),
      apiTokenActionForRequest("POST", "/api/tasks/task-1/sync-source-status"),
      apiTokenActionForRequest("POST", "/api/tasks/task-1/draft-tech-design"),
      apiTokenActionForRequest(
        "POST",
        "/api/tasks/task-1/refresh-source-planning",
      ),
      apiTokenActionForRequest("POST", "/api/tasks/task-1/approve-spec"),
      apiTokenActionForRequest("POST", "/api/tasks/task-1/approve-tech-design"),
      apiTokenActionForRequest("POST", "/api/tasks/task-1/runs"),
      apiTokenActionForRequest("GET", "/api/tasks/task-1/rework-requests"),
      apiTokenActionForRequest(
        "GET",
        "/api/tasks/task-1/rework-requests/tcr_123",
      ),
      apiTokenActionForRequest("POST", "/api/tasks/task-1/rework-requests"),
      apiTokenActionForRequest(
        "POST",
        "/api/tasks/task-1/rework-requests/tcr_123/confirm",
      ),
      apiTokenActionForRequest(
        "POST",
        "/api/tasks/task-1/rework-requests/tcr_123/cancel",
      ),
      apiTokenActionForRequest("GET", "/api/runs"),
      apiTokenActionForRequest("GET", "/api/runs/run%201"),
      apiTokenActionForRequest("GET", "/api/runs/run%201/logs/stream"),
      apiTokenActionForRequest("GET", "/api/preview-sessions"),
      apiTokenActionForRequest("POST", "/api/preview-sessions"),
      apiTokenActionForRequest(
        "GET",
        "/api/preview-sessions/pvs_1111111111111111",
      ),
      apiTokenActionForRequest(
        "GET",
        "/api/preview-sessions/pvs_1111111111111111/diagnostics",
      ),
      apiTokenActionForRequest(
        "GET",
        "/api/preview-sessions/pvs_1111111111111111/hierarchy",
      ),
      apiTokenActionForRequest(
        "POST",
        "/api/preview-sessions/pvs_1111111111111111/restart",
      ),
      apiTokenActionForRequest(
        "POST",
        "/api/preview-sessions/pvs_1111111111111111/attach-screenshot",
      ),
      apiTokenActionForRequest(
        "POST",
        "/api/preview-sessions/pvs_1111111111111111/compare-reference",
      ),
    ]).toEqual([
      { action: "flows.list", capability: "tasks:read" },
      { action: "tasks.list", capability: "tasks:read" },
      {
        action: "tasks.get",
        capability: "tasks:read",
        target: { taskId: "task 1" },
      },
      { action: "tasks.create", capability: "tasks:write" },
      { action: "specs.draft", capability: "tasks:write" },
      {
        action: "source-status.sync",
        capability: "tasks:write",
        target: { taskId: "task-1" },
      },
      {
        action: "tech-designs.draft",
        capability: "tasks:write",
        target: { taskId: "task-1" },
      },
      {
        action: "source-planning.refresh",
        capability: "tasks:write",
        target: { taskId: "task-1" },
      },
      {
        action: "specs.approve",
        capability: "spec:approve",
        target: { taskId: "task-1" },
      },
      {
        action: "tech-designs.approve",
        capability: "spec:approve",
        target: { taskId: "task-1" },
      },
      {
        action: "runs.start",
        capability: "runs:start",
        target: { taskId: "task-1" },
      },
      {
        action: "task-rework-requests.list",
        capability: "tasks:read",
        target: { taskId: "task-1" },
      },
      {
        action: "task-rework-requests.get",
        capability: "tasks:read",
        target: { taskId: "task-1" },
      },
      {
        action: "task-rework-requests.create",
        capability: "runs:start",
        target: { taskId: "task-1" },
      },
      {
        action: "task-rework-requests.confirm",
        capability: "runs:start",
        target: { taskId: "task-1" },
      },
      {
        action: "task-rework-requests.cancel",
        capability: "runs:start",
        target: { taskId: "task-1" },
      },
      { action: "runs.list", capability: "runs:read" },
      {
        action: "runs.get",
        capability: "runs:read",
        target: { runId: "run 1" },
      },
      {
        action: "runs.logs.stream",
        capability: "runs:read",
        target: { runId: "run 1" },
      },
      { action: "preview.sessions.list", capability: "preview:read" },
      { action: "preview.sessions.start", capability: "preview:control" },
      {
        action: "preview.sessions.get",
        capability: "preview:read",
        target: { previewSessionId: "pvs_1111111111111111" },
      },
      {
        action: "preview.diagnostics.get",
        capability: "preview:read",
        target: { previewSessionId: "pvs_1111111111111111" },
      },
      {
        action: "preview.hierarchy.get",
        capability: "preview:read",
        target: { previewSessionId: "pvs_1111111111111111" },
      },
      {
        action: "preview.sessions.control",
        capability: "preview:control",
        target: { previewSessionId: "pvs_1111111111111111" },
      },
      {
        action: "preview.screenshot.attach",
        capability: "preview:compare",
        target: { previewSessionId: "pvs_1111111111111111" },
      },
      {
        action: "preview.compare",
        capability: "preview:compare",
        target: { previewSessionId: "pvs_1111111111111111" },
      },
    ]);
    expect(apiTokenActionForRequest("GET", "/api/providers")).toBeNull();
    expect(apiTokenActionForRequest("POST", "/api/flows")).toBeNull();
    expect(
      apiTokenActionForRequest("GET", "/api/flows/flows%2Fimplement.json"),
    ).toBeNull();
    expect(apiTokenActionForRequest("GET", "/api/preview-sessions/pvs_1/proxy/app")).toBeNull();
    expect(
      apiTokenActionForRequest(
        "POST",
        "/api/preview-sessions/pvs_1/proxy/app",
      ),
    ).toBeNull();
    expect(apiTokenActionForRequest("DELETE", "/api/tasks/task-1")).toBeNull();
  });

  it("creates a one-time secret while persisting only a verifier and safe grants", async () => {
    const repoPath = await createRepo();
    const created = await createApiToken(repoPath, {
      name: "Claude Code",
      capabilities: ["tasks:read", "runs:read"],
      ownerUserId: "usr_owner",
      now: () => new Date("2026-07-14T05:00:00.000Z"),
    });

    expect(created.token).toMatch(/^nitely_api_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/);
    expect(created.record).toMatchObject({
      name: "Claude Code",
      capabilities: ["tasks:read", "runs:read"],
      createdAt: "2026-07-14T05:00:00.000Z",
    });
    expect(created.record).not.toHaveProperty("tokenHash");

    const stored = await readFile(apiTokenStorePath(repoPath), "utf8");
    expect(stored).not.toContain(created.token);
    // The token is `nitely_api_<16>_<43>` and both halves are base64url, so the
    // secret has to be taken by its fixed length: splitting on "_" can land on
    // a one-character tail that any JSON document contains by chance.
    expect(stored).not.toContain(created.token.slice(-43));
    expect(JSON.parse(stored)).toMatchObject({
      version: 1,
      tokens: {
        [created.record.id]: {
          id: created.record.id,
          name: "Claude Code",
          capabilities: ["tasks:read", "runs:read"],
          tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
    expect((await stat(apiTokenStorePath(repoPath))).mode & 0o777).toBe(0o600);

    await expect(authenticateApiToken(repoPath, created.token)).resolves.toEqual(
      created.record,
    );
    await expect(
      authenticateApiToken(repoPath, `${created.token}x`),
    ).resolves.toBeNull();
    await expect(listApiTokens(repoPath)).resolves.toEqual([created.record]);

    const audit = await readAudit(repoPath);
    expect(audit).toEqual([
      expect.objectContaining({
        version: 1,
        event: "token.created",
        tokenId: created.record.id,
        tokenName: "Claude Code",
        capabilities: ["tasks:read", "runs:read"],
        createdAt: "2026-07-14T05:00:00.000Z",
        ownerUserId: "usr_owner",
      }),
    ]);
    expect(JSON.stringify(audit)).not.toContain(created.token);
    expect((await stat(apiTokenAuditPath(repoPath))).mode & 0o777).toBe(0o600);
  });

  it("requires explicit grants and confirmation for every high-impact capability", async () => {
    const repoPath = await createRepo();
    await expect(
      createApiToken(repoPath, {
        name: "unsafe\nname",
        capabilities: ["tasks:read"],
        ownerUserId: "usr_owner",
      }),
    ).rejects.toThrow("API token name must be 1-80 printable characters");
    await expect(
      createApiToken(repoPath, {
        name: "empty",
        capabilities: [],
        ownerUserId: "usr_owner",
      }),
    ).rejects.toThrow("at least one capability is required");

    for (const capability of [
      "tasks:write",
      "runs:start",
      "spec:approve",
      "preview:control",
      "preview:compare",
    ] as const) {
      await expect(
        createApiToken(repoPath, {
          name: capability,
          capabilities: [capability],
          ownerUserId: "usr_owner",
        }),
      ).rejects.toThrow(`high-impact capability requires confirmation: ${capability}`);
    }

    const created = await createApiToken(repoPath, {
      name: "operator",
      capabilities: ["runs:start", "runs:start", "tasks:read"],
      ownerUserId: "usr_owner",
      allowHighImpact: true,
    });
    expect(created.record.capabilities).toEqual(["tasks:read", "runs:start"]);
    expect(API_TOKEN_CAPABILITIES).toEqual([
      "tasks:read",
      "tasks:write",
      "runs:read",
      "runs:start",
      "spec:approve",
      "preview:read",
      "preview:control",
      "preview:compare",
    ]);
  });

  it("revokes without returning secrets and records metadata-only request outcomes", async () => {
    const repoPath = await createRepo();
    const created = await createApiToken(repoPath, {
      name: "Cursor",
      capabilities: ["runs:read"],
      ownerUserId: "usr_owner",
      now: () => new Date("2026-07-14T05:10:00.000Z"),
    });

    await appendApiTokenRequestAudit(repoPath, {
      tokenId: created.record.id,
      tokenName: created.record.name,
      action: "runs.get",
      capability: "runs:read",
      target: { runId: "run-123" },
      decision: "allow",
      outcome: "error",
      httpStatus: 404,
      reasonCode: "not_found",
      createdAt: "2026-07-14T05:11:00.000Z",
    });
    const revoked = await revokeApiToken(repoPath, created.record.id, {
      now: () => new Date("2026-07-14T05:12:00.000Z"),
    });

    expect(revoked).toMatchObject({
      id: created.record.id,
      revokedAt: "2026-07-14T05:12:00.000Z",
    });
    expect(revoked).not.toHaveProperty("tokenHash");
    await expect(authenticateApiToken(repoPath, created.token)).resolves.toBeNull();
    await expect(revokeApiToken(repoPath, "tok_missing")).rejects.toThrow(
      "API token not found",
    );

    const audit = await readAudit(repoPath);
    expect(audit).toEqual([
      expect.objectContaining({ event: "token.created" }),
      expect.objectContaining({
        event: "token.request",
        tokenId: created.record.id,
        action: "runs.get",
        capability: "runs:read",
        target: { runId: "run-123" },
        decision: "allow",
        outcome: "error",
        httpStatus: 404,
        reasonCode: "not_found",
      }),
      expect.objectContaining({
        event: "token.revoked",
        tokenId: created.record.id,
        createdAt: "2026-07-14T05:12:00.000Z",
      }),
    ]);
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(created.token);
    expect(serialized).not.toContain("Authorization");
  });

  it("requires an owner when minting and round-trips it through the store", async () => {
    const repoPath = await createRepo();
    await expect(
      createApiToken(repoPath, {
        name: "no owner",
        capabilities: ["tasks:read"],
        ownerUserId: "   ",
      }),
    ).rejects.toThrow("API token owner is required");

    const created = await createApiToken(repoPath, {
      name: "owned",
      capabilities: ["tasks:read"],
      ownerUserId: "usr_owner",
    });
    expect(created.record.ownerUserId).toBe("usr_owner");

    const [listed] = await listApiTokens(repoPath);
    expect(listed.ownerUserId).toBe("usr_owner");

    const authenticated = await authenticateApiToken(repoPath, created.token);
    expect(authenticated?.ownerUserId).toBe("usr_owner");

    const stored = JSON.parse(await readFile(apiTokenStorePath(repoPath), "utf8")) as {
      tokens: Record<string, { ownerUserId?: string }>;
    };
    expect(stored.tokens[created.record.id].ownerUserId).toBe("usr_owner");
  });

  it("still lists a legacy record that has no owner", async () => {
    const repoPath = await createRepo();
    const created = await createApiToken(repoPath, {
      name: "legacy",
      capabilities: ["tasks:read"],
      ownerUserId: "usr_owner",
    });
    const path = apiTokenStorePath(repoPath);
    const file = JSON.parse(await readFile(path, "utf8")) as {
      tokens: Record<string, Record<string, unknown>>;
    };
    delete file.tokens[created.record.id].ownerUserId;
    await writeFile(path, JSON.stringify(file));

    const [listed] = await listApiTokens(repoPath);
    expect(listed.id).toBe(created.record.id);
    expect(listed.ownerUserId).toBeUndefined();
  });
});
