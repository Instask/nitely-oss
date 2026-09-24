import { describe, expect, it } from "vitest";

import { webSecurityActionForRequest } from "../../src/web/security-actions.js";

describe("Web security action mapping", () => {
  it.each([
    ["POST", "/api/tasks", "tasks.create", "tasks:write", undefined],
    ["POST", "/api/draft-specs", "tasks.draft", "tasks:write", undefined],
    [
      "POST",
      "/api/tasks/task-1/sync-source-status",
      "tasks.update",
      "tasks:write",
      { type: "task", id: "task-1" },
    ],
    [
      "POST",
      "/api/tasks/task-1/approve-spec",
      "planning.approve-spec",
      "planning:approve",
      { type: "task", id: "task-1" },
    ],
    [
      "POST",
      "/api/tasks/task-1/approve-tech-design",
      "planning.approve-tech-design",
      "planning:approve",
      { type: "task", id: "task-1" },
    ],
    [
      "POST",
      "/api/tasks/task-1/runs",
      "runs.start",
      "runs:start",
      { type: "task", id: "task-1" },
    ],
    [
      "GET",
      "/api/tasks/task-1/rework-requests",
      "task-rework-requests.view",
      "tasks:view",
      { type: "task", id: "task-1" },
    ],
    [
      "GET",
      "/api/tasks/task-1/rework-requests/tcr_123",
      "task-rework-requests.view",
      "tasks:view",
      { type: "task", id: "task-1" },
    ],
    [
      "POST",
      "/api/tasks/task-1/rework-requests",
      "task-rework-requests.manage",
      "runs:start",
      { type: "task", id: "task-1" },
    ],
    [
      "POST",
      "/api/tasks/task-1/rework-requests/tcr_123/confirm",
      "task-rework-requests.manage",
      "runs:start",
      { type: "task", id: "task-1" },
    ],
    [
      "POST",
      "/api/tasks/task-1/rework-requests/tcr_123/cancel",
      "task-rework-requests.manage",
      "runs:start",
      { type: "task", id: "task-1" },
    ],
    [
      "GET",
      "/api/runs/run-1",
      "evidence.view",
      "evidence:view",
      { type: "run", id: "run-1" },
    ],
    ["POST", "/api/flows", "flows.create", "flows:manage", undefined],
    [
      "POST",
      "/api/notifications/note-1/resolve",
      "notifications.resolve",
      "notifications:resolve",
      { type: "notification", id: "note-1" },
    ],
    [
      "PUT",
      "/api/flows/flow-1",
      "flows.update",
      "flows:manage",
      { type: "flow", id: "flow-1" },
    ],
    [
      "DELETE",
      "/api/providers/github/connection",
      "providers.clear",
      "providers:write:personal",
      { type: "provider", id: "github" },
    ],
    ["POST", "/api/scheduler/run", "scheduler.run", "scheduler:run", { type: "scheduler" }],
    [
      "DELETE",
      "/api/users/usr_1/sessions",
      "sessions.revoke",
      "sessions:revoke",
      { type: "user", id: "usr_1" },
    ],
    [
      "GET",
      "/api/security/audit",
      "security-audit.view",
      "security:audit:view",
      { type: "audit" },
    ],
    [
      "POST",
      "/api/knowledge-repositories/platform/refresh",
      "knowledge.refresh",
      "knowledge:manage",
      { type: "knowledge-repository", id: "platform" },
    ],
    [
      "GET",
      "/api/preview-sessions",
      "preview-sessions.list",
      "preview:view",
      { type: "preview-session" },
    ],
    [
      "POST",
      "/api/preview-sessions",
      "preview-sessions.start",
      "preview:control",
      { type: "preview-session" },
    ],
    [
      "GET",
      "/api/preview-sessions/pvs_123",
      "preview-sessions.view",
      "preview:view",
      { type: "preview-session", id: "pvs_123" },
    ],
    [
      "GET",
      "/api/preview-sessions/pvs_123/diagnostics",
      "preview-sessions.view",
      "preview:view",
      { type: "preview-session", id: "pvs_123" },
    ],
    [
      "GET",
      "/api/preview-sessions/pvs_123/proxy/app",
      "preview-sessions.view",
      "preview:view",
      { type: "preview-session", id: "pvs_123" },
    ],
    [
      "POST",
      "/api/preview-sessions/pvs_123/screenshot",
      "preview-sessions.control",
      "preview:control",
      { type: "preview-session", id: "pvs_123" },
    ],
    [
      "POST",
      "/api/preview-sessions/pvs_123/restart",
      "preview-sessions.control",
      "preview:control",
      { type: "preview-session", id: "pvs_123" },
    ],
    [
      "POST",
      "/api/preview-sessions/pvs_123/attach-screenshot",
      "preview-sessions.control",
      "preview:control",
      { type: "preview-session", id: "pvs_123" },
    ],
    ["POST", "/api/schedules", "schedules.create", "scheduler:run", { type: "scheduler" }],
    ["PATCH", "/api/schedules/sch_1", "schedules.update", "scheduler:run", { type: "scheduler", id: "sch_1" }],
    ["DELETE", "/api/schedules/sch_1", "schedules.delete", "scheduler:run", { type: "scheduler", id: "sch_1" }],
    ["POST", "/api/schedules/sch_1/pause", "schedules.pause", "scheduler:run", { type: "scheduler", id: "sch_1" }],
    ["POST", "/api/schedules/sch_1/run-now", "schedules.run-now", "scheduler:run", { type: "scheduler", id: "sch_1" }],
    [
      "POST",
      "/api/preview-sessions/pvs_123/compare-reference",
      "preview-sessions.control",
      "preview:control",
      { type: "preview-session", id: "pvs_123" },
    ],
    [
      "POST",
      "/api/providers/github/oauth/start",
      "providers.oauth.start",
      "providers:write:personal",
      { type: "provider", id: "github" },
    ],
    [
      "POST",
      "/api/providers/github/connections/conn_1/disconnect",
      "providers.oauth.disconnect",
      "providers:write:personal",
      { type: "provider", id: "github" },
    ],
    [
      "POST",
      "/api/providers/github/connections/conn_1/validate",
      "providers.validate",
      "providers:write:personal",
      { type: "provider", id: "github" },
    ],
    [
      "POST",
      "/api/providers/github/connections/conn_1/default",
      "providers.default",
      "providers:write:personal",
      { type: "provider", id: "github" },
    ],
  ] as const)(
    "maps %s %s",
    (method, path, action, permission, target) => {
      expect(webSecurityActionForRequest(method, path)).toEqual({
        action,
        permission,
        ...(target ? { target } : {}),
      });
    },
  );

  it("decodes bounded resource identifiers and ignores unrelated endpoints", () => {
    expect(
      webSecurityActionForRequest("POST", "/api/tasks/task%20one/approve-spec"),
    ).toMatchObject({ target: { type: "task", id: "task one" } });
    expect(webSecurityActionForRequest("GET", "/api/session")).toBeNull();
    expect(webSecurityActionForRequest("GET", "/support.js")).toBeNull();
    expect(
      webSecurityActionForRequest("POST", "/api/preview-sessions/pvs_123/proxy/app"),
    ).toBeNull();
  });
});
