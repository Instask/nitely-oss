import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const API_TOKEN_CAPABILITIES = [
  "tasks:read",
  "tasks:write",
  "runs:read",
  "runs:start",
  "spec:approve",
  "preview:read",
  "preview:control",
  "preview:compare",
] as const;

export type ApiTokenCapability = (typeof API_TOKEN_CAPABILITIES)[number];

const capabilityOrder = new Map<ApiTokenCapability, number>(
  API_TOKEN_CAPABILITIES.map((capability, index) => [capability, index]),
);
const highImpactCapabilities = new Set<ApiTokenCapability>([
  "tasks:write",
  "runs:start",
  "spec:approve",
  "preview:control",
  "preview:compare",
]);

interface StoredApiTokenRecord {
  id: string;
  name: string;
  capabilities: ApiTokenCapability[];
  createdAt: string;
  tokenHash: string;
  /** Absent only on records minted before tokens carried an owner. */
  ownerUserId?: string;
  revokedAt?: string;
}

export interface ApiTokenRecord {
  id: string;
  name: string;
  capabilities: ApiTokenCapability[];
  createdAt: string;
  ownerUserId?: string;
  revokedAt?: string;
}

interface ApiTokenFile {
  version: 1;
  tokens: Record<string, StoredApiTokenRecord>;
}

export interface CreateApiTokenInput {
  name: string;
  capabilities: ApiTokenCapability[];
  /**
   * The user this token acts as. Callers validate that the user exists; the
   * store only refuses an empty value so no unowned token can be minted.
   */
  ownerUserId: string;
  allowHighImpact?: boolean;
  now?: () => Date;
}

export interface RevokeApiTokenOptions {
  now?: () => Date;
}

export interface ApiTokenRequestAuditInput {
  tokenId?: string;
  tokenName?: string;
  action: string;
  capability?: ApiTokenCapability;
  target?: { taskId?: string; runId?: string };
  decision: "allow" | "deny";
  outcome: "success" | "error";
  httpStatus: number;
  reasonCode: string;
  createdAt?: string;
  /** The user the token acted as; absent when the request was denied before an owner resolved. */
  onBehalfOf?: { userId: string };
}

type ApiTokenAuditEvent =
  | {
      version: 1;
      eventId: string;
      event: "token.created";
      tokenId: string;
      tokenName: string;
      capabilities: ApiTokenCapability[];
      createdAt: string;
      ownerUserId: string;
    }
  | {
      version: 1;
      eventId: string;
      event: "token.revoked";
      tokenId: string;
      tokenName: string;
      capabilities: ApiTokenCapability[];
      createdAt: string;
    }
  | ({
      version: 1;
      eventId: string;
      event: "token.request";
      createdAt: string;
    } & ApiTokenRequestAuditInput);

export function apiTokenStorePath(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "api-tokens", "tokens.json");
}

export function apiTokenAuditPath(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "api-tokens", "audit.jsonl");
}

function publicRecord(record: StoredApiTokenRecord): ApiTokenRecord {
  return {
    id: record.id,
    name: record.name,
    capabilities: [...record.capabilities],
    createdAt: record.createdAt,
    ...(record.ownerUserId ? { ownerUserId: record.ownerUserId } : {}),
    ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
  };
}

function isCapability(value: unknown): value is ApiTokenCapability {
  return API_TOKEN_CAPABILITIES.includes(value as ApiTokenCapability);
}

function parseStoredRecord(value: unknown, key: string): StoredApiTokenRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid API token store record: ${key}`);
  }
  const record = value as Record<string, unknown>;
  if (
    record.id !== key ||
    typeof record.name !== "string" ||
    !record.name ||
    typeof record.createdAt !== "string" ||
    typeof record.tokenHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.tokenHash) ||
    !Array.isArray(record.capabilities) ||
    !record.capabilities.every(isCapability) ||
    (record.ownerUserId !== undefined && typeof record.ownerUserId !== "string") ||
    (record.revokedAt !== undefined && typeof record.revokedAt !== "string")
  ) {
    throw new Error(`invalid API token store record: ${key}`);
  }
  return {
    id: key,
    name: record.name,
    capabilities: [...new Set(record.capabilities)],
    createdAt: record.createdAt,
    tokenHash: record.tokenHash,
    ...(typeof record.ownerUserId === "string" && record.ownerUserId
      ? { ownerUserId: record.ownerUserId }
      : {}),
    ...(typeof record.revokedAt === "string"
      ? { revokedAt: record.revokedAt }
      : {}),
  };
}

function parseTokenFile(value: unknown): ApiTokenFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid API token store: root must be an object");
  }
  const root = value as Record<string, unknown>;
  if (
    root.version !== 1 ||
    typeof root.tokens !== "object" ||
    root.tokens === null ||
    Array.isArray(root.tokens)
  ) {
    throw new Error("invalid API token store");
  }
  return {
    version: 1,
    tokens: Object.fromEntries(
      Object.entries(root.tokens as Record<string, unknown>).map(([key, record]) => [
        key,
        parseStoredRecord(record, key),
      ]),
    ),
  };
}

async function readTokenFile(repoPath: string): Promise<ApiTokenFile> {
  try {
    return parseTokenFile(
      JSON.parse(await readFile(apiTokenStorePath(repoPath), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, tokens: {} };
    }
    throw error;
  }
}

async function writeTokenFile(repoPath: string, file: ApiTokenFile): Promise<void> {
  const path = apiTokenStorePath(repoPath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(file, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function appendAuditEvent(
  repoPath: string,
  event: ApiTokenAuditEvent,
): Promise<void> {
  const path = apiTokenAuditPath(repoPath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tokenIdFromRawToken(token: string): string | undefined {
  const match = /^nitely_api_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{43})$/.exec(
    token,
  );
  return match ? `tok_${match[1]}` : undefined;
}

/**
 * Whether a capability may only be granted with an explicit confirmation.
 *
 * Exported so callers that need to reject — or warn about — a high-impact
 * grant *before* `createApiToken` runs can ask this list rather than restate
 * it. A second copy of the set is the duplication to avoid here.
 */
export function isHighImpactCapability(value: ApiTokenCapability): boolean {
  return highImpactCapabilities.has(value);
}

export function normalizeCapabilities(
  capabilities: ApiTokenCapability[],
): ApiTokenCapability[] {
  for (const capability of capabilities) {
    if (!isCapability(capability)) {
      throw new Error(`unknown API token capability: ${String(capability)}`);
    }
  }
  return [...new Set(capabilities)].sort(
    (left, right) =>
      (capabilityOrder.get(left) ?? 0) - (capabilityOrder.get(right) ?? 0),
  );
}

export async function createApiToken(
  repoPath: string,
  input: CreateApiTokenInput,
): Promise<{ token: string; record: ApiTokenRecord }> {
  const name = input.name.trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("API token name must be 1-80 printable characters");
  }
  const capabilities = normalizeCapabilities(input.capabilities);
  if (capabilities.length === 0) {
    throw new Error("at least one capability is required");
  }
  if (!input.allowHighImpact) {
    const capability = capabilities.find(isHighImpactCapability);
    if (capability) {
      throw new Error(
        `high-impact capability requires confirmation: ${capability}`,
      );
    }
  }
  const ownerUserId = input.ownerUserId.trim();
  if (!ownerUserId) {
    throw new Error("API token owner is required");
  }

  const idPart = randomBytes(12).toString("base64url");
  const id = `tok_${idPart}`;
  const token = `nitely_api_${idPart}_${randomBytes(32).toString("base64url")}`;
  const createdAt = (input.now ?? (() => new Date()))().toISOString();
  const stored: StoredApiTokenRecord = {
    id,
    name,
    capabilities,
    createdAt,
    tokenHash: tokenHash(token),
    ownerUserId,
  };
  const file = await readTokenFile(repoPath);
  file.tokens[id] = stored;
  await writeTokenFile(repoPath, file);
  await appendAuditEvent(repoPath, {
    version: 1,
    eventId: randomUUID(),
    event: "token.created",
    tokenId: id,
    tokenName: name,
    capabilities,
    createdAt,
    ownerUserId,
  });
  return { token, record: publicRecord(stored) };
}

export async function listApiTokens(repoPath: string): Promise<ApiTokenRecord[]> {
  const file = await readTokenFile(repoPath);
  return Object.values(file.tokens)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map(publicRecord);
}

export async function authenticateApiToken(
  repoPath: string,
  token: string,
): Promise<ApiTokenRecord | null> {
  const id = tokenIdFromRawToken(token);
  if (!id) return null;
  const record = (await readTokenFile(repoPath)).tokens[id];
  if (!record || record.revokedAt) return null;
  const actual = Buffer.from(record.tokenHash, "hex");
  const expected = Buffer.from(tokenHash(token), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? publicRecord(record)
    : null;
}

export function parseApiTokenId(token: string): string | undefined {
  return tokenIdFromRawToken(token);
}

export async function revokeApiToken(
  repoPath: string,
  tokenId: string,
  options: RevokeApiTokenOptions = {},
): Promise<ApiTokenRecord> {
  const file = await readTokenFile(repoPath);
  const record = file.tokens[tokenId];
  if (!record) {
    throw new Error("API token not found");
  }
  const revokedAt =
    record.revokedAt ?? (options.now ?? (() => new Date()))().toISOString();
  record.revokedAt = revokedAt;
  await writeTokenFile(repoPath, file);
  await appendAuditEvent(repoPath, {
    version: 1,
    eventId: randomUUID(),
    event: "token.revoked",
    tokenId: record.id,
    tokenName: record.name,
    capabilities: record.capabilities,
    createdAt: revokedAt,
  });
  return publicRecord(record);
}

export async function appendApiTokenRequestAudit(
  repoPath: string,
  input: ApiTokenRequestAuditInput,
): Promise<void> {
  await appendAuditEvent(repoPath, {
    ...input,
    version: 1,
    eventId: randomUUID(),
    event: "token.request",
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}
