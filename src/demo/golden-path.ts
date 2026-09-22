import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  runFlow,
  type AgentExecutionInput,
  type RunFlowResult,
} from "../run/run-flow.js";
import {
  admitWorkItemRun,
  settleWorkItemRun,
} from "../run/admission.js";
import {
  evaluateWorkItemRunStarts,
  formatRunEligibilityError,
} from "../run/eligibility.js";
import { projectRun, eventStorePath } from "../run/project.js";
import { EventStore } from "../events/store.js";
import type { ProviderConnectionStore } from "../providers/types.js";
import type { ChangeRequestTarget, ScmProvider } from "../scm/types.js";
import { createTask } from "../web/tasks.js";
import {
  finalizeWorkItemRunCandidate,
  prepareWorkItemRunCandidate,
} from "../work-items/access.js";

const execFileAsync = promisify(execFile);

const demoProviderStore: ProviderConnectionStore = {
  getConnection: async (providerId) => ({
    providerId,
    getAccessToken: async () => "golden-path-demo-token",
  }),
  resolveEnv: async () => ({}),
  listStatuses: async () => [
    {
      id: "github",
      name: "GitHub",
      configured: true,
      message: "mocked by the golden path demo",
      hints: [],
      reconnectRequired: false,
      authMethods: [],
    },
  ],
};

export interface GoldenPathDemoInput {
  outputDir: string;
}

export interface GoldenPathDemoProof {
  approvedPlanning: boolean;
  eligibleImplementationStart: boolean;
  verifiedImplementation: boolean;
  draftPullRequest: boolean;
  evidenceBacked: boolean;
  controlledSamePullRequestRework: boolean;
}

export interface GoldenPathDemoResult {
  outputDir: string;
  repoPath: string;
  taskId: string;
  implementationRunId: string;
  implementationEvidencePath: string;
  draftPullRequestUrl: string;
  reworkRunId: string;
  reworkEvidencePath: string;
  updatedPullRequestUrl: string;
  proof: GoldenPathDemoProof;
}

export function assertGoldenPathDemoProof(proof: GoldenPathDemoProof): void {
  const failedProof = Object.entries(proof)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failedProof.length > 0) {
    throw new Error(`golden path proof failed: ${failedProof.join(", ")}`);
  }
}

async function git(cwd: string, args: string[]) {
  return await execFileAsync("git", args, { cwd });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

async function createFixtureRepo(repoPath: string): Promise<void> {
  await mkdir(repoPath, { recursive: true });
  await git(repoPath, ["init"]);
  await git(repoPath, ["config", "user.email", "nitely-demo@example.test"]);
  await git(repoPath, ["config", "user.name", "Nitely Demo"]);
  await writeFile(join(repoPath, "README.md"), "# Nitely Golden Path Fixture\n", "utf8");
  await git(repoPath, ["add", "README.md"]);
  await git(repoPath, ["commit", "-m", "Initial fixture"]);
}

async function writeImplementationFlow(repoPath: string): Promise<string> {
  const flowPath = join(repoPath, "flows", "golden-path-implementation.json");
  await writeJson(flowPath, {
    apiVersion: "nitely.dev/v1alpha1",
    kind: "Flow",
    metadata: { name: "golden-path-implementation", workItemType: "dev.pr" },
    spec: {
      stages: [
        {
          id: "implement",
          type: "agent",
          runtime: "mock",
          prompt: "Implement the approved spec and technical design.",
          inputs: ["spec", "tech-design", "source", "workflow-metadata"],
          outputs: ["implementation", "pr-title"],
        },
        {
          id: "verify",
          type: "command",
          command: "test -f feature.txt && grep -q implemented feature.txt",
          inputs: ["implementation"],
          outputs: ["verification-report"],
        },
        {
          id: "review",
          type: "agent",
          runtime: "mock",
          prompt: "Review the implementation before publishing.",
          inputs: ["spec", "tech-design", "implementation", "verification-report"],
          outputs: ["review"],
        },
        {
          id: "publish",
          type: "publish-change",
          provider: "github",
          inputs: ["implementation", "verification-report", "review", "pr-title"],
          outputs: ["change-request"],
        },
        {
          id: "reflect",
          type: "agent",
          runtime: "mock",
          prompt: "Reflect on the implementation run.",
          inputs: ["source", "implementation", "verification-report", "review", "change-request"],
          outputs: ["reflection"],
        },
      ],
    },
  });
  return flowPath;
}

async function writeReworkFlow(repoPath: string): Promise<string> {
  const flowPath = join(repoPath, "flows", "golden-path-rework.json");
  await writeJson(flowPath, {
    apiVersion: "nitely.dev/v1alpha1",
    kind: "Flow",
    metadata: { name: "golden-path-rework", workItemType: "dev.pr" },
    spec: {
      stages: [
        {
          id: "rework",
          type: "agent",
          runtime: "mock",
          prompt: "Apply reviewer feedback on the existing pull request branch.",
          inputs: ["feedback"],
          outputs: ["implementation", "pr-title"],
        },
        {
          id: "verify",
          type: "command",
          command: "test -f feature.txt && grep -q reworked feature.txt",
          inputs: ["implementation"],
          outputs: ["verification-report"],
        },
        {
          id: "update",
          type: "update-change",
          provider: "github",
          inputs: ["implementation", "verification-report", "pr-title"],
          outputs: ["change-request"],
        },
        {
          id: "reflect",
          type: "agent",
          runtime: "mock",
          prompt: "Reflect on the reviewer feedback loop.",
          inputs: ["feedback", "implementation", "verification-report", "change-request"],
          outputs: ["reflection"],
        },
      ],
    },
  });
  return flowPath;
}

async function executeDemoAgent(input: AgentExecutionInput): Promise<void> {
  if (input.stage.id === "implement") {
    await writeFile(join(input.worktreePath, "feature.txt"), "implemented\n", "utf8");
    await writeFile(join(input.attemptDirectory, "implementation.md"), "implemented\n", "utf8");
    await writeFile(join(input.attemptDirectory, "pr-title.md"), "Add golden path fixture feature\n", "utf8");
    return;
  }
  if (input.stage.id === "review") {
    await writeFile(
      join(input.attemptDirectory, "review.md"),
      "PASS: implementation is ready for a draft PR.\n",
      "utf8",
    );
    return;
  }
  if (input.stage.id === "rework") {
    await writeFile(join(input.worktreePath, "feature.txt"), "implemented\nreworked\n", "utf8");
    await writeFile(join(input.attemptDirectory, "implementation.md"), "reworked\n", "utf8");
    await writeFile(join(input.attemptDirectory, "pr-title.md"), "Update golden path fixture feature\n", "utf8");
    return;
  }
  if (input.stage.id === "reflect") {
    await writeFile(
      join(input.attemptDirectory, "reflection.md"),
      "Reflection: approved planning artifacts, evidence, draft PR, and rework all stayed linked.\n",
      "utf8",
    );
  }
}

function evidencePath(repoPath: string, runId: string): string {
  return join(repoPath, ".nitely", "runs", runId, "evidence.md");
}

function projectionFor(repoPath: string, runId: string) {
  const store = new EventStore(eventStorePath(repoPath));
  try {
    return projectRun(store.list(runId));
  } finally {
    store.close();
  }
}

export async function runGoldenPathDemo(
  input: GoldenPathDemoInput,
): Promise<GoldenPathDemoResult> {
  const requestedOutputDir = resolve(input.outputDir);
  if (requestedOutputDir === "/" || requestedOutputDir.length < 8) {
    throw new Error("golden path demo output directory is unsafe");
  }

  await rm(requestedOutputDir, { recursive: true, force: true });
  await mkdir(requestedOutputDir, { recursive: true });
  const outputDir = await realpath(requestedOutputDir);
  const repoPath = join(outputDir, "fixture-repo");
  await createFixtureRepo(repoPath);
  await writeImplementationFlow(repoPath);
  const reworkFlowPath = await writeReworkFlow(repoPath);

  await mkdir(join(repoPath, "inputs"), { recursive: true });
  await writeFile(
    join(repoPath, "inputs", "review-feedback.md"),
    "Reviewer feedback: preserve the original implemented marker and add a reworked marker.\n",
    "utf8",
  );

  const task = await createTask(
    repoPath,
    {
      title: "Golden path fixture issue",
      spec: `# Feature Spec: Golden path fixture feature

Status: approved
Source: github-issue https://github.com/Instask/nitely/issues/golden-path-fixture

## Background

Evaluators need deterministic proof that approved source-backed planning can produce a reviewed draft pull request.

## User Stories

- **US-001:** As an evaluator, I can run the golden path and inspect a verified file change.

## Acceptance Scenarios

- **US-001 / SC-001:** Given approved planning, when implementation runs, then feature.txt is created and verified before draft PR publication.

## Functional Requirements

- **FR-001:** Add feature.txt containing the text implemented.

## Success Criteria

- **SC-001:** The implementation Run verifies that feature.txt exists and contains implemented.

## Edge Cases And Failure Behavior

- A missing or incorrect feature.txt must fail the verification stage.

## Assumptions

- Git and the deterministic mock runtime are available locally.

## Out Of Scope

- Publishing to a live GitHub repository.

## Open Questions

- None.
`,
      techDesign: "Use a single file change and verify it with a shell command.",
      issueUrl: "https://github.com/Instask/nitely/issues/golden-path-fixture",
      flowPath: "flows/golden-path-implementation.json",
    },
    {
      createId: () => "golden-path-task",
      source: {
        type: "github-issue",
        uri: "https://github.com/Instask/nitely/issues/golden-path-fixture",
        title: "Golden path fixture issue",
        snapshot: {
          uri: "https://github.com/Instask/nitely/issues/golden-path-fixture",
          title: "Golden path fixture issue",
          body: "Create a small file-backed feature, then handle one reviewer rework request.",
          fetchedAt: "2026-06-28T00:00:00.000Z",
        },
      },
    },
  );
  const preparedImplementation = await prepareWorkItemRunCandidate(
    repoPath,
    task,
    "manual",
  );
  const plannedWorkItem = preparedImplementation.workItem;
  const implementationStarts = await evaluateWorkItemRunStarts({
    repoPath,
    workItems: [plannedWorkItem],
    candidateIds: [plannedWorkItem.id],
    intent: { kind: "manual" },
    providerStore: demoProviderStore,
  });
  const implementationEligibility =
    implementationStarts.eligibility[plannedWorkItem.id];
  const implementationRunInput =
    implementationStarts.runInputs[plannedWorkItem.id];
  const eligibleImplementationStart =
    implementationEligibility?.decision === "eligible" &&
    implementationRunInput !== undefined;
  if (!implementationEligibility) {
    throw new Error("golden path implementation eligibility was not evaluated");
  }
  if (!eligibleImplementationStart || !implementationRunInput) {
    throw new Error(
      `golden path implementation is not eligible: ${formatRunEligibilityError(implementationEligibility)}`,
    );
  }
  const finalizedImplementation = await finalizeWorkItemRunCandidate(
    repoPath,
    preparedImplementation,
  );
  const admittedImplementationRunInput = {
    ...implementationRunInput,
    inputs: finalizedImplementation.workItem.inputs,
  };

  const admission = await admitWorkItemRun({
    repoPath,
    candidate: {
      workItem: finalizedImplementation.workItem,
      version: preparedImplementation.version,
    },
    runInput: admittedImplementationRunInput,
    legacyState: {
      activePlanningBaseline: preparedImplementation.activePlanningBaseline,
    },
    createRunId: () => "run-golden-implementation",
  });
  if (admission.decision === "conflict") {
    throw new Error(
      `golden path implementation admission conflicted: ${admission.reason}`,
    );
  }
  const planningApproval = admittedImplementationRunInput.planningApproval;

  const draftPullRequestNumber = 1;
  let implementation: RunFlowResult;
  try {
    implementation = await runFlow(
      admittedImplementationRunInput,
      {
        createRunId: () => admission.runId,
        executeAgent: executeDemoAgent,
        publishChange: async (
          { branchName, evidencePath: publishedEvidencePath },
        ) => ({
          url: `https://github.com/Instask/nitely/pull/${draftPullRequestNumber}`,
          evidencePath: publishedEvidencePath,
          changeRequest: {
            provider: "github",
            url: `https://github.com/Instask/nitely/pull/${draftPullRequestNumber}`,
            number: draftPullRequestNumber,
            owner: "Instask",
            repository: "nitely",
            baseBranch: "master",
            headBranch: branchName,
            draft: true,
          },
        }),
      },
    );
    if (implementation.runId !== admission.runId) {
      throw new Error(
        `runner returned Run ${implementation.runId} instead of admitted Run ${admission.runId}`,
      );
    }
    if (implementation.status !== "awaiting-approval") {
      const settled = await settleWorkItemRun({
        repoPath,
        workItemId: task.id,
        runId: admission.runId,
        status: "completed",
        ...(implementation.changeRequestUrl
          ? { changeRequestUrl: implementation.changeRequestUrl }
          : {}),
      });
      if (!settled.settled) {
        throw new Error(
          `admitted Run no longer owns Work item: ${admission.runId}`,
        );
      }
    }
  } catch (error) {
    await settleWorkItemRun({
      repoPath,
      workItemId: task.id,
      runId: admission.runId,
      status: "failed",
    });
    throw error;
  }

  const previousHeadSha = await git(implementation.worktreePath, ["rev-parse", "HEAD"]).then(
    ({ stdout }) => stdout.trim(),
  );
  await git(repoPath, ["worktree", "remove", implementation.worktreePath, "--force"]);

  const target: ChangeRequestTarget = {
    provider: "github",
    owner: "Instask",
    repository: "nitely",
    number: draftPullRequestNumber,
    url: `https://github.com/Instask/nitely/pull/${draftPullRequestNumber}`,
    baseBranch: "master",
    headBranch: implementation.branchName,
    headSha: previousHeadSha,
    headRepository: { owner: "Instask", repository: "nitely" },
    isCrossRepository: false,
  };
  const scmProvider: ScmProvider = {
    type: "github",
    resolveChangeRequestTarget: async () => target,
    checkoutChangeRequest: async ({ worktreePath }) => {
      await git(repoPath, ["worktree", "add", worktreePath, target.headBranch]);
      return { previousHeadSha: target.headSha };
    },
    updateChangeRequest: async ({ worktreePath, title }) => {
      await git(worktreePath, ["add", "."]);
      await git(worktreePath, ["commit", "-m", title]);
      const updatedHeadSha = await git(worktreePath, ["rev-parse", "HEAD"]).then(
        ({ stdout }) => stdout.trim(),
      );
      return {
        url: target.url,
        number: target.number,
        previousHeadSha: target.headSha,
        updatedHeadSha,
        changeRequest: {
          provider: "github",
          url: target.url,
          number: target.number,
          owner: target.owner,
          repository: target.repository,
          baseBranch: target.baseBranch,
          headBranch: target.headBranch,
          draft: true,
          outcome: "updated",
        },
      };
    },
    publishChange: async () => {
      throw new Error("golden path rework must update the existing PR");
    },
  };

  // Rework continues an accepted implementation Run on its existing pull
  // request; it is not a new Work item Run start and therefore intentionally
  // keeps the priorRunId/changeRequestTarget continuation interface.
  const rework = await runFlow(
    {
      flowPath: reworkFlowPath,
      repoPath,
      inputs: {
        feedback: { connector: "local-file", uri: "inputs/review-feedback.md" },
      },
      trigger: {
        type: "github-pr-comment",
        provider: "github",
        owner: "Instask",
        repository: "nitely",
        prNumber: 1,
        prUrl: "https://github.com/Instask/nitely/pull/1",
        commentId: "discussion_r1",
        commentUrl: "https://github.com/Instask/nitely/pull/1#discussion_r1",
        authorLogin: "reviewer",
        action: "rework",
      },
      priorRunId: implementation.runId,
      changeRequestTarget: { provider: "github", target: String(draftPullRequestNumber) },
    },
    {
      createRunId: () => "run-golden-rework",
      executeAgent: executeDemoAgent,
      scmProvider,
    },
  );

  const implementationProjection = projectionFor(repoPath, implementation.runId);
  const reworkProjection = projectionFor(repoPath, rework.runId);
  if (implementationProjection.status !== "completed" || !implementation.changeRequestUrl) {
    throw new Error("golden path implementation did not create a draft PR");
  }
  if (reworkProjection.status !== "completed" || !rework.changeRequestUrl) {
    throw new Error("golden path rework did not update the draft PR");
  }

  const implementationEvidencePath = evidencePath(
    repoPath,
    implementation.runId,
  );
  const reworkEvidencePath = evidencePath(repoPath, rework.runId);
  const [implementationEvidence, reworkEvidence] = await Promise.all([
    readFile(implementationEvidencePath, "utf8"),
    readFile(reworkEvidencePath, "utf8"),
  ]);
  const proof: GoldenPathDemoProof = {
    approvedPlanning:
      planningApproval?.artifacts.spec?.state === "spec_approved" &&
      planningApproval?.artifacts.techDesign?.state === "tech_design_approved",
    eligibleImplementationStart,
    verifiedImplementation:
      implementationProjection.stages.some(
        (stage) => stage.stageId === "verify" && stage.status === "completed",
      ) &&
      implementationProjection.stages.some(
        (stage) => stage.stageId === "review" && stage.status === "completed",
      ),
    draftPullRequest:
      implementation.changeRequest?.draft === true &&
      implementation.changeRequest.url === implementation.changeRequestUrl,
    evidenceBacked:
      implementationEvidence.includes(`Run ID: ${implementation.runId}`) &&
      implementationEvidence.includes("- verify (command)") &&
      implementationEvidence.includes("## Artifacts") &&
      reworkEvidence.includes(`Run ID: ${rework.runId}`) &&
      reworkEvidence.includes("- verify (command)") &&
      reworkEvidence.includes("## Artifacts"),
    controlledSamePullRequestRework:
      implementation.changeRequestUrl === rework.changeRequestUrl &&
      rework.changeRequest?.outcome === "updated" &&
      Boolean(rework.previousHeadSha) &&
      Boolean(rework.updatedHeadSha) &&
      rework.previousHeadSha !== rework.updatedHeadSha,
  };
  assertGoldenPathDemoProof(proof);

  const result: GoldenPathDemoResult = {
    outputDir,
    repoPath,
    taskId: task.id,
    implementationRunId: implementation.runId,
    implementationEvidencePath,
    draftPullRequestUrl: implementation.changeRequestUrl,
    reworkRunId: rework.runId,
    reworkEvidencePath,
    updatedPullRequestUrl: rework.changeRequestUrl,
    proof,
  };
  await writeJson(join(outputDir, "summary.json"), {
    ...result,
    demoId: randomUUID(),
  });
  await writeFile(
    join(outputDir, "README.md"),
    [
      "# Nitely Golden Path Demo",
      "",
      `Task: ${result.taskId}`,
      `Implementation run: ${result.implementationRunId}`,
      `Draft PR: ${result.draftPullRequestUrl}`,
      `Rework run: ${result.reworkRunId}`,
      `Updated PR: ${result.updatedPullRequestUrl}`,
      "",
      "Product proof:",
      `- Approved planning: ${proof.approvedPlanning ? "passed" : "failed"}`,
      `- Eligible implementation start: ${proof.eligibleImplementationStart ? "passed" : "failed"}`,
      `- Verified implementation and review: ${proof.verifiedImplementation ? "passed" : "failed"}`,
      `- Draft pull request: ${proof.draftPullRequest ? "passed" : "failed"}`,
      `- Evidence-backed runs: ${proof.evidenceBacked ? "passed" : "failed"}`,
      `- Controlled same-PR rework: ${proof.controlledSamePullRequestRework ? "passed" : "failed"}`,
      "",
      "Evidence:",
      `- ${result.implementationEvidencePath}`,
      `- ${result.reworkEvidencePath}`,
      "",
    ].join("\n"),
    "utf8",
  );
  return result;
}
