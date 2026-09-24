import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { ProviderConnectionStore } from "../providers/types.js";
import { resolveProviderStore } from "../providers/index.js";
import { createScmProvider } from "../scm/registry.js";
import type {
  RepositoryIssue,
  RepositoryIssueComment,
  ScmProvider,
  ScmRepository,
} from "../scm/types.js";
import { parseTaskArtifact } from "../task-artifacts/parse.js";
import {
  buildTaskIssueGroups,
  planTaskIssues,
  type TaskIssueGrouping,
  type TaskIssueSources,
} from "./model.js";
import {
  assertTaskIssueRepository,
  readTaskIssueRegistry,
  taskIssueRegistryPath,
  taskIssueScope,
  writeTaskIssueRegistry,
  type TaskIssueBinding,
  type TaskIssueScope,
} from "./registry.js";

const execFileAsync = promisify(execFile);
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export interface SyncTaskIssuesInput {
  repoPath: string;
  tasksPath: string;
  specPath: string;
  planPath: string;
  grouping?: TaskIssueGrouping;
  remoteName?: string;
  provider?: ScmProvider;
  providerStore?: ProviderConnectionStore;
  env?: Record<string, string | undefined>;
  git?: GitRunner;
  now?: () => Date;
}

export interface SyncedTaskIssue {
  taskIds: string[];
  issue: RepositoryIssue;
  outcome: "created" | "reused";
}

export interface SyncTaskIssuesResult {
  repository: ScmRepository;
  grouping: TaskIssueGrouping;
  created: number;
  reused: number;
  issues: SyncedTaskIssue[];
  registryPath: string;
}

export interface ResolvedTaskIssueScope extends TaskIssueScope {
  repository?: ScmRepository;
  registryError?: string;
}

export type TaskIssueRunStatus = "completed" | "failed" | "blocked" | "cancelled";

export interface LinkTaskIssueRunInput {
  repoPath: string;
  runId: string;
  status: TaskIssueRunStatus;
  evidencePath: string;
  changeRequestUrl?: string;
  scope: ResolvedTaskIssueScope;
  remoteName?: string;
  provider?: ScmProvider;
  providerStore?: ProviderConnectionStore;
}

export interface TaskIssueRunLinkResult {
  issueNumber: number;
  issueUrl: string;
  taskIds: string[];
  outcome: "created" | "updated" | "reused" | "failed";
  commentUrl?: string;
  error?: string;
}

async function defaultGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function requireIssueProvider(provider: ScmProvider): {
  resolveRepository: NonNullable<ScmProvider["resolveRepository"]>;
  listRepositoryIssues: NonNullable<ScmProvider["listRepositoryIssues"]>;
  createRepositoryIssue: NonNullable<ScmProvider["createRepositoryIssue"]>;
} {
  if (
    !provider.resolveRepository ||
    !provider.listRepositoryIssues ||
    !provider.createRepositoryIssue
  ) {
    throw new Error(
      `SCM provider ${provider.type} does not support repository issue synchronization`,
    );
  }
  return {
    resolveRepository: provider.resolveRepository.bind(provider),
    listRepositoryIssues: provider.listRepositoryIssues.bind(provider),
    createRepositoryIssue: provider.createRepositoryIssue.bind(provider),
  };
}

function requireIssueCommentProvider(provider: ScmProvider): {
  resolveRepository: NonNullable<ScmProvider["resolveRepository"]>;
  listRepositoryIssueComments: NonNullable<
    ScmProvider["listRepositoryIssueComments"]
  >;
  createRepositoryIssueComment: NonNullable<
    ScmProvider["createRepositoryIssueComment"]
  >;
  updateRepositoryIssueComment: NonNullable<
    ScmProvider["updateRepositoryIssueComment"]
  >;
} {
  if (
    !provider.resolveRepository ||
    !provider.listRepositoryIssueComments ||
    !provider.createRepositoryIssueComment ||
    !provider.updateRepositoryIssueComment
  ) {
    throw new Error(
      `SCM provider ${provider.type} does not support repository issue comments`,
    );
  }
  return {
    resolveRepository: provider.resolveRepository.bind(provider),
    listRepositoryIssueComments: provider.listRepositoryIssueComments.bind(provider),
    createRepositoryIssueComment: provider.createRepositoryIssueComment.bind(provider),
    updateRepositoryIssueComment: provider.updateRepositoryIssueComment.bind(provider),
  };
}

function pathInside(parent: string, candidate: string): boolean {
  const value = relative(parent, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function slashPath(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}

function encodedGitHubPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function repositoryArtifactPath(input: {
  repoRoot: string;
  commit: string;
  value: string;
  label: string;
  git: GitRunner;
}): Promise<string> {
  if (!input.value || isAbsolute(input.value)) {
    throw new Error(`${input.label} must be a repository-relative path`);
  }
  const unresolved = resolve(input.repoRoot, input.value);
  const fileInfo = await lstat(unresolved).catch(() => undefined);
  if (!fileInfo?.isFile() || fileInfo.isSymbolicLink()) {
    throw new Error(`${input.label} must be a regular, non-symlink file`);
  }
  const resolvedPath = await realpath(unresolved);
  if (!pathInside(input.repoRoot, resolvedPath)) {
    throw new Error(`${input.label} must stay inside the repository`);
  }
  const path = slashPath(relative(input.repoRoot, resolvedPath));
  try {
    await input.git(input.repoRoot, ["cat-file", "-e", `${input.commit}:${path}`]);
  } catch {
    throw new Error(`${input.label} must be tracked at HEAD: ${path}`);
  }
  try {
    await input.git(input.repoRoot, ["diff", "--quiet", input.commit, "--", path]);
  } catch {
    throw new Error(`${input.label} must match its committed HEAD content: ${path}`);
  }
  return path;
}

async function taskIssueSources(input: {
  repoPath: string;
  tasksPath: string;
  specPath: string;
  planPath: string;
  repository: ScmRepository;
  git: GitRunner;
}): Promise<TaskIssueSources> {
  const repoRoot = await realpath(resolve(input.repoPath));
  const commit = (await input.git(repoRoot, ["rev-parse", "HEAD"])).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
    throw new Error("unable to resolve a full HEAD commit SHA for task issue links");
  }
  const [tasksPath, specPath, planPath] = await Promise.all([
    repositoryArtifactPath({
      repoRoot,
      commit,
      value: input.tasksPath,
      label: "--tasks",
      git: input.git,
    }),
    repositoryArtifactPath({
      repoRoot,
      commit,
      value: input.specPath,
      label: "--spec",
      git: input.git,
    }),
    repositoryArtifactPath({
      repoRoot,
      commit,
      value: input.planPath,
      label: "--plan",
      git: input.git,
    }),
  ]);
  const link = (path: string) => ({
    path,
    url: `${input.repository.url}/blob/${commit}/${encodedGitHubPath(path)}`,
  });
  return {
    commit,
    commitUrl: `${input.repository.url}/commit/${commit}`,
    tasks: link(tasksPath),
    spec: link(specPath),
    plan: link(planPath),
  };
}

function bridgeProvider(input: {
  repoPath: string;
  provider?: ScmProvider;
  providerStore?: ProviderConnectionStore;
  env?: Record<string, string | undefined>;
}): ScmProvider {
  return (
    input.provider ??
    createScmProvider("github", {
      store:
        input.providerStore ??
        resolveProviderStore(
          join(resolve(input.repoPath), ".nitely"),
          input.env ?? process.env,
        ),
    })
  );
}

export async function syncTaskIssues(
  input: SyncTaskIssuesInput,
): Promise<SyncTaskIssuesResult> {
  const repoPath = await realpath(resolve(input.repoPath));
  const remoteName = input.remoteName ?? "origin";
  const grouping = input.grouping ?? "task";
  const provider = bridgeProvider({ ...input, repoPath });
  const capabilities = requireIssueProvider(provider);
  const repository = await capabilities.resolveRepository({ repoPath, remoteName });
  const existingRegistry = await readTaskIssueRegistry(repoPath);
  if (existingRegistry) {
    assertTaskIssueRepository({
      actual: existingRegistry.repository,
      expected: repository,
    });
  }
  const sources = await taskIssueSources({
    repoPath,
    tasksPath: input.tasksPath,
    specPath: input.specPath,
    planPath: input.planPath,
    repository,
    git: input.git ?? defaultGit,
  });
  const parsed = parseTaskArtifact(
    await (input.git ?? defaultGit)(repoPath, [
      "show",
      `${sources.commit}:${sources.tasks.path}`,
    ]),
  );
  const groups = buildTaskIssueGroups({ parsed, grouping, sources });
  const existingIssues = await capabilities.listRepositoryIssues({
    repoPath,
    remoteName,
    repository,
  });
  const plan = planTaskIssues({ groups, existingIssues });
  const synced: SyncedTaskIssue[] = [];
  for (const entry of plan.entries) {
    const issue =
      entry.issue ??
      (await capabilities.createRepositoryIssue({
        repoPath,
        remoteName,
        repository,
        title: entry.group.title,
        body: entry.group.body,
      }));
    synced.push({
      taskIds: entry.group.taskIds,
      issue,
      outcome: entry.outcome === "create" ? "created" : "reused",
    });
  }

  const syncedAt = (input.now?.() ?? new Date()).toISOString();
  const source = {
    commit: sources.commit,
    tasksPath: sources.tasks.path,
    specPath: sources.spec.path,
    planPath: sources.plan.path,
  };
  const bindings: TaskIssueBinding[] = synced.flatMap((entry) =>
    entry.taskIds.map((taskId) => ({
      taskId,
      issueNumber: entry.issue.number,
      issueUrl: entry.issue.url,
      issueTitle: entry.issue.title,
      issueState: entry.issue.state,
      source,
      syncedAt,
    })),
  );
  await writeTaskIssueRegistry({ repoPath, repository, bindings });
  return {
    repository,
    grouping,
    created: synced.filter((entry) => entry.outcome === "created").length,
    reused: synced.filter((entry) => entry.outcome === "reused").length,
    issues: synced,
    registryPath: taskIssueRegistryPath(repoPath),
  };
}

export async function resolveTaskIssueScope(input: {
  repoPath: string;
  taskIds: string[];
  remoteName?: string;
  provider?: ScmProvider;
  providerStore?: ProviderConnectionStore;
}): Promise<ResolvedTaskIssueScope> {
  let registry;
  try {
    registry = await readTaskIssueRegistry(input.repoPath);
  } catch (error) {
    return {
      issues: [],
      missingTaskIds: [...new Set(input.taskIds)],
      registryError: error instanceof Error ? error.message : String(error),
    };
  }
  if (!registry) {
    return { issues: [], missingTaskIds: [...new Set(input.taskIds)] };
  }
  try {
    const provider = bridgeProvider(input);
    if (!provider.resolveRepository) {
      throw new Error(`SCM provider ${provider.type} cannot resolve repository identity`);
    }
    const repository = await provider.resolveRepository({
      repoPath: input.repoPath,
      remoteName: input.remoteName ?? "origin",
    });
    return {
      repository,
      ...taskIssueScope({ registry, repository, taskIds: input.taskIds }),
    };
  } catch (error) {
    return {
      issues: [],
      missingTaskIds: [...new Set(input.taskIds)],
      registryError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function taskIssueRunMarker(input: {
  repository: ScmRepository;
  runId: string;
  issueNumber: number;
}): string {
  const digest = createHash("sha256")
    .update(
      `${input.repository.owner.toLowerCase()}/${input.repository.repository.toLowerCase()}:${input.runId}:${input.issueNumber}`,
    )
    .digest("hex");
  return `<!-- nitely-task-run:v1 ${digest} -->`;
}

function relativeEvidencePath(input: {
  repoPath: string;
  evidencePath: string;
}): string {
  const repoPath = resolve(input.repoPath);
  const evidencePath = resolve(input.evidencePath);
  if (!pathInside(repoPath, evidencePath)) {
    throw new Error("task issue run evidence path must stay inside the repository");
  }
  return slashPath(relative(repoPath, evidencePath));
}

function renderTaskIssueRunComment(input: {
  marker: string;
  runId: string;
  status: TaskIssueRunStatus;
  evidencePath: string;
  taskIds: string[];
  changeRequestUrl?: string;
}): string {
  return [
    input.marker,
    "",
    `Nitely run \`${input.runId}\` reached terminal status **${input.status}** for this task issue.`,
    "",
    `- Covered task IDs: ${input.taskIds.map((taskId) => `\`${taskId}\``).join(", ")}`,
    `- Run evidence: \`${input.evidencePath}\``,
    input.changeRequestUrl
      ? `- Pull request and published evidence: ${input.changeRequestUrl}`
      : "- Pull request: none published",
    "",
  ].join("\n");
}

function reusedComment(
  comments: RepositoryIssueComment[],
  marker: string,
): RepositoryIssueComment | undefined {
  return comments.find((comment) => comment.body.includes(marker));
}

export async function linkTaskIssuesToRun(
  input: LinkTaskIssueRunInput,
): Promise<TaskIssueRunLinkResult[]> {
  if (!input.scope.repository || input.scope.issues.length === 0) return [];
  if (!RUN_ID_PATTERN.test(input.runId)) {
    throw new Error("task issue run ID contains unsupported characters");
  }
  const provider = bridgeProvider(input);
  const capabilities = requireIssueCommentProvider(provider);
  const remoteName = input.remoteName ?? "origin";
  const repository = await capabilities.resolveRepository({
    repoPath: input.repoPath,
    remoteName,
  });
  assertTaskIssueRepository({ actual: input.scope.repository, expected: repository });
  const evidencePath = relativeEvidencePath(input);
  const results: TaskIssueRunLinkResult[] = [];
  for (const issue of input.scope.issues) {
    const marker = taskIssueRunMarker({
      repository,
      runId: input.runId,
      issueNumber: issue.issueNumber,
    });
    try {
      const comments = await capabilities.listRepositoryIssueComments({
        repoPath: input.repoPath,
        remoteName,
        repository,
        issueNumber: issue.issueNumber,
      });
      const existing = reusedComment(comments, marker);
      const body = renderTaskIssueRunComment({
        marker,
        runId: input.runId,
        status: input.status,
        evidencePath,
        taskIds: issue.taskIds,
        changeRequestUrl: input.changeRequestUrl,
      });
      if (existing) {
        if (existing.body !== body) {
          const updated = await capabilities.updateRepositoryIssueComment({
            repoPath: input.repoPath,
            remoteName,
            repository,
            commentId: existing.id,
            body,
          });
          results.push({
            issueNumber: issue.issueNumber,
            issueUrl: issue.issueUrl,
            taskIds: issue.taskIds,
            outcome: "updated",
            commentUrl: updated.url,
          });
          continue;
        }
        results.push({
          issueNumber: issue.issueNumber,
          issueUrl: issue.issueUrl,
          taskIds: issue.taskIds,
          outcome: "reused",
          commentUrl: existing.url,
        });
        continue;
      }
      const comment = await capabilities.createRepositoryIssueComment({
        repoPath: input.repoPath,
        remoteName,
        repository,
        issueNumber: issue.issueNumber,
        body,
      });
      results.push({
        issueNumber: issue.issueNumber,
        issueUrl: issue.issueUrl,
        taskIds: issue.taskIds,
        outcome: "created",
        commentUrl: comment.url,
      });
    } catch (error) {
      results.push({
        issueNumber: issue.issueNumber,
        issueUrl: issue.issueUrl,
        taskIds: issue.taskIds,
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
