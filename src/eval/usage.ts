import {
  collectSensitiveStringValues,
  isSafeTokenCountField,
  isSensitiveKey,
  redactText,
} from "../context/redaction.js";

export type UsageSourceKind = "provider-reported" | "calculated";

export type NormalizedUsageCost =
  | { classification: "actual"; usd: number }
  | { classification: "estimated"; usd: number; method: string }
  | { classification: "unknown" };

export interface ProviderUsageObservation {
  provider: string;
  model?: string;
  observedAt: string;
  source: {
    kind: UsageSourceKind;
    reference: string;
  };
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  contextWindow?: number;
  cost?: NormalizedUsageCost;
  raw?: unknown;
}

export interface NormalizedProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  contextWindow?: number;
  cost: NormalizedUsageCost;
  provenance: {
    provider: string;
    model?: string;
    observedAt: string;
    source: ProviderUsageObservation["source"];
  };
  raw?: unknown;
}

export interface PersistedRuntimeUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  contextWindow?: number;
  cost: NormalizedUsageCost;
  provenance?: NormalizedProviderUsage["provenance"];
  raw?: unknown;
}

const RAW_METADATA_LIMITS = {
  depth: 10,
  nodes: 512,
  collectionEntries: 128,
  stringCharacters: 32_768,
} as const;

const USAGE_TEXT_LIMITS = {
  provider: 128,
  model: 256,
  sourceReference: 2_048,
  costMethod: 1_024,
} as const;

function normalizedUsageText(input: {
  name: string;
  value: string;
  maximumCharacters: number;
  secrets?: readonly string[];
}): string {
  if (input.value.length > input.maximumCharacters) {
    throw new Error(
      `${input.name} exceeds ${input.maximumCharacters} characters`,
    );
  }
  const trimmed = input.value.trim();
  if (!trimmed) throw new Error(`${input.name} is required`);
  return redactRawText(trimmed, input.secrets ?? []);
}

function assertCanonicalIsoTimestamp(value: string): void {
  const timestamp = new Date(value);
  if (
    !Number.isFinite(timestamp.valueOf()) ||
    timestamp.toISOString() !== value
  ) {
    throw new Error("observedAt must be a canonical ISO timestamp");
  }
}

function boundRawMetadata(value: unknown): {
  value: unknown;
  sensitiveValues: string[];
} {
  const active = new WeakSet<object>();
  const sensitiveValues = collectSensitiveStringValues(value);
  let remainingNodes: number = RAW_METADATA_LIMITS.nodes;
  let remainingCharacters: number = RAW_METADATA_LIMITS.stringCharacters;

  const boundedString = (entry: string): string => {
    if (entry.length > remainingCharacters) {
      remainingCharacters = 0;
      return "[TRUNCATED]";
    }
    remainingCharacters -= entry.length;
    return entry;
  };

  const visit = (entry: unknown, depth: number): unknown => {
    if (remainingNodes <= 0 || depth > RAW_METADATA_LIMITS.depth) {
      return "[TRUNCATED]";
    }
    remainingNodes -= 1;
    if (entry === null || typeof entry === "boolean") return entry;
    if (typeof entry === "number") {
      return Number.isFinite(entry) ? entry : String(entry);
    }
    if (typeof entry === "string") return boundedString(entry);
    if (typeof entry === "bigint") return boundedString(`${entry}n`);
    if (typeof entry === "undefined") return null;
    if (typeof entry === "symbol" || typeof entry === "function") {
      return "[UNSUPPORTED]";
    }
    if (typeof entry !== "object") return String(entry);
    if (active.has(entry)) return "[CIRCULAR]";

    active.add(entry);
    try {
      if (Array.isArray(entry)) {
        const bounded = entry
          .slice(0, RAW_METADATA_LIMITS.collectionEntries)
          .map((item) => visit(item, depth + 1));
        if (entry.length > RAW_METADATA_LIMITS.collectionEntries) {
          bounded.push("[TRUNCATED]");
        }
        return bounded;
      }
      let entries: Array<[string, unknown]>;
      try {
        entries = Object.entries(entry);
      } catch {
        return "[TRUNCATED]";
      }
      const bounded: Record<string, unknown> = {};
      for (const [index, [key, item]] of entries.entries()) {
        if (index >= RAW_METADATA_LIMITS.collectionEntries || remainingNodes <= 0) {
          bounded.__truncated__ = "[TRUNCATED]";
          break;
        }
        const boundedKey = boundedString(key);
        bounded[boundedKey === "[TRUNCATED]"
          ? `__truncated_field_${index}__`
          : boundedKey] = visit(item, depth + 1);
      }
      return bounded;
    } finally {
      active.delete(entry);
    }
  };

  return { value: visit(value, 0), sensitiveValues };
}

function redactRawText(value: string, secrets: readonly string[]): string {
  let redacted = redactText(value, secrets) ?? value;
  for (const secret of [...new Set(secrets)]
    .filter((entry) => entry.length > 0)
    .sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function redactSensitiveRawFields(
  value: unknown,
  secrets: readonly string[],
): unknown {
  if (typeof value === "string") return redactRawText(value, secrets);
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveRawFields(entry, secrets));
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    const redactedKey = redactRawText(key, secrets);
    if (isSensitiveKey(key) && !isSafeTokenCountField(key, entry)) {
      if (typeof entry === "string") {
        const redacted = redactRawText(entry, secrets);
        return [redactedKey, redacted !== entry ? redacted : "[REDACTED]"];
      }
      return [redactedKey, "[REDACTED]"];
    }
    return [redactedKey, redactSensitiveRawFields(entry, secrets)];
  }));
}

export function normalizeProviderUsage(
  input: undefined,
): undefined;
export function normalizeProviderUsage(
  input: ProviderUsageObservation,
): NormalizedProviderUsage;
export function normalizeProviderUsage(
  input: ProviderUsageObservation | undefined,
): NormalizedProviderUsage | undefined {
  if (!input) return undefined;
  if (
    input.source.kind !== "provider-reported" &&
    input.source.kind !== "calculated"
  ) {
    throw new Error("usage provenance source kind is invalid");
  }
  assertCanonicalIsoTimestamp(input.observedAt);
  for (const [name, value] of [
    ["inputTokens", input.inputTokens],
    ["outputTokens", input.outputTokens],
    ["totalTokens", input.totalTokens],
    ["cachedInputTokens", input.cachedInputTokens],
    ["contextWindow", input.contextWindow],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`${name} must be a non-negative integer within the safe range`);
    }
  }
  if (
    input.inputTokens !== undefined &&
    input.outputTokens !== undefined &&
    !Number.isSafeInteger(input.inputTokens + input.outputTokens)
  ) {
    throw new Error("inputTokens plus outputTokens exceeds the safe integer range");
  }
  if (
    input.inputTokens !== undefined &&
    input.outputTokens !== undefined &&
    input.totalTokens !== undefined &&
    input.inputTokens + input.outputTokens !== input.totalTokens
  ) {
    throw new Error("totalTokens must equal inputTokens plus outputTokens");
  }
  if (
    input.cachedInputTokens !== undefined &&
    input.inputTokens !== undefined &&
    input.cachedInputTokens > input.inputTokens
  ) {
    throw new Error("cachedInputTokens cannot exceed inputTokens");
  }
  if (
    input.cost?.classification === "actual" &&
    input.source.kind !== "provider-reported"
  ) {
    throw new Error("actual cost requires provider-reported provenance");
  }
  if (
    input.cost?.classification === "estimated" &&
    input.source.kind !== "calculated"
  ) {
    throw new Error("estimated cost requires calculated provenance");
  }
  if (
    input.cost !== undefined &&
    input.cost.classification !== "actual" &&
    input.cost.classification !== "estimated" &&
    input.cost.classification !== "unknown"
  ) {
    throw new Error("usage cost classification is invalid");
  }
  if (
    input.cost &&
    input.cost.classification !== "unknown" &&
    (!Number.isFinite(input.cost.usd) || input.cost.usd < 0)
  ) {
    throw new Error("usage cost must be a non-negative finite number");
  }
  if (
    input.cost?.classification === "unknown" &&
    ("usd" in input.cost || "method" in input.cost)
  ) {
    throw new Error("unknown cost cannot include a value or method");
  }
  const bounded = input.raw === undefined
    ? undefined
    : boundRawMetadata(input.raw);
  const boundedRaw = bounded?.value;
  const rawSecrets = bounded?.sensitiveValues ?? [];
  const provider = normalizedUsageText({
    name: "provider",
    value: input.provider,
    maximumCharacters: USAGE_TEXT_LIMITS.provider,
    secrets: rawSecrets,
  });
  const model = input.model === undefined
    ? undefined
    : normalizedUsageText({
        name: "model",
        value: input.model,
        maximumCharacters: USAGE_TEXT_LIMITS.model,
        secrets: rawSecrets,
      });
  const sourceReference = normalizedUsageText({
    name: "usage provenance reference",
    value: input.source.reference,
    maximumCharacters: USAGE_TEXT_LIMITS.sourceReference,
    secrets: rawSecrets,
  });
  const cost: NormalizedUsageCost = input.cost?.classification === "estimated"
    ? {
        classification: "estimated",
        usd: input.cost.usd,
        method: normalizedUsageText({
          name: "estimated cost method",
          value: input.cost.method,
          maximumCharacters: USAGE_TEXT_LIMITS.costMethod,
          secrets: rawSecrets,
        }),
      }
    : input.cost?.classification === "actual"
      ? { classification: "actual", usd: input.cost.usd }
      : { classification: "unknown" };
  return {
    ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
    ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
    ...(input.totalTokens !== undefined ? { totalTokens: input.totalTokens } : {}),
    ...(input.cachedInputTokens !== undefined
      ? { cachedInputTokens: input.cachedInputTokens }
      : {}),
    ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
    cost,
    provenance: {
      provider,
      ...(model ? { model } : {}),
      observedAt: input.observedAt,
      source: {
        kind: input.source.kind,
        reference: sourceReference,
      },
    },
    ...(boundedRaw !== undefined
      ? {
          raw: redactSensitiveRawFields(
            boundedRaw,
            rawSecrets,
          ),
        }
      : {}),
  };
}

function usageRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function usageCount(
  record: Record<string, unknown>,
  name:
    | "inputTokens"
    | "outputTokens"
    | "totalTokens"
    | "cachedInputTokens"
    | "contextWindow",
): number | undefined {
  const value = record[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

export function normalizeRuntimeUsageForPersistence(
  input: unknown,
): PersistedRuntimeUsage {
  const record = usageRecord(input);
  const inputTokens = usageCount(record, "inputTokens");
  const outputTokens = usageCount(record, "outputTokens");
  const totalTokens = usageCount(record, "totalTokens");
  const cachedInputTokens = usageCount(record, "cachedInputTokens");
  const contextWindow = usageCount(record, "contextWindow");
  if (
    inputTokens !== undefined &&
    outputTokens !== undefined &&
    totalTokens !== undefined &&
    inputTokens + outputTokens !== totalTokens
  ) {
    throw new Error("totalTokens must equal inputTokens plus outputTokens");
  }
  if (
    cachedInputTokens !== undefined &&
    inputTokens !== undefined &&
    cachedInputTokens > inputTokens
  ) {
    throw new Error("cachedInputTokens cannot exceed inputTokens");
  }

  if (record.provenance !== undefined) {
    const provenance = usageRecord(record.provenance);
    const source = usageRecord(provenance.source);
    if (
      typeof provenance.provider !== "string" ||
      (provenance.model !== undefined && typeof provenance.model !== "string") ||
      typeof provenance.observedAt !== "string" ||
      (source.kind !== "provider-reported" && source.kind !== "calculated") ||
      typeof source.reference !== "string"
    ) {
      throw new Error("runtime usage provenance is malformed");
    }
    const cost = record.cost as ProviderUsageObservation["cost"] | undefined;
    return normalizeProviderUsage({
      provider: provenance.provider,
      ...(typeof provenance.model === "string"
        ? { model: provenance.model }
        : {}),
      observedAt: provenance.observedAt,
      source: {
        kind: source.kind,
        reference: source.reference,
      },
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(cost !== undefined ? { cost } : {}),
      ...(record.raw !== undefined ? { raw: record.raw } : {}),
    });
  }

  const costRecord = usageRecord(record.cost);
  if (
    record.cost !== undefined &&
    !(
      costRecord.classification === "unknown" &&
      costRecord.usd === undefined &&
      costRecord.method === undefined
    )
  ) {
    throw new Error("runtime usage cost provenance is required");
  }
  const bounded = record.raw === undefined
    ? undefined
    : boundRawMetadata(record.raw);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    cost: { classification: "unknown" },
    ...(bounded
      ? {
          raw: redactSensitiveRawFields(
            bounded.value,
            bounded.sensitiveValues,
          ),
        }
      : {}),
  };
}
