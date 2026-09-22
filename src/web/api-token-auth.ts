import type { ApiTokenCapability } from "./api-tokens.js";

export interface ApiTokenAction {
  action: string;
  capability: ApiTokenCapability;
  target?: { taskId?: string; runId?: string; previewSessionId?: string };
}

function decodedMatch(
  pathname: string,
  pattern: RegExp,
): string | undefined {
  const match = pattern.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

export function apiTokenActionForRequest(
  method: string | undefined,
  pathname: string,
): ApiTokenAction | null {
  const previewSessionId = decodedMatch(
    pathname,
    /^\/api\/preview-sessions\/([^/]+)(?:\/(?:stop|navigate|reload|restart|screenshot|attach-screenshot|compare-reference|diagnostics|hierarchy|click|type|scroll))?$/,
  );
  if (method === "GET" && pathname === "/api/preview-sessions") {
    return { action: "preview.sessions.list", capability: "preview:read" };
  }
  if (previewSessionId !== undefined) {
    if (method === "GET") {
      const diagnostics = /\/diagnostics$/u.test(pathname);
      const hierarchy = /\/hierarchy$/u.test(pathname);
      return {
        action: diagnostics
          ? "preview.diagnostics.get"
          : hierarchy
            ? "preview.hierarchy.get"
            : "preview.sessions.get",
        capability: "preview:read",
        target: { previewSessionId },
      };
    }
    if (method === "POST") {
      const compare = /\/compare-reference$/u.test(pathname);
      const attach = /\/attach-screenshot$/u.test(pathname);
      return {
        action: compare
          ? "preview.compare"
          : attach
            ? "preview.screenshot.attach"
            : "preview.sessions.control",
        capability: compare || attach ? "preview:compare" : "preview:control",
        target: { previewSessionId },
      };
    }
  }
  if (method === "POST" && pathname === "/api/preview-sessions") {
    return { action: "preview.sessions.start", capability: "preview:control" };
  }
  if (method === "GET" && pathname === "/api/flows") {
    return { action: "flows.list", capability: "tasks:read" };
  }
  if (method === "GET" && pathname === "/api/tasks") {
    return { action: "tasks.list", capability: "tasks:read" };
  }
  if (method === "POST" && pathname === "/api/tasks") {
    return { action: "tasks.create", capability: "tasks:write" };
  }
  if (method === "POST" && pathname === "/api/draft-specs") {
    return { action: "specs.draft", capability: "tasks:write" };
  }
  if (method === "GET") {
    const taskReworkListId = decodedMatch(
      pathname,
      /^\/api\/tasks\/([^/]+)\/rework-requests$/,
    );
    if (taskReworkListId !== undefined) {
      return {
        action: "task-rework-requests.list",
        capability: "tasks:read",
        target: { taskId: taskReworkListId },
      };
    }
    const taskReworkGetId = decodedMatch(
      pathname,
      /^\/api\/tasks\/([^/]+)\/rework-requests\/[^/]+$/,
    );
    if (taskReworkGetId !== undefined) {
      return {
        action: "task-rework-requests.get",
        capability: "tasks:read",
        target: { taskId: taskReworkGetId },
      };
    }
    const taskId = decodedMatch(pathname, /^\/api\/tasks\/([^/]+)$/);
    if (taskId !== undefined) {
      return {
        action: "tasks.get",
        capability: "tasks:read",
        target: { taskId },
      };
    }
  }
  if (method === "POST") {
    const draftTechDesignTaskId = decodedMatch(
      pathname,
      /^\/api\/tasks\/([^/]+)\/draft-tech-design$/,
    );
    if (draftTechDesignTaskId !== undefined) {
      return {
        action: "tech-designs.draft",
        capability: "tasks:write",
        target: { taskId: draftTechDesignTaskId },
      };
    }
    const refreshSourcePlanningTaskId = decodedMatch(
      pathname,
      /^\/api\/tasks\/([^/]+)\/refresh-source-planning$/,
    );
    if (refreshSourcePlanningTaskId !== undefined) {
      return {
        action: "source-planning.refresh",
        capability: "tasks:write",
        target: { taskId: refreshSourcePlanningTaskId },
      };
    }
    const sourceStatusTaskId = decodedMatch(
      pathname,
      /^\/api\/tasks\/([^/]+)\/sync-source-status$/,
    );
    if (sourceStatusTaskId !== undefined) {
      return {
        action: "source-status.sync",
        capability: "tasks:write",
        target: { taskId: sourceStatusTaskId },
      };
    }
    const specTaskId = decodedMatch(
      pathname,
      /^\/api\/tasks\/([^/]+)\/approve-spec$/,
    );
    if (specTaskId !== undefined) {
      return {
        action: "specs.approve",
        capability: "spec:approve",
        target: { taskId: specTaskId },
      };
    }
    const techDesignTaskId = decodedMatch(
      pathname,
      /^\/api\/tasks\/([^/]+)\/approve-tech-design$/,
    );
    if (techDesignTaskId !== undefined) {
      return {
        action: "tech-designs.approve",
        capability: "spec:approve",
        target: { taskId: techDesignTaskId },
      };
    }
    const runTaskId = decodedMatch(
      pathname,
      /^\/api\/tasks\/([^/]+)\/runs$/,
    );
    if (runTaskId !== undefined) {
      return {
        action: "runs.start",
        capability: "runs:start",
        target: { taskId: runTaskId },
      };
    }
    const createTaskReworkId = decodedMatch(
      pathname,
      /^\/api\/tasks\/([^/]+)\/rework-requests$/,
    );
    if (createTaskReworkId !== undefined) {
      return {
        action: "task-rework-requests.create",
        capability: "runs:start",
        target: { taskId: createTaskReworkId },
      };
    }
    const confirmTaskReworkId = decodedMatch(
      pathname,
      /^\/api\/tasks\/([^/]+)\/rework-requests\/[^/]+\/confirm$/,
    );
    if (confirmTaskReworkId !== undefined) {
      return {
        action: "task-rework-requests.confirm",
        capability: "runs:start",
        target: { taskId: confirmTaskReworkId },
      };
    }
    const cancelTaskReworkId = decodedMatch(
      pathname,
      /^\/api\/tasks\/([^/]+)\/rework-requests\/[^/]+\/cancel$/,
    );
    if (cancelTaskReworkId !== undefined) {
      return {
        action: "task-rework-requests.cancel",
        capability: "runs:start",
        target: { taskId: cancelTaskReworkId },
      };
    }
  }
  if (method === "GET" && pathname === "/api/runs") {
    return { action: "runs.list", capability: "runs:read" };
  }
  if (method === "GET") {
    const runLogsStreamId = decodedMatch(
      pathname,
      /^\/api\/runs\/([^/]+)\/logs\/stream$/,
    );
    if (runLogsStreamId !== undefined) {
      return {
        action: "runs.logs.stream",
        capability: "runs:read",
        target: { runId: runLogsStreamId },
      };
    }
    const runId = decodedMatch(pathname, /^\/api\/runs\/([^/]+)$/);
    if (runId !== undefined) {
      return {
        action: "runs.get",
        capability: "runs:read",
        target: { runId },
      };
    }
  }
  return null;
}
