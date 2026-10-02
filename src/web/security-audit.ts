import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { withKnowledgeLease } from "../knowledge-repositories/lock.js";
import { writeJsonAtomic } from "./organizations.js";

import {
  WEB_PERMISSIONS,
  type WebOrganizationRole,
  type WebPermission,
} from "./access-control.js";

export type SecurityAuditDecision = "allow" | "deny";
export type SecurityAuditOutcome = "success" | "error";
export type SecurityAuditActorType = "local" | "user" | "api-token" | "anonymous";
export type SecurityAuditTargetType =
  | "audit"
  | "context"
  | "flow"
  | "knowledge-repository"
  | "organization"
  | "notification"
  | "provider"
  | "preview-session"
  | "repository"
  | "run"
  | "scheduler"
  | "skill"
  | "task"
  | "user"
  | "work-item";

export interface SecurityAuditActor {
  type: SecurityAuditActorType;
  id?: string;
  globalRole?: "admin" | "user";
  organizationId?: string;
  organizationRole?: WebOrganizationRole;
  subjectHash?: string;
}

export interface SecurityAuditTarget {
  type: SecurityAuditTargetType;
  id?: string;
}

export interface SecurityAuditContext {
  requestId?: string;
  sessionHash?: string;
  repositoryId?: string;
  taskId?: string;
  runId?: string;
  providerId?: string;
}

export interface SecurityAuditEvent {
  version: 1;
  event: "security.action";
  eventId: string;
  createdAt: string;
  action: string;
  permission?: WebPermission;
  decision: SecurityAuditDecision;
  outcome: SecurityAuditOutcome;
  httpStatus: number;
  reasonCode: string;
  actor: SecurityAuditActor;
  target?: SecurityAuditTarget;
  organizationId?: string;
  source?: string;
  context?: SecurityAuditContext;
}

export interface AppendSecurityAuditEventInput {
  action: string;
  permission?: WebPermission;
  decision: SecurityAuditDecision;
  outcome: SecurityAuditOutcome;
  httpStatus: number;
  reasonCode: string;
  actor: SecurityAuditActor;
  target?: SecurityAuditTarget;
  organizationId?: string;
  source?: string;
  context?: SecurityAuditContext;
  now?: () => Date;
  createEventId?: () => string;
}

export interface ListSecurityAuditEventsOptions {
  action?: string;
  decision?: SecurityAuditDecision;
  actorId?: string;
  limit?: number;
}

const metadataCode = /^[a-z][a-z0-9_.:-]{0,95}$/;
const metadataId = /^[A-Za-z0-9][A-Za-z0-9_.:@/_-]{0,159}$/;
const subjectHash = /^sha256:[a-f0-9]{64}$/;
const globalRoles = new Set(["admin", "user"]);
const organizationRoles = new Set<WebOrganizationRole>([
  "owner",
  "maintainer",
  "member",
  "viewer",
]);
const actorTypes = new Set<SecurityAuditActorType>([
  "local",
  "user",
  "api-token",
  "anonymous",
]);
const targetTypes = new Set<SecurityAuditTargetType>([
  "audit",
  "context",
  "flow",
  "knowledge-repository",
  "organization",
  "notification",
  "provider",
  "preview-session",
  "repository",
  "run",
  "scheduler",
  "skill",
  "task",
  "user",
  "work-item",
]);

export function securityAuditPath(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "security", "audit.jsonl");
}

export function securityAuditSubjectFingerprint(subject: string): string {
  return `sha256:${createHash("sha256")
    .update(subject.trim().toLocaleLowerCase("en-US"), "utf8")
    .digest("hex")}`;
}

function validateMetadataCode(value: string, label: string): void {
  if (!metadataCode.test(value)) {
    throw new Error(`invalid security audit ${label}`);
  }
}

function validateMetadataId(value: string, label: string): void {
  if (!metadataId.test(value)) {
    throw new Error(`invalid security audit ${label}`);
  }
}

function validateActor(actor: SecurityAuditActor): void {
  if (!actorTypes.has(actor.type)) {
    throw new Error("invalid security audit actor type");
  }
  if (actor.id !== undefined) validateMetadataId(actor.id, "actor id");
  if (actor.globalRole !== undefined && !globalRoles.has(actor.globalRole)) {
    throw new Error("invalid security audit global role");
  }
  if (actor.organizationId !== undefined) {
    validateMetadataId(actor.organizationId, "organization id");
  }
  if (
    actor.organizationRole !== undefined &&
    !organizationRoles.has(actor.organizationRole)
  ) {
    throw new Error("invalid security audit organization role");
  }
  if (actor.subjectHash !== undefined && !subjectHash.test(actor.subjectHash)) {
    throw new Error("invalid security audit subject hash");
  }
}

function validateTarget(target: SecurityAuditTarget): void {
  if (!targetTypes.has(target.type)) {
    throw new Error("invalid security audit target type");
  }
  if (target.id !== undefined) validateMetadataId(target.id, "target id");
}

function eventFromInput(
  input: AppendSecurityAuditEventInput,
): SecurityAuditEvent {
  const eventId = input.createEventId?.() ?? randomUUID();
  validateMetadataId(eventId, "event id");
  validateMetadataCode(input.action, "action");
  validateMetadataCode(input.reasonCode, "reason code");
  if (input.decision !== "allow" && input.decision !== "deny") {
    throw new Error("invalid security audit decision");
  }
  if (input.outcome !== "success" && input.outcome !== "error") {
    throw new Error("invalid security audit outcome");
  }
  if (
    input.permission !== undefined &&
    !(WEB_PERMISSIONS as readonly string[]).includes(input.permission)
  ) {
    throw new Error("invalid security audit permission");
  }
  if (!Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599) {
    throw new Error("invalid security audit HTTP status");
  }
  validateActor(input.actor);
  if (input.target) validateTarget(input.target);
  const organizationId = input.organizationId ?? input.actor.organizationId;
  if (organizationId) validateMetadataId(organizationId, "organization id");
  const source = input.source ?? (input.action.startsWith("providers.connection.") ? "provider" : "web");
  validateMetadataCode(source, "source");
  const context: SecurityAuditContext = {};
  for (const key of ["requestId", "sessionHash", "repositoryId", "taskId", "runId", "providerId"] as const) {
    const value = input.context?.[key];
    if (value !== undefined) { validateMetadataId(value, key); context[key] = value; }
  }
  return {
    version: 1,
    event: "security.action",
    eventId,
    createdAt: (input.now?.() ?? new Date()).toISOString(),
    action: input.action,
    ...(input.permission ? { permission: input.permission } : {}),
    decision: input.decision,
    outcome: input.outcome,
    httpStatus: input.httpStatus,
    reasonCode: input.reasonCode,
    actor: Object.fromEntries(Object.entries(input.actor).filter(([key]) => ["type", "id", "globalRole", "organizationId", "organizationRole", "subjectHash"].includes(key))) as unknown as SecurityAuditActor,
    ...(input.target ? { target: { type: input.target.type, ...(input.target.id ? { id: input.target.id } : {}) } } : {}),
    ...(organizationId ? { organizationId } : {}), source,
    ...(Object.keys(context).length ? { context } : {}),
  };
}

export async function appendSecurityAuditEvent(
  repoPath: string,
  input: AppendSecurityAuditEventInput,
): Promise<SecurityAuditEvent> {
  const path = securityAuditPath(repoPath);
  return await withKnowledgeLease({ path: path + ".lock", waitMs: 10_000 }, async () => {
    const event = eventFromInput(input);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    const handle = await open(path, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    const parentHandle = await open(dirname(path), "r");
    try {
      await parentHandle.sync();
    } finally {
      await parentHandle.close();
    }
    return event;
  });
}

async function readSecurityAuditEvents(
  repoPath: string,
): Promise<SecurityAuditEvent[]> {
  let content: string;
  try {
    content = await readFile(securityAuditPath(repoPath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!content.trim()) return [];
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SecurityAuditEvent);
}

export async function securityAuditEventById(
  repoPath: string,
  eventId: string,
): Promise<SecurityAuditEvent | null> {
  validateMetadataId(eventId, "event id");
  return (await readSecurityAuditEvents(repoPath)).find(
    (event) => event.eventId === eventId,
  ) ?? null;
}

export async function listSecurityAuditEvents(
  repoPath: string,
  options: ListSecurityAuditEventsOptions = {},
): Promise<SecurityAuditEvent[]> {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("security audit limit must be between 1 and 500");
  }
  if (options.action !== undefined) validateMetadataCode(options.action, "action");
  if (options.actorId !== undefined) validateMetadataId(options.actorId, "actor id");
  if (
    options.decision !== undefined &&
    options.decision !== "allow" &&
    options.decision !== "deny"
  ) {
    throw new Error("invalid security audit decision");
  }
  return (await readSecurityAuditEvents(repoPath))
    .filter((event) => options.action === undefined || event.action === options.action)
    .filter((event) =>
      options.decision === undefined || event.decision === options.decision,
    )
    .filter((event) => options.actorId === undefined || event.actor.id === options.actorId)
    .slice(-limit)
    .reverse();
}

export interface OrganizationAuditQuery extends SecurityAuditContext {
  organizationId: string;
  action?: string;
  actorId?: string;
  source?: string;
  result?: SecurityAuditOutcome;
  from?: string;
  until?: string;
  cursor?: string;
  eventId?: string;
  limit?: number;
}

function eventOrganization(event: SecurityAuditEvent): string | undefined {
  return event.organizationId ?? event.actor.organizationId;
}

// ponytail: bounded memory, linear file scan; use an indexed hosted store when scan latency matters.
async function* iterateAuditEvents(repoPath: string, normalize = true): AsyncGenerator<SecurityAuditEvent> {
  const path = securityAuditPath(repoPath);
  const stream = createReadStream(path);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line) continue;
      if (Buffer.byteLength(line) > 16_384) throw new Error("oversized security audit record");
      const raw = JSON.parse(line) as SecurityAuditEvent;
      if (raw.version !== 1 || raw.event !== "security.action" || typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))) throw new Error("invalid security audit record");
      // Project through the writer's metadata allowlist, including legacy rows.
      const projected = eventFromInput({ ...raw, now: () => new Date(raw.createdAt), createEventId: () => raw.eventId });
      yield normalize ? projected : raw;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally { lines.close(); stream.destroy(); }
}

export async function queryOrganizationAudit(repoPath: string, query: OrganizationAuditQuery): Promise<{ events: SecurityAuditEvent[]; nextCursor?: string }> {
  validateMetadataId(query.organizationId, "organization id");
  const limit = query.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("security audit limit must be between 1 and 500");
  for (const key of ["actorId", "cursor", "eventId", "repositoryId", "taskId", "runId", "providerId", "requestId", "sessionHash"] as const) {
    if (query[key] !== undefined) validateMetadataId(query[key]!, key);
  }
  for (const key of ["action", "source"] as const) if (query[key] !== undefined) validateMetadataCode(query[key]!, key);
  if (query.result !== undefined && !["success", "error"].includes(query.result)) throw new Error("invalid audit result");
  for (const value of [query.from, query.until]) {
    if (value !== undefined && (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) || !Number.isFinite(Date.parse(value)))) throw new Error("invalid audit time");
  }
  if (query.from && query.until && Date.parse(query.from) > Date.parse(query.until)) throw new Error("invalid audit time range");
  const events: SecurityAuditEvent[] = [];
  let foundCursor = !query.cursor;
  for await (const event of iterateAuditEvents(repoPath)) {
    if (eventOrganization(event) !== query.organizationId) continue;
    if (query.eventId !== undefined && event.eventId !== query.eventId) continue;
    if (event.eventId === query.cursor) { foundCursor = true; break; }
    if (query.action !== undefined && event.action !== query.action || query.actorId !== undefined && event.actor.id !== query.actorId || query.source !== undefined && event.source !== query.source || query.result !== undefined && event.outcome !== query.result || query.from !== undefined && Date.parse(event.createdAt) < Date.parse(query.from) || query.until !== undefined && Date.parse(event.createdAt) > Date.parse(query.until)) continue;
    if ((["repositoryId", "taskId", "runId", "providerId", "requestId", "sessionHash"] as const).some((key) => {
      if (query[key] === undefined) return false;
      const targetType = { repositoryId: "repository", taskId: "task", runId: "run", providerId: "provider", requestId: undefined, sessionHash: undefined }[key];
      return (event.context?.[key] ?? (event.target?.type === targetType ? event.target?.id : undefined)) !== query[key];
    })) continue;
    events.push(event);
    if (events.length > limit + 1) events.shift();
  }
  if (!foundCursor) throw new Error("audit cursor not found");
  const more = events.length > limit;
  if (more) events.shift();
  events.reverse();
  return { events, ...(more ? { nextCursor: events.at(-1)!.eventId } : {}) };
}

export interface OrganizationAuditRetention { version: 1; retentionDays: number | null }
function retentionPath(repoPath: string, org: string): string {
  validateMetadataId(org, "organization id");
  return join(dirname(securityAuditPath(repoPath)), "retention", createHash("sha256").update(org).digest("hex") + ".json");
}
function parseRetention(value: unknown): OrganizationAuditRetention {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["version", "retentionDays"].includes(key))) throw new Error("invalid audit retention policy");
  const policy = value as OrganizationAuditRetention;
  if (policy.version !== 1 || policy.retentionDays !== null && (!Number.isInteger(policy.retentionDays) || policy.retentionDays < 1 || policy.retentionDays > 3650)) throw new Error("retentionDays must be null or between 1 and 3650");
  return { version: 1, retentionDays: policy.retentionDays };
}
export async function getOrganizationAuditRetention(repoPath: string, org: string): Promise<OrganizationAuditRetention> {
  try { return parseRetention(JSON.parse(await readFile(retentionPath(repoPath, org), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, retentionDays: null }; throw error; }
}
export async function setOrganizationAuditRetention(repoPath: string, org: string, value: unknown, actor: SecurityAuditActor): Promise<OrganizationAuditRetention> {
  const policy = parseRetention(value);
  const path = retentionPath(repoPath, org);
  return await withKnowledgeLease({ path: path + ".lock", waitMs: 10_000 }, async () => {
    await appendSecurityAuditEvent(repoPath, { action: "audit.retention.update", decision: "allow", outcome: "success", httpStatus: 200, reasonCode: "ok", actor, organizationId: org, target: { type: "audit" } });
    await writeJsonAtomic(path, policy);
    return policy;
  });
}
export async function pruneOrganizationAudit(repoPath: string, org: string, actor: SecurityAuditActor, now = new Date()): Promise<{ deleted: number; cutoff: string | null }> {
  const policyPath = retentionPath(repoPath, org);
  return await withKnowledgeLease({ path: policyPath + ".lock", waitMs: 10_000 }, async () => {
    const policy = await getOrganizationAuditRetention(repoPath, org);
    const cutoff = policy.retentionDays === null ? null : new Date(now.getTime() - policy.retentionDays * 86_400_000).toISOString();
    await appendSecurityAuditEvent(repoPath, { action: "audit.retention.prune", decision: "allow", outcome: "success", httpStatus: 200, reasonCode: "requested", actor, organizationId: org, target: { type: "audit" }, now: () => now });
    if (cutoff === null) return { deleted: 0, cutoff };
    const path = securityAuditPath(repoPath);
    return await withKnowledgeLease({ path: path + ".lock", waitMs: 10_000 }, async () => {
      const temporary = path + "." + randomUUID() + ".tmp";
      const handle = await open(temporary, "wx", 0o600);
      let deleted = 0;
      try {
        for await (const event of iterateAuditEvents(repoPath, false)) {
          if (eventOrganization(event) === org && Date.parse(event.createdAt) < Date.parse(cutoff)) deleted++;
          else await handle.writeFile(JSON.stringify(event) + "\n", "utf8");
        }
        await handle.sync(); await handle.close();
        await rename(temporary, path);
        const parent = await open(dirname(path), "r");
        try { await parent.sync(); } finally { await parent.close(); }
      } catch (error) { await handle.close().catch(() => {}); await rm(temporary, { force: true }); throw error; }
      return { deleted, cutoff };
    });
  });
}
