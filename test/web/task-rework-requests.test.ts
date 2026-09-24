import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  cancelTaskReworkRequest,
  createTaskReworkRequest,
  listTaskReworkRequests,
  materializeTaskReworkRequestInputs,
} from "../../src/web/task-rework-requests.js";
import { createTask, updateTaskRunState } from "../../src/web/tasks.js";

async function createRepo() {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-task-rework-"));
  await mkdir(join(repoPath, "flows"), { recursive: true });
  await writeFile(
    join(repoPath, "flows/implement-spec-bootstrap.json"),
    "{}",
    "utf8",
  );
  await writeFile(
    join(repoPath, "flows/rework-pr-bootstrap.json"),
    "{}",
    "utf8",
  );
  return repoPath;
}

async function completedTask(repoPath: string) {
  const task = await createTask(
    repoPath,
    {
      title: "Completed task",
      spec: "Spec body",
      techDesign: "Design body",
      issueUrl: "https://github.com/Instask/nitely/issues/424",
    },
    { createId: () => "task-rework-ready" },
  );
  return updateTaskRunState(repoPath, task.id, {
    status: "completed",
    latestRunId: "run-original",
    changeRequestUrl: "https://github.com/Instask/nitely/pull/77",
  });
}

describe("task rework request persistence", () => {
  it("creates durable idempotent same-PR rework requests for completed tasks", async () => {
    const repoPath = await createRepo();
    const task = await completedTask(repoPath);

    const request = await createTaskReworkRequest(repoPath, task, {
      instruction: "Tighten the implementation copy.",
      idempotencyKey: "operator-request-1",
      actor: { id: "usr_operator", email: "operator@example.test" },
      flowPath: "flows/rework-pr-bootstrap.json",
      now: new Date("2026-07-23T05:00:00.000Z"),
    });

    expect(request.id).toMatch(/^tcr_[a-f0-9]{16}$/);
    expect(request).toMatchObject({
      idempotencyKey: "operator-request-1",
      taskId: task.id,
      status: "pending_confirmation",
      instruction: "Tighten the implementation copy.",
      priorRunId: "run-original",
      flowPath: "flows/rework-pr-bootstrap.json",
      route: {
        target: "implementation",
        confidence: "explicit",
        requiresOperatorApproval: true,
      },
      actor: {
        id: "usr_operator",
        email: "operator@example.test",
      },
      changeRequest: {
        provider: "github",
        target: "77",
        url: "https://github.com/Instask/nitely/pull/77",
        owner: "Instask",
        repository: "nitely",
        number: 77,
      },
      createdAt: "2026-07-23T05:00:00.000Z",
      updatedAt: "2026-07-23T05:00:00.000Z",
    });

    await expect(listTaskReworkRequests(repoPath, task.id)).resolves.toEqual([
      request,
    ]);
    await expect(
      createTaskReworkRequest(repoPath, task, {
        instruction: "Tighten the implementation copy.",
        idempotencyKey: "operator-request-1",
        actor: { id: "usr_operator" },
        flowPath: "flows/rework-pr-bootstrap.json",
      }),
    ).resolves.toEqual(request);
    await expect(
      createTaskReworkRequest(repoPath, task, {
        instruction: "Change something else.",
        idempotencyKey: "operator-request-1",
        actor: { id: "usr_operator" },
        flowPath: "flows/rework-pr-bootstrap.json",
      }),
    ).rejects.toThrow(
      "idempotency key already belongs to a different task rework request",
    );
  });

  it("materializes governed rework inputs for the implementation flow", async () => {
    const repoPath = await createRepo();
    const task = await completedTask(repoPath);
    const request = await createTaskReworkRequest(repoPath, task, {
      instruction: "Keep the existing PR and only update the button state.",
      actor: { id: "usr_operator" },
      flowPath: "flows/rework-pr-bootstrap.json",
    });

    const materialized = await materializeTaskReworkRequestInputs(
      repoPath,
      request,
    );

    expect(materialized.inputs).toMatchObject({
      spec: { connector: "local-file" },
      "tech-design": { connector: "local-file" },
    });
    await expect(
      readFile(materialized.inputs.spec.uri, "utf8"),
    ).resolves.toContain("Keep the existing PR and only update the button state.");
    await expect(
      readFile(materialized.inputs["tech-design"].uri, "utf8"),
    ).resolves.toContain("existing pull request branch before editing");
  });

  it("rejects unsupported routes and non-completed task states in the first slice", async () => {
    const repoPath = await createRepo();
    const task = await completedTask(repoPath);

    await expect(
      createTaskReworkRequest(repoPath, task, {
        instruction: "Revise the spec.",
        routeTarget: "spec",
        actor: { id: "usr_operator" },
      }),
    ).rejects.toThrow(
      "task request changes first slice supports only implementation route",
    );

    await cancelTaskReworkRequest({
      repoPath,
      taskId: task.id,
      requestId: (
        await createTaskReworkRequest(repoPath, task, {
          instruction: "Temporary pending request.",
          actor: { id: "usr_operator" },
        })
      ).id,
    });
    const running = await updateTaskRunState(repoPath, task.id, {
      status: "running",
      latestRunId: "run-active",
      changeRequestUrl: "https://github.com/Instask/nitely/pull/77",
    });
    await expect(
      createTaskReworkRequest(repoPath, running, {
        instruction: "Inject a live request.",
        actor: { id: "usr_operator" },
      }),
    ).rejects.toThrow("running Task cannot receive live request changes");
  });
});
