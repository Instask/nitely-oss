import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { withKnowledgeLease } from "../knowledge-repositories/lock.js";
import { evaluateOrganizationSession, type OrganizationSessionAccess } from "./session-policy.js";
import { WebForbiddenError } from "./errors.js";

import {
  organizationSessionScopes,
  ensureDefaultOrganizationForUser,
  listPublicMemberships,
  type PublicOrganizationMembership,
} from "./organizations.js";
import {
  appendSecurityAuditEvent,
  securityAuditEventById,
} from "./security-audit.js";

export type UserRole = "admin" | "user";

export interface UserRecord {
  id: string;
  email: string;
  role: UserRole;
  createdAt: string;
  externalIdentities?: Array<{ issuer: string; subject: string }>;
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
  authenticationMethod?: "password" | "oidc";
  organizationId?: string;
  organizationVersions?: Record<string, { organization: number; user: number }>;
  lastActivityAt?: string;
  organizationActivity?: Record<string, string>;
}

export type SessionUser = PublicUser & OrganizationSessionAccess;

export interface CreateUserInput {
  email: string;
  password: string;
  role: UserRole;
}

export interface SessionOptions {
  authenticationMethod?: "password" | "oidc";
  organizationId?: string;
  now?: () => Date;
  createId?: () => string;
}

export interface VerifyPasswordOptions {
  derivePasswordKey?: (
    password: string,
    salt: string,
    keyLength: number,
  ) => Promise<Buffer>;
}

export type InitialAdminBootstrapStep =
  | "intent-persisted"
  | "user-persisted"
  | "organization-persisted"
  | "audit-persisted";

export interface BootstrapInitialAdminOptions {
  afterStep?: (step: InitialAdminBootstrapStep) => Promise<void> | void;
  now?: () => Date;
  createUserId?: () => string;
  createOrganizationId?: () => string;
  createAuditEventId?: () => string;
}

interface InitialAdminBootstrapJournalBase {
  version: 1;
  organizationId: string;
  auditEventId: string;
  startedAt: string;
}

interface PendingInitialAdminBootstrapJournal
  extends InitialAdminBootstrapJournalBase {
  status: "pending";
  user: UserRecord;
}

interface CompleteInitialAdminBootstrapJournal
  extends InitialAdminBootstrapJournalBase {
  status: "complete";
  userId: string;
  completedAt: string;
}

type InitialAdminBootstrapJournal =
  | PendingInitialAdminBootstrapJournal
  | CompleteInitialAdminBootstrapJournal;

const scrypt = promisify(scryptCallback);
const passwordParams = { algorithm: "scrypt" as const, keyLength: 32 };
const sessionTtlMs = 7 * 24 * 60 * 60 * 1000;
export const LOCAL_PASSWORD_MIN_CODE_POINTS = 15;
export const LOCAL_PASSWORD_MAX_CODE_POINTS = 128;
const missingUserPasswordSalt = "nitely-missing-user-password-v1";
const builtInBlockedPasswords = new Set([
  "123456789012345",
  "letmeinletmeinletmein",
  "password123456",
  "passwordpassword",
  "qwertyqwertyqwerty",
]);

function usersRoot(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "users");
}

function usersPath(repoPath: string): string {
  return join(usersRoot(repoPath), "users.json");
}

function initialAdminBootstrapPath(repoPath: string): string {
  return join(usersRoot(repoPath), "initial-admin-bootstrap.json");
}

function initialAdminBootstrapLockPath(repoPath: string): string {
  return join(usersRoot(repoPath), "initial-admin-bootstrap.lock");
}

function sessionsRoot(repoPath: string): string {
  return join(usersRoot(repoPath), "sessions");
}

function passwordBlocklistPath(repoPath: string): string {
  return join(usersRoot(repoPath), "password-blocklist.txt");
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

function createOrganizationId(): string {
  return `org_${randomBytes(18).toString("base64url")}`;
}

function createAuditEventId(): string {
  return `bootstrap-${randomBytes(18).toString("base64url")}`;
}

function createSessionId(): string {
  return `sess_${randomBytes(32).toString("base64url")}`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function passwordCodePoints(password: string): number {
  return [...password].length;
}

export function validateLocalPassword(password: string): void {
  const length = passwordCodePoints(password);
  if (length < LOCAL_PASSWORD_MIN_CODE_POINTS) {
    throw new Error(
      `password must be at least ${LOCAL_PASSWORD_MIN_CODE_POINTS} characters`,
    );
  }
  if (length > LOCAL_PASSWORD_MAX_CODE_POINTS) {
    throw new Error(
      `password must be at most ${LOCAL_PASSWORD_MAX_CODE_POINTS} characters`,
    );
  }
  if (builtInBlockedPasswords.has(password.toLocaleLowerCase("en-US"))) {
    throw new Error("password is blocked");
  }
}

async function operatorBlockedPasswords(repoPath: string): Promise<Set<string>> {
  try {
    const lines = (await readFile(passwordBlocklistPath(repoPath), "utf8"))
      .split("\n")
      .map((line) => line.endsWith("\r") ? line.slice(0, -1) : line)
      .filter((line) => line !== "" && !line.startsWith("#"));
    return new Set(lines);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Set();
    }
    throw error;
  }
}

async function validateLocalPasswordForRepo(
  repoPath: string,
  password: string,
): Promise<void> {
  validateLocalPassword(password);
  if ((await operatorBlockedPasswords(repoPath)).has(password)) {
    throw new Error("password is blocked");
  }
}

async function derivePasswordKey(
  password: string,
  salt: string,
  keyLength: number,
): Promise<Buffer> {
  return await scrypt(password, salt, keyLength) as Buffer;
}

function validIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function parseUserRecord(
  key: string,
  value: unknown,
  source = "users.json",
): UserRecord {
  const invalid = (detail: string): never => {
    throw new Error(`invalid ${source}: ${detail}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("user must be an object");
  }
  const user = value as Record<string, unknown>;
  if (
    typeof user.id !== "string" ||
    !/^usr_[A-Za-z0-9_-]{4,}$/.test(user.id) ||
    user.id !== key
  ) {
    return invalid("user id must match its storage key");
  }
  if (
    typeof user.email !== "string" ||
    !user.email ||
    normalizeEmail(user.email) !== user.email
  ) {
    return invalid("user email must be non-empty and normalized");
  }
  if (user.externalIdentities !== undefined && (!Array.isArray(user.externalIdentities) || user.externalIdentities.some((identity) =>
    !identity || typeof identity !== "object" || typeof identity.issuer !== "string" || !identity.issuer || typeof identity.subject !== "string" || !identity.subject))) return invalid("external identities must contain issuer and subject");
  if (user.role !== "admin" && user.role !== "user") {
    return invalid("user role must be admin or user");
  }
  if (!validIsoTimestamp(user.createdAt)) {
    return invalid("user createdAt must be an ISO timestamp");
  }
  if (
    typeof user.passwordHash !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(user.passwordHash) ||
    Buffer.from(user.passwordHash, "base64url").length !== passwordParams.keyLength
  ) {
    return invalid("user passwordHash is invalid");
  }
  if (
    typeof user.passwordSalt !== "string" ||
    !/^[A-Za-z0-9_-]{16,}$/.test(user.passwordSalt)
  ) {
    return invalid("user passwordSalt is invalid");
  }
  if (
    typeof user.passwordParams !== "object" ||
    user.passwordParams === null ||
    Array.isArray(user.passwordParams) ||
    (user.passwordParams as Record<string, unknown>).algorithm !== "scrypt" ||
    (user.passwordParams as Record<string, unknown>).keyLength !==
      passwordParams.keyLength
  ) {
    return invalid("user passwordParams are invalid");
  }
  return user as unknown as UserRecord;
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
  for (const [key, user] of Object.entries(record.users)) {
    parseUserRecord(key, user);
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

function parseInitialAdminBootstrapJournal(
  value: unknown,
): InitialAdminBootstrapJournal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid initial admin bootstrap journal: root must be an object");
  }
  const journal = value as Record<string, unknown>;
  if (
    journal.version !== 1 ||
    (journal.status !== "pending" && journal.status !== "complete") ||
    typeof journal.organizationId !== "string" ||
    !/^org_[A-Za-z0-9_-]{4,}$/.test(journal.organizationId) ||
    typeof journal.auditEventId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,159}$/.test(journal.auditEventId) ||
    !validIsoTimestamp(journal.startedAt)
  ) {
    throw new Error("invalid initial admin bootstrap journal: metadata is invalid");
  }
  const base = {
    version: 1 as const,
    organizationId: journal.organizationId,
    auditEventId: journal.auditEventId,
    startedAt: journal.startedAt,
  };
  if (journal.status === "complete") {
    if (
      typeof journal.userId !== "string" ||
      !/^usr_[A-Za-z0-9_-]{4,}$/.test(journal.userId) ||
      !validIsoTimestamp(journal.completedAt)
    ) {
      throw new Error(
        "invalid initial admin bootstrap journal: completion metadata is invalid",
      );
    }
    return {
      ...base,
      status: "complete",
      userId: journal.userId,
      completedAt: journal.completedAt,
    };
  }

  const userValue = journal.user;
  const userKey = typeof userValue === "object" &&
      userValue !== null &&
      !Array.isArray(userValue)
    ? (userValue as Record<string, unknown>).id
    : undefined;
  if (typeof userKey !== "string") {
    throw new Error("invalid initial admin bootstrap journal: user is invalid");
  }
  const user = parseUserRecord(
    userKey,
    userValue,
    "initial admin bootstrap journal",
  );
  if (user.role !== "admin") {
    throw new Error("invalid initial admin bootstrap journal: user must be an admin");
  }
  return { ...base, status: "pending", user };
}

async function readInitialAdminBootstrapJournal(
  repoPath: string,
): Promise<InitialAdminBootstrapJournal | null> {
  try {
    return parseInitialAdminBootstrapJournal(
      JSON.parse(await readFile(initialAdminBootstrapPath(repoPath), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

interface InitialAdminBootstrapLock {
  path: string;
  ownerPath: string;
  ownerId: string;
  ownerHandle: Awaited<ReturnType<typeof open>>;
  heartbeat: ReturnType<typeof setInterval>;
}

const bootstrapLockStaleMs = 60_000;
const bootstrapLockWaitMs = 10_000;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function bootstrapLockIsStale(path: string): Promise<boolean> {
  const ownerPath = join(path, "owner.json");
  try {
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as {
      pid?: unknown;
    };
    if (typeof owner.pid === "number" && !processIsAlive(owner.pid)) return true;
    return Date.now() - (await stat(ownerPath)).mtimeMs > bootstrapLockStaleMs;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "ENOENT" &&
      !(error instanceof SyntaxError)
    ) {
      throw error;
    }
    try {
      return Date.now() - (await stat(path)).mtimeMs > 1_000;
    } catch (pathError) {
      if ((pathError as NodeJS.ErrnoException).code === "ENOENT") {
        return true;
      }
      throw pathError;
    }
  }
}

async function acquireInitialAdminBootstrapLock(
  repoPath: string,
): Promise<InitialAdminBootstrapLock> {
  const root = usersRoot(repoPath);
  const path = initialAdminBootstrapLockPath(repoPath);
  const recoveryPath = `${path}.recovery`;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + bootstrapLockWaitMs;
  while (true) {
    try {
      const recoveryAge = Date.now() - (await stat(recoveryPath)).mtimeMs;
      if (recoveryAge > 1_000) {
        await rm(recoveryPath, { recursive: true, force: true });
      } else {
        if (Date.now() >= deadline) {
          throw new Error("timed out waiting for initial admin bootstrap lock");
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await mkdir(path, { mode: 0o700 });
      const ownerPath = join(path, "owner.json");
      const ownerId = randomBytes(18).toString("base64url");
      const ownerHandle = await open(ownerPath, "wx", 0o600);
      try {
        await ownerHandle.writeFile(
          JSON.stringify({
            version: 1,
            ownerId,
            pid: process.pid,
            acquiredAt: new Date().toISOString(),
          }),
          "utf8",
        );
        await ownerHandle.sync();
      } catch (error) {
        await ownerHandle.close().catch(() => {});
        await rm(path, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      const heartbeat = setInterval(() => {
        const now = new Date();
        void ownerHandle.utimes(now, now).catch(() => {});
      }, Math.floor(bootstrapLockStaleMs / 4));
      heartbeat.unref();
      return { path, ownerPath, ownerId, ownerHandle, heartbeat };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await bootstrapLockIsStale(path)) {
        try {
          await mkdir(recoveryPath, { mode: 0o700 });
        } catch (recoveryError) {
          if ((recoveryError as NodeJS.ErrnoException).code !== "EEXIST") {
            throw recoveryError;
          }
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
          continue;
        }
        try {
          if (await bootstrapLockIsStale(path)) {
            await rm(path, { recursive: true, force: true });
          }
        } catch (recheckError) {
          if ((recheckError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw recheckError;
          }
        } finally {
          await rm(recoveryPath, { recursive: true, force: true });
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for initial admin bootstrap lock");
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
}

async function releaseInitialAdminBootstrapLock(
  lock: InitialAdminBootstrapLock,
): Promise<void> {
  clearInterval(lock.heartbeat);
  await lock.ownerHandle.close().catch(() => {});
  try {
    const owner = JSON.parse(await readFile(lock.ownerPath, "utf8")) as {
      ownerId?: unknown;
    };
    if (owner.ownerId === lock.ownerId) {
      await rm(lock.path, { recursive: true, force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function withInitialAdminBootstrapLock<T>(
  repoPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = await acquireInitialAdminBootstrapLock(repoPath);
  try {
    return await operation();
  } finally {
    await releaseInitialAdminBootstrapLock(lock);
  }
}

function sameUserRecord(left: UserRecord, right: UserRecord): boolean {
  return left.id === right.id &&
    left.email === right.email &&
    left.role === right.role &&
    left.createdAt === right.createdAt &&
    left.passwordHash === right.passwordHash &&
    left.passwordSalt === right.passwordSalt &&
    left.passwordParams.algorithm === right.passwordParams.algorithm &&
    left.passwordParams.keyLength === right.passwordParams.keyLength;
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

async function ensureInitialAdminBootstrapAudit(
  repoPath: string,
  journal: InitialAdminBootstrapJournal,
  userId: string,
): Promise<void> {
  const existingAudit = await securityAuditEventById(
    repoPath,
    journal.auditEventId,
  );
  if (existingAudit) {
    if (
      existingAudit.action !== "auth.bootstrap" ||
      existingAudit.reasonCode !== "explicit_initial_admin" ||
      existingAudit.decision !== "allow" ||
      existingAudit.outcome !== "success" ||
      existingAudit.httpStatus !== 200 ||
      existingAudit.actor.type !== "anonymous" ||
      existingAudit.target?.type !== "user" ||
      existingAudit.target.id !== userId
    ) {
      throw new Error(
        "initial admin bootstrap audit event conflicts with its durable intent",
      );
    }
    return;
  }
  await appendSecurityAuditEvent(repoPath, {
    action: "auth.bootstrap",
    decision: "allow",
    outcome: "success",
    httpStatus: 200,
    reasonCode: "explicit_initial_admin",
    actor: { type: "anonymous" },
    target: { type: "user", id: userId },
    now: () => new Date(journal.startedAt),
    createEventId: () => journal.auditEventId,
  });
}

async function resumeInitialAdminBootstrap(
  repoPath: string,
  journal: PendingInitialAdminBootstrapJournal,
  options: BootstrapInitialAdminOptions,
): Promise<UserRecord> {
  const users = await readUsers(repoPath);
  const stored = users.users[journal.user.id];
  if (!stored) {
    if (Object.keys(users.users).length > 0) {
      throw new Error(
        "initial admin bootstrap conflicts with users created after its durable intent",
      );
    }
    users.users[journal.user.id] = journal.user;
    await writeJsonAtomic(usersPath(repoPath), users);
  } else if (!sameUserRecord(stored, journal.user)) {
    throw new Error(
      "initial admin bootstrap user record does not match its durable intent",
    );
  }
  await options.afterStep?.("user-persisted");

  await ensureDefaultOrganizationForUser(
    repoPath,
    { userId: journal.user.id, role: "owner" },
    {
      createId: () => journal.organizationId,
      now: () => new Date(journal.startedAt),
      enforceRole: true,
    },
  );
  await options.afterStep?.("organization-persisted");

  await ensureInitialAdminBootstrapAudit(repoPath, journal, journal.user.id);
  await options.afterStep?.("audit-persisted");

  await writeJsonAtomic(initialAdminBootstrapPath(repoPath), {
    version: 1,
    status: "complete",
    userId: journal.user.id,
    organizationId: journal.organizationId,
    auditEventId: journal.auditEventId,
    startedAt: journal.startedAt,
    completedAt: (options.now?.() ?? new Date()).toISOString(),
  } satisfies CompleteInitialAdminBootstrapJournal);
  return journal.user;
}

async function validateCompletedInitialAdminBootstrap(
  repoPath: string,
  journal: CompleteInitialAdminBootstrapJournal,
): Promise<UserRecord | null> {
  await ensureInitialAdminBootstrapAudit(repoPath, journal, journal.userId);
  const users = await readUsers(repoPath);
  const referenced = users.users[journal.userId];
  const admin = referenced?.role === "admin"
    ? referenced
    : Object.values(users.users).find((user) => user.role === "admin");
  if (!admin) return null;
  await ensureDefaultOrganizationForUser(repoPath, {
    userId: admin.id,
    role: "owner",
  });
  return admin;
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
  await validateLocalPasswordForRepo(repoPath, input.password);
  const user = await withKnowledgeLease({ path: join(usersRoot(repoPath), "users.lock"), waitMs: 10_000 }, async () => {
    const users = await readUsers(repoPath);
    if (Object.values(users.users).some((user) => user.email === email)) {
      throw new Error("user already exists");
    }
    const verifier = await hashPassword(input.password);
    const created: UserRecord = {
      id: createUserId(),
      email,
      role: input.role,
      createdAt: new Date().toISOString(),
      ...verifier,
    };
    users.users[created.id] = created;
    await writeJsonAtomic(usersPath(repoPath), users);
    return created;
  });
  await ensureDefaultOrganizationForUser(repoPath, {
    userId: user.id,
    role: user.role === "admin" ? "owner" : "member",
  });
  return user;
}

export async function bootstrapInitialAdmin(
  repoPath: string,
  env: Record<string, string | undefined>,
  options: BootstrapInitialAdminOptions = {},
): Promise<UserRecord | null> {
  return await withInitialAdminBootstrapLock(repoPath, async () => {
    const journal = await readInitialAdminBootstrapJournal(repoPath);
    if (journal) {
      return journal.status === "complete"
        ? await validateCompletedInitialAdminBootstrap(repoPath, journal)
        : await resumeInitialAdminBootstrap(repoPath, journal, options);
    }

    const users = await readUsers(repoPath);
    const existing = Object.values(users.users).find(
      (user) => user.role === "admin",
    );
    if (existing) {
      await ensureDefaultOrganizationForUser(repoPath, {
        userId: existing.id,
        role: "owner",
      });
      return existing;
    }
    if (Object.keys(users.users).length > 0) return null;

    const email = env.NITELY_ADMIN_EMAIL;
    const password = env.NITELY_ADMIN_PASSWORD;
    if (!email || !password) return null;
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) throw new Error("email is required");
    await validateLocalPasswordForRepo(repoPath, password);
    const startedAt = (options.now?.() ?? new Date()).toISOString();
    const user: UserRecord = {
      id: options.createUserId?.() ?? createUserId(),
      email: normalizedEmail,
      role: "admin",
      createdAt: startedAt,
      ...(await hashPassword(password)),
    };
    const pending: PendingInitialAdminBootstrapJournal = {
      version: 1,
      status: "pending",
      user,
      organizationId:
        options.createOrganizationId?.() ?? createOrganizationId(),
      auditEventId: options.createAuditEventId?.() ?? createAuditEventId(),
      startedAt,
    };
    await writeJsonAtomic(initialAdminBootstrapPath(repoPath), pending);
    await options.afterStep?.("intent-persisted");
    return await resumeInitialAdminBootstrap(repoPath, pending, options);
  });
}

export async function verifyUserPassword(
  repoPath: string,
  email: string,
  password: string,
  options: VerifyPasswordOptions = {},
): Promise<UserRecord | null> {
  const users = await readUsers(repoPath);
  const user = Object.values(users.users).find(
    (candidate) => candidate.email === normalizeEmail(email),
  );
  const derive = options.derivePasswordKey ?? derivePasswordKey;
  if (!user || user.passwordParams.algorithm !== "scrypt") {
    await derive(password, missingUserPasswordSalt, passwordParams.keyLength);
    return null;
  }
  const actual = Buffer.from(user.passwordHash, "base64url");
  const expected = await derive(
    password,
    user.passwordSalt,
    user.passwordParams.keyLength,
  );
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
  const user = Object.hasOwn(users.users, userId) ? users.users[userId] : undefined;
  return user ? await publicUserWithOrganizations(repoPath, user) : null;
}

/**
 * Resolves an operator-typed owner reference. Ids are matched exactly; emails
 * the way `createUser` stores them, so `Owner@Example.test` finds the user
 * created as `owner@example.test`.
 */
export async function findUserByIdOrEmail(
  repoPath: string,
  value: string,
): Promise<PublicUser | null> {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const users = await readUsers(repoPath);
  const byId = Object.hasOwn(users.users, trimmed) ? users.users[trimmed] : undefined;
  if (byId) return await publicUserWithOrganizations(repoPath, byId);
  const email = normalizeEmail(trimmed);
  const byEmail = Object.values(users.users).find((user) => user.email === email);
  return byEmail ? await publicUserWithOrganizations(repoPath, byEmail) : null;
}

export async function listPublicUsers(repoPath: string): Promise<PublicUser[]> {
  const users = await readUsers(repoPath);
  return await Promise.all(
    Object.values(users.users)
      .sort((left, right) =>
        left.email.localeCompare(right.email) || left.id.localeCompare(right.id),
      )
      .map((user) => publicUserWithOrganizations(repoPath, user)),
  );
}

export async function createSession(
  repoPath: string,
  userId: string,
  options: SessionOptions = {},
): Promise<SessionRecord> {
  const user = await getPublicUser(repoPath, userId);
  if (!user) throw new Error("session user not found");
  const scopes = await organizationSessionScopes(repoPath, userId, user.role === "admin");
  const now = options.now?.() ?? new Date();
  const session: SessionRecord = {
    version: 1,
    id: options.createId?.() ?? createSessionId(),
    userId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + sessionTtlMs).toISOString(),
    authenticationMethod: options.authenticationMethod ?? "password",
    organizationVersions: Object.fromEntries(scopes.map((scope) => [scope.organizationId, { organization: scope.organizationVersion, user: scope.userVersion }])),
    ...(options.organizationId ? { organizationId: options.organizationId } : {}),
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
  options: Pick<SessionOptions, "now" | "organizationId"> & { touch?: boolean; breakGlass?: boolean; auditBreakGlass?: boolean } = {},
): Promise<SessionUser | null> {
  let path: string;
  try { path = sessionPath(repoPath, sessionId); } catch { return null; }
  if (!(await readSession(repoPath, sessionId))) return null;
  // Touches and logout share this lease so an in-flight idle refresh cannot resurrect a revoked session.
  return await withKnowledgeLease({ path: path + ".lock", waitMs: 10_000 }, async () => {
    const session = await readSession(repoPath, sessionId);
    if (!session) return null;
    const now = options.now?.() ?? new Date();
    if (!Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= now.getTime()) {
      await unlink(path);
      return null;
    }
    const user = await getPublicUser(repoPath, session.userId);
    if (!user) return null;
    if (session.authenticationMethod === "oidc" && !user.memberships?.some((member) => member.organizationId === session.organizationId)) return null;
    const scopes = await organizationSessionScopes(repoPath, user.id, user.role === "admin");
    const requested = options.organizationId ?? session.organizationId ?? user.currentOrganizationId;
    const decisions = scopes.map((scope) => ({ ...scope, decision: evaluateOrganizationSession({ ...scope, session, now,
      breakGlass: options.breakGlass === true && user.role === "admin" && scope.organizationId === requested }) }));
    const selected = decisions.find((scope) => scope.organizationId === requested);
    if (options.organizationId && selected && !selected.decision.allowed) return null;
    const current = selected?.decision.allowed ? selected : decisions.find((scope) => scope.decision.allowed && user.memberships?.some((member) => member.organizationId === scope.organizationId));
    if (!current && user.memberships?.length) return null;
    if (current?.decision.breakGlass && options.auditBreakGlass !== false) {
      await appendSecurityAuditEvent(repoPath, { action: "auth.break-glass", decision: "allow", outcome: "success", httpStatus: 200,
        reasonCode: "sso_policy_recovery", actor: { type: "user", id: user.id, globalRole: "admin", organizationId: current.organizationId }, target: { type: "organization", id: current.organizationId } });
    }
    if (decisions.some((scope) => scope.decision.allowed && scope.policy.idleTimeoutSeconds !== null) && options.touch !== false) {
      const activity = session.organizationActivity ??= {};
      for (const scope of decisions) {
        if (scope.decision.allowed && scope.policy.idleTimeoutSeconds !== null) activity[scope.organizationId] = now.toISOString();
      }
      await writeJsonAtomic(path, session);
    }
    const role = user.memberships?.find((member) => member.organizationId === current?.organizationId)?.role;
    return { ...user, memberships: user.memberships?.filter((member) => decisions.find((scope) => scope.organizationId === member.organizationId)?.decision.allowed), sessionDeniedOrganizationIds: decisions.filter((scope) => !scope.decision.allowed).map((scope) => scope.organizationId),
      ...(current ? { currentOrganizationId: current.organizationId, currentOrganizationRole: role } : {}),
      ...(current?.decision.breakGlass ? { breakGlassOrganizationId: current.organizationId } : {}) };
  });
}

export async function deleteSession(repoPath: string, sessionId: string): Promise<void> {
  const path = sessionPath(repoPath, sessionId);
  if (!(await readSession(repoPath, sessionId))) return;
  await withKnowledgeLease({ path: path + ".lock", waitMs: 10_000 }, async () => {
    try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  });
}

export async function invalidateUserSessions(
  repoPath: string,
  userId: string,
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(sessionsRoot(repoPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  let invalidated = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const path = join(sessionsRoot(repoPath), entry);
    const session = JSON.parse(await readFile(path, "utf8")) as SessionRecord;
    if (session.userId !== userId) continue;
    try {
      await deleteSession(repoPath, session.id);
      invalidated += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return invalidated;
}


/** Immutable issuer/subject matching never falls back to matching an email. */
export async function resolveOidcUser(repoPath: string, input: {
  issuer: string; subject: string; email?: string; allowCreate: boolean; linkUserId?: string;
}): Promise<{ user: UserRecord; created: boolean }> {
  return await withKnowledgeLease({ path: join(usersRoot(repoPath), "users.lock"), waitMs: 10_000 }, async () => {
    const file = await readUsers(repoPath);
    const identity = { issuer: input.issuer, subject: input.subject };
    const matched = Object.values(file.users).find((user) => user.externalIdentities?.some((id) => id.issuer === identity.issuer && id.subject === identity.subject));
    if (matched) {
      if (input.linkUserId && input.linkUserId !== matched.id) throw new WebForbiddenError("OIDC identity is already linked");
      return { user: matched, created: false };
    }
    let user: UserRecord;
    let created = false;
    if (input.linkUserId) {
      if (!Object.hasOwn(file.users, input.linkUserId)) throw new WebForbiddenError();
      user = file.users[input.linkUserId];
    } else {
      const email = input.email && normalizeEmail(input.email);
      if (!input.allowCreate || !email || Object.values(file.users).some((user) => user.email === email)) throw new WebForbiddenError("OIDC identity requires explicit account linking");
      user = { id: createUserId(), email, role: "user", createdAt: new Date().toISOString(), ...(await hashPassword(randomBytes(48).toString("base64url"))) };
      created = true;
    }
    (user.externalIdentities ??= []).push(identity);
    file.users[user.id] = user;
    await writeJsonAtomic(usersPath(repoPath), file);
    return { user, created };
  });
}
