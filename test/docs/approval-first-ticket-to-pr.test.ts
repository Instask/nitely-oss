import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");

describe("approval-first ticket-to-PR product contract", () => {
  it("keeps the shipped lifecycle, proof, evidence, and boundaries explicit", async () => {
    const [contract, readme, chineseReadme] = await Promise.all([
      readFile(
        join(repositoryRoot, "docs", "approval-first-ticket-to-pr.md"),
        "utf8",
      ),
      readFile(join(repositoryRoot, "README.md"), "utf8"),
      readFile(join(repositoryRoot, "README.zh-CN.md"), "utf8"),
    ]);

    expect(contract).toContain(
      "# Approval-First Ticket-to-PR Product Contract",
    );
    expect(contract).toContain("## Acceptance Matrix");
    for (const step of [
      "1. Intake a GitHub issue or Jira ticket",
      "2. Generate and approve planning artifacts",
      "3. Execute implementation through a draft PR",
      "4. Review the pull request",
      "5. Route feedback into same-PR rework",
      "6. Preserve reusable memory and closeout evidence",
    ]) {
      expect(contract).toContain(step);
    }

    expect(contract).toContain("## Live And Deterministic Proof Boundaries");
    expect(contract).toContain("Live-provider path");
    expect(contract).toContain("Deterministic proof path");
    expect(contract).toContain(
      "nitely smoke golden-path --output /tmp/nitely-golden-path",
    );
    const proofExample = contract.match(
      /The generated `summary\.json` must contain:\s+```json\s+([\s\S]*?)\s+```/,
    );
    expect(proofExample).not.toBeNull();
    expect(JSON.parse(proofExample?.[1] ?? "{}")).toMatchObject({
      proof: {
        approvedPlanning: true,
        verifiedImplementation: true,
        draftPullRequest: true,
        evidenceBacked: true,
        controlledSamePullRequestRework: true,
      },
    });

    expect(contract).toContain("## Evidence Contract");
    expect(contract).toContain("notification decisions");
    expect(contract).toContain("stage attempts");
    expect(contract).toContain("verification output");
    expect(contract).toContain("same-PR rework history");
    expect(contract).toContain("reflection and context knowledge");
    expect(contract).toContain("## Metrics And Traceability");
    expect(contract).toContain("Reviewable PRs");
    expect(contract).toContain("cycle time");
    expect(contract).toContain("recoverable failures");
    expect(contract).toContain("cleanup time avoided");
    expect(contract).toContain("status-known PRs");
    expect(contract).toContain("lookup coverage");
    expect(contract).toContain("lookup failures remain unknown");
    expect(contract).toContain("canonicalize GitHub URL variants");
    expect(contract).toMatch(/at\s+most four real provider requests in flight/);
    expect(contract).toContain("five-second batch deadline");
    expect(contract).toContain(
      "Synthetic demo repositories and runs are excluded",
    );
    expect(contract).toMatch(
      /Manager Dashboard, scheduler, and inbox PR\s+reconciliation/,
    );
    expect(contract).toMatch(/pilot\s+closeout/);

    const markdownLinkTargets = [...contract.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g)]
      .map((match) => match[1]);
    for (const link of [
      "golden-path-demo.md",
      "notification-actions-and-delivery.md",
      "pilot-flow-templates.md",
      "customer-hosted-runner-onboarding.md",
      "evidence-retention-search-export.md",
      "open-core-boundary.md",
    ]) {
      expect(markdownLinkTargets).toContain(link);
      await expect(
        readFile(join(repositoryRoot, "docs", link), "utf8"),
      ).resolves.not.toHaveLength(0);
    }
    expect(contract).toContain("## Non-Goals");
    expect(contract).toContain("No autonomous merge or deploy");
    expect(contract).toContain("No hosted source-code custody requirement");

    expect(readme).toContain("docs/approval-first-ticket-to-pr.md");
    expect(chineseReadme).toContain("docs/approval-first-ticket-to-pr.md");
    expect(chineseReadme).toContain("GitHub issue、Jira ticket 或 prompt");
    expect(readme).not.toContain("- Richer PR evidence reports.");
    expect(chineseReadme).not.toContain("- 更完整的 PR evidence report。");
  });
});
