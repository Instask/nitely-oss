import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { findAuthMethod, findDescriptor } from "./descriptors.js";
import { EnvProviderConnectionStore } from "./env-store.js";
import { FileProviderSecretStore } from "./secret-store.js";
import type { ProviderSecretMaterial, ProviderSecretStore } from "./secret-store.js";
import { MissingConnectionError, ReconnectRequiredError } from "./types.js";
import type {
  ProviderAccountIdentity,
  ProviderAuthMethod,
  ProviderConnection,
  ProviderConnectionRecord,
  ProviderConnectionSelector,
  ProviderConnectionState,
  ProviderConnectionStatus,
  ProviderConnectionStore,
  ProviderConnectionSummary,
  ProviderCredentialMetadata,
  ProviderId,
  SetConnectionInput,
} from "./types.js";

interface ConnectionsFile {
  version: 2;
  connections: ProviderConnectionRecord[];
}

/**
 * A loaded file plus the secrets a version-1 file still carries inline. Those
 * move into the secret store on the next write to that file.
 */
interface LoadedFile {
  file: ConnectionsFile;
  legacySecrets: Map<string, ProviderSecretMaterial>;
}

interface ConnectionSource {
  path: string;
  secrets: ProviderSecretStore;
}

interface LoadedConnection {
  record: ProviderConnectionRecord;
  source: ConnectionSource;
  legacySecret?: ProviderSecretMaterial;
}

export interface ProviderOAuthRefreshInput {
  providerId: ProviderId;
  authMethod: ProviderAuthMethod;
  connectionId: string;
  refreshToken: string;
}

export interface ProviderOAuthRefreshResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

export interface ProviderOAuthOptions {
  /**
   * Exchanges a refresh token for new material. Absent, an expired OAuth
   * credential is reported as reconnect-required instead of refreshed.
   */
  refresh?: (input: ProviderOAuthRefreshInput) => Promise<ProviderOAuthRefreshResult>;
}

export interface FileProviderConnectionStoreOptions {
  path: string;
  /**
   * Additional stores read, in order, for providers `path` does not hold.
   * Reads merge; new connections never leave `path`. Refresh rotation and
   * state changes are written to the store that holds the connection.
   */
  fallbackPaths?: string[];
  auditPath?: string;
  env: Record<string, string | undefined>;
  commandStatus?: (command: string, args: string[]) => Promise<boolean>;
  /** Defaults to a `0600` file beside each connections file. */
  secretStore?: (connectionsPath: string) => ProviderSecretStore;
  oauth?: ProviderOAuthOptions;
  now?: () => Date;
}

type ProviderCredentialAuditAction =
  | "set"
  | "clear"
  | "status-check"
  | "refresh"
  | "revoke"
  | "expired";

interface ProviderCredentialAuditEvent {
  version: 1;
  action: ProviderCredentialAuditAction;
  providerId: ProviderId;
  createdAt: string;
  result: "success" | "missing" | "configured" | "failed";
  connectionId?: string;
  authMethod?: ProviderAuthMethod;
  scope?: ProviderCredentialMetadata["scope"];
  source?: ProviderCredentialMetadata["source"];
  ownerId?: string;
  repositoryId?: string;
  organizationId?: string;
  rotationHint?: string;
  vaultRef?: string;
}

/** Credentials this close to expiry are refreshed before use. */
const EXPIRY_SKEW_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function legacyConnectionId(providerId: string): string {
  return `conn_legacy_${providerId}`;
}

function legacyCredentialRef(providerId: string): string {
  return `sec_legacy_${providerId}`;
}

async function readConnections(path: string): Promise<LoadedFile> {
  try {
    const content = await readFile(path, "utf8");
    return parseConnectionsFile(JSON.parse(content));
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { file: { version: 2, connections: [] }, legacySecrets: new Map() };
    }
    throw err;
  }
}

function parseConnectionsFile(value: unknown): LoadedFile {
  if (!isRecord(value)) {
    throw new Error("invalid connections.json: root must be an object");
  }
  if (value.version === 1) {
    return parseLegacyConnectionsFile(value);
  }
  if (value.version !== 2) {
    throw new Error("invalid connections.json: version must be 1 or 2");
  }
  if (!Array.isArray(value.connections)) {
    throw new Error("invalid connections.json: connections must be an array");
  }
  const connections = value.connections.map((entry, index) =>
    parseConnectionRecord(entry, `connections[${index}]`),
  );
  return { file: { version: 2, connections }, legacySecrets: new Map() };
}

/**
 * Version 1 keyed one inline secret per provider. Each entry becomes one
 * default connection whose auth method the provider's migration rule assigns.
 */
function parseLegacyConnectionsFile(value: Record<string, unknown>): LoadedFile {
  if (!isRecord(value.connections)) {
    throw new Error("invalid connections.json: connections must be an object");
  }
  const connections: ProviderConnectionRecord[] = [];
  const legacySecrets = new Map<string, ProviderSecretMaterial>();
  for (const [providerId, connection] of Object.entries(value.connections)) {
    const descriptor = findDescriptor(providerId as ProviderId);
    if (!isRecord(connection)) {
      throw new Error(
        `invalid connections.json: connections.${providerId} must be an object`,
      );
    }
    if (typeof connection.value !== "string") {
      throw new Error(
        `invalid connections.json: connections.${providerId}.value must be a string`,
      );
    }
    // A stored entry with no value is not a configuration. Treating it as one
    // lets a run pass preflight and then fail at spawn time, once the empty
    // value reaches the runtime.
    if (!connection.value.trim()) continue;
    const metadata = isRecord(connection.metadata)
      ? parseCredentialMetadata(providerId, connection.metadata)
      : { scope: "user" as const, source: "web-console" as const };
    const credentialRef = legacyCredentialRef(providerId);
    legacySecrets.set(credentialRef, { accessToken: connection.value });
    connections.push({
      id: legacyConnectionId(providerId),
      providerId: descriptor.id,
      authMethod: descriptor.legacyAuthMethod(connection.value),
      state: "active",
      isDefault: true,
      credentialRef,
      refreshable: false,
      credential: metadata,
      createdAt: metadata.createdAt ?? new Date(0).toISOString(),
      updatedAt: metadata.updatedAt ?? metadata.createdAt ?? new Date(0).toISOString(),
    });
  }
  return { file: { version: 2, connections }, legacySecrets };
}

function parseConnectionRecord(value: unknown, label: string): ProviderConnectionRecord {
  if (!isRecord(value)) {
    throw new Error(`invalid connections.json: ${label} must be an object`);
  }
  const providerId = optionalString(value.providerId);
  if (!providerId) {
    throw new Error(`invalid connections.json: ${label}.providerId is required`);
  }
  const descriptor = findDescriptor(providerId as ProviderId);
  const authMethod = optionalString(value.authMethod);
  if (!authMethod) {
    throw new Error(`invalid connections.json: ${label}.authMethod is required`);
  }
  findAuthMethod(descriptor, authMethod as ProviderAuthMethod);
  const id = optionalString(value.id);
  const credentialRef = optionalString(value.credentialRef);
  if (!id || !credentialRef) {
    throw new Error(`invalid connections.json: ${label}.id and credentialRef are required`);
  }
  const state = value.state;
  if (state !== "active" && state !== "expired" && state !== "revoked") {
    throw new Error(`invalid connections.json: ${label}.state is invalid`);
  }
  if (!isRecord(value.credential)) {
    throw new Error(`invalid connections.json: ${label}.credential is required`);
  }
  const account = isRecord(value.account) ? parseAccount(value.account) : undefined;
  return {
    id,
    providerId: descriptor.id,
    authMethod: authMethod as ProviderAuthMethod,
    ...(optionalString(value.label) ? { label: value.label as string } : {}),
    state,
    isDefault: value.isDefault === true,
    ...(Array.isArray(value.scopes)
      ? { scopes: value.scopes.filter((s): s is string => typeof s === "string") }
      : {}),
    ...(account ? { account } : {}),
    credentialRef,
    ...(optionalString(value.expiresAt) ? { expiresAt: value.expiresAt as string } : {}),
    refreshable: value.refreshable === true,
    credential: parseCredentialMetadata(providerId, value.credential),
    createdAt: optionalString(value.createdAt) ?? new Date(0).toISOString(),
    updatedAt: optionalString(value.updatedAt) ?? new Date(0).toISOString(),
    ...(optionalString(value.lastValidatedAt)
      ? { lastValidatedAt: value.lastValidatedAt as string }
      : {}),
  };
}

function parseAccount(value: Record<string, unknown>): ProviderAccountIdentity {
  return {
    ...(optionalString(value.id) ? { id: value.id as string } : {}),
    ...(optionalString(value.login) ? { login: value.login as string } : {}),
    ...(optionalString(value.displayName)
      ? { displayName: value.displayName as string }
      : {}),
    ...(optionalString(value.email) ? { email: value.email as string } : {}),
  };
}

function parseCredentialMetadata(
  providerId: string,
  value: Record<string, unknown>,
): ProviderCredentialMetadata {
  const scope = normalizeCredentialScope(value.scope);
  if (!scope) {
    throw new Error(
      `invalid connections.json: connections.${providerId}.metadata.scope is invalid`,
    );
  }
  const source = value.source;
  if (
    source !== "web-console" &&
    source !== "environment" &&
    source !== "external-vault"
  ) {
    throw new Error(
      `invalid connections.json: connections.${providerId}.metadata.source is invalid`,
    );
  }
  return {
    scope,
    source,
    ...(typeof value.ownerId === "string" ? { ownerId: value.ownerId } : {}),
    ...(typeof value.repositoryId === "string"
      ? { repositoryId: value.repositoryId }
      : {}),
    ...(typeof value.organizationId === "string"
      ? { organizationId: value.organizationId }
      : {}),
    ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
    ...(typeof value.lastStatusCheckedAt === "string"
      ? { lastStatusCheckedAt: value.lastStatusCheckedAt }
      : {}),
    ...(typeof value.rotationHint === "string"
      ? { rotationHint: value.rotationHint }
      : {}),
    ...(typeof value.vaultRef === "string" ? { vaultRef: value.vaultRef } : {}),
  };
}

function normalizeCredentialScope(
  value: unknown,
): ProviderCredentialMetadata["scope"] | undefined {
  if (
    value === "user" ||
    value === "repo" ||
    value === "org" ||
    value === "env-only" ||
    value === "external-vault-backed"
  ) {
    return value;
  }
  if (value === "env") {
    return "env-only";
  }
  if (value === "external-vault") {
    return "external-vault-backed";
  }
  return undefined;
}

function connectionMetadataForWrite(
  existing: ProviderCredentialMetadata | undefined,
  input: SetConnectionInput,
  now: string,
): ProviderCredentialMetadata {
  return {
    scope: input.metadata?.scope ?? existing?.scope ?? "user",
    source: input.metadata?.source ?? existing?.source ?? "web-console",
    ...(input.metadata?.ownerId ?? existing?.ownerId
      ? { ownerId: input.metadata?.ownerId ?? existing?.ownerId }
      : {}),
    ...(input.metadata?.repositoryId ?? existing?.repositoryId
      ? { repositoryId: input.metadata?.repositoryId ?? existing?.repositoryId }
      : {}),
    ...(input.metadata?.organizationId ?? existing?.organizationId
      ? { organizationId: input.metadata?.organizationId ?? existing?.organizationId }
      : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(input.metadata?.rotationHint ?? existing?.rotationHint
      ? { rotationHint: input.metadata?.rotationHint ?? existing?.rotationHint }
      : {}),
    ...(input.metadata?.vaultRef ?? existing?.vaultRef
      ? { vaultRef: input.metadata?.vaultRef ?? existing?.vaultRef }
      : {}),
  };
}

async function writeConnections(
  path: string,
  data: ConnectionsFile,
): Promise<void> {
  const tmp = `${path}.tmp.${Math.random().toString(36).slice(2, 8)}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, JSON.stringify(data, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, path);
}

/**
 * Exactly one connection per (provider, method) is the default. The oldest
 * remaining one takes over when the default is removed, so runtime selection
 * never depends on file order.
 */
function normalizeDefaults(
  connections: ProviderConnectionRecord[],
): ProviderConnectionRecord[] {
  const groups = new Map<string, ProviderConnectionRecord[]>();
  for (const record of connections) {
    const key = `${record.providerId}:${record.authMethod}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const result: ProviderConnectionRecord[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    const hasDefault = sorted.some((record) => record.isDefault);
    let seenDefault = false;
    for (const record of sorted) {
      const shouldDefault = hasDefault
        ? record.isDefault && !seenDefault
        : record === sorted[0];
      if (shouldDefault) seenDefault = true;
      result.push({ ...record, isDefault: shouldDefault });
    }
  }
  return result;
}

function effectiveState(
  record: ProviderConnectionRecord,
  now: Date,
): ProviderConnectionState {
  if (record.state !== "active") return record.state;
  if (record.expiresAt && !record.refreshable && isExpired(record.expiresAt, now)) {
    return "expired";
  }
  return "active";
}

function isExpired(expiresAt: string, now: Date): boolean {
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at - EXPIRY_SKEW_MS <= now.getTime();
}

function summarize(
  record: ProviderConnectionRecord,
  now: Date,
): ProviderConnectionSummary {
  const state = effectiveState(record, now);
  return {
    id: record.id,
    authMethod: record.authMethod,
    ...(record.label ? { label: record.label } : {}),
    state,
    isDefault: record.isDefault,
    reconnectRequired: state !== "active",
    refreshable: record.refreshable,
    ...(record.scopes ? { scopes: record.scopes } : {}),
    ...(record.account ? { account: record.account } : {}),
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
    credential: record.credential,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.lastValidatedAt ? { lastValidatedAt: record.lastValidatedAt } : {}),
  };
}

export class FileProviderConnectionStore implements ProviderConnectionStore {
  private readonly primary: ConnectionSource;
  private readonly fallbacks: ConnectionSource[];
  private readonly auditPath: string;
  private readonly env: Record<string, string | undefined>;
  private readonly inner: EnvProviderConnectionStore;
  private readonly oauth: ProviderOAuthOptions;
  private readonly now: () => Date;

  constructor(options: FileProviderConnectionStoreOptions) {
    const secretStore = options.secretStore ??
      ((path: string) => new FileProviderSecretStore(FileProviderSecretStore.pathFor(path)));
    this.primary = { path: options.path, secrets: secretStore(options.path) };
    this.fallbacks = (options.fallbackPaths ?? []).map((path) => ({
      path,
      secrets: secretStore(path),
    }));
    this.auditPath = options.auditPath ?? `${options.path}.audit.jsonl`;
    this.env = options.env;
    this.oauth = options.oauth ?? {};
    this.now = options.now ?? (() => new Date());
    this.inner = new EnvProviderConnectionStore({
      env: options.env,
      commandStatus: options.commandStatus,
    });
  }

  /**
   * Primary connections first; a fallback store only contributes providers
   * the primary does not hold at all, so a personal store shadows a shared
   * one per provider rather than per connection.
   */
  private async loadMerged(): Promise<LoadedConnection[]> {
    const merged: LoadedConnection[] = [];
    const held = new Set<string>();
    for (const source of [this.primary, ...this.fallbacks]) {
      const loaded = await readConnections(source.path);
      const providers = new Set(loaded.file.connections.map((c) => c.providerId));
      for (const record of loaded.file.connections) {
        if (held.has(record.providerId)) continue;
        merged.push({
          record,
          source,
          ...(loaded.legacySecrets.has(record.credentialRef)
            ? { legacySecret: loaded.legacySecrets.get(record.credentialRef) }
            : {}),
        });
      }
      for (const providerId of providers) held.add(providerId);
    }
    return merged;
  }

  private select(
    loaded: LoadedConnection[],
    providerId: ProviderId,
    selector: ProviderConnectionSelector | undefined,
  ): LoadedConnection | undefined {
    const forProvider = loaded.filter((c) => c.record.providerId === providerId);
    if (selector?.connectionId) {
      return forProvider.find((c) => c.record.id === selector.connectionId);
    }
    const descriptor = findDescriptor(providerId);
    const methods = selector?.authMethod
      ? [selector.authMethod]
      : descriptor.authMethods.map((m) => m.method);
    for (const method of methods) {
      const chosen = forProvider.find(
        (c) => c.record.authMethod === method && c.record.isDefault,
      );
      if (chosen) return chosen;
    }
    return undefined;
  }

  async getConnection(
    providerId: ProviderId,
    selector?: ProviderConnectionSelector,
  ): Promise<ProviderConnection> {
    const loaded = await this.loadMerged();
    const chosen = this.select(loaded, providerId, selector);
    if (!chosen) {
      if (selector?.connectionId) {
        throw new MissingConnectionError(
          providerId,
          `provider ${providerId} has no connection ${selector.connectionId}`,
        );
      }
      return this.inner.getConnection(providerId);
    }
    const { record } = chosen;
    return {
      providerId,
      connectionId: record.id,
      authMethod: record.authMethod,
      ...(record.account ? { account: record.account } : {}),
      ...(record.scopes ? { scopes: record.scopes } : {}),
      getAccessToken: async () => await this.resolveAccessToken(chosen),
    };
  }

  /**
   * The runtime boundary: returns a usable token or a structured
   * reconnect-required error, refreshing OAuth material when it can.
   */
  private async resolveAccessToken(loaded: LoadedConnection): Promise<string> {
    // Re-read so a refresh performed through another store instance is seen.
    const current = (await this.loadMerged()).find(
      (c) => c.record.id === loaded.record.id && c.source.path === loaded.source.path,
    ) ?? loaded;
    const { record, source } = current;
    if (record.state === "revoked") {
      throw this.reconnectRequired(record, "revoked");
    }
    const material = current.legacySecret ?? (await source.secrets.get(record.credentialRef));
    if (!material) {
      throw this.reconnectRequired(record, "revoked");
    }
    const now = this.now();
    const expired = record.state === "expired" ||
      (record.expiresAt !== undefined && isExpired(record.expiresAt, now));
    if (!expired) return material.accessToken;
    if (material.refreshToken && this.oauth.refresh) {
      return await this.refresh(current, material.refreshToken);
    }
    if (record.state !== "expired") {
      await this.updateRecord(source, record.id, { state: "expired" });
      await this.appendAuditEvent({
        version: 1,
        action: "expired",
        providerId: record.providerId,
        createdAt: now.toISOString(),
        result: "failed",
        connectionId: record.id,
        authMethod: record.authMethod,
        ...safeAuditMetadata(record.credential),
      });
    }
    throw this.reconnectRequired(record, "expired");
  }

  private async refresh(
    loaded: LoadedConnection,
    refreshToken: string,
  ): Promise<string> {
    const { record, source } = loaded;
    const refresh = this.oauth.refresh;
    if (!refresh) throw this.reconnectRequired(record, "expired");
    let result: ProviderOAuthRefreshResult;
    try {
      result = await refresh({
        providerId: record.providerId,
        authMethod: record.authMethod,
        connectionId: record.id,
        refreshToken,
      });
    } catch {
      await source.secrets.delete(record.credentialRef);
      await this.updateRecord(source, record.id, { state: "revoked" });
      await this.appendAuditEvent({
        version: 1,
        action: "refresh",
        providerId: record.providerId,
        createdAt: this.now().toISOString(),
        result: "failed",
        connectionId: record.id,
        authMethod: record.authMethod,
        ...safeAuditMetadata(record.credential),
      });
      throw this.reconnectRequired(record, "revoked");
    }
    const rotated: ProviderSecretMaterial = {
      accessToken: result.accessToken,
      // A provider that does not rotate refresh tokens keeps the old one valid.
      refreshToken: result.refreshToken ?? refreshToken,
      ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
    };
    await source.secrets.put(record.credentialRef, rotated);
    const validatedAt = this.now().toISOString();
    await this.updateRecord(source, record.id, {
      state: "active",
      refreshable: true,
      lastValidatedAt: validatedAt,
      ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
    });
    await this.appendAuditEvent({
      version: 1,
      action: "refresh",
      providerId: record.providerId,
      createdAt: validatedAt,
      result: "success",
      connectionId: record.id,
      authMethod: record.authMethod,
      ...safeAuditMetadata(record.credential),
    });
    return rotated.accessToken;
  }

  private reconnectRequired(
    record: ProviderConnectionRecord,
    reason: "expired" | "revoked",
  ): ReconnectRequiredError {
    return new ReconnectRequiredError(
      record.providerId,
      record.id,
      record.authMethod,
      reason,
      `provider ${record.providerId} connection ${record.id} (${record.authMethod}) is ${reason}; reconnect it in the Web Console`,
    );
  }

  private async updateRecord(
    source: ConnectionSource,
    id: string,
    patch: Partial<ProviderConnectionRecord>,
  ): Promise<void> {
    const file = await this.loadForWrite(source);
    const now = this.now().toISOString();
    file.connections = file.connections.map((record) =>
      record.id === id ? { ...record, ...patch, updatedAt: now } : record,
    );
    await writeConnections(source.path, file);
  }

  /**
   * Reads a file for rewriting, first moving any version-1 inline secrets
   * into the secret store so the rewritten file never carries them.
   */
  private async loadForWrite(source: ConnectionSource): Promise<ConnectionsFile> {
    const loaded = await readConnections(source.path);
    for (const [ref, material] of loaded.legacySecrets) {
      await source.secrets.put(ref, material);
    }
    return loaded.file;
  }

  async resolveEnv(): Promise<Record<string, string | undefined>> {
    const base = { ...this.env };
    const loaded = await this.loadMerged();
    const providers = new Set(loaded.map((c) => c.record.providerId));
    for (const providerId of providers) {
      const descriptor = findDescriptor(providerId);
      const projected = new Set<string>();
      for (const method of descriptor.authMethods) {
        if (!method.env) continue;
        const chosen = this.select(loaded, providerId, { authMethod: method.method });
        if (!chosen) continue;
        let token: string;
        try {
          token = await this.resolveAccessToken(chosen);
        } catch (error) {
          if (error instanceof ReconnectRequiredError) continue;
          throw error;
        }
        base[method.env] = token;
        projected.add(method.env);
      }
      // The stored connections are the single source of truth for this
      // provider. Leaving another of its variables in place — inherited from
      // the environment — would let the runtime authenticate as something the
      // operator did not configure here.
      for (const method of descriptor.authMethods) {
        if (method.env && !projected.has(method.env)) delete base[method.env];
      }
    }
    return base;
  }

  async listConnections(providerId?: ProviderId): Promise<ProviderConnectionRecord[]> {
    const loaded = await this.loadMerged();
    return loaded
      .map((c) => c.record)
      .filter((record) => providerId === undefined || record.providerId === providerId);
  }

  async listStatuses(): Promise<ProviderConnectionStatus[]> {
    const inner = await this.inner.listStatuses();
    const loaded = await this.loadMerged();
    const now = this.now();
    const checkedAt = now.toISOString();
    const statuses = inner.map((status): ProviderConnectionStatus => {
      const descriptor = findDescriptor(status.id);
      const stored = loaded
        .filter((c) => c.record.providerId === status.id)
        .map((c) => summarize(c.record, now));
      if (stored.length === 0) return status;
      const authMethods = status.authMethods.map((method) => {
        const connections = [
          ...stored.filter((c) => c.authMethod === method.method),
          ...method.connections,
        ];
        return {
          ...method,
          configured: connections.some((c) => c.state === "active"),
          connections,
        };
      });
      const configured = authMethods.some((m) => m.configured);
      const reconnectRequired = stored.some((c) => c.reconnectRequired);
      const selected = descriptor.authMethods
        .map((m) => stored.find((c) => c.authMethod === m.method && c.isDefault))
        .find((c) => c !== undefined);
      const storedConfigured = stored.some((c) => c.state === "active");
      return {
        ...status,
        configured,
        reconnectRequired,
        message: storedConfigured
          ? "Configured in Web Console."
          : reconnectRequired
            ? `Reconnect required: the stored ${descriptor.name} credential is ${stored.find((c) => c.reconnectRequired)?.state}.`
            : status.message,
        authMethods,
        ...(selected
          ? { credential: { ...selected.credential, lastStatusCheckedAt: checkedAt } }
          : {}),
      };
    });
    for (const status of statuses) {
      if (status.id === "codex") continue;
      await this.appendAuditEvent({
        version: 1,
        action: "status-check",
        providerId: status.id,
        createdAt: checkedAt,
        result: status.configured ? "configured" : "missing",
        ...safeAuditMetadata(status.credential),
      });
    }
    return statuses;
  }

  async setConnection(input: SetConnectionInput): Promise<ProviderConnectionRecord> {
    const descriptor = findDescriptor(input.providerId);
    if (!descriptor.writable) {
      throw new Error(`provider ${input.providerId} cannot be configured via Web Console`);
    }
    if (!input.value.trim()) {
      throw new Error(`provider ${input.providerId} credential cannot be empty`);
    }
    const authMethod = input.authMethod ?? descriptor.legacyAuthMethod(input.value);
    const method = findAuthMethod(descriptor, authMethod);
    if (!method.writable) {
      throw new Error(
        `provider ${input.providerId} auth method ${authMethod} cannot be stored via Web Console`,
      );
    }
    const file = await this.loadForWrite(this.primary);
    const siblings = file.connections.filter(
      (record) => record.providerId === input.providerId && record.authMethod === authMethod,
    );
    let existing: ProviderConnectionRecord | undefined;
    if (input.connectionId) {
      existing = file.connections.find(
        (record) => record.id === input.connectionId && record.providerId === input.providerId,
      );
      if (!existing) {
        throw new Error(
          `provider ${input.providerId} has no connection ${input.connectionId}`,
        );
      }
      if (existing.authMethod !== authMethod) {
        throw new Error(
          `connection ${existing.id} authenticates with ${existing.authMethod}, not ${authMethod}`,
        );
      }
    } else if (input.authMethod === undefined) {
      // A legacy single-value write replaces the provider's default of the
      // inferred method, as it did when one provider held one secret.
      existing = siblings.find((record) => record.isDefault);
    }
    const now = this.now().toISOString();
    const record: ProviderConnectionRecord = {
      id: existing?.id ?? newId("conn"),
      providerId: input.providerId,
      authMethod,
      ...(input.label ?? existing?.label ? { label: input.label ?? existing?.label } : {}),
      state: "active",
      isDefault: input.makeDefault === true ||
        existing?.isDefault === true ||
        siblings.length === 0,
      ...(input.scopes ? { scopes: input.scopes } : existing?.scopes ? { scopes: existing.scopes } : {}),
      ...(input.account ? { account: input.account } : existing?.account ? { account: existing.account } : {}),
      credentialRef: existing?.credentialRef ?? newId("sec"),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      refreshable: Boolean(input.refreshToken),
      credential: connectionMetadataForWrite(existing?.credential, input, now),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastValidatedAt: now,
    };
    await this.primary.secrets.put(record.credentialRef, {
      accessToken: input.value,
      ...(input.refreshToken ? { refreshToken: input.refreshToken } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    });
    const others = file.connections
      .filter((candidate) => candidate.id !== record.id)
      .map((candidate) =>
        record.isDefault &&
          candidate.providerId === record.providerId &&
          candidate.authMethod === record.authMethod
          ? { ...candidate, isDefault: false }
          : candidate,
      );
    file.connections = normalizeDefaults([...others, record]);
    await writeConnections(this.primary.path, file);
    const written = file.connections.find((candidate) => candidate.id === record.id) ?? record;
    await this.appendAuditEvent({
      version: 1,
      action: "set",
      providerId: input.providerId,
      createdAt: now,
      result: "success",
      connectionId: written.id,
      authMethod: written.authMethod,
      ...safeAuditMetadata(written.credential),
    });
    return written;
  }

  async clearConnection(
    providerId: ProviderId,
    selector?: ProviderConnectionSelector,
  ): Promise<void> {
    const descriptor = findDescriptor(providerId);
    if (!descriptor.writable) {
      throw new Error(`provider ${providerId} cannot be configured via Web Console`);
    }
    const file = await this.loadForWrite(this.primary);
    const removed = file.connections.filter(
      (record) =>
        record.providerId === providerId &&
        (selector?.connectionId === undefined || record.id === selector.connectionId) &&
        (selector?.authMethod === undefined || record.authMethod === selector.authMethod),
    );
    file.connections = normalizeDefaults(
      file.connections.filter((record) => !removed.includes(record)),
    );
    for (const record of removed) {
      await this.primary.secrets.delete(record.credentialRef);
    }
    await writeConnections(this.primary.path, file);
    const createdAt = this.now().toISOString();
    if (removed.length === 0) {
      await this.appendAuditEvent({
        version: 1,
        action: "clear",
        providerId,
        createdAt,
        result: "success",
      });
      return;
    }
    for (const record of removed) {
      await this.appendAuditEvent({
        version: 1,
        action: "clear",
        providerId,
        createdAt,
        result: "success",
        connectionId: record.id,
        authMethod: record.authMethod,
        ...safeAuditMetadata(record.credential),
      });
    }
  }

  /**
   * Keeps the record as evidence that a connection existed, drops its
   * material, and reports it as reconnect-required from then on.
   */
  async revokeConnection(
    providerId: ProviderId,
    selector: ProviderConnectionSelector,
  ): Promise<void> {
    const loaded = await this.loadMerged();
    const chosen = this.select(loaded, providerId, selector);
    if (!chosen) {
      throw new MissingConnectionError(
        providerId,
        `provider ${providerId} has no matching connection to revoke`,
      );
    }
    await chosen.source.secrets.delete(chosen.record.credentialRef);
    await this.updateRecord(chosen.source, chosen.record.id, { state: "revoked" });
    await this.appendAuditEvent({
      version: 1,
      action: "revoke",
      providerId,
      createdAt: this.now().toISOString(),
      result: "success",
      connectionId: chosen.record.id,
      authMethod: chosen.record.authMethod,
      ...safeAuditMetadata(chosen.record.credential),
    });
  }

  async setDefaultConnection(providerId: ProviderId, connectionId: string): Promise<void> {
    const file = await this.loadForWrite(this.primary);
    const target = file.connections.find(
      (record) => record.id === connectionId && record.providerId === providerId,
    );
    if (!target) {
      throw new MissingConnectionError(
        providerId,
        `provider ${providerId} has no connection ${connectionId}`,
      );
    }
    file.connections = normalizeDefaults(
      file.connections.map((record) =>
        record.providerId === providerId && record.authMethod === target.authMethod
          ? { ...record, isDefault: record.id === connectionId }
          : record,
      ),
    );
    await writeConnections(this.primary.path, file);
  }

  describeCredentialSources(): string[] {
    return [this.primary.path, ...this.fallbacks.map((source) => source.path)];
  }

  private async appendAuditEvent(event: ProviderCredentialAuditEvent): Promise<void> {
    await mkdir(dirname(this.auditPath), { recursive: true });
    await appendFile(this.auditPath, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

function safeAuditMetadata(
  metadata: ProviderCredentialMetadata | undefined,
): Omit<
  ProviderCredentialAuditEvent,
  "version" | "action" | "providerId" | "createdAt" | "result" | "connectionId" | "authMethod"
> {
  return {
    ...(metadata?.scope ? { scope: metadata.scope } : {}),
    ...(metadata?.source ? { source: metadata.source } : {}),
    ...(metadata?.ownerId ? { ownerId: metadata.ownerId } : {}),
    ...(metadata?.repositoryId ? { repositoryId: metadata.repositoryId } : {}),
    ...(metadata?.organizationId ? { organizationId: metadata.organizationId } : {}),
    ...(metadata?.rotationHint ? { rotationHint: metadata.rotationHint } : {}),
    ...(metadata?.vaultRef ? { vaultRef: metadata.vaultRef } : {}),
  };
}
