import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { WebInputError } from "../../src/web/errors.js";
import {
  assertWorkItemTypeAllowed,
  resolveWorkItemTypePolicy,
} from "../../src/work-items/governance.js";

async function createRepo(allowedTypes?: string[]) {
  const repo = await mkdtemp(join(tmpdir(), "nitely-governance-"));
  await mkdir(join(repo, ".nitely"), { recursive: true });
  if (allowedTypes) {
    await writeFile(
      join(repo, ".nitely", "work-item-policy.json"),
      JSON.stringify({ allowedTypes }),
      "utf8",
    );
  }
  return repo;
}

function flowWithStages(
  stageIds: { id: string; approval?: boolean; type?: string }[],
) {
  return {
    metadata: { name: "f" },
    spec: {
      stages: stageIds.map((stage) => {
        if (stage.approval) {
          return { id: stage.id, type: "approval", prompt: "ok", inputs: [], outputs: [] };
        }
        if (stage.type === "publish-change") {
          return { id: stage.id, type: "publish-change", inputs: [], outputs: [] };
        }
        return { id: stage.id, type: "command", command: "true", inputs: [], outputs: [] };
      }),
    },
  } as never;
}

describe("work item governance", () => {
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
        flow: flowWithStages([{ id: "implement" }]),
      }),
    ).resolves.toBeUndefined();
  });

  it("allows an unknown type that is not in the policy table", async () => {
    const repo = await createRepo();
    await expect(
      assertWorkItemTypeAllowed({
        repoPath: repo,
        workItemType: "some.experimental",
        flow: flowWithStages([{ id: "do" }]),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a high-risk type that is not allow-listed", async () => {
    const repo = await createRepo();
    await expect(
      assertWorkItemTypeAllowed({
        repoPath: repo,
        workItemType: "autofarm.site",
        flow: flowWithStages([
          { id: "approve-plan", approval: true },
          { id: "approve-preview", approval: true },
        ]),
      }),
    ).rejects.toBeInstanceOf(WebInputError);
  });

  it("rejects a high-risk type whose flow is missing required gates", async () => {
    const repo = await createRepo(["autofarm.site"]);
    await expect(
      assertWorkItemTypeAllowed({
        repoPath: repo,
        workItemType: "autofarm.site",
        flow: flowWithStages([{ id: "approve-plan", approval: true }]),
      }),
    ).rejects.toBeInstanceOf(WebInputError);
  });

  it("accepts a high-risk type that is allow-listed and declares required gates", async () => {
    const repo = await createRepo(["autofarm.site"]);
    await expect(
      assertWorkItemTypeAllowed({
        repoPath: repo,
        workItemType: "autofarm.site",
        flow: flowWithStages([
          { id: "discover" },
          { id: "approve-plan", approval: true },
          { id: "approve-preview", approval: true },
          { id: "deploy" },
        ]),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a high-risk flow whose protected stage has no preceding approval gate", async () => {
    const repo = await createRepo(["capital-autopilot.research"]);
    await expect(
      assertWorkItemTypeAllowed({
        repoPath: repo,
        workItemType: "capital-autopilot.research",
        flow: flowWithStages([
          { id: "publish", type: "publish-change" },
          { id: "risk-manager", approval: true },
        ]),
      }),
    ).rejects.toBeInstanceOf(WebInputError);
  });

  it("accepts a high-risk flow whose protected stage follows an approval gate", async () => {
    const repo = await createRepo(["capital-autopilot.research"]);
    await expect(
      assertWorkItemTypeAllowed({
        repoPath: repo,
        workItemType: "capital-autopilot.research",
        flow: flowWithStages([
          { id: "risk-manager", approval: true },
          { id: "publish", type: "publish-change" },
        ]),
      }),
    ).resolves.toBeUndefined();
  });
});
