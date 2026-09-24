import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");

describe("positioning docs", () => {
  it("distinguishes governed spec-to-PR execution from Agent-workforce platforms", async () => {
    const [doc, roadmap, openCoreAudit] = await Promise.all([
      readFile(join(repositoryRoot, "docs", "positioning.md"), "utf8"),
      readFile(
        join(repositoryRoot, "docs", "usage-scenarios-and-efficiency-thesis.md"),
        "utf8",
      ),
      readFile(
        join(repositoryRoot, "docs", "open-core-feature-audit.md"),
        "utf8",
      ),
    ]);
    const normalizedDoc = doc.replace(/\s+/g, " ");
    const normalizedRoadmap = roadmap.replace(/\s+/g, " ");

    expect(doc).toContain(
      "open, local-first governed spec-to-PR execution system",
    );
    expect(doc).toContain("Evidence-backed PRs, not prompt-to-diff");
    expect(doc).toContain("## Competitor Learnings");
    expect(doc).toContain(
      "| Competitor | Learn | Do not copy | Nitely implication |",
    );
    expect(doc).toContain("Factory.ai");
    expect(doc).toContain(
      "Do not position Nitely as a broad software factory",
    );
    expect(doc).toContain("GitHub Copilot coding agent");
    expect(doc).toContain("workflow layer outside GitHub-native automation");
    expect(doc).toContain("GitLab Duo Agent Platform");
    expect(doc).toContain("Multica");
    expect(doc).toContain("Multica coordinates an Agent workforce");
    expect(doc).toContain(
      "Nitely governs versioned Flows, typed artifacts, gates, approvals, recovery, and PR evidence",
    );
    expect(doc).toContain("45ff984");
    expect(doc).toContain(
      "Multica is materially broader today in collaboration",
    );

    expect(doc).toContain("## Product And Roadmap Guardrails");
    expect(normalizedDoc).toContain("persistent employee personas");
    expect(normalizedDoc).toContain("dynamic Squads");
    expect(normalizedDoc).toContain("general chat or inbox product");
    expect(normalizedDoc).toContain("board/Gantt/project-management depth");
    expect(normalizedDoc).toContain("native desktop/mobile clients");
    expect(normalizedDoc).toContain("provider count is not a success metric");
    expect(roadmap).toContain(
      "These are governed-delivery surfaces, not a path to Agent-workforce",
    );
    expect(normalizedRoadmap).toContain("board/Gantt depth");
    expect(openCoreAudit).toContain(
      "not general chat/inbox or project management",
    );
    expect(openCoreAudit).toContain("provider count is not a product metric");

    expect(doc).toContain("## First Task Families");
    expect(doc).toContain("approved spec to reviewable PR");
    expect(doc).toContain("bug ticket to verified PR");
    expect(doc).toContain("PR review feedback to same-PR rework");
    expect(doc).toContain("dependency migration");
    expect(doc).toContain("CI failure repair");
  });

  it("keeps buyer copy and the primary demo aligned with governed delivery", async () => {
    const [readme, chineseReadme, pilotOffer, demo] = await Promise.all([
      readFile(join(repositoryRoot, "README.md"), "utf8"),
      readFile(join(repositoryRoot, "README.zh-CN.md"), "utf8"),
      readFile(join(repositoryRoot, "docs", "paid-pilot-offering.md"), "utf8"),
      readFile(join(repositoryRoot, "docs", "golden-path-demo.md"), "utf8"),
    ]);
    const normalizedReadme = readme.replace(/\s+/g, " ");
    const normalizedChineseReadme = chineseReadme.replace(/\s+/g, " ");
    const normalizedPilotOffer = pilotOffer.replace(/\s+/g, " ");

    expect(normalizedReadme).toContain(
      "open, local-first governed spec-to-PR execution system",
    );
    expect(normalizedReadme).toContain(
      "approved engineering intent into evidence-backed, reviewable draft pull requests",
    );
    expect(normalizedReadme).toContain(
      "Nitely is not an Agent workforce, chat/inbox, or project-management suite",
    );
    expect(readme.indexOf("governed spec-to-PR")).toBeLessThan(
      readme.indexOf("interchangeable runtimes"),
    );
    expect(normalizedChineseReadme).toContain("受治理的 spec-to-PR 执行系统");
    expect(normalizedChineseReadme).toContain(
      "有证据支撑、可审查的 draft Pull Request",
    );
    expect(normalizedChineseReadme).toContain("Nitely 不是 Agent workforce");

    expect(normalizedPilotOffer).toContain(
      "recurring specs, bugs, and review feedback",
    );
    expect(normalizedPilotOffer).toContain(
      "customer-hosted AI workflows that end in reviewable PRs",
    );
    expect(normalizedPilotOffer).toContain(
      "a narrow repeatable PR workflow with declared contracts and durable evidence, not a broad software factory or Agent-workforce platform",
    );

    expect(demo).toContain("primary deterministic product demo");
    expect(demo).toContain('"approvedPlanning": true');
    expect(demo).toContain('"verifiedImplementation": true');
    expect(demo).toContain('"draftPullRequest": true');
    expect(demo).toContain('"evidenceBacked": true');
    expect(demo).toContain('"controlledSamePullRequestRework": true');
    expect(demo).toContain("false signal aborts the smoke");
  });

  it("defines the GitHub-first adapter contract without claiming shipped endpoints", async () => {
    const [positioning, contract, validation] = await Promise.all([
      readFile(join(repositoryRoot, "docs", "positioning.md"), "utf8"),
      readFile(
        join(repositoryRoot, "docs", "upstream-integration-contract.md"),
        "utf8",
      ),
      readFile(join(repositoryRoot, "docs", "customer-validation.md"), "utf8"),
    ]);

    expect(positioning).toContain("## Layered Integration Model");
    expect(positioning).toContain("GitHub / Linear / Jira / Agent-workforce intake");
    expect(positioning).toContain("upstream-integration-contract.md");
    expect(contract).toContain('"kind": "ExecutionRequest"');
    expect(contract).toContain('"kind": "ExecutionResult"');
    expect(contract).toContain('"idempotencyKey"');
    expect(contract).toContain('"repositoryId"');
    expect(contract).toContain('"approval"');
    expect(contract).toContain('"artifactIds": ["spec", "tech-design"]');
    expect(contract).toContain('"secretRef"');
    expect(contract).toContain('"status": "blocked"');
    expect(contract).toContain('"changeRequest"');
    expect(contract).toContain('"evidence"');
    expect(contract).toContain(
      "does **not** claim that Nitely currently exposes a public webhook",
    );
    expect(contract).toContain("## GitHub-First Mapping");

    expect(validation).toContain("## Minimum Evidence Before #93 Or #397");
    expect(validation).toContain("at least 3 failed attempts");
    expect(validation).toContain("workforce collaboration");
    expect(validation).toContain(
      "Repository copy and demo tests are not customer evidence",
    );
  });
});
