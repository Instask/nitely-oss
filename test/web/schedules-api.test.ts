import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { materializeDueSchedules } from "../../src/schedules/materialize.js";
import { listScheduleOccurrences, listSchedules } from "../../src/schedules/store.js";
import { listSecurityAuditEvents } from "../../src/web/security-audit.js";
import { startWebServer, type StartWebServerInput, type WebServer } from "../../src/web/server.js";
import { listTasks, updateTaskRunState } from "../../src/web/tasks.js";

const servers: WebServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function createRepo() {
  const repo = await mkdtemp(join(tmpdir(), "nitely-schedules-api-"));
  await mkdir(join(repo, "flows"), { recursive: true });
  await writeFile(
    join(repo, "flows/implement-spec-bootstrap.json"),
    JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "implement-spec-bootstrap" },
      spec: {
        stages: [
          { id: "build", type: "command", command: "true", inputs: [], outputs: ["out"] },
        ],
      },
    }),
    "utf8",
  );
  return repo;
}

async function start(repoPath: string, options: Partial<StartWebServerInput> = {}) {
  const server = await startWebServer({
    repoPath,
    host: "127.0.0.1",
    port: 0,
    providerEnv: {},
    providerCommandStatus: async () => false,
    readRepositoryOrigin: async () => undefined,
    repositories: [{ id: "home", name: "home", path: repoPath }],
    ...options,
  });
  servers.push(server);
  return server;
}

async function json(response: Response): Promise<any> {
  return await response.json();
}

async function call(server: WebServer, method: string, path: string, body?: unknown) {
  return await fetch(`${server.url}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const template = {
  title: "Weekly repository health review",
  spec: "# Spec\n\nReview.",
  techDesign: "# Design\n\nCheck.",
};

describe("schedules API", () => {
  it("creates, lists, edits, pauses, resumes and deletes a schedule", async () => {
    const repoPath = await createRepo();
    const server = await start(repoPath);
    const created = await call(server, "POST", "/api/schedules", {
      name: "weekly-health",
      trigger: { type: "cron", expression: "0 9 * * 1" },
      timezone: "Asia/Singapore",
      template,
    });
    expect(created.status).toBe(201);
    const { schedule } = await json(created);
    expect(schedule).toMatchObject({
      name: "weekly-health",
      enabled: true,
      revision: 1,
      timezone: "Asia/Singapore",
      repoId: expect.any(String),
    });
    expect(schedule.nextRunAt).toMatch(/T01:00:00\.000Z$/);

    const listed = await json(await call(server, "GET", "/api/schedules"));
    expect(listed.schedules.map((s: { id: string }) => s.id)).toEqual([schedule.id]);

    const edited = await call(server, "PATCH", `/api/schedules/${schedule.id}`, {
      trigger: { type: "cron", expression: "0 10 * * 1" },
    });
    expect(edited.status).toBe(200);
    const editedBody = await json(edited);
    expect(editedBody.schedule).toMatchObject({ revision: 2 });
    expect(editedBody.schedule.nextRunAt).toMatch(/T02:00:00\.000Z$/);

    const paused = await json(await call(server, "POST", `/api/schedules/${schedule.id}/pause`));
    expect(paused.schedule).toMatchObject({ enabled: false });
    expect(paused.schedule.nextRunAt).toBeUndefined();
    const resumed = await call(server, "POST", `/api/schedules/${schedule.id}/resume`);
    expect((await json(resumed)).schedule).toMatchObject({ enabled: true, nextRunAt: expect.any(String) });

    const detail = await json(await call(server, "GET", `/api/schedules/${schedule.id}`));
    expect(detail.schedule.id).toBe(schedule.id);
    expect(detail.occurrences).toEqual([]);

    const deleted = await call(server, "DELETE", `/api/schedules/${schedule.id}`);
    expect(deleted.status).toBe(200);
    expect(await listSchedules(repoPath)).toEqual([]);
    expect((await call(server, "GET", `/api/schedules/${schedule.id}`)).status).toBe(404);

    const audit = (await listSecurityAuditEvents(repoPath)).map((event) => event.action);
    expect(audit).toEqual(
      expect.arrayContaining([
        "schedules.create",
        "schedules.update",
        "schedules.pause",
        "schedules.resume",
        "schedules.delete",
      ]),
    );
  });

  it("rejects invalid schedule input with a JSON 400", async () => {
    const repoPath = await createRepo();
    const server = await start(repoPath);
    const response = await call(server, "POST", "/api/schedules", {
      name: "bad",
      trigger: { type: "cron", expression: "0 9 * *" },
      timezone: "UTC",
      template,
    });
    expect(response.status).toBe(400);
    expect((await json(response)).error.message).toMatch(/five fields/);
    const badZone = await call(server, "POST", "/api/schedules", {
      name: "bad",
      trigger: { type: "cron", expression: "0 9 * * *" },
      timezone: "Nowhere/City",
      template,
    });
    expect(badZone.status).toBe(400);
  });

  it("run-now materializes an occurrence immediately through the queue", async () => {
    const repoPath = await createRepo();
    const server = await start(repoPath);
    const { schedule } = await json(await call(server, "POST", "/api/schedules", {
      name: "weekly-health",
      trigger: { type: "cron", expression: "0 9 * * 1" },
      timezone: "UTC",
      template,
    }));
    const ran = await call(server, "POST", `/api/schedules/${schedule.id}/run-now`);
    expect(ran.status).toBe(200);
    const body = await json(ran);
    expect(body.occurrence).toMatchObject({ scheduleId: schedule.id, status: "materialized" });
    expect(await listTasks(repoPath)).toHaveLength(1);
    expect(await listScheduleOccurrences(repoPath)).toHaveLength(1);
    // The regular next firing is unaffected by a manual run.
    const detail = await json(await call(server, "GET", `/api/schedules/${schedule.id}`));
    expect(detail.schedule.nextRunAt).toBe(schedule.nextRunAt);
  });
});

describe("schedules API reliability surface", () => {
  it("accepts misfire and overlap policies, defaults them, and rejects unbounded catch-up", async () => {
    const repoPath = await createRepo();
    const server = await start(repoPath);
    const defaults = await json(await call(server, "POST", "/api/schedules", {
      name: "defaults",
      trigger: { type: "cron", expression: "0 9 * * 1" },
      timezone: "UTC",
      template,
    }));
    expect(defaults.schedule).toMatchObject({ misfire: { policy: "run_once_now" }, overlap: "allow" });

    const explicit = await json(await call(server, "POST", "/api/schedules", {
      name: "explicit",
      trigger: { type: "cron", expression: "0 9 * * 1" },
      timezone: "UTC",
      template,
      misfire: { policy: "catch_up", limit: 3 },
      overlap: "skip",
    }));
    expect(explicit.schedule).toMatchObject({ misfire: { policy: "catch_up", limit: 3 }, overlap: "skip" });

    const patched = await json(await call(server, "PATCH", `/api/schedules/${explicit.schedule.id}`, {
      overlap: "queue",
    }));
    expect(patched.schedule).toMatchObject({ overlap: "queue", revision: 2 });

    const unbounded = await call(server, "POST", "/api/schedules", {
      name: "unbounded",
      trigger: { type: "cron", expression: "0 9 * * 1" },
      timezone: "UTC",
      template,
      misfire: { policy: "catch_up", limit: 5000 },
    });
    expect(unbounded.status).toBe(400);
    expect((await json(unbounded)).error.message).toMatch(/limit/);
  });

  it("schedule detail exposes occurrence history with task, candidate and run lineage", async () => {
    const repoPath = await createRepo();
    const server = await start(repoPath);
    const { schedule } = await json(await call(server, "POST", "/api/schedules", {
      name: "hourly",
      trigger: { type: "interval", everyMs: 3_600_000, anchorAt: "2026-09-19T00:00:00Z" },
      timezone: "UTC",
      template,
      misfire: { policy: "skip" },
    }));
    const { fired } = await materializeDueSchedules({ repoPath, now: () => new Date(Date.parse(schedule.nextRunAt)) });
    await updateTaskRunState(repoPath, fired[0].workItemId!, { status: "completed", latestRunId: "run-7" });
    await materializeDueSchedules({
      repoPath,
      now: () => new Date(Date.parse(schedule.nextRunAt) + 3 * 3_600_000 + 30 * 60_000),
    });
    const detail = await json(await call(server, "GET", `/api/schedules/${schedule.id}`));
    expect(detail.occurrences[0].status).toBe("skipped");
    const materialized = detail.occurrences.find((o: { status: string }) => o.status === "materialized");
    expect(materialized).toMatchObject({
      workItemId: fired[0].workItemId,
      candidateId: fired[0].candidateId,
      lineage: { taskStatus: "completed", runId: "run-7", candidateStatus: expect.any(String) },
    });
    // The latest decision of any kind, plus the latest one that produced work.
    expect(detail.schedule.lastOccurrence).toMatchObject({ status: "skipped" });
    expect(detail.schedule.lastMaterializedOccurrence).toMatchObject({ id: fired[0].id, status: "materialized" });
    const listed = await json(await call(server, "GET", "/api/schedules"));
    expect(listed.schedules[0].lastMaterializedOccurrence).toMatchObject({
      status: "materialized",
      lineage: { runId: "run-7" },
    });
  });
});
