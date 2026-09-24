import type { FlowGraph } from "./load.js";
import { stageOutputIds, type Flow, type Stage } from "./schema.js";

export type FlowGraphFormat = "text" | "mermaid" | "json";

export interface FormatFlowGraphOptions {
  format: FlowGraphFormat;
}

const EXTERNAL_INPUT_PREFIX = "input:";

interface ProjectedStage {
  id: string;
  type: string;
  inputs: string[];
  outputs: string[];
  runtime?: string;
  model?: string;
  command?: string;
  runtimes?: Array<{ runtime: string; model?: string }>;
}

interface ProjectedEdge {
  from: string;
  to: string;
  artifact: string;
}

interface FlowGraphProjection {
  name: string;
  stages: ProjectedStage[];
  edges: ProjectedEdge[];
  externalInputs: string[];
}

function stageById(flow: Flow): Map<string, Stage> {
  return new Map(flow.spec.stages.map((stage) => [stage.id, stage]));
}

function projectStage(stage: Stage): ProjectedStage {
  const projected: ProjectedStage = {
    id: stage.id,
    type: stage.type,
    inputs: [...stage.inputs],
    outputs: stageOutputIds(stage),
  };
  if (stage.type === "command") {
    projected.command = stage.command;
  } else if (stage.type === "gate" && stage.mode === "deterministic") {
    projected.command = stage.command;
  } else if (
    stage.type === "agent" ||
    stage.type === "judge" ||
    (stage.type === "gate" && stage.mode === "review")
  ) {
    if ("runtimes" in stage && stage.runtimes) {
      projected.runtimes = stage.runtimes.map((candidate) => ({
        runtime: candidate.runtime,
        ...(candidate.model ? { model: candidate.model } : {}),
      }));
    } else if ("runtime" in stage && stage.runtime) {
      projected.runtime = stage.runtime;
      if (stage.model) projected.model = stage.model;
    }
  }
  return projected;
}

function projectFlowGraph(flow: Flow, graph: FlowGraph): FlowGraphProjection {
  const stages = graph.order.map((id) => {
    const stage = stageById(flow).get(id);
    if (!stage) {
      throw new Error(`graph order references unknown stage: ${id}`);
    }
    return projectStage(stage);
  });

  const edges: ProjectedEdge[] = [];
  const externalInputs: string[] = [];
  const seenExternal = new Set<string>();

  for (const stage of stages) {
    for (const artifact of stage.inputs) {
      const producer = graph.producerByArtifact.get(artifact);
      if (producer) {
        edges.push({ from: producer, to: stage.id, artifact });
        continue;
      }
      edges.push({ from: `${EXTERNAL_INPUT_PREFIX}${artifact}`, to: stage.id, artifact });
      if (!seenExternal.has(artifact)) {
        seenExternal.add(artifact);
        externalInputs.push(artifact);
      }
    }
  }

  return {
    name: flow.metadata.name,
    stages,
    edges,
    externalInputs,
  };
}

function projectedDetail(stage: ProjectedStage): string | undefined {
  if (stage.command) return stage.command;
  if (stage.runtimes && stage.runtimes.length > 0) {
    return stage.runtimes
      .map((candidate) =>
        candidate.model ? `${candidate.runtime}/${candidate.model}` : candidate.runtime,
      )
      .join(",");
  }
  if (stage.runtime) {
    return stage.model ? `${stage.runtime}/${stage.model}` : stage.runtime;
  }
  return undefined;
}

function formatText(projection: FlowGraphProjection): string {
  const lines: string[] = [];
  for (const stage of projection.stages) {
    const extra = projectedDetail(stage);
    const prefix = extra
      ? `STAGE ${stage.id} ${stage.type} ${extra}`
      : `STAGE ${stage.id} ${stage.type}`;
    lines.push(
      `${prefix} in:${stage.inputs.join(",")} out:${stage.outputs.join(",")}`,
    );
  }
  for (const edge of projection.edges) {
    if (edge.from.startsWith(EXTERNAL_INPUT_PREFIX)) continue;
    lines.push(`EDGE ${edge.from} -[${edge.artifact}]-> ${edge.to}`);
  }
  for (const id of projection.externalInputs) {
    lines.push(`INPUT ${id}`);
  }
  return lines.join("\n");
}

function formatMermaid(projection: FlowGraphProjection): string {
  const lines = ["flowchart TD"];
  for (const id of projection.externalInputs) {
    lines.push(`  ${id}(["${id}"])`);
  }
  for (const stage of projection.stages) {
    lines.push(`  ${stage.id}["${stage.id}"]`);
  }
  for (const edge of projection.edges) {
    const from = edge.from.startsWith(EXTERNAL_INPUT_PREFIX)
      ? edge.from.slice(EXTERNAL_INPUT_PREFIX.length)
      : edge.from;
    lines.push(`  ${from} -->|${edge.artifact}| ${edge.to}`);
  }
  return lines.join("\n");
}

export function formatFlowGraph(
  flow: Flow,
  graph: FlowGraph,
  options: FormatFlowGraphOptions,
): string {
  const projection = projectFlowGraph(flow, graph);
  switch (options.format) {
    case "text":
      return formatText(projection);
    case "mermaid":
      return formatMermaid(projection);
    case "json":
      return JSON.stringify(
        {
          name: projection.name,
          stages: projection.stages,
          edges: projection.edges,
          externalInputs: projection.externalInputs,
        },
        null,
        2,
      );
    default: {
      const unexpected: never = options.format;
      throw new Error(`unknown graph format: ${String(unexpected)}`);
    }
  }
}
