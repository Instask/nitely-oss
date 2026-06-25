import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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
}

export interface PublicOrganizationMembership {
  organizationId: string;
  organizationName: string;
  role: OrganizationRole;
}

interface OrganizationsFile {
  version: 1;
  organizations: Record<string, OrganizationRecord>;
}

export interface CreateOrganizationOptions {
  createId?: () => string;
  now?: () => Date;
}

const writableRoles = new Set<OrganizationRole>([
  "owner",
  "maintainer",
  "member",
]);

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
  throw new Error("invalid organization role");
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

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, path);
  } catch (error) {
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
  const file = await readOrganizations(repoPath);
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
  await writeJsonAtomic(organizationsPath(repoPath), file);
  return organization;
}

export async function ensureDefaultOrganizationForUser(
  repoPath: string,
  input: { userId: string; role: OrganizationRole },
): Promise<OrganizationRecord> {
  const role = validateOrganizationRole(input.role);
  const file = await readOrganizations(repoPath);
  const existing = Object.values(file.organizations).find(
    (organization) => organization.members[input.userId],
  );
  if (existing) {
    return existing;
  }
  const now = new Date().toISOString();
  const organization: OrganizationRecord = {
    id: createOrganizationId(),
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
  await writeJsonAtomic(organizationsPath(repoPath), file);
  return organization;
}

export async function addOrganizationMember(
  repoPath: string,
  organizationId: string,
  input: { userId: string; role: OrganizationRole },
): Promise<OrganizationRecord> {
  const file = await readOrganizations(repoPath);
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
  await writeJsonAtomic(organizationsPath(repoPath), file);
  return organization;
}

export async function listPublicMemberships(
  repoPath: string,
  userId: string,
): Promise<PublicOrganizationMembership[]> {
  return publicMemberships(await readOrganizations(repoPath), userId);
}

export function organizationRoleCanWrite(role: OrganizationRole | undefined): boolean {
  return role ? writableRoles.has(role) : false;
}
