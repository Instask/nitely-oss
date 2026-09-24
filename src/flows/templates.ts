import { parseFlowDocument } from "../flow/load.js";
import { inputContractHasDefaultSource } from "../flow/inputs.js";
import { flowWorkItemType, stageOutputIds } from "../flow/schema.js";
import type {
  ConfigurableInput,
  Flow,
  OutputDeclaration,
  Stage,
} from "../flow/schema.js";
import {
  CONFORMANCE_REPORT_MEDIA_TYPE,
  CONFORMANCE_REPORT_SCHEMA,
} from "../conformance/report.js";
import {
  CONVERGENCE_REPORT_MEDIA_TYPE,
  CONVERGENCE_REPORT_SCHEMA,
} from "../task-artifacts/convergence.js";
import {
  summarizeFlowArtifactGraph,
  type FlowArtifactContractView,
  type FlowArtifactGraphView,
} from "./artifact-graph.js";

export interface FlowTemplateInput {
  id: string;
  type?: string;
  required: boolean;
}

export interface FlowTemplateStageSummary {
  id: string;
  type: string;
  inputs: string[];
  outputs: string[];
}

export interface FlowTemplateLineage {
  templateId: string;
  templateVersion: string;
  source: "builtin";
  sourceFlowPath?: string;
}

export interface FlowTemplate {
  id: string;
  name: string;
  description: string;
  version: string;
  taskFamily: string;
  flowPath?: string;
  inputs: FlowTemplateInput[];
  configurables: ConfigurableInput[];
  requiredProviders: string[];
  requiredMcpServers: string[];
  requiredConnectors: string[];
  requiredSkills: string[];
  runtimeCompatibility: string[];
  expectedOutputs: string[];
  stages: FlowTemplateStageSummary[];
  artifacts: FlowArtifactContractView[];
  artifactGraph: FlowArtifactGraphView;
  suggestedGates: string[];
  document: string;
}

interface FlowTemplateDefinition {
  id: string;
  name: string;
  description: string;
  version?: string;
  taskFamily?: string;
  flowPath?: string;
  document: string;
}

function asDocument(flow: unknown): string {
  return JSON.stringify(flow, null, 2);
}

function sorted(values: Iterable<string | undefined>): string[] {
  return [...new Set([...values].filter((value): value is string => !!value))]
    .sort((left, right) => left.localeCompare(right));
}

function describedOutput(input: {
  id: string;
  name: string;
  type: string;
  description: string;
  mediaType?: string;
  schema?: unknown;
}): OutputDeclaration {
  return {
    id: input.id,
    name: input.name,
    type: input.type,
    description: input.description,
    ...(input.mediaType ? { mediaType: input.mediaType } : {}),
    ...(input.schema !== undefined ? { schema: input.schema } : {}),
  };
}

const GOVERNED_PRODUCTION_MAX_PLAN_TASKS = 12;
const GOVERNED_PRODUCTION_SHARED_RETRY_REWORK_HEADROOM = 12;
// Stage attempts are counted globally across the loop, so reserve one initial
// execution per planned task plus an equal shared pool for retries and rework.
const GOVERNED_PRODUCTION_TASK_LOOP_BUDGET =
  GOVERNED_PRODUCTION_MAX_PLAN_TASKS +
  GOVERNED_PRODUCTION_SHARED_RETRY_REWORK_HEADROOM;

const artifactOutputs = {
  spec: describedOutput({
    id: "spec",
    name: "Approved specification candidate",
    type: "specification.document",
    description:
      "Structured feature specification with acceptance criteria, non-goals, risks, and open questions.",
    mediaType: "text/markdown",
  }),
  techDesign: describedOutput({
    id: "tech-design",
    name: "Technical design",
    type: "technical-design.document",
    description:
      "Repository-grounded technical design covering implementation, verification, release, and operational risks.",
    mediaType: "text/markdown",
  }),
  implementation: describedOutput({
    id: "implementation",
    name: "Implementation summary",
    type: "implementation.summary",
    description:
      "Markdown summary of code changes, affected files, and important implementation decisions.",
    mediaType: "text/markdown",
  }),
  prTitle: describedOutput({
    id: "pr-title",
    name: "Pull request title",
    type: "change-request.title",
    description: "One-line title to use when publishing or updating the pull request.",
    mediaType: "text/plain",
  }),
  taskPlan: describedOutput({
    id: "task-plan",
    name: "Task plan",
    type: "task-plan",
    description:
      "Ordered task-plan.json with task ids, titles, dependency/completion state, and optional max_iterations.",
    mediaType: "application/json",
  }),
  verificationReport: describedOutput({
    id: "verification-report",
    name: "Verification report",
    type: "verification.report",
    description:
      "Command output summary listing tests, checks, failures, and any verification caveats.",
    mediaType: "text/markdown",
  }),
  review: describedOutput({
    id: "review",
    name: "Review verdict",
    type: "review.verdict",
    description:
      "Blocking review result with pass/fail verdict and P0/P1 findings when present.",
    mediaType: "text/markdown",
  }),
  specReview: describedOutput({
    id: "spec-review",
    name: "Specification review",
    type: "review.spec",
    description:
      "Per-task review verdict confirming implementation and verification evidence satisfy the approved specification.",
    mediaType: "text/markdown",
  }),
  qualityReview: describedOutput({
    id: "quality-review",
    name: "Quality review",
    type: "review.quality",
    description:
      "Per-task quality verdict covering correctness, tests, maintainability, and blocking findings.",
    mediaType: "text/markdown",
  }),
  finalReview: describedOutput({
    id: "final-review",
    name: "Final review",
    type: "review.final",
    description:
      "Holistic final verdict confirming the completed task plan is ready for draft pull request publication.",
    mediaType: "text/markdown",
  }),
  releaseReadinessReview: describedOutput({
    id: "release-readiness-review",
    name: "Release readiness review",
    type: "review.release-readiness",
    description:
      "Release-candidate verdict covering the draft pull request, runbook, evidence, rollback, and smoke-check readiness.",
    mediaType: "text/markdown",
  }),
  releaseReport: describedOutput({
    id: "release-report",
    name: "Release report",
    type: "release.report",
    description:
      "Atomic release adapter report covering merge, rollback baseline, deployment, outcome, and rollback when required.",
    mediaType: "text/markdown",
  }),
  smokeReport: describedOutput({
    id: "smoke-report",
    name: "Smoke report",
    type: "smoke.report",
    description:
      "Production smoke-check evidence emitted by the repository-owned release adapter.",
    mediaType: "text/markdown",
  }),
  postReleaseReview: describedOutput({
    id: "post-release-review",
    name: "Post-release review",
    type: "review.post-release",
    description:
      "Post-release verdict reconciling release and smoke evidence with the approved runbook.",
    mediaType: "text/markdown",
  }),
  changeRequest: describedOutput({
    id: "change-request",
    name: "Change request result",
    type: "change-request.result",
    description:
      "Published or updated pull request metadata, including provider, URL, branch, and status.",
    mediaType: "text/markdown",
  }),
  reflection: describedOutput({
    id: "reflection",
    name: "Reflection",
    type: "workflow.reflection",
    description:
      "Post-run workflow reflection listing follow-up issues, duplicates, observations, or a clean result.",
    mediaType: "text/markdown",
  }),
  conformanceReport: describedOutput({
    id: "conformance-report",
    name: "Conformance report",
    type: "conformance.report",
    description:
      "Requirement-to-evidence report showing how the implementation satisfies the approved spec.",
    mediaType: CONFORMANCE_REPORT_MEDIA_TYPE,
    schema: CONFORMANCE_REPORT_SCHEMA,
  }),
  regressionTest: describedOutput({
    id: "regression-test",
    name: "Regression test",
    type: "test.regression",
    description:
      "Description of the failing regression test, command, expected failure, and covered bug behavior.",
    mediaType: "text/markdown",
  }),
  convergenceReport: describedOutput({
    id: "convergence-report",
    name: "Convergence report",
    type: "convergence.report",
    description:
      "Structured implementation-gap report classified and traced to feature source references.",
    mediaType: CONVERGENCE_REPORT_MEDIA_TYPE,
    schema: CONVERGENCE_REPORT_SCHEMA,
  }),
  convergedTasks: describedOutput({
    id: "converged-tasks",
    name: "Converged tasks",
    type: "task.converged",
    description:
      "Markdown task artifact with deterministic remaining-work tasks appended after existing content.",
    mediaType: "text/markdown",
  }),
} satisfies Record<string, OutputDeclaration>;

function stageRuntimes(stage: Stage): string[] {
  if (!("runtime" in stage) && !("runtimes" in stage)) {
    return [];
  }
  const direct = "runtime" in stage ? stage.runtime : undefined;
  const candidates =
    "runtimes" in stage && Array.isArray(stage.runtimes)
      ? stage.runtimes.map((candidate) => candidate.runtime)
      : [];
  return sorted([direct, ...candidates]);
}

function stageProvider(stage: Stage): string | undefined {
  return "provider" in stage ? stage.provider : undefined;
}

function stageRequiredMcpServers(stage: Stage): string[] {
  return "required_mcp_servers" in stage ? (stage.required_mcp_servers ?? []) : [];
}

function stageRequiredConnectors(stage: Stage): string[] {
  return "required_connectors" in stage ? (stage.required_connectors ?? []) : [];
}

function stageSkills(stage: Stage): string[] {
  return "skills" in stage ? (stage.skills ?? []) : [];
}

function summarizeTemplate(definition: FlowTemplateDefinition): FlowTemplate {
  const externalInputs = (() => {
    const parsed = JSON.parse(definition.document) as {
      metadata?: { inputs?: Array<{ id?: unknown }> };
    };
    return (parsed.metadata?.inputs ?? [])
      .map((input) => (typeof input.id === "string" ? input.id : undefined))
      .filter((id): id is string => !!id);
  })();
  const loaded = parseFlowDocument(definition.document, { externalInputs });
  const flow = loaded.flow;
  const artifactGraph = summarizeFlowArtifactGraph(flow, loaded.graph);
  const stages = flow.spec.stages;
  const runtimeCompatibility = sorted(stages.flatMap(stageRuntimes));
  const requiredConnectors = sorted(stages.flatMap(stageRequiredConnectors));
  const requiredProviders = sorted([
    ...runtimeCompatibility,
    ...requiredConnectors,
    ...stages.map(stageProvider),
  ]);

  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    version: definition.version ?? "1.0.0",
    taskFamily: definition.taskFamily ?? flowWorkItemType(flow),
    ...(definition.flowPath ? { flowPath: definition.flowPath } : {}),
    inputs: (flow.metadata.inputs ?? []).map((input) => ({
      id: input.id,
      ...(input.type ? { type: input.type } : {}),
      required: !inputContractHasDefaultSource(input),
    })),
    configurables: flow.metadata.configurables,
    requiredProviders,
    requiredMcpServers: sorted(stages.flatMap(stageRequiredMcpServers)),
    requiredConnectors,
    requiredSkills: sorted(stages.flatMap(stageSkills)),
    runtimeCompatibility,
    expectedOutputs: sorted(stages.flatMap(stageOutputIds)),
    stages: stages.map((stage) => ({
      id: stage.id,
      type: stage.type,
      inputs: stage.inputs,
      outputs: stageOutputIds(stage),
    })),
    artifacts: artifactGraph.artifacts,
    artifactGraph,
    suggestedGates: stages
      .filter(
        (stage) =>
          stage.type === "approval" ||
          (stage.type === "gate" && stage.mode === "review"),
      )
      .map((stage) => stage.id),
    document: definition.document,
  };
}

export function getFlowTemplate(id: string): FlowTemplate | undefined {
  return flowTemplates.find((template) => template.id === id);
}

export function flowTemplateLineage(
  template: FlowTemplate,
): FlowTemplateLineage {
  return {
    templateId: template.id,
    templateVersion: template.version,
    source: "builtin",
    ...(template.flowPath ? { sourceFlowPath: template.flowPath } : {}),
  };
}

export function requiredFlowTemplateInputIds(template: FlowTemplate): string[] {
  return template.inputs
    .filter((input) => input.required)
    .map((input) => input.id);
}

function insertCustomReviewStage(flow: Flow, prompt: string): Flow {
  const targetIndex = flow.spec.stages.findIndex(
    (stage) => stage.type === "agent" && stage.id === "implement",
  );
  const insertAt =
    targetIndex >= 0
      ? targetIndex
      : flow.spec.stages.findIndex((stage) => stage.type === "agent");
  if (insertAt < 0) {
    return flow;
  }
  const target = flow.spec.stages[insertAt];
  return {
    ...flow,
    spec: {
      ...flow.spec,
      stages: [
        ...flow.spec.stages.slice(0, insertAt),
        {
          id: "pre-implementation-review",
          type: "gate",
          mode: "review",
          runtime: "codex",
          skills: [],
          required_mcp_servers: [],
          required_connectors: [],
          prompt,
          inputs: target.inputs,
          outputs: ["pre-implementation-review"],
        },
        ...flow.spec.stages.slice(insertAt),
      ],
    },
  };
}

export function flowTemplateDocumentForCopy(
  template: FlowTemplate,
  input: { name?: string; reviewStagePrompt?: string } = {},
): string {
  const externalInputs = requiredFlowTemplateInputIds(template);
  let flow = parseFlowDocument(template.document, { externalInputs }).flow;
  if (input.name?.trim()) {
    flow = {
      ...flow,
      metadata: { ...flow.metadata, name: input.name.trim() },
    };
  }
  if (input.reviewStagePrompt?.trim()) {
    flow = insertCustomReviewStage(flow, input.reviewStagePrompt.trim());
  }
  return asDocument(flow);
}

/**
 * Built-in starting points for the flow editor. Each document validates against
 * `validateFlowDocument`, so "New Flow → choose template" yields a runnable draft.
 */
const flowTemplateDefinitions: FlowTemplateDefinition[] = [
  {
    id: "plan-approve-implement",
    name: "Plan, approve, implement",
    description:
      "Generate a spec and technical design inside the workflow, pause for human approval, then implement and publish.",
    flowPath: "flows/plan-approve-implement-bootstrap.json",
    document: asDocument({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "plan-approve-implement",
        workItemType: "dev.pr",
        inputs: [{ id: "intake" }],
      },
      spec: {
        maxAttempts: 2,
        stages: [
          {
            id: "draft-spec",
            type: "agent",
            runtime: "codex",
            capabilities: { write: { scope: "none" }, commands: { mode: "none" } },
            prompt: "Turn the supplied issue or rough intake into a structured specification. Do not implement.",
            inputs: ["intake"],
            outputs: ["spec"],
          },
          {
            id: "approve-spec",
            type: "approval",
            prompt: "Approve the generated specification before technical design starts.",
            inputs: ["spec"],
            outputs: [],
          },
          {
            id: "draft-tech-design",
            type: "agent",
            runtime: "codex",
            capabilities: { write: { scope: "none" }, commands: { mode: "none" } },
            prompt: "Create a technical design for the approved specification. Do not implement.",
            inputs: ["spec"],
            context: { fullReadInputs: ["spec"] },
            outputs: ["tech-design"],
          },
          {
            id: "approve-tech-design",
            type: "approval",
            prompt: "Approve the generated technical design before implementation starts.",
            inputs: ["tech-design"],
            outputs: [],
          },
          {
            id: "write-tests",
            type: "agent",
            runtime: "codex",
            capabilities: { write: { scope: "worktree", allow: ["test/"] }, commands: { mode: "none" } },
            prompt: "Write only the tests for the approved specification and technical design. Do not write production code and do not make the suite green.",
            inputs: ["spec", "tech-design"],
            context: { fullReadInputs: ["spec", "tech-design"] },
            outputs: ["tests"],
          },
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            capabilities: { write: { scope: "worktree" }, commands: { mode: "unrestricted" } },
            prompt: "Implement the approved specification and technical design so the tests written in the write-tests stage pass. The tests from the write-tests stage are a contract: do not delete them, mark them skipped, or loosen their expected values to reach green.",
            inputs: ["spec", "tech-design", "tests"],
            context: { fullReadInputs: ["spec", "tech-design", "tests"] },
            outputs: ["implementation", "pr-title"],
          },
          {
            id: "test",
            type: "command",
            command: "pnpm exec vitest run",
            timeoutMs: 600000,
            inputs: ["implementation"],
            outputs: ["test-report"],
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github-cli",
            inputs: ["implementation", "test-report", "pr-title"],
            outputs: ["change-request"],
          },
        ],
      },
    }),
  },
  {
    id: "dev-pr",
    name: "Dev PR",
    description:
      "Implement a spec and technical design, run tests, review, and open a pull request.",
    flowPath: "flows/implement-spec-bootstrap.json",
    document: asDocument({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "dev-pr",
        workItemType: "dev.pr",
        inputs: [{ id: "spec" }, { id: "tech-design" }],
      },
      spec: {
        maxAttempts: 2,
        stages: [
          {
            id: "write-tests",
            type: "agent",
            runtime: "codex",
            capabilities: { write: { scope: "worktree", allow: ["test/"] }, commands: { mode: "none" } },
            prompt: "Write only the tests for the supplied specification and technical design. Do not write production code and do not make the suite green.",
            inputs: ["spec", "tech-design"],
            context: { fullReadInputs: ["spec", "tech-design"] },
            outputs: ["tests"],
          },
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            capabilities: { write: { scope: "worktree" }, commands: { mode: "unrestricted" } },
            prompt: "Implement the supplied specification and technical design so the tests written in the write-tests stage pass. The tests from the write-tests stage are a contract: do not delete them, mark them skipped, or loosen their expected values to reach green.",
            inputs: ["spec", "tech-design", "tests"],
            context: { fullReadInputs: ["spec", "tech-design", "tests"] },
            outputs: ["implementation", "pr-title"],
          },
          {
            id: "test",
            type: "command",
            command: "pnpm exec vitest run",
            timeoutMs: 600000,
            inputs: ["implementation"],
            outputs: ["test-report"],
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github",
            inputs: ["implementation", "test-report", "pr-title"],
            outputs: ["change-request"],
          },
        ],
      },
    }),
  },
  {
    id: "rework-pr",
    name: "Rework PR",
    description:
      "Apply review feedback to an existing pull request branch via update-change.",
    flowPath: "flows/rework-pr-bootstrap.json",
    document: asDocument({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "rework-pr",
        workItemType: "dev.pr",
        inputs: [{ id: "spec" }],
      },
      spec: {
        maxAttempts: 2,
        stages: [
          {
            id: "rework",
            type: "agent",
            runtime: "codex",
            prompt: "Apply the requested changes to the existing change.",
            inputs: ["spec"],
            outputs: ["implementation", "pr-title"],
          },
          {
            id: "update",
            type: "update-change",
            provider: "github",
            inputs: ["implementation", "pr-title"],
            outputs: ["change-request"],
          },
        ],
      },
    }),
  },
  {
    id: "converge-feature-artifacts",
    name: "Converge feature artifacts",
    description:
      "Compare the current implementation with a spec, plan, and task artifact, then append traceable remaining work.",
    flowPath: "flows/converge-feature-artifacts.json",
    document: asDocument({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "converge-feature-artifacts",
        workItemType: "dev.pr",
        inputs: [{ id: "spec" }, { id: "plan" }, { id: "tasks" }],
      },
      spec: {
        maxAttempts: 2,
        stages: [
          {
            id: "converge",
            type: "agent",
            runtime: "codex",
            prompt:
              "Assess the current worktree against the supplied spec, technical plan, and task artifact. Classify every implementation gap, cite stable feature source references and concrete worktree evidence, and produce the required strict convergence report. A clean implementation must produce an empty gaps array.",
            inputs: ["spec", "plan", "tasks"],
            outputs: [
              artifactOutputs.convergenceReport,
              artifactOutputs.convergedTasks,
            ],
            convergence: {
              tasksInput: "tasks",
              reportOutput: "convergence-report",
              tasksOutput: "converged-tasks",
            },
          },
        ],
      },
    }),
  },
  {
    id: "pilot-approved-spec-pr",
    name: "Pilot: approved spec to PR",
    description:
      "Turn an approved spec and technical design into a reviewed draft PR with evidence.",
    flowPath: "flows/pilot-approved-spec-pr.json",
    document: asDocument({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "pilot-approved-spec-pr",
        workItemType: "dev.pr",
        inputs: [{ id: "spec" }, { id: "tech-design" }],
      },
      spec: {
        maxAttempts: 2,
        stages: [
          {
            id: "plan-tasks",
            type: "agent",
            runtime: "codex",
            prompt:
              "Decompose the approved specification and technical design into an ordered task-plan.json. Write an artifact.json manifest that declares task-plan.json as the `task-plan` output with mediaType application/json. Use task ids such as T001, include titles, dependencies, paths when known, status pending/completed, and max_iterations no larger than 12.",
            inputs: ["spec", "tech-design"],
            context: { fullReadInputs: ["spec", "tech-design"] },
            outputs: [artifactOutputs.taskPlan],
          },
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            maxAttempts: 12,
            prompt:
              "Implement only the current pending task from the task-plan context. Keep the diff scoped, use the repository's existing patterns, add or update tests for changed behavior, write a concise pr-title artifact, and write a conformance-report JSON artifact mapping US/FR/SC/PD/T IDs to implementation evidence for completed work.",
            inputs: ["spec", "tech-design", "task-plan"],
            outputs: [
              artifactOutputs.implementation,
              artifactOutputs.prTitle,
              artifactOutputs.conformanceReport,
            ],
            taskPlan: {
              input: "task-plan",
              role: "execute-current",
              max_iterations: 12,
            },
          },
          {
            id: "verify",
            type: "command",
            command: "pnpm exec vitest run && pnpm run check",
            timeoutMs: 600000,
            maxAttempts: 12,
            inputs: ["task-plan", "implementation"],
            outputs: [artifactOutputs.verificationReport],
            taskPlan: {
              input: "task-plan",
              role: "verify-advance",
            },
          },
          {
            id: "review",
            type: "gate",
            mode: "review",
            runtime: "codex",
            prompt:
              "Review the implementation and conformance report against the approved spec and task plan. Check requirement coverage, success-criterion verification, design-decision evidence from the conformance report, tests, security-sensitive handling, and whether the PR evidence is enough for a human reviewer. Write `Review verdict: pass` only when there are no P0/P1/blocking findings.",
            inputs: ["spec", "task-plan", "implementation", "conformance-report", "verification-report"],
            outputs: [artifactOutputs.review],
            taskPlan: {
              input: "task-plan",
              role: "final",
            },
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github-cli",
            inputs: ["task-plan", "implementation", "conformance-report", "verification-report", "review", "pr-title"],
            outputs: [artifactOutputs.changeRequest],
            conformance: {
              mode: "advisory",
              report: "conformance-report",
            },
          },
          {
            id: "reflect",
            type: "agent",
            runtime: "codex",
            alwaysRun: true,
            prompt:
              "Reflect on this pilot run. Identify reusable workflow improvements, missing evidence, unclear spec/design inputs, and follow-up issues. If no action is needed, write a clean-result reflection.",
            inputs: ["spec", "tech-design", "task-plan", "implementation", "conformance-report", "verification-report", "review", "change-request"],
            outputs: [artifactOutputs.reflection],
          },
        ],
      },
    }),
  },
  {
    id: "pilot-issue-to-production",
    name: "Pilot: issue to production",
    description:
      "Turn an issue into approved plans, a reviewed draft PR, and an explicitly approved production release.",
    flowPath: "flows/pilot-issue-to-production.json",
    document: asDocument({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "pilot-issue-to-production",
        workItemType: "dev.pr",
        inputs: [
          { id: "issue" },
          { id: "repo-notes" },
          { id: "release-runbook" },
        ],
      },
      spec: {
        maxAttempts: 2,
        stages: [
          {
            id: "draft-spec",
            type: "agent",
            runtime: "codex",
            prompt:
              "Turn the issue and repository notes into a structured specification. Capture acceptance criteria, non-goals, risks, and open questions. Do not implement product code.",
            inputs: ["issue", "repo-notes"],
            outputs: [artifactOutputs.spec],
          },
          {
            id: "approve-spec",
            type: "approval",
            prompt:
              "Approve the generated specification before technical design starts.",
            inputs: ["spec"],
            outputs: [],
          },
          {
            id: "draft-tech-design",
            type: "agent",
            runtime: "codex",
            prompt:
              "Create a repository-grounded technical design for the approved specification. Cover implementation steps, test strategy, release impact, and open technical risks. Do not implement product code.",
            inputs: ["spec", "repo-notes"],
            context: { fullReadInputs: ["spec"] },
            outputs: [artifactOutputs.techDesign],
          },
          {
            id: "approve-tech-design",
            type: "approval",
            prompt:
              "Approve the technical design before task planning and implementation start.",
            inputs: ["tech-design"],
            outputs: [],
          },
          {
            id: "plan-tasks",
            type: "agent",
            runtime: "codex",
            prompt:
              `Decompose the approved specification and technical design into an ordered task-plan.json with at most ${GOVERNED_PRODUCTION_MAX_PLAN_TASKS} tasks. Write an artifact.json manifest declaring task-plan.json as the task-plan output. Use stable task ids, dependencies, paths when known, and pending/completed status. Set max_iterations to ${GOVERNED_PRODUCTION_TASK_LOOP_BUDGET}: ${GOVERNED_PRODUCTION_MAX_PLAN_TASKS} initial task iterations plus ${GOVERNED_PRODUCTION_SHARED_RETRY_REWORK_HEADROOM} shared rework iterations.`,
            inputs: ["spec", "tech-design"],
            context: { fullReadInputs: ["spec", "tech-design"] },
            outputs: [artifactOutputs.taskPlan],
          },
          {
            id: "implement",
            type: "agent",
            runtime: "codex",
            maxAttempts: GOVERNED_PRODUCTION_TASK_LOOP_BUDGET,
            prompt:
              "Implement only the current pending task. Keep the diff scoped, follow repository conventions, update tests for changed behavior, write a concise pull request title, and emit conformance evidence for completed requirements.",
            inputs: ["spec", "tech-design", "task-plan"],
            outputs: [
              artifactOutputs.implementation,
              artifactOutputs.prTitle,
              artifactOutputs.conformanceReport,
            ],
            taskPlan: {
              input: "task-plan",
              role: "execute-current",
              max_iterations: GOVERNED_PRODUCTION_TASK_LOOP_BUDGET,
              max_tasks: GOVERNED_PRODUCTION_MAX_PLAN_TASKS,
            },
          },
          {
            id: "verify",
            type: "command",
            command: "pnpm exec vitest run && pnpm run check",
            timeoutMs: 600000,
            maxAttempts: GOVERNED_PRODUCTION_TASK_LOOP_BUDGET,
            inputs: ["task-plan", "implementation"],
            outputs: [artifactOutputs.verificationReport],
          },
          {
            id: "spec-review",
            type: "gate",
            mode: "review",
            runtime: "codex",
            maxAttempts: GOVERNED_PRODUCTION_TASK_LOOP_BUDGET,
            prompt:
              "Review the current task implementation and verification evidence against the approved specification. Write `Review verdict: pass` only when the task satisfies the specification with no blocking finding. Write `Review verdict: fail` for any unmet requirement, unsupported scope change, or blocking finding.",
            inputs: [
              "spec",
              "task-plan",
              "implementation",
              "verification-report",
            ],
            outputs: [artifactOutputs.specReview],
          },
          {
            id: "quality-review",
            type: "gate",
            mode: "review",
            runtime: "codex",
            maxAttempts: GOVERNED_PRODUCTION_TASK_LOOP_BUDGET,
            prompt:
              "Review the current task for correctness, tests, maintainability, security-sensitive handling, and blocking P0/P1 findings. Write `Review verdict: pass` only when the specification review and this quality review both pass. Write `Review verdict: fail` for any blocking finding.",
            inputs: [
              "task-plan",
              "implementation",
              "verification-report",
              "spec-review",
            ],
            outputs: [artifactOutputs.qualityReview],
            taskPlan: {
              input: "task-plan",
              role: "verify-advance",
              max_iterations: GOVERNED_PRODUCTION_TASK_LOOP_BUDGET,
              max_tasks: GOVERNED_PRODUCTION_MAX_PLAN_TASKS,
            },
          },
          {
            id: "final-review",
            type: "gate",
            mode: "review",
            runtime: "codex",
            maxAttempts: GOVERNED_PRODUCTION_TASK_LOOP_BUDGET,
            prompt:
              "Perform a holistic review after every planned task has passed specification and quality review. Write `Review verdict: pass` only when the approved design, requirement conformance, and completed task plan are ready for draft pull request publication. Write `Review verdict: fail` for any blocking finding.",
            inputs: [
              "spec",
              "tech-design",
              "task-plan",
              "conformance-report",
              "quality-review",
            ],
            outputs: [artifactOutputs.finalReview],
            taskPlan: {
              input: "task-plan",
              role: "final",
              max_tasks: GOVERNED_PRODUCTION_MAX_PLAN_TASKS,
            },
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github-cli",
            inputs: [
              "implementation",
              "pr-title",
              "conformance-report",
              "verification-report",
              "final-review",
            ],
            outputs: [artifactOutputs.changeRequest],
            conformance: {
              mode: "advisory",
              report: "conformance-report",
            },
          },
          {
            id: "release-readiness-review",
            type: "gate",
            mode: "review",
            runtime: "codex",
            prompt:
              "Review the draft pull request and release runbook for production readiness. Write `Review verdict: pass` only when verification, final-review evidence, rollback expectations, and production smoke checks are ready for release approval. Write `Review verdict: fail` for any blocking finding.",
            inputs: ["release-runbook", "change-request", "final-review"],
            outputs: [artifactOutputs.releaseReadinessReview],
          },
          {
            id: "approve-release",
            type: "approval",
            prompt:
              "Approve this release candidate and runbook before the production adapter runs.",
            inputs: [
              "release-runbook",
              "change-request",
              "release-readiness-review",
            ],
            outputs: [],
          },
          {
            id: "release",
            type: "command",
            command: "./scripts/nitely/release-production",
            timeoutMs: 1800000,
            maxAttempts: 1,
            inputs: [
              "release-runbook",
              "change-request",
              "release-readiness-review",
            ],
            outputs: [artifactOutputs.releaseReport, artifactOutputs.smokeReport],
          },
          {
            id: "post-release-review",
            type: "gate",
            mode: "review",
            runtime: "codex",
            prompt:
              "Review the atomic release and production smoke evidence against the approved runbook. Write `Review verdict: pass` only when the release and smoke evidence satisfy the runbook with no blocking follow-up. Write `Review verdict: fail` for any release failure, unresolved rollback, smoke-check gap, or blocking follow-up.",
            inputs: [
              "release-runbook",
              "change-request",
              "release-report",
              "smoke-report",
            ],
            outputs: [artifactOutputs.postReleaseReview],
          },
          {
            id: "reflect",
            type: "agent",
            runtime: "codex",
            alwaysRun: true,
            prompt:
              "Reflect on the complete issue-to-production run. Preserve actionable follow-ups, duplicates, issue closeout, and improvements to specifications, implementation, review, release, rollback, smoke checks, and observability. Write a clean result when no action remains.",
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
            outputs: [artifactOutputs.reflection],
          },
        ],
      },
    }),
  },
  {
    id: "pilot-bug-ticket-fix-pr",
    name: "Pilot: bug ticket to fix PR",
    description:
      "Convert a bug report into a regression test, fix, verification report, and draft PR.",
    flowPath: "flows/pilot-bug-ticket-fix-pr.json",
    document: asDocument({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "pilot-bug-ticket-fix-pr",
        workItemType: "dev.pr",
        inputs: [{ id: "bug-ticket" }, { id: "repo-notes" }],
      },
      spec: {
        maxAttempts: 2,
        stages: [
          {
            id: "reproduce",
            type: "agent",
            runtime: "codex",
            prompt:
              "Read the bug ticket and repository notes. Add or update the smallest regression test that fails before the fix. Do not implement the product fix in this stage. Write a regression-test artifact describing the failing test and command.",
            inputs: ["bug-ticket", "repo-notes"],
            outputs: [artifactOutputs.regressionTest],
          },
          {
            id: "fix",
            type: "agent",
            runtime: "codex",
            prompt:
              "Implement the smallest fix for the bug. Keep the regression test, update related tests if needed, and write a concise pr-title artifact.",
            inputs: ["bug-ticket", "repo-notes", "regression-test"],
            outputs: [artifactOutputs.implementation, artifactOutputs.prTitle],
          },
          {
            id: "verify",
            type: "command",
            command: "pnpm exec vitest run && pnpm run check",
            timeoutMs: 600000,
            inputs: ["regression-test", "implementation"],
            outputs: [artifactOutputs.verificationReport],
          },
          {
            id: "review",
            type: "gate",
            mode: "review",
            runtime: "codex",
            prompt:
              "Review whether the bug is reproduced, the fix is minimal, the regression test proves the behavior, and no adjacent behavior regressed. Write `Review verdict: pass` only when there are no P0/P1/blocking findings.",
            inputs: ["bug-ticket", "regression-test", "implementation", "verification-report"],
            outputs: [artifactOutputs.review],
          },
          {
            id: "publish",
            type: "publish-change",
            provider: "github-cli",
            inputs: ["regression-test", "implementation", "verification-report", "review", "pr-title"],
            outputs: [artifactOutputs.changeRequest],
          },
          {
            id: "reflect",
            type: "agent",
            runtime: "codex",
            alwaysRun: true,
            prompt:
              "Reflect on this bug-fix pilot run. Note whether the ticket was reproducible, whether the regression evidence was enough, and what follow-up workflow or product issues should be created.",
            inputs: ["bug-ticket", "regression-test", "implementation", "verification-report", "review", "change-request"],
            outputs: [artifactOutputs.reflection],
          },
        ],
      },
    }),
  },
  {
    id: "pilot-pr-review-rework",
    name: "Pilot: review feedback to PR update",
    description:
      "Apply review feedback to an existing PR branch and update the same pull request.",
    flowPath: "flows/pilot-pr-review-rework.json",
    document: asDocument({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "pilot-pr-review-rework",
        workItemType: "dev.pr",
        inputs: [{ id: "review-feedback" }, { id: "implementation-notes" }],
      },
      spec: {
        maxAttempts: 2,
        stages: [
          {
            id: "rework",
            type: "agent",
            runtime: "codex",
            prompt:
              "Apply the supplied review feedback on the existing pull request branch. Preserve unrelated code, address every blocking comment, update tests/docs when behavior changes, and write a concise pr-title artifact.",
            inputs: ["review-feedback", "implementation-notes"],
            outputs: [artifactOutputs.implementation, artifactOutputs.prTitle],
          },
          {
            id: "verify",
            type: "command",
            command: "pnpm exec vitest run && pnpm run check",
            timeoutMs: 600000,
            inputs: ["implementation"],
            outputs: [artifactOutputs.verificationReport],
          },
          {
            id: "review",
            type: "gate",
            mode: "review",
            runtime: "codex",
            prompt:
              "Review whether the requested feedback was addressed without broadening scope. Check tests, docs, and remaining unresolved P0/P1 findings. Write `Review verdict: pass` only when there are no P0/P1/blocking findings.",
            inputs: ["review-feedback", "implementation", "verification-report"],
            outputs: [artifactOutputs.review],
          },
          {
            id: "update",
            type: "update-change",
            provider: "github-cli",
            inputs: ["implementation", "verification-report", "review", "pr-title"],
            outputs: [artifactOutputs.changeRequest],
          },
          {
            id: "reflect",
            type: "agent",
            runtime: "codex",
            alwaysRun: true,
            prompt:
              "Reflect on this PR rework pilot run. Identify recurring review-feedback patterns, missing automation, unclear reviewer instructions, and follow-up issues.",
            inputs: ["review-feedback", "implementation", "verification-report", "review", "change-request"],
            outputs: [artifactOutputs.reflection],
          },
        ],
      },
    }),
  },
  {
    id: "approval-pipeline",
    name: "Approval pipeline",
    description:
      "Plan, gate on human approval, then generate — a template for gated pipelines.",
    document: asDocument({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "approval-pipeline",
        inputs: [{ id: "brief" }],
      },
      spec: {
        stages: [
          {
            id: "plan",
            type: "agent",
            runtime: "codex",
            prompt: "Produce a plan from the brief.",
            inputs: ["brief"],
            outputs: ["plan"],
          },
          {
            id: "approve-plan",
            type: "approval",
            prompt: "Approve the plan before generation.",
            inputs: ["plan"],
            outputs: [],
          },
          {
            id: "generate",
            type: "command",
            command: "true",
            inputs: ["plan"],
            outputs: ["result"],
          },
        ],
      },
    }),
  },
  {
    id: "research-pipeline",
    name: "Research pipeline",
    description:
      "Research from a task, produce an evidence-bearing report, then a structured signal.",
    document: asDocument({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: {
        name: "research-pipeline",
        inputs: [{ id: "research-task" }],
      },
      spec: {
        stages: [
          {
            id: "research",
            type: "agent",
            runtime: "codex",
            prompt: "Research the task and cite evidence.",
            inputs: ["research-task"],
            outputs: ["research-report"],
          },
          {
            id: "summarize",
            type: "command",
            command: "true",
            inputs: ["research-report"],
            outputs: ["signal"],
          },
        ],
      },
    }),
  },
];

export const flowTemplates: FlowTemplate[] =
  flowTemplateDefinitions.map(summarizeTemplate);
