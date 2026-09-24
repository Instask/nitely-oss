import { createHash, createHmac } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  GitHubWebhookIntake,
  getGitHubWebhookDelivery,
  githubWebhookConfigurationFromEnv,
  type GitHubWebhookConfiguration,
  type GitHubWebhookStatusUpdate,
} from "../../src/github-webhooks/intake.js";
import {
  createTask,
  getTask,
  listTasks,
  taskSourceInputUri,
  updateTaskRunState,
} from "../../src/web/tasks.js";
import { listTaskReworkRequests } from "../../src/web/task-rework-requests.js";

const secret = "webhook-secret-for-tests";
const now = new Date("2026-07-16T04:00:00.000Z");

function issuePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action: "labeled",
    installation: { id: 123 },
    repository: {
      id: 101,
      full_name: "acme/widgets",
      html_url: "https://github.com/acme/widgets",
    },
    sender: { id: 501, login: "alice" },
    label: { name: "nitely" },
    issue: {
      number: 7,
      html_url: "https://github.com/acme/widgets/issues/7",
      title: "Make imports resumable",
      body: "Persist the import cursor and resume after a restart.",
      state: "open",
      updated_at: "2026-07-16T03:59:30.000Z",
      user: { login: "reporter" },
      assignees: [{ login: "maintainer" }],
      labels: [{ name: "nitely" }, { name: "priority:P1" }],
    },
    ...overrides,
  };
}

function issueCommentPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action: "created",
    installation: { id: 123 },
    repository: {
      id: 101,
      full_name: "acme/widgets",
      html_url: "https://github.com/acme/widgets",
    },
    sender: { id: 501, login: "alice" },
    issue: {
      ...(issuePayload().issue as Record<string, unknown>),
    },
    comment: {
      id: 9001,
      html_url: "https://github.com/acme/widgets/issues/7#issuecomment-9001",
      body: "@nitely please turn this into a governed task",
      user: { login: "alice" },
      created_at: "2026-07-16T03:59:45.000Z",
      updated_at: "2026-07-16T03:59:45.000Z",
    },
    ...overrides,
  };
}

function pullRequestReviewCommentPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action: "created",
    installation: { id: 123 },
    repository: {
      id: 101,
      full_name: "acme/widgets",
      html_url: "https://github.com/acme/widgets",
    },
    sender: { id: 501, login: "alice" },
    pull_request: {
      number: 9,
      html_url: "https://github.com/acme/widgets/pull/9",
      updated_at: "2026-07-16T03:59:40.000Z",
      base: { ref: "main" },
      head: {
        ref: "nitely/run-9",
        sha: "abc1234def5678abc1234def5678abc1234def56",
        repo: { full_name: "acme/widgets" },
      },
      draft: true,
    },
    comment: {
      id: 100,
      html_url: "https://github.com/acme/widgets/pull/9#discussion_r100",
      body: "@nitely rework add a regression test for this branch",
      user: { login: "alice" },
      author_association: "MEMBER",
      created_at: "2026-07-16T03:59:50.000Z",
      updated_at: "2026-07-16T03:59:50.000Z",
      path: "src/app.ts",
      line: 42,
    },
    ...overrides,
  };
}

function signedDelivery(input: {
  deliveryId?: string;
  event?: string;
  payload?: Record<string, unknown>;
  signingSecret?: string;
}) {
  const body = Buffer.from(JSON.stringify(input.payload ?? issuePayload()), "utf8");
  return {
    deliveryId: input.deliveryId ?? "delivery-426-1",
    event: input.event ?? "issues",
    body,
    signature: `sha256=${createHmac("sha256", input.signingSecret ?? secret)
      .update(body)
      .digest("hex")}`,
  };
}

async function createRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-github-webhook-"));
  await mkdir(join(repoPath, "flows"), { recursive: true });
  await writeFile(
    join(repoPath, "flows/implement-spec-bootstrap.json"),
    JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "implement-spec-bootstrap" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement the approved specification.",
            inputs: ["spec", "tech-design"],
            outputs: ["implementation"],
          },
        ],
      },
    }),
    "utf8",
  );
  return repoPath;
}

function configuration(
  overrides: Partial<GitHubWebhookConfiguration> = {},
): GitHubWebhookConfiguration {
  return {
    secret,
    repositories: [
      { fullName: "acme/widgets", repositoryId: "default" },
    ],
    allowedActors: ["alice"],
    allowedInstallationIds: [123],
    triggerLabels: ["nitely"],
    flowPath: "flows/implement-spec-bootstrap.json",
    maxDeliveryAgeMs: 5 * 60_000,
    now: () => now,
    ...overrides,
  };
}

function intake(
  stateRepoPath: string,
  targetRepoPath = stateRepoPath,
  overrides: Partial<GitHubWebhookConfiguration> = {},
  intakeOptions: {
    leaseDurationMs?: number;
    createLeaseOwnerId?: () => string;
  } = {},
) {
  return new GitHubWebhookIntake({
    stateRepoPath,
    configuration: configuration(overrides),
    resolveRepository: async (repositoryId) => {
      if (repositoryId !== "default") return undefined;
      return { id: "default", path: targetRepoPath };
    },
    ...intakeOptions,
  });
}

async function deliveryDirectoryEntries(repoPath: string): Promise<string[]> {
  try {
    return await readdir(join(repoPath, ".nitely/github-webhooks/deliveries"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function deliveryTaskId(deliveryId: string): string {
  return `github-delivery-${createHash("sha256")
    .update(deliveryId)
    .digest("hex")
    .slice(0, 24)}`;
}

describe("GitHub webhook intake", () => {
  it("rejects an invalid signature without reserving the delivery id", async () => {
    const repoPath = await createRepo();
    const service = intake(repoPath);

    await expect(
      service.accept(
        signedDelivery({
          deliveryId: "invalid-signature",
          signingSecret: "wrong-secret",
        }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_signature",
      status: 401,
    });
    await expect(deliveryDirectoryEntries(repoPath)).resolves.toEqual([]);
  });

  it("authenticates the exact body before validating untrusted headers", async () => {
    const repoPath = await createRepo();
    const service = intake(repoPath);
    const delivery = signedDelivery({
      deliveryId: "../invalid-delivery-id",
      signingSecret: "wrong-secret",
    });

    await expect(
      service.accept({ ...delivery, event: "" }),
    ).rejects.toMatchObject({
      code: "invalid_signature",
      status: 401,
    });
    await expect(deliveryDirectoryEntries(repoPath)).resolves.toEqual([]);
  });

  it.each([".nitely", ".nitely/github-webhooks/deliveries"])(
    "does not enqueue through a symbolic-link %s directory",
    async (linkedDirectory) => {
      const repoPath = await createRepo();
      const outsidePath = await mkdtemp(
        join(tmpdir(), "nitely-github-webhook-outside-"),
      );
      const parent = join(repoPath, linkedDirectory, "..");
      await mkdir(parent, { recursive: true });
      await symlink(outsidePath, join(repoPath, linkedDirectory));
      const service = intake(repoPath);

      await expect(
        service.accept(
          signedDelivery({ deliveryId: `symlink-${linkedDirectory.length}` }),
        ),
      ).rejects.toThrow(/symbolic link|unsafe|not a directory/i);
      await expect(readdir(outsidePath)).resolves.toEqual([]);
    },
  );

  it("does not read a delivery record through a symbolic link", async () => {
    const repoPath = await createRepo();
    const outsidePath = await mkdtemp(
      join(tmpdir(), "nitely-github-webhook-record-outside-"),
    );
    const delivery = signedDelivery({ deliveryId: "symlinked-record" });
    const outsideRecord = join(outsidePath, "record.json");
    await writeFile(
      outsideRecord,
      JSON.stringify({
        schemaVersion: 1,
        deliveryId: delivery.deliveryId,
        event: delivery.event,
        bodySha256: createHash("sha256").update(delivery.body).digest("hex"),
        receivedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        state: "queued",
      }),
      "utf8",
    );
    const deliveriesPath = join(
      repoPath,
      ".nitely/github-webhooks/deliveries",
    );
    await mkdir(deliveriesPath, { recursive: true });
    await symlink(outsideRecord, join(deliveriesPath, "symlinked-record.json"));
    const before = await readFile(outsideRecord, "utf8");

    await expect(intake(repoPath).accept(delivery)).rejects.toThrow(
      /symbolic link|unsafe/i,
    );
    await expect(readFile(outsideRecord, "utf8")).resolves.toBe(before);
  });

  it("does not create a deterministic task through a symbolic link", async () => {
    const repoPath = await createRepo();
    const deliveryId = "symlinked-task";
    const service = intake(repoPath);
    await service.accept(signedDelivery({ deliveryId }));
    const taskId = deliveryTaskId(deliveryId);
    const outsidePath = await mkdtemp(
      join(tmpdir(), "nitely-github-webhook-task-outside-"),
    );
    const tasksPath = join(repoPath, ".nitely", "tasks");
    await mkdir(tasksPath, { recursive: true });
    await symlink(outsidePath, join(tasksPath, taskId));

    await service.drain();

    await expect(
      getGitHubWebhookDelivery(repoPath, deliveryId),
    ).resolves.toMatchObject({
      state: "failed",
      failure: { code: "processing_failed" },
    });
    await expect(readdir(outsidePath)).resolves.toEqual([]);
  });

  it("rejects a stale supported delivery", async () => {
    const repoPath = await createRepo();
    const service = intake(repoPath);
    const payload = issuePayload({
      issue: {
        ...(issuePayload().issue as Record<string, unknown>),
        updated_at: "2026-07-16T03:40:00.000Z",
      },
    });

    await expect(
      service.accept(signedDelivery({ deliveryId: "stale", payload })),
    ).rejects.toMatchObject({
      code: "stale_delivery",
      status: 400,
    });
    await expect(deliveryDirectoryEntries(repoPath)).resolves.toEqual([]);
  });

  it("durably deduplicates a redelivery after service restart", async () => {
    const repoPath = await createRepo();
    const delivery = signedDelivery({ deliveryId: "restart-duplicate" });
    const firstService = intake(repoPath);

    await expect(firstService.accept(delivery)).resolves.toMatchObject({
      status: 202,
      accepted: true,
      duplicate: false,
    });
    await firstService.drain();

    const restartedService = intake(repoPath, repoPath, {
      now: () => new Date("2026-07-16T05:00:00.000Z"),
    });
    await expect(restartedService.accept(delivery)).resolves.toMatchObject({
      status: 202,
      accepted: true,
      duplicate: true,
    });
    await restartedService.drain();

    await expect(listTasks(repoPath)).resolves.toHaveLength(1);
    await expect(
      getGitHubWebhookDelivery(repoPath, "restart-duplicate"),
    ).resolves.toMatchObject({
      state: "completed",
      taskId: expect.stringMatching(/^github-delivery-/),
    });
  });

  it("atomically accepts concurrent redelivery without exposing a partial record", async () => {
    const repoPath = await createRepo();
    const service = intake(repoPath);
    const delivery = signedDelivery({ deliveryId: "concurrent-duplicate" });

    const results = await Promise.all(
      Array.from({ length: 25 }, () => service.accept(delivery)),
    );

    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(results.filter((result) => result.duplicate)).toHaveLength(24);
    expect(results.every((result) => result.accepted)).toBe(true);
    await expect(
      getGitHubWebhookDelivery(repoPath, "concurrent-duplicate"),
    ).resolves.toMatchObject({ state: "queued" });
  });

  it("atomically rejects concurrent reuse of one delivery id for another event", async () => {
    const repoPath = await createRepo();
    const service = intake(repoPath);
    const delivery = signedDelivery({ deliveryId: "concurrent-event-collision" });

    const results = await Promise.allSettled([
      service.accept(delivery),
      service.accept({ ...delivery, event: "ping" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejection?.reason).toMatchObject({
      code: "delivery_id_collision",
      status: 409,
    });
    await expect(
      getGitHubWebhookDelivery(repoPath, "concurrent-event-collision"),
    ).resolves.toMatchObject({
      event: expect.stringMatching(/^(issues|ping)$/),
    });
  });

  it("rejects reuse of a delivery id with a different signed payload", async () => {
    const repoPath = await createRepo();
    const service = intake(repoPath);
    await service.accept(signedDelivery({ deliveryId: "collision" }));
    const changed = issuePayload({
      issue: {
        ...(issuePayload().issue as Record<string, unknown>),
        title: "A different request",
      },
    });

    await expect(
      service.accept(
        signedDelivery({ deliveryId: "collision", payload: changed }),
      ),
    ).rejects.toMatchObject({
      code: "delivery_id_collision",
      status: 409,
    });
    await expect(
      getGitHubWebhookDelivery(repoPath, "collision"),
    ).resolves.toMatchObject({
      request: { source: { snapshot: { title: "Make imports resumable" } } },
    });
  });

  it("reclaims an interrupted processing record after restart", async () => {
    const repoPath = await createRepo();
    const firstService = intake(repoPath);
    await firstService.accept(signedDelivery({ deliveryId: "interrupted" }));
    const record = await getGitHubWebhookDelivery(repoPath, "interrupted");
    await writeFile(
      join(
        repoPath,
        ".nitely/github-webhooks/deliveries/interrupted.json",
      ),
      JSON.stringify({ ...record, state: "processing" }, null, 2),
      "utf8",
    );

    const restartedService = intake(repoPath);
    await restartedService.drain();

    await expect(listTasks(repoPath)).resolves.toHaveLength(1);
    await expect(
      getGitHubWebhookDelivery(repoPath, "interrupted"),
    ).resolves.toMatchObject({ state: "completed" });
  });

  it("durably ignores an authenticated unsupported event", async () => {
    const repoPath = await createRepo();
    const service = intake(repoPath);
    const delivery = signedDelivery({
      deliveryId: "unsupported-ping",
      event: "ping",
      payload: { zen: "Keep it logically awesome." },
    });

    await expect(service.accept(delivery)).resolves.toEqual({
      status: 202,
      accepted: false,
      duplicate: false,
      deliveryId: "unsupported-ping",
      state: "ignored",
      reason: "unsupported_event",
    });
    await expect(
      getGitHubWebhookDelivery(repoPath, "unsupported-ping"),
    ).resolves.toMatchObject({
      state: "ignored",
      reason: "unsupported_event",
    });
    await expect(listTasks(repoPath)).resolves.toEqual([]);
  });

  it.each([
    {
      name: "repository",
      payload: issuePayload({
        repository: {
          id: 999,
          full_name: "other/repository",
          html_url: "https://github.com/other/repository",
        },
        issue: {
          ...(issuePayload().issue as Record<string, unknown>),
          html_url: "https://github.com/other/repository/issues/7",
        },
      }),
      reason: "repository_denied",
    },
    {
      name: "actor",
      payload: issuePayload({ sender: { id: 502, login: "mallory" } }),
      reason: "actor_denied",
    },
    {
      name: "installation",
      payload: issuePayload({ installation: { id: 999 } }),
      reason: "installation_denied",
    },
  ])("denies a supported event from an unapproved $name", async ({ payload, reason }) => {
    const repoPath = await createRepo();
    const service = intake(repoPath);
    const deliveryId = `denied-${reason}`;

    await expect(
      service.accept(signedDelivery({ deliveryId, payload })),
    ).rejects.toMatchObject({ code: reason, status: 403 });
    await expect(
      getGitHubWebhookDelivery(repoPath, deliveryId),
    ).resolves.toMatchObject({ state: "denied", reason });
    await expect(listTasks(repoPath)).resolves.toEqual([]);
  });

  it("normalizes one label event with immutable source provenance", async () => {
    const repoPath = await createRepo();
    const service = intake(repoPath);

    await service.accept(signedDelivery({ deliveryId: "normalized" }));

    const record = await getGitHubWebhookDelivery(repoPath, "normalized");
    expect(record).toMatchObject({
      schemaVersion: 1,
      state: "queued",
      bodySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      request: {
        apiVersion: "nitely.dev/github-webhook/v1",
        kind: "ExecutionRequest",
        idempotencyKey: "github:delivery:normalized",
        provider: "github",
        event: "issues",
        action: "labeled",
        deliveryId: "normalized",
        receivedAt: now.toISOString(),
        eventAt: "2026-07-16T03:59:30.000Z",
        installationId: 123,
        repository: {
          id: 101,
          fullName: "acme/widgets",
          url: "https://github.com/acme/widgets",
          nitelyRepositoryId: "default",
        },
        actor: { id: 501, login: "alice" },
        source: {
          number: 7,
          url: "https://github.com/acme/widgets/issues/7",
          snapshot: {
            externalId: "acme/widgets#7",
            title: "Make imports resumable",
            author: "reporter",
            assignees: ["maintainer"],
            labels: ["nitely", "priority:P1"],
          },
          snapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        requestedFlow: "flows/implement-spec-bootstrap.json",
      },
    });
    expect(JSON.stringify(record)).not.toContain(secret);
  });

  it("accepts configured issue assignment activations", async () => {
    const repoPath = await createRepo();
    const service = intake(repoPath, repoPath, {
      triggerAssignees: ["nitely[bot]"],
    });
    const payload = issuePayload({
      action: "assigned",
      assignee: { login: "nitely[bot]" },
    });

    await expect(
      service.accept(
        signedDelivery({
          deliveryId: "assigned-activation",
          event: "issues",
          payload,
        }),
      ),
    ).resolves.toMatchObject({ accepted: true, state: "queued" });
    await service.drain();

    const record = await getGitHubWebhookDelivery(repoPath, "assigned-activation");
    expect(record).toMatchObject({
      state: "completed",
      request: {
        kind: "ExecutionRequest",
        event: "issues",
        action: "assigned",
      },
    });
    const task = await getTask(repoPath, record.taskId!);
    expect(task.source?.intake).toMatchObject({
      event: "issues",
      action: "assigned",
      deliveryId: "assigned-activation",
    });
  });

  it("accepts configured issue mention activations and preserves the trigger comment in the source snapshot", async () => {
    const repoPath = await createRepo();
    const service = intake(repoPath, repoPath, {
      triggerMentions: ["nitely"],
    });

    await expect(
      service.accept(
        signedDelivery({
          deliveryId: "issue-mention",
          event: "issue_comment",
          payload: issueCommentPayload(),
        }),
      ),
    ).resolves.toMatchObject({ accepted: true, state: "queued" });
    await service.drain();

    const record = await getGitHubWebhookDelivery(repoPath, "issue-mention");
    expect(record).toMatchObject({
      state: "completed",
      request: {
        kind: "ExecutionRequest",
        event: "issue_comment",
        action: "created",
      },
    });
    const task = await getTask(repoPath, record.taskId!);
    expect(task.source?.snapshot?.comments).toEqual([
      expect.objectContaining({
        author: "alice",
        body: "@nitely please turn this into a governed task",
      }),
    ]);
    expect(task.source?.intake).toMatchObject({
      event: "issue_comment",
      action: "created",
    });
  });

  it("creates a pending same-PR task rework request from a configured PR review comment", async () => {
    const repoPath = await createRepo();
    const task = await createTask(
      repoPath,
      {
        title: "Completed PR task",
        spec: "# Spec\n\nApproved.",
        techDesign: "# Design\n\nApproved.",
        repoId: "default",
        flowPath: "flows/implement-spec-bootstrap.json",
      },
      {
        createId: () => "task-pr-9",
        repoId: "default",
        initialStatus: "ready",
        specStatus: "approved",
        techDesignStatus: "approved",
      },
    );
    await updateTaskRunState(repoPath, task.id, {
      status: "completed",
      latestRunId: "run-pr-9",
      changeRequestUrl: "https://github.com/acme/widgets/pull/9",
    });
    const updates: GitHubWebhookStatusUpdate[] = [];
    const service = intake(repoPath, repoPath, {
      triggerMentions: ["nitely"],
      statusPublisher: async (update) => {
        updates.push(update);
      },
    });

    await expect(
      service.accept(
        signedDelivery({
          deliveryId: "pr-review-rework",
          event: "pull_request_review_comment",
          payload: pullRequestReviewCommentPayload(),
        }),
      ),
    ).resolves.toMatchObject({ accepted: true, state: "queued" });
    await service.drain();

    const record = await getGitHubWebhookDelivery(repoPath, "pr-review-rework");
    expect(record).toMatchObject({
      state: "completed",
      taskId: task.id,
      reworkRequestId: expect.stringMatching(/^tcr_/),
      request: {
        kind: "ReworkRequest",
        event: "pull_request_review_comment",
        action: "created",
        pullRequest: {
          number: 9,
          headBranch: "nitely/run-9",
        },
        feedback: {
          action: "rework",
          instruction: "add a regression test for this branch",
        },
      },
    });
    const requests = await listTaskReworkRequests(repoPath, task.id);
    expect(requests).toEqual([
      expect.objectContaining({
        id: record.reworkRequestId,
        taskId: task.id,
        status: "pending_confirmation",
        instruction: "add a regression test for this branch",
        priorRunId: "run-pr-9",
        changeRequest: expect.objectContaining({
          url: "https://github.com/acme/widgets/pull/9",
          headBranch: "nitely/run-9",
        }),
      }),
    ]);
    expect(updates).toEqual([
      {
        state: "rework-request-created",
        deliveryId: "pr-review-rework",
        installationId: 123,
        repositoryId: 101,
        repositoryFullName: "acme/widgets",
        pullRequestNumber: 9,
        headSha: "abc1234def5678abc1234def5678abc1234def56",
        sourceUrl: "https://github.com/acme/widgets/pull/9#discussion_r100",
        taskId: task.id,
        reworkRequestId: record.reworkRequestId!,
        reworkRequestPath:
          `/tasks/${encodeURIComponent(task.id)}/rework-requests/${encodeURIComponent(record.reworkRequestId!)}`,
      },
    ]);
    expect(JSON.stringify(updates)).not.toContain("regression test");
  });

  it.each([
    {
      name: "sender login",
      deliveryId: "oversized-sender",
      payload: issuePayload({
        sender: { id: 501, login: "a".repeat(101) },
      }),
    },
    {
      name: "repository owner",
      deliveryId: "oversized-repository",
      payload: issuePayload({
        repository: {
          id: 101,
          full_name: `${"a".repeat(40)}/widgets`,
          html_url: `https://github.com/${"a".repeat(40)}/widgets`,
        },
        issue: {
          ...(issuePayload().issue as Record<string, unknown>),
          html_url: `https://github.com/${"a".repeat(40)}/widgets/issues/7`,
        },
      }),
    },
  ])(
    "rejects an oversized signed $name before persistence or publication",
    async ({ deliveryId, payload }) => {
      const repoPath = await createRepo();
      const updates: GitHubWebhookStatusUpdate[] = [];
      const service = intake(repoPath, repoPath, {
        statusPublisher: async (update) => {
          updates.push(update);
        },
      });

      await expect(
        service.accept(signedDelivery({ deliveryId, payload })),
      ).rejects.toMatchObject({
        code: "invalid_payload",
        status: 400,
      });
      await expect(deliveryDirectoryEntries(repoPath)).resolves.toEqual([]);
      expect(updates).toEqual([]);
    },
  );

  it("creates one approval-gated task and emits only a bounded status update", async () => {
    const repoPath = await createRepo();
    const updates: GitHubWebhookStatusUpdate[] = [];
    const service = intake(repoPath, repoPath, {
      statusPublisher: async (update) => {
        updates.push(update);
      },
    });

    await service.accept(signedDelivery({ deliveryId: "successful-intake" }));
    await service.drain();

    const record = await getGitHubWebhookDelivery(repoPath, "successful-intake");
    expect(record).toMatchObject({ state: "completed" });
    const task = await getTask(repoPath, record.taskId!);
    expect(task).toMatchObject({
      status: "draft",
      specStatus: "draft",
      techDesignStatus: "draft",
      issueUrl: "https://github.com/acme/widgets/issues/7",
      flowPath: "flows/implement-spec-bootstrap.json",
      source: {
        type: "github-issue",
        uri: "https://github.com/acme/widgets/issues/7",
        externalId: "acme/widgets#7",
        snapshot: {
          title: "Make imports resumable",
          body: "Persist the import cursor and resume after a restart.",
        },
        intake: {
          type: "github-webhook",
          deliveryId: "successful-intake",
          installationId: 123,
          repositoryFullName: "acme/widgets",
          actorLogin: "alice",
          event: "issues",
          action: "labeled",
          requestedFlow: "flows/implement-spec-bootstrap.json",
          snapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
    expect(updates).toEqual([
      {
        state: "task-created",
        deliveryId: "successful-intake",
        installationId: 123,
        repositoryId: 101,
        repositoryFullName: "acme/widgets",
        issueNumber: 7,
        sourceUrl: "https://github.com/acme/widgets/issues/7",
        taskId: task.id,
        taskPath: `/tasks/${encodeURIComponent(task.id)}`,
      },
    ]);
    expect(JSON.stringify(updates)).not.toContain("Persist the import cursor");
    expect(JSON.stringify(updates).length).toBeLessThan(1_000);
  });

  it("fails closed when a delivery-derived task id already has different lineage", async () => {
    const repoPath = await createRepo();
    const deliveryId = "lineage-collision";
    const taskId = deliveryTaskId(deliveryId);
    const alternateFlowPath = "flows/alternate.json";
    await writeFile(
      join(repoPath, alternateFlowPath),
      JSON.stringify({
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "alternate" },
        spec: {
          stages: [
            {
              id: "alternate",
              type: "agent",
              runtime: "mock",
              prompt: "Do unrelated work.",
              inputs: ["spec", "tech-design"],
              outputs: ["implementation"],
            },
          ],
        },
      }),
      "utf8",
    );
    await createTask(
      repoPath,
      {
        title: "Make imports resumable",
        spec: "# Unrelated specification",
        techDesign: "# Unrelated technical design",
        repoId: "wrong-repository",
        issueUrl: "https://github.com/acme/widgets/issues/7",
        flowPath: alternateFlowPath,
      },
      {
        createId: () => taskId,
        repoId: "wrong-repository",
        initialStatus: "draft",
        specStatus: "draft",
        techDesignStatus: "draft",
        source: {
          type: "github-issue",
          uri: "https://github.com/acme/widgets/issues/7",
          externalId: "acme/widgets#7",
          title: "Make imports resumable",
          snapshot: {
            uri: "https://github.com/acme/widgets/issues/7",
            externalId: "acme/widgets#7",
            title: "Make imports resumable",
            body: "Tampered source snapshot.",
            fetchedAt: now.toISOString(),
          },
          drift: {
            status: "unchanged",
            checkedAt: now.toISOString(),
            changedFields: [],
          },
          intake: {
            type: "github-webhook",
            deliveryId: "different-delivery",
            installationId: 999,
            repositoryId: 999,
            repositoryFullName: "acme/widgets",
            actorLogin: "alice",
            event: "issues",
            action: "labeled",
            receivedAt: now.toISOString(),
            eventAt: now.toISOString(),
            requestedFlow: alternateFlowPath,
            snapshotSha256: "0".repeat(64),
          },
        },
      },
    );
    const updates: GitHubWebhookStatusUpdate[] = [];
    const service = intake(repoPath, repoPath, {
      statusPublisher: async (update) => {
        updates.push(update);
      },
    });

    await service.accept(signedDelivery({ deliveryId }));
    await service.drain();

    await expect(
      getGitHubWebhookDelivery(repoPath, deliveryId),
    ).resolves.toMatchObject({
      state: "failed",
      failure: { code: "processing_failed" },
    });
    await expect(listTasks(repoPath)).resolves.toHaveLength(1);
    expect(updates).toEqual([
      expect.objectContaining({
        state: "failed",
        deliveryId,
        failureCode: "processing_failed",
      }),
    ]);
  });

  it("reuses a pre-upgrade draft task whose stored repoId is the legacy default, for the home target only", async () => {
    const repoPath = await createRepo();
    const deliveryId = "home-alias-lineage";
    const deliveryRecordPath = join(
      repoPath,
      ".nitely/github-webhooks/deliveries",
      `${deliveryId}.json`,
    );

    // Create the draft through a first delivery whose resolved target is the
    // home repository.
    const homeService = new GitHubWebhookIntake({
      stateRepoPath: repoPath,
      configuration: configuration({
        repositories: [{ fullName: "acme/widgets", repositoryId: "home" }],
      }),
      resolveRepository: async () => ({ id: "home", path: repoPath, home: true }),
    });
    await homeService.accept(signedDelivery({ deliveryId }));
    await homeService.drain();
    const created = await getGitHubWebhookDelivery(repoPath, deliveryId);
    expect(created).toMatchObject({ state: "completed" });
    const taskId = created.taskId!;
    await expect(getTask(repoPath, taskId)).resolves.toMatchObject({
      repoId: "home",
    });

    // Simulate a pre-upgrade install: the stored task still carries the
    // retired implicit `default` repository id.
    const taskJsonPath = join(repoPath, ".nitely/tasks", taskId, "task.json");
    const stored = JSON.parse(await readFile(taskJsonPath, "utf8")) as Record<
      string,
      unknown
    >;
    stored.repoId = "default";
    await writeFile(taskJsonPath, JSON.stringify(stored, null, 2), "utf8");
    // Drop the delivery record so the next delivery for this id reprocesses
    // instead of returning the cached acceptance.
    await rm(deliveryRecordPath);

    // Deliver a second event for the same issue against the home target: the
    // legacy `default` repoId must still be recognized as this task's
    // lineage because the target is the home checkout.
    await homeService.accept(signedDelivery({ deliveryId }));
    await homeService.drain();
    const reused = await getGitHubWebhookDelivery(repoPath, deliveryId);
    expect(reused).toMatchObject({ state: "completed", taskId });
    await expect(listTasks(repoPath)).resolves.toHaveLength(1);

    // The same stored `repoId: "default"` must NOT be treated as a lineage
    // match for a target that is not the home checkout: the alias is scoped
    // to the home target only.
    const otherRepoPath = await createRepo();
    const otherDeliveryId = "non-home-alias-lineage";
    const otherDeliveryRecordPath = join(
      otherRepoPath,
      ".nitely/github-webhooks/deliveries",
      `${otherDeliveryId}.json`,
    );
    const widgetsService = new GitHubWebhookIntake({
      stateRepoPath: otherRepoPath,
      configuration: configuration({
        repositories: [{ fullName: "acme/widgets", repositoryId: "widgets" }],
      }),
      resolveRepository: async () => ({ id: "widgets", path: otherRepoPath }),
    });
    await widgetsService.accept(signedDelivery({ deliveryId: otherDeliveryId }));
    await widgetsService.drain();
    const otherCreated = await getGitHubWebhookDelivery(
      otherRepoPath,
      otherDeliveryId,
    );
    expect(otherCreated).toMatchObject({ state: "completed" });
    const otherTaskId = otherCreated.taskId!;
    const otherTaskJsonPath = join(
      otherRepoPath,
      ".nitely/tasks",
      otherTaskId,
      "task.json",
    );
    const otherStored = JSON.parse(
      await readFile(otherTaskJsonPath, "utf8"),
    ) as Record<string, unknown>;
    otherStored.repoId = "default";
    await writeFile(
      otherTaskJsonPath,
      JSON.stringify(otherStored, null, 2),
      "utf8",
    );
    await rm(otherDeliveryRecordPath);

    await widgetsService.accept(signedDelivery({ deliveryId: otherDeliveryId }));
    await widgetsService.drain();
    await expect(
      getGitHubWebhookDelivery(otherRepoPath, otherDeliveryId),
    ).resolves.toMatchObject({
      state: "failed",
      failure: { code: "processing_failed" },
    });
    await expect(listTasks(otherRepoPath)).resolves.toHaveLength(1);
  });

  it("fails closed when repository resolution crosses the configured mapping", async () => {
    const repoPath = await createRepo();
    const service = new GitHubWebhookIntake({
      stateRepoPath: repoPath,
      configuration: configuration(),
      resolveRepository: async () => ({ id: "wrong-repository", path: repoPath }),
    });

    await service.accept(
      signedDelivery({ deliveryId: "repository-resolution-mismatch" }),
    );
    await service.drain();

    await expect(
      getGitHubWebhookDelivery(repoPath, "repository-resolution-mismatch"),
    ).resolves.toMatchObject({
      state: "failed",
      failure: { code: "processing_failed" },
    });
    await expect(listTasks(repoPath)).resolves.toEqual([]);
  });

  it("fails closed when a queued source no longer matches its fingerprint", async () => {
    const repoPath = await createRepo();
    const deliveryId = "snapshot-fingerprint-mismatch";
    const firstService = intake(repoPath);
    await firstService.accept(signedDelivery({ deliveryId }));
    const queued = await getGitHubWebhookDelivery(repoPath, deliveryId);
    const request = queued.request!;
    if (request.kind !== "ExecutionRequest") {
      throw new Error("expected execution request");
    }
    await writeFile(
      join(
        repoPath,
        `.nitely/github-webhooks/deliveries/${deliveryId}.json`,
      ),
      JSON.stringify(
        {
          ...queued,
          request: {
            ...request,
            source: {
              ...request.source,
              snapshot: {
                ...request.source.snapshot,
                body: "Tampered after durable intake.",
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const restartedService = intake(repoPath);
    await restartedService.drain();

    await expect(
      getGitHubWebhookDelivery(repoPath, deliveryId),
    ).resolves.toMatchObject({
      state: "failed",
      failure: { code: "processing_failed" },
    });
    await expect(listTasks(repoPath)).resolves.toEqual([]);
  });

  it("repairs execution input materialization when resuming a valid task", async () => {
    const repoPath = await createRepo();
    const deliveryId = "partial-materialization";
    const firstService = intake(repoPath);
    await firstService.accept(signedDelivery({ deliveryId }));
    await firstService.drain();
    const completed = await getGitHubWebhookDelivery(repoPath, deliveryId);
    const task = await getTask(repoPath, completed.taskId!);
    const sourcePath = join(repoPath, taskSourceInputUri(task));
    await rm(sourcePath);
    await writeFile(
      join(
        repoPath,
        `.nitely/github-webhooks/deliveries/${deliveryId}.json`,
      ),
      JSON.stringify({ ...completed, state: "processing" }, null, 2),
      "utf8",
    );

    const restartedService = intake(repoPath);
    await restartedService.drain();

    await expect(
      getGitHubWebhookDelivery(repoPath, deliveryId),
    ).resolves.toMatchObject({ state: "completed", taskId: task.id });
    expect(JSON.parse(await readFile(sourcePath, "utf8"))).toEqual(task.source);
  });

  it("creates a reviewable draft when a GitHub issue has an empty body", async () => {
    const repoPath = await createRepo();
    const service = intake(repoPath);
    const payload = issuePayload({
      issue: {
        ...(issuePayload().issue as Record<string, unknown>),
        body: "",
      },
    });

    await service.accept(
      signedDelivery({ deliveryId: "empty-issue-body", payload }),
    );
    await service.drain();

    const record = await getGitHubWebhookDelivery(repoPath, "empty-issue-body");
    expect(record).toMatchObject({ state: "completed" });
    const task = await getTask(repoPath, record.taskId!);
    expect(task.source?.snapshot?.body).toBe("");
    await expect(readFile(join(repoPath, task.specPath), "utf8")).resolves.toContain(
      "Make imports resumable",
    );
  });

  it("keeps a created task authoritative when status publication fails", async () => {
    const repoPath = await createRepo();
    const service = intake(repoPath, repoPath, {
      statusPublisher: async () => {
        throw new Error("credential=should-not-be-persisted");
      },
    });

    await service.accept(signedDelivery({ deliveryId: "callback-failure" }));
    await service.drain();

    const record = await getGitHubWebhookDelivery(repoPath, "callback-failure");
    expect(record).toMatchObject({
      state: "completed",
      taskId: expect.stringMatching(/^github-delivery-/),
      callback: {
        state: "failed",
        failureCode: "status_publish_failed",
      },
    });
    expect(JSON.stringify(record)).not.toContain("should-not-be-persisted");
    await expect(listTasks(repoPath)).resolves.toHaveLength(1);
  });

  it("retries a durably recorded callback failure after restart", async () => {
    const repoPath = await createRepo();
    const deliveryId = "callback-retry";
    const firstService = intake(repoPath, repoPath, {
      statusPublisher: async () => {
        throw new Error("temporary provider failure");
      },
    });
    await firstService.accept(signedDelivery({ deliveryId }));
    await firstService.drain();
    await expect(
      getGitHubWebhookDelivery(repoPath, deliveryId),
    ).resolves.toMatchObject({
      state: "completed",
      callback: {
        state: "failed",
        failureCode: "status_publish_failed",
        attempts: 1,
      },
    });

    const retried: GitHubWebhookStatusUpdate[] = [];
    const restartedService = intake(repoPath, repoPath, {
      statusPublisher: async (update) => {
        retried.push(update);
      },
    });
    await restartedService.drain();

    expect(retried).toEqual([
      expect.objectContaining({
        state: "task-created",
        deliveryId,
      }),
    ]);
    await expect(
      getGitHubWebhookDelivery(repoPath, deliveryId),
    ).resolves.toMatchObject({
      state: "completed",
      callback: { state: "succeeded", attempts: 2 },
    });
  });

  it("persists publisher external ids and passes them back on callback retry", async () => {
    const repoPath = await createRepo();
    const deliveryId = "callback-external-retry";
    const firstService = intake(repoPath, repoPath, {
      statusPublisher: async () => ({
        provider: "github",
        commentId: 701,
      }),
    });
    await firstService.accept(signedDelivery({ deliveryId }));
    await firstService.drain();
    await expect(
      getGitHubWebhookDelivery(repoPath, deliveryId),
    ).resolves.toMatchObject({
      state: "completed",
      callback: {
        state: "succeeded",
        external: {
          provider: "github",
          commentId: 701,
        },
      },
    });
    const completed = await getGitHubWebhookDelivery(repoPath, deliveryId);
    await writeFile(
      join(
        repoPath,
        `.nitely/github-webhooks/deliveries/${deliveryId}.json`,
      ),
      JSON.stringify(
        {
          ...completed,
          callback: {
            ...completed.callback,
            state: "failed",
            failureCode: "status_publish_failed",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const previousExternal: unknown[] = [];
    const restartedService = intake(repoPath, repoPath, {
      statusPublisher: async (_update, previous) => {
        previousExternal.push(previous);
        return {
          provider: "github",
          checkRunId: 801,
        };
      },
    });
    await restartedService.drain();

    expect(previousExternal).toEqual([
      {
        provider: "github",
        commentId: 701,
      },
    ]);
    await expect(
      getGitHubWebhookDelivery(repoPath, deliveryId),
    ).resolves.toMatchObject({
      state: "completed",
      callback: {
        state: "succeeded",
        external: {
          provider: "github",
          commentId: 701,
          checkRunId: 801,
        },
      },
    });
  });

  it("leases deliveries so concurrent drainers do not publish duplicate callbacks", async () => {
    const repoPath = await createRepo();
    let callbackStartedResolve!: () => void;
    let releaseCallback!: () => void;
    const callbackStarted = new Promise<void>((resolve) => {
      callbackStartedResolve = resolve;
    });
    const blockedCallback = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    const updates: GitHubWebhookStatusUpdate[] = [];
    const first = intake(repoPath, repoPath, {
      statusPublisher: async (update) => {
        updates.push(update);
        callbackStartedResolve();
        await blockedCallback;
      },
    }, {
      createLeaseOwnerId: () => "webhook-worker-a",
    });
    const second = intake(repoPath, repoPath, {
      statusPublisher: async (update) => {
        updates.push(update);
      },
    }, {
      createLeaseOwnerId: () => "webhook-worker-b",
    });

    await first.accept(signedDelivery({ deliveryId: "leased-delivery" }));
    const firstDrain = first.drain();
    await callbackStarted;
    await second.drain();

    expect(updates).toHaveLength(1);
    await expect(
      getGitHubWebhookDelivery(repoPath, "leased-delivery"),
    ).resolves.toMatchObject({
      state: "processing",
      lease: {
        ownerId: "webhook-worker-a",
      },
    });

    releaseCallback();
    await firstDrain;

    await expect(
      getGitHubWebhookDelivery(repoPath, "leased-delivery"),
    ).resolves.toMatchObject({
      state: "completed",
      callback: { state: "succeeded" },
    });
    expect(updates).toHaveLength(1);
    expect(await deliveryDirectoryEntries(repoPath)).not.toContain(
      "leased-delivery.json.lock",
    );
  });

  it("reclaims an expired processing lease after worker death", async () => {
    const repoPath = await createRepo();
    const deliveryId = "expired-lease";
    const service = intake(repoPath);
    await service.accept(signedDelivery({ deliveryId }));
    await writeFile(
      join(
        repoPath,
        `.nitely/github-webhooks/deliveries/${deliveryId}.json.lock`,
      ),
      JSON.stringify({
        schemaVersion: 1,
        deliveryId,
        ownerId: "dead-worker",
        token: "dead-token",
        acquiredAt: "2026-07-16T03:00:00.000Z",
        expiresAt: "2026-07-16T03:01:00.000Z",
      }),
      "utf8",
    );
    const restarted = intake(repoPath, repoPath, {}, {
      createLeaseOwnerId: () => "replacement-worker",
    });

    await restarted.drain();

    await expect(
      getGitHubWebhookDelivery(repoPath, deliveryId),
    ).resolves.toMatchObject({
      state: "completed",
      taskId: expect.stringMatching(/^github-delivery-/),
    });
    expect(await deliveryDirectoryEntries(repoPath)).not.toContain(
      `${deliveryId}.json.lock`,
    );
  });

  it("records and retries a processing-failure callback after restart", async () => {
    const repoPath = await createRepo();
    const deliveryId = "failed-callback-retry";
    const firstService = new GitHubWebhookIntake({
      stateRepoPath: repoPath,
      configuration: configuration({
        statusPublisher: async () => {
          throw new Error("temporary provider failure");
        },
      }),
      resolveRepository: async () => ({ id: "wrong-repository", path: repoPath }),
    });
    await firstService.accept(signedDelivery({ deliveryId }));
    await firstService.drain();
    await expect(
      getGitHubWebhookDelivery(repoPath, deliveryId),
    ).resolves.toMatchObject({
      state: "failed",
      failure: { code: "processing_failed" },
      callback: {
        state: "failed",
        failureCode: "status_publish_failed",
        attempts: 1,
      },
    });

    const retried: GitHubWebhookStatusUpdate[] = [];
    const restartedService = new GitHubWebhookIntake({
      stateRepoPath: repoPath,
      configuration: configuration({
        statusPublisher: async (update) => {
          retried.push(update);
        },
      }),
      resolveRepository: async () => {
        throw new Error("failed callbacks must not reprocess the request");
      },
    });
    await restartedService.drain();

    expect(retried).toEqual([
      expect.objectContaining({
        state: "failed",
        deliveryId,
        failureCode: "processing_failed",
      }),
    ]);
    await expect(
      getGitHubWebhookDelivery(repoPath, deliveryId),
    ).resolves.toMatchObject({
      state: "failed",
      callback: { state: "succeeded", attempts: 2 },
    });
  });

  it("parses complete environment configuration and fails closed when partial", () => {
    expect(
      githubWebhookConfigurationFromEnv({
        NITELY_GITHUB_WEBHOOK_SECRET: secret,
        NITELY_GITHUB_WEBHOOK_REPOSITORIES: "acme/widgets=default",
        NITELY_GITHUB_WEBHOOK_ACTORS: "alice,bob",
        NITELY_GITHUB_WEBHOOK_INSTALLATIONS: "123,456",
        NITELY_GITHUB_WEBHOOK_LABELS: "nitely,run-nitely",
        NITELY_GITHUB_WEBHOOK_ASSIGNEES: "nitely[bot]",
        NITELY_GITHUB_WEBHOOK_MENTIONS: "@nitely,nitely[bot]",
        NITELY_GITHUB_WEBHOOK_FLOW: "flows/implement-spec-bootstrap.json",
        NITELY_GITHUB_WEBHOOK_REWORK_FLOW: "flows/rework-pr-bootstrap.json",
        NITELY_GITHUB_WEBHOOK_MAX_AGE_MS: "90000",
      }),
    ).toMatchObject({
      secret,
      repositories: [{ fullName: "acme/widgets", repositoryId: "default" }],
      allowedActors: ["alice", "bob"],
      allowedInstallationIds: [123, 456],
      triggerLabels: ["nitely", "run-nitely"],
      triggerAssignees: ["nitely[bot]"],
      triggerMentions: ["@nitely", "nitely[bot]"],
      flowPath: "flows/implement-spec-bootstrap.json",
      reworkFlowPath: "flows/rework-pr-bootstrap.json",
      maxDeliveryAgeMs: 90_000,
    });

    expect(() =>
      githubWebhookConfigurationFromEnv({
        NITELY_GITHUB_WEBHOOK_SECRET: secret,
        NITELY_GITHUB_WEBHOOK_REPOSITORIES: "acme/widgets=default",
      }),
    ).toThrow("GitHub webhook configuration is incomplete");
  });

  it("rejects oversized repository and actor configuration identifiers", async () => {
    const repoPath = await createRepo();

    expect(() =>
      intake(repoPath, repoPath, {
        repositories: [
          { fullName: `${"a".repeat(40)}/widgets`, repositoryId: "default" },
        ],
      }),
    ).toThrow("GitHub webhook repository must be owner/repository");
    expect(() =>
      intake(repoPath, repoPath, {
        allowedActors: ["a".repeat(101)],
      }),
    ).toThrow("GitHub webhook allowed actor is invalid");
  });
});
