import { describe, expect, it } from "vitest";

import {
  consoleListApiRoutes,
  dispatchHttpRoutes,
} from "../../src/web/route-dispatch.js";

describe("dispatchHttpRoutes", () => {
  it("selects the first matching method/path route", async () => {
    const calls: string[] = [];
    const handled = await dispatchHttpRoutes(
      { method: "GET", pathname: "/tasks/1" },
      [
        {
          method: "POST",
          matches: () => true,
          handle: async () => {
            calls.push("wrong-method");
            return true;
          },
        },
        {
          matches: (context) => context.pathname.startsWith("/tasks/"),
          handle: async () => {
            calls.push("task");
            return true;
          },
        },
        {
          matches: () => true,
          handle: async () => {
            calls.push("fallback");
            return true;
          },
        },
      ],
    );

    expect(handled).toBe(true);
    expect(calls).toEqual(["task"]);
  });

  it("continues after a matched route declines and reports no match", async () => {
    const handled = await dispatchHttpRoutes(
      { method: "GET", pathname: "/missing" },
      [
        {
          matches: () => true,
          handle: async () => false,
        },
      ],
    );

    expect(handled).toBe(false);
  });
});

describe("console list API routes", () => {
  function recordingRoutes() {
    const calls: string[] = [];
    const routes = consoleListApiRoutes({
      "/api/runs": async () => {
        calls.push("/api/runs");
        return true;
      },
      "/api/dashboard": async () => {
        calls.push("/api/dashboard");
        return true;
      },
      "/api/agent-stability": async () => {
        calls.push("/api/agent-stability");
        return true;
      },
      "/api/tasks": async () => {
        calls.push("/api/tasks");
        return true;
      },
    });
    return { calls, routes };
  }

  it("selects GET /api/runs from the first-match table", async () => {
    const { calls, routes } = recordingRoutes();

    const handled = await dispatchHttpRoutes(
      { method: "GET", pathname: "/api/runs" },
      routes,
    );

    expect(handled).toBe(true);
    expect(calls).toEqual(["/api/runs"]);
  });

  it("does not match POST /api/runs", async () => {
    const { calls, routes } = recordingRoutes();

    const handled = await dispatchHttpRoutes(
      { method: "POST", pathname: "/api/runs" },
      routes,
    );

    expect(handled).toBe(false);
    expect(calls).toEqual([]);
  });

  it("selects the other GET-only console list endpoints by exact path", async () => {
    const { calls, routes } = recordingRoutes();

    await dispatchHttpRoutes(
      { method: "GET", pathname: "/api/dashboard" },
      routes,
    );
    await dispatchHttpRoutes(
      { method: "GET", pathname: "/api/agent-stability" },
      routes,
    );
    await dispatchHttpRoutes({ method: "GET", pathname: "/api/tasks" }, routes);
    await dispatchHttpRoutes(
      { method: "POST", pathname: "/api/tasks" },
      routes,
    );

    expect(calls).toEqual([
      "/api/dashboard",
      "/api/agent-stability",
      "/api/tasks",
    ]);
  });
});
