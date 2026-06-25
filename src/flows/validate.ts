import { FlowValidationError, parseFlowDocument } from "../flow/load.js";
import { flowWorkItemType } from "../flow/schema.js";
import { assertWorkItemTypeAllowed } from "../work-items/governance.js";
import { WebInputError } from "../web/errors.js";

export interface FlowValidationReport {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function outputIdOf(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  if (typeof output === "object" && output !== null && "id" in output) {
    const id = (output as { id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

/**
 * Infer the external inputs of a flow document the way the runtime does: every
 * declared `metadata.inputs` id, plus any stage input that no stage produces
 * (these are supplied to the run). This keeps legacy flows that consume external
 * inputs without declaring them (e.g. spec/tech-design) valid and runnable.
 */
export function inferExternalInputs(content: string): string[] {
  try {
    const document = JSON.parse(content) as {
      metadata?: { inputs?: Array<{ id?: unknown }> };
      spec?: { stages?: Array<{ inputs?: unknown; outputs?: unknown }> };
    };
    const declared = Array.isArray(document.metadata?.inputs)
      ? document.metadata.inputs
          .map((input) => input?.id)
          .filter((id): id is string => typeof id === "string")
      : [];
    const stages = Array.isArray(document.spec?.stages)
      ? document.spec.stages
      : [];
    const produced = new Set<string>();
    for (const stage of stages) {
      const outputs = Array.isArray(stage.outputs) ? stage.outputs : [];
      for (const output of outputs) {
        const id = outputIdOf(output);
        if (id) produced.add(id);
      }
    }
    const external = new Set<string>(declared);
    for (const stage of stages) {
      const inputs = Array.isArray(stage.inputs) ? stage.inputs : [];
      for (const inputId of inputs) {
        if (typeof inputId === "string" && !produced.has(inputId)) {
          external.add(inputId);
        }
      }
    }
    return [...external];
  } catch {
    return [];
  }
}

/**
 * Validate a flow document string the same way the runtime would, plus the
 * save-time policy guard. Returns structured errors/warnings for the editor and
 * the save/run hard block. A report with any errors is not saveable or runnable.
 */
export async function validateFlowDocument(
  repoPath: string,
  content: string,
): Promise<FlowValidationReport> {
  const errors: string[] = [];
  const warnings: string[] = [];

  let loaded;
  try {
    loaded = parseFlowDocument(content, {
      externalInputs: inferExternalInputs(content),
    });
  } catch (error) {
    if (error instanceof FlowValidationError) {
      return { valid: false, errors: error.errors, warnings };
    }
    throw error;
  }

  try {
    await assertWorkItemTypeAllowed({
      repoPath,
      workItemType: flowWorkItemType(loaded.flow),
      flow: loaded.flow,
    });
  } catch (error) {
    if (error instanceof WebInputError) {
      errors.push(error.message);
    } else {
      throw error;
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
