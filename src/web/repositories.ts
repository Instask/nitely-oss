import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

import { parseGitHubRemoteUrl } from "../scm/github.js";
import { WebInputError, WebNotFoundError } from "./errors.js";

export interface WebRepositoryInput {
  id?: string;
  name?: string;
  path: string;
  defaultBranch?: string;
  sourceUrl?: string;
  synthetic?: boolean;
  organizationId?: string;
}

export interface WebRepository {
  id: string;
  name: string;
  /**
   * Checkout location on this server. Internal: stripped from every Web API
   * response by publicRepository() and never rendered by the console.
   */
  path: string;
  defaultBranch?: string;
  sourceUrl?: string;
  synthetic?: boolean;
  organizationId?: string;
  /**
   * Set on the entry whose checkout is the console home directory. Derived
   * from `path` at load time, never stored.
   */
  home?: true;
  /**
   * Set on clones Nitely created under `<home>/.nitely/repositories`. Only a
   * managed clone may be reset to its remote. Derived, never stored.
   */
  managed?: true;
}

export type PublicWebRepository = Omit<WebRepository, "path" | "home" | "managed">;

export function publicRepository(repository: WebRepository): PublicWebRepository {
  const { path: _path, home: _home, managed: _managed, ...rest } = repository;
  return rest;
}

export const LEGACY_DEFAULT_REPOSITORY_ID = "default";

export interface AddWebRepositoryInput {
  id?: string;
  name?: string;
  /**
   * Explicit checkout location. Honored only for synthetic entries (the
   * mocked golden-path demo registers its fixture this way). Every other
   * registration clones `githubUrl` into the managed checkout root.
   */
  path?: string;
  githubUrl?: string;
  defaultBranch?: string;
  synthetic?: boolean;
  organizationId?: string;
}

export type CloneRepository = (input: {
  url: string;
  targetPath: string;
}) => Promise<void>;

interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  cloneUrl: string;
}

const repoIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

interface WebRepositoriesFile {
  version: 1;
  repositories: WebRepositoryInput[];
}

function validateRepoId(id: string): void {
  if (!repoIdPattern.test(id)) {
    throw new WebInputError("invalid repository id");
  }
}

function displayNameForPath(path: string): string {
  return basename(path) || path;
}

function normalizeRepository(
  homePath: string,
  input: WebRepositoryInput,
): WebRepository {
  const id = input.id?.trim();
  if (!id) {
    throw new WebInputError("repository id is required");
  }
  validateRepoId(id);
  const path = resolve(input.path);
  const name = input.name?.trim() || displayNameForPath(path);
  const managedRoot = managedCheckoutRoot(homePath);
  return {
    id,
    name,
    path,
    ...(input.defaultBranch?.trim()
      ? { defaultBranch: input.defaultBranch.trim() }
      : {}),
    ...(input.sourceUrl?.trim() ? { sourceUrl: input.sourceUrl.trim() } : {}),
    ...(input.synthetic === true ? { synthetic: true } : {}),
    ...(input.organizationId?.trim()
      ? { organizationId: input.organizationId.trim() }
      : {}),
    ...(path === resolve(homePath) ? { home: true as const } : {}),
    ...(path.startsWith(`${managedRoot}${sep}`) ? { managed: true as const } : {}),
  };
}

function repositoriesPath(homeRepoPath: string): string {
  return join(resolve(homeRepoPath), ".nitely", "repositories.json");
}

function managedCheckoutRoot(homePath: string): string {
  return join(resolve(homePath), ".nitely", "repositories");
}

function legacyGoldenPathRepositoryCandidate(
  input: WebRepositoryInput,
): boolean {
  return (
    input.synthetic !== true &&
    input.id === "demo-golden-path" &&
    input.name === "Mocked golden path demo"
  );
}

function migrateLegacyGoldenPathRepositoryLexically(
  defaultRepoPath: string,
  input: WebRepositoryInput,
): WebRepositoryInput {
  if (!legacyGoldenPathRepositoryCandidate(input)) {
    return input;
  }
  const demoRoot = join(
    resolve(defaultRepoPath),
    ".nitely",
    "demo",
    "golden-path",
  );
  const path = resolve(input.path);
  return path === demoRoot || path.startsWith(`${demoRoot}${sep}`)
    ? { ...input, synthetic: true }
    : input;
}

async function realpathOrResolve(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function migrateLegacyGoldenPathRepository(
  defaultRepoPath: string,
  input: WebRepositoryInput,
): Promise<WebRepositoryInput> {
  const lexical = migrateLegacyGoldenPathRepositoryLexically(
    defaultRepoPath,
    input,
  );
  if (lexical !== input || !legacyGoldenPathRepositoryCandidate(input)) {
    return lexical;
  }
  const [realDefaultRepoPath, realRepositoryPath] = await Promise.all([
    realpathOrResolve(defaultRepoPath),
    realpathOrResolve(input.path),
  ]);
  const demoRoot = join(
    realDefaultRepoPath,
    ".nitely",
    "demo",
    "golden-path",
  );
  return realRepositoryPath === demoRoot ||
    realRepositoryPath.startsWith(`${demoRoot}${sep}`)
    ? { ...input, synthetic: true }
    : input;
}

function parseRepositoriesFile(value: unknown): WebRepositoriesFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WebInputError("invalid repositories file");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.repositories)) {
    throw new WebInputError("invalid repositories file");
  }
  return {
    version: 1,
    repositories: record.repositories.map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new WebInputError("invalid repository entry");
      }
      const item = entry as Record<string, unknown>;
      return {
        id: typeof item.id === "string" ? item.id : undefined,
        name: typeof item.name === "string" ? item.name : undefined,
        path: typeof item.path === "string" ? item.path : "",
        defaultBranch:
          typeof item.defaultBranch === "string" ? item.defaultBranch : undefined,
        sourceUrl: typeof item.sourceUrl === "string" ? item.sourceUrl : undefined,
        synthetic: item.synthetic === true ? true : undefined,
        organizationId:
          typeof item.organizationId === "string" ? item.organizationId : undefined,
      };
    }),
  };
}

async function readStoredRepositories(
  homeRepoPath: string,
): Promise<WebRepositoryInput[]> {
  try {
    return parseRepositoriesFile(
      JSON.parse(await readFile(repositoriesPath(homeRepoPath), "utf8")),
    ).repositories;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

async function assertRepositoryPath(path: string): Promise<void> {
  let stats;
  try {
    stats = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WebInputError("repository path must exist");
    }
    throw error;
  }
  if (!stats.isDirectory()) {
    throw new WebInputError("repository path must be a directory");
  }
}

function sanitizeRepoId(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.slice(0, 64) || "repository";
}

function stripDotGit(repo: string): string {
  return repo.endsWith(".git") ? repo.slice(0, -4) : repo;
}

export function parseGitHubRepositoryUrl(value: string): ParsedGitHubUrl {
  const raw = value.trim();
  const sshMatch = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (sshMatch) {
    const owner = sshMatch[1];
    const repo = stripDotGit(sshMatch[2].split("/")[0]);
    if (!owner || !repo) {
      throw new WebInputError("invalid GitHub repository URL");
    }
    return {
      owner,
      repo,
      cloneUrl: `git@github.com:${owner}/${repo}.git`,
    };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebInputError("invalid GitHub repository URL");
  }
  if (url.hostname.toLowerCase() !== "github.com") {
    throw new WebInputError("repository URL must be on github.com");
  }
  const [owner, repoSegment] = url.pathname.split("/").filter(Boolean);
  const repo = repoSegment ? stripDotGit(repoSegment) : "";
  if (!owner || !repo) {
    throw new WebInputError("invalid GitHub repository URL");
  }
  return {
    owner,
    repo,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

function checkoutPath(defaultRepoPath: string, id: string): string {
  return join(managedCheckoutRoot(defaultRepoPath), id);
}

function repositorySourceKey(value: string | undefined): string {
  const source = value?.trim();
  if (!source) return "";
  try {
    const parsed = parseGitHubRepositoryUrl(source);
    return `github:${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}`;
  } catch {
    return source.toLowerCase();
  }
}

export type RunGit = (args: string[], cwd: string) => Promise<void>;

async function defaultRunGit(args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    execFile("git", args, { cwd, timeout: 120_000 }, (error) => {
      if (error) {
        reject(new WebInputError("failed to sync repository"));
        return;
      }
      resolvePromise();
    });
  });
}

async function defaultCloneRepository(input: {
  url: string;
  targetPath: string;
}): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    execFile(
      "git",
      ["clone", "--depth", "1", input.url, input.targetPath],
      { timeout: 120_000 },
      (error) => {
        if (error) {
          reject(new WebInputError("failed to clone repository"));
          return;
        }
        resolvePromise();
      },
    );
  });
}

export type ReadOriginUrl = (path: string) => Promise<string | undefined>;

async function gitOutput(args: string[]): Promise<string | undefined> {
  return await new Promise<string | undefined>((resolvePromise) => {
    execFile("git", args, { timeout: 10_000 }, (error, stdout) => {
      resolvePromise(error ? undefined : stdout.trim() || undefined);
    });
  });
}

/**
 * The `origin` URL of the git repository rooted exactly at `path`. A
 * directory that merely sits inside some other checkout (a temp directory
 * under a clone, a state directory nested in a project) yields nothing: only
 * a checkout whose top level is `path` itself is the home checkout.
 */
export async function readGitOriginUrl(path: string): Promise<string | undefined> {
  const toplevel = await gitOutput(["-C", path, "rev-parse", "--show-toplevel"]);
  if (!toplevel) return undefined;
  const [realToplevel, realPath] = await Promise.all([
    realpathOrResolve(toplevel),
    realpathOrResolve(path),
  ]);
  if (realToplevel !== realPath) return undefined;
  return await gitOutput(["-C", path, "remote", "get-url", "origin"]);
}

export type HomeRepositoryMigration =
  | { status: "registered"; repository: WebRepository }
  | {
      status: "skipped";
      reason:
        | "already-registered"
        | "no-origin"
        | "origin-not-github"
        | "source-already-registered"
        | "id-collision";
      originUrl?: string;
    };

/**
 * One-time, idempotent startup migration for installs that used to treat the
 * console home directory as the implicit `default` repository. When home is
 * a checkout with a GitHub `origin` and nothing stored already covers that
 * source or that path, register it as an ordinary repository whose checkout
 * happens to be home. Runs recorded under `<home>/.nitely/runs` keep their
 * owner that way.
 */
export async function migrateHomeRepository(
  homePath: string,
  readOriginUrl: ReadOriginUrl = readGitOriginUrl,
): Promise<HomeRepositoryMigration> {
  const home = resolve(homePath);
  const stored = await readStoredRepositories(home);
  if (stored.some((entry) => resolve(entry.path) === home)) {
    return { status: "skipped", reason: "already-registered" };
  }
  const originUrl = await readOriginUrl(home);
  if (!originUrl) {
    return { status: "skipped", reason: "no-origin" };
  }
  let parsed: ParsedGitHubUrl;
  try {
    parsed = parseGitHubRepositoryUrl(originUrl);
  } catch {
    return { status: "skipped", reason: "origin-not-github", originUrl };
  }
  const sourceKey = repositorySourceKey(parsed.cloneUrl);
  if (stored.some((entry) => repositorySourceKey(entry.sourceUrl) === sourceKey)) {
    return { status: "skipped", reason: "source-already-registered", originUrl };
  }
  const entry: WebRepositoryInput = {
    id: sanitizeRepoId(`${parsed.owner}-${parsed.repo}`),
    name: `${parsed.owner}/${parsed.repo}`,
    path: home,
    sourceUrl: parsed.cloneUrl,
  };
  if (stored.some((candidate) => candidate.id === entry.id)) {
    return { status: "skipped", reason: "id-collision", originUrl };
  }
  const repository = normalizeRepository(home, entry);
  await writeJsonAtomic(repositoriesPath(home), {
    version: 1,
    repositories: [...stored, entry],
  });
  return { status: "registered", repository };
}

/**
 * True when `<home>/.nitely/runs` or `<home>/.nitely/tasks` exists as a
 * directory. Used to warn when the origin migration above did not register a
 * repository but the home directory still holds pre-upgrade run/task state
 * that would otherwise silently disappear from the console.
 */
export async function hasLegacyHomeState(homePath: string): Promise<boolean> {
  const home = resolve(homePath);
  for (const name of ["runs", "tasks"]) {
    try {
      const info = await stat(join(home, ".nitely", name));
      if (info.isDirectory()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return false;
}

/**
 * Refresh a checkout Nitely created itself. Only managed clones — the ones
 * under `<home>/.nitely/repositories` — are touched: those are Nitely's to
 * reset. Anything else, including the home checkout the origin migration
 * registers with a source URL, is somebody's working tree, and discarding
 * uncommitted work there would be unforgivable.
 */
export async function syncStoredWebRepository(
  repository: WebRepository,
  runGit: RunGit = defaultRunGit,
): Promise<boolean> {
  if (repository.managed !== true) return false;
  const branch = repository.defaultBranch?.trim() || "HEAD";
  await runGit(["fetch", "--depth", "1", "origin", branch], repository.path);
  await runGit(["reset", "--hard", "FETCH_HEAD"], repository.path);
  return true;
}

export function resolveWebRepositories(
  defaultRepoPath: string,
  repositories: WebRepositoryInput[] = [],
): WebRepository[] {
  const byId = new Map<string, WebRepository>();
  for (const repository of repositories) {
    const normalized = normalizeRepository(
      defaultRepoPath,
      migrateLegacyGoldenPathRepositoryLexically(defaultRepoPath, repository),
    );
    if (normalized.id === LEGACY_DEFAULT_REPOSITORY_ID) {
      throw new WebInputError("repository id default is reserved");
    }
    if (byId.has(normalized.id)) {
      throw new WebInputError(`duplicate repository id: ${normalized.id}`);
    }
    byId.set(normalized.id, normalized);
  }
  return [...byId.values()];
}

export async function loadWebRepositories(
  defaultRepoPath: string,
  repositories: WebRepositoryInput[] = [],
): Promise<WebRepository[]> {
  const stored = await readStoredRepositories(defaultRepoPath);
  const [migratedRuntime, migratedStored] = await Promise.all([
    Promise.all(
      repositories.map((repository) =>
        migrateLegacyGoldenPathRepository(defaultRepoPath, repository),
      ),
    ),
    Promise.all(
      stored.map((repository) =>
        migrateLegacyGoldenPathRepository(defaultRepoPath, repository),
      ),
    ),
  ]);
  if (migratedStored.some((repository, index) => repository !== stored[index])) {
    await writeJsonAtomic(repositoriesPath(defaultRepoPath), {
      version: 1,
      repositories: migratedStored,
    });
  }
  return resolveWebRepositories(defaultRepoPath, [
    ...migratedRuntime,
    ...migratedStored,
  ]);
}

export async function addStoredWebRepository(
  defaultRepoPath: string,
  runtimeRepositories: WebRepositoryInput[] = [],
  input: AddWebRepositoryInput,
  cloneRepository: CloneRepository = defaultCloneRepository,
): Promise<WebRepository> {
  const githubUrl = input.githubUrl?.trim();
  const parsedUrl = githubUrl ? parseGitHubRepositoryUrl(githubUrl) : undefined;
  const syntheticPath =
    input.synthetic === true ? input.path?.trim() || undefined : undefined;
  if (!parsedUrl && !syntheticPath) {
    throw new WebInputError("githubUrl is required");
  }
  const id =
    input.id?.trim() ||
    (parsedUrl ? sanitizeRepoId(`${parsedUrl.owner}-${parsedUrl.repo}`) : "");
  if (!id) {
    throw new WebInputError("repository id is required");
  }
  const repositoryPath = syntheticPath ?? checkoutPath(defaultRepoPath, id);
  const repository = normalizeRepository(defaultRepoPath, {
    id,
    name: input.name?.trim() || (parsedUrl ? `${parsedUrl.owner}/${parsedUrl.repo}` : undefined),
    path: repositoryPath,
    defaultBranch: input.defaultBranch,
    sourceUrl: parsedUrl?.cloneUrl,
    synthetic: input.synthetic,
    organizationId: input.organizationId,
  });
  if (repository.id === LEGACY_DEFAULT_REPOSITORY_ID) {
    throw new WebInputError("repository id default is reserved");
  }
  const stored = await readStoredRepositories(defaultRepoPath);
  const existing = resolveWebRepositories(defaultRepoPath, [
    ...runtimeRepositories,
    ...stored,
  ]);
  if (existing.some((candidate) => candidate.id === repository.id)) {
    throw new WebInputError(`duplicate repository id: ${repository.id}`);
  }
  if (existing.some((candidate) => candidate.path === repository.path)) {
    throw new WebInputError(`duplicate repository path: ${repository.path}`);
  }
  const sourceKey = repositorySourceKey(repository.sourceUrl);
  if (
    sourceKey &&
    existing.some((candidate) => repositorySourceKey(candidate.sourceUrl) === sourceKey)
  ) {
    throw new WebInputError(`duplicate repository source: ${repository.sourceUrl}`);
  }
  if (parsedUrl && !syntheticPath) {
    try {
      await mkdir(dirname(repository.path), { recursive: true });
      await cloneRepository({
        url: parsedUrl.cloneUrl,
        targetPath: repository.path,
      });
    } catch (error) {
      await rm(repository.path, { force: true, recursive: true }).catch(() => {});
      throw error;
    }
  }
  await assertRepositoryPath(repository.path);
  const nextStored: WebRepositoryInput[] = [
    ...stored,
    {
      id: repository.id,
      name: repository.name,
      path: repository.path,
      ...(repository.defaultBranch
        ? { defaultBranch: repository.defaultBranch }
        : {}),
      ...(repository.sourceUrl ? { sourceUrl: repository.sourceUrl } : {}),
      ...(repository.synthetic === true ? { synthetic: true } : {}),
      ...(repository.organizationId
        ? { organizationId: repository.organizationId }
        : {}),
    },
  ];
  await writeJsonAtomic(repositoriesPath(defaultRepoPath), {
    version: 1,
    repositories: nextStored,
  });
  return repository;
}

/** `owner/repo` of a repository registered from a GitHub source URL. */
export function githubRepositorySlug(
  repository: Pick<WebRepository, "sourceUrl">,
): string | undefined {
  if (!repository.sourceUrl) return undefined;
  try {
    const { owner, repository: name } = parseGitHubRemoteUrl(repository.sourceUrl);
    return owner && name ? `${owner}/${name}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Look a repository up by id. An omitted id, or the legacy `default` id that
 * older Work items still carry, means the home checkout: the entry whose
 * `path` is the console home directory. When nothing is registered at the
 * home directory there is no implicit repository, and the caller must name
 * one.
 */
export function repositoryById(
  repositories: WebRepository[],
  id: string | undefined,
): WebRepository {
  const wanted = id?.trim();
  if (wanted && wanted !== LEGACY_DEFAULT_REPOSITORY_ID) {
    const repository = repositories.find((candidate) => candidate.id === wanted);
    if (!repository) {
      throw new WebNotFoundError("repository not found");
    }
    return repository;
  }
  const home = repositories.find((candidate) => candidate.home === true);
  if (!home) {
    throw new WebInputError("repoId is required");
  }
  return home;
}
