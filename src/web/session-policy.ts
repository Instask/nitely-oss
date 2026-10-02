import type { OrganizationSecurityPolicy } from "./organizations.js";

export interface OrganizationSessionAccess {
  sessionDeniedOrganizationIds?: readonly string[];
  breakGlassOrganizationId?: string;
}

export function organizationSessionAccessAllowed(subject: OrganizationSessionAccess | undefined, organizationId?: string): boolean {
  return !organizationId || !subject?.sessionDeniedOrganizationIds?.includes(organizationId);
}

export function evaluateOrganizationSession(input: {
  policy: OrganizationSecurityPolicy;
  organizationId: string;
  organizationVersion: number;
  userVersion: number;
  session: {
    createdAt: string;
    expiresAt: string;
    authenticationMethod?: "password" | "oidc";
    organizationId?: string;
    organizationVersions?: Record<string, { organization: number; user: number }>;
    lastActivityAt?: string;
    organizationActivity?: Record<string, string>;
  };
  now: Date;
  breakGlass?: boolean;
}) {
  const { policy, session, organizationId } = input;
  const created = Date.parse(session.createdAt);
  const expires = Date.parse(session.expiresAt);
  const now = input.now.getTime();
  if (!Number.isFinite(created) || !Number.isFinite(expires) || created > now || now >= Math.min(expires, created + policy.maxSessionLifetimeSeconds * 1000)) return { allowed: false, reason: "session-expired" };
  const version = session.organizationVersions?.[organizationId];
  if ((version?.organization ?? 0) !== input.organizationVersion || (version?.user ?? 0) !== input.userVersion) return { allowed: false, reason: "session-revoked" };
  const activity = Date.parse(session.organizationActivity?.[organizationId] ?? session.lastActivityAt ?? session.createdAt);
  if (!Number.isFinite(activity) || activity > now || policy.idleTimeoutSeconds !== null && now >= activity + policy.idleTimeoutSeconds * 1000) return { allowed: false, reason: "idle-expired" };
  if (policy.ssoRequired && (session.authenticationMethod !== "oidc" || session.organizationId !== organizationId)) {
    return input.breakGlass ? { allowed: true, reason: "break-glass", breakGlass: true } : { allowed: false, reason: "sso-required" };
  }
  return { allowed: true, reason: "allowed" };
}
