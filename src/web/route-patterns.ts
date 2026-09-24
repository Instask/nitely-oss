export function apiTaskId(pathname: string): string | undefined {
  const match = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function apiContextKnowledgeId(pathname: string): string | undefined {
  const match = /^\/api\/context-kg\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function apiTaskRunId(pathname: string): string | undefined {
  const match = /^\/api\/tasks\/([^/]+)\/runs$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export type ApiPreviewSessionAction =
  | "stop"
  | "navigate"
  | "reload"
  | "restart"
  | "screenshot"
  | "attach-screenshot"
  | "compare-reference"
  | "diagnostics"
  | "hierarchy"
  | "click"
  | "type"
  | "scroll";

export function apiPreviewSessionProxyRef(pathname: string):
  | { sessionId: string; proxyPath?: string }
  | undefined {
  const match =
    /^\/api\/preview-sessions\/([^/]+)\/proxy(?:\/(.*))?$/.exec(pathname);
  return match
    ? {
        sessionId: decodeURIComponent(match[1]),
        ...(match[2] !== undefined ? { proxyPath: match[2] } : {}),
      }
    : undefined;
}

export function apiPreviewSessionRef(pathname: string):
  | { sessionId: string; action?: ApiPreviewSessionAction }
  | undefined {
  const match =
    /^\/api\/preview-sessions\/([^/]+)(?:\/(stop|navigate|reload|restart|screenshot|attach-screenshot|compare-reference|diagnostics|hierarchy|click|type|scroll))?$/.exec(
      pathname,
    );
  return match
    ? {
        sessionId: decodeURIComponent(match[1]),
        ...(match[2] ? { action: match[2] as ApiPreviewSessionAction } : {}),
      }
    : undefined;
}

export function apiTaskReworkRequestsId(pathname: string): string | undefined {
  const match = /^\/api\/tasks\/([^/]+)\/rework-requests$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function apiTaskReworkRequestId(
  pathname: string,
): { taskId: string; requestId: string; action?: "confirm" | "cancel" } | undefined {
  const match =
    /^\/api\/tasks\/([^/]+)\/rework-requests\/([^/]+)(?:\/(confirm|cancel))?$/.exec(
      pathname,
    );
  return match
    ? {
        taskId: decodeURIComponent(match[1]),
        requestId: decodeURIComponent(match[2]),
        ...(match[3] === "confirm" || match[3] === "cancel"
          ? { action: match[3] }
          : {}),
      }
    : undefined;
}

export function apiTaskPreflightId(pathname: string): string | undefined {
  const match = /^\/api\/tasks\/([^/]+)\/preflight$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function apiTaskDependenciesId(pathname: string): string | undefined {
  const match = /^\/api\/tasks\/([^/]+)\/dependencies$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function apiTaskDependencyId(
  pathname: string,
): { taskId: string; upstreamId: string } | undefined {
  const match = /^\/api\/tasks\/([^/]+)\/dependencies\/([^/]+)$/.exec(pathname);
  return match
    ? {
        taskId: decodeURIComponent(match[1]),
        upstreamId: decodeURIComponent(match[2]),
      }
    : undefined;
}

export function apiTaskDependencySuggestionDismissId(
  pathname: string,
): { taskId: string; upstreamId: string } | undefined {
  const match =
    /^\/api\/tasks\/([^/]+)\/dependency-suggestions\/([^/]+)\/dismiss$/.exec(
      pathname,
    );
  return match
    ? {
        taskId: decodeURIComponent(match[1]),
        upstreamId: decodeURIComponent(match[2]),
      }
    : undefined;
}

export function apiDeviceAuthorizationUserCode(pathname: string): string | undefined {
  const match = /^\/api\/device-authorizations\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function apiTaskDependencySuggestionsRefreshId(
  pathname: string,
): string | undefined {
  const match = /^\/api\/tasks\/([^/]+)\/suggestions:refresh$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function apiTaskDraftTechDesignId(pathname: string): string | undefined {
  const match = /^\/api\/tasks\/([^/]+)\/draft-tech-design$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function apiTaskRefreshSourcePlanningId(pathname: string): string | undefined {
  const match = /^\/api\/tasks\/([^/]+)\/refresh-source-planning$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function apiTaskReplaceSpecId(pathname: string): string | undefined {
  const match = /^\/api\/tasks\/([^/]+)\/replace-spec$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function apiTaskSyncSourceStatusId(pathname: string): string | undefined {
  const match = /^\/api\/tasks\/([^/]+)\/sync-source-status$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function apiTaskApproveSpecId(pathname: string): string | undefined {
  const match = /^\/api\/tasks\/([^/]+)\/approve-spec$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function apiTaskApproveTechDesignId(pathname: string): string | undefined {
  const match = /^\/api\/tasks\/([^/]+)\/approve-tech-design$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function apiRunId(pathname: string): string | undefined {
  const match = /^\/api\/runs\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function apiRunLogsStreamId(pathname: string): string | undefined {
  const match = /^\/api\/runs\/([^/]+)\/logs\/stream$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function apiRunQuestionAnswerId(
  pathname: string,
): { runId: string; questionId: string } | undefined {
  const match = /^\/api\/runs\/([^/]+)\/questions\/([^/]+)\/answer$/.exec(
    pathname,
  );
  return match
    ? {
        runId: decodeURIComponent(match[1]),
        questionId: decodeURIComponent(match[2]),
      }
    : undefined;
}

export function apiRunReviewVerdictId(pathname: string): string | undefined {
  const match = /^\/api\/runs\/([^/]+)\/review-verdict$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function apiNotificationResolveId(pathname: string): string | undefined {
  const match = /^\/api\/notifications\/([^/]+)\/resolve$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function apiNotificationAssignId(pathname: string): string | undefined {
  const match = /^\/api\/notifications\/([^/]+)\/assign$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function apiNotificationActionsId(pathname: string): string | undefined {
  const match = /^\/api\/notifications\/([^/]+)\/actions$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function apiWorkItemId(pathname: string): string | undefined {
  const match = /^\/api\/work-items\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function apiWorkItemRunId(pathname: string): string | undefined {
  const match = /^\/api\/work-items\/([^/]+)\/runs$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function apiFlowId(pathname: string): string | undefined {
  const match = /^\/api\/flows\/(.+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function htmlRunId(pathname: string): string | undefined {
  const match = /^\/runs\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function htmlTaskId(pathname: string): string | undefined {
  const match = /^\/tasks\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}
