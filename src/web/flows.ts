import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { FlowValidationError, parseFlowDocument } from "../flow/load.js";
import { flowWorkItemType, stageOutputIds } from "../flow/schema.js";
import type { ConfigurableInput, Flow } from "../flow/schema.js";
import {
  summarizeFlowArtifactGraph,
  type FlowArtifactGraphView,
} from "../flows/artifact-graph.js";
import { bundledFlowsRoot, resolveBuiltinFlowPath } from "../flows/paths.js";
import { openFlowStore, type FlowRecord } from "../flows/store.js";
import type { FlowTemplateLineage } from "../flows/templates.js";
import { inferExternalInputs, validateFlowDocument } from "../flows/validate.js";
import { WebNotFoundError } from "./errors.js";
import {
  type PublicOrganizationMembership,
} from "./organizations.js";
import { organizationRoleHasPermission } from "./access-control.js";
import { listRuns, type WebRunSummary } from "./runs.js";

export type FlowSource = "builtin" | "user";

export interface FlowView {
  id: string;
  name: string;
  source: FlowSource;
  workItemType?: string;
  stageCount: number;
  runnable: boolean;
  editable: boolean;
  template?: FlowTemplateLineage;
}

export interface FlowAccessContext {
  id: string;
  role: "admin" | "user";
  authMode: "local" | "required";
  memberships?: PublicOrganizationMembership[];
}

export interface FlowStageView {
  id: string;
  type: string;
  inputs: string[];
  outputs: string[];
}

export interface FlowInputView {
  id: string;
  type?: string;
}

export interface FlowDetailView extends FlowView {
  document: string;
  stages: FlowStageView[];
  inputs: FlowInputView[];
  configurables: ConfigurableInput[];
  artifactGraph?: FlowArtifactGraphView;
  gates: string[];
  runs: WebRunSummary[];
}

function flowMetadataName(document: string): string | undefined {
  try {
    const parsed = JSON.parse(document) as { metadata?: { name?: unknown } };
    return typeof parsed.metadata?.name === "string"
      ? parsed.metadata.name
      : undefined;
  } catch {
    return undefined;
  }
}

function summarizeFlow(input: {
  id: string;
  source: FlowSource;
  document: string;
  runnable: boolean;
  template?: FlowTemplateLineage;
  editable: boolean;
}): FlowView {
  let flow: Flow | undefined;
  try {
    flow = parseFlowDocument(input.document, {
      externalInputs: inferExternalInputs(input.document),
    }).flow;
  } catch {
    flow = undefined;
  }
  return {
    id: input.id,
    name: flow?.metadata.name ?? flowMetadataName(input.document) ?? input.id,
    source: input.source,
    ...(flow ? { workItemType: flowWorkItemType(flow) } : {}),
    stageCount: flow?.spec.stages.length ?? 0,
    runnable: input.runnable,
    editable: input.editable,
    ...(input.template ? { template: input.template } : {}),
  };
}

export function flowRecordVisibleToUser(
  record: Pick<FlowRecord, "ownerId" | "organizationId">,
  user?: FlowAccessContext,
): boolean {
  if (!user || user.authMode === "local" || user.role === "admin") {
    return true;
  }
  if (record.organizationId) {
    return (user.memberships ?? []).some(
      (membership) => membership.organizationId === record.organizationId,
    );
  }
  return record.ownerId === user.id;
}

export function flowRecordWritableByUser(
  record: Pick<FlowRecord, "ownerId" | "organizationId">,
  user?: FlowAccessContext,
): boolean {
  if (!user || user.authMode === "local" || user.role === "admin") {
    return true;
  }
  if (record.organizationId) {
    const role = (user.memberships ?? []).find(
      (membership) => membership.organizationId === record.organizationId,
    )?.role;
    return organizationRoleHasPermission(role, "flows:manage");
  }
  return record.ownerId === user.id;
}

async function readFlowEntries(root: string): Promise<string[]> {
  try {
    return await readdir(join(resolve(root), "flows"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * Built-in flows are the repository's `flows/` plus the flows shipped with this
 * installation; resolveBuiltinFlowPath lets the repository's copy win.
 */
async function readBuiltinFlows(
  repoPath: string,
): Promise<Array<{ id: string; document: string }>> {
  const entries = [
    ...new Set([
      ...(await readFlowEntries(repoPath)),
      ...(await readFlowEntries(bundledFlowsRoot())),
    ]),
  ].sort();
  const flows = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => {
        try {
          const id = `flows/${entry}`;
          const resolved = await resolveBuiltinFlowPath(repoPath, id);
          const document = await readFile(resolved.absolutePath, "utf8");
          return { id: resolved.flowPath, document };
        } catch {
          return undefined;
        }
      }),
  );
  return flows.filter(
    (flow): flow is { id: string; document: string } => flow !== undefined,
  );
}

export async function listFlowViews(
  repoPath: string,
  user?: FlowAccessContext,
): Promise<FlowView[]> {
  const builtin = await readBuiltinFlows(repoPath);
  const builtinViews = await Promise.all(
    builtin.map(async (flow) => {
      const report = await validateFlowDocument(repoPath, flow.document);
      return summarizeFlow({
        id: flow.id,
        source: "builtin",
        document: flow.document,
        runnable: report.valid,
        editable: false,
      });
    }),
  );

  const store = openFlowStore(repoPath);
  let userViews: FlowView[];
  try {
    userViews = await Promise.all(
      store
        .listFlows()
        .filter((record) => flowRecordVisibleToUser(record, user))
        .map(async (record) => {
          const report = await validateFlowDocument(repoPath, record.document);
          return summarizeFlow({
            id: record.id,
            source: "user",
            document: record.document,
            runnable: report.valid,
            editable: flowRecordWritableByUser(record, user),
            template: record.template,
          });
        }),
    );
  } finally {
    store.close();
  }

  return [...userViews, ...builtinViews];
}

function flowDocumentById(
  repoPath: string,
  id: string,
): Promise<{ document: string; source: FlowSource; record?: FlowRecord }> {
  if (id.startsWith("flows/")) {
    return resolveBuiltinFlowPath(repoPath, id)
      .then((resolved) => readFile(resolved.absolutePath, "utf8"))
      .then((document) => ({ document, source: "builtin" as const }))
      .catch(() => {
        throw new WebNotFoundError("flow not found");
      });
  }
  const store = openFlowStore(repoPath);
  try {
    const record = store.getFlow(id);
    return Promise.resolve({
      document: record.document,
      source: "user" as const,
      record,
    });
  } finally {
    store.close();
  }
}

function runMatchesFlow(run: WebRunSummary, id: string, flowName?: string): boolean {
  if (run.workItemId && id.startsWith("flow-")) {
    // user flows: run associated via flowPath label equal to the flow id
    return run.flowPath === id;
  }
  if (id.startsWith("flows/")) {
    return run.flowPath === id || (!!flowName && run.flowName === flowName);
  }
  return run.flowPath === id;
}

export async function getFlowView(
  repoPath: string,
  id: string,
  user?: FlowAccessContext,
): Promise<FlowDetailView> {
  const { document, source, record } = await flowDocumentById(repoPath, id);
  if (record && !flowRecordVisibleToUser(record, user)) {
    throw new WebNotFoundError("flow not found");
  }
  const report = await validateFlowDocument(repoPath, document);

  let stages: FlowStageView[] = [];
  let inputs: FlowInputView[] = [];
  let configurables: ConfigurableInput[] = [];
  let artifactGraph: FlowArtifactGraphView | undefined;
  let gates: string[] = [];
  let flowName: string | undefined;
  try {
    const loaded = parseFlowDocument(document, {
      externalInputs: inferExternalInputs(document),
    });
    const flow = loaded.flow;
    flowName = flow.metadata.name;
    stages = flow.spec.stages.map((stage) => ({
      id: stage.id,
      type: stage.type,
      inputs: stage.inputs,
      outputs: stageOutputIds(stage),
    }));
    artifactGraph = summarizeFlowArtifactGraph(flow, loaded.graph);
    inputs = (flow.metadata.inputs ?? []).map((contract) => ({
      id: contract.id,
      ...(contract.type ? { type: contract.type } : {}),
    }));
    configurables = flow.metadata.configurables;
    gates = flow.spec.stages
      .filter((stage) => stage.type === "approval")
      .map((stage) => stage.id);
  } catch (error) {
    if (!(error instanceof FlowValidationError)) {
      throw error;
    }
  }

  const runs = (await listRuns(repoPath)).filter((run) =>
    runMatchesFlow(run, id, flowName),
  );

  return {
    ...summarizeFlow({
      id,
      source,
      document,
      runnable: report.valid,
      editable: record ? flowRecordWritableByUser(record, user) : false,
      ...(record?.template ? { template: record.template } : {}),
    }),
    document,
    stages,
    inputs,
    configurables,
    ...(artifactGraph ? { artifactGraph } : {}),
    gates,
    runs,
  };
}
