import { effortSchema, type Effort, type Flow } from "./schema.js";

/** Per-run execution choices applied on top of the stored Flow document. */
export interface RunOverrides {
  model?: string;
  effort?: Effort;
  runtime?: string;
  questions?: "ask" | "auto" | "deny";
}

export class RunOverridesError extends Error {}

export function normalizeRunOverrides(value: unknown): RunOverrides | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RunOverridesError("overrides must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["model", "effort", "runtime", "questions"].includes(key)) {
      throw new RunOverridesError(`unknown overrides field: ${key}`);
    }
  }
  const result: RunOverrides = {};
  for (const key of ["model", "runtime"] as const) {
    if (record[key] === undefined) continue;
    if (typeof record[key] !== "string" || !record[key].trim()) {
      throw new RunOverridesError(`overrides.${key} must be a non-empty string`);
    }
    result[key] = record[key].trim();
  }
  if (record.effort !== undefined) {
    const parsed = effortSchema.safeParse(record.effort);
    if (!parsed.success) {
      throw new RunOverridesError(`overrides.effort must be one of: ${effortSchema.options.join(", ")}`);
    }
    result.effort = parsed.data;
  }
  if (record.questions !== undefined) {
    if (record.questions !== "ask" && record.questions !== "auto" && record.questions !== "deny") {
      throw new RunOverridesError("overrides.questions must be one of: ask, auto, deny");
    }
    result.questions = record.questions;
  }
  return Object.keys(result).length ? result : undefined;
}

/** Model/effort preserve fallback order; a runtime override selects one runtime. */
export function applyRunOverrides(flow: Flow, overrides?: RunOverrides): Flow {
  const normalized = normalizeRunOverrides(overrides);
  const result = structuredClone(flow);
  if (!normalized) return result;
  if (normalized.questions) {
    result.spec.questions = { ...result.spec.questions, mode: normalized.questions };
  }
  result.spec.stages = result.spec.stages.map((stage) => {
    if (stage.type !== "agent" && stage.type !== "judge" &&
        !(stage.type === "gate" && stage.mode === "review")) return stage;
    if (stage.type === "agent" && normalized.questions) {
      stage = { ...stage, questions: { ...stage.questions, mode: normalized.questions } };
    }
    if (normalized.runtime) {
      const first = stage.runtimes?.[0];
      const { runtimes: _runtimes, ...single } = stage;
      return { ...single, runtime: normalized.runtime,
        ...(normalized.model ?? stage.model ?? first?.model
          ? { model: normalized.model ?? stage.model ?? first?.model } : {}),
        ...(normalized.effort ?? stage.effort ?? first?.effort
          ? { effort: normalized.effort ?? stage.effort ?? first?.effort } : {}) };
    }
    return { ...stage,
      ...(normalized.model ? { model: normalized.model } : {}),
      ...(normalized.effort ? { effort: normalized.effort } : {}),
      ...(stage.runtimes ? { runtimes: stage.runtimes.map((candidate) => ({
        ...candidate,
        ...(normalized.model ? { model: normalized.model } : {}),
        ...(normalized.effort ? { effort: normalized.effort } : {}),
      })) } : {}),
    };
  });
  // Candidate form cannot also contain a stage-level model.
  for (const stage of result.spec.stages) {
    if ("runtimes" in stage && stage.runtimes) {
      delete stage.model;
      delete stage.effort;
    }
  }
  return result;
}
