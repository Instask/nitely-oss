import type { FlowGraph } from "../flow/load.js";
import {
  stageOutputContracts,
  type Flow,
  type OutputDeclaration,
  type Stage,
} from "../flow/schema.js";

export interface FlowArtifactContractView {
  id: string;
  source: "external-input" | "stage-output";
  producer: "external-input" | string;
  consumers: string[];
  implicitExternal?: boolean;
  name?: string;
  type?: string;
  description?: string;
  mediaType?: string;
  schema?: unknown;
  version?: string;
}

export interface FlowStageArtifactGraphView {
  id: string;
  type: string;
  inputs: string[];
  outputs: string[];
  dependsOn: string[];
  unblocks: string[];
}

export interface FlowArtifactGraphEdgeView {
  from: string;
  to: string;
  artifacts: string[];
}

export interface FlowArtifactGraphView {
  order: string[];
  artifacts: FlowArtifactContractView[];
  stages: FlowStageArtifactGraphView[];
  edges: FlowArtifactGraphEdgeView[];
}

function artifactViewFromOutput(
  output: ReturnType<typeof stageOutputContracts>[number],
  producer: string,
): FlowArtifactContractView {
  return {
    id: output.id,
    source: "stage-output",
    producer,
    consumers: [],
    ...(output.name ? { name: output.name } : {}),
    ...(output.type ? { type: output.type } : {}),
    ...(output.description ? { description: output.description } : {}),
    ...(output.mediaType ? { mediaType: output.mediaType } : {}),
    ...(output.schema !== undefined ? { schema: output.schema } : {}),
    ...(output.version ? { version: output.version } : {}),
  };
}

function outputIds(outputs: OutputDeclaration[]): string[] {
  return outputs.map((output) => (typeof output === "string" ? output : output.id));
}

function stageOrderIndex(flow: Flow): Map<string, number> {
  return new Map(flow.spec.stages.map((stage, index) => [stage.id, index]));
}

function sortStageIds(ids: Iterable<string>, orderIndex: Map<string, number>): string[] {
  return [...ids].sort(
    (left, right) =>
      (orderIndex.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (orderIndex.get(right) ?? Number.MAX_SAFE_INTEGER),
  );
}

function addExternalArtifact(
  artifacts: Map<string, FlowArtifactContractView>,
  input: { id: string; type?: string },
  implicitExternal = false,
): void {
  if (artifacts.has(input.id)) return;
  artifacts.set(input.id, {
    id: input.id,
    source: "external-input",
    producer: "external-input",
    consumers: [],
    ...(implicitExternal ? { implicitExternal: true } : {}),
    ...(input.type ? { type: input.type } : {}),
  });
}

function addConsumer(
  artifacts: Map<string, FlowArtifactContractView>,
  artifactId: string,
  stage: Stage,
): void {
  let artifact = artifacts.get(artifactId);
  if (!artifact) {
    artifact = {
      id: artifactId,
      source: "external-input",
      producer: "external-input",
      consumers: [],
      implicitExternal: true,
    };
    artifacts.set(artifactId, artifact);
  }
  if (!artifact.consumers.includes(stage.id)) {
    artifact.consumers.push(stage.id);
  }
}

export function summarizeFlowArtifactGraph(
  flow: Flow,
  graph: FlowGraph,
): FlowArtifactGraphView {
  const orderIndex = stageOrderIndex(flow);
  const artifacts = new Map<string, FlowArtifactContractView>();

  for (const input of flow.metadata.inputs ?? []) {
    addExternalArtifact(artifacts, input);
  }

  for (const stage of flow.spec.stages) {
    for (const output of stageOutputContracts(stage)) {
      artifacts.set(output.id, artifactViewFromOutput(output, stage.id));
    }
  }

  for (const stage of flow.spec.stages) {
    for (const inputId of stage.inputs) {
      addConsumer(artifacts, inputId, stage);
    }
  }

  const edgeByKey = new Map<string, FlowArtifactGraphEdgeView>();
  for (const stage of flow.spec.stages) {
    for (const artifactId of stage.inputs) {
      const producer = graph.producerByArtifact.get(artifactId);
      if (!producer) continue;
      const key = `${producer}\u0000${stage.id}`;
      const edge = edgeByKey.get(key) ?? {
        from: producer,
        to: stage.id,
        artifacts: [],
      };
      edge.artifacts.push(artifactId);
      edgeByKey.set(key, edge);
    }
  }

  return {
    order: graph.order,
    artifacts: [...artifacts.values()].map((artifact) => ({
      ...artifact,
      consumers: sortStageIds(artifact.consumers, orderIndex),
    })),
    stages: flow.spec.stages.map((stage) => ({
      id: stage.id,
      type: stage.type,
      inputs: stage.inputs,
      outputs: outputIds(stage.outputs),
      dependsOn: sortStageIds(graph.predecessors.get(stage.id) ?? [], orderIndex),
      unblocks: sortStageIds(graph.successors.get(stage.id) ?? [], orderIndex),
    })),
    edges: [...edgeByKey.values()].map((edge) => ({
      ...edge,
      artifacts: [...edge.artifacts],
    })),
  };
}
