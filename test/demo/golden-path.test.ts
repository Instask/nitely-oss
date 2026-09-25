import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertGoldenPathDemoProof,
  runGoldenPathDemo,
} from "../../src/demo/golden-path.js";
import { RunAdmissionStore } from "../../src/run/admission-store.js";

describe("golden path demo", () => {
  it("fails closed when the initial implementation start is ineligible", () => {
    expect(() =>
      assertGoldenPathDemoProof({
        approvedPlanning: true,
        eligibleImplementationStart: false,
        verifiedImplementation: true,
        draftPullRequest: true,
        evidenceBacked: true,
        controlledSamePullRequestRework: true,
      }),
    ).toThrow("golden path proof failed: eligibleImplementationStart");
  });

  it("runs approved task implementation and same-PR rework with mocked providers", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "nitely-golden-path-"));

    const result = await runGoldenPathDemo({ outputDir });

    expect(result).toMatchObject({
      outputDir,
      taskId: "golden-path-task",
      implementationRunId: "run-golden-implementation",
      draftPullRequestUrl: "https://github.com/example/nitely-demo/pull/1",
      reworkRunId: "run-golden-rework",
      updatedPullRequestUrl: "https://github.com/example/nitely-demo/pull/1",
      proof: {
        approvedPlanning: true,
        eligibleImplementationStart: true,
        verifiedImplementation: true,
        draftPullRequest: true,
        evidenceBacked: true,
        controlledSamePullRequestRework: true,
      },
    });
    await expect(readFile(result.implementationEvidencePath, "utf8")).resolves.toContain(
      "golden-path-implementation",
    );
    await expect(readFile(result.reworkEvidencePath, "utf8")).resolves.toContain(
      "golden-path-rework",
    );
    const summary = JSON.parse(
      await readFile(join(outputDir, "summary.json"), "utf8"),
    ) as {
      implementationRunId?: string;
      reworkRunId?: string;
      proof?: Record<string, boolean>;
    };
    expect(summary).toMatchObject({
      implementationRunId: "run-golden-implementation",
      reworkRunId: "run-golden-rework",
      proof: {
        approvedPlanning: true,
        eligibleImplementationStart: true,
        verifiedImplementation: true,
        draftPullRequest: true,
        evidenceBacked: true,
        controlledSamePullRequestRework: true,
      },
    });
    await expect(readFile(join(outputDir, "README.md"), "utf8")).resolves.toContain(
      "Eligible implementation start: passed",
    );
    await expect(readFile(join(outputDir, "README.md"), "utf8")).resolves.toContain(
      "Controlled same-PR rework: passed",
    );

    const workflowMetadata = JSON.parse(
      await readFile(
        join(
          result.repoPath,
          ".nitely/tasks/golden-path-task/execution/workflow-metadata.json",
        ),
        "utf8",
      ),
    ) as {
      status?: string;
      planningBaseline?: {
        specVersionId?: string;
        specContentHash?: string;
        specContentPath?: string;
        techDesignVersionId?: string;
        techDesignContentHash?: string;
        techDesignContentPath?: string;
      };
    };
    const implementationRun = JSON.parse(
      await readFile(
        join(
          result.repoPath,
          ".nitely/runs/run-golden-implementation/run.json",
        ),
        "utf8",
      ),
    ) as {
      planningApproval?: {
        artifacts?: {
          spec?: { versionId?: string; contentHash?: string; path?: string };
          techDesign?: { versionId?: string; contentHash?: string; path?: string };
        };
      };
    };
    expect(workflowMetadata.status).toBe("running");
    expect(workflowMetadata.planningBaseline).toMatchObject({
      specVersionId:
        implementationRun.planningApproval?.artifacts?.spec?.versionId,
      specContentHash:
        implementationRun.planningApproval?.artifacts?.spec?.contentHash,
      specContentPath:
        implementationRun.planningApproval?.artifacts?.spec?.path,
      techDesignVersionId:
        implementationRun.planningApproval?.artifacts?.techDesign?.versionId,
      techDesignContentHash:
        implementationRun.planningApproval?.artifacts?.techDesign?.contentHash,
      techDesignContentPath:
        implementationRun.planningApproval?.artifacts?.techDesign?.path,
    });

    const admissions = new RunAdmissionStore(
      join(result.repoPath, ".nitely", "run-admissions.db"),
    );
    try {
      expect(admissions.get(result.implementationRunId)).toMatchObject({
        runId: "run-golden-implementation",
        workItemId: "golden-path-task",
        state: "settled",
      });
      expect(admissions.get(result.reworkRunId)).toBeUndefined();
    } finally {
      admissions.close();
    }
  }, 120_000);
});
