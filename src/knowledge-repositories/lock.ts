import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";

interface LeaseOwner {
  version: 1;
  token: string;
  pid: number;
  acquiredAt: string;
}

export interface KnowledgeLease {
  path: string;
  token: string;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

export class KnowledgeLeaseLostError extends Error {
  constructor(path: string) {
    super(`knowledge operation lost its lease: ${path}`);
    this.name = "KnowledgeLeaseLostError";
  }
}

export class KnowledgeLeaseBusyError extends Error {
  constructor(path: string) {
    super(`knowledge operation is already in progress: ${path}`);
    this.name = "KnowledgeLeaseBusyError";
  }
}

async function readOwner(path: string): Promise<LeaseOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as Partial<LeaseOwner>;
    if (
      value.version === 1 &&
      typeof value.token === "string" &&
      typeof value.pid === "number" &&
      typeof value.acquiredAt === "string"
    ) {
      return value as LeaseOwner;
    }
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

async function staleLease(path: string, staleMs: number): Promise<boolean> {
  try {
    const owner = await readOwner(path);
    if (owner) {
      try {
        process.kill(owner.pid, 0);
        // A paused or temporarily starved owner must never be reclaimed: it
        // could resume after a successor commits and overwrite newer state.
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
        return false;
      }
    }
    const ownerPath = join(path, "owner.json");
    let stats;
    try {
      stats = await stat(ownerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      stats = await stat(path);
    }
    return Date.now() - stats.mtimeMs > staleMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function reclaimStaleLease(path: string, staleMs: number): Promise<boolean> {
  if (!(await staleLease(path, staleMs))) return false;
  const stalePath = `${path}.stale-${randomUUID()}`;
  try {
    await rename(path, stalePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
  await rm(stalePath, { recursive: true, force: true });
  return true;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

export async function acquireKnowledgeLease(input: {
  path: string;
  staleMs?: number;
  waitMs?: number;
  retryMs?: number;
  heartbeatMs?: number;
  now?: () => Date;
}): Promise<KnowledgeLease> {
  const staleMs = input.staleMs ?? 120_000;
  const waitMs = input.waitMs ?? 0;
  const retryMs = Math.max(5, input.retryMs ?? 25);
  const deadline = Date.now() + waitMs;
  await mkdir(dirname(input.path), { recursive: true, mode: 0o700 });

  for (;;) {
    try {
      await mkdir(input.path, { mode: 0o700 });
      await chmod(input.path, 0o700);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await reclaimStaleLease(input.path, staleMs)) continue;
      if (Date.now() >= deadline) throw new KnowledgeLeaseBusyError(input.path);
      await wait(Math.min(retryMs, Math.max(1, deadline - Date.now())));
    }
  }

  const token = randomUUID();
  const owner: LeaseOwner = {
    version: 1,
    token,
    pid: process.pid,
    acquiredAt: (input.now?.() ?? new Date()).toISOString(),
  };
  const ownerPath = join(input.path, "owner.json");
  let ownerHandle;
  try {
    ownerHandle = await open(ownerPath, "wx", 0o600);
    await ownerHandle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await ownerHandle.sync();
    const installed = await readOwner(input.path);
    if (installed?.token !== token) {
      throw new KnowledgeLeaseLostError(input.path);
    }
  } catch (error) {
    await ownerHandle?.close().catch(() => {});
    // The directory created above may have been reclaimed and replaced while
    // this process was paused before owner.json was installed. Never remove a
    // replacement lease: cleanup is allowed only after our token is visible.
    const current = await readOwner(input.path);
    if (current?.token === token) {
      await rm(input.path, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }

  const heartbeatMs = input.heartbeatMs ?? Math.max(1_000, Math.floor(staleMs / 4));
  const heartbeat = setInterval(() => {
    const timestamp = new Date();
    void ownerHandle?.utimes(timestamp, timestamp).catch(() => {});
  }, heartbeatMs);
  heartbeat.unref();

  let released = false;
  return {
    path: input.path,
    token,
    async assertOwned(): Promise<void> {
      const current = await readOwner(input.path);
      if (current?.token !== token) {
        throw new KnowledgeLeaseLostError(input.path);
      }
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      await ownerHandle?.close().catch(() => {});
      const current = await readOwner(input.path);
      if (current?.token === token) {
        await rm(input.path, { recursive: true, force: true });
      }
    },
  };
}

export async function withKnowledgeLease<T>(
  input: Parameters<typeof acquireKnowledgeLease>[0],
  operation: (lease: KnowledgeLease) => Promise<T>,
): Promise<T> {
  const lease = await acquireKnowledgeLease(input);
  try {
    return await operation(lease);
  } finally {
    await lease.release();
  }
}
