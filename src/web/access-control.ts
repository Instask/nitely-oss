export const WEB_PERMISSIONS = [
  "tasks:view",
  "tasks:write",
  "planning:approve",
  "runs:start",
  "runs:review",
  "flows:manage",
  "providers:write:personal",
  "providers:write:shared",
  "notifications:manage",
  "notifications:resolve",
  "evidence:view",
  "evidence:export",
  "scheduler:run",
  "repositories:manage",
  "sessions:revoke",
  "security:audit:view",
  "context:manage",
  "knowledge:manage",
  "skills:manage",
  "demo:run",
  "preview:view",
  "preview:control",
] as const;

export type WebPermission = (typeof WEB_PERMISSIONS)[number];
export type WebOrganizationRole = "owner" | "maintainer" | "member" | "viewer";

export interface WebPermissionSubject {
  authMode: "local" | "required";
  globalRole: "admin" | "user";
  organizationRole?: WebOrganizationRole;
}

const organizationPermissions: Record<
  WebOrganizationRole,
  ReadonlySet<WebPermission>
> = {
  owner: new Set([
    "tasks:view",
    "tasks:write",
    "planning:approve",
    "runs:start",
    "runs:review",
    "flows:manage",
    "providers:write:personal",
    "providers:write:shared",
    "notifications:manage",
    "notifications:resolve",
    "evidence:view",
    "evidence:export",
    "repositories:manage",
    "preview:view",
    "preview:control",
  ]),
  maintainer: new Set([
    "tasks:view",
    "tasks:write",
    "planning:approve",
    "runs:start",
    "runs:review",
    "flows:manage",
    "providers:write:personal",
    "notifications:manage",
    "notifications:resolve",
    "evidence:view",
    "evidence:export",
    "repositories:manage",
    "preview:view",
    "preview:control",
  ]),
  member: new Set([
    "tasks:view",
    "tasks:write",
    "planning:approve",
    "runs:start",
    "runs:review",
    "flows:manage",
    "providers:write:personal",
    "notifications:resolve",
    "evidence:view",
    "preview:view",
    "preview:control",
  ]),
  viewer: new Set(["tasks:view", "evidence:view", "preview:view"]),
};

export function organizationRoleHasPermission(
  role: WebOrganizationRole | undefined,
  permission: WebPermission,
): boolean {
  return role ? organizationPermissions[role].has(permission) : false;
}

export function webPermissionAllowed(
  subject: WebPermissionSubject,
  permission: WebPermission,
): boolean {
  if (subject.authMode === "local" || subject.globalRole === "admin") {
    return true;
  }
  return organizationRoleHasPermission(subject.organizationRole, permission);
}
