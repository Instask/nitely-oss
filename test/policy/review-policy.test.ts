import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { classifyChangeRisk } from "../../src/policy/risk.js";
import {
  declaredRiskBaseline,
  DEFAULT_REVIEW_POLICY,
  loadReviewPolicy,
  renderRiskClassificationMarkdown,
  resolveReviewRequirement,
} from "../../src/policy/review-policy.js";

async function repoWithPolicy(policy?: unknown): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "nitely-review-policy-"));
  if (policy !== undefined) {
    await mkdir(join(repo, ".nitely"), { recursive: true });
    await writeFile(
      join(repo, ".nitely/review-policy.json"),
      typeof policy === "string" ? policy : JSON.stringify(policy),
      "utf8",
    );
  }
  return repo;
}

describe("repository review policy", () => {
  it("falls back to conservative built-in defaults", async () => {
    const policy = await loadReviewPolicy(await repoWithPolicy());
    expect(policy.configured).toBe(false);
    expect(policy.classes.protected).toMatchObject({
      requiredApprovals: 2,
      requireCodeOwner: true,
      allowUnattendedMerge: false,
      requireRunApproval: true,
    });
    expect(policy.classes.mechanical).toMatchObject({
      requiredApprovals: 0,
      autoMergeEligible: true,
      requireRunApproval: false,
    });
  });

  it("merges per-class overrides onto the defaults", async () => {
    const policy = await loadReviewPolicy(
      await repoWithPolicy({
        classes: { high: { requiredApprovals: 3, requireRunApproval: true } },
      }),
    );

    expect(policy.classes.high).toMatchObject({
      riskClass: "high",
      requiredApprovals: 3,
      requireRunApproval: true,
      // untouched fields keep the default
      requireCodeOwner: true,
      draftOnly: true,
    });
    expect(policy.classes.normal).toEqual(
      DEFAULT_REVIEW_POLICY.classes.normal,
    );
  });

  it("rejects a malformed policy instead of guessing", async () => {
    await expect(
      loadReviewPolicy(await repoWithPolicy({ classes: { high: [] } })),
    ).rejects.toThrow("classes.high must be an object");
    await expect(
      loadReviewPolicy(await repoWithPolicy({ classes: { high: { requiredApprovals: -1 } } })),
    ).rejects.toThrow("must be a non-negative integer");
    await expect(
      loadReviewPolicy(await repoWithPolicy({ baselineByWorkItemType: { "dev.pr": "trivial" } })),
    ).rejects.toThrow("must be one of: mechanical, normal, high, protected");
    await expect(loadReviewPolicy(await repoWithPolicy("{"))).rejects.toThrow(
      "is not valid JSON",
    );
  });

  it("takes the declared baseline from repository policy, then governance", async () => {
    const policy = await loadReviewPolicy(
      await repoWithPolicy({
        baselineByWorkItemType: { "docs.update": "mechanical" },
      }),
    );

    expect(
      declaredRiskBaseline({ policy, workItemType: "docs.update" }),
    ).toBe("mechanical");
    expect(declaredRiskBaseline({ policy, workItemType: "dev.pr" })).toBe(
      "normal",
    );
    expect(
      declaredRiskBaseline({
        policy,
        workItemType: "ops.deploy",
        highRiskWorkItemType: true,
      }),
    ).toBe("high");
  });

  it("maps the effective class to the review the change needs", async () => {
    const policy = await loadReviewPolicy(await repoWithPolicy());
    const classification = classifyChangeRisk({
      declared: "mechanical",
      diff: { files: [{ path: "src/auth/session.ts", status: "modified" }] },
    });

    expect(resolveReviewRequirement({ policy, classification })).toMatchObject({
      riskClass: "protected",
      requireRunApproval: true,
      allowUnattendedMerge: false,
    });
  });

  it("renders the escalation and its requirement for a human reader", async () => {
    const policy = await loadReviewPolicy(await repoWithPolicy());
    const classification = classifyChangeRisk({
      declared: "normal",
      diff: {
        files: [
          { path: "src/auth/session.ts", status: "modified" },
          { path: "db/migrate/001.sql", status: "added" },
        ],
      },
    });
    const markdown = renderRiskClassificationMarkdown({
      classification,
      requirement: resolveReviewRequirement({ policy, classification }),
    });

    expect(markdown).toContain("Declared risk: normal");
    expect(markdown).toContain("Effective risk: protected");
    expect(markdown).toContain("Escalated: yes");
    expect(markdown).toContain("src/auth/session.ts");
    expect(markdown).toContain("- database-migration (high):");
    expect(markdown).toContain("- Unattended merge: prohibited");
  });
});
