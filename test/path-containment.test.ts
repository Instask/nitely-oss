import { describe, expect, it } from "vitest";

import { isPathInside } from "../src/path-containment.js";

describe("isPathInside", () => {
  it("accepts the parent itself and paths beneath it", () => {
    expect(isPathInside("/repo/.nitely/runs/run-1", "/repo/.nitely/runs/run-1")).toBe(true);
    expect(isPathInside("/repo/.nitely/runs/run-1", "/repo/.nitely/runs/run-1/a/b.json")).toBe(true);
  });

  it("accepts a child whose name starts with two dots", () => {
    expect(isPathInside("/repo/run", "/repo/run/..notes")).toBe(true);
  });

  it("rejects the parent's parent, siblings and traversal", () => {
    expect(isPathInside("/repo/run", "/repo")).toBe(false);
    expect(isPathInside("/repo/run", "/repo/run-2/file")).toBe(false);
    expect(isPathInside("/repo/run", "/repo/run/../other")).toBe(false);
    expect(isPathInside("/repo/run", "/elsewhere")).toBe(false);
  });
});
