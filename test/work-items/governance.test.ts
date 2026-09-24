import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseFlowDocument } from "../../src/flow/load.js";
import { WebInputError } from "../../src/web/errors.js";
import {
  assertWorkItemTypeAllowed,
  evaluateWorkItemTypeGovernance,
  resolveWorkItemTypePolicy,
} from "../../src/work-items/governance.js";

async function createRepo(policy?: string[] | Record<string, unknown>) {
  const repo = await mkdtemp(join(tmpdir(), "nitely-governance-"));
  await mkdir(join(repo, ".nitely"), { recursive: true });
  if (policy) {
    await writeFile(
      join(repo, ".nitely", "work-item-policy.json"),
      JSON.stringify(Array.isArray(policy) ? { allowedTypes: policy } : policy),
      "utf8",
    );
  }
  return repo;
}

function flowWithStages(
  stageIds: {
    id: string;
    approval?: boolean;
    type?: string;
    inputs?: string[];
    outputs?: string[];
  }[],
  workItemType = "dev.pr",
) {
  return parseFlowDocument(
    JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "f", workItemType },
      spec: {
        stages: stageIds.map((stage) => {
          if (stage.approval) {
            return {
              id: stage.id,
              type: "approval",
              prompt: "ok",
              inputs: stage.inputs ?? [],
              outputs: stage.outputs ?? [],
            };
          }
          if (stage.type === "publish-change") {
            return {
              id: stage.id,
              type: "publish-change",
              inputs: stage.inputs ?? [],
              outputs: stage.outputs ?? [],
            };
          }
          return {
            id: stage.id,
            type: "command",
            command: "true",
            inputs: stage.inputs ?? [],
            outputs: stage.outputs ?? [],
          };
        }),
      },
    }),
  );
}

function loadedFlow(
  flow: { metadata: Record<string, unknown>; spec: unknown },
  workItemType = "dev.pr",
) {
  return parseFlowDocument(
    JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      ...flow,
      metadata: { ...flow.metadata, workItemType },
    }),
  );
}

async function expectGovernanceDenial(
  input: Parameters<typeof evaluateWorkItemTypeGovernance>[0],
  expected: { code: string; message: string },
): Promise<void> {
  await expect(evaluateWorkItemTypeGovernance(input)).resolves.toEqual({
    decision: "deny",
    reason: expected,
  });
  await expect(assertWorkItemTypeAllowed(input)).rejects.toMatchObject({
    message: expected.message,
  });
}

describe("work item governance", () => {
  it("requires an approval to be a graph ancestor of the protected stage", async () => {
    const repo = await createRepo(["capital-autopilot.research"]);
    const loaded = parseFlowDocument(
      JSON.stringify({
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: {
          name: "unrelated-approval",
          workItemType: "capital-autopilot.research",
          inputs: [{ id: "spec" }],
        },
        spec: {
          stages: [
            {
              id: "risk-manager",
              type: "approval",
              prompt: "Approve",
              inputs: ["spec"],
              outputs: [],
            },
            {
              id: "publish",
              type: "publish-change",
              inputs: ["spec"],
              outputs: ["change-request"],
            },
          ],
        },
      }),
    );

    await expectGovernanceDenial(
      {
        repoPath: repo,
        workItemType: "capital-autopilot.research",
        loaded,
      },
      {
        code: "governance.protected-stage-ungated",
        message:
          'work item type "capital-autopilot.research" requires an approval gate before protected stage "publish" (publish-change)',
      },
    );
  });

  it("accepts an approval graph ancestor even when it is declared later", async () => {
    const repo = await createRepo(["capital-autopilot.research"]);
    const loaded = parseFlowDocument(
      JSON.stringify({
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: {
          name: "out-of-order-ancestor",
          workItemType: "capital-autopilot.research",
        },
        spec: {
          stages: [
            {
              id: "publish",
              type: "publish-change",
              inputs: ["approval-evidence"],
              outputs: ["change-request"],
            },
            {
              id: "risk-manager",
              type: "approval",
              prompt: "Approve",
              inputs: [],
              outputs: ["approval-evidence"],
            },
          ],
        },
      }),
    );

    await expect(
      assertWorkItemTypeAllowed({
        repoPath: repo,
        workItemType: "capital-autopilot.research",
        loaded,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a work item type that disagrees with Flow metadata", async () => {
    const repo = await createRepo(["autofarm.site"]);
    const loaded = parseFlowDocument(
      JSON.stringify({
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "masquerading", workItemType: "autofarm.site" },
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
      }),
    );

    await expectGovernanceDenial(
      { repoPath: repo, workItemType: "dev.pr", loaded },
      {
        code: "governance.work-item-type-mismatch",
        message:
          'work item type "dev.pr" does not match Flow metadata workItemType "autofarm.site"',
      },
    );
  });

  it("treats the default dev.pr Flow type as canonical when metadata omits it", async () => {
    const repo = await createRepo();
    const loaded = parseFlowDocument(
      JSON.stringify({
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "legacy-default" },
        spec: {
          stages: [
            {
              id: "execute",
              type: "command",
              command: "true",
              inputs: [],
              outputs: ["result"],
            },
          ],
        },
      }),
    );

    await expectGovernanceDenial(
      { repoPath: repo, workItemType: "some.experimental", loaded },
      {
        code: "governance.work-item-type-mismatch",
        message:
          'work item type "some.experimental" does not match Flow metadata workItemType "dev.pr"',
      },
    );
  });

  it("returns a stable policy-denied reason and preserves the assertion message", async () => {
    const repo = await createRepo({ unknownTypeDefault: "deny" });
    await expectGovernanceDenial(
      {
        repoPath: repo,
        workItemType: "some.experimental",
        loaded: flowWithStages([{ id: "do" }], "some.experimental"),
      },
      {
        code: "governance.policy-denied",
        message:
          'work item type "some.experimental" is denied by .nitely/work-item-policy.json unknownTypeDefault',
      },
    );
  });

  it("returns a stable approval-stage-required reason and preserves the assertion message", async () => {
    const repo = await createRepo({
      unknownTypeDefault: "require-approval",
    });
    await expectGovernanceDenial(
      {
        repoPath: repo,
        workItemType: "some.experimental",
        loaded: flowWithStages([{ id: "do" }], "some.experimental"),
      },
      {
        code: "governance.approval-stage-required",
        message:
          'work item type "some.experimental" requires an approval stage by .nitely/work-item-policy.json policy',
      },
    );
  });

  it("returns a stable required-gates-missing reason and preserves the assertion message", async () => {
    const repo = await createRepo(["autofarm.site"]);
    await expectGovernanceDenial(
      {
        repoPath: repo,
        workItemType: "autofarm.site",
        loaded: flowWithStages(
          [{ id: "approve-plan", approval: true }],
          "autofarm.site",
        ),
      },
      {
        code: "governance.required-gates-missing",
        message:
          'work item type "autofarm.site" requires approval gate stage(s): approve-preview',
      },
    );
  });

  it("returns a stable capability-policy-missing reason and preserves the assertion message", async () => {
    const repo = await createRepo(["autofarm.site"]);
    await expectGovernanceDenial(
      {
        repoPath: repo,
        workItemType: "autofarm.site",
        loaded: loadedFlow({
          metadata: { name: "f" },
          spec: {
            stages: [
              {
                id: "approve-plan",
                type: "approval",
                prompt: "ok",
                inputs: [],
                outputs: [],
              },
              {
                id: "approve-preview",
                type: "approval",
                prompt: "ok",
                inputs: [],
                outputs: [],
              },
              {
                id: "implement",
                type: "agent",
                runtime: "codex",
                prompt: "do it",
                inputs: [],
                outputs: ["implementation"],
              },
            ],
          },
        }, "autofarm.site"),
      },
      {
        code: "governance.capability-policy-missing",
        message:
          'work item type "autofarm.site" is high-risk and requires capability policy on agent/review stage(s): implement',
      },
    );
  });

  it("returns a stable protected-stage-ungated reason and preserves the assertion message", async () => {
    const repo = await createRepo(["capital-autopilot.research"]);
    await expectGovernanceDenial(
      {
        repoPath: repo,
        workItemType: "capital-autopilot.research",
        loaded: flowWithStages([
          { id: "publish", type: "publish-change" },
          { id: "risk-manager", approval: true },
        ], "capital-autopilot.research"),
      },
      {
        code: "governance.protected-stage-ungated",
        message:
          'work item type "capital-autopilot.research" requires an approval gate before protected stage "publish" (publish-change)',
      },
    );
  });

  it("treats dev.pr as a non-high-risk built-in type", () => {
    const policy = resolveWorkItemTypePolicy("dev.pr");
    expect(policy?.highRisk).toBe(false);
  });

  it("matches capital-autopilot.* by prefix as a high-risk paper-only type", () => {
    const policy = resolveWorkItemTypePolicy("capital-autopilot.research");
    expect(policy).toMatchObject({ highRisk: true, paperOnly: true });
  });

  it("allows dev.pr without an allow-list entry", async () => {
    const repo = await createRepo();
    await expect(
      assertWorkItemTypeAllowed({
        repoPath: repo,
        workItemType: "dev.pr",
        loaded: flowWithStages([{ id: "implement" }]),
      }),
    ).resolves.toBeUndefined();
  });

  it("allows an unknown non-protected type that is not in the policy table", async () => {
    const repo = await createRepo();
    await expect(
      assertWorkItemTypeAllowed({
        repoPath: repo,
        workItemType: "some.experimental",
        loaded: flowWithStages([{ id: "do" }], "some.experimental"),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects an unknown protected type by default when it has no approval gate", async () => {
    const repo = await createRepo();
    await expect(
      assertWorkItemTypeAllowed({
        repoPath: repo,
        workItemType: "some.experimental",
        loaded: flowWithStages(
          [{ id: "publish", type: "publish-change" }],
          "some.experimental",
        ),
      }),
    ).rejects.toThrow(/approval stage|protected stage/i);
  });

  it("rejects an unknown type when the repo policy default is deny", async () => {
    const repo = await createRepo({ unknownTypeDefault: "deny" });
    await expect(
      assertWorkItemTypeAllowed({
        repoPath: repo,
        workItemType: "some.experimental",
        loaded: flowWithStages([{ id: "do" }], "some.experimental"),
      }),
    ).rejects.toThrow(/unknownTypeDefault/);
  });

  it("allows an unknown protected type when the repo policy default explicitly allows it", async () => {
    const repo = await createRepo({ unknownTypeDefault: "allow" });
    await expect(
      assertWorkItemTypeAllowed({
        repoPath: repo,
        workItemType: "some.experimental",
        loaded: flowWithStages(
          [{ id: "publish", type: "publish-change" }],
          "some.experimental",
        ),
      }),
    ).resolves.toBeUndefined();
  });

  it("requires an approval stage for unknown types when configured by default", async () => {
    const repo = await createRepo({ unknownTypeDefault: "require-approval" });
    await expect(
      assertWorkItemTypeAllowed({
        repoPath: repo,
        workItemType: "some.experimental",
        loaded: flowWithStages([{ id: "do" }], "some.experimental"),
      }),
    ).rejects.toThrow(/approval stage/);
    await expect(
      assertWorkItemTypeAllowed({
        repoPath: repo,
        workItemType: "some.experimental",
        loaded: flowWithStages(
          [{ id: "approve-custom", approval: true }, { id: "do" }],
          "some.experimental",
        ),
      }),
    ).resolves.toBeUndefined();
  });

  it("allows a custom protected type that is explicitly low-risk", async () => {
    const repo = await createRepo({
      customTypes: {
        "docs.publish": { decision: "allow", risk: "low" },
      },
    });
    await expect(
      assertWorkItemTypeAllowed({
        repoPath: repo,
        workItemType: "docs.publish",
        loaded: flowWithStages(
          [{ id: "publish", type: "publish-change" }],
          "docs.publish",
        ),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a custom protected type that requires approval but has no gate", async () => {
    const repo = await createRepo({
      customTypes: {
        "docs.publish": { decision: "require-approval" },
      },
    });
    await expect(
      assertWorkItemTypeAllowed({
        repoPath: repo,
        workItemType: "docs.publish",
        loaded: flowWithStages(
          [{ id: "publish", type: "publish-change" }],
          "docs.publish",
        ),
      }),
    ).rejects.toThrow(/approval stage|protected stage/i);
  });

  it("accepts a custom protected type after a declared approval gate", async () => {
    const repo = await createRepo({
      customTypes: {
        "docs.publish": { decision: "require-approval" },
      },
    });
    await expect(
      assertWorkItemTypeAllowed({
        repoPath: repo,
        workItemType: "docs.publish",
        loaded: flowWithStages([
          {
            id: "approve-publish",
            approval: true,
            outputs: ["approval-evidence"],
          },
          {
            id: "publish",
            type: "publish-change",
            inputs: ["approval-evidence"],
          },
        ], "docs.publish"),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a high-risk type that is not allow-listed", async () => {
    const repo = await createRepo();
    await expect(
      assertWorkItemTypeAllowed({
        repoPath: repo,
        workItemType: "autofarm.site",
        loaded: flowWithStages([
          { id: "approve-plan", approval: true },
          { id: "approve-preview", approval: true },
        ], "autofarm.site"),
      }),
    ).rejects.toBeInstanceOf(WebInputError);
  });

  it("rejects a high-risk type whose flow is missing required gates", async () => {
    const repo = await createRepo(["autofarm.site"]);
    await expect(
      assertWorkItemTypeAllowed({
        repoPath: repo,
        workItemType: "autofarm.site",
        loaded: flowWithStages(
          [{ id: "approve-plan", approval: true }],
          "autofarm.site",
        ),
      }),
    ).rejects.toBeInstanceOf(WebInputError);
  });

  it("accepts a high-risk type that is allow-listed and declares required gates", async () => {
    const repo = await createRepo(["autofarm.site"]);
    await expect(
      assertWorkItemTypeAllowed({
        repoPath: repo,
        workItemType: "autofarm.site",
        loaded: flowWithStages([
          { id: "discover" },
          { id: "approve-plan", approval: true },
          { id: "approve-preview", approval: true },
          { id: "deploy" },
        ], "autofarm.site"),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a high-risk flow whose agent stage omits capability policy", async () => {
    const repo = await createRepo(["autofarm.site"]);
    await expect(
      assertWorkItemTypeAllowed({
        repoPath: repo,
        workItemType: "autofarm.site",
        loaded: loadedFlow({
          metadata: { name: "f" },
          spec: {
            stages: [
              { id: "approve-plan", type: "approval", prompt: "ok", inputs: [], outputs: [] },
              { id: "approve-preview", type: "approval", prompt: "ok", inputs: [], outputs: [] },
              {
                id: "implement",
                type: "agent",
                runtime: "codex",
                prompt: "do it",
                inputs: [],
                outputs: ["implementation"],
              },
            ],
          },
        }, "autofarm.site"),
      }),
    ).rejects.toThrow(/capability policy/);
  });

  it("accepts a high-risk flow whose agent stage declares capability policy", async () => {
    const repo = await createRepo(["autofarm.site"]);
    await expect(
      assertWorkItemTypeAllowed({
        repoPath: repo,
        workItemType: "autofarm.site",
        loaded: loadedFlow({
          metadata: { name: "f" },
          spec: {
            stages: [
              { id: "approve-plan", type: "approval", prompt: "ok", inputs: [], outputs: [] },
              { id: "approve-preview", type: "approval", prompt: "ok", inputs: [], outputs: [] },
              {
                id: "implement",
                type: "agent",
                runtime: "codex",
                prompt: "do it",
                inputs: [],
                outputs: ["implementation"],
                capabilities: {
                  allowedRuntimes: ["codex"],
                  commands: { mode: "none" },
                  network: { mode: "disabled", advisory: false },
                },
              },
            ],
          },
        }, "autofarm.site"),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a high-risk flow whose protected stage has no preceding approval gate", async () => {
    const repo = await createRepo(["capital-autopilot.research"]);
    await expect(
      assertWorkItemTypeAllowed({
        repoPath: repo,
        workItemType: "capital-autopilot.research",
        loaded: flowWithStages([
          { id: "publish", type: "publish-change" },
          { id: "risk-manager", approval: true },
        ], "capital-autopilot.research"),
      }),
    ).rejects.toBeInstanceOf(WebInputError);
  });

  it("accepts a high-risk flow whose protected stage follows an approval gate", async () => {
    const repo = await createRepo(["capital-autopilot.research"]);
    await expect(
      assertWorkItemTypeAllowed({
        repoPath: repo,
        workItemType: "capital-autopilot.research",
        loaded: flowWithStages([
          {
            id: "risk-manager",
            approval: true,
            outputs: ["approval-evidence"],
          },
          {
            id: "publish",
            type: "publish-change",
            inputs: ["approval-evidence"],
          },
        ], "capital-autopilot.research"),
      }),
    ).resolves.toBeUndefined();
  });
});
