import { organizationSessionAccessAllowed, type OrganizationSessionAccess } from "./session-policy.js";

import { FlowValidationError, parseFlowDocument } from "../flow/load.js";
import { flowWorkItemType, stageOutputIds } from "../flow/schema.js";
import type { ConfigurableInput, Flow } from "../flow/schema.js";
import {
  summarizeFlowArtifactGraph,
  type FlowArtifactGraphView,
} from "../flows/artifact-graph.js";
import {
  CatalogFlowNotFoundError,
  catalogFlowId,
  listCatalogFlows,
  resolveCatalogFlow,
} from "../flows/catalog.js";
import { flowRecordCustomized, type FlowOrigin, type FlowRecord } from "../flows/store.js";
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
  origin: FlowOrigin;
  enabled: boolean;
  /** A system Flow whose document was changed after it was seeded. */
  customized?: boolean;
  /** A newer shipped version exists but was not applied over a customization. */
  upstreamUpdateAvailable?: boolean;
}

export interface FlowAccessContext extends OrganizationSessionAccess {
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
  record: FlowRecord;
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
    runnable: input.runnable && input.record.enabled,
    editable: input.editable,
    ...(input.template ? { template: input.template } : {}),
    origin: input.record.origin,
    enabled: input.record.enabled,
    ...(input.record.origin === "system"
      ? {
          customized: flowRecordCustomized(input.record),
          upstreamUpdateAvailable: Boolean(input.record.seed?.availableHash),
        }
      : {}),
  };
}

function flowSource(record: FlowRecord): FlowSource {
  return record.origin === "system" ? "builtin" : "user";
}

/**
 * System Flows have no owner; only an administrator (or anyone in local mode)
 * may customize or disable them.
 */
export function systemFlowWritableByUser(user?: FlowAccessContext): boolean {
  return !user || user.authMode === "local" || user.role === "admin";
}

function catalogRecordVisibleToUser(record: FlowRecord, user?: FlowAccessContext): boolean {
  return record.origin === "system" || flowRecordVisibleToUser(record, user);
}

function catalogRecordWritableByUser(record: FlowRecord, user?: FlowAccessContext): boolean {
  return record.origin === "system"
    ? systemFlowWritableByUser(user)
    : flowRecordWritableByUser(record, user);
}

export function flowRecordVisibleToUser(
  record: Pick<FlowRecord, "ownerId" | "organizationId">,
  user?: FlowAccessContext,
): boolean {
  if (!organizationSessionAccessAllowed(user, record.organizationId)) return false;
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
  if (!organizationSessionAccessAllowed(user, record.organizationId)) return false;
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

/**
 * The catalog: system Flows seeded from the repository's and this
 * installation's `flows/`, plus stored user Flows, all read from the Flow
 * store. User Flows are listed first, as before.
 */
export async function listFlowViews(
  repoPath: string,
  user?: FlowAccessContext,
): Promise<FlowView[]> {
  const records = (await listCatalogFlows(repoPath)).filter((record) =>
    catalogRecordVisibleToUser(record, user),
  );
  const views = await Promise.all(
    records.map(async (record) => {
      const report = await validateFlowDocument(repoPath, record.document);
      return summarizeFlow({
        id: catalogFlowId(record),
        source: flowSource(record),
        document: record.document,
        runnable: report.valid,
        editable: catalogRecordWritableByUser(record, user),
        template: record.template,
        record,
      });
    }),
  );
  const userViews = views.filter((view) => view.source === "user");
  const builtin = views
    .filter((view) => view.source === "builtin")
    .sort((a, b) => a.id.localeCompare(b.id));
  return [...userViews, ...builtin];
}

async function flowDocumentById(
  repoPath: string,
  id: string,
): Promise<{ document: string; source: FlowSource; record: FlowRecord }> {
  try {
    const resolved = await resolveCatalogFlow(repoPath, id, { requireEnabled: false });
    return {
      document: resolved.document,
      source: flowSource(resolved.record),
      record: resolved.record,
    };
  } catch (error) {
    if (error instanceof CatalogFlowNotFoundError) {
      throw new WebNotFoundError("flow not found");
    }
    throw error;
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
  if (!catalogRecordVisibleToUser(record, user)) {
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
      id: catalogFlowId(record),
      source,
      document,
      runnable: report.valid,
      editable: catalogRecordWritableByUser(record, user),
      ...(record.template ? { template: record.template } : {}),
      record,
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
