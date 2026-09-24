import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { WebInputError } from "../web/errors.js";
import {
  normalizePreviewViewport,
  previewRouteAllowed,
  resolvePreviewCommand,
  resolvePreviewCwd,
  resolvePreviewTargetUrl,
} from "./config.js";
import {
  createPreviewSessionId,
  getPreviewSessionRecord,
  listPreviewSessionRecords,
  markStalePreviewSessions,
  previewSessionDirectory,
  updatePreviewSessionRecord,
  writePreviewSessionRecord,
} from "./store.js";
import type {
  ActivePreviewSession,
  PreviewDiagnosticEvent,
  PreviewDiagnostics,
  PreviewHierarchyNode,
  PreviewRuntimeProvider,
  PreviewScreenshotArtifact,
  PreviewSessionRecord,
  PreviewStartInput,
} from "./types.js";

const defaultReadinessTimeoutMs = 30_000;
const defaultReadinessIntervalMs = 250;
const maxTailBytes = 24 * 1024;

function sha256Hex(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function key(repoPath: string, sessionId: string): string {
  return `${repoPath}\0${sessionId}`;
}

function redact(value: string, secrets: string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function appendTail(current: string, chunk: Buffer, secrets: string[]): string {
  const next = current + redact(chunk.toString("utf8"), secrets);
  if (Buffer.byteLength(next, "utf8") <= maxTailBytes) return next;
  return next.slice(Math.max(0, next.length - maxTailBytes));
}

function buildProcessEnv(input: {
  commandEnv?: Record<string, string>;
  inheritEnv?: string[];
  sourceEnv: Record<string, string | undefined>;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of input.inheritEnv ?? ["PATH"]) {
    const value = input.sourceEnv[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(input.commandEnv ?? {})) {
    env[name] = value;
  }
  return env;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "manual",
    });
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForReadiness(input: {
  url: string;
  timeoutMs: number;
  intervalMs: number;
  exited: () => boolean;
}): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < input.timeoutMs) {
    if (input.exited()) return false;
    if (await fetchWithTimeout(input.url, Math.min(input.intervalMs, 1_000))) {
      return true;
    }
    await delay(input.intervalMs);
  }
  return false;
}

function terminateProcessTree(processId: number | undefined): void {
  if (processId === undefined) return;
  try {
    globalThis.process.kill(-processId, "SIGTERM");
  } catch {
    try {
      globalThis.process.kill(processId, "SIGTERM");
    } catch {
      return;
    }
  }
  setTimeout(() => {
    try {
      globalThis.process.kill(-processId, "SIGKILL");
    } catch {
      try {
        globalThis.process.kill(processId, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }, 2_000).unref();
}

function validateSessionNavigationUrl(
  record: PreviewSessionRecord,
  value: string,
): string {
  let candidate: URL;
  try {
    candidate = new URL(value, record.targetUrl);
  } catch {
    throw new WebInputError("preview navigation URL is invalid");
  }
  const base = new URL(record.targetUrl);
  if (candidate.origin !== base.origin) {
    throw new WebInputError("preview navigation must stay on the session origin");
  }
  if (!previewRouteAllowed(candidate.pathname, record.allowedRoutes ?? ["/"])) {
    throw new WebInputError("preview route is not allowed by repository config");
  }
  return candidate.toString();
}

function diagnosticShell(record: PreviewSessionRecord): PreviewDiagnostics {
  return {
    sessionId: record.id,
    collectedAt: new Date().toISOString(),
    console: record.diagnostics.console,
    pageErrors: record.diagnostics.pageErrors,
    failedRequests: record.diagnostics.failedRequests,
    server: {
      stdoutTail: record.server.stdoutTail,
      stderrTail: record.server.stderrTail,
      ...(record.server.exitCode !== undefined
        ? { exitCode: record.server.exitCode }
        : {}),
      ...(record.server.signal !== undefined ? { signal: record.server.signal } : {}),
    },
  };
}

export class PreviewSessionManager {
  readonly #provider: PreviewRuntimeProvider;
  readonly #createId: () => string;
  readonly #now: () => Date;
  readonly #env: Record<string, string | undefined>;
  readonly #active = new Map<string, ActivePreviewSession>();

  constructor(input: {
    provider: PreviewRuntimeProvider;
    createId?: () => string;
    now?: () => Date;
    env?: Record<string, string | undefined>;
  }) {
    this.#provider = input.provider;
    this.#createId = input.createId ?? createPreviewSessionId;
    this.#now = input.now ?? (() => new Date());
    this.#env = input.env ?? process.env;
  }

  async markStale(repoPath: string): Promise<PreviewSessionRecord[]> {
    return await markStalePreviewSessions(repoPath, this.#now());
  }

  async list(repoPath: string): Promise<PreviewSessionRecord[]> {
    return await listPreviewSessionRecords(repoPath);
  }

  async get(repoPath: string, sessionId: string): Promise<PreviewSessionRecord> {
    return this.#active.get(key(repoPath, sessionId))?.record ??
      await getPreviewSessionRecord(repoPath, sessionId);
  }

  async start(input: PreviewStartInput): Promise<PreviewSessionRecord> {
    const command = await resolvePreviewCommand(input.repoPath, input.commandId);
    const cwd = await resolvePreviewCwd(input.repoPath, command.cwd);
    const viewport = normalizePreviewViewport(input.viewport);
    const target = resolvePreviewTargetUrl({
      command,
      ...(input.targetUrl ? { targetUrl: input.targetUrl } : {}),
      ...(input.route ? { route: input.route } : {}),
    });
    const env = buildProcessEnv({
      commandEnv: command.env,
      inheritEnv: command.inheritEnv,
      sourceEnv: this.#env,
    });
    const secrets = [
      ...Object.values(command.env ?? {}),
      ...(command.inheritEnv ?? [])
        .map((name) => this.#env[name])
        .filter((value): value is string => value !== undefined),
    ].filter(Boolean);
    const now = this.#now().toISOString();
    const sessionId = this.#createId();
    const args = command.args ?? [];
    let record: PreviewSessionRecord = {
      schemaVersion: "nitely.preview-session.v1",
      id: sessionId,
      repoId: input.repoId,
      repoPath: input.repoPath,
      commandId: command.id,
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      status: "starting",
      actor: input.actor,
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      provider: this.#provider.provider,
      capabilities: this.#provider.capabilities,
      viewport,
      targetUrl: target.targetUrl,
      allowedRoutes: command.allowedRoutes ?? ["/"],
      ...(target.route ? { route: target.route } : {}),
      createdAt: now,
      updatedAt: now,
      server: {
        command: command.command,
        args,
        cwd,
        readinessUrl: target.readinessUrl,
        stdoutTail: "",
        stderrTail: "",
      },
      diagnostics: {
        sessionId,
        collectedAt: now,
        console: [],
        pageErrors: [],
        failedRequests: [],
        server: { stdoutTail: "", stderrTail: "" },
      },
      screenshots: [],
    };
    await writePreviewSessionRecord(input.repoPath, record);

    const child = spawn(command.command, args, {
      cwd,
      env,
      detached: true,
      stdio: "pipe",
    });
    let exited = false;
    let spawnError: Error | undefined;
    const active: ActivePreviewSession = {
      record: {
        ...record,
        server: { ...record.server, pid: child.pid },
      },
      process: child,
      redactionSecrets: secrets,
    };
    record = active.record;
    this.#active.set(key(input.repoPath, sessionId), active);

    const persistActive = async () => {
      active.record.diagnostics = diagnosticShell(active.record);
      await writePreviewSessionRecord(input.repoPath, active.record);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      active.record.server.stdoutTail = appendTail(
        active.record.server.stdoutTail,
        chunk,
        secrets,
      );
      void persistActive().catch(() => {});
    });
    child.stderr.on("data", (chunk: Buffer) => {
      active.record.server.stderrTail = appendTail(
        active.record.server.stderrTail,
        chunk,
        secrets,
      );
      void persistActive().catch(() => {});
    });
    child.once("error", (error) => {
      spawnError = error;
      exited = true;
      active.record.server.stderrTail = appendTail(
        active.record.server.stderrTail,
        Buffer.from(error.message),
        secrets,
      );
      void persistActive().catch(() => {});
    });
    child.once("exit", (exitCode, signal) => {
      exited = true;
      active.record.server.exitCode = exitCode;
      active.record.server.signal = signal;
      if (active.record.status === "starting" || active.record.status === "ready") {
        const failedAt = this.#now().toISOString();
        active.record = {
          ...active.record,
          status: "failed",
          updatedAt: failedAt,
          failedAt,
          failure: `preview server exited unexpectedly${exitCode !== null ? ` with code ${exitCode}` : ""}${signal ? ` from ${signal}` : ""}`,
          diagnostics: diagnosticShell(active.record),
        };
        void writePreviewSessionRecord(input.repoPath, active.record).catch(() => {});
        void active.runtime?.close().catch(() => {});
        this.#active.delete(key(input.repoPath, sessionId));
      }
    });
    await writePreviewSessionRecord(input.repoPath, record);

    const ready = await waitForReadiness({
      url: target.readinessUrl,
      timeoutMs: command.readiness?.timeoutMs ?? defaultReadinessTimeoutMs,
      intervalMs: command.readiness?.intervalMs ?? defaultReadinessIntervalMs,
      exited: () => exited,
    });
    if (!ready) {
      terminateProcessTree(child.pid);
      const failedAt = this.#now().toISOString();
      const status = spawnError || exited ? "failed" : "timed_out";
      active.record = {
        ...active.record,
        status,
        updatedAt: failedAt,
        ...(status === "timed_out" ? { timedOutAt: failedAt } : { failedAt }),
        failure: spawnError
          ? spawnError.message
          : exited
            ? "preview server exited before readiness"
            : `preview readiness timed out: ${target.readinessUrl}`,
        diagnostics: diagnosticShell(active.record),
      };
      await writePreviewSessionRecord(input.repoPath, active.record);
      this.#active.delete(key(input.repoPath, sessionId));
      return active.record;
    }

    try {
      active.runtime = await this.#provider.start({
        sessionId,
        targetUrl: target.targetUrl,
        viewport,
      });
      const currentUrl = await active.runtime.currentUrl();
      const readyAt = this.#now().toISOString();
      active.record = {
        ...active.record,
        status: "ready",
        updatedAt: readyAt,
        readyAt,
        ...(currentUrl ? { currentUrl } : {}),
        diagnostics: {
          ...diagnosticShell(active.record),
          ...(await active.runtime.diagnostics()),
        },
      };
      await writePreviewSessionRecord(input.repoPath, active.record);
      return active.record;
    } catch (error) {
      terminateProcessTree(child.pid);
      const failedAt = this.#now().toISOString();
      active.record = {
        ...active.record,
        status: "failed",
        updatedAt: failedAt,
        failedAt,
        failure: error instanceof Error ? error.message : String(error),
        diagnostics: diagnosticShell(active.record),
      };
      await writePreviewSessionRecord(input.repoPath, active.record);
      this.#active.delete(key(input.repoPath, sessionId));
      return active.record;
    }
  }

  async stop(repoPath: string, sessionId: string): Promise<PreviewSessionRecord> {
    const active = this.#active.get(key(repoPath, sessionId));
    if (!active) {
      const existing = await getPreviewSessionRecord(repoPath, sessionId);
      if (
        existing.status === "stopped" ||
        existing.status === "failed" ||
        existing.status === "timed_out" ||
        existing.status === "stale"
      ) {
        return existing;
      }
      const stoppedAt = this.#now().toISOString();
      return await updatePreviewSessionRecord(repoPath, sessionId, (record) => ({
        ...record,
        status: "stale",
        updatedAt: stoppedAt,
        staleAt: stoppedAt,
        failure: "preview session process is no longer attached",
      }));
    }
    const stoppingAt = this.#now().toISOString();
    active.record = {
      ...active.record,
      status: "stopping",
      updatedAt: stoppingAt,
      diagnostics: diagnosticShell(active.record),
    };
    await writePreviewSessionRecord(repoPath, active.record);
    await active.runtime?.close().catch(() => {});
    terminateProcessTree(active.process.pid);
    const stoppedAt = this.#now().toISOString();
    active.record = {
      ...active.record,
      status: "stopped",
      updatedAt: stoppedAt,
      stoppedAt,
      diagnostics: diagnosticShell(active.record),
    };
    await writePreviewSessionRecord(repoPath, active.record);
    this.#active.delete(key(repoPath, sessionId));
    return active.record;
  }

  async restart(
    repoPath: string,
    sessionId: string,
  ): Promise<PreviewSessionRecord> {
    const existing = await this.get(repoPath, sessionId);
    await this.stop(repoPath, sessionId);
    return await this.start({
      repoId: existing.repoId,
      repoPath,
      commandId: existing.commandId,
      actor: existing.actor,
      ...(existing.ownerId ? { ownerId: existing.ownerId } : {}),
      ...(existing.organizationId ? { organizationId: existing.organizationId } : {}),
      ...(existing.workItemId ? { workItemId: existing.workItemId } : {}),
      ...(existing.runId ? { runId: existing.runId } : {}),
      ...(existing.route ? { route: existing.route } : {}),
      targetUrl: existing.targetUrl,
      viewport: existing.viewport,
    });
  }

  async navigate(
    repoPath: string,
    sessionId: string,
    url: string,
  ): Promise<PreviewSessionRecord> {
    const active = this.#requireActive(repoPath, sessionId);
    const currentUrl = await active.runtime!.navigate(
      validateSessionNavigationUrl(active.record, url),
    );
    return await this.#updateReady(active, repoPath, {
      ...(currentUrl ? { currentUrl } : {}),
    });
  }

  async reload(repoPath: string, sessionId: string): Promise<PreviewSessionRecord> {
    const active = this.#requireActive(repoPath, sessionId);
    const currentUrl = await active.runtime!.reload();
    return await this.#updateReady(active, repoPath, {
      ...(currentUrl ? { currentUrl } : {}),
    });
  }

  async click(repoPath: string, sessionId: string, selector: string): Promise<void> {
    if (!selector.trim()) throw new WebInputError("selector is required");
    const active = this.#requireActive(repoPath, sessionId);
    await active.runtime!.click(selector);
    await this.#updateReady(active, repoPath);
  }

  async type(
    repoPath: string,
    sessionId: string,
    selector: string,
    text: string,
  ): Promise<void> {
    if (!selector.trim()) throw new WebInputError("selector is required");
    const active = this.#requireActive(repoPath, sessionId);
    await active.runtime!.type(selector, text);
    await this.#updateReady(active, repoPath);
  }

  async scroll(
    repoPath: string,
    sessionId: string,
    deltaX: number | undefined,
    deltaY: number | undefined,
  ): Promise<void> {
    const active = this.#requireActive(repoPath, sessionId);
    await active.runtime!.scroll({ deltaX, deltaY });
    await this.#updateReady(active, repoPath);
  }

  async diagnostics(
    repoPath: string,
    sessionId: string,
  ): Promise<PreviewDiagnostics> {
    const active = this.#active.get(key(repoPath, sessionId));
    if (!active?.runtime) {
      const record = await getPreviewSessionRecord(repoPath, sessionId);
      return diagnosticShell(record);
    }
    const runtimeDiagnostics = await active.runtime.diagnostics();
    const diagnostics: PreviewDiagnostics = {
      ...diagnosticShell(active.record),
      ...runtimeDiagnostics,
      collectedAt: this.#now().toISOString(),
    };
    active.record = {
      ...active.record,
      diagnostics,
      updatedAt: diagnostics.collectedAt,
    };
    await writePreviewSessionRecord(repoPath, active.record);
    return diagnostics;
  }

  async hierarchy(
    repoPath: string,
    sessionId: string,
  ): Promise<PreviewHierarchyNode> {
    const active = this.#requireActive(repoPath, sessionId);
    return await active.runtime!.hierarchy();
  }

  async screenshot(input: {
    repoPath: string;
    sessionId: string;
    fullPage?: boolean;
  }): Promise<PreviewScreenshotArtifact> {
    const active = this.#requireActive(input.repoPath, input.sessionId);
    const buffer = await active.runtime!.screenshot({
      fullPage: input.fullPage === true,
    });
    const capturedAt = this.#now().toISOString();
    const artifactId = `preview-screenshot-${randomUUID().slice(0, 8)}`;
    const relativePath = join(active.record.id, "artifacts", `${artifactId}.png`);
    const directory = join(previewSessionDirectory(input.repoPath, active.record.id), "artifacts");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${artifactId}.png`), buffer, {
      mode: 0o600,
    });
    const artifact: PreviewScreenshotArtifact = {
      id: artifactId,
      path: `.nitely/preview-sessions/${relativePath}`,
      mediaType: "image/png",
      sha256: sha256Hex(buffer),
      size: buffer.byteLength,
      fullPage: input.fullPage === true,
      viewport: active.record.viewport,
      ...(active.record.currentUrl ? { url: active.record.currentUrl } : {}),
      capturedAt,
    };
    active.record = {
      ...active.record,
      screenshots: [...active.record.screenshots, artifact],
      updatedAt: capturedAt,
      diagnostics: await this.diagnostics(input.repoPath, input.sessionId),
    };
    await writePreviewSessionRecord(input.repoPath, active.record);
    return artifact;
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.#active.values()].map((active) =>
        this.stop(active.record.repoPath, active.record.id).catch(() => {}),
      ),
    );
  }

  #requireActive(repoPath: string, sessionId: string): ActivePreviewSession {
    const active = this.#active.get(key(repoPath, sessionId));
    if (!active || !active.runtime || active.record.status !== "ready") {
      throw new WebInputError("preview session is not ready");
    }
    return active;
  }

  async #updateReady(
    active: ActivePreviewSession,
    repoPath: string,
    patch: Partial<PreviewSessionRecord> = {},
  ): Promise<PreviewSessionRecord> {
    const updatedAt = this.#now().toISOString();
    const runtimeDiagnostics = active.runtime
      ? await active.runtime.diagnostics()
      : { console: [], pageErrors: [], failedRequests: [] };
    active.record = {
      ...active.record,
      ...patch,
      updatedAt,
      diagnostics: {
        ...diagnosticShell(active.record),
        ...runtimeDiagnostics,
        collectedAt: updatedAt,
      },
    };
    await writePreviewSessionRecord(repoPath, active.record);
    return active.record;
  }
}
