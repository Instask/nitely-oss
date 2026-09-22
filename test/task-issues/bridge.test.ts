import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type {
  RepositoryIssue,
  RepositoryIssueComment,
  ScmProvider,
  ScmRepository,
} from "../../src/scm/types.js";
import {
  linkTaskIssuesToRun,
  resolveTaskIssueScope,
  syncTaskIssues,
} from "../../src/task-issues/bridge.js";
import { taskIssueRegistryPath } from "../../src/task-issues/registry.js";

const execFileAsync = promisify(execFile);
const repository: ScmRepository = {
  provider: "github",
  owner: "Instask",
  repository: "nitely",
  url: "https://github.com/Instask/nitely",
};

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout;
}

async function createRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-task-issue-bridge-"));
  await git(repoPath, ["init"]);
  await git(repoPath, ["config", "user.email", "nitely@example.test"]);
  await git(repoPath, ["config", "user.name", "Nitely Test"]);
  const files = {
    "docs/tasks.md": `# Tasks

## Phase 1: Foundation

- [ ] T001 Create parser
- [ ] T002 Verify parser (depends: T001)
`,
    "docs/spec.md": "# Spec\n",
    "docs/plan.md": "# Plan\n",
  };
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(repoPath, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["commit", "-m", "planning artifacts"]);
  await git(repoPath, [
    "remote",
    "add",
    "origin",
    "git@github.com:Instask/nitely.git",
  ]);
  return repoPath;
}

function issue(number: number, title: string, body: string): RepositoryIssue {
  return {
    provider: "github",
    owner: "Instask",
    repository: "nitely",
    number,
    url: `https://github.com/Instask/nitely/issues/${number}`,
    title,
    body,
    state: "open",
  };
}

function providerState(initialIssues: RepositoryIssue[] = []) {
  const issues = [...initialIssues];
  const comments = new Map<number, RepositoryIssueComment[]>();
  const createIssueBodies: string[] = [];
  const createCommentBodies: string[] = [];
  const updateCommentBodies: string[] = [];
  const provider: ScmProvider = {
    type: "github",
    publishChange: async () => {
      throw new Error("publishChange is not used by the task issue bridge");
    },
    resolveRepository: async () => repository,
    listRepositoryIssues: async () => [...issues],
    createRepositoryIssue: async ({ title, body }) => {
      createIssueBodies.push(body);
      const created = issue(100 + issues.length, title, body);
      issues.push(created);
      return created;
    },
    listRepositoryIssueComments: async ({ issueNumber }) => [
      ...(comments.get(issueNumber) ?? []),
    ],
    createRepositoryIssueComment: async ({ issueNumber, body }) => {
      createCommentBodies.push(body);
      const created: RepositoryIssueComment = {
        provider: "github",
        id: String(200 + createCommentBodies.length),
        url: `https://github.com/Instask/nitely/issues/${issueNumber}#issuecomment-${200 + createCommentBodies.length}`,
        body,
        authorLogin: "nitely",
        createdAt: "2026-07-14T00:00:00Z",
      };
      comments.set(issueNumber, [...(comments.get(issueNumber) ?? []), created]);
      return created;
    },
    updateRepositoryIssueComment: async ({ commentId, body }) => {
      updateCommentBodies.push(body);
      for (const [issueNumber, issueComments] of comments) {
        const index = issueComments.findIndex((comment) => comment.id === commentId);
        if (index < 0) continue;
        const updated = { ...issueComments[index]!, body };
        issueComments[index] = updated;
        comments.set(issueNumber, issueComments);
        return updated;
      }
      throw new Error(`comment not found: ${commentId}`);
    },
  };
  return {
    provider,
    issues,
    comments,
    createIssueBodies,
    createCommentBodies,
    updateCommentBodies,
  };
}

describe("task issue bridge", () => {
  it("creates only missing issues, writes immutable bindings, and reuses everything on rerun", async () => {
    const repoPath = await createRepo();
    const state = providerState([issue(10, "T001: Existing parser", "")]);
    const input = {
      repoPath,
      tasksPath: "docs/tasks.md",
      specPath: "docs/spec.md",
      planPath: "docs/plan.md",
      provider: state.provider,
      now: () => new Date("2026-07-14T00:00:00Z"),
    };

    const first = await syncTaskIssues(input);
    const second = await syncTaskIssues(input);

    expect(first).toMatchObject({ created: 1, reused: 1, grouping: "task" });
    expect(second).toMatchObject({ created: 0, reused: 2, grouping: "task" });
    expect(state.createIssueBodies).toHaveLength(1);
    expect(state.createIssueBodies[0]).toContain("<!-- nitely-task-ids:v1 T002 -->");
    expect(state.createIssueBodies[0]).toMatch(
      /github\.com\/Instask\/nitely\/blob\/[0-9a-f]{40}\/docs\/tasks\.md/,
    );
    const registry = JSON.parse(
      await readFile(taskIssueRegistryPath(repoPath), "utf8"),
    ) as { bindings: Array<{ taskId: string; issueNumber: number }> };
    expect(registry.bindings).toEqual([
      expect.objectContaining({ taskId: "T001", issueNumber: 10 }),
      expect.objectContaining({ taskId: "T002", issueNumber: 101 }),
    ]);
  });

  it("aborts phase creation before any write when an existing group is partial", async () => {
    const repoPath = await createRepo();
    const state = providerState([issue(10, "T001: Existing parser", "")]);

    await expect(
      syncTaskIssues({
        repoPath,
        tasksPath: "docs/tasks.md",
        specPath: "docs/spec.md",
        planPath: "docs/plan.md",
        grouping: "phase",
        provider: state.provider,
      }),
    ).rejects.toThrow("task issue sync has conflicts");
    expect(state.createIssueBodies).toEqual([]);
  });

  it("rejects dirty source artifacts before listing or creating issues", async () => {
    const repoPath = await createRepo();
    const state = providerState();
    let listCalls = 0;
    state.provider.listRepositoryIssues = async () => {
      listCalls += 1;
      return [];
    };
    await writeFile(join(repoPath, "docs/tasks.md"), "dirty\n", "utf8");

    await expect(
      syncTaskIssues({
        repoPath,
        tasksPath: "docs/tasks.md",
        specPath: "docs/spec.md",
        planPath: "docs/plan.md",
        provider: state.provider,
      }),
    ).rejects.toThrow("must match its committed HEAD content");
    expect(listCalls).toBe(0);
  });

  it("links a grouped scope once and reuses the stable run marker", async () => {
    const repoPath = await createRepo();
    const state = providerState();
    await syncTaskIssues({
      repoPath,
      tasksPath: "docs/tasks.md",
      specPath: "docs/spec.md",
      planPath: "docs/plan.md",
      grouping: "phase",
      provider: state.provider,
    });
    const scope = await resolveTaskIssueScope({
      repoPath,
      taskIds: ["T001", "T002", "T999"],
      provider: state.provider,
    });
    const evidencePath = join(repoPath, ".nitely", "runs", "run-1", "evidence.md");
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, "evidence\n", "utf8");
    const input = {
      repoPath,
      runId: "run-1",
      status: "blocked" as const,
      evidencePath,
      scope,
      provider: state.provider,
    };

    const first = await linkTaskIssuesToRun(input);
    const second = await linkTaskIssuesToRun(input);
    const completed = await linkTaskIssuesToRun({
      ...input,
      status: "completed",
      changeRequestUrl: "https://github.com/Instask/nitely/pull/55",
    });

    expect(scope).toMatchObject({
      issues: [{ taskIds: ["T001", "T002"] }],
      missingTaskIds: ["T999"],
    });
    expect(first).toMatchObject([{ outcome: "created", taskIds: ["T001", "T002"] }]);
    expect(second).toMatchObject([{ outcome: "reused", taskIds: ["T001", "T002"] }]);
    expect(completed).toMatchObject([{ outcome: "updated", taskIds: ["T001", "T002"] }]);
    expect(state.createCommentBodies).toHaveLength(1);
    expect(state.createCommentBodies[0]).toContain("<!-- nitely-task-run:v1 ");
    expect(state.createCommentBodies[0]).toContain("`.nitely/runs/run-1/evidence.md`");
    expect(state.createCommentBodies[0]).toContain("**blocked**");
    expect(state.updateCommentBodies).toHaveLength(1);
    expect(state.updateCommentBodies[0]).toContain("**completed**");
    expect(state.updateCommentBodies[0]).toContain("https://github.com/Instask/nitely/pull/55");
  });

  it("does not expose mismatched registry bindings to evidence or comments", async () => {
    const repoPath = await createRepo();
    const state = providerState();
    await syncTaskIssues({
      repoPath,
      tasksPath: "docs/tasks.md",
      specPath: "docs/spec.md",
      planPath: "docs/plan.md",
      provider: state.provider,
    });
    state.provider.resolveRepository = async () => ({
      ...repository,
      owner: "Other",
      url: "https://github.com/Other/nitely",
    });

    const createdBeforeMismatch = state.createIssueBodies.length;
    await expect(
      syncTaskIssues({
        repoPath,
        tasksPath: "docs/tasks.md",
        specPath: "docs/spec.md",
        planPath: "docs/plan.md",
        provider: state.provider,
      }),
    ).rejects.toThrow("does not match configured repository");
    expect(state.createIssueBodies).toHaveLength(createdBeforeMismatch);

    const scope = await resolveTaskIssueScope({
      repoPath,
      taskIds: ["T001"],
      provider: state.provider,
    });

    expect(scope.issues).toEqual([]);
    expect(scope.registryError).toContain("does not match configured repository");
    expect(state.createCommentBodies).toEqual([]);
  });
});
