export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

type JsonSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "boolean"
  | "null";

function typeOfValue(value: unknown): JsonSchemaType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "object") return "object";
  if (t === "string") return "string";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  return "object";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(
  schema: unknown,
  value: unknown,
  path: string,
  errors: string[],
): void {
  // Non-object schemas (e.g. { kind: "markdown" }) impose no constraints.
  if (!isPlainObject(schema)) {
    return;
  }

  if (typeof schema.type === "string") {
    const expected = schema.type as JsonSchemaType;
    const actual = typeOfValue(value);
    if (actual !== expected) {
      errors.push(`${path || "value"}: expected ${expected}, got ${actual}`);
      return;
    }
  }

  if (Array.isArray(schema.required) && isPlainObject(value)) {
    for (const key of schema.required) {
      if (typeof key === "string" && !(key in value)) {
        errors.push(`${path || "value"}: missing required key "${key}"`);
      }
    }
  }

  if (isPlainObject(schema.properties) && isPlainObject(value)) {
    for (const [key, subSchema] of Object.entries(schema.properties)) {
      if (key in value) {
        validate(subSchema, value[key], path ? `${path}.${key}` : key, errors);
      }
    }
  }
}

/**
 * Validate a value against a minimal JSON-Schema subset: `type`, `required`,
 * and `properties` (recursive). Unknown keywords are ignored, and a non-object
 * schema imposes no constraints.
 */
export function validateAgainstSchema(
  schema: unknown,
  value: unknown,
): SchemaValidationResult {
  const errors: string[] = [];
  validate(schema, value, "", errors);
  return { valid: errors.length === 0, errors };
}
