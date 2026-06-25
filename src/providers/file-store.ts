import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { findDescriptor } from "./descriptors.js";
import { EnvProviderConnectionStore } from "./env-store.js";
import type {
  ProviderConnection,
  ProviderConnectionStatus,
  ProviderConnectionStore,
  ProviderId,
  SetConnectionInput,
} from "./types.js";

interface ConnectionsFile {
  version: 1;
  connections: Record<string, { value: string }>;
}

export interface FileProviderConnectionStoreOptions {
  path: string;
  env: Record<string, string | undefined>;
  commandStatus?: (command: string, args: string[]) => Promise<boolean>;
}

async function readConnections(path: string): Promise<ConnectionsFile> {
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
      return { version: 1, connections: {} };
    }
    throw err;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConnectionsFile(value: unknown): ConnectionsFile {
  if (!isRecord(value)) {
    throw new Error("invalid connections.json: root must be an object");
  }
  if (value.version !== 1) {
    throw new Error("invalid connections.json: version must be 1");
  }
  if (!isRecord(value.connections)) {
    throw new Error("invalid connections.json: connections must be an object");
  }
  const connections: ConnectionsFile["connections"] = {};
  for (const [providerId, connection] of Object.entries(value.connections)) {
    findDescriptor(providerId as ProviderId);
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
    connections[providerId] = { value: connection.value };
  }
  return { version: 1, connections };
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

export class FileProviderConnectionStore implements ProviderConnectionStore {
  private readonly path: string;
  private readonly env: Record<string, string | undefined>;
  private readonly inner: EnvProviderConnectionStore;

  constructor(options: FileProviderConnectionStoreOptions) {
    this.path = options.path;
    this.env = options.env;
    this.inner = new EnvProviderConnectionStore({
      env: options.env,
      commandStatus: options.commandStatus,
    });
  }

  async getConnection(providerId: ProviderId): Promise<ProviderConnection> {
    const stored = await this.readStoredValue(providerId);
    if (stored !== undefined) {
      return {
        providerId,
        getAccessToken: async () => stored,
      };
    }
    return this.inner.getConnection(providerId);
  }

  async resolveEnv(): Promise<Record<string, string | undefined>> {
    const base = { ...this.env };
    const file = await readConnections(this.path);
    for (const [id, conn] of Object.entries(file.connections)) {
      const desc = findDescriptor(id as ProviderId);
      if (desc.canonicalEnv) {
        base[desc.canonicalEnv] = conn.value;
      }
    }
    return base;
  }

  async listStatuses(): Promise<ProviderConnectionStatus[]> {
    const inner = await this.inner.listStatuses();
    const file = await readConnections(this.path);
    return inner.map((s) => {
      if (s.id === "codex") return s;
      const stored = file.connections[s.id];
      if (stored) {
        return {
          ...s,
          configured: true,
          message: "Configured in Web Console.",
        };
      }
      return s;
    });
  }

  async setConnection(input: SetConnectionInput): Promise<void> {
    const desc = findDescriptor(input.providerId);
    if (!desc.writable) {
      throw new Error(`provider ${input.providerId} cannot be configured via Web Console`);
    }
    const file = await readConnections(this.path);
    file.connections[input.providerId] = { value: input.value };
    await writeConnections(this.path, file);
  }

  async clearConnection(providerId: ProviderId): Promise<void> {
    const desc = findDescriptor(providerId);
    if (!desc.writable) {
      throw new Error(`provider ${providerId} cannot be configured via Web Console`);
    }
    const file = await readConnections(this.path);
    delete file.connections[providerId];
    await writeConnections(this.path, file);
  }

  private async readStoredValue(
    providerId: ProviderId,
  ): Promise<string | undefined> {
    const file = await readConnections(this.path);
    return file.connections[providerId]?.value;
  }
}
