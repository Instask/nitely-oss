import { createSign } from "node:crypto";

import type {
  GitHubWebhookStatusPublication,
  GitHubWebhookStatusPublisher,
  GitHubWebhookStatusUpdate,
} from "./intake.js";

const defaultGitHubApiBaseUrl = "https://api.github.com";
const githubApiVersion = "2022-11-28";
const tokenRefreshSkewMs = 5 * 60_000;
const defaultCheckName = "Nitely";
const maximumCommentBodyLength = 2_000;

type FetchLike = typeof fetch;

interface InstallationTokenCacheEntry {
  token: string;
  expiresAtMs: number;
}

export interface GitHubAppInstallationTokenProviderOptions {
  appId: string;
  privateKey: string;
  apiBaseUrl?: string;
  now?: () => Date;
  fetch?: FetchLike;
}

export interface GitHubAppStatusPublisherOptions
  extends GitHubAppInstallationTokenProviderOptions {
  detailsUrlBase?: string;
  checkName?: string;
}

interface GitHubRequestOptions {
  method: string;
  path: string;
  token: string;
  body?: unknown;
}

export class GitHubAppStatusPublisherError extends Error {
  readonly code = "github_status_publish_failed";
  readonly status?: number;
  readonly publication?: GitHubWebhookStatusPublication;

  constructor(input: {
    message?: string;
    status?: number;
    publication?: GitHubWebhookStatusPublication;
  } = {}) {
    super(input.message ?? "GitHub status publication failed");
    this.name = "GitHubAppStatusPublisherError";
    this.status = input.status;
    this.publication = input.publication;
  }
}

export class GitHubAppInstallationTokenProvider {
  readonly #appId: string;
  readonly #privateKey: string;
  readonly #apiBaseUrl: string;
  readonly #now: () => Date;
  readonly #fetch: FetchLike;
  readonly #cache = new Map<string, InstallationTokenCacheEntry>();

  constructor(input: GitHubAppInstallationTokenProviderOptions) {
    this.#appId = normalizeAppId(input.appId);
    this.#privateKey = normalizePrivateKey(input.privateKey);
    this.#apiBaseUrl = normalizeApiBaseUrl(
      input.apiBaseUrl ?? defaultGitHubApiBaseUrl,
    );
    this.#now = input.now ?? (() => new Date());
    this.#fetch = input.fetch ?? fetch;
  }

  async token(input: {
    installationId: number;
    repositoryId: number;
  }): Promise<string> {
    const key = `${input.installationId}:${input.repositoryId}`;
    const nowMs = this.#now().getTime();
    const cached = this.#cache.get(key);
    if (cached && cached.expiresAtMs - tokenRefreshSkewMs > nowMs) {
      return cached.token;
    }
    const jwt = githubAppJwt({
      appId: this.#appId,
      privateKey: this.#privateKey,
      now: this.#now(),
    });
    const response = await this.#requestInstallationToken({
      jwt,
      installationId: input.installationId,
      repositoryId: input.repositoryId,
    });
    const expiresAtMs = Date.parse(response.expires_at);
    if (!Number.isFinite(expiresAtMs)) {
      throw new GitHubAppStatusPublisherError();
    }
    this.#cache.set(key, {
      token: response.token,
      expiresAtMs,
    });
    return response.token;
  }

  clear(input: { installationId: number; repositoryId: number }): void {
    this.#cache.delete(`${input.installationId}:${input.repositoryId}`);
  }

  async #requestInstallationToken(input: {
    jwt: string;
    installationId: number;
    repositoryId: number;
  }): Promise<{ token: string; expires_at: string }> {
    const response = await this.#fetch(
      endpoint(
        this.#apiBaseUrl,
        `/app/installations/${encodeURIComponent(String(input.installationId))}/access_tokens`,
      ),
      {
        method: "POST",
        headers: githubHeaders(input.jwt),
        body: JSON.stringify({
          repository_ids: [input.repositoryId],
          permissions: {
            checks: "write",
            issues: "write",
            pull_requests: "write",
          },
        }),
      },
    );
    const data = await parseGitHubJson(response);
    if (!response.ok) {
      throw new GitHubAppStatusPublisherError({ status: response.status });
    }
    if (!isRecord(data) || typeof data.token !== "string" ||
      typeof data.expires_at !== "string") {
      throw new GitHubAppStatusPublisherError();
    }
    return { token: data.token, expires_at: data.expires_at };
  }
}

export function createGitHubAppStatusPublisher(
  input: GitHubAppStatusPublisherOptions,
): GitHubWebhookStatusPublisher {
  const tokenProvider = new GitHubAppInstallationTokenProvider(input);
  const apiBaseUrl = normalizeApiBaseUrl(
    input.apiBaseUrl ?? defaultGitHubApiBaseUrl,
  );
  const now = input.now ?? (() => new Date());
  const fetchImplementation = input.fetch ?? fetch;
  const checkName = normalizeCheckName(input.checkName ?? defaultCheckName);
  const detailsUrlBase = input.detailsUrlBase?.trim();

  return async (update, previous) => {
    let publication: GitHubWebhookStatusPublication = {
      provider: "github",
      ...(previous?.checkRunId ? { checkRunId: previous.checkRunId } : {}),
      ...(previous?.commentId ? { commentId: previous.commentId } : {}),
    };
    try {
      const commentId = await withInstallationToken(
        tokenProvider,
        update,
        async (token) =>
          await publishIssueComment({
            apiBaseUrl,
            fetch: fetchImplementation,
            token,
            update,
            previousCommentId: publication.commentId,
            detailsUrlBase,
          }),
      );
      publication = { ...publication, commentId };
      if (hasHeadSha(update)) {
        const checkRunId = await withInstallationToken(
          tokenProvider,
          update,
          async (token) =>
            await publishCheckRun({
              apiBaseUrl,
              fetch: fetchImplementation,
              token,
              update,
              previousCheckRunId: publication.checkRunId,
              checkName,
              detailsUrlBase,
              now: now(),
            }),
        );
        publication = { ...publication, checkRunId };
      }
      return publication;
    } catch (error) {
      throw new GitHubAppStatusPublisherError({
        status: error instanceof GitHubAppStatusPublisherError
          ? error.status
          : undefined,
        publication:
          publication.checkRunId || publication.commentId
            ? publication
            : undefined,
      });
    }
  };
}

export function githubAppStatusPublisherFromEnv(
  env: Record<string, string | undefined>,
): GitHubWebhookStatusPublisher | undefined {
  const appId = env.NITELY_GITHUB_APP_ID?.trim();
  const privateKey = env.NITELY_GITHUB_APP_PRIVATE_KEY?.trim();
  const privateKeyBase64 = env.NITELY_GITHUB_APP_PRIVATE_KEY_BASE64?.trim();
  const apiBaseUrl = env.NITELY_GITHUB_API_BASE_URL?.trim();
  const detailsUrlBase = env.NITELY_GITHUB_WEBHOOK_STATUS_BASE_URL?.trim();
  const checkName = env.NITELY_GITHUB_WEBHOOK_CHECK_NAME?.trim();
  const configured = [
    appId,
    privateKey,
    privateKeyBase64,
    apiBaseUrl,
    detailsUrlBase,
    checkName,
  ].some((value) => value && value.length > 0);
  if (!configured) return undefined;
  if (!appId || (!privateKey && !privateKeyBase64)) {
    throw new Error("GitHub App status publisher configuration is incomplete");
  }
  if (privateKey && privateKeyBase64) {
    throw new Error(
      "GitHub App status publisher private key is ambiguous; set only one private key environment variable",
    );
  }
  return createGitHubAppStatusPublisher({
    appId,
    privateKey: privateKeyBase64
      ? Buffer.from(privateKeyBase64, "base64").toString("utf8")
      : privateKey!,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(detailsUrlBase ? { detailsUrlBase } : {}),
    ...(checkName ? { checkName } : {}),
  });
}

function hasHeadSha(
  update: GitHubWebhookStatusUpdate,
): update is Extract<
  GitHubWebhookStatusUpdate,
  { state: "rework-request-created" | "failed" }
> & { headSha: string } {
  return "headSha" in update && typeof update.headSha === "string" &&
    update.headSha.length > 0;
}

async function withInstallationToken<T>(
  tokenProvider: GitHubAppInstallationTokenProvider,
  update: GitHubWebhookStatusUpdate,
  action: (token: string) => Promise<T>,
): Promise<T> {
  const tokenInput = {
    installationId: update.installationId,
    repositoryId: update.repositoryId,
  };
  const token = await tokenProvider.token(tokenInput);
  try {
    return await action(token);
  } catch (error) {
    if (
      error instanceof GitHubAppStatusPublisherError &&
      error.status === 401
    ) {
      tokenProvider.clear(tokenInput);
      return await action(await tokenProvider.token(tokenInput));
    }
    throw error;
  }
}

async function publishIssueComment(input: {
  apiBaseUrl: string;
  fetch: FetchLike;
  token: string;
  update: GitHubWebhookStatusUpdate;
  previousCommentId?: number;
  detailsUrlBase?: string;
}): Promise<number> {
  const { owner, repo } = splitRepositoryFullName(input.update.repositoryFullName);
  const body = boundedCommentBody(input.update, input.detailsUrlBase);
  const request = input.previousCommentId
    ? {
        method: "PATCH",
        path:
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
          `/issues/comments/${encodeURIComponent(String(input.previousCommentId))}`,
        body: { body },
      }
    : {
        method: "POST",
        path:
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
          `/issues/${encodeURIComponent(String(issueOrPullRequestNumber(input.update)))}/comments`,
        body: { body },
      };
  const data = await githubJson<Record<string, unknown>>({
    apiBaseUrl: input.apiBaseUrl,
    fetch: input.fetch,
    token: input.token,
    ...request,
  });
  const commentId = numberField(data, "id");
  if (!commentId) throw new GitHubAppStatusPublisherError();
  return commentId;
}

async function publishCheckRun(input: {
  apiBaseUrl: string;
  fetch: FetchLike;
  token: string;
  update: Extract<
    GitHubWebhookStatusUpdate,
    { state: "rework-request-created" | "failed" }
  > & { headSha: string };
  previousCheckRunId?: number;
  checkName: string;
  detailsUrlBase?: string;
  now: Date;
}): Promise<number> {
  const { owner, repo } = splitRepositoryFullName(input.update.repositoryFullName);
  const output = checkOutput(input.update);
  const detailsUrl = detailsUrlFor(input.update, input.detailsUrlBase);
  const completedAt = input.now.toISOString();
  const requestBody = {
    name: input.checkName,
    external_id: `github-webhook:${input.update.deliveryId}`,
    ...(detailsUrl ? { details_url: detailsUrl } : {}),
    status: "completed",
    conclusion: input.update.state === "failed" ? "failure" : "success",
    completed_at: completedAt,
    output,
  };
  const data = await githubJson<Record<string, unknown>>({
    apiBaseUrl: input.apiBaseUrl,
    fetch: input.fetch,
    token: input.token,
    method: input.previousCheckRunId ? "PATCH" : "POST",
    path: input.previousCheckRunId
      ? `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
        `/check-runs/${encodeURIComponent(String(input.previousCheckRunId))}`
      : `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs`,
    body: input.previousCheckRunId
      ? requestBody
      : { ...requestBody, head_sha: input.update.headSha },
  });
  const checkRunId = numberField(data, "id");
  if (!checkRunId) throw new GitHubAppStatusPublisherError();
  return checkRunId;
}

async function githubJson<T>(input: {
  apiBaseUrl: string;
  fetch: FetchLike;
  token: string;
} & GitHubRequestOptions): Promise<T> {
  const response = await input.fetch(endpoint(input.apiBaseUrl, input.path), {
    method: input.method,
    headers: githubHeaders(input.token),
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  const data = await parseGitHubJson(response);
  if (!response.ok) {
    throw new GitHubAppStatusPublisherError({ status: response.status });
  }
  return data as T;
}

async function parseGitHubJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new GitHubAppStatusPublisherError({ status: response.status });
  }
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "nitely",
    "x-github-api-version": githubApiVersion,
  };
}

function githubAppJwt(input: {
  appId: string;
  privateKey: string;
  now: Date;
}): string {
  const issuedAt = Math.floor(input.now.getTime() / 1000) - 60;
  const expiresAt = issuedAt + 9 * 60;
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iat: issuedAt,
    exp: expiresAt,
    iss: input.appId,
  });
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(input.privateKey)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function splitRepositoryFullName(fullName: string): {
  owner: string;
  repo: string;
} {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo || fullName.split("/").length !== 2) {
    throw new GitHubAppStatusPublisherError();
  }
  return { owner, repo };
}

function issueOrPullRequestNumber(update: GitHubWebhookStatusUpdate): number {
  if ("issueNumber" in update && update.issueNumber) return update.issueNumber;
  if ("pullRequestNumber" in update && update.pullRequestNumber) {
    return update.pullRequestNumber;
  }
  throw new GitHubAppStatusPublisherError();
}

function boundedCommentBody(
  update: GitHubWebhookStatusUpdate,
  detailsUrlBase?: string,
): string {
  const marker = `<!-- nitely:github-webhook:${update.deliveryId} -->`;
  const details = detailsUrlFor(update, detailsUrlBase);
  const lines = [
    marker,
    "",
    `Nitely webhook status: ${humanStatus(update)}.`,
    "",
    `- Delivery: \`${update.deliveryId}\``,
    `- Source: ${update.sourceUrl}`,
    ...(details ? [`- Nitely: ${details}`] : []),
  ];
  return lines.join("\n").slice(0, maximumCommentBodyLength);
}

function detailsUrlFor(
  update: GitHubWebhookStatusUpdate,
  detailsUrlBase?: string,
): string | undefined {
  const path = "taskPath" in update
    ? update.taskPath
    : "reworkRequestPath" in update
      ? update.reworkRequestPath
      : undefined;
  if (!path || !detailsUrlBase) return undefined;
  return new URL(path, ensureTrailingSlash(detailsUrlBase)).toString();
}

function humanStatus(update: GitHubWebhookStatusUpdate): string {
  switch (update.state) {
    case "task-created":
      return `created draft task ${update.taskId}`;
    case "rework-request-created":
      return `created pending rework request ${update.reworkRequestId}`;
    case "failed":
      return "processing failed";
  }
}

function checkOutput(
  update: Extract<
    GitHubWebhookStatusUpdate,
    { state: "rework-request-created" | "failed" }
  >,
): { title: string; summary: string } {
  if (update.state === "failed") {
    return {
      title: "Nitely webhook processing failed",
      summary:
        `Delivery \`${update.deliveryId}\` failed with code ` +
        `\`${update.failureCode}\`. Inspect Nitely webhook delivery state.`,
    };
  }
  return {
    title: "Nitely webhook accepted",
    summary:
      `Delivery \`${update.deliveryId}\` created pending rework request ` +
      `\`${update.reworkRequestId}\`. Operator confirmation is still required.`,
  };
}

function normalizeAppId(value: string): string {
  if (!/^\d+$/.test(value.trim())) {
    throw new Error("GitHub App id must be a positive integer");
  }
  return value.trim();
}

function normalizePrivateKey(value: string): string {
  const normalized = value.replace(/\\n/g, "\n").trim();
  if (!normalized.includes("BEGIN") || !normalized.includes("PRIVATE KEY")) {
    throw new Error("GitHub App private key must be a PEM private key");
  }
  return normalized;
}

function normalizeApiBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" &&
    parsed.hostname !== "localhost") {
    throw new Error("GitHub API base URL must use HTTPS");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeCheckName(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 100) {
    throw new Error("GitHub webhook check name is invalid");
  }
  return normalized;
}

function endpoint(apiBaseUrl: string, path: string): string {
  return `${apiBaseUrl}${path}`;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isSafeInteger(field) && field > 0
    ? field
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
