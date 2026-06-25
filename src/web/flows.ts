import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { FlowValidationError, parseFlowDocument } from "../flow/load.js";
import { flowWorkItemType, stageOutputIds } from "../flow/schema.js";
import type { Flow } from "../flow/schema.js";
import { resolveBuiltinFlowPath } from "../flows/paths.js";
import { openFlowStore } from "../flows/store.js";
import { inferExternalInputs, validateFlowDocument } from "../flows/validate.js";
import { WebNotFoundError } from "./errors.js";
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
    editable: input.source === "user",
  };
}

async function readBuiltinFlows(
  repoPath: string,
): Promise<Array<{ id: string; document: string }>> {
  const flowsDirectory = join(resolve(repoPath), "flows");
  let entries: string[];
  try {
    entries = await readdir(flowsDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
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

export async function listFlowViews(repoPath: string): Promise<FlowView[]> {
  const builtin = await readBuiltinFlows(repoPath);
  const builtinViews = await Promise.all(
    builtin.map(async (flow) => {
      const report = await validateFlowDocument(repoPath, flow.document);
      return summarizeFlow({
        id: flow.id,
        source: "builtin",
        document: flow.document,
        runnable: report.valid,
      });
    }),
  );

  const store = openFlowStore(repoPath);
  let userViews: FlowView[];
  try {
    userViews = await Promise.all(
      store.listFlows().map(async (record) => {
        const report = await validateFlowDocument(repoPath, record.document);
        return summarizeFlow({
          id: record.id,
          source: "user",
          document: record.document,
          runnable: report.valid,
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
): Promise<{ document: string; source: FlowSource }> {
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
    return Promise.resolve({
      document: store.getFlow(id).document,
      source: "user" as const,
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
): Promise<FlowDetailView> {
  const { document, source } = await flowDocumentById(repoPath, id);
  const report = await validateFlowDocument(repoPath, document);

  let stages: FlowStageView[] = [];
  let inputs: FlowInputView[] = [];
  let gates: string[] = [];
  let flowName: string | undefined;
  try {
    const flow = parseFlowDocument(document, {
      externalInputs: inferExternalInputs(document),
    }).flow;
    flowName = flow.metadata.name;
    stages = flow.spec.stages.map((stage) => ({
      id: stage.id,
      type: stage.type,
      inputs: stage.inputs,
      outputs: stageOutputIds(stage),
    }));
    inputs = (flow.metadata.inputs ?? []).map((contract) => ({
      id: contract.id,
      ...(contract.type ? { type: contract.type } : {}),
    }));
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
    ...summarizeFlow({ id, source, document, runnable: report.valid }),
    document,
    stages,
    inputs,
    gates,
    runs,
  };
}
