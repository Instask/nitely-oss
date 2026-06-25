import { describe, expect, it } from "vitest";

import { validateAgainstSchema } from "../../src/artifacts/validate.js";

describe("minimal schema validator", () => {
  it("accepts a value matching type, required, and properties", () => {
    const result = validateAgainstSchema(
      { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      { name: "macro-calculator", extra: 1 },
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects a missing required key", () => {
    const result = validateAgainstSchema(
      { type: "object", required: ["name"] },
      {},
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("name");
  });

  it("rejects a property of the wrong type", () => {
    const result = validateAgainstSchema(
      { type: "object", properties: { count: { type: "number" } } },
      { count: "not-a-number" },
    );
    expect(result.valid).toBe(false);
  });

  it("validates nested properties recursively", () => {
    const schema = {
      type: "object",
      properties: {
        meta: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      },
    };
    expect(validateAgainstSchema(schema, { meta: { id: "x" } }).valid).toBe(true);
    expect(validateAgainstSchema(schema, { meta: { id: 5 } }).valid).toBe(false);
  });

  it("checks array type", () => {
    expect(validateAgainstSchema({ type: "array" }, [1, 2]).valid).toBe(true);
    expect(validateAgainstSchema({ type: "array" }, {}).valid).toBe(false);
  });

  it("ignores unknown schema keywords and non-object schemas", () => {
    expect(validateAgainstSchema({ kind: "markdown" }, "anything").valid).toBe(true);
    expect(validateAgainstSchema(undefined, "anything").valid).toBe(true);
  });
});
