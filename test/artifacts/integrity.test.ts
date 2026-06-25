import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  computeIntegrity,
  withProvenance,
} from "../../src/artifacts/integrity.js";
import type { RunArtifact } from "../../src/artifacts/types.js";

describe("artifact integrity", () => {
  it("computes the sha256 hex digest and byte size of content", () => {
    const content = "site plan contents";
    const expected = createHash("sha256").update(content, "utf8").digest("hex");

    const integrity = computeIntegrity(content);

    expect(integrity.sha256).toBe(expected);
    expect(integrity.size).toBe(Buffer.byteLength(content, "utf8"));
  });

  it("computes size in bytes for multi-byte content", () => {
    const integrity = computeIntegrity("café");
    expect(integrity.size).toBe(5);
  });

  it("attaches integrity and provenance without clobbering existing fields", () => {
    const artifact: RunArtifact = {
      id: "site-plan",
      type: "autofarm.site-plan",
      producer: "plan",
      mediaType: "application/json",
    };

    const enriched = withProvenance(artifact, "{}", {
      runId: "run-1",
      stageId: "plan",
      attempt: 2,
    });

    expect(enriched).toMatchObject({
      id: "site-plan",
      type: "autofarm.site-plan",
      producer: "plan",
      sha256: createHash("sha256").update("{}", "utf8").digest("hex"),
      size: 2,
      createdByRunId: "run-1",
      stageId: "plan",
      attempt: 2,
    });
  });

  it("does not overwrite a digest that is already present", () => {
    const artifact: RunArtifact = {
      id: "a",
      producer: "p",
      mediaType: "text/plain",
      sha256: "preexisting",
    };
    const enriched = withProvenance(artifact, "different", { runId: "run-1" });
    expect(enriched.sha256).toBe("preexisting");
  });
});
