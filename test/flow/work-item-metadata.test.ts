import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadFlow } from "../../src/flow/load.js";
import { flowWorkItemType } from "../../src/flow/schema.js";

async function writeFlow(flow: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "nitely-flow-wit-"));
  const path = join(directory, "flow.json");
  await writeFile(path, JSON.stringify(flow, null, 2), "utf8");
  return path;
}

function flowWithMetadata(metadata: Record<string, unknown>) {
  return {
    apiVersion: "nitely.dev/v1alpha1",
    kind: "Flow",
    metadata,
    spec: {
      stages: [
        {
          id: "discover",
          type: "command",
          command: "true",
          outputs: ["keyword-set"],
        },
      ],
    },
  };
}

describe("flow work item metadata", () => {
  it("accepts a declared work item type and typed input contracts", async () => {
    const path = await writeFlow(
      flowWithMetadata({
        name: "autofarm-site-pipeline",
        workItemType: "autofarm.site",
        inputs: [{ id: "seed", type: "keyword-seed" }],
      }),
    );

    const result = await loadFlow(path, { externalInputs: ["seed"] });

    expect(result.flow.metadata.workItemType).toBe("autofarm.site");
    expect(result.flow.metadata.inputs).toEqual([
      { id: "seed", type: "keyword-seed" },
    ]);
    expect(flowWorkItemType(result.flow)).toBe("autofarm.site");
  });

  it("defaults the work item type to dev.pr when metadata omits it", async () => {
    const path = await writeFlow(flowWithMetadata({ name: "implement-spec" }));

    const result = await loadFlow(path, { externalInputs: ["seed"] });

    expect(result.flow.metadata.workItemType).toBeUndefined();
    expect(flowWorkItemType(result.flow)).toBe("dev.pr");
  });
});
