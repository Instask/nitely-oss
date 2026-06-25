export interface FlowTemplate {
  id: string;
  name: string;
  description: string;
  document: string;
}

function asDocument(flow: unknown): string {
  return JSON.stringify(flow, null, 2);
}

/**
 * Built-in starting points for the flow editor. Each document validates against
 * `validateFlowDocument`, so "New Flow → choose template" yields a runnable draft.
 */
export const flowTemplates: FlowTemplate[] = [
  {
    id: "dev-pr",
    name: "Dev PR",
    description:
      "Implement a spec and technical design, run tests, review, and open a pull request.",
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
            id: "implement",
            type: "agent",
            runtime: "codex",
            prompt: "Implement the supplied specification and technical design.",
            inputs: ["spec", "tech-design"],
            outputs: ["implementation", "pr-title"],
          },
          {
            id: "test",
            type: "command",
            command: "pnpm exec vitest run",
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
