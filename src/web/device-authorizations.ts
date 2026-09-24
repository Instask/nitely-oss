import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readdir, readFile, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  type ApiTokenCapability,
  normalizeCapabilities,
} from "./api-tokens.js";
import { WebInputError, WebNotFoundError } from "./errors.js";
import { writeJsonAtomic } from "./users.js";

export const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

const USER_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const USER_CODE_LENGTH = 8;
const DEFAULT_CLIENT_NAME = "nitely cli";
const MAX_CODE_ALLOCATION_ATTEMPTS = 5;

export type DeviceAuthorizationStatus = "pending" | "approved" | "denied";

export interface DeviceAuthorizationRecord {
  version: 1;
  userCode: string;
  deviceCodeHash: string;
  status: DeviceAuthorizationStatus;
  capabilities: ApiTokenCapability[];
  allowHighImpact: boolean;
  clientName: string;
  createdAt: string;
  expiresAt: string;
  intervalSeconds: number;
  lastPolledAt?: string;
  approvedByUserId?: string;
}

export interface CreateDeviceAuthorizationInput {
  capabilities: ApiTokenCapability[];
  allowHighImpact?: boolean;
  clientName?: string;
  now?: () => Date;
}

export interface DecideDeviceAuthorizationInput {
  decision: "approve" | "deny";
  userId: string;
  now?: () => Date;
}

export interface ReadDeviceAuthorizationOptions {
  now?: () => Date;
}

export function deviceAuthorizationsRoot(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "device-authorizations");
}

export function deviceAuthorizationPath(
  repoPath: string,
  userCode: string,
): string {
  const normalized = normalizeUserCode(userCode);
  if (!normalized) throw new Error("invalid user code");
  return join(deviceAuthorizationsRoot(repoPath), `${normalized}.json`);
}

export function normalizeUserCode(value: string): string | undefined {
  const compact = value.replace(/[^0-9a-zA-Z]/g, "").toUpperCase();
  if (compact.length !== USER_CODE_LENGTH) return undefined;
  for (const character of compact) {
    if (!USER_CODE_ALPHABET.includes(character)) return undefined;
  }
  return compact;
}

export function formatUserCode(userCode: string): string {
  return `${userCode.slice(0, 4)}-${userCode.slice(4)}`;
}

function randomUserCode(): string {
  // Rejection-free because 256 is a whole multiple of the 32-character alphabet.
  return [...randomBytes(USER_CODE_LENGTH)]
    .map((byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length])
    .join("");
}

function deviceCodeHash(deviceCode: string): string {
  return createHash("sha256").update(deviceCode).digest("hex");
}

function userCodeFromDeviceCode(deviceCode: string): string | undefined {
  const [head, secret] = deviceCode.split(".");
  if (!head || !secret) return undefined;
  return normalizeUserCode(head);
}

function normalizeClientName(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return DEFAULT_CLIENT_NAME;
  // The client name is rendered as the requesting client's identity on the
  // consent screen, so it has to be safe to *read*, not merely safe to
  // insert. `textContent` stops markup injection but not visual spoofing:
  // U+202E (right-to-left override) and friends can make "cli@dev-box" render
  // as something else entirely. Reject the whole \p{C} class — control,
  // format, surrogate, private-use and unassigned — rather than just C0.
  if (trimmed.length > 80 || /\p{C}/u.test(trimmed)) {
    throw new Error("client name must be 1-80 printable characters");
  }
  return trimmed;
}

function isExpired(record: DeviceAuthorizationRecord, now: Date): boolean {
  return new Date(record.expiresAt).getTime() <= now.getTime();
}

export async function createDeviceAuthorization(
  repoPath: string,
  input: CreateDeviceAuthorizationInput,
): Promise<{ deviceCode: string; record: DeviceAuthorizationRecord }> {
  const capabilities = normalizeCapabilities(input.capabilities);
  if (capabilities.length === 0) {
    throw new Error("at least one capability is required");
  }
  const clientName = normalizeClientName(input.clientName);
  const now = (input.now ?? (() => new Date()))();

  // Creating a record is the only unauthenticated way to add a file here, so
  // it is also the right place to take the expired ones away: the store stays
  // bounded by what is live rather than by everything ever requested. Best
  // effort — a sweep that fails must not fail the login.
  await sweepExpiredDeviceAuthorizations(repoPath, { now: () => now }).catch(
    () => {},
  );

  for (let attempt = 0; attempt < MAX_CODE_ALLOCATION_ATTEMPTS; attempt += 1) {
    const userCode = randomUserCode();
    // A live record under this code means a collision; try another.
    if (await readDeviceAuthorization(repoPath, userCode, { now: () => now })) {
      continue;
    }
    const deviceCode = `${userCode}.${randomBytes(32).toString("base64url")}`;
    const record: DeviceAuthorizationRecord = {
      version: 1,
      userCode,
      deviceCodeHash: deviceCodeHash(deviceCode),
      status: "pending",
      capabilities,
      allowHighImpact: input.allowHighImpact ?? false,
      clientName,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + DEVICE_CODE_TTL_MS).toISOString(),
      intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
    };
    await writeJsonAtomic(deviceAuthorizationPath(repoPath, userCode), record);
    return { deviceCode, record };
  }
  throw new Error("could not allocate a device authorization code");
}

export async function readDeviceAuthorization(
  repoPath: string,
  userCode: string,
  options: ReadDeviceAuthorizationOptions = {},
): Promise<DeviceAuthorizationRecord | null> {
  const normalized = normalizeUserCode(userCode);
  if (!normalized) return null;
  let record: DeviceAuthorizationRecord;
  try {
    record = JSON.parse(
      await readFile(deviceAuthorizationPath(repoPath, normalized), "utf8"),
    ) as DeviceAuthorizationRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const now = (options.now ?? (() => new Date()))();
  if (isExpired(record, now)) {
    await deleteDeviceAuthorization(repoPath, normalized).catch(() => {});
    return null;
  }
  return record;
}

export async function resolveDeviceAuthorization(
  repoPath: string,
  deviceCode: string,
  options: ReadDeviceAuthorizationOptions = {},
): Promise<DeviceAuthorizationRecord | null> {
  const userCode = userCodeFromDeviceCode(deviceCode);
  if (!userCode) return null;
  const record = await readDeviceAuthorization(repoPath, userCode, options);
  if (!record) return null;
  const actual = Buffer.from(record.deviceCodeHash, "hex");
  const expected = Buffer.from(deviceCodeHash(deviceCode), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? record
    : null;
}

/**
 * Serializes the read-modify-write cycles on a single record inside this
 * process.
 *
 * A record is one whole JSON file, so any read-modify-write can clobber a
 * concurrent one. The case that matters: a poll reads a `pending` record, an
 * admin's denial lands, and the poll then writes its copy back — reverting
 * `status` to `pending` and making a denied request approvable again. That is
 * a fail-open on the one decision that must fail closed.
 *
 * Every path that changes a record — decide, poll, and the exchange's claim —
 * goes through here, so they observe each other's writes in a defined order
 * instead of racing on the file.
 *
 * A single process owns a home repo's `.nitely` store — session and throttle
 * state already live in that process's memory — so an in-process queue is
 * enough, and unlike an on-disk lock it cannot be left stale by a crash. The
 * map holds an entry only while a mutation for that code is in flight.
 */
const recordMutations = new Map<string, Promise<void>>();

function withRecordMutation<T>(
  repoPath: string,
  userCode: string,
  mutate: () => Promise<T>,
): Promise<T> {
  const key = `${resolve(repoPath)}\u0000${normalizeUserCode(userCode) ?? userCode}`;
  const previous = recordMutations.get(key) ?? Promise.resolve();
  // `mutate` runs whether the previous mutation resolved or rejected: one
  // caller's failure must not strand every caller queued behind it.
  const result = previous.then(mutate, mutate);
  const settled: Promise<void> = result.then(
    () => {},
    () => {},
  ).then(() => {
    // Only the last mutation queued for this code clears the entry, so the
    // map stays bounded by the number of codes being mutated right now.
    if (recordMutations.get(key) === settled) recordMutations.delete(key);
  });
  recordMutations.set(key, settled);
  return result;
}

export async function decideDeviceAuthorization(
  repoPath: string,
  userCode: string,
  input: DecideDeviceAuthorizationInput,
): Promise<DeviceAuthorizationRecord> {
  return await withRecordMutation(repoPath, userCode, async () => {
    const record = await readDeviceAuthorization(repoPath, userCode, {
      ...(input.now ? { now: input.now } : {}),
    });
    // These are reachable by racing two decisions on one code, so they are
    // ordinary bad input rather than a server fault: throw errors the HTTP
    // layer already maps to 404 and 400 instead of a bare Error, which would
    // surface as an opaque 500.
    if (!record) throw new WebNotFoundError("device authorization not found");
    if (record.status !== "pending") {
      throw new WebInputError("device authorization already decided");
    }
    const decided: DeviceAuthorizationRecord = {
      ...record,
      status: input.decision === "approve" ? "approved" : "denied",
      approvedByUserId: input.userId,
    };
    await writeJsonAtomic(
      deviceAuthorizationPath(repoPath, record.userCode),
      decided,
    );
    return decided;
  });
}

export async function recordDevicePoll(
  repoPath: string,
  userCode: string,
  polledAt: Date,
): Promise<void> {
  await withRecordMutation(repoPath, userCode, async () => {
    const record = await readDeviceAuthorization(repoPath, userCode, {
      now: () => polledAt,
    });
    if (!record) return;
    // `lastPolledAt` paces polls against a request nobody has decided yet.
    // Once a decision is recorded there is nothing left to pace — the next
    // poll either mints or reports the denial, and deletes the record either
    // way — so writing here would only risk carrying an older `status` back
    // onto disk. Refusing to write a decided record is what makes a decision
    // final.
    if (record.status !== "pending") return;
    await writeJsonAtomic(deviceAuthorizationPath(repoPath, record.userCode), {
      ...record,
      lastPolledAt: polledAt.toISOString(),
    } satisfies DeviceAuthorizationRecord);
  });
}

/**
 * Take exclusive ownership of a record, returning whether this caller is the
 * one that got it. Exactly one of any number of callers can be told `true`,
 * which is what lets the exchange mint at most one token per approval.
 *
 * Two deliberate choices here.
 *
 * The delete runs inside the mutation queue rather than relying on the
 * filesystem to arbitrate. Concurrent `unlink` of one path does *not* reliably
 * give the loser ENOENT: on macOS/APFS both callers are told the delete
 * succeeded (reproduced directly, at the syscall level, outside Node). Serialized
 * by the queue, the second caller's `unlink` genuinely runs after the first
 * has finished, so it sees ENOENT on every platform — the guarantee stops
 * depending on which filesystem the server happens to sit on.
 *
 * It is `unlink` and not `rm` because `rm` stats the path first and then
 * ignores an ENOENT raised by the unlink itself, which would report success to
 * a caller that removed nothing.
 */
export async function claimDeviceAuthorization(
  repoPath: string,
  userCode: string,
): Promise<boolean> {
  const normalized = normalizeUserCode(userCode);
  if (!normalized) return false;
  return await withRecordMutation(repoPath, normalized, async () => {
    try {
      await unlink(deviceAuthorizationPath(repoPath, normalized));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  });
}

/**
 * Delete every expired record in the store, returning how many went.
 *
 * `readDeviceAuthorization` only collects a record when somebody reads it by
 * its own user code, and nobody ever reads a code that was abandoned — or one
 * created purely to consume storage, since the create endpoint takes no
 * credential. Without this the directory only ever grows, and unbounded
 * directory entries slow down every later operation in it.
 */
export async function sweepExpiredDeviceAuthorizations(
  repoPath: string,
  options: ReadDeviceAuthorizationOptions = {},
): Promise<number> {
  const now = (options.now ?? (() => new Date()))();
  let entries: string[];
  try {
    entries = await readdir(deviceAuthorizationsRoot(repoPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const userCode = normalizeUserCode(entry.slice(0, -".json".length));
    if (!userCode) continue;
    let record: DeviceAuthorizationRecord;
    try {
      record = JSON.parse(
        await readFile(deviceAuthorizationPath(repoPath, userCode), "utf8"),
      ) as DeviceAuthorizationRecord;
    } catch {
      // Unreadable or unparsable: leave it. Only a record we can positively
      // show to be expired is ours to delete.
      continue;
    }
    if (!isExpired(record, now)) continue;
    await deleteDeviceAuthorization(repoPath, userCode).catch(() => {});
    removed += 1;
  }
  return removed;
}

export async function deleteDeviceAuthorization(
  repoPath: string,
  userCode: string,
): Promise<void> {
  const normalized = normalizeUserCode(userCode);
  if (!normalized) return;
  await rm(deviceAuthorizationPath(repoPath, normalized), { force: true });
}
