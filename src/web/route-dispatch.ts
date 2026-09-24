export interface HttpRouteContext {
  method: string;
  pathname: string;
}

export interface HttpRoute {
  method?: string;
  matches: (context: HttpRouteContext) => boolean;
  handle: () => Promise<boolean>;
}

/**
 * Small first-match seam for the standard-library HTTP adapter. A route may
 * decline after matching (for example when a static asset is absent), letting
 * the caller preserve its existing fallback behavior.
 */
export async function dispatchHttpRoutes(
  context: HttpRouteContext,
  routes: readonly HttpRoute[],
): Promise<boolean> {
  for (const route of routes) {
    if (route.method && route.method !== context.method) continue;
    if (!route.matches(context)) continue;
    if (await route.handle()) return true;
  }
  return false;
}

export const CONSOLE_LIST_API_PATHS = [
  "/api/runs",
  "/api/dashboard",
  "/api/agent-stability",
  "/api/tasks",
] as const;

export type ConsoleListApiPath = (typeof CONSOLE_LIST_API_PATHS)[number];

/**
 * GET-only console list endpoints. Adding a list route here is a table
 * entry, not another first-match `if` in `handleApiRequest`.
 */
export function consoleListApiRoutes(
  handlers: Record<ConsoleListApiPath, HttpRoute["handle"]>,
): HttpRoute[] {
  return CONSOLE_LIST_API_PATHS.map((pathname) => ({
    method: "GET",
    matches: (context: HttpRouteContext) => context.pathname === pathname,
    handle: handlers[pathname],
  }));
}
