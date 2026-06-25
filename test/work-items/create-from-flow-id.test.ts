import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createFlowWorkItem } from "../../src/work-items/create.js";
import { openFlowStore } from "../../src/flows/store.js";

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
});
