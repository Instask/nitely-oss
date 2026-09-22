import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createFlowWorkItem } from "../../src/work-items/create.js";
import { openFlowStore } from "../../src/flows/store.js";
import { WebInputError } from "../../src/web/errors.js";

const document = JSON.stringify({
  apiVersion: "nitely.dev/v1alpha1",
  kind: "Flow",
  metadata: { name: "report", workItemType: "report.generation", inputs: [{ id: "brief" }] },
  spec: {
    stages: [
      { id: "build", type: "command", command: "true", inputs: ["brief"], outputs: ["out"] },
    ],
  },
});

describe("createFlowWorkItem from a stored flow id", () => {
  it("loads the flow document from the store and records the flowId", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-create-flowid-"));
    const store = openFlowStore(repo);
    store.createFlow({ name: "report", document }, { createId: () => "flow-1" });
    store.close();

    const workItem = await createFlowWorkItem(
      repo,
      {
        title: "Generate report",
        flowId: "flow-1",
        inputs: { brief: { connector: "local-file", uri: "briefs/x.md" } },
      },
      { createId: () => "wi-1" },
    );

    expect(workItem).toMatchObject({
      id: "wi-1",
      workItemType: "report.generation",
      flowId: "flow-1",
    });
  });

  it("rejects a request type that disguises an allow-listed high-risk Flow", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-create-flowid-"));
    const highRiskDocument = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "autofarm", workItemType: "autofarm.site" },
      spec: {
        stages: [
          {
            id: "deploy",
            type: "command",
            command: "true",
            inputs: [],
            outputs: ["deployment"],
          },
        ],
      },
    });
    const store = openFlowStore(repo);
    store.createFlow(
      { name: "autofarm", document: highRiskDocument },
      { createId: () => "flow-high-risk" },
    );
    store.close();
    await mkdir(join(repo, ".nitely"), { recursive: true });
    await writeFile(
      join(repo, ".nitely/work-item-policy.json"),
      JSON.stringify({ allowedTypes: ["autofarm.site"] }),
      "utf8",
    );

    const creating = createFlowWorkItem(repo, {
      title: "Disguised autofarm",
      flowId: "flow-high-risk",
      workItemType: "dev.pr",
      inputs: {},
    });
    await expect(creating).rejects.toBeInstanceOf(WebInputError);
    await expect(creating).rejects.toMatchObject({
      message:
        'work item type "dev.pr" does not match Flow metadata workItemType "autofarm.site"',
    });
  });
});
