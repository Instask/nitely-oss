import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve } from "node:path";

import type { ScmRepository } from "../scm/types.js";

export const TASK_ISSUE_REGISTRY_SCHEMA = "nitely.task-issues.v1";

export interface TaskIssueBindingSource {
  commit: string;
  tasksPath: string;
  specPath: string;
  planPath: string;
}

export interface TaskIssueBinding {
  taskId: string;
  issueNumber: number;
  issueUrl: string;
  issueTitle: string;
  issueState: "open" | "closed";
  source: TaskIssueBindingSource;
  syncedAt: string;
}

export interface TaskIssueRegistry {
  schemaVersion: typeof TASK_ISSUE_REGISTRY_SCHEMA;
  repository: ScmRepository;
  bindings: TaskIssueBinding[];
}

export interface TaskIssueScopeLink {
  issueNumber: number;
  issueUrl: string;
  issueTitle: string;
  issueState: "open" | "closed";
  taskIds: string[];
}

export interface TaskIssueScope {
  issues: TaskIssueScopeLink[];
  missingTaskIds: string[];
}

const TASK_ID_PATTERN = /^T\d{3}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/i;

export function taskIssueRegistryPath(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "task-issues.json");
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function sameRepository(left: ScmRepository, right: ScmRepository): boolean {
  return (
    left.provider === right.provider &&
    `${left.owner}/${left.repository}`.toLowerCase() ===
      `${right.owner}/${right.repository}`.toLowerCase()
  );
}

export function assertTaskIssueRepository(input: {
  actual: ScmRepository;
  expected: ScmRepository;
}): void {
  if (!sameRepository(input.actual, input.expected)) {
    throw new Error(
      `task issue registry repository ${input.actual.owner}/${input.actual.repository} does not match configured repository ${input.expected.owner}/${input.expected.repository}`,
    );
  }
}

function safeRepositoryPath(value: unknown, label: string): string {
  const path = requireString(value, label);
  const normalized = normalize(path);
  if (
    isAbsolute(path) ||
    normalized === ".." ||
    normalized.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    path.includes("\0")
  ) {
    throw new Error(`${label} must stay inside the repository`);
  }
  return path;
}

function parseRepository(value: unknown): ScmRepository {
  const record = asRecord(value, "task issue registry repository");
  if (record.provider !== "github") {
    throw new Error("task issue registry repository.provider must be github");
  }
  const owner = requireString(record.owner, "task issue registry repository.owner");
  const repository = requireString(
    record.repository,
    "task issue registry repository.repository",
  );
  const url = requireString(record.url, "task issue registry repository.url");
  const expectedUrl = `https://github.com/${owner}/${repository}`;
  if (url.toLowerCase() !== expectedUrl.toLowerCase()) {
    throw new Error(`task issue registry repository.url must be ${expectedUrl}`);
  }
  return { provider: "github", owner, repository, url };
}

function parseIssueUrl(input: {
  value: unknown;
  repository: ScmRepository;
  issueNumber: number;
  label: string;
}): string {
  const value = requireString(input.value, input.label);
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(value);
  if (!match) throw new Error(`${input.label} must be a canonical GitHub issue URL`);
  const target = `${match[1]}/${match[2]}`.toLowerCase();
  const configured = `${input.repository.owner}/${input.repository.repository}`.toLowerCase();
  if (target !== configured || Number.parseInt(match[3]!, 10) !== input.issueNumber) {
    throw new Error(`${input.label} does not match its configured repository and issue number`);
  }
  return value;
}

function parseBinding(
  value: unknown,
  index: number,
  repository: ScmRepository,
): TaskIssueBinding {
  const label = `task issue registry bindings[${index}]`;
  const record = asRecord(value, label);
  const taskId = requireString(record.taskId, `${label}.taskId`);
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error(`${label}.taskId must match Tnnn`);
  }
  if (!Number.isInteger(record.issueNumber) || (record.issueNumber as number) <= 0) {
    throw new Error(`${label}.issueNumber must be a positive integer`);
  }
  const issueNumber = record.issueNumber as number;
  const issueState = record.issueState;
  if (issueState !== "open" && issueState !== "closed") {
    throw new Error(`${label}.issueState must be open or closed`);
  }
  const sourceRecord = asRecord(record.source, `${label}.source`);
  const commit = requireString(sourceRecord.commit, `${label}.source.commit`);
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error(`${label}.source.commit must be a full Git commit SHA`);
  }
  const syncedAt = requireString(record.syncedAt, `${label}.syncedAt`);
  if (!Number.isFinite(Date.parse(syncedAt))) {
    throw new Error(`${label}.syncedAt must be an ISO timestamp`);
  }
  return {
    taskId,
    issueNumber,
    issueUrl: parseIssueUrl({
      value: record.issueUrl,
      repository,
      issueNumber,
      label: `${label}.issueUrl`,
    }),
    issueTitle: requireString(record.issueTitle, `${label}.issueTitle`),
    issueState,
    source: {
      commit,
      tasksPath: safeRepositoryPath(sourceRecord.tasksPath, `${label}.source.tasksPath`),
      specPath: safeRepositoryPath(sourceRecord.specPath, `${label}.source.specPath`),
      planPath: safeRepositoryPath(sourceRecord.planPath, `${label}.source.planPath`),
    },
    syncedAt,
  };
}

export function parseTaskIssueRegistry(value: unknown): TaskIssueRegistry {
  const record = asRecord(value, "task issue registry");
  if (record.schemaVersion !== TASK_ISSUE_REGISTRY_SCHEMA) {
    throw new Error(
      `task issue registry schemaVersion must be ${TASK_ISSUE_REGISTRY_SCHEMA}`,
    );
  }
  const repository = parseRepository(record.repository);
  if (!Array.isArray(record.bindings)) {
    throw new Error("task issue registry bindings must be an array");
  }
  const bindings = record.bindings.map((binding, index) =>
    parseBinding(binding, index, repository),
  );
  const seen = new Set<string>();
  const issueMetadata = new Map<
    number,
    Pick<TaskIssueBinding, "issueUrl" | "issueTitle" | "issueState">
  >();
  for (const binding of bindings) {
    if (seen.has(binding.taskId)) {
      throw new Error(`task issue registry has duplicate binding for ${binding.taskId}`);
    }
    seen.add(binding.taskId);
    const existing = issueMetadata.get(binding.issueNumber);
    if (
      existing &&
      (existing.issueUrl !== binding.issueUrl ||
        existing.issueTitle !== binding.issueTitle ||
        existing.issueState !== binding.issueState)
    ) {
      throw new Error(
        `task issue registry has inconsistent metadata for issue #${binding.issueNumber}`,
      );
    }
    issueMetadata.set(binding.issueNumber, {
      issueUrl: binding.issueUrl,
      issueTitle: binding.issueTitle,
      issueState: binding.issueState,
    });
  }
  return { schemaVersion: TASK_ISSUE_REGISTRY_SCHEMA, repository, bindings };
}

export async function readTaskIssueRegistry(
  repoPath: string,
): Promise<TaskIssueRegistry | undefined> {
  try {
    return parseTaskIssueRegistry(
      JSON.parse(await readFile(taskIssueRegistryPath(repoPath), "utf8")) as unknown,
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      throw new Error(`invalid task issue registry JSON: ${error.message}`);
    }
    throw error;
  }
}

export async function writeTaskIssueRegistry(input: {
  repoPath: string;
  repository: ScmRepository;
  bindings: TaskIssueBinding[];
}): Promise<TaskIssueRegistry> {
  const existing = await readTaskIssueRegistry(input.repoPath);
  if (existing) {
    assertTaskIssueRepository({ actual: existing.repository, expected: input.repository });
  }
  const replacements = new Set(input.bindings.map((binding) => binding.taskId));
  const refreshedIssueMetadata = new Map(
    input.bindings.map((binding) => [
      binding.issueNumber,
      {
        issueUrl: binding.issueUrl,
        issueTitle: binding.issueTitle,
        issueState: binding.issueState,
      },
    ]),
  );
  const registry = parseTaskIssueRegistry({
    schemaVersion: TASK_ISSUE_REGISTRY_SCHEMA,
    repository: input.repository,
    bindings: [
      ...(existing?.bindings ?? []).filter(
        (binding) => !replacements.has(binding.taskId),
      ).map((binding) => ({
        ...binding,
        ...(refreshedIssueMetadata.get(binding.issueNumber) ?? {}),
      })),
      ...input.bindings,
    ].sort((left, right) => left.taskId.localeCompare(right.taskId, "en")),
  });
  const path = taskIssueRegistryPath(input.repoPath);
  const directory = join(resolve(input.repoPath), ".nitely");
  const temporaryPath = join(directory, `.task-issues-${process.pid}-${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return registry;
}

export function taskIssueScope(input: {
  registry: TaskIssueRegistry | undefined;
  repository: ScmRepository;
  taskIds: string[];
}): TaskIssueScope {
  if (!input.registry) {
    return { issues: [], missingTaskIds: uniqueTaskIds(input.taskIds) };
  }
  assertTaskIssueRepository({
    actual: input.registry.repository,
    expected: input.repository,
  });
  const bindings = new Map(
    input.registry.bindings.map((binding) => [binding.taskId, binding]),
  );
  const issues = new Map<number, TaskIssueScopeLink>();
  const missingTaskIds: string[] = [];
  for (const taskId of uniqueTaskIds(input.taskIds)) {
    const binding = bindings.get(taskId);
    if (!binding) {
      missingTaskIds.push(taskId);
      continue;
    }
    const current = issues.get(binding.issueNumber);
    if (current) {
      current.taskIds.push(taskId);
      continue;
    }
    issues.set(binding.issueNumber, {
      issueNumber: binding.issueNumber,
      issueUrl: binding.issueUrl,
      issueTitle: binding.issueTitle,
      issueState: binding.issueState,
      taskIds: [taskId],
    });
  }
  return { issues: [...issues.values()], missingTaskIds };
}

function uniqueTaskIds(taskIds: string[]): string[] {
  return [...new Set(taskIds)];
}
