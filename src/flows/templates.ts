import { parseFlowDocument } from "../flow/load.js";
import { inputContractHasDefaultSource } from "../flow/inputs.js";
import { flowWorkItemType, stageOutputIds } from "../flow/schema.js";
import type { ConfigurableInput, Flow, Stage } from "../flow/schema.js";
import {
  summarizeFlowArtifactGraph,
  type FlowArtifactContractView,
  type FlowArtifactGraphView,
} from "./artifact-graph.js";
import {
  CatalogFlowDisabledError,
  CatalogFlowNotFoundError,
  catalogFlowSummary,
  resolveCatalogFlow,
  type FlowCatalogOptions,
} from "./catalog.js";
import { flowDocumentHash } from "./store.js";
import { inferExternalInputs } from "./validate.js";

/**
 * Flow templates are named starting points over built-in Flows. They carry no
 * documents of their own: each one points at a `flows/<name>.json` seed, and
 * its document is read from the Flow store like any other runtime lookup, so
 * an edited or disabled built-in Flow is what a template uses too.
 */

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
  /**
   * Template contract version, unchanged from the hardcoded templates so stored
   * lineage (`templateVersion`) stays comparable.
   */
  version: string;
  /** Digest (`sha256:…`) of the stored Flow document the template reads now. */
  documentHash: string;
  taskFamily: string;
  /** The built-in Flow's seed key, `flows/<name>.json`. */
  flowPath: string;
  /** Whether the built-in Flow has been edited from its shipped version. */
  edited: boolean;
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

/** A template id, its catalog labels, and the built-in Flow it reads. */
export interface FlowTemplateEntry {
  id: string;
  name: string;
  description: string;
  flowPath: string;
}

/**
 * Template ids are stored on existing work items (`template.templateId`, and a
 * `template:<id>` flow path), so these ids must keep resolving.
 */
export const FLOW_TEMPLATE_ENTRIES: readonly FlowTemplateEntry[] = [
  {
    id: "plan-approve-implement",
    name: "Plan, approve, implement",
    description:
      "Generate a spec and technical design inside the workflow, pause for human approval, then implement and publish.",
    flowPath: "flows/plan-approve-implement-bootstrap.json",
  },
  {
    id: "dev-pr",
    name: "Dev PR",
    description:
      "Implement a spec and technical design, run tests, review, and open a pull request.",
    flowPath: "flows/implement-spec-bootstrap.json",
  },
  {
    id: "rework-pr",
    name: "Rework PR",
    description:
      "Apply review feedback to an existing pull request branch via update-change.",
    flowPath: "flows/rework-pr-bootstrap.json",
  },
  {
    id: "converge-feature-artifacts",
    name: "Converge feature artifacts",
    description:
      "Compare the current implementation with a spec, plan, and task artifact, then append traceable remaining work.",
    flowPath: "flows/converge-feature-artifacts.json",
  },
  {
    id: "pilot-approved-spec-pr",
    name: "Pilot: approved spec to PR",
    description:
      "Turn an approved spec and technical design into a reviewed draft PR with evidence.",
    flowPath: "flows/pilot-approved-spec-pr.json",
  },
  {
    id: "pilot-issue-to-production",
    name: "Pilot: issue to production",
    description:
      "Turn an issue into approved plans, a reviewed draft PR, and an explicitly approved production release.",
    flowPath: "flows/pilot-issue-to-production.json",
  },
  {
    id: "pilot-bug-ticket-fix-pr",
    name: "Pilot: bug ticket to fix PR",
    description:
      "Convert a bug report into a regression test, fix, verification report, and draft PR.",
    flowPath: "flows/pilot-bug-ticket-fix-pr.json",
  },
  {
    id: "pilot-pr-review-rework",
    name: "Pilot: review feedback to PR update",
    description:
      "Apply review feedback to an existing PR branch and update the same pull request.",
    flowPath: "flows/pilot-pr-review-rework.json",
  },
  {
    id: "approval-pipeline",
    name: "Approval pipeline",
    description:
      "Plan, gate on human approval, then generate — a template for gated pipelines.",
    flowPath: "flows/approval-pipeline.json",
  },
  {
    id: "research-pipeline",
    name: "Research pipeline",
    description:
      "Research from a task, produce an evidence-bearing report, then a structured signal.",
    flowPath: "flows/research-pipeline.json",
  },
];

export const FLOW_TEMPLATE_VERSION = "1.0.0";

export function flowTemplateEntry(id: string): FlowTemplateEntry | undefined {
  return FLOW_TEMPLATE_ENTRIES.find((entry) => entry.id === id);
}

function sorted(values: Iterable<string | undefined>): string[] {
  return [...new Set([...values].filter((value): value is string => !!value))]
    .sort((left, right) => left.localeCompare(right));
}

function asDocument(flow: unknown): string {
  return JSON.stringify(flow, null, 2);
}

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

/**
 * External inputs of a template's Flow, the same set the validator infers:
 * the declared `metadata.inputs` plus every input a stage consumes that no
 * stage produces. A declared input keeps its type and is optional when it has
 * a default source; an undeclared external input is always required.
 */
function templateInputs(flow: Flow, document: string): FlowTemplateInput[] {
  const inputs: FlowTemplateInput[] = [];
  const seen = new Set<string>();
  for (const input of flow.metadata.inputs ?? []) {
    if (seen.has(input.id)) continue;
    seen.add(input.id);
    inputs.push({
      id: input.id,
      ...(input.type ? { type: input.type } : {}),
      required: !inputContractHasDefaultSource(input),
    });
  }
  for (const id of inferExternalInputs(document)) {
    if (seen.has(id)) continue;
    seen.add(id);
    inputs.push({ id, required: true });
  }
  return inputs;
}

function summarizeTemplate(
  entry: FlowTemplateEntry,
  document: string,
  edited: boolean,
): FlowTemplate {
  const externalInputs = inferExternalInputs(document);
  const loaded = parseFlowDocument(document, { externalInputs });
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
    id: entry.id,
    name: entry.name,
    description: entry.description,
    version: FLOW_TEMPLATE_VERSION,
    documentHash: flowDocumentHash(document),
    taskFamily: flowWorkItemType(flow),
    flowPath: entry.flowPath,
    edited,
    inputs: templateInputs(flow, document),
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
    document,
  };
}

export interface GetFlowTemplateOptions extends FlowCatalogOptions {
  /** Reject a template whose built-in Flow is disabled. Defaults to true. */
  requireEnabled?: boolean;
}

/**
 * Resolve a template through the Flow catalog. Returns undefined for an
 * unknown template id or a built-in Flow that no longer ships; throws
 * `CatalogFlowDisabledError` for a disabled one unless `requireEnabled` is
 * false.
 */
export async function getFlowTemplate(
  repoPath: string,
  id: string,
  options: GetFlowTemplateOptions = {},
): Promise<FlowTemplate | undefined> {
  const entry = flowTemplateEntry(id);
  if (!entry) return undefined;
  try {
    const resolved = await resolveCatalogFlow(repoPath, entry.flowPath, options);
    return summarizeTemplate(entry, resolved.document, catalogFlowSummary(resolved.record).edited);
  } catch (error) {
    if (error instanceof CatalogFlowNotFoundError) return undefined;
    throw error;
  }
}

/** Every template whose built-in Flow is present and enabled. */
export async function listFlowTemplates(
  repoPath: string,
  options: FlowCatalogOptions = {},
): Promise<FlowTemplate[]> {
  const templates: FlowTemplate[] = [];
  for (const entry of FLOW_TEMPLATE_ENTRIES) {
    try {
      const template = await getFlowTemplate(repoPath, entry.id, options);
      if (template) templates.push(template);
    } catch (error) {
      // A disabled built-in Flow is not offered as a starting point. Anything
      // else (an invalid stored document, a store or filesystem failure) is a
      // real fault and must not silently drop the template.
      if (error instanceof CatalogFlowDisabledError) continue;
      throw error;
    }
  }
  return templates;
}

export function flowTemplateLineage(
  template: FlowTemplate,
): FlowTemplateLineage {
  return {
    templateId: template.id,
    templateVersion: template.version,
    source: "builtin",
    sourceFlowPath: template.flowPath,
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


