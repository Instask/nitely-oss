import { describe, expect, it } from "vitest";
import { renderInputContext } from "../../src/run/run-flow.js";

function context() {
  return {
    runId: "run-1",
    runDirectory: "/repo/.nitely/runs/run-1",
    manifestEntries: [],
    manifestEntryIndexes: new Map(),
    artifactEntries: [],
    artifactEntryIndexes: new Map(),
    redactionSecrets: [],
    constitution: { loaded: false as const, path: ".nitely/constitution.md" as const },
  };
}

function input(content: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "spec",
    reference: { connector: "generated", uri: "/x" },
    resource: {
      sourceUri: "spec.md",
      mediaType: "text/markdown",
      content: Buffer.from(content, "utf8"),
      metadata: { filename: "spec.md" },
    },
    contentPath: "/repo/.nitely/runs/run-1/inputs/spec/content",
    ...overrides,
  } as Parameters<typeof renderInputContext>[0];
}

describe("renderInputContext", () => {
  it("inlines small content fully with no savings and includes the readable path", () => {
    const { block, usage } = renderInputContext(input("short body"), context());
    expect(block).toContain("Full content: /repo/.nitely/runs/run-1/inputs/spec/content");
    expect(block).toContain("Content preview:");
    expect(block).toContain("short body");
    expect(block).not.toContain("MUST read");
    expect(usage).toEqual({ inlinedBytes: Buffer.byteLength("short body"), savedBytes: 0 });
  });

  it("truncates large content to a head and demands a mandatory read", () => {
    const big = "x".repeat(20 * 1024);
    const { block, usage } = renderInputContext(input(big), context());
    expect(block).toContain("Content preview (truncated");
    expect(block).toContain("MUST read the full file");
    expect(usage.inlinedBytes).toBeLessThanOrEqual(8 * 1024);
    expect(usage.savedBytes).toBe(Buffer.byteLength(big) - usage.inlinedBytes);
  });

  it("emits metadata + path only for binary media types", () => {
    const { block, usage } = renderInputContext(
      input("\x00\x01\x02 binary", { resource: { sourceUri: "b.bin", mediaType: "application/octet-stream", content: Buffer.from("\x00\x01\x02 binary"), metadata: { filename: "b.bin" } } }),
      context(),
    );
    expect(block).toContain("Binary artifact");
    expect(block).not.toContain("Content preview");
    expect(usage.inlinedBytes).toBe(0);
    expect(usage.savedBytes).toBeGreaterThan(0);
  });

  it("keeps omitted-by-policy rendering with zero usage", () => {
    const { block, usage } = renderInputContext(
      input("ignored", { omittedByPolicy: { reason: "matched", matchedPattern: "*.env" } }),
      context(),
    );
    expect(block).toContain("Omitted by context policy.");
    expect(usage).toEqual({ inlinedBytes: 0, savedBytes: 0 });
  });

  it("forcePathOnly renders a textual input as path-only with mandatory read", () => {
    const { block, usage } = renderInputContext(input("a short body"), context(), { forcePathOnly: true });
    expect(block).toContain("Full content: /repo/.nitely/runs/run-1/inputs/spec/content");
    expect(block).toContain("MUST read the full file");
    expect(block).not.toContain("a short body");
    expect(usage.inlinedBytes).toBe(0);
    expect(usage.savedBytes).toBe(Buffer.byteLength("a short body"));
  });
});
