import { describe, expect, it } from "vitest";

import {
  WEB_PERMISSIONS,
  organizationRoleHasPermission,
  webPermissionAllowed,
  type WebPermission,
} from "../../src/web/access-control.js";

const allPermissions = [...WEB_PERMISSIONS];

function allowedForRole(role: "owner" | "maintainer" | "member" | "viewer") {
  return allPermissions.filter((permission) =>
    organizationRoleHasPermission(role, permission),
  );
}

describe("Web access-control policy", () => {
  it("keeps local compatibility mode and global admins fully capable", () => {
    for (const permission of allPermissions) {
      expect(
        webPermissionAllowed(
          { authMode: "local", globalRole: "user", organizationRole: "viewer" },
          permission,
        ),
      ).toBe(true);
      expect(
        webPermissionAllowed(
          { authMode: "required", globalRole: "admin" },
          permission,
        ),
      ).toBe(true);
    }
  });

  it("gives owners the complete organization-scoped permission set", () => {
    expect(allowedForRole("owner")).toEqual([
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
    ] satisfies WebPermission[]);
  });

  it("lets maintainers coordinate work but not shared credential ownership", () => {
    expect(allowedForRole("maintainer")).toEqual([
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
    ] satisfies WebPermission[]);
  });

  it("preserves member task, run, approval, flow, and personal credential writes", () => {
    expect(allowedForRole("member")).toEqual([
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
    ] satisfies WebPermission[]);
  });

  it("keeps viewers read-only", () => {
    expect(allowedForRole("viewer")).toEqual([
      "tasks:view",
      "evidence:view",
      "preview:view",
    ] satisfies WebPermission[]);
  });

  it("keeps global operations out of organization roles", () => {
    for (const role of ["owner", "maintainer", "member", "viewer"] as const) {
      for (const permission of [
        "scheduler:run",
        "sessions:revoke",
        "security:audit:view",
        "context:manage",
        "knowledge:manage",
        "skills:manage",
        "demo:run",
      ] as const) {
        expect(organizationRoleHasPermission(role, permission)).toBe(false);
      }
    }
  });

  it("denies a normal required-auth user without a matching organization role", () => {
    for (const permission of allPermissions) {
      expect(
        webPermissionAllowed(
          { authMode: "required", globalRole: "user" },
          permission,
        ),
      ).toBe(false);
    }
  });
});
