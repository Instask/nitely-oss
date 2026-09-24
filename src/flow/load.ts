import { readFile } from "node:fs/promises";

import { type Flow, flowSchema, stageOutputIds } from "./schema.js";

export interface FlowGraph {
  predecessors: Map<string, Set<string>>;
  successors: Map<string, Set<string>>;
  producerByArtifact: Map<string, string>;
  order: string[];
}

export interface LoadFlowOptions {
  externalInputs?: string[];
}

export interface LoadedFlow {
  flow: Flow;
  graph: FlowGraph;
}

export class FlowValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join("\n"));
    this.name = "FlowValidationError";
    this.errors = errors;
  }
}

function formatSchemaPath(path: PropertyKey[]): string {
  return path.length === 0 ? "flow" : path.map(String).join(".");
}

const REMOVED_BUDGETS_MESSAGE =
  "no longer supported; use the machine-wide runaway ceiling NITELY_DEFAULT_MAX_RUNTIME_TOKENS instead";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removedBudgetFieldErrors(document: unknown): string[] {
  if (!isRecord(document) || !isRecord(document.spec)) return [];
  const errors: string[] = [];
  if (Object.prototype.hasOwnProperty.call(document.spec, "budgets")) {
    errors.push(`spec.budgets: ${REMOVED_BUDGETS_MESSAGE}`);
  }
  const stages = document.spec.stages;
  if (!Array.isArray(stages)) return errors;
  stages.forEach((stage, index) => {
    if (isRecord(stage) && Object.prototype.hasOwnProperty.call(stage, "budgets")) {
      errors.push(`spec.stages.${index}.budgets: ${REMOVED_BUDGETS_MESSAGE}`);
    }
  });
  return errors;
}

function valueAtPath(value: unknown, path: PropertyKey[]): unknown {
  let current = value;
  for (const part of path) {
    if (typeof part !== "string" && typeof part !== "number") {
      return undefined;
    }
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
}

function unionErrorsForMatchingStage(
  issue: { path: PropertyKey[]; errors?: unknown },
  document: unknown,
): Array<{ path: PropertyKey[]; message: string }> | undefined {
  if (
    issue.path.length !== 3 ||
    issue.path[0] !== "spec" ||
    issue.path[1] !== "stages" ||
    typeof issue.path[2] !== "number" ||
    !Array.isArray(issue.errors)
  ) {
    return undefined;
  }
  const stage = valueAtPath(document, issue.path);
  const stageType =
    typeof stage === "object" &&
    stage !== null &&
    typeof (stage as { type?: unknown }).type === "string"
      ? (stage as { type: string }).type
      : undefined;
  if (!stageType) return undefined;

  for (const candidate of issue.errors) {
    if (!Array.isArray(candidate)) continue;
    const gateModeDiscriminator = candidate.some((nested) => {
      if (typeof nested !== "object" || nested === null) return false;
      const record = nested as {
        path?: unknown;
        discriminator?: unknown;
        code?: unknown;
      };
      return (
        record.code === "invalid_union" &&
        record.discriminator === "mode" &&
        Array.isArray(record.path) &&
        record.path.length === 1 &&
        record.path[0] === "mode"
      );
    });
    if (gateModeDiscriminator && stageType !== "gate") continue;
    const mismatchedType = candidate.some((nested) => {
      if (typeof nested !== "object" || nested === null) return false;
      const record = nested as {
        path?: unknown;
        values?: unknown;
        code?: unknown;
      };
      return (
        record.code === "invalid_value" &&
        Array.isArray(record.path) &&
        record.path.length === 1 &&
        record.path[0] === "type" &&
        Array.isArray(record.values) &&
        !record.values.includes(stageType)
      );
    });
    if (mismatchedType) continue;
    return candidate
      .filter(
        (nested): nested is { path: PropertyKey[]; message: string } =>
          typeof nested === "object" &&
          nested !== null &&
          Array.isArray((nested as { path?: unknown }).path) &&
          typeof (nested as { message?: unknown }).message === "string",
      )
      .map((nested) => ({
        path: [...issue.path, ...nested.path],
        message: nested.message,
      }));
  }
  return undefined;
}

function validateGraph(
  flow: Flow,
  externalInputs: Set<string>,
): FlowGraph {
  const errors: string[] = [];
  const stageIds = new Set<string>();
  const producerByArtifact = new Map<string, string>();
  const predecessors = new Map<string, Set<string>>();
  const successors = new Map<string, Set<string>>();

  for (const stage of flow.spec.stages) {
    if (stageIds.has(stage.id)) {
      errors.push(`duplicate stage id: ${stage.id}`);
    }
    stageIds.add(stage.id);
    predecessors.set(stage.id, new Set());
    successors.set(stage.id, new Set());

    for (const artifact of stageOutputIds(stage)) {
      const existing = producerByArtifact.get(artifact);
      if (existing) {
        errors.push(
          `artifact ${artifact} has multiple producers: ${existing}, ${stage.id}`,
        );
      } else {
        producerByArtifact.set(artifact, stage.id);
      }
    }
  }

  for (const stage of flow.spec.stages) {
    if (stage.taskPlan && !stage.inputs.includes(stage.taskPlan.input)) {
      errors.push(
        `stage ${stage.id} taskPlan input must be declared in inputs: ${stage.taskPlan.input}`,
      );
    }
    for (const artifact of stage.inputs) {
      const producer = producerByArtifact.get(artifact);
      if (!producer) {
        if (!externalInputs.has(artifact)) {
          errors.push(
            `stage ${stage.id} consumes unknown artifact: ${artifact}`,
          );
        }
        continue;
      }
      if (producer === stage.id) {
        errors.push(`stage ${stage.id} consumes its own artifact: ${artifact}`);
        continue;
      }
      predecessors.get(stage.id)?.add(producer);
      successors.get(producer)?.add(stage.id);
    }
  }

  if (errors.length > 0) {
    throw new FlowValidationError(errors);
  }

  const declarationIndex = new Map(
    flow.spec.stages.map((stage, index) => [stage.id, index]),
  );
  const remainingPredecessors = new Map(
    [...predecessors].map(([id, values]) => [id, new Set(values)]),
  );
  const ready = flow.spec.stages
    .filter((stage) => remainingPredecessors.get(stage.id)?.size === 0)
    .map((stage) => stage.id);
  const order: string[] = [];

  while (ready.length > 0) {
    ready.sort(
      (left, right) =>
        (declarationIndex.get(left) ?? 0) - (declarationIndex.get(right) ?? 0),
    );
    const current = ready.shift();
    if (!current) break;
    order.push(current);

    for (const successor of successors.get(current) ?? []) {
      const pending = remainingPredecessors.get(successor);
      pending?.delete(current);
      if (pending?.size === 0 && !order.includes(successor)) {
        ready.push(successor);
      }
    }
  }

  if (order.length !== flow.spec.stages.length) {
    throw new FlowValidationError(["flow contains a cycle"]);
  }

  return { predecessors, successors, producerByArtifact, order };
}

export function parseFlowDocument(
  content: string,
  options: LoadFlowOptions = {},
): LoadedFlow {
  let document: unknown;
  try {
    document = JSON.parse(content);
  } catch (error) {
    throw new FlowValidationError([
      `flow is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  const removedBudgetErrors = removedBudgetFieldErrors(document);
  const parsed = flowSchema.safeParse(document);
  if (!parsed.success || removedBudgetErrors.length > 0) {
    const schemaErrors = parsed.success
      ? []
      : parsed.error.issues.flatMap((issue) => {
          const matchingUnionErrors =
            issue.code === "invalid_union"
              ? unionErrorsForMatchingStage(issue, document)
              : undefined;
          const issues = matchingUnionErrors ?? [issue];
          return issues.map(
            (candidate) =>
              `${formatSchemaPath(candidate.path)}: ${candidate.message}`,
          );
        });
    throw new FlowValidationError([...removedBudgetErrors, ...schemaErrors]);
  }

  const externalInputs = new Set([
    ...(options.externalInputs ?? []),
    ...(parsed.data.metadata.inputs ?? []).map((input) => input.id),
  ]);

  return {
    flow: parsed.data,
    graph: validateGraph(parsed.data, externalInputs),
  };
}

export async function loadFlow(
  path: string,
  options: LoadFlowOptions = {},
): Promise<LoadedFlow> {
  return parseFlowDocument(await readFile(path, "utf8"), options);
}
