import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** The credential material behind one connection. */
export interface ProviderSecretMaterial {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
}

/**
 * Where credential bytes live. Connection metadata refers to an entry by
 * `credentialRef` and never carries the bytes itself, so a hosted deployment
 * can back this with a vault without changing the connection model.
 */
export interface ProviderSecretStore {
  get(ref: string): Promise<ProviderSecretMaterial | undefined>;
  put(ref: string, material: ProviderSecretMaterial): Promise<void>;
  delete(ref: string): Promise<void>;
}

interface SecretsFile {
  version: 1;
  secrets: Record<string, ProviderSecretMaterial>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSecretsFile(value: unknown, path: string): SecretsFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.secrets)) {
    throw new Error(`invalid ${path}: expected version 1 secrets file`);
  }
  const secrets: SecretsFile["secrets"] = {};
  for (const [ref, material] of Object.entries(value.secrets)) {
    if (!isRecord(material) || typeof material.accessToken !== "string") {
      throw new Error(`invalid ${path}: secrets.${ref}.accessToken must be a string`);
    }
    secrets[ref] = {
      accessToken: material.accessToken,
      ...(typeof material.refreshToken === "string"
        ? { refreshToken: material.refreshToken }
        : {}),
      ...(typeof material.expiresAt === "string"
        ? { expiresAt: material.expiresAt }
        : {}),
    };
  }
  return { version: 1, secrets };
}

/**
 * Local-first secret storage: a `0600` JSON file beside the connection
 * metadata. Not the long-term team backend; the interface above is.
 */
export class FileProviderSecretStore implements ProviderSecretStore {
  constructor(private readonly path: string) {}

  static pathFor(connectionsPath: string): string {
    return connectionsPath.replace(/\.json$/, "") + ".secrets.json";
  }

  private async read(): Promise<SecretsFile> {
    try {
      return parseSecretsFile(JSON.parse(await readFile(this.path, "utf8")), this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, secrets: {} };
      }
      throw err;
    }
  }

  private async write(file: SecretsFile): Promise<void> {
    const tmp = `${this.path}.tmp.${Math.random().toString(36).slice(2, 8)}`;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(tmp, JSON.stringify(file, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, this.path);
  }

  async get(ref: string): Promise<ProviderSecretMaterial | undefined> {
    return (await this.read()).secrets[ref];
  }

  async put(ref: string, material: ProviderSecretMaterial): Promise<void> {
    const file = await this.read();
    file.secrets[ref] = material;
    await this.write(file);
  }

  async delete(ref: string): Promise<void> {
    const file = await this.read();
    if (!(ref in file.secrets)) return;
    delete file.secrets[ref];
    await this.write(file);
  }
}
