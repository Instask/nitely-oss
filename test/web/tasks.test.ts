import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createTask,
  getTaskDetail,
  getTask,
  listTasks,
  validateTaskId,
} from "../../src/web/tasks.js";

async function createRepo() {
  const repo = await mkdtemp(join(tmpdir(), "nitely-web-tasks-"));
  await mkdir(join(repo, "flows"), { recursive: true });
  await writeFile(
    join(repo, "flows/implement-spec-bootstrap.json"),
    "{}",
    "utf8",
  );
  return repo;
}

describe("web task persistence", () => {
  it("creates a task, materializes submitted files, and reads it after restart", async () => {
    const repoPath = await createRepo();

    const task = await createTask(
      repoPath,
      {
        title: "Implement console",
        spec: "Specification text",
        techDesign: "Technical design text",
        issueUrl: "https://github.com/Instask/nitely/issues/10",
      },
      {
        createId: () => "task-test",
        now: () => new Date("2026-06-19T06:07:33.000Z"),
      },
    );

    expect(task).toMatchObject({
      id: "task-test",
      title: "Implement console",
      status: "ready",
      flowPath: "flows/implement-spec-bootstrap.json",
      issueUrl: "https://github.com/Instask/nitely/issues/10",
      specPath: ".nitely/tasks/task-test/spec.md",
      techDesignPath: ".nitely/tasks/task-test/tech-design.md",
      createdAt: "2026-06-19T06:07:33.000Z",
      updatedAt: "2026-06-19T06:07:33.000Z",
    });
    await expect(
      readFile(join(repoPath, ".nitely/tasks/task-test/spec.md"), "utf8"),
    ).resolves.toBe("Specification text");
    await expect(
      readFile(join(repoPath, ".nitely/tasks/task-test/tech-design.md"), "utf8"),
    ).resolves.toBe("Technical design text");

    await expect(getTask(repoPath, "task-test")).resolves.toEqual(task);
    await expect(getTaskDetail(repoPath, "task-test")).resolves.toEqual({
      task,
      spec: "Specification text",
      techDesign: "Technical design text",
    });
    await expect(listTasks(repoPath)).resolves.toEqual([task]);
  });

  it("persists owner metadata when a web user creates a task", async () => {
    const repoPath = await createRepo();

    const task = await createTask(
      repoPath,
      {
        title: "Owned task",
        spec: "Specification text",
        techDesign: "Technical design text",
      },
      {
        createId: () => "task-owned",
        ownerId: "usr_owner",
      },
    );

    expect(task.ownerId).toBe("usr_owner");
    await expect(getTask(repoPath, "task-owned")).resolves.toMatchObject({
      ownerId: "usr_owner",
    });
  });

  it("preserves submitted spec and technical design text exactly", async () => {
    const repoPath = await createRepo();

    await createTask(
      repoPath,
      {
        title: "Preserve text",
        spec: "\n  Specification text\n",
        techDesign: "\n  Technical design text\n",
      },
      { createId: () => "task-preserve" },
    );

    await expect(
      readFile(join(repoPath, ".nitely/tasks/task-preserve/spec.md"), "utf8"),
    ).resolves.toBe("\n  Specification text\n");
    await expect(
      readFile(
        join(repoPath, ".nitely/tasks/task-preserve/tech-design.md"),
        "utf8",
      ),
    ).resolves.toBe("\n  Technical design text\n");
  });

  it("rejects empty fields and flow paths outside the repository", async () => {
    const repoPath = await createRepo();

    await expect(
      createTask(repoPath, {
        title: " ",
        spec: "spec",
        techDesign: "design",
      }),
    ).rejects.toThrow("title is required");
    await expect(
      createTask(repoPath, {
        title: "Task",
        spec: "",
        techDesign: "design",
      }),
    ).rejects.toThrow("specification text is required");
    await expect(
      createTask(repoPath, {
        title: "Task",
        spec: "spec",
        techDesign: "design",
        flowPath: "../outside.json",
      }),
    ).rejects.toThrow("flow path must stay inside the repository");
    await expect(
      createTask(repoPath, {
        title: "Task",
        spec: "spec",
        techDesign: "design",
        flowPath: "flows/missing.json",
      }),
    ).rejects.toThrow("flow path must exist inside the repository");
  });

  it("resyncs the repository once before rejecting a flow path it cannot see", async () => {
    const repoPath = await createRepo();
    let synced = 0;
    await expect(
      createTask(
        repoPath,
        {
          title: "Task",
          spec: "spec",
          techDesign: "design",
          flowPath: "flows/missing.json",
        },
        {
          resyncRepository: async () => {
            synced += 1;
            return false;
          },
        },
      ),
    ).rejects.toThrow("flow path must exist inside the repository");
    expect(synced).toBe(1);
  });

  it("accepts a flow path that only appears after the repository is resynced", async () => {
    const repoPath = await createRepo();
    const task = await createTask(
      repoPath,
      {
        title: "Task",
        spec: "spec",
        techDesign: "design",
        flowPath: "flows/late.json",
      },
      {
        resyncRepository: async () => {
          await mkdir(join(repoPath, "flows"), { recursive: true });
          await writeFile(join(repoPath, "flows", "late.json"), "{}", "utf8");
          return true;
        },
      },
    );
    expect(task.flowPath).toBe("flows/late.json");
  });

  it("rejects flow paths that resolve outside the repository through a symlink", async () => {
    const repoPath = await createRepo();
    const outside = await mkdtemp(join(tmpdir(), "nitely-web-tasks-outside-"));
    await writeFile(join(outside, "flow.json"), "{}", "utf8");
    await symlink(join(outside, "flow.json"), join(repoPath, "flows/escape.json"));

    await expect(
      createTask(repoPath, {
        title: "Task",
        spec: "spec",
        techDesign: "design",
        flowPath: "flows/escape.json",
      }),
    ).rejects.toThrow("flow path must stay inside the repository");
  });

  it("rejects task ids with path traversal characters", () => {
    expect(() => validateTaskId("task-abc_123")).not.toThrow();
    expect(() => validateTaskId("../secret")).toThrow("invalid task id");
    expect(() => validateTaskId("task/secret")).toThrow("invalid task id");
  });
});
