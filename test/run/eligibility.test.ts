import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openFlowStore } from "../../src/flows/store.js";
import { getFlowTemplate } from "../../src/flows/templates.js";
import type { ProviderConnectionStore } from "../../src/providers/types.js";
import { evaluateWorkItemRunStarts } from "../../src/run/eligibility.js";
import type { WorkItemRecord } from "../../src/work-items/types.js";

async function createRepo(
  inputIds: string[] = [],
  workItemType = "example.work",
): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-run-eligibility-"));
  await mkdir(join(repoPath, "flows"), { recursive: true });
  await writeFile(
    join(repoPath, "flows/eligible.json"),
    JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "eligible",
        workItemType,
        ...(inputIds.length > 0
          ? { inputs: inputIds.map((id) => ({ id })) }
          : {}),
      },
      spec: {
        stages: [
          {
            id: "execute",
            type: "agent",
            runtime: "mock",
            prompt: "Execute the work item.",
            inputs: inputIds,
            outputs: ["result"],
          },
        ],
      },
    }),
    "utf8",
  );
  return repoPath;
}

function workItem(
  id: string,
  patch: Partial<WorkItemRecord> = {},
): WorkItemRecord {
  return {
    id,
    title: id,
    status: "ready",
    workItemType: "example.work",
    flowPath: "flows/eligible.json",
    inputs: {},
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...patch,
  };
}

describe("run eligibility", () => {
  it("returns runner inputs only for eligible work items", async () => {
    const repoPath = await createRepo();
    const eligible = workItem("eligible");
    const blocked = workItem("blocked", { status: "draft" });

    const starts = await evaluateWorkItemRunStarts({
      repoPath,
      repoId: "repo-1",
      repoName: "Example",
      workItems: [eligible, blocked],
      intent: { kind: "automatic" },
      getChangeRequestStatus: async () => ({
        provider: "github",
        state: "open",
        merged: false,
      }),
    });

    expect(starts.eligibility.eligible.decision).toBe("eligible");
    expect(starts.runInputs.eligible).toMatchObject({
      flowPath: join(repoPath, "flows/eligible.json"),
      repoPath,
      repoId: "repo-1",
      repoName: "Example",
      inputs: {},
      workItemId: "eligible",
      workItemType: "example.work",
    });
    expect(starts.eligibility.blocked).toMatchObject({
      decision: "blocked",
      blockers: [expect.objectContaining({ code: "status.draft" })],
    });
    expect(starts.runInputs).not.toHaveProperty("blocked");
  });

  it("uses one stored Flow snapshot for preflight and runner input", async () => {
    const repoPath = await createRepo();
    const flowDocument = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "stored", workItemType: "example.work" },
      spec: {
        stages: [
          {
            id: "execute",
            type: "agent",
            runtime: "mock",
            prompt: "Execute the stored Flow.",
            inputs: [],
            outputs: ["result"],
          },
        ],
      },
    });
    const store = openFlowStore(repoPath);
    store.createFlow(
      { name: "stored", document: flowDocument },
      { createId: () => "flow-stored" },
    );
    store.close();
    const item = workItem("stored-item", {
      flowId: "flow-stored",
      flowPath: "flow-stored",
    });

    const starts = await evaluateWorkItemRunStarts({
      repoPath,
      workItems: [item],
      intent: { kind: "automatic" },
    });

    expect(starts.eligibility[item.id]).toMatchObject({
      decision: "eligible",
      checks: {
        preflight: { flowPath: "flow-stored", flowName: "stored" },
      },
    });
    expect(starts.runInputs[item.id]).toMatchObject({
      flowPath: "flow-stored",
      flowDocument,
    });
  });

  it("freezes a repository Flow snapshot before the file can change", async () => {
    const repoPath = await createRepo();
    const item = workItem("repository-flow");
    const flowPath = join(repoPath, item.flowPath);
    const evaluatedDocument = await readFile(flowPath, "utf8");

    const starts = await evaluateWorkItemRunStarts({
      repoPath,
      workItems: [item],
      intent: { kind: "automatic" },
    });

    await writeFile(
      flowPath,
      JSON.stringify({
        apiVersion: "nitely.dev/v1alpha1",
        kind: "Flow",
        metadata: { name: "changed", workItemType: "example.work" },
        spec: {
          stages: [
            {
              id: "changed-after-evaluation",
              type: "command",
              command: "false",
              inputs: [],
              outputs: ["changed"],
            },
          ],
        },
      }),
      "utf8",
    );

    expect(starts.eligibility[item.id].decision).toBe("eligible");
    expect(starts.runInputs[item.id]).toMatchObject({
      flowPath,
      flowDocument: evaluatedDocument,
    });
    expect(starts.runInputs[item.id].flowDocument).not.toContain(
      "changed-after-evaluation",
    );
  });

  it("blocks a record whose type disagrees with canonical Flow metadata", async () => {
    const repoPath = await createRepo();
    const flowPath = join(repoPath, "flows/eligible.json");
    const document = JSON.parse(await readFile(flowPath, "utf8")) as {
      metadata: { workItemType: string };
    };
    document.metadata.workItemType = "autofarm.site";
    await writeFile(flowPath, JSON.stringify(document), "utf8");
    const item = workItem("masquerading-high-risk", {
      workItemType: "dev.pr",
    });

    const starts = await evaluateWorkItemRunStarts({
      repoPath,
      workItems: [item],
      intent: {
        kind: "manual",
        override: { actor: "operator", reason: "run as dev.pr" },
      },
    });

    expect(starts.eligibility[item.id]).toMatchObject({
      decision: "blocked",
      blockers: [
        {
          code: "governance.work-item-type-mismatch",
          kind: "governance",
          overridePolicy: "never",
          message:
            'work item type "dev.pr" does not match Flow metadata workItemType "autofarm.site"',
        },
      ],
      overridden: [],
    });
    expect(starts.runInputs).not.toHaveProperty(item.id);
  });

  it("uses one template Flow snapshot for preflight and runner input", async () => {
    const repoPath = await createRepo();
    await writeFile(join(repoPath, "research.md"), "Research Nitely.", "utf8");
    const template = getFlowTemplate("research-pipeline")!;
    const providerStore: ProviderConnectionStore = {
      getConnection: async (providerId) => ({
        providerId,
        getAccessToken: async () => "demo-token",
      }),
      resolveEnv: async () => ({}),
      listStatuses: async () => [
        {
          id: "codex",
          name: "Codex",
          configured: true,
          message: "configured",
          hints: [],
          reconnectRequired: false,
          authMethods: [],
        },
      ],
    };
    const item = workItem("template-item", {
      workItemType: "dev.pr",
      flowPath: "template:research-pipeline",
      template: {
        templateId: template.id,
        templateVersion: template.version,
        source: "builtin",
      },
      inputs: {
        "research-task": { connector: "local-file", uri: "research.md" },
      },
    });

    const starts = await evaluateWorkItemRunStarts({
      repoPath,
      workItems: [item],
      intent: { kind: "automatic" },
      providerStore,
    });

    expect(starts.eligibility[item.id]).toMatchObject({
      decision: "eligible",
      checks: {
        preflight: {
          flowPath: "template:research-pipeline",
          flowName: "research-pipeline",
        },
      },
    });
    expect(starts.runInputs[item.id]).toMatchObject({
      flowPath: "template:research-pipeline",
      flowDocument: template.document,
    });
  });

  it("treats governance denial as a hard blocker with no runner input", async () => {
    const repoPath = await createRepo([], "some.experimental");
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    await writeFile(
      join(repoPath, ".nitely/work-item-policy.json"),
      JSON.stringify({ unknownTypeDefault: "deny" }),
      "utf8",
    );
    const item = workItem("governance-denied", {
      workItemType: "some.experimental",
    });

    const starts = await evaluateWorkItemRunStarts({
      repoPath,
      workItems: [item],
      intent: {
        kind: "manual",
        override: { actor: "operator", reason: "try anyway" },
      },
    });

    expect(starts.eligibility[item.id]).toMatchObject({
      decision: "blocked",
      blockers: [
        {
          code: "governance.policy-denied",
          kind: "governance",
          overridePolicy: "never",
          message:
            'work item type "some.experimental" is denied by .nitely/work-item-policy.json unknownTypeDefault',
        },
      ],
      overridden: [],
    });
    expect(starts.runInputs).not.toHaveProperty(item.id);
  });

  it("turns unavailable Flow sources into hard eligibility blockers", async () => {
    const repoPath = await createRepo();
    const cases = [
      workItem("missing-stored", {
        flowId: "flow-missing",
        flowPath: "flow-missing",
      }),
      workItem("missing-template", {
        flowPath: "template:missing",
        template: {
          templateId: "missing",
          templateVersion: "1",
          source: "builtin",
        },
      }),
      workItem("unsafe-path", { flowPath: "../outside.json" }),
    ];

    for (const item of cases) {
      const starts = await evaluateWorkItemRunStarts({
        repoPath,
        workItems: [item],
        intent: { kind: "automatic" },
      });
      expect(starts.eligibility[item.id]).toMatchObject({
        decision: "blocked",
        blockers: [
          expect.objectContaining({
            code: "preflight.flow-unreadable",
            kind: "preflight",
            overridePolicy: "never",
          }),
        ],
      });
      expect(starts.runInputs).not.toHaveProperty(item.id);
    }
  });

  it("owns canonical planning-source drift and explicit manual overrides", async () => {
    const repoPath = await createRepo();
    const item = workItem("drifted", {
      planningSource: {
        type: "github-issue",
        uri: "https://github.com/Instask/nitely/issues/414",
        title: "Canonical source",
        snapshot: {
          uri: "https://github.com/Instask/nitely/issues/414",
          title: "Canonical source",
          body: "Original requirements",
          fetchedAt: "2026-07-15T00:00:00.000Z",
        },
        drift: {
          status: "changed",
          checkedAt: "2026-07-15T01:00:00.000Z",
          changedFields: ["body"],
        },
      },
    });

    const automatic = (await evaluateWorkItemRunStarts({
      repoPath,
      workItems: [item],
      intent: { kind: "automatic" },
      getChangeRequestStatus: async () => ({
        provider: "github",
        state: "open",
        merged: false,
      }),
    })).eligibility;
    expect(automatic.drifted).toMatchObject({
      decision: "blocked",
      blockers: [
        {
          code: "spec-readiness.source-drift",
          kind: "source-drift",
          message: "source issue changed since planning",
          remediation: expect.any(String),
          overridePolicy: "manual",
          changedFields: ["body"],
        },
      ],
    });
    await expect(
      stat(join(repoPath, ".nitely/preflight")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const manual = (await evaluateWorkItemRunStarts({
      repoPath,
      workItems: [item],
      intent: {
        kind: "manual",
        override: { actor: "operator", reason: "accepted changed source" },
      },
      getChangeRequestStatus: async () => ({
        provider: "github",
        state: "open",
        merged: false,
      }),
    })).eligibility;
    expect(manual.drifted).toMatchObject({
      decision: "eligible",
      blockers: [],
      overridden: [
        expect.objectContaining({
          code: "spec-readiness.source-drift",
          kind: "source-drift",
        }),
      ],
      override: {
        actor: "operator",
        reason: "accepted changed source",
        acceptedReasonCodes: ["spec-readiness.source-drift"],
      },
    });
  });

  it("never lets an operator override a blocking run preflight", async () => {
    const repoPath = await createRepo(["intake"]);
    const item = workItem("missing-intake", {
      dependsOn: ["missing-upstream"],
    });

    const decisions = (await evaluateWorkItemRunStarts({
      repoPath,
      workItems: [item],
      intent: {
        kind: "manual",
        override: { actor: "operator", reason: "try anyway" },
      },
      getChangeRequestStatus: async () => ({
        provider: "github",
        state: "open",
        merged: false,
      }),
    })).eligibility;

    expect(decisions["missing-intake"]).toMatchObject({
      decision: "blocked",
      blockers: [
        expect.objectContaining({
          code: "preflight.missing-input",
          kind: "preflight",
          overridePolicy: "never",
        }),
      ],
      overridden: [
        expect.objectContaining({
          code: "dependency.missing:missing-upstream",
          kind: "missing",
        }),
      ],
      override: {
        actor: "operator",
        reason: "try anyway",
        acceptedReasonCodes: ["dependency.missing:missing-upstream"],
      },
    });
  });

  it("shares completion facts across candidates in one repository snapshot", async () => {
    const repoPath = await createRepo();
    const upstream = workItem("upstream", {
      status: "completed",
      changeRequestUrl: "https://github.com/Instask/nitely/pull/414",
    });
    const unrelated = workItem("unrelated", {
      status: "completed",
      changeRequestUrl: "https://github.com/Instask/nitely/pull/415",
    });
    const left = workItem("left", { dependsOn: [upstream.id] });
    const right = workItem("right", { dependsOn: [upstream.id] });
    let statusCalls = 0;

    const decisions = (await evaluateWorkItemRunStarts({
      repoPath,
      workItems: [upstream, unrelated, left, right],
      candidateIds: [left.id, right.id],
      intent: { kind: "automatic" },
      getChangeRequestStatus: async () => {
        statusCalls += 1;
        return { provider: "github", state: "open", merged: false };
      },
    })).eligibility;

    expect(statusCalls).toBe(1);
    expect(decisions.left.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "dependency.incomplete:upstream",
        }),
      ]),
    );
    expect(decisions.right.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "dependency.incomplete:upstream",
        }),
      ]),
    );
  });
});
