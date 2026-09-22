import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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
    actor: input.actor,
    ...(input.target ? { target: input.target } : {}),
  };
}

export async function appendSecurityAuditEvent(
  repoPath: string,
  input: AppendSecurityAuditEventInput,
): Promise<SecurityAuditEvent> {
  const event = eventFromInput(input);
  const path = securityAuditPath(repoPath);
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
