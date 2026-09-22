import type { WebPermission } from "./access-control.js";
import type {
  SecurityAuditTarget,
  SecurityAuditTargetType,
} from "./security-audit.js";

export interface WebSecurityAction {
  action: string;
  permission: WebPermission;
  target?: SecurityAuditTarget;
}

function decodedTarget(
  pathname: string,
  pattern: RegExp,
  type: SecurityAuditTargetType,
): SecurityAuditTarget | undefined {
  const match = pattern.exec(pathname);
  if (!match) return undefined;
  try {
    return { type, id: decodeURIComponent(match[1]) };
  } catch {
    return { type };
  }
}

function action(
  actionName: string,
  permission: WebPermission,
  target?: SecurityAuditTarget,
): WebSecurityAction {
  return { action: actionName, permission, ...(target ? { target } : {}) };
}

export function webSecurityActionForRequest(
  method: string | undefined,
  pathname: string,
): WebSecurityAction | null {
  if (method === "POST" && pathname === "/api/demo/golden-path") {
    return action("demo.run", "demo:run");
  }
  if (method === "POST" && pathname === "/api/skills/preview") {
    return action("skills.preview", "skills:manage", { type: "skill" });
  }
  if (method === "POST" && pathname === "/api/skills/import") {
    return action("skills.import", "skills:manage", { type: "skill" });
  }
  if (method === "POST" && pathname === "/api/repositories") {
    return action("repositories.onboard", "repositories:manage", {
      type: "repository",
    });
  }
  if (method === "POST" && pathname === "/api/scheduler/run") {
    return action("scheduler.run", "scheduler:run", { type: "scheduler" });
  }
  if (method === "POST" && pathname === "/api/factory-queue/dispatch") {
    return action("factory-queue.dispatch", "scheduler:run", { type: "scheduler" });
  }
  if (method === "POST" && pathname === "/api/factory-queue/pause") {
    return action("factory-queue.pause", "scheduler:run", { type: "scheduler" });
  }
  if (method === "POST" && pathname === "/api/tasks") {
    return action("tasks.create", "tasks:write");
  }
  if (method === "POST" && pathname === "/api/draft-specs") {
    return action("tasks.draft", "tasks:write");
  }
  if (method === "POST" && pathname === "/api/flows/from-template") {
    return action("flows.create-from-template", "flows:manage");
  }
  if (method === "POST" && pathname === "/api/flows") {
    return action("flows.create", "flows:manage");
  }
  if (method === "POST" && pathname === "/api/work-items") {
    return action("work-items.create", "tasks:write");
  }
  if (method === "POST" && pathname === "/api/schedules") {
    return action("schedules.create", "scheduler:run", { type: "scheduler" });
  }
  const scheduleAction = /^\/api\/schedules\/([^/]+)(?:\/(pause|resume|run-now))?$/.exec(pathname);
  if (scheduleAction) {
    const target = decodedTarget(pathname, /^\/api\/schedules\/([^/]+)/, "scheduler");
    if (method === "PATCH" && !scheduleAction[2]) {
      return action("schedules.update", "scheduler:run", target);
    }
    if (method === "DELETE" && !scheduleAction[2]) {
      return action("schedules.delete", "scheduler:run", target);
    }
    if (method === "POST" && scheduleAction[2]) {
      return action(`schedules.${scheduleAction[2]}`, "scheduler:run", target);
    }
  }
  if (method === "POST" && pathname === "/api/factory-queue/candidates") {
    return action("factory-queue.candidates.create", "tasks:write");
  }
  if (method === "POST" && pathname === "/api/context-kg") {
    return action("context.create", "context:manage", { type: "context" });
  }
  if (
    (method === "GET" || method === "POST") &&
    (pathname === "/api/knowledge-repositories" ||
      pathname === "/api/knowledge-repositories/query")
  ) {
    return action(
      method === "GET" ? "knowledge.list" : "knowledge.manage",
      "knowledge:manage",
      { type: "knowledge-repository" },
    );
  }
  if (method === "GET" && pathname === "/api/security/audit") {
    return action("security-audit.view", "security:audit:view", { type: "audit" });
  }
  if (pathname === "/api/preview-sessions") {
    if (method === "GET") {
      return action("preview-sessions.list", "preview:view", {
        type: "preview-session",
      });
    }
    if (method === "POST") {
      return action("preview-sessions.start", "preview:control", {
        type: "preview-session",
      });
    }
  }
  const previewProxySession = decodedTarget(
    pathname,
    /^\/api\/preview-sessions\/([^/]+)\/proxy(?:\/.*)?$/,
    "preview-session",
  );
  if (previewProxySession && (method === "GET" || method === "HEAD")) {
    return action("preview-sessions.view", "preview:view", previewProxySession);
  }
  const previewSession = decodedTarget(
    pathname,
    /^\/api\/preview-sessions\/([^/]+)(?:\/(?:stop|navigate|reload|restart|screenshot|attach-screenshot|compare-reference|diagnostics|hierarchy|click|type|scroll))?$/,
    "preview-session",
  );
  if (previewSession) {
    if (method === "GET") {
      return action("preview-sessions.view", "preview:view", previewSession);
    }
    if (method === "POST") {
      return action(
        "preview-sessions.control",
        "preview:control",
        previewSession,
      );
    }
  }

  const userSessions = decodedTarget(
    pathname,
    /^\/api\/users\/([^/]+)\/sessions$/,
    "user",
  );

  const knowledgeRepository = decodedTarget(
    pathname,
    /^\/api\/knowledge-repositories\/([^/]+)(?:\/refresh|\/status)?$/,
    "knowledge-repository",
  );
  if (
    knowledgeRepository &&
    (method === "GET" || method === "POST" || method === "DELETE")
  ) {
    return action(
      method === "GET"
        ? "knowledge.status"
        : method === "DELETE"
          ? "knowledge.detach"
          : "knowledge.refresh",
      "knowledge:manage",
      knowledgeRepository,
    );
  }
  if (method === "DELETE" && userSessions) {
    return action("sessions.revoke", "sessions:revoke", userSessions);
  }

  const notificationAssign = decodedTarget(
    pathname,
    /^\/api\/notifications\/([^/]+)\/assign$/,
    "notification",
  );
  if (method === "POST" && notificationAssign) {
    return action(
      "notifications.assign",
      "notifications:manage",
      notificationAssign,
    );
  }
  const notificationAction = decodedTarget(
    pathname,
    /^\/api\/notifications\/([^/]+)\/actions$/,
    "notification",
  );
  if (method === "POST" && notificationAction) {
    return action(
      "notifications.action",
      "notifications:resolve",
      notificationAction,
    );
  }
  const notificationResolve = decodedTarget(
    pathname,
    /^\/api\/notifications\/([^/]+)\/resolve$/,
    "notification",
  );
  if (method === "POST" && notificationResolve) {
    return action(
      "notifications.resolve",
      "notifications:resolve",
      notificationResolve,
    );
  }

  const taskApproval = decodedTarget(
    pathname,
    /^\/api\/tasks\/([^/]+)\/approve-spec$/,
    "task",
  );
  if (method === "POST" && taskApproval) {
    return action("planning.approve-spec", "planning:approve", taskApproval);
  }
  const designApproval = decodedTarget(
    pathname,
    /^\/api\/tasks\/([^/]+)\/approve-tech-design$/,
    "task",
  );
  if (method === "POST" && designApproval) {
    return action(
      "planning.approve-tech-design",
      "planning:approve",
      designApproval,
    );
  }
  const taskRun = decodedTarget(
    pathname,
    /^\/api\/tasks\/([^/]+)\/runs$/,
    "task",
  );
  if (method === "POST" && taskRun) {
    return action("runs.start", "runs:start", taskRun);
  }
  const taskReworkRequests = decodedTarget(
    pathname,
    /^\/api\/tasks\/([^/]+)\/rework-requests(?:\/[^/]+(?:\/(?:confirm|cancel))?)?$/,
    "task",
  );
  if (taskReworkRequests) {
    if (method === "GET") {
      return action("task-rework-requests.view", "tasks:view", taskReworkRequests);
    }
    if (method === "POST") {
      return action(
        "task-rework-requests.manage",
        "runs:start",
        taskReworkRequests,
      );
    }
  }
  const taskMutation = decodedTarget(
    pathname,
    /^\/api\/tasks\/([^/]+)\/(?:dependencies|dependency-suggestions\/refresh|refresh-source-planning|sync-source-status|draft-tech-design)$/,
    "task",
  );
  if ((method === "POST" || method === "DELETE") && taskMutation) {
    return action("tasks.update", "tasks:write", taskMutation);
  }
  const taskNestedMutation = decodedTarget(
    pathname,
    /^\/api\/tasks\/([^/]+)\/(?:dependencies\/[^/]+|dependency-suggestions\/[^/]+\/dismiss)$/,
    "task",
  );
  if ((method === "POST" || method === "DELETE") && taskNestedMutation) {
    return action("tasks.update", "tasks:write", taskNestedMutation);
  }
  const taskDetail = decodedTarget(pathname, /^\/api\/tasks\/([^/]+)$/, "task");
  if (method === "GET" && taskDetail) {
    return action("tasks.view", "tasks:view", taskDetail);
  }

  const flow = decodedTarget(pathname, /^\/api\/flows\/([^/]+)$/, "flow");
  if (method === "PUT" && flow) {
    return action("flows.update", "flows:manage", flow);
  }
  if (method === "DELETE" && flow) {
    return action("flows.delete", "flows:manage", flow);
  }

  const workItemRun = decodedTarget(
    pathname,
    /^\/api\/work-items\/([^/]+)\/runs$/,
    "work-item",
  );
  if (method === "POST" && workItemRun) {
    return action("runs.start", "runs:start", workItemRun);
  }

  const context = decodedTarget(pathname, /^\/api\/context-kg\/([^/]+)$/, "context");
  if (method === "PATCH" && context) {
    return action("context.update", "context:manage", context);
  }

  const runReview = decodedTarget(
    pathname,
    /^\/api\/runs\/([^/]+)\/(?:questions\/[^/]+\/answer|review-verdict)$/,
    "run",
  );
  if (method === "POST" && runReview) {
    return action("runs.review", "runs:review", runReview);
  }
  const runDetail = decodedTarget(pathname, /^\/api\/runs\/([^/]+)$/, "run");
  if (method === "GET" && runDetail) {
    return action("evidence.view", "evidence:view", runDetail);
  }

  const provider = decodedTarget(
    pathname,
    /^\/api\/providers\/([^/]+)\/connection$/,
    "provider",
  );
  if (method === "POST" && provider) {
    return action("providers.set", "providers:write:personal", provider);
  }
  if (method === "DELETE" && provider) {
    return action("providers.clear", "providers:write:personal", provider);
  }
  const providerOAuthStart = decodedTarget(
    pathname,
    /^\/api\/providers\/([^/]+)\/oauth\/start$/,
    "provider",
  );
  if (method === "POST" && providerOAuthStart) {
    return action("providers.oauth.start", "providers:write:personal", providerOAuthStart);
  }
  const providerConnectionAction = /^\/api\/providers\/([^/]+)\/connections\/[^/]+\/(disconnect|validate|default)$/.exec(pathname);
  if (method === "POST" && providerConnectionAction) {
    const target = decodedTarget(
      pathname,
      /^\/api\/providers\/([^/]+)\/connections\//,
      "provider",
    );
    const name = providerConnectionAction[2] === "disconnect"
      ? "providers.oauth.disconnect"
      : `providers.${providerConnectionAction[2]}`;
    return action(name, "providers:write:personal", target);
  }
  return null;
}
