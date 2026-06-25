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
  ListPullRequestDiscussionRequest,
  PublishChangeRequest,
  PullRequestDiscussionItem,
  ResolveChangeRequestTargetRequest,
  ScmProvider,
  UpdateChangeRequestRequest,
  UpdateChangeRequestResult,
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
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:$|[?#])/.exec(
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
      `pull request target ${target} does not match configured repository ${configured}`,
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

async function findExistingPullRequest(input: {
  fetch: FetchLike;
  token: string;
  repository: GitHubRepository;
  baseBranch: string;
  headBranch: string;
}): Promise<ChangeRequest | undefined> {
  const head = `${input.repository.owner}:${input.headBranch}`;
  const response = await input.fetch(
    `https://api.github.com/repos/${input.repository.owner}/${input.repository.repository}/pulls?state=open&head=${encodeQueryValue(head)}&base=${encodeQueryValue(input.baseBranch)}&per_page=1`,
    {
      method: "GET",
      headers: githubJsonHeaders(input.token),
    },
  );
  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      `GitHub pull request lookup failed with ${response.status}: ${details}`,
    );
  }
  const payload = await response.json();
  if (!Array.isArray(payload) || payload.length === 0) {
    return undefined;
  }
  return changeRequestFromGitHubPullPayload({
    repository: input.repository,
    baseBranch: input.baseBranch,
    headBranch: input.headBranch,
    payload: payload[0],
    outcome: "reused",
  });
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

async function requireGithubArrayResponse(
  response: Response,
  label: string,
): Promise<unknown[]> {
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`GitHub ${label} failed with ${response.status}: ${details}`);
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

function parseWorktreeList(output: string): Array<{ path: string; branch?: string }> {
  return output
    .trim()
    .split(/\n\n+/)
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const result: { path: string; branch?: string } = { path: "" };
      for (const line of entry.split("\n")) {
        if (line.startsWith("worktree ")) {
          result.path = line.slice("worktree ".length);
        }
        if (line.startsWith("branch ")) {
          result.branch = line.slice("branch ".length);
        }
      }
      return result;
    })
    .filter((entry) => entry.path.length > 0);
}

async function releaseCleanNitelyWorktreeForBranch(input: {
  git: GitRunner;
  repoPath: string;
  worktreePath: string;
  headBranch: string;
}): Promise<void> {
  const worktrees = parseWorktreeList(
    await input.git(input.repoPath, ["worktree", "list", "--porcelain"]),
  );
  const nitelyRunsDirectory = resolve(input.repoPath, ".nitely", "runs");
  const targetRef = `refs/heads/${input.headBranch}`;
  for (const worktree of worktrees) {
    const worktreePath = resolve(worktree.path);
    if (worktree.branch !== targetRef || worktreePath === resolve(input.worktreePath)) {
      continue;
    }
    if (!isPathInside(nitelyRunsDirectory, worktreePath)) {
      throw new Error(
        `pull request branch ${input.headBranch} is already checked out at ${worktree.path}`,
      );
    }
    const status = await input.git(worktreePath, ["status", "--short"]);
    if (status.trim().length > 0) {
      throw new Error(
        `pull request branch ${input.headBranch} is already checked out with local changes at ${worktree.path}`,
      );
    }
    await input.git(input.repoPath, ["worktree", "remove", "--force", worktree.path]);
  }
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
  await releaseCleanNitelyWorktreeForBranch({
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
    input.request.target.headBranch,
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
      return existing;
    }

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
      const details = await response.text();
      throw new Error(
        `GitHub pull request creation failed with ${response.status}: ${details}`,
      );
    }

    return changeRequestFromGitHubPullPayload({
      repository,
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      payload: await response.json(),
      outcome: "created",
    });
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
      const details = await response.text();
      throw new Error(
        `GitHub pull request lookup failed with ${response.status}: ${details}`,
      );
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
    const response = await this.#fetch(
      `https://api.github.com/repos/${input.target.owner}/${input.target.repository}/pulls/${input.target.number}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ title: input.title }),
      },
    );
    if (!response.ok) {
      const details = await response.text();
      throw new Error(
        `GitHub pull request title update failed with ${response.status}: ${details}`,
      );
    }
    return updated;
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
      const details = await response.text();
      throw new Error(
        `GitHub pull request comment creation failed with ${response.status}: ${details}`,
      );
    }
    return normalizeDiscussionPayload(await response.json(), "issue-comment");
  }
}

export interface GitHubCliScmProviderOptions {
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
  readonly #git: GitRunner;
  readonly #execFile: NonNullable<GitHubCliScmProviderOptions["execFile"]>;

  constructor(options: GitHubCliScmProviderOptions = {}) {
    this.#git = options.git ?? defaultGit;
    this.#execFile =
      options.execFile ??
      (async (file, args, execOptions) => {
        const { stdout } = await execFileAsync(file, args, execOptions);
        return { stdout };
      });
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
      return existing;
    }

    const bodyArguments = input.bodyPath
      ? ["--body-file", input.bodyPath]
      : ["--body", input.body];
    const { stdout } = await this.#execFile(
      "gh",
      [
        "pr",
        "create",
        "--draft",
        "--base",
        input.baseBranch,
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
  }

  async #findExistingPullRequest(input: {
    repository: GitHubRepository;
    baseBranch: string;
    headBranch: string;
    worktreePath: string;
  }): Promise<ChangeRequest | undefined> {
    const { stdout } = await this.#execFile(
      "gh",
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
      {
        cwd: input.worktreePath,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    const payload = JSON.parse(stdout) as unknown;
    if (!Array.isArray(payload) || payload.length === 0) {
      return undefined;
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
    await this.#execFile(
      "gh",
      ["pr", "edit", String(input.target.number), "--title", input.title],
      {
        cwd: input.worktreePath,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    return updated;
  }
}
