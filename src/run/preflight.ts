import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { resolveLocalFileResource } from "../connectors/local-file.js";
import type { ResourceReference } from "../connectors/types.js";
import { flowInputReferences } from "../flow/inputs.js";
import { parseFlowDocument, type LoadedFlow, FlowValidationError } from "../flow/load.js";
import { stageDependencyRequirements } from "../flow/requirements.js";
import {
  stageOutputIds,
  stageRuntimeCandidates,
  type Flow,
  type Stage,
} from "../flow/schema.js";
import { openFlowStore } from "../flows/store.js";
import { getFlowTemplate } from "../flows/templates.js";
import { resolveRepositoryFlowPath } from "../flows/paths.js";
import { resolveProviderStore } from "../providers/index.js";
import type {
  ProviderConnectionStatus,
  ProviderConnectionStore,
  ProviderId,
} from "../providers/types.js";
import type { WorkItemRecord } from "../work-items/types.js";

export type RunPreflightStatus = "PASS" | "WARN" | "BLOCK";

export interface RunPreflightIssue {
  severity: "warning" | "blocking";
  code:
    | "repo-unavailable"
    | "flow-unreadable"
    | "flow-invalid"
    | "missing-input"
    | "input-unreadable"
    | "missing-provider"
    | "unknown-mcp-server"
    | "runtime-unavailable"
    | "runtime-unchecked"
    | "provider-unchecked"
    | "missing-skill"
    | "output-directory-unwritable";
  message: string;
  remediation: string;
  stageId?: string;
  inputId?: string;
  providerId?: ProviderId;
  mcpServer?: string;
  runtime?: string;
  path?: string;
}

export interface RunPreflightReport {
  status: RunPreflightStatus;
  summary: string;
  flowPath: string;
  flowName?: string;
  stageCount: number;
  artifactCount: number;
  requiredInputs: string[];
  requiredProviders: ProviderId[];
  outputDirectory: string;
  executionPlan: Array<{
    id: string;
    type: Stage["type"];
    inputs: string[];
    outputs: string[];
  }>;
  issues: RunPreflightIssue[];
}

export interface EvaluateRunPreflightInput {
  repoPath: string;
  flowPath: string;
  flowDocument?: string;
  inputs?: Record<string, ResourceReference>;
  providerStore?: ProviderConnectionStore;
}

export interface EvaluateWorkItemRunPreflightInput {
  repoPath: string;
  workItem: WorkItemRecord;
  providerStore?: ProviderConnectionStore;
}

function issue(
  severity: RunPreflightIssue["severity"],
  code: RunPreflightIssue["code"],
  message: string,
  remediation: string,
  extra: Omit<
    RunPreflightIssue,
    "severity" | "code" | "message" | "remediation"
  > = {},
): RunPreflightIssue {
  return { severity, code, message, remediation, ...extra };
}

function summarizePreflight(
  base: Omit<RunPreflightReport, "status" | "summary">,
): RunPreflightReport {
  if (base.issues.some((item) => item.severity === "blocking")) {
    return {
      ...base,
      status: "BLOCK",
      summary: "run preflight blocks execution",
    };
  }
  if (base.issues.length > 0) {
    return {
      ...base,
      status: "WARN",
      summary: "run preflight has warnings",
    };
  }
  return {
    ...base,
    status: "PASS",
    summary: "run preflight passed",
  };
}

function emptyReport(input: {
  flowPath: string;
  outputDirectory: string;
  issues: RunPreflightIssue[];
}): RunPreflightReport {
  return summarizePreflight({
    flowPath: input.flowPath,
    stageCount: 0,
    artifactCount: 0,
    requiredInputs: [],
    requiredProviders: [],
    outputDirectory: input.outputDirectory,
    executionPlan: [],
    issues: input.issues,
  });
}

async function loadPreflightFlow(
  input: EvaluateRunPreflightInput & { repoPath: string },
  externalInputs: string[],
): Promise<LoadedFlow | RunPreflightIssue> {
  try {
    if (input.flowDocument !== undefined) {
      return parseFlowDocument(input.flowDocument, { externalInputs });
    }
    const flowPath = resolve(input.repoPath, input.flowPath);
    return parseFlowDocument(await readFile(flowPath, "utf8"), { externalInputs });
  } catch (error) {
    if (error instanceof FlowValidationError) {
      return issue(
        "blocking",
        "flow-invalid",
        error.errors[0] ?? error.message,
        "Fix the flow JSON/schema/DAG before starting a run.",
        { path: input.flowPath },
      );
    }
    return issue(
      "blocking",
      "flow-unreadable",
      `flow could not be read: ${input.flowPath}`,
      "Ensure the flow exists and is readable from the repository.",
      { path: input.flowPath },
    );
  }
}

function runtimeProvider(runtime: string): ProviderId | undefined {
  const normalized = runtime.trim().toLowerCase();
  if (normalized === "codex" || normalized === "openai") return "codex";
  if (normalized === "claude" || normalized === "anthropic") return "anthropic";
  if (normalized === "glm" || normalized === "zhipu") return "glm";
  if (normalized === "grok" || normalized === "xai") return "grok";
  if (normalized === "pi") return "pi";
  return undefined;
}

function hasRuntimeCandidates(
  stage: Stage,
): stage is Extract<Stage, { type: "agent" }> | Extract<Stage, { type: "gate"; mode: "review" }> {
  return stage.type === "agent" || stage.type === "judge" || (stage.type === "gate" && stage.mode === "review");
}

function inputIdsRequiredByFlow(flow: Flow, loaded: LoadedFlow): string[] {
  const required = new Set(
    (flow.metadata.inputs ?? []).map((input) => input.id),
  );
  for (const stage of flow.spec.stages) {
    for (const inputId of stage.inputs) {
      if (!loaded.graph.producerByArtifact.has(inputId)) {
        required.add(inputId);
      }
    }
  }
  return [...required].sort();
}

function executionPlan(flow: Flow): RunPreflightReport["executionPlan"] {
  return flow.spec.stages.map((stage) => ({
    id: stage.id,
    type: stage.type,
    inputs: [...stage.inputs],
    outputs: stageOutputIds(stage),
  }));
}

async function providerStatuses(
  repoPath: string,
  providerStore?: ProviderConnectionStore,
): Promise<ProviderConnectionStatus[]> {
  const store =
    providerStore ??
    resolveProviderStore(
      resolve(repoPath, ".nitely"),
      process.env,
    );
  return store.listStatuses();
}

function configuredProviderMap(
  statuses: ProviderConnectionStatus[],
): Map<ProviderId, ProviderConnectionStatus> {
  return new Map(statuses.map((status) => [status.id, status]));
}

async function checkRepo(repoPath: string): Promise<RunPreflightIssue[]> {
  try {
    const result = await stat(repoPath);
    if (result.isDirectory()) return [];
  } catch {
    // Fall through to the common issue below.
  }
  return [
    issue(
      "blocking",
      "repo-unavailable",
      `repository path is not available: ${repoPath}`,
      "Choose an existing repository path before starting a run.",
      { path: repoPath },
    ),
  ];
}

async function checkOutputDirectory(
  repoPath: string,
  outputDirectory: string,
): Promise<RunPreflightIssue[]> {
  let candidate = resolve(repoPath, outputDirectory);
  while (true) {
    try {
      const metadata = await stat(candidate);
      if (!metadata.isDirectory()) break;
      await access(candidate, constants.W_OK | constants.X_OK);
      return [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") break;
      const parent = dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }
  return [
    issue(
      "blocking",
      "output-directory-unwritable",
      `preflight output directory is not writable: ${outputDirectory}`,
      "Fix repository permissions or choose a writable runtime state directory.",
      { path: outputDirectory },
    ),
  ];
}

async function checkInputFiles(input: {
  repoPath: string;
  requiredInputs: string[];
  inputs: Record<string, ResourceReference>;
}): Promise<RunPreflightIssue[]> {
  const issues: RunPreflightIssue[] = [];
  for (const inputId of input.requiredInputs) {
    const reference = input.inputs[inputId];
    if (!reference) {
      issues.push(
        issue(
          "blocking",
          "missing-input",
          `required input is missing: ${inputId}`,
          "Attach the input artifact or choose a flow whose required inputs are satisfied.",
          { inputId },
        ),
      );
      continue;
    }
    if (reference.connector !== "local-file") continue;
    try {
      await resolveLocalFileResource(input.repoPath, reference, {
        allowedRoots: [process.cwd()],
      });
    } catch {
      issues.push(
        issue(
          "blocking",
          "input-unreadable",
          `required local-file input is not readable: ${inputId}`,
          "Regenerate or reattach the local input file before starting a run.",
          { inputId, path: reference.uri },
        ),
      );
    }
  }
  return issues;
}

async function checkRequiredSkill(repoPath: string, skillId: string): Promise<boolean> {
  try {
    await stat(resolve(repoPath, ".nitely", "skills", skillId, "SKILL.md"));
    return true;
  } catch {
    return false;
  }
}

function addMissingProviderIssue(input: {
  issues: RunPreflightIssue[];
  statuses: Map<ProviderId, ProviderConnectionStatus>;
  requiredProviders: Set<ProviderId>;
  providerId: ProviderId;
  stageId: string;
}): void {
  input.requiredProviders.add(input.providerId);
  const status = input.statuses.get(input.providerId);
  if (status?.configured) return;
  input.issues.push(
    issue(
      "blocking",
      "missing-provider",
      `stage ${input.stageId} requires unconfigured provider: ${input.providerId}`,
      status?.message || `Configure provider ${input.providerId}.`,
      { stageId: input.stageId, providerId: input.providerId },
    ),
  );
}

function checkChangeProvider(input: {
  stage: Stage;
  issues: RunPreflightIssue[];
  statuses: Map<ProviderId, ProviderConnectionStatus>;
  requiredProviders: Set<ProviderId>;
}): void {
  if (input.stage.type !== "publish-change" && input.stage.type !== "update-change") {
    return;
  }
  const provider =
    input.stage.type === "publish-change"
      ? input.stage.provider ?? "github"
      : input.stage.provider;
  if (provider === "github") {
    addMissingProviderIssue({
      issues: input.issues,
      statuses: input.statuses,
      requiredProviders: input.requiredProviders,
      providerId: "github",
      stageId: input.stage.id,
    });
    return;
  }
  input.issues.push(
    issue(
      "warning",
      "provider-unchecked",
      provider
        ? `stage ${input.stage.id} uses SCM provider with no preflight mapping: ${provider}`
        : `stage ${input.stage.id} resolves its SCM provider from the change request target`,
      "Confirm the SCM provider is authenticated before starting the run.",
      { stageId: input.stage.id, runtime: provider },
    ),
  );
}

async function stageIssues(input: {
  repoPath: string;
  flow: Flow;
  statuses: Map<ProviderId, ProviderConnectionStatus>;
  requiredProviders: Set<ProviderId>;
  providerStore?: ProviderConnectionStore;
}): Promise<RunPreflightIssue[]> {
  const issues: RunPreflightIssue[] = [];
  for (const stage of input.flow.spec.stages) {
    checkChangeProvider({
      stage,
      issues,
      statuses: input.statuses,
      requiredProviders: input.requiredProviders,
    });

    const requirements = stageDependencyRequirements(stage);
    for (const providerId of requirements.providerIds) {
      addMissingProviderIssue({
        issues,
        statuses: input.statuses,
        requiredProviders: input.requiredProviders,
        providerId,
        stageId: stage.id,
      });
    }
    for (const mcpServer of requirements.unknownMcpServers) {
      issues.push(
        issue(
          "blocking",
          "unknown-mcp-server",
          `stage ${stage.id} requires unknown MCP server: ${mcpServer}`,
          "Map this MCP server to a provider requirement or remove it from the flow.",
          { stageId: stage.id, mcpServer },
        ),
      );
    }

    if ("skills" in stage) {
      for (const skillId of stage.skills ?? []) {
        if (await checkRequiredSkill(input.repoPath, skillId)) continue;
        issues.push(
          issue(
            "blocking",
            "missing-skill",
            `stage ${stage.id} requires missing skill: ${skillId}`,
            "Import the required skill into the repository before starting a run.",
            { stageId: stage.id, path: `.nitely/skills/${skillId}/SKILL.md` },
          ),
        );
      }
    }

    if (!hasRuntimeCandidates(stage)) continue;
    const candidates = stageRuntimeCandidates(stage);
    const mapped = candidates
      .map((candidate) => ({
        runtime: candidate.runtime,
        providerId: runtimeProvider(candidate.runtime),
      }))
      .filter(
        (candidate): candidate is { runtime: string; providerId: ProviderId } =>
          candidate.providerId !== undefined,
      );
    if (mapped.length === 0) {
      for (const candidate of candidates) {
        if (candidate.runtime.toLowerCase() === "mock") continue;
        issues.push(
          issue(
            "warning",
            "runtime-unchecked",
            `stage ${stage.id} uses runtime with no preflight mapping: ${candidate.runtime}`,
            "Add a provider mapping for this runtime if it must be checked before execution.",
            { stageId: stage.id, runtime: candidate.runtime },
          ),
        );
      }
      continue;
    }
    for (const candidate of mapped) {
      input.requiredProviders.add(candidate.providerId);
    }
    if (
      !mapped.some(
        (candidate) => input.statuses.get(candidate.providerId)?.configured,
      )
    ) {
      const first = mapped[0];
      const sources = input.providerStore?.describeCredentialSources?.() ?? [];
      const remediation = sources.length > 0
        ? `Configure one of the stage runtime providers before starting a run. Credentials are read from ${sources.join(" then ")}.`
        : `Configure one of the stage runtime providers before starting a run. Credentials are read per repository from ${
            join(input.repoPath, ".nitely", "connections.json")
          }, and a signed-in Web Console user may also hold their own under .nitely/users/.`;
      issues.push(
        issue(
          "blocking",
          "runtime-unavailable",
          `stage ${stage.id} has no configured runtime candidate: ${
            candidates.map((candidate) => candidate.runtime).join(", ")
          }`,
          remediation,
          {
            stageId: stage.id,
            runtime: candidates.map((candidate) => candidate.runtime).join(", "),
            providerId: first?.providerId,
          },
        ),
      );
    }
  }
  return issues;
}

export async function evaluateRunPreflight(
  input: EvaluateRunPreflightInput,
): Promise<RunPreflightReport> {
  const repoPath = resolve(input.repoPath);
  const outputDirectory = ".nitely/preflight";
  const repoIssues = await checkRepo(repoPath);
  if (repoIssues.length > 0) {
    return emptyReport({
      flowPath: input.flowPath,
      outputDirectory,
      issues: repoIssues,
    });
  }

  const inputs = input.inputs ?? {};
  const loaded = await loadPreflightFlow(input, Object.keys(inputs));
  if ("severity" in loaded) {
    return emptyReport({
      flowPath: input.flowPath,
      outputDirectory,
      issues: [loaded],
    });
  }

  const flow = loaded.flow;
  const effectiveInputs = flowInputReferences(flow, inputs);
  const requiredInputs = inputIdsRequiredByFlow(flow, loaded);
  const requiredProviders = new Set<ProviderId>();
  const statuses = configuredProviderMap(
    await providerStatuses(repoPath, input.providerStore),
  );
  const issues = [
    ...(await checkOutputDirectory(repoPath, outputDirectory)),
    ...(await checkInputFiles({
      repoPath,
      requiredInputs,
      inputs: effectiveInputs,
    })),
    ...(await stageIssues({
      repoPath,
      flow,
      statuses,
      requiredProviders,
      providerStore: input.providerStore,
    })),
  ];

  return summarizePreflight({
    flowPath: input.flowPath,
    flowName: flow.metadata.name,
    stageCount: flow.spec.stages.length,
    artifactCount: loaded.graph.producerByArtifact.size,
    requiredInputs,
    requiredProviders: [...requiredProviders].sort(),
    outputDirectory,
    executionPlan: executionPlan(flow),
    issues,
  });
}

export async function evaluateWorkItemRunPreflight(
  input: EvaluateWorkItemRunPreflightInput,
): Promise<RunPreflightReport> {
  if (input.workItem.flowId) {
    const flowStore = openFlowStore(input.repoPath);
    try {
      const flow = flowStore.getFlow(input.workItem.flowId);
      return evaluateRunPreflight({
        repoPath: input.repoPath,
        flowPath: input.workItem.flowId,
        flowDocument: flow.document,
        inputs: input.workItem.inputs,
        providerStore: input.providerStore,
      });
    } finally {
      flowStore.close();
    }
  }
  if (input.workItem.template) {
    const template = getFlowTemplate(input.workItem.template.templateId);
    if (template) {
      return evaluateRunPreflight({
        repoPath: input.repoPath,
        flowPath: input.workItem.flowPath,
        flowDocument: template.document,
        inputs: input.workItem.inputs,
        providerStore: input.providerStore,
      });
    }
  }
  const resolvedFlowPath = await resolveRepositoryFlowPath(
    input.repoPath,
    input.workItem.flowPath,
  );
  return evaluateRunPreflight({
    repoPath: input.repoPath,
    flowPath: resolvedFlowPath.absolutePath,
    inputs: input.workItem.inputs,
    providerStore: input.providerStore,
  });
}

export function formatRunPreflightError(report: RunPreflightReport): string {
  const details = report.issues
    .filter((item) => item.severity === "blocking")
    .slice(0, 3)
    .map((item) => item.message)
    .join("; ");
  return ["run preflight blocks execution", details]
    .filter(Boolean)
    .join(": ");
}
