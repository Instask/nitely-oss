import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { WebNotFoundError } from "../../src/web/errors.js";
import { FlowStore, openFlowStore } from "../../src/flows/store.js";

const document = JSON.stringify({
  apiVersion: "nitely.dev/v1alpha1",
  kind: "Flow",
  metadata: { name: "research", workItemType: "capital.research" },
  spec: { stages: [{ id: "build", type: "command", command: "true", inputs: [], outputs: ["out"] }] },
});

describe("FlowStore", () => {
  it("creates, reads, lists, updates, and deletes user flows", async () => {
    const store = new FlowStore(":memory:");

    const created = store.createFlow(
      {
        name: "research",
        workItemType: "capital.research",
        document,
        ownerId: "usr_1",
      },
      { createId: () => "flow-1", now: () => new Date("2026-06-20T00:00:00.000Z") },
    );
    expect(created).toMatchObject({
      id: "flow-1",
      name: "research",
      workItemType: "capital.research",
      document,
      ownerId: "usr_1",
      createdAt: "2026-06-20T00:00:00.000Z",
    });

    expect(store.getFlow("flow-1")).toMatchObject({ id: "flow-1", document });

    store.createFlow(
      { name: "second", document },
      { createId: () => "flow-2", now: () => new Date("2026-06-20T01:00:00.000Z") },
    );
    expect(store.listFlows().map((f) => f.id)).toEqual(["flow-2", "flow-1"]);

    const updated = store.updateFlow("flow-1", { name: "renamed", document });
    expect(updated.name).toBe("renamed");
    expect(updated.updatedAt).not.toBe(updated.createdAt);

    store.deleteFlow("flow-1");
    expect(() => store.getFlow("flow-1")).toThrow(WebNotFoundError);

    store.close();
  });

  it("persists across reopen via openFlowStore", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-flows-"));
    const a = openFlowStore(repo);
    a.createFlow({ name: "p", document }, { createId: () => "flow-x" });
    a.close();

    const b = openFlowStore(repo);
    expect(b.getFlow("flow-x").name).toBe("p");
    b.close();
  });
});
