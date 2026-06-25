import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  ensureDefaultOrganizationForUser,
  listPublicMemberships,
  type PublicOrganizationMembership,
} from "./organizations.js";

export type UserRole = "admin" | "user";

export interface UserRecord {
  id: string;
  email: string;
  role: UserRole;
  createdAt: string;
  passwordHash: string;
  passwordSalt: string;
  passwordParams: { algorithm: "scrypt"; keyLength: number };
}

export interface PublicUser {
  id: string;
  email: string;
  role: UserRole;
  memberships?: PublicOrganizationMembership[];
  currentOrganizationId?: string;
  currentOrganizationRole?: PublicOrganizationMembership["role"];
}

interface UsersFile {
  version: 1;
  users: Record<string, UserRecord>;
}

export interface SessionRecord {
  version: 1;
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface CreateUserInput {
  email: string;
  password: string;
  role: UserRole;
}

export interface SessionOptions {
  now?: () => Date;
  createId?: () => string;
}

const scrypt = promisify(scryptCallback);
const passwordParams = { algorithm: "scrypt" as const, keyLength: 32 };
const sessionTtlMs = 7 * 24 * 60 * 60 * 1000;

function usersRoot(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "users");
}

function usersPath(repoPath: string): string {
  return join(usersRoot(repoPath), "users.json");
}

function sessionPath(repoPath: string, sessionId: string): string {
  if (!/^sess_[A-Za-z0-9_-]{4,}$/.test(sessionId)) {
    throw new Error("invalid session id");
  }
  return join(usersRoot(repoPath), "sessions", `${sessionId}.json`);
}

function createUserId(): string {
  return `usr_${randomBytes(18).toString("base64url")}`;
}

function createSessionId(): string {
  return `sess_${randomBytes(32).toString("base64url")}`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function parseUsersFile(value: unknown): UsersFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid users.json: root must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error("invalid users.json: version must be 1");
  }
  if (
    typeof record.users !== "object" ||
    record.users === null ||
    Array.isArray(record.users)
  ) {
    throw new Error("invalid users.json: users must be an object");
  }
  return record as unknown as UsersFile;
}

async function readUsers(repoPath: string): Promise<UsersFile> {
  try {
    return parseUsersFile(JSON.parse(await readFile(usersPath(repoPath), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, users: {} };
    }
    throw error;
  }
}

export async function hasAnyUsers(repoPath: string): Promise<boolean> {
  const users = await readUsers(repoPath);
  return Object.keys(users.users).length > 0;
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

async function hashPassword(password: string): Promise<{
  passwordHash: string;
  passwordSalt: string;
  passwordParams: UserRecord["passwordParams"];
}> {
  const passwordSalt = randomBytes(16).toString("base64url");
  const hash = (await scrypt(password, passwordSalt, passwordParams.keyLength)) as Buffer;
  return {
    passwordHash: hash.toString("base64url"),
    passwordSalt,
    passwordParams,
  };
}

export function publicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
  };
}

async function publicUserWithOrganizations(
  repoPath: string,
  user: UserRecord,
): Promise<PublicUser> {
  const memberships = await listPublicMemberships(repoPath, user.id);
  const current = memberships[0];
  return {
    ...publicUser(user),
    ...(memberships.length > 0 ? { memberships } : {}),
    ...(current
      ? {
          currentOrganizationId: current.organizationId,
          currentOrganizationRole: current.role,
        }
      : {}),
  };
}

export async function createUser(
  repoPath: string,
  input: CreateUserInput,
): Promise<UserRecord> {
  const email = normalizeEmail(input.email);
  if (!email) {
    throw new Error("email is required");
  }
  if (!input.password) {
    throw new Error("password is required");
  }
  const users = await readUsers(repoPath);
  if (Object.values(users.users).some((user) => user.email === email)) {
    throw new Error("user already exists");
  }
  const verifier = await hashPassword(input.password);
  const user: UserRecord = {
    id: createUserId(),
    email,
    role: input.role,
    createdAt: new Date().toISOString(),
    ...verifier,
  };
  users.users[user.id] = user;
  await writeJsonAtomic(usersPath(repoPath), users);
  await ensureDefaultOrganizationForUser(repoPath, {
    userId: user.id,
    role: user.role === "admin" ? "owner" : "member",
  });
  return user;
}

export async function bootstrapInitialAdmin(
  repoPath: string,
  env: Record<string, string | undefined>,
): Promise<UserRecord | null> {
  const users = await readUsers(repoPath);
  const existing = Object.values(users.users).find((user) => user.role === "admin");
  if (existing) {
    return existing;
  }
  if (Object.keys(users.users).length > 0) {
    return null;
  }
  const email = env.NITELY_ADMIN_EMAIL;
  const password = env.NITELY_ADMIN_PASSWORD;
  if (!email || !password) {
    return null;
  }
  return await createUser(repoPath, { email, password, role: "admin" });
}

export async function verifyUserPassword(
  repoPath: string,
  email: string,
  password: string,
): Promise<UserRecord | null> {
  const users = await readUsers(repoPath);
  const user = Object.values(users.users).find(
    (candidate) => candidate.email === normalizeEmail(email),
  );
  if (!user || user.passwordParams.algorithm !== "scrypt") {
    return null;
  }
  const actual = Buffer.from(user.passwordHash, "base64url");
  const expected = (await scrypt(
    password,
    user.passwordSalt,
    user.passwordParams.keyLength,
  )) as Buffer;
  if (actual.length !== expected.length) {
    return null;
  }
  return timingSafeEqual(actual, expected) ? user : null;
}

export async function getPublicUser(
  repoPath: string,
  userId: string,
): Promise<PublicUser | null> {
  const users = await readUsers(repoPath);
  const user = users.users[userId];
  return user ? await publicUserWithOrganizations(repoPath, user) : null;
}

export async function createSession(
  repoPath: string,
  userId: string,
  options: SessionOptions = {},
): Promise<SessionRecord> {
  const now = options.now?.() ?? new Date();
  const session: SessionRecord = {
    version: 1,
    id: options.createId?.() ?? createSessionId(),
    userId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + sessionTtlMs).toISOString(),
  };
  await writeJsonAtomic(sessionPath(repoPath, session.id), session);
  return session;
}

async function readSession(
  repoPath: string,
  sessionId: string,
): Promise<SessionRecord | null> {
  try {
    return JSON.parse(await readFile(sessionPath(repoPath, sessionId), "utf8")) as SessionRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    if (error instanceof Error && error.message === "invalid session id") {
      return null;
    }
    throw error;
  }
}

export async function readSessionUser(
  repoPath: string,
  sessionId: string,
  options: Pick<SessionOptions, "now"> = {},
): Promise<PublicUser | null> {
  const session = await readSession(repoPath, sessionId);
  if (!session) {
    return null;
  }
  const now = options.now?.() ?? new Date();
  if (new Date(session.expiresAt).getTime() <= now.getTime()) {
    await deleteSession(repoPath, sessionId).catch(() => {});
    return null;
  }
  return await getPublicUser(repoPath, session.userId);
}

export async function deleteSession(
  repoPath: string,
  sessionId: string,
): Promise<void> {
  try {
    await unlink(sessionPath(repoPath, sessionId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
