import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { EnvProviderConnectionStore } from "../providers/env-store.js";
import { MissingConnectionError } from "../providers/types.js";
import type {
  ProviderConnection,
  ProviderConnectionStore,
} from "../providers/types.js";
import type {
  ChangeRequest,
  ChangeRequestTarget,
  CheckoutChangeRequestRequest,
  CheckoutChangeRequestResult,
  CreatePullRequestCommentRequest,
  GetChangeRequestStatusRequest,
  ListPullRequestDiscussionRequest,
  PublishChangeRequest,
  PullRequestDiscussionItem,
  ResolveChangeRequestTargetRequest,
  ScmProvider,
  UpdateChangeRequestRequest,
  UpdateChangeRequestMetadataRequest,
  UpdateChangeRequestMetadataResult,
  UpdateChangeRequestResult,
  ChangeRequestMetadataUpdate,
  ChangeRequestStatus,
  CreateRepositoryIssueCommentRequest,
  CreateRepositoryIssueRequest,
  ListRepositoryIssueCommentsRequest,
  ListRepositoryIssuesRequest,
  RepositoryIssue,
  RepositoryIssueComment,
  ResolveRepositoryRequest,
  ScmRepository,
  UpdateRepositoryIssueCommentRequest,
} from "./types.js";

const execFileAsync = promisify(execFile);

export const MISSING_GITHUB_TOKEN_MESSAGE =
  "Missing GitHub token. Set NITELY_GITHUB_TOKEN or configure a GitHub provider connection.";

export class MissingGitHubTokenError extends Error {
  constructor() {
    super(MISSING_GITHUB_TOKEN_MESSAGE);
    this.name = "MissingGitHubTokenError";
  }
}

export type GitHubApiErrorKind =
  | "auth"
  | "permission"
  | "rate-limit"
  | "not-found"
  | "conflict"
  | "validation"
  | "network"
  | "unknown";

export class GitHubApiError extends Error {
  readonly kind: GitHubApiErrorKind;
  readonly status: number;
  readonly operation: string;
  readonly details: string;

  constructor(input: {
    kind: GitHubApiErrorKind;
    status: number;
    operation: string;
    details: string;
  }) {
    super(
      `GitHub ${input.operation} failed with ${input.status} (${input.kind}): ${input.details}`,
    );
    this.name = "GitHubApiError";
    this.kind = input.kind;
    this.status = input.status;
    this.operation = input.operation;
    this.details = input.details;
  }
}

export interface GitHubRepository {
  owner: string;
  repository: string;
}

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GitHubScmProviderOptions {
  env?: Record<string, string | undefined>;
  connection?: ProviderConnection;
  store?: ProviderConnectionStore;
  git?: GitRunner;
  fetch?: FetchLike;
}

async function defaultGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function trimGitSuffix(value: string): string {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

export function parseGitHubRemoteUrl(remoteUrl: string): GitHubRepository {
  const value = remoteUrl.trim();
  const sshMatch = /^git@github\.com:([^/]+)\/(.+)$/.exec(value);
  if (sshMatch) {
    return {
      owner: sshMatch[1] ?? "",
      repository: trimGitSuffix(sshMatch[2] ?? ""),
    };
  }

  const sshUrlMatch = /^ssh:\/\/git@github\.com\/([^/]+)\/(.+)$/.exec(value);
  if (sshUrlMatch) {
    return {
      owner: sshUrlMatch[1] ?? "",
      repository: trimGitSuffix(sshUrlMatch[2] ?? ""),
    };
  }

  const httpsMatch = /^https:\/\/github\.com\/([^/]+)\/(.+)$/.exec(value);
  if (httpsMatch) {
    return {
      owner: httpsMatch[1] ?? "",
      repository: trimGitSuffix(httpsMatch[2] ?? ""),
    };
  }

  throw new Error(`unsupported GitHub remote URL: ${remoteUrl}`);
}

export interface GitHubPullRequestTargetInput {
  owner?: string;
  repository?: string;
  number: number;
}

export function parseGitHubPullRequestTarget(
  target: string,
): GitHubPullRequestTargetInput {
  const value = target.trim();
  if (/^\d+$/.test(value)) {
    return { number: Number.parseInt(value, 10) };
  }

  const match =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:$|[/?#])/.exec(
      value,
    );
  if (!match) {
    throw new Error(`unsupported GitHub pull request target: ${target}`);
  }
  return {
    owner: match[1] ?? "",
    repository: trimGitSuffix(match[2] ?? ""),
    number: Number.parseInt(match[3] ?? "", 10),
  };
}

function normalizeDraft(value: unknown): boolean {
  return typeof value === "boolean" ? value : true;
}

function encodeQueryValue(value: string): string {
  return encodeURIComponent(value);
}

async function configuredRepository(input: {
  git: GitRunner;
  repoPath: string;
  remoteName: string;
}): Promise<GitHubRepository> {
  const remoteUrl = await input.git(input.repoPath, [
    "remote",
    "get-url",
    input.remoteName,
  ]);
  return parseGitHubRemoteUrl(remoteUrl);
}

function assertSameRepository(input: {
  configured: GitHubRepository;
  target: GitHubRepository;
}): void {
  const configured = `${input.configured.owner}/${input.configured.repository}`;
  const target = `${input.target.owner}/${input.target.repository}`;
  if (configured.toLowerCase() !== target.toLowerCase()) {
    throw new Error(
      `repository target ${target} does not match configured repository ${configured}`,
    );
  }
}

function assertSameHeadRepository(input: {
  configured: GitHubRepository;
  target: ChangeRequestTarget;
}): void {
  const configured = `${input.configured.owner}/${input.configured.repository}`;
  const head = `${input.target.headRepository.owner}/${input.target.headRepository.repository}`;
  if (configured.toLowerCase() !== head.toLowerCase()) {
    throw new Error(
      `cross-repository pull requests are not supported: ${head} differs from ${configured}`,
    );
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`GitHub pull request response did not include ${label}`);
  }
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number") {
    throw new Error(`GitHub pull request response did not include ${label}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function githubJsonHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function githubJsonWriteHeaders(token: string): Record<string, string> {
  return {
    ...githubJsonHeaders(token),
    "Content-Type": "application/json",
  };
}

function classifyGitHubApiError(input: {
  status: number;
  details: string;
  headers: Headers;
}): GitHubApiErrorKind {
  const details = input.details.toLowerCase();
  if (
    input.status === 429 ||
    (input.status === 403 &&
      (input.headers.get("x-ratelimit-remaining") === "0" ||
        details.includes("rate limit")))
  ) {
    return "rate-limit";
  }
  if (input.status === 401) return "auth";
  if (input.status === 403) return "permission";
  if (input.status === 404) return "not-found";
  if (input.status === 409) return "conflict";
  if (input.status === 422) return "validation";
  return "unknown";
}

async function githubApiError(
  response: Response,
  operation: string,
): Promise<GitHubApiError> {
  const details = await response.text();
  return new GitHubApiError({
    kind: classifyGitHubApiError({
      status: response.status,
      details,
      headers: response.headers,
    }),
    status: response.status,
    operation,
    details,
  });
}

function changeRequestFromGitHubPullPayload(input: {
  repository: GitHubRepository;
  baseBranch: string;
  headBranch: string;
  payload: unknown;
  outcome: NonNullable<ChangeRequest["outcome"]>;
}): ChangeRequest {
  const payload = asObject(input.payload);
  return {
    provider: "github",
    url: requireString(payload.html_url, "html_url"),
    number: requireNumber(payload.number, "number"),
    owner: input.repository.owner,
    repository: input.repository.repository,
    baseBranch: input.baseBranch,
    headBranch: input.headBranch,
    draft: normalizeDraft(payload.draft),
    outcome: input.outcome,
  };
}

function isAlreadyExistsPullRequestError(error: unknown): boolean {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message);
    if (error instanceof GitHubApiError) {
      parts.push(error.details);
    }
  } else {
    parts.push(String(error));
  }
  if (error && typeof error === "object" && "stderr" in error) {
    parts.push(String((error as { stderr: unknown }).stderr));
  }
  if (error && typeof error === "object" && "stdout" in error) {
    parts.push(String((error as { stdout: unknown }).stdout));
  }
  const text = parts.join("\n");
  return (
    /already exists/i.test(text) ||
    /pull request already exists/i.test(text) ||
    (/Validation Failed/i.test(text) && /pull request/i.test(text))
  );
}

async function findExistingPullRequest(input: {
  fetch: FetchLike;
  token: string;
  repository: GitHubRepository;
  baseBranch: string;
  headBranch: string;
}): Promise<ChangeRequest | undefined> {
  const head = `${input.repository.owner}:${input.headBranch}`;
  const listUrls = [
    `https://api.github.com/repos/${input.repository.owner}/${input.repository.repository}/pulls?state=open&head=${encodeQueryValue(head)}&base=${encodeQueryValue(input.baseBranch)}&per_page=1`,
    `https://api.github.com/repos/${input.repository.owner}/${input.repository.repository}/pulls?state=open&head=${encodeQueryValue(head)}&per_page=1`,
  ];
  for (const url of listUrls) {
    const response = await input.fetch(url, {
      method: "GET",
      headers: githubJsonHeaders(input.token),
    });
    if (!response.ok) {
      throw await githubApiError(response, "pull request lookup");
    }
    const payload = await response.json();
    if (!Array.isArray(payload) || payload.length === 0) {
      continue;
    }
    return changeRequestFromGitHubPullPayload({
      repository: input.repository,
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      payload: payload[0],
      outcome: "reused",
    });
  }
  return undefined;
}

function remoteHeadSha(input: {
  output: string;
  branch: string;
  label: "base" | "head";
  remoteName: string;
}): string {
  const expectedRef = `refs/heads/${input.branch}`;
  for (const line of input.output.trim().split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref === expectedRef) {
      return sha;
    }
  }
  throw new Error(
    `Cannot publish change request: ${input.label} branch '${input.branch}' does not exist on remote '${input.remoteName}'. Check the configured base/head branch and retry.`,
  );
}

async function assertPublishablePullRequestDiff(input: {
  git: GitRunner;
  worktreePath: string;
  remoteName: string;
  baseBranch: string;
  headBranch: string;
}): Promise<void> {
  const baseSha = remoteHeadSha({
    output: await input.git(input.worktreePath, [
      "ls-remote",
      "--heads",
      input.remoteName,
      `refs/heads/${input.baseBranch}`,
    ]),
    branch: input.baseBranch,
    label: "base",
    remoteName: input.remoteName,
  });
  const headSha = remoteHeadSha({
    output: await input.git(input.worktreePath, [
      "ls-remote",
      "--heads",
      input.remoteName,
      `refs/heads/${input.headBranch}`,
    ]),
    branch: input.headBranch,
    label: "head",
    remoteName: input.remoteName,
  });
  await input.git(input.worktreePath, [
    "fetch",
    "--no-tags",
    input.remoteName,
    `refs/heads/${input.baseBranch}`,
    `refs/heads/${input.headBranch}`,
  ]);
  const count = Number.parseInt(
    (
      await input.git(input.worktreePath, [
        "rev-list",
        "--count",
        `${baseSha}..${headSha}`,
      ])
    ).trim(),
    10,
  );
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error(
      `Cannot publish change request: no commits between base branch '${input.baseBranch}' and head branch '${input.headBranch}'. Commit changes, choose the correct base branch, or reuse an existing pull request.`,
    );
  }
}

async function patchPullRequestMetadata(input: {
  fetch: FetchLike;
  token: string;
  target: Pick<ChangeRequestTarget, "owner" | "repository" | "number">;
  title?: string;
  body?: string;
}): Promise<ChangeRequestMetadataUpdate> {
  const body: Record<string, string> = {};
  if (input.title !== undefined) {
    body.title = input.title;
  }
  if (input.body !== undefined) {
    body.body = input.body;
  }
  const fields = Object.keys(body);
  const response = await input.fetch(
    `https://api.github.com/repos/${input.target.owner}/${input.target.repository}/pulls/${input.target.number}`,
    {
      method: "PATCH",
      headers: githubJsonWriteHeaders(input.token),
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw await githubApiError(response, "pull request metadata update");
  }
  return {
    transport: "github-rest-api",
    outcome: "updated",
    fields,
  };
}

function normalizeDiscussionPayload(
  value: unknown,
  kind: "issue-comment" | "review-comment",
): PullRequestDiscussionItem {
  const payload = asObject(value);
  const user = asObject(payload.user);
  const item: PullRequestDiscussionItem = {
    provider: "github",
    kind,
    id: String(requireNumber(payload.id, "id")),
    url: requireString(payload.html_url, "html_url"),
    body: typeof payload.body === "string" ? payload.body : "",
    authorLogin: requireString(user.login, "user.login"),
    createdAt: requireString(payload.created_at, "created_at"),
  };
  const authorAssociation = optionalString(payload.author_association);
  if (authorAssociation) item.authorAssociation = authorAssociation;
  const updatedAt = optionalString(payload.updated_at);
  if (updatedAt) item.updatedAt = updatedAt;
  if (kind === "review-comment") {
    const path = optionalString(payload.path);
    if (path) item.path = path;
    const line = optionalNumber(payload.line);
    if (line !== undefined) item.line = line;
    const inReplyToId = optionalNumber(payload.in_reply_to_id);
    if (inReplyToId !== undefined) item.inReplyToId = String(inReplyToId);
  }
  return item;
}

function normalizeRepositoryIssuePayload(input: {
  repository: GitHubRepository;
  value: unknown;
}): RepositoryIssue {
  const payload = asObject(input.value);
  const state = requireString(payload.state, "state");
  if (state !== "open" && state !== "closed") {
    throw new Error(`GitHub issue response included unsupported state: ${state}`);
  }
  return {
    provider: "github",
    owner: input.repository.owner,
    repository: input.repository.repository,
    number: requireNumber(payload.number, "number"),
    url: requireString(payload.html_url, "html_url"),
    title: requireString(payload.title, "title"),
    body: typeof payload.body === "string" ? payload.body : "",
    state,
  };
}

function normalizeRepositoryIssueCommentPayload(
  value: unknown,
): RepositoryIssueComment {
  const payload = asObject(value);
  const user = asObject(payload.user);
  const comment: RepositoryIssueComment = {
    provider: "github",
    id: String(requireNumber(payload.id, "id")),
    url: requireString(payload.html_url, "html_url"),
    body: typeof payload.body === "string" ? payload.body : "",
    authorLogin: requireString(user.login, "user.login"),
    createdAt: requireString(payload.created_at, "created_at"),
  };
  const updatedAt = optionalString(payload.updated_at);
  if (updatedAt) comment.updatedAt = updatedAt;
  return comment;
}

function scmRepository(repository: GitHubRepository): ScmRepository {
  return {
    provider: "github",
    owner: repository.owner,
    repository: repository.repository,
    url: `https://github.com/${repository.owner}/${repository.repository}`,
  };
}

function metadataUpdateResult(input: {
  changeRequest: ChangeRequest;
  metadataUpdate: ChangeRequestMetadataUpdate;
}): UpdateChangeRequestMetadataResult {
  return {
    url: input.changeRequest.url,
    number: input.changeRequest.number,
    changeRequest: {
      ...input.changeRequest,
      outcome: "updated",
    },
    metadataUpdate: input.metadataUpdate,
  };
}

async function requireGithubArrayResponse(
  response: Response,
  label: string,
): Promise<unknown[]> {
  if (!response.ok) {
    throw await githubApiError(response, label);
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error(`GitHub ${label} response was not an array`);
  }
  return payload;
}

function nextGithubPageUrl(linkHeader: string | null): string | undefined {
  if (!linkHeader) {
    return undefined;
  }
  for (const part of linkHeader.split(",")) {
    const [rawUrl, ...parameters] = part.trim().split(";").map((value) => value.trim());
    if (!parameters.some((parameter) => parameter === 'rel="next"')) {
      continue;
    }
    const match = /^<(.+)>$/.exec(rawUrl ?? "");
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

async function fetchPaginatedGithubArray(input: {
  fetch: FetchLike;
  initialUrl: string;
  headers: Record<string, string>;
  label: string;
}): Promise<unknown[]> {
  const items: unknown[] = [];
  let nextUrl: string | undefined = input.initialUrl;
  while (nextUrl) {
    const response = await input.fetch(nextUrl, {
      method: "GET",
      headers: input.headers,
    });
    items.push(...(await requireGithubArrayResponse(response, input.label)));
    nextUrl = nextGithubPageUrl(response.headers.get("link"));
  }
  return items;
}

function targetFromGitHubPullPayload(input: {
  configured: GitHubRepository;
  payload: unknown;
}): ChangeRequestTarget {
  const payload = asObject(input.payload);
  const base = asObject(payload.base);
  const head = asObject(payload.head);
  const headRepo = asObject(head.repo);
  const headOwner = asObject(headRepo.owner);
  const owner = input.configured.owner;
  const repository = input.configured.repository;
  const target: ChangeRequestTarget = {
    provider: "github",
    owner,
    repository,
    number: requireNumber(payload.number, "number"),
    url: requireString(payload.html_url, "html_url"),
    baseBranch: requireString(base.ref, "base.ref"),
    headBranch: requireString(head.ref, "head.ref"),
    headSha: requireString(head.sha, "head.sha"),
    headRepository: {
      owner: requireString(headOwner.login, "head.repo.owner.login"),
      repository: requireString(headRepo.name, "head.repo.name"),
    },
    isCrossRepository: false,
  };
  target.isCrossRepository =
    `${target.headRepository.owner}/${target.headRepository.repository}`.toLowerCase() !==
    `${owner}/${repository}`.toLowerCase();
  assertSameHeadRepository({ configured: input.configured, target });
  return target;
}

function assertResolvedTargetIsSameRepository(target: ChangeRequestTarget): void {
  const configured = `${target.owner}/${target.repository}`;
  const head = `${target.headRepository.owner}/${target.headRepository.repository}`;
  if (target.isCrossRepository || configured.toLowerCase() !== head.toLowerCase()) {
    throw new Error(
      `cross-repository pull requests are not supported: ${head} differs from ${configured}`,
    );
  }
}

function isPathInside(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

function parseWorktreeList(
  output: string,
): Array<{ path: string; branch?: string; prunable: boolean; locked: boolean }> {
  return output
    .trim()
    .split(/\n\n+/)
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const result: {
        path: string;
        branch?: string;
        prunable: boolean;
        locked: boolean;
      } = { path: "", prunable: false, locked: false };
      for (const line of entry.split("\n")) {
        if (line.startsWith("worktree ")) {
          result.path = line.slice("worktree ".length);
        }
        if (line.startsWith("branch ")) {
          result.branch = line.slice("branch ".length);
        }
        if (line === "prunable" || line.startsWith("prunable ")) {
          result.prunable = true;
        }
        if (line === "locked" || line.startsWith("locked ")) {
          result.locked = true;
        }
      }
      return result;
    })
    .filter((entry) => entry.path.length > 0);
}

function checkoutBranchNameForCollision(input: {
  headBranch: string;
  worktreePath: string;
}): string {
  const runDirectory = resolve(input.worktreePath, "..");
  const runId = runDirectory.split(/[/\\]/).pop() ?? "run";
  const suffix = runId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${input.headBranch}-checkout-${suffix || "run"}`;
}

async function prepareLocalCheckoutBranch(input: {
  git: GitRunner;
  repoPath: string;
  worktreePath: string;
  headBranch: string;
}): Promise<string> {
  const worktrees = parseWorktreeList(
    await input.git(input.repoPath, ["worktree", "list", "--porcelain"]),
  );
  const nitelyRunsDirectory = resolve(input.repoPath, ".nitely", "runs");
  const targetRef = `refs/heads/${input.headBranch}`;
  let useCollisionBranch = false;
  for (const worktree of worktrees) {
    const worktreePath = resolve(worktree.path);
    if (worktree.branch !== targetRef || worktreePath === resolve(input.worktreePath)) {
      continue;
    }
    if (!isPathInside(nitelyRunsDirectory, worktreePath)) {
      throw new Error(
        `pull request branch ${input.headBranch} is already checked out at ${worktree.path}. Remove or detach that worktree, then retry the Nitely checkout.`,
      );
    }
    if (worktree.prunable && !worktree.locked) {
      await input.git(input.repoPath, ["worktree", "prune"]);
      continue;
    }
    useCollisionBranch = true;
  }
  return useCollisionBranch
    ? checkoutBranchNameForCollision({
        headBranch: input.headBranch,
        worktreePath: input.worktreePath,
      })
    : input.headBranch;
}

async function checkoutResolvedChangeRequest(input: {
  git: GitRunner;
  request: CheckoutChangeRequestRequest;
}): Promise<CheckoutChangeRequestResult> {
  assertResolvedTargetIsSameRepository(input.request.target);
  await input.git(input.request.repoPath, [
    "fetch",
    input.request.remoteName,
    input.request.target.headBranch,
  ]);
  const localBranchName = await prepareLocalCheckoutBranch({
    git: input.git,
    repoPath: input.request.repoPath,
    worktreePath: input.request.worktreePath,
    headBranch: input.request.target.headBranch,
  });
  await input.git(input.request.repoPath, [
    "worktree",
    "add",
    "--force",
    "-B",
    localBranchName,
    input.request.worktreePath,
    "FETCH_HEAD",
  ]);
  return { previousHeadSha: input.request.target.headSha };
}

async function updateResolvedChangeRequest(input: {
  git: GitRunner;
  request: UpdateChangeRequestRequest;
}): Promise<UpdateChangeRequestResult> {
  assertResolvedTargetIsSameRepository(input.request.target);
  await input.git(input.request.worktreePath, ["add", "."]);
  const status = await input.git(input.request.worktreePath, [
    "status",
    "--short",
  ]);
  if (status.trim().length > 0) {
    await input.git(input.request.worktreePath, [
      "commit",
      "-m",
      input.request.title,
    ]);
  }
  await input.git(input.request.worktreePath, [
    "push",
    input.request.remoteName,
    `HEAD:${input.request.target.headBranch}`,
  ]);
  const updatedHeadSha = (
    await input.git(input.request.worktreePath, ["rev-parse", "HEAD"])
  ).trim();
  return {
    url: input.request.target.url,
    number: input.request.target.number,
    previousHeadSha: input.request.target.headSha,
    updatedHeadSha,
    changeRequest: {
      provider: "github",
      url: input.request.target.url,
      number: input.request.target.number,
      owner: input.request.target.owner,
      repository: input.request.target.repository,
      baseBranch: input.request.target.baseBranch,
      headBranch: input.request.target.headBranch,
      draft: true,
      outcome: "updated",
    },
  };
}

export class GitHubScmProvider implements ScmProvider {
  readonly type = "github";
  readonly #connection: ProviderConnection | undefined;
  readonly #store: ProviderConnectionStore;
  readonly #git: GitRunner;
  readonly #fetch: FetchLike;

  constructor(options: GitHubScmProviderOptions = {}) {
    this.#connection = options.connection;
    this.#store =
      options.store ??
      new EnvProviderConnectionStore({ env: options.env ?? process.env });
    this.#git = options.git ?? defaultGit;
    this.#fetch = options.fetch ?? fetch;
  }

  async #getAccessToken(): Promise<string> {
    try {
      return await (
        this.#connection ?? (await this.#store.getConnection("github"))
      ).getAccessToken();
    } catch (error) {
      if (
        error instanceof MissingConnectionError &&
        error.providerId === "github" &&
        error.message === MISSING_GITHUB_TOKEN_MESSAGE
      ) {
        throw new MissingGitHubTokenError();
      }
      throw error;
    }
  }

  async resolveRepository(
    input: ResolveRepositoryRequest,
  ): Promise<ScmRepository> {
    return scmRepository(
      await configuredRepository({
        git: this.#git,
        repoPath: input.repoPath,
        remoteName: input.remoteName,
      }),
    );
  }

  async listRepositoryIssues(
    input: ListRepositoryIssuesRequest,
  ): Promise<RepositoryIssue[]> {
    const configured = await configuredRepository({
      git: this.#git,
      repoPath: input.repoPath,
      remoteName: input.remoteName,
    });
    assertSameRepository({ configured, target: input.repository });
    const token = await this.#getAccessToken();
    const payloads = await fetchPaginatedGithubArray({
      fetch: this.#fetch,
      initialUrl: `https://api.github.com/repos/${configured.owner}/${configured.repository}/issues?state=all&per_page=100`,
      headers: githubJsonHeaders(token),
      label: "repository issues listing",
    });
    return payloads
      .filter((payload) => !("pull_request" in asObject(payload)))
      .map((value) => normalizeRepositoryIssuePayload({ repository: configured, value }));
  }

  async createRepositoryIssue(
    input: CreateRepositoryIssueRequest,
  ): Promise<RepositoryIssue> {
    const configured = await configuredRepository({
      git: this.#git,
      repoPath: input.repoPath,
      remoteName: input.remoteName,
    });
    assertSameRepository({ configured, target: input.repository });
    const token = await this.#getAccessToken();
    const response = await this.#fetch(
      `https://api.github.com/repos/${configured.owner}/${configured.repository}/issues`,
      {
        method: "POST",
        headers: githubJsonWriteHeaders(token),
        body: JSON.stringify({ title: input.title, body: input.body }),
      },
    );
    if (!response.ok) {
      throw await githubApiError(response, "repository issue creation");
    }
    return normalizeRepositoryIssuePayload({
      repository: configured,
      value: await response.json(),
    });
  }

  async listRepositoryIssueComments(
    input: ListRepositoryIssueCommentsRequest,
  ): Promise<RepositoryIssueComment[]> {
    const configured = await configuredRepository({
      git: this.#git,
      repoPath: input.repoPath,
      remoteName: input.remoteName,
    });
    assertSameRepository({ configured, target: input.repository });
    const token = await this.#getAccessToken();
    const payloads = await fetchPaginatedGithubArray({
      fetch: this.#fetch,
      initialUrl: `https://api.github.com/repos/${configured.owner}/${configured.repository}/issues/${input.issueNumber}/comments?per_page=100`,
      headers: githubJsonHeaders(token),
      label: "repository issue comments listing",
    });
    return payloads.map(normalizeRepositoryIssueCommentPayload);
  }

  async createRepositoryIssueComment(
    input: CreateRepositoryIssueCommentRequest,
  ): Promise<RepositoryIssueComment> {
    const configured = await configuredRepository({
      git: this.#git,
      repoPath: input.repoPath,
      remoteName: input.remoteName,
    });
    assertSameRepository({ configured, target: input.repository });
    const token = await this.#getAccessToken();
    const response = await this.#fetch(
      `https://api.github.com/repos/${configured.owner}/${configured.repository}/issues/${input.issueNumber}/comments`,
      {
        method: "POST",
        headers: githubJsonWriteHeaders(token),
        body: JSON.stringify({ body: input.body }),
      },
    );
    if (!response.ok) {
      throw await githubApiError(response, "repository issue comment creation");
    }
    return normalizeRepositoryIssueCommentPayload(await response.json());
  }

  async updateRepositoryIssueComment(
    input: UpdateRepositoryIssueCommentRequest,
  ): Promise<RepositoryIssueComment> {
    const configured = await configuredRepository({
      git: this.#git,
      repoPath: input.repoPath,
      remoteName: input.remoteName,
    });
    assertSameRepository({ configured, target: input.repository });
    if (!/^\d+$/.test(input.commentId)) {
      throw new Error("GitHub issue comment ID must be numeric");
    }
    const token = await this.#getAccessToken();
    const response = await this.#fetch(
      `https://api.github.com/repos/${configured.owner}/${configured.repository}/issues/comments/${input.commentId}`,
      {
        method: "PATCH",
        headers: githubJsonWriteHeaders(token),
        body: JSON.stringify({ body: input.body }),
      },
    );
    if (!response.ok) {
      throw await githubApiError(response, "repository issue comment update");
    }
    return normalizeRepositoryIssueCommentPayload(await response.json());
  }

  async publishChange(input: PublishChangeRequest): Promise<ChangeRequest> {
    const token = await this.#getAccessToken();
    const remoteUrl = await this.#git(input.worktreePath, [
      "remote",
      "get-url",
      input.remoteName,
    ]);
    const repository = parseGitHubRemoteUrl(remoteUrl);

    await this.#git(input.worktreePath, [
      "push",
      "-u",
      input.remoteName,
      input.headBranch,
    ]);

    const existing = await findExistingPullRequest({
      fetch: this.#fetch,
      token,
      repository,
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
    });
    if (existing) {
      const metadataUpdate = await patchPullRequestMetadata({
        fetch: this.#fetch,
        token,
        target: existing,
        title: input.title,
        body: input.body,
      });
      return { ...existing, metadataUpdate };
    }

    await assertPublishablePullRequestDiff({
      git: this.#git,
      worktreePath: input.worktreePath,
      remoteName: input.remoteName,
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
    });

    const response = await this.#fetch(
      `https://api.github.com/repos/${repository.owner}/${repository.repository}/pulls`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          title: input.title,
          head: input.headBranch,
          base: input.baseBranch,
          body: input.body,
          draft: true,
        }),
      },
    );

    if (!response.ok) {
      const createError = await githubApiError(response, "pull request creation");
      if (isAlreadyExistsPullRequestError(createError)) {
        const raced = await findExistingPullRequest({
          fetch: this.#fetch,
          token,
          repository,
          baseBranch: input.baseBranch,
          headBranch: input.headBranch,
        });
        if (raced) {
          const metadataUpdate = await patchPullRequestMetadata({
            fetch: this.#fetch,
            token,
            target: raced,
            title: input.title,
            body: input.body,
          });
          return { ...raced, metadataUpdate, outcome: "updated" };
        }
      }
      throw createError;
    }

    return changeRequestFromGitHubPullPayload({
      repository,
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      payload: await response.json(),
      outcome: "created",
    });
  }

  async getChangeRequestStatus(
    input: GetChangeRequestStatusRequest,
  ): Promise<ChangeRequestStatus> {
    const parsed = parseGitHubPullRequestTarget(input.target);
    if (!parsed.owner || !parsed.repository) {
      throw new Error("GitHub pull request URL is required for status lookup");
    }
    const token = await this.#getAccessToken();
    const response = await this.#fetch(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repository}/pulls/${parsed.number}`,
      {
        method: "GET",
        headers: githubJsonHeaders(token),
      },
    );
    if (!response.ok) {
      throw await githubApiError(response, "pull request status lookup");
    }
    const payload = asObject(await response.json());
    return {
      provider: "github",
      url: typeof payload.html_url === "string" ? payload.html_url : input.target,
      state: requireString(payload.state, "state"),
      merged: payload.merged === true,
    };
  }

  async resolveChangeRequestTarget(
    input: ResolveChangeRequestTargetRequest,
  ): Promise<ChangeRequestTarget> {
    const token = await this.#getAccessToken();
    const configured = await configuredRepository({
      git: this.#git,
      repoPath: input.repoPath,
      remoteName: input.remoteName,
    });
    const parsed = parseGitHubPullRequestTarget(input.target);
    const targetRepository = {
      owner: parsed.owner ?? configured.owner,
      repository: parsed.repository ?? configured.repository,
    };
    assertSameRepository({ configured, target: targetRepository });

    const response = await this.#fetch(
      `https://api.github.com/repos/${configured.owner}/${configured.repository}/pulls/${parsed.number}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      throw await githubApiError(response, "pull request lookup");
    }
    return targetFromGitHubPullPayload({
      configured,
      payload: await response.json(),
    });
  }

  async checkoutChangeRequest(
    input: CheckoutChangeRequestRequest,
  ): Promise<CheckoutChangeRequestResult> {
    return await checkoutResolvedChangeRequest({ git: this.#git, request: input });
  }

  async updateChangeRequest(
    input: UpdateChangeRequestRequest,
  ): Promise<UpdateChangeRequestResult> {
    const updated = await updateResolvedChangeRequest({
      git: this.#git,
      request: input,
    });
    const token = await this.#getAccessToken();
    const metadataUpdate = await patchPullRequestMetadata({
      fetch: this.#fetch,
      token,
      target: input.target,
      title: input.title,
      body: input.body,
    });
    return { ...updated, metadataUpdate };
  }

  async updateChangeRequestMetadata(
    input: UpdateChangeRequestMetadataRequest,
  ): Promise<UpdateChangeRequestMetadataResult> {
    const token = await this.#getAccessToken();
    const metadataUpdate = await patchPullRequestMetadata({
      fetch: this.#fetch,
      token,
      target: input.changeRequest,
      title: input.title,
      body: input.body,
    });
    return metadataUpdateResult({
      changeRequest: input.changeRequest,
      metadataUpdate,
    });
  }

  async listPullRequestDiscussion(
    input: ListPullRequestDiscussionRequest,
  ): Promise<PullRequestDiscussionItem[]> {
    const configured = await configuredRepository({
      git: this.#git,
      repoPath: input.repoPath,
      remoteName: input.remoteName,
    });
    assertSameRepository({ configured, target: input.target });
    const token = await this.#getAccessToken();
    const headers = githubJsonHeaders(token);
    const [issueComments, reviewComments] = await Promise.all([
      fetchPaginatedGithubArray({
        fetch: this.#fetch,
        initialUrl: `https://api.github.com/repos/${input.target.owner}/${input.target.repository}/issues/${input.target.number}/comments?per_page=100`,
        headers,
        label: "pull request issue comments listing",
      }),
      fetchPaginatedGithubArray({
        fetch: this.#fetch,
        initialUrl: `https://api.github.com/repos/${input.target.owner}/${input.target.repository}/pulls/${input.target.number}/comments?per_page=100`,
        headers,
        label: "pull request review comments listing",
      }),
    ]);
    return [
      ...issueComments.map((payload) =>
        normalizeDiscussionPayload(payload, "issue-comment"),
      ),
      ...reviewComments.map((payload) =>
        normalizeDiscussionPayload(payload, "review-comment"),
      ),
    ];
  }

  async createPullRequestComment(
    input: CreatePullRequestCommentRequest,
  ): Promise<PullRequestDiscussionItem> {
    const configured = await configuredRepository({
      git: this.#git,
      repoPath: input.repoPath,
      remoteName: input.remoteName,
    });
    assertSameRepository({ configured, target: input.target });
    const token = await this.#getAccessToken();
    const response = await this.#fetch(
      `https://api.github.com/repos/${input.target.owner}/${input.target.repository}/issues/${input.target.number}/comments`,
      {
        method: "POST",
        headers: githubJsonWriteHeaders(token),
        body: JSON.stringify({ body: input.body }),
      },
    );
    if (!response.ok) {
      throw await githubApiError(response, "pull request comment creation");
    }
    return normalizeDiscussionPayload(await response.json(), "issue-comment");
  }
}

export interface GitHubCliScmProviderOptions {
  env?: Record<string, string | undefined>;
  connection?: ProviderConnection;
  store?: ProviderConnectionStore;
  fetch?: FetchLike;
  git?: GitRunner;
  execFile?: (
    file: string,
    args: string[],
    options: { cwd: string; maxBuffer: number },
  ) => Promise<{ stdout: string }>;
}

function parsePullRequestNumber(url: string): number {
  const match = /\/pull\/(\d+)(?:$|[?#])/.exec(url);
  if (!match) {
    throw new Error(`unable to parse pull request number from URL: ${url}`);
  }
  return Number.parseInt(match[1] ?? "", 10);
}

export class GitHubCliScmProvider implements ScmProvider {
  readonly type = "github-cli";
  readonly #connection: ProviderConnection | undefined;
  readonly #store: ProviderConnectionStore;
  readonly #fetch: FetchLike;
  readonly #git: GitRunner;
  readonly #execFile: NonNullable<GitHubCliScmProviderOptions["execFile"]>;

  constructor(options: GitHubCliScmProviderOptions = {}) {
    this.#connection = options.connection;
    this.#store =
      options.store ??
      new EnvProviderConnectionStore({ env: options.env ?? process.env });
    this.#fetch = options.fetch ?? fetch;
    this.#git = options.git ?? defaultGit;
    this.#execFile =
      options.execFile ??
      (async (file, args, execOptions) => {
        const { stdout } = await execFileAsync(file, args, execOptions);
        return { stdout };
      });
  }

  async #getAccessTokenIfAvailable(): Promise<string | undefined> {
    try {
      return await (
        this.#connection ?? (await this.#store.getConnection("github"))
      ).getAccessToken();
    } catch (error) {
      if (error instanceof MissingConnectionError && error.providerId === "github") {
        return undefined;
      }
      throw error;
    }
  }

  async publishChange(input: PublishChangeRequest): Promise<ChangeRequest> {
    const remoteUrl = await this.#git(input.worktreePath, [
      "remote",
      "get-url",
      input.remoteName,
    ]);
    const repository = parseGitHubRemoteUrl(remoteUrl);

    await this.#git(input.worktreePath, [
      "push",
      "-u",
      input.remoteName,
      input.headBranch,
    ]);

    const existing = await this.#findExistingPullRequest({
      repository,
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      worktreePath: input.worktreePath,
    });
    if (existing) {
      const metadataUpdate = await this.#editExistingPublishedPullRequest({
        changeRequest: existing,
        input,
      });
      return { ...existing, metadataUpdate };
    }

    await assertPublishablePullRequestDiff({
      git: this.#git,
      worktreePath: input.worktreePath,
      remoteName: input.remoteName,
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
    });

    const bodyArguments = input.bodyPath
      ? ["--body-file", input.bodyPath]
      : ["--body", input.body];
    try {
      const { stdout } = await this.#execFile(
        "gh",
        [
          "pr",
          "create",
          "--draft",
          "--base",
          input.baseBranch,
          "--head",
          input.headBranch,
          "--title",
          input.title,
          ...bodyArguments,
        ],
        {
          cwd: input.worktreePath,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      const url = stdout.trim();
      return {
        provider: "github",
        url,
        number: parsePullRequestNumber(url),
        owner: repository.owner,
        repository: repository.repository,
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        draft: true,
        outcome: "created",
      };
    } catch (error) {
      if (isAlreadyExistsPullRequestError(error)) {
        const raced = await this.#findExistingPullRequest({
          repository,
          baseBranch: input.baseBranch,
          headBranch: input.headBranch,
          worktreePath: input.worktreePath,
        });
        if (raced) {
          const metadataUpdate = await this.#editExistingPublishedPullRequest({
            changeRequest: raced,
            input,
          });
          return { ...raced, metadataUpdate, outcome: "updated" };
        }
      }
      throw error;
    }
  }

  async #findExistingPullRequest(input: {
    repository: GitHubRepository;
    baseBranch: string;
    headBranch: string;
    worktreePath: string;
  }): Promise<ChangeRequest | undefined> {
    const listArgumentSets: string[][] = [
      [
        "pr",
        "list",
        "--head",
        input.headBranch,
        "--base",
        input.baseBranch,
        "--state",
        "open",
        "--json",
        "number,url,isDraft",
        "--limit",
        "1",
      ],
      [
        "pr",
        "list",
        "--head",
        input.headBranch,
        "--state",
        "open",
        "--json",
        "number,url,isDraft",
        "--limit",
        "1",
      ],
    ];
    for (const args of listArgumentSets) {
      const { stdout } = await this.#execFile("gh", args, {
        cwd: input.worktreePath,
        maxBuffer: 10 * 1024 * 1024,
      });
      const payload = JSON.parse(stdout) as unknown;
      if (!Array.isArray(payload) || payload.length === 0) {
        continue;
      }
      const pull = asObject(payload[0]);
      return {
        provider: "github",
        url: requireString(pull.url, "url"),
        number: requireNumber(pull.number, "number"),
        owner: input.repository.owner,
        repository: input.repository.repository,
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        draft: normalizeDraft(pull.isDraft),
        outcome: "reused",
      };
    }
    return undefined;
  }

  async #editExistingPublishedPullRequest(input: {
    changeRequest: ChangeRequest;
    input: PublishChangeRequest;
  }): Promise<ChangeRequestMetadataUpdate> {
    const token = await this.#getAccessTokenIfAvailable();
    if (token) {
      return await patchPullRequestMetadata({
        fetch: this.#fetch,
        token,
        target: input.changeRequest,
        title: input.input.title,
        body: input.input.body,
      });
    }

    const args = [
      "pr",
      "edit",
      String(input.changeRequest.number),
      "--title",
      input.input.title,
    ];
    if (input.input.bodyPath !== undefined) {
      args.push("--body-file", input.input.bodyPath);
    } else {
      args.push("--body", input.input.body);
    }
    await this.#execFile("gh", args, {
      cwd: input.input.worktreePath,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      transport: "github-cli",
      outcome: "updated",
      fields: ["title", "body"],
    };
  }

  async resolveChangeRequestTarget(
    input: ResolveChangeRequestTargetRequest,
  ): Promise<ChangeRequestTarget> {
    const configured = await configuredRepository({
      git: this.#git,
      repoPath: input.repoPath,
      remoteName: input.remoteName,
    });
    const parsed = parseGitHubPullRequestTarget(input.target);
    const targetRepository = {
      owner: parsed.owner ?? configured.owner,
      repository: parsed.repository ?? configured.repository,
    };
    assertSameRepository({ configured, target: targetRepository });

    const { stdout } = await this.#execFile(
      "gh",
      [
        "pr",
        "view",
        input.target,
        "--json",
        "number,url,baseRefName,headRefName,headRefOid,headRepositoryOwner,headRepository",
      ],
      {
        cwd: input.repoPath,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    const payload = asObject(JSON.parse(stdout));
    const headRepository = asObject(payload.headRepository);
    const headOwner = asObject(payload.headRepositoryOwner);
    const target: ChangeRequestTarget = {
      provider: "github",
      owner: configured.owner,
      repository: configured.repository,
      number: requireNumber(payload.number, "number"),
      url: requireString(payload.url, "url"),
      baseBranch: requireString(payload.baseRefName, "baseRefName"),
      headBranch: requireString(payload.headRefName, "headRefName"),
      headSha: requireString(payload.headRefOid, "headRefOid"),
      headRepository: {
        owner: requireString(headOwner.login, "headRepositoryOwner.login"),
        repository: requireString(headRepository.name, "headRepository.name"),
      },
      isCrossRepository: false,
    };
    target.isCrossRepository =
      `${target.headRepository.owner}/${target.headRepository.repository}`.toLowerCase() !==
      `${configured.owner}/${configured.repository}`.toLowerCase();
    assertSameHeadRepository({ configured, target });
    return target;
  }

  async checkoutChangeRequest(
    input: CheckoutChangeRequestRequest,
  ): Promise<CheckoutChangeRequestResult> {
    return await checkoutResolvedChangeRequest({ git: this.#git, request: input });
  }

  async updateChangeRequest(
    input: UpdateChangeRequestRequest,
  ): Promise<UpdateChangeRequestResult> {
    const updated = await updateResolvedChangeRequest({
      git: this.#git,
      request: input,
    });
    const token = await this.#getAccessTokenIfAvailable();
    if (token) {
      const metadataUpdate = await patchPullRequestMetadata({
        fetch: this.#fetch,
        token,
        target: input.target,
        title: input.title,
        body: input.body,
      });
      return { ...updated, metadataUpdate };
    }
    await this.#execFile(
      "gh",
      ["pr", "edit", String(input.target.number), "--title", input.title],
      {
        cwd: input.worktreePath,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    return {
      ...updated,
      metadataUpdate: {
        transport: "github-cli",
        outcome: "updated",
        fields: ["title"],
      },
    };
  }

  async updateChangeRequestMetadata(
    input: UpdateChangeRequestMetadataRequest,
  ): Promise<UpdateChangeRequestMetadataResult> {
    const token = await this.#getAccessTokenIfAvailable();
    if (token) {
      const metadataUpdate = await patchPullRequestMetadata({
        fetch: this.#fetch,
        token,
        target: input.changeRequest,
        title: input.title,
        body: input.body,
      });
      return metadataUpdateResult({
        changeRequest: input.changeRequest,
        metadataUpdate,
      });
    }

    const args = ["pr", "edit", String(input.changeRequest.number)];
    const fields: string[] = [];
    if (input.title !== undefined) {
      args.push("--title", input.title);
      fields.push("title");
    }
    if (input.bodyPath !== undefined) {
      args.push("--body-file", input.bodyPath);
      fields.push("body");
    } else if (input.body !== undefined) {
      args.push("--body", input.body);
      fields.push("body");
    }
    await this.#execFile("gh", args, {
      cwd: input.worktreePath,
      maxBuffer: 10 * 1024 * 1024,
    });
    return metadataUpdateResult({
      changeRequest: input.changeRequest,
      metadataUpdate: {
        transport: "github-cli",
        outcome: "updated",
        fields,
      },
    });
  }
}
