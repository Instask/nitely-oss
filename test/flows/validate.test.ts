import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { validateFlowDocument } from "../../src/flows/validate.js";
import { flowTemplates } from "../../src/flows/templates.js";

async function createRepo(policy?: string[] | Record<string, unknown>) {
  const repo = await mkdtemp(join(tmpdir(), "nitely-flow-validate-"));
  if (policy) {
    await mkdir(join(repo, ".nitely"), { recursive: true });
    await writeFile(
      join(repo, ".nitely/work-item-policy.json"),
      JSON.stringify(Array.isArray(policy) ? { allowedTypes: policy } : policy),
      "utf8",
    );
  }
  return repo;
}

const devFlow = JSON.stringify({
  apiVersion: "nitely.dev/v1alpha1",
  kind: "Flow",
  metadata: { name: "dev", workItemType: "dev.pr", inputs: [{ id: "spec" }] },
  spec: {
    stages: [
      { id: "implement", type: "agent", runtime: "codex", prompt: "x", inputs: ["spec"], outputs: ["implementation"] },
    ],
  },
});

const repositoryRoot = join(import.meta.dirname, "..", "..");

interface GovernedPilotOutput {
  id?: string;
  name?: string;
  type?: string;
  description?: string;
  mediaType?: string;
  schema?: unknown;
}

interface GovernedPilotStage {
  id: string;
  prompt?: string;
  command?: string;
  maxAttempts?: number;
  alwaysRun?: boolean;
  outputs: Array<string | GovernedPilotOutput>;
  taskPlan?: {
    input?: string;
    role?: string;
    max_iterations?: number;
    maxIterations?: number;
    max_tasks?: number;
    maxTasks?: number;
  };
  conformance?: {
    mode?: string;
    report?: string;
  };
}

interface GovernedPilotDocument {
  metadata: {
    name: string;
  };
  spec: {
    stages: GovernedPilotStage[];
  };
}

function governedPilotStage(
  document: GovernedPilotDocument,
  id: string,
): GovernedPilotStage {
  const stage = document.spec.stages.find((candidate) => candidate.id === id);
  if (!stage) throw new Error(`missing governed pilot stage: ${id}`);
  return stage;
}

function governedPilotOutput(
  document: GovernedPilotDocument,
  stageId: string,
): GovernedPilotOutput {
  const output = governedPilotStage(document, stageId).outputs[0];
  if (!output || typeof output === "string") {
    throw new Error(`missing governed pilot output contract: ${stageId}`);
  }
  return output;
}

const serializedSecretLikePatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bgithub_pat_[A-Za-z0-9_]+\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:api[_-]?key|secret|token|password|passwd|private[_ -]?key)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{8,}/i,
];

function expectGovernedPilotSafetyContract(
  document: GovernedPilotDocument,
): void {
  const taskPlanStages = document.spec.stages
    .filter((stage) => stage.taskPlan !== undefined)
    .map(({ id, taskPlan }) => ({ id, taskPlan }));
  expect(taskPlanStages).toEqual([
    {
      id: "implement",
      taskPlan: {
        input: "task-plan",
        role: "execute-current",
        max_iterations: 24,
        max_tasks: 12,
      },
    },
    {
      id: "quality-review",
      taskPlan: {
        input: "task-plan",
        role: "verify-advance",
        max_iterations: 24,
        max_tasks: 12,
      },
    },
    {
      id: "final-review",
      taskPlan: {
        input: "task-plan",
        role: "final",
        max_tasks: 12,
      },
    },
  ]);

  for (const stageId of [
    "implement",
    "verify",
    "spec-review",
    "quality-review",
    "final-review",
  ]) {
    expect(governedPilotStage(document, stageId).maxAttempts, stageId).toBe(24);
  }

  expect(
    document.spec.stages
      .filter((stage) => stage.alwaysRun === true)
      .map((stage) => stage.id),
  ).toEqual(["reflect"]);

  const publish = governedPilotStage(document, "publish");
  expect(publish.outputs).toEqual([
    {
      id: "change-request",
      name: "Change request result",
      type: "change-request.result",
      description:
        "Published or updated pull request metadata, including provider, URL, branch, and status.",
      mediaType: "text/markdown",
    },
  ]);
  expect(publish.conformance).toEqual({
    mode: "advisory",
    report: "conformance-report",
  });

  expect(governedPilotStage(document, "release")).toMatchObject({
    command: "./scripts/nitely/release-production",
    maxAttempts: 1,
  });

  const serialized = JSON.stringify(document);
  for (const pattern of serializedSecretLikePatterns) {
    expect(pattern.test(serialized), pattern.source).toBe(false);
  }
}

describe("validateFlowDocument", () => {
  it("reports a valid flow", async () => {
    const repo = await createRepo();
    const report = await validateFlowDocument(repo, devFlow);
    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("surfaces the derived artifact DAG in validation output", async () => {
    const repo = await createRepo();
    const flow = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "artifact-contract",
        workItemType: "dev.pr",
        inputs: [{ id: "spec" }],
      },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement the spec.",
            inputs: ["spec"],
            outputs: [
              {
                id: "implementation",
                name: "Implementation summary",
                type: "implementation.summary",
                description: "Summary of the implementation.",
              },
            ],
          },
          {
            id: "verify",
            type: "command",
            command: "true",
            inputs: ["implementation"],
            outputs: ["verification-report"],
          },
        ],
      },
    });

    const report = await validateFlowDocument(repo, flow);

    expect(report.valid).toBe(true);
    expect(report.artifactGraph?.order).toEqual(["implement", "verify"]);
    expect(report.artifactGraph?.edges).toEqual([
      { from: "implement", to: "verify", artifacts: ["implementation"] },
    ]);
    expect(report.artifactGraph?.artifacts).toContainEqual(
      expect.objectContaining({
        id: "implementation",
        producer: "implement",
        consumers: ["verify"],
        name: "Implementation summary",
        type: "implementation.summary",
        description: "Summary of the implementation.",
      }),
    );
    expect(report.artifactGraph?.artifacts).toContainEqual(
      expect.objectContaining({
        id: "spec",
        source: "external-input",
        producer: "external-input",
        consumers: ["implement"],
      }),
    );
  });

  it("reports source-backed metadata inputs as external artifacts", async () => {
    const repo = await createRepo();
    const flow = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "source-backed",
        workItemType: "dev.pr",
        inputs: [
          {
            id: "spec",
            type: "spec",
            sourceUrl: "https://example.test/spec.md",
          },
        ],
      },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement the imported spec.",
            inputs: ["spec"],
            outputs: ["implementation"],
          },
        ],
      },
    });

    const report = await validateFlowDocument(repo, flow);

    expect(report.valid).toBe(true);
    expect(report.artifactGraph?.edges).toEqual([]);
    expect(report.artifactGraph?.artifacts).toContainEqual(
      expect.objectContaining({
        id: "spec",
        source: "external-input",
        producer: "external-input",
        consumers: ["implement"],
        type: "spec",
      }),
    );
  });

  it("reports invalid artifact references as validation errors", async () => {
    const repo = await createRepo();
    const flow = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "self-input", workItemType: "dev.pr" },
      spec: {
        stages: [
          {
            id: "loop",
            type: "agent",
            runtime: "codex",
            prompt: "This cannot consume its own output.",
            inputs: ["result"],
            outputs: ["result"],
          },
        ],
      },
    });

    const report = await validateFlowDocument(repo, flow);

    expect(report.valid).toBe(false);
    expect(report.errors).toEqual(["stage loop consumes its own artifact: result"]);
    expect(report.artifactGraph).toBeUndefined();
  });

  it("reports production lint warnings separately from validation errors", async () => {
    const repo = await createRepo();
    const flow = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "linted", workItemType: "dev.pr", inputs: [{ id: "spec" }] },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement with api_key=abcdefghij123456.",
            inputs: ["spec"],
            outputs: [
              "implementation",
              "pr-title",
              "release-notes",
              { id: "conformance-report", type: "conformance.report" },
            ],
          },
          {
            id: "verify",
            type: "command",
            command: "pnpm exec vitest run",
            inputs: ["implementation"],
            outputs: ["test-report"],
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github-cli",
            inputs: ["implementation", "pr-title"],
            outputs: ["change-request"],
          },
        ],
      },
    });

    const report = await validateFlowDocument(repo, flow);

    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings.join("\n")).toMatch(/production-lint:broad-stage/);
    expect(report.warnings.join("\n")).toMatch(/production-lint:secret-like-value/);
    expect(report.warnings.join("\n")).toMatch(/production-lint:weak-artifact-contract/);
    expect(report.warnings.join("\n")).toMatch(/production-lint:missing-timeout/);
    expect(report.warnings.join("\n")).toMatch(/production-lint:missing-review-evidence/);
    expect(report.warnings.join("\n")).toMatch(/production-lint:missing-verification-evidence/);
  });

  it("reports invalid JSON as an error", async () => {
    const repo = await createRepo();
    const report = await validateFlowDocument(repo, "{ not json");
    expect(report.valid).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
  });

  it("reports a schema violation (empty stages)", async () => {
    const repo = await createRepo();
    const bad = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "bad" },
      spec: { stages: [] },
    });
    const report = await validateFlowDocument(repo, bad);
    expect(report.valid).toBe(false);
  });

  it("hard-blocks a high-risk type that omits its required gate", async () => {
    const repo = await createRepo(["autofarm.site"]);
    const flow = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "af", workItemType: "autofarm.site" },
      spec: {
        stages: [
          { id: "deploy", type: "command", command: "true", inputs: [], outputs: ["out"] },
        ],
      },
    });
    const report = await validateFlowDocument(repo, flow);
    expect(report.valid).toBe(false);
    expect(report.errors.join(" ")).toMatch(/gate|approval/i);
  });

  it("reports unknown protected custom flows as policy errors", async () => {
    const repo = await createRepo();
    const flow = JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "custom-publish", workItemType: "docs.publish" },
      spec: {
        stages: [
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: ["spec"],
            outputs: ["change-request"],
          },
        ],
      },
    });
    const report = await validateFlowDocument(repo, flow);
    expect(report.valid).toBe(false);
    expect(report.errors.join(" ")).toMatch(/docs\.publish|approval|policy/i);
  });
});

describe("flowTemplates", () => {
  it("provides templates whose documents validate", async () => {
    const repo = await createRepo();
    expect(flowTemplates.length).toBeGreaterThan(0);
    for (const template of flowTemplates) {
      const report = await validateFlowDocument(repo, template.document);
      expect(report.valid, `${template.id}: ${report.errors.join("; ")}`).toBe(true);
      expect(template.artifactGraph.order.length, template.id).toBeGreaterThan(0);
    }
  });

  it("keeps built-in implementation templates least-privileged by stage", () => {
    for (const templateId of ["plan-approve-implement", "dev-pr"]) {
      const template = flowTemplates.find((item) => item.id === templateId);
      const document = JSON.parse(template?.document ?? "{}") as {
        spec?: { stages?: Array<{ id: string; capabilities?: unknown }> };
      };
      const stages = new Map(
        (document.spec?.stages ?? []).map((stage) => [stage.id, stage]),
      );
      expect(stages.get("write-tests")?.capabilities, templateId).toMatchObject({
        write: { scope: "worktree", allow: ["test/"] },
        commands: { mode: "none" },
      });
      expect(stages.get("implement")?.capabilities, templateId).toMatchObject({
        write: { scope: "worktree" },
        commands: { mode: "unrestricted" },
      });
      if (templateId === "plan-approve-implement") {
        expect(stages.get("draft-spec")?.capabilities).toMatchObject({
          write: { scope: "none" },
          commands: { mode: "none" },
        });
      }
    }
  });

  it("uses codex as the only runtime in built-in workflow templates", () => {
    for (const template of flowTemplates) {
      const document = JSON.parse(template.document) as {
        spec?: { stages?: Array<{ runtime?: string; runtimes?: Array<{ runtime?: string }> }> };
      };
      for (const stage of document.spec?.stages ?? []) {
        const runtimes = stage.runtimes ?? (stage.runtime ? [{ runtime: stage.runtime }] : []);
        if (runtimes.length === 0) continue;
        expect(runtimes, template.id).toEqual([{ runtime: "codex" }]);
      }
    }
  });

  it("validates the multi-perspective review pilot flow without warnings", async () => {
    const repo = await createRepo();
    const document = await readFile(
      join(repositoryRoot, "flows", "pilot-approved-spec-pr-multi-review.json"),
      "utf8",
    );

    const report = await validateFlowDocument(repo, document);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);

    const flow = JSON.parse(document) as {
      spec: {
        stages: Array<{
          id: string;
          mode?: string;
          blocking?: boolean;
          perspectives?: string[];
        }>;
      };
    };
    const perspectives = flow.spec.stages.filter(
      (stage) => stage.mode === "review",
    );
    expect(perspectives.map((stage) => stage.id)).toEqual([
      "review-correctness",
      "review-security",
      "review-spec-conformance",
    ]);
    // Every perspective runs; the aggregate owns the blocking decision.
    for (const stage of perspectives) {
      expect(stage.blocking, stage.id).toBe(false);
    }
    expect(
      flow.spec.stages.find((stage) => stage.mode === "review-aggregate"),
    ).toMatchObject({
      id: "review",
      perspectives: perspectives.map((stage) => stage.id),
    });
  });

  it("ships a typed convergence template in sync with its repository flow", async () => {
    const template = flowTemplates.find(
      (candidate) => candidate.id === "converge-feature-artifacts",
    );
    expect(template).toMatchObject({
      flowPath: "flows/converge-feature-artifacts.json",
      expectedOutputs: expect.arrayContaining([
        "convergence-report",
        "converged-tasks",
      ]),
    });
    const document = JSON.parse(template!.document) as {
      spec: {
        stages: Array<{
          id: string;
          convergence?: Record<string, string>;
          outputs: Array<{ id: string; type: string; mediaType: string }>;
        }>;
      };
    };
    expect(document.spec.stages[0]).toMatchObject({
      id: "converge",
      convergence: {
        tasksInput: "tasks",
        reportOutput: "convergence-report",
        tasksOutput: "converged-tasks",
      },
      outputs: expect.arrayContaining([
        expect.objectContaining({
          id: "convergence-report",
          type: "convergence.report",
          mediaType: "application/vnd.nitely.convergence+json",
        }),
        expect.objectContaining({
          id: "converged-tasks",
          type: "task.converged",
          mediaType: "text/markdown",
        }),
      ]),
    });
    const fileDocument = JSON.parse(
      await readFile(
        join(repositoryRoot, "flows", "converge-feature-artifacts.json"),
        "utf8",
      ),
    );
    expect(fileDocument).toEqual(document);
  });

  it("ships a governed issue-to-production pilot contract", () => {
    const template = flowTemplates.find(
      (candidate) => candidate.id === "pilot-issue-to-production",
    );
    expect(template, "pilot-issue-to-production template is missing").toBeDefined();
    expect(template).toMatchObject({
      flowPath: "flows/pilot-issue-to-production.json",
    });

    const document = JSON.parse(template!.document) as {
      metadata: {
        name: string;
        workItemType?: string;
        inputs?: Array<{ id: string }>;
      };
      spec: {
        stages: Array<{
          id: string;
          type: string;
          mode?: string;
          runtime?: string;
          provider?: string;
          command?: string;
          prompt?: string;
          timeoutMs?: number;
          maxAttempts?: number;
          alwaysRun?: boolean;
          inputs: string[];
          outputs: Array<{
            id: string;
            name: string;
            type: string;
            description: string;
            mediaType?: string;
          }>;
          taskPlan?: {
            input: string;
            role: string;
            max_iterations?: number;
            max_tasks?: number;
          };
        }>;
      };
    };
    const stages = document.spec.stages;
    const stage = (id: string) => stages.find((candidate) => candidate.id === id)!;

    expect(document.metadata).toMatchObject({
      name: "pilot-issue-to-production",
      workItemType: "dev.pr",
      inputs: [{ id: "issue" }, { id: "repo-notes" }, { id: "release-runbook" }],
    });
    expect(stages.map(({ id }) => id)).toEqual([
      "draft-spec",
      "approve-spec",
      "draft-tech-design",
      "approve-tech-design",
      "plan-tasks",
      "implement",
      "verify",
      "spec-review",
      "quality-review",
      "final-review",
      "publish",
      "release-readiness-review",
      "approve-release",
      "release",
      "post-release-review",
      "reflect",
    ]);
    expect(stages.map(({ type, mode }) => [type, mode])).toEqual([
      ["agent", undefined],
      ["approval", undefined],
      ["agent", undefined],
      ["approval", undefined],
      ["agent", undefined],
      ["agent", undefined],
      ["command", undefined],
      ["gate", "review"],
      ["gate", "review"],
      ["gate", "review"],
      ["publish-change", undefined],
      ["gate", "review"],
      ["approval", undefined],
      ["command", undefined],
      ["gate", "review"],
      ["agent", undefined],
    ]);

    expect(stage("approve-spec")).toMatchObject({
      type: "approval",
      inputs: ["spec"],
      outputs: [],
    });
    expect(stage("approve-tech-design")).toMatchObject({
      type: "approval",
      inputs: ["tech-design"],
      outputs: [],
    });
    expect(stage("implement")).toMatchObject({
      type: "agent",
      maxAttempts: 24,
      inputs: ["spec", "tech-design", "task-plan"],
      taskPlan: {
        input: "task-plan",
        role: "execute-current",
        max_iterations: 24,
        max_tasks: 12,
      },
    });
    expect(stage("verify")).toMatchObject({
      type: "command",
      timeoutMs: 600000,
      maxAttempts: 24,
      inputs: ["task-plan", "implementation"],
    });
    expect(stage("spec-review")).toMatchObject({
      type: "gate",
      mode: "review",
      maxAttempts: 24,
      inputs: ["spec", "task-plan", "implementation", "verification-report"],
    });
    expect(stage("quality-review")).toMatchObject({
      type: "gate",
      mode: "review",
      maxAttempts: 24,
      inputs: ["task-plan", "implementation", "verification-report", "spec-review"],
      taskPlan: {
        input: "task-plan",
        role: "verify-advance",
        max_iterations: 24,
        max_tasks: 12,
      },
    });
    expect(stage("final-review")).toMatchObject({
      type: "gate",
      mode: "review",
      maxAttempts: 24,
      inputs: ["spec", "tech-design", "task-plan", "conformance-report", "quality-review"],
      taskPlan: {
        input: "task-plan",
        role: "final",
        max_tasks: 12,
      },
    });
    expect(stage("plan-tasks").prompt).toContain("at most 12 tasks");
    expect(stage("plan-tasks").prompt).toContain("max_iterations to 24");
    expect(stage("publish")).toMatchObject({
      type: "publish-change",
      provider: "github-cli",
      inputs: [
        "implementation",
        "pr-title",
        "conformance-report",
        "verification-report",
        "final-review",
      ],
    });
    expect(stage("release-readiness-review")).toMatchObject({
      type: "gate",
      mode: "review",
      inputs: ["release-runbook", "change-request", "final-review"],
    });
    expect(stage("approve-release")).toMatchObject({
      type: "approval",
      inputs: ["release-runbook", "change-request", "release-readiness-review"],
      outputs: [],
    });
    expect(stage("release")).toMatchObject({
      type: "command",
      command: "./scripts/nitely/release-production",
      timeoutMs: 1800000,
      maxAttempts: 1,
      inputs: ["release-runbook", "change-request", "release-readiness-review"],
      outputs: [
        expect.objectContaining({
          id: "release-report",
          type: "release.report",
          description: expect.any(String),
        }),
        expect.objectContaining({
          id: "smoke-report",
          type: "smoke.report",
          description: expect.any(String),
        }),
      ],
    });
    expect(stage("post-release-review")).toMatchObject({
      type: "gate",
      mode: "review",
      inputs: ["release-runbook", "change-request", "release-report", "smoke-report"],
    });
    for (const reviewId of [
      "spec-review",
      "quality-review",
      "final-review",
      "release-readiness-review",
      "post-release-review",
    ]) {
      expect(stage(reviewId).prompt, reviewId).toContain("Review verdict: pass");
      expect(stage(reviewId).prompt, reviewId).toContain("Review verdict: fail");
    }
    expect(stage("reflect")).toMatchObject({
      type: "agent",
      alwaysRun: true,
      inputs: [
        "issue",
        "spec",
        "tech-design",
        "task-plan",
        "change-request",
        "release-report",
        "smoke-report",
        "post-release-review",
      ],
    });
    expectGovernedPilotSafetyContract(document);
  });

  it("rejects unsafe governed pilot contract mutations", () => {
    const template = flowTemplates.find(
      (candidate) => candidate.id === "pilot-issue-to-production",
    );
    expect(template, "pilot-issue-to-production template is missing").toBeDefined();
    const original = JSON.parse(template!.document) as GovernedPilotDocument;
    const credentialLikeValue = "abcdefghij123456";
    const githubCredentialLikeValue = `ghp_${"0".repeat(24)}`;
    const fineGrainedGithubCredentialLikeValue =
      `github_pat_${"0".repeat(24)}`;
    const apiCredentialLikeValue = `sk-${"0".repeat(24)}`;
    const privateKeyHeader = ["-----BEGIN", "TEST PRIVATE KEY-----"].join(" ");
    const mutations: Array<{
      name: string;
      apply: (document: GovernedPilotDocument) => void;
    }> = [
      {
        name: "extra taskPlan stage",
        apply: (document) => {
          governedPilotStage(document, "verify").taskPlan = {
            input: "task-plan",
            role: "execute-current",
            max_iterations: 12,
          };
        },
      },
      {
        name: "changed taskPlan role",
        apply: (document) => {
          governedPilotStage(document, "quality-review").taskPlan!.role = "final";
        },
      },
      {
        name: "changed taskPlan max_iterations",
        apply: (document) => {
          governedPilotStage(document, "implement").taskPlan!.max_iterations = 23;
        },
      },
      {
        name: "changed taskPlan max_tasks",
        apply: (document) => {
          governedPilotStage(document, "implement").taskPlan!.max_tasks = 13;
        },
      },
      {
        name: "reduced shared attempt budget",
        apply: (document) => {
          governedPilotStage(document, "spec-review").maxAttempts = 23;
        },
      },
      {
        name: "final taskPlan gains max_iterations",
        apply: (document) => {
          governedPilotStage(document, "final-review").taskPlan!.max_iterations = 24;
        },
      },
      {
        name: "extra alwaysRun stage",
        apply: (document) => {
          governedPilotStage(document, "release").alwaysRun = true;
        },
      },
      {
        name: "release gains an automatic retry",
        apply: (document) => {
          governedPilotStage(document, "release").maxAttempts = 2;
        },
      },
      {
        name: "bare publish output",
        apply: (document) => {
          governedPilotStage(document, "publish").outputs = ["change-request"];
        },
      },
      {
        name: "changed publish conformance",
        apply: (document) => {
          governedPilotStage(document, "publish").conformance = {
            mode: "strict",
            report: "conformance-report",
          };
        },
      },
      {
        name: "credential-like metadata",
        apply: (document) => {
          document.metadata.name = `api_key=${credentialLikeValue}`;
        },
      },
      {
        name: "credential-like prompt",
        apply: (document) => {
          governedPilotStage(document, "draft-spec").prompt =
            `Use token=${credentialLikeValue}`;
        },
      },
      {
        name: "credential-like command",
        apply: (document) => {
          governedPilotStage(document, "release").command =
            `./scripts/nitely/release-production --token=${credentialLikeValue}`;
        },
      },
      {
        name: "credential-like artifact name",
        apply: (document) => {
          governedPilotOutput(document, "release").name =
            `token=${credentialLikeValue}`;
        },
      },
      {
        name: "credential-like artifact description",
        apply: (document) => {
          governedPilotOutput(document, "release").description =
            `token=${credentialLikeValue}`;
        },
      },
      {
        name: "credential-like artifact schema",
        apply: (document) => {
          governedPilotOutput(document, "release").schema = {
            api_key: credentialLikeValue,
          };
        },
      },
      {
        name: "credential-like GitHub token",
        apply: (document) => {
          governedPilotOutput(document, "release").description =
            githubCredentialLikeValue;
        },
      },
      {
        name: "credential-like fine-grained GitHub token",
        apply: (document) => {
          governedPilotOutput(document, "release").description =
            fineGrainedGithubCredentialLikeValue;
        },
      },
      {
        name: "credential-like API token",
        apply: (document) => {
          governedPilotOutput(document, "release").description =
            apiCredentialLikeValue;
        },
      },
      {
        name: "credential-like private key",
        apply: (document) => {
          governedPilotOutput(document, "release").schema = {
            pem: privateKeyHeader,
          };
        },
      },
    ];

    for (const mutation of mutations) {
      const document = structuredClone(original);
      mutation.apply(document);
      expect(
        () => expectGovernedPilotSafetyContract(document),
        mutation.name,
      ).toThrow();
    }
  });

  it("provides pilot-ready PR templates with verification, review, and reflection", () => {
    const pilotTemplates = flowTemplates.filter((template) =>
      template.id.startsWith("pilot-"),
    );
    expect(pilotTemplates.length).toBeGreaterThanOrEqual(3);

    for (const template of pilotTemplates) {
      const document = JSON.parse(template.document) as {
        metadata?: { inputs?: { id: string }[] };
        spec?: { stages?: { id: string; type: string; mode?: string; alwaysRun?: boolean }[] };
      };
      const stages = document.spec?.stages ?? [];
      expect(document.metadata?.inputs?.length, template.id).toBeGreaterThan(0);
      expect(stages.some((stage) => stage.type === "command"), template.id).toBe(true);
      expect(
        stages.some((stage) => stage.type === "gate" && stage.mode === "review"),
        template.id,
      ).toBe(true);
      expect(
        stages.some(
          (stage) =>
            (stage.type === "publish-change" || stage.type === "update-change"),
        ),
        template.id,
      ).toBe(true);
      expect(
        stages.some((stage) => stage.id === "reflect" && stage.alwaysRun === true),
        template.id,
      ).toBe(true);
    }
  });

  it("keeps pilot templates clear of production lint warnings", async () => {
    const repo = await createRepo();
    const pilotTemplates = flowTemplates.filter((template) =>
      template.id.startsWith("pilot-"),
    );

    for (const template of pilotTemplates) {
      const report = await validateFlowDocument(repo, template.document);
      expect(report.warnings, template.id).toEqual([]);
    }
  });

  it("uses described artifact contracts in pilot template outputs", () => {
    const pilotTemplates = flowTemplates.filter((template) =>
      template.id.startsWith("pilot-"),
    );

    for (const template of pilotTemplates) {
      const document = JSON.parse(template.document) as {
        spec?: { stages?: Array<{ outputs?: unknown[] }> };
      };
      for (const stage of document.spec?.stages ?? []) {
        for (const output of stage.outputs ?? []) {
          expect(typeof output, template.id).toBe("object");
          expect(output, template.id).toMatchObject({
            id: expect.any(String),
            name: expect.any(String),
            type: expect.any(String),
            description: expect.any(String),
          });
        }
      }
      for (const artifact of template.artifacts) {
        if (artifact.source === "stage-output") {
          expect(artifact.description, `${template.id}:${artifact.id}`).toBeTruthy();
          expect(artifact.consumers, `${template.id}:${artifact.id}`).toEqual(
            expect.any(Array),
          );
        }
      }
    }
  });

  it("keeps pilot template files in sync with the built-in catalog", async () => {
    const pilotTemplates = flowTemplates.filter((template) =>
      template.id.startsWith("pilot-"),
    );
    expect(pilotTemplates.length).toBeGreaterThanOrEqual(3);

    for (const template of pilotTemplates) {
      const fileDocument = await readFile(
        join(repositoryRoot, "flows", `${template.id}.json`),
        "utf8",
      );
      expect(JSON.parse(fileDocument), template.id).toEqual(
        JSON.parse(template.document),
      );
    }
  });

  it("keeps the governed built-in JSON deeply equal to its template document", async () => {
    const template = flowTemplates.find(
      (candidate) => candidate.id === "pilot-issue-to-production",
    );
    expect(template, "pilot-issue-to-production template is missing").toBeDefined();
    const fileDocument = JSON.parse(
      await readFile(
        join(repositoryRoot, "flows", "pilot-issue-to-production.json"),
        "utf8",
      ),
    ) as unknown;

    expect(fileDocument).toEqual(JSON.parse(template!.document));
  });
});
