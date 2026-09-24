import type { ConfigurableInput, Flow } from "../flow/schema.js";

export type FlowConfigurationValue = string | number | boolean;
export type FlowConfiguration = Record<string, FlowConfigurationValue>;

export class FlowConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowConfigurationError";
  }
}

export function flowConfigurables(flow: Flow): ConfigurableInput[] {
  return flow.metadata.configurables ?? [];
}

function hasConfigurationValue(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function parseBoolean(value: unknown, key: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  throw new FlowConfigurationError(`invalid value for configurable ${key}: expected boolean`);
}

function normalizeValue(
  configurable: ConfigurableInput,
  rawValue: unknown,
): FlowConfigurationValue {
  switch (configurable.type) {
    case "number": {
      const numberValue =
        typeof rawValue === "number" ? rawValue : Number(String(rawValue).trim());
      if (!Number.isFinite(numberValue)) {
        throw new FlowConfigurationError(
          `invalid value for configurable ${configurable.key}: expected number`,
        );
      }
      return numberValue;
    }
    case "boolean":
      return parseBoolean(rawValue, configurable.key);
    case "date":
    case "url":
    case "textarea":
    case "text":
      return String(rawValue);
  }
}

export function normalizeFlowConfiguration(
  flow: Flow,
  input: Record<string, unknown> = {},
): FlowConfiguration {
  const output: FlowConfiguration = {};
  const configurables = flowConfigurables(flow);
  const allowedKeys = new Set(configurables.map((configurable) => configurable.key));
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      throw new FlowConfigurationError(`unknown configurable: ${key}`);
    }
  }
  const seen = new Set<string>();
  for (const configurable of configurables) {
    if (seen.has(configurable.key)) {
      throw new FlowConfigurationError(
        `duplicate configurable key: ${configurable.key}`,
      );
    }
    seen.add(configurable.key);

    const rawValue = hasConfigurationValue(input[configurable.key])
      ? input[configurable.key]
      : configurable.default;
    if (!hasConfigurationValue(rawValue)) {
      if (configurable.required) {
        throw new FlowConfigurationError(
          `missing required configurable: ${configurable.key}`,
        );
      }
      continue;
    }
    output[configurable.key] = normalizeValue(configurable, rawValue);
  }
  return output;
}

export function renderFlowConfiguration(configuration: FlowConfiguration): string[] {
  const entries = Object.entries(configuration);
  if (entries.length === 0) return [];
  return [
    "## Configuration",
    "",
    "Operator-supplied flow parameters for this run:",
    "",
    ...entries.map(([key, value]) => `- ${key}: ${String(value)}`),
    "",
  ];
}

function configurationReplacement(
  key: string,
  configuration: FlowConfiguration,
  fallback: string,
): string {
  return configuration[key] === undefined ? fallback : String(configuration[key]);
}

export function applyFlowConfigurationTemplate(
  text: string,
  configuration: FlowConfiguration,
): string {
  return text
    .replace(/\{\{\s*config\.([A-Za-z0-9_.-]+)\s*\}\}/g, (match, key: string) =>
      configurationReplacement(key, configuration, match),
    )
    .replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, key: string) =>
      configurationReplacement(key, configuration, match),
    );
}
