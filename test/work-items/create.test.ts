import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { WebInputError } from "../../src/web/errors.js";
import { createFlowWorkItem } from "../../src/work-items/create.js";

const autofarmFlow = {
  apiVersion: "nitely.dev/v1alpha1",
  kind: "Flow",
  metadata: {
    name: "autofarm-site-pipeline",
    workItemType: "autofarm.site",
    inputs: [{ id: "seed", type: "keyword-seed" }],
  },
  spec: {
    stages: [
      { id: "discover", type: "command", command: "true", inputs: ["seed"], outputs: ["keyword-set"] },
      { id: "approve-plan", type: "approval", prompt: "Approve", inputs: [], outputs: [] },
      { id: "approve-preview", type: "approval", prompt: "Approve", inputs: [], outputs: [] },
      { id: "deploy", type: "command", command: "true", inputs: [], outputs: ["deployment"] },
    ],
  },
};

async function createRepo(allowedTypes?: string[]) {
  const repo = await mkdtemp(join(tmpdir(), "nitely-create-wi-"));
  await mkdir(join(repo, "flows"), { recursive: true });
  await writeFile(
    join(repo, "flows/autofarm-site.json"),
    JSON.stringify(autofarmFlow),
    "utf8",
  );
  if (allowedTypes) {
    await mkdir(join(repo, ".nitely"), { recursive: true });
    await writeFile(
      join(repo, ".nitely/work-item-policy.json"),
      JSON.stringify({ allowedTypes }),
      "utf8",
    );
  }
  return repo;
}

async function writeFlow(path: string): Promise<void> {
  await writeFile(path, JSON.stringify(autofarmFlow), "utf8");
}

describe("createFlowWorkItem", () => {
  it("derives the work item type from flow metadata and persists a non-dev work item", async () => {
    const repo = await createRepo(["autofarm.site"]);
    const item = await createFlowWorkItem(
      repo,
      {
        title: "Launch site",
        flowPath: "flows/autofarm-site.json",
        inputs: { seed: { connector: "local-file", uri: "seeds/k.json" } },
      },
      { createId: () => "wi-1" },
    );

    expect(item).toMatchObject({
      id: "wi-1",
      flowPath: "flows/autofarm-site.json",
      workItemType: "autofarm.site",
      inputs: { seed: { connector: "local-file", uri: "seeds/k.json" } },
    });
    expect("specPath" in item).toBe(false);
  });

  it("rejects a high-risk type that is not allow-listed", async () => {
    const repo = await createRepo();
    await expect(
      createFlowWorkItem(repo, {
        title: "Launch site",
        flowPath: "flows/autofarm-site.json",
        inputs: { seed: { connector: "local-file", uri: "seeds/k.json" } },
      }),
    ).rejects.toBeInstanceOf(WebInputError);
  });

  it("rejects built-in flow paths that traverse outside flows", async () => {
    const repo = await createRepo(["autofarm.site"]);
    await writeFlow(join(repo, "outside.json"));

    await expect(
      createFlowWorkItem(repo, {
        title: "Launch site",
        flowPath: "flows/../outside.json",
        inputs: { seed: { connector: "local-file", uri: "seeds/k.json" } },
      }),
    ).rejects.toThrow("built-in flow path");
  });

  it("rejects absolute built-in flow paths", async () => {
    const repo = await createRepo(["autofarm.site"]);

    await expect(
      createFlowWorkItem(repo, {
        title: "Launch site",
        flowPath: resolve(repo, "flows/autofarm-site.json"),
        inputs: { seed: { connector: "local-file", uri: "seeds/k.json" } },
      }),
    ).rejects.toThrow("built-in flow path");
  });

  it("rejects built-in flow symlinks that resolve outside flows", async () => {
    const repo = await createRepo(["autofarm.site"]);
    const outside = await mkdtemp(join(tmpdir(), "nitely-create-wi-outside-"));
    await writeFlow(join(outside, "escape.json"));
    await symlink(join(outside, "escape.json"), join(repo, "flows/escape.json"));

    await expect(
      createFlowWorkItem(repo, {
        title: "Launch site",
        flowPath: "flows/escape.json",
        inputs: { seed: { connector: "local-file", uri: "seeds/k.json" } },
      }),
    ).rejects.toThrow("built-in flow path");
  });
});
