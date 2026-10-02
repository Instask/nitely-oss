import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { withKnowledgeLease } from "../knowledge-repositories/lock.js";
import { WebForbiddenError, WebInputError, WebNotFoundError } from "./errors.js";

import { organizationRoleHasPermission } from "./access-control.js";

export type OrganizationRole = "owner" | "maintainer" | "member" | "viewer";

export interface OrganizationMemberRecord {
  userId: string;
  role: OrganizationRole;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationRecord {
  id: string;
  name: string;
  members: Record<string, OrganizationMemberRecord>;
  createdAt: string;
  updatedAt: string;
  securityPolicy?: OrganizationSecurityPolicy;
  sessionRevocationVersion?: number;
  userSessionRevocationVersions?: Record<string, number>;
}

export interface OrganizationSecurityPolicy {
  version: 1;
  maxSessionLifetimeSeconds: number;
  idleTimeoutSeconds: number | null;
  ssoRequired: boolean;
}

export const DEFAULT_ORGANIZATION_SECURITY_POLICY: OrganizationSecurityPolicy = {
  version: 1, maxSessionLifetimeSeconds: 604800, idleTimeoutSeconds: null, ssoRequired: false,
};

export function validateOrganizationSecurityPolicy(value: unknown): OrganizationSecurityPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebInputError("invalid organization security policy");
  const policy = value as OrganizationSecurityPolicy;
  if (Object.keys(policy).some((key) => !["version", "maxSessionLifetimeSeconds", "idleTimeoutSeconds", "ssoRequired"].includes(key)) || policy.version !== 1 ||
    !Number.isInteger(policy.maxSessionLifetimeSeconds) || policy.maxSessionLifetimeSeconds < 1 || policy.maxSessionLifetimeSeconds > 2592000 ||
    policy.idleTimeoutSeconds !== null && (!Number.isInteger(policy.idleTimeoutSeconds) || policy.idleTimeoutSeconds < 1 || policy.idleTimeoutSeconds > 604800) ||
    typeof policy.ssoRequired !== "boolean") throw new WebInputError("invalid organization security policy");
  return { ...policy };
}

export interface PublicOrganizationMembership {
  organizationId: string;
  organizationName: string;
  role: OrganizationRole;
}

interface OrganizationsFile {
  version: 1;
  organizations: Record<string, OrganizationRecord>;
  invitations?: Record<string, OrganizationInvitation>;
}

export interface CreateOrganizationOptions {
  createId?: () => string;
  now?: () => Date;
}

export interface EnsureDefaultOrganizationOptions {
  createId?: () => string;
  now?: () => Date;
  enforceRole?: boolean;
}

function organizationsRoot(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "users");
}

function organizationsPath(repoPath: string): string {
  return join(organizationsRoot(repoPath), "organizations.json");
}

function createOrganizationId(): string {
  return `org_${randomBytes(18).toString("base64url")}`;
}

function validateOrganizationRole(value: unknown): OrganizationRole {
  if (
    value === "owner" ||
    value === "maintainer" ||
    value === "member" ||
    value === "viewer"
  ) {
    return value;
  }
  throw new WebInputError("invalid organization role");
}

function parseOrganizationsFile(value: unknown): OrganizationsFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid organizations.json: root must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error("invalid organizations.json: version must be 1");
  }
  if (
    typeof record.organizations !== "object" ||
    record.organizations === null ||
    Array.isArray(record.organizations)
  ) {
    throw new Error("invalid organizations.json: organizations must be an object");
  }
  for (const organization of Object.values(record.organizations)) {
    if (
      typeof organization !== "object" ||
      organization === null ||
      Array.isArray(organization)
    ) {
      throw new Error("invalid organizations.json: organization must be an object");
    }
    const org = organization as Record<string, unknown>;
    if (org.securityPolicy !== undefined) validateOrganizationSecurityPolicy(org.securityPolicy);
    if (org.sessionRevocationVersion !== undefined && (!Number.isSafeInteger(org.sessionRevocationVersion) || (org.sessionRevocationVersion as number) < 0)) throw new Error("invalid organization session revocation version");
    if (org.userSessionRevocationVersions !== undefined && (!org.userSessionRevocationVersions || typeof org.userSessionRevocationVersions !== "object" || Array.isArray(org.userSessionRevocationVersions) ||
      Object.values(org.userSessionRevocationVersions).some((version) => !Number.isSafeInteger(version) || (version as number) < 0))) throw new Error("invalid user session revocation versions");
    if (
      typeof org.members !== "object" ||
      org.members === null ||
      Array.isArray(org.members)
    ) {
      throw new Error("invalid organizations.json: members must be an object");
    }
    for (const member of Object.values(org.members)) {
      if (typeof member !== "object" || member === null || Array.isArray(member)) {
        throw new Error("invalid organizations.json: member must be an object");
      }
      validateOrganizationRole((member as Record<string, unknown>).role);
    }
  }
  if (record.invitations !== undefined) {
    if (!record.invitations || typeof record.invitations !== "object" || Array.isArray(record.invitations)) throw new Error("invalid organizations.json: invitations must be an object");
    for (const [id, value] of Object.entries(record.invitations)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid organizations.json: invitation must be an object");
      const invitation = value as Record<string, unknown>;
      if (invitation.id !== id || typeof invitation.organizationId !== "string" || !Object.hasOwn(record.organizations, invitation.organizationId) ||
        typeof invitation.email !== "string" || typeof invitation.createdBy !== "string" ||
        typeof invitation.createdAt !== "string" || !Number.isFinite(Date.parse(invitation.createdAt)) ||
        typeof invitation.expiresAt !== "string" || !Number.isFinite(Date.parse(invitation.expiresAt)) ||
        typeof invitation.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(invitation.tokenHash) ||
        !["pending", "accepted", "declined", "revoked"].includes(String(invitation.status))) throw new Error("invalid organizations.json: invalid invitation");
      validateOrganizationRole(invitation.role);
    }
  }
  return record as unknown as OrganizationsFile;
}

async function readOrganizations(repoPath: string): Promise<OrganizationsFile> {
  try {
    return parseOrganizationsFile(
      JSON.parse(await readFile(organizationsPath(repoPath), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, organizations: {} };
    }
    throw error;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmp, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmp, path);
    const parentHandle = await open(parent, "r");
    try {
      await parentHandle.sync();
    } finally {
      await parentHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

function publicMemberships(
  file: OrganizationsFile,
  userId: string,
): PublicOrganizationMembership[] {
  return Object.values(file.organizations)
    .filter((organization) => organization.members[userId])
    .map((organization) => ({
      organizationId: organization.id,
      organizationName: organization.name,
      role: organization.members[userId].role,
    }))
    .sort((left, right) =>
      left.organizationName.localeCompare(right.organizationName) ||
      left.organizationId.localeCompare(right.organizationId),
    );
}

export async function createOrganization(
  repoPath: string,
  input: {
    name: string;
    members?: Record<string, OrganizationRole>;
  },
  options: CreateOrganizationOptions = {},
): Promise<OrganizationRecord> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("organization name is required");
  }
  return await mutateOrganizations(repoPath, (file) => {
    const now = (options.now?.() ?? new Date()).toISOString();
    const id = options.createId?.() ?? createOrganizationId();
    const members: Record<string, OrganizationMemberRecord> = {};
    for (const [userId, role] of Object.entries(input.members ?? {})) {
      members[userId] = {
        userId,
        role: validateOrganizationRole(role),
        createdAt: now,
        updatedAt: now,
      };
    }
    const organization: OrganizationRecord = {
      id,
      name,
      members,
      createdAt: now,
      updatedAt: now,
    };
    file.organizations[id] = organization;
    return organization;
  });
}

export async function ensureDefaultOrganizationForUser(
  repoPath: string,
  input: { userId: string; role: OrganizationRole },
  options: EnsureDefaultOrganizationOptions = {},
): Promise<OrganizationRecord> {
  const role = validateOrganizationRole(input.role);
  return await mutateOrganizations(repoPath, (file) => {
    const existing = Object.values(file.organizations).find(
      (organization) => organization.members[input.userId],
    );
    if (existing) {
      if (
        options.enforceRole &&
        existing.members[input.userId].role !== role
      ) {
        const now = (options.now?.() ?? new Date()).toISOString();
        existing.members[input.userId].role = role;
        existing.members[input.userId].updatedAt = now;
        existing.updatedAt = now;
      }
      return existing;
    }
    const now = (options.now?.() ?? new Date()).toISOString();
    const organization: OrganizationRecord = {
      id: options.createId?.() ?? createOrganizationId(),
      name: "Default Team",
      members: {
        [input.userId]: {
          userId: input.userId,
          role,
          createdAt: now,
          updatedAt: now,
        },
      },
      createdAt: now,
      updatedAt: now,
    };
    file.organizations[organization.id] = organization;
    return organization;
  });
}

export async function addOrganizationMember(
  repoPath: string,
  organizationId: string,
  input: { userId: string; role: OrganizationRole },
): Promise<OrganizationRecord> {
  return await mutateOrganizations(repoPath, (file) => {
    const organization = file.organizations[organizationId];
    if (!organization) {
      throw new Error("organization not found");
    }
    const now = new Date().toISOString();
    const existing = organization.members[input.userId];
    organization.members[input.userId] = {
      userId: input.userId,
      role: validateOrganizationRole(input.role),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    organization.updatedAt = now;
    return organization;
  });
}


export async function listPublicMemberships(
  repoPath: string,
  userId: string,
): Promise<PublicOrganizationMembership[]> {
  return publicMemberships(await readOrganizations(repoPath), userId);
}

export function organizationRoleCanWrite(role: OrganizationRole | undefined): boolean {
  return organizationRoleHasPermission(role, "tasks:write");
}

export interface OrganizationInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: OrganizationRole;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "accepted" | "declined" | "revoked";
  tokenHash: string;
}

export type OrganizationActor = { id: string; email: string };

async function mutateOrganizations<T>(repoPath: string, operation: (file: OrganizationsFile) => T): Promise<T> {
  // ponytail: one lease for the organization file; split storage per org if write throughput requires it.
  return await withKnowledgeLease({ path: join(organizationsRoot(repoPath), "organizations.lock"), waitMs: 10_000 }, async (lease) => {
    const file = await readOrganizations(repoPath);
    const owned = Object.values(file.organizations).filter((org) => Object.values(org.members).some((member) => member.role === "owner")).map((org) => org.id);
    const result = operation(file);
    for (const id of owned) {
      if (!Object.values(file.organizations[id].members).some((member) => member.role === "owner")) throw new WebInputError("organization must retain an owner");
    }
    await lease.assertOwned();
    await writeJsonAtomic(organizationsPath(repoPath), file);
    return result;
  });
}

function organizationForActor(file: OrganizationsFile, id: string, actor: OrganizationActor, manage = false): OrganizationRecord {
  const org = Object.hasOwn(file.organizations, id) ? file.organizations[id] : undefined;
  const role = org && Object.hasOwn(org.members, actor.id) ? org.members[actor.id].role : undefined;
  if (!org || !role) throw new WebNotFoundError("organization not found");
  if (manage && !organizationRoleHasPermission(role, "organizations:manage")) throw new WebForbiddenError();
  return org;
}

function publicInvitation(invitation: OrganizationInvitation, now = new Date()) {
  const { tokenHash: _secret, ...metadata } = invitation;
  return { ...metadata, status: invitation.status === "pending" && Date.parse(invitation.expiresAt) <= now.getTime() ? "expired" : invitation.status };
}

export async function listOrganizationMembers(repoPath: string, id: string, actor: OrganizationActor) {
  return Object.values(organizationForActor(await readOrganizations(repoPath), id, actor).members);
}

export async function changeOrganizationMember(repoPath: string, id: string, actor: OrganizationActor, userId: string, role?: unknown) {
  return await mutateOrganizations(repoPath, (file) => {
    const org = organizationForActor(file, id, actor, true);
    if (!Object.hasOwn(org.members, userId)) throw new WebNotFoundError("member not found");
    if (role === undefined) {
      delete org.members[userId];
      const versions = org.userSessionRevocationVersions ??= {};
      versions[userId] = (versions[userId] ?? 0) + 1;
    }
    else org.members[userId] = { ...org.members[userId], role: validateOrganizationRole(role), updatedAt: new Date().toISOString() };
    org.updatedAt = new Date().toISOString();
    return { ok: true };
  });
}

export async function listOrganizationInvitations(repoPath: string, id: string, actor: OrganizationActor) {
  const file = await readOrganizations(repoPath);
  organizationForActor(file, id, actor, true);
  return Object.values(file.invitations ?? {}).filter((invite) => invite.organizationId === id).map((invite) => publicInvitation(invite));
}

export async function createOrganizationInvitation(repoPath: string, id: string, actor: OrganizationActor, input: { email: unknown; role: unknown; expiresInSeconds?: unknown }, now = new Date()) {
  if (typeof input.email !== "string" || input.email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(input.email.trim())) throw new WebInputError("valid invitation email is required");
  const role = validateOrganizationRole(input.role);
  const expires = input.expiresInSeconds ?? 7 * 86400;
  if (typeof expires !== "number" || !Number.isInteger(expires) || expires < 1 || expires > 30 * 86400) throw new WebInputError("invitation expiry must be between 1 and 2592000 seconds");
  const email = input.email.trim().toLocaleLowerCase("en-US");
  const token = randomBytes(32).toString("base64url");
  return await mutateOrganizations(repoPath, (file) => {
    organizationForActor(file, id, actor, true);
    const invitation: OrganizationInvitation = { id: `inv_${randomBytes(18).toString("base64url")}`, organizationId: id,
      email, role, createdBy: actor.id, createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + expires * 1000).toISOString(), status: "pending", tokenHash: createHash("sha256").update(token).digest("hex") };
    (file.invitations ??= {})[invitation.id] = invitation;
    return { invitation: publicInvitation(invitation, now), token };
  });
}

export async function resolveOrganizationInvitation(repoPath: string, id: string, invitationId: string, actor: OrganizationActor, action: "accept" | "decline" | "revoke", token?: unknown, now = new Date()) {
  return await mutateOrganizations(repoPath, (file) => {
    if (action === "revoke") organizationForActor(file, id, actor, true);
    const invitation = file.invitations && Object.hasOwn(file.invitations, invitationId) ? file.invitations[invitationId] : undefined;
    if (!invitation || invitation.organizationId !== id || invitation.status !== "pending" || Date.parse(invitation.expiresAt) <= now.getTime()) throw new WebNotFoundError("invitation not found");
    if (action !== "revoke" && (typeof token !== "string" || token.length !== 43 || invitation.email !== actor.email.toLocaleLowerCase("en-US") || !timingSafeEqual(createHash("sha256").update(token).digest(), Buffer.from(invitation.tokenHash, "hex")))) throw new WebNotFoundError("invitation not found");
    if (action === "accept") {
      const org = file.organizations[id];
      // An invitation never changes the role of an existing member.
      if (!Object.hasOwn(org.members, actor.id)) org.members[actor.id] = { userId: actor.id, role: invitation.role, createdAt: now.toISOString(), updatedAt: now.toISOString() };
      org.updatedAt = now.toISOString();
    }
    invitation.status = action === "accept" ? "accepted" : action === "decline" ? "declined" : "revoked";
    return { invitation: publicInvitation(invitation, now) };
  });
}

export type OrganizationPolicyActor = OrganizationActor & { role?: "admin" | "user"; breakGlassOrganizationId?: string };

function policyOrganization(file: OrganizationsFile, id: string, actor: OrganizationPolicyActor) {
  if (actor.role === "admin" && actor.breakGlassOrganizationId === id) {
    if (!Object.hasOwn(file.organizations, id)) throw new WebNotFoundError("organization not found");
    return file.organizations[id];
  }
  return organizationForActor(file, id, actor, true);
}

export async function getOrganizationSecurityPolicy(repoPath: string, id: string, actor: OrganizationPolicyActor) {
  const org = policyOrganization(await readOrganizations(repoPath), id, actor);
  return { ...(org.securityPolicy ?? DEFAULT_ORGANIZATION_SECURITY_POLICY) };
}

export async function updateOrganizationSecurityPolicy(repoPath: string, id: string, actor: OrganizationPolicyActor, value: unknown) {
  const policy = validateOrganizationSecurityPolicy(value);
  return await mutateOrganizations(repoPath, (file) => {
    const org = policyOrganization(file, id, actor);
    org.securityPolicy = policy;
    org.updatedAt = new Date().toISOString();
    return policy;
  });
}

export async function revokeOrganizationSessions(repoPath: string, id: string, actor: OrganizationPolicyActor, userId?: string) {
  return await mutateOrganizations(repoPath, (file) => {
    const org = policyOrganization(file, id, actor);
    if (userId !== undefined) {
      if (!Object.hasOwn(org.members, userId)) throw new WebNotFoundError("member not found");
      const versions = org.userSessionRevocationVersions ??= {};
      versions[userId] = (versions[userId] ?? 0) + 1;
    } else org.sessionRevocationVersion = (org.sessionRevocationVersion ?? 0) + 1;
    org.updatedAt = new Date().toISOString();
    return { ok: true };
  });
}

export async function organizationSessionScopes(repoPath: string, userId: string, globalAdmin = false) {
  const file = await readOrganizations(repoPath);
  return Object.values(file.organizations).filter((org) => globalAdmin || Object.hasOwn(org.members, userId)).map((org) => ({
    organizationId: org.id,
    policy: org.securityPolicy ?? DEFAULT_ORGANIZATION_SECURITY_POLICY,
    organizationVersion: org.sessionRevocationVersion ?? 0,
    userVersion: org.userSessionRevocationVersions?.[userId] ?? 0,
  }));
}
