import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseFlowDocument } from "../../src/flow/load.js";
import { inferExternalInputs } from "../../src/flows/validate.js";
import { stageRuntimeCandidates } from "../../src/flow/schema.js";
import { hasRuntimeCandidates, stageReadIssues } from "../../src/run/preflight.js";

const FLOWS = join(import.meta.dirname, "..", "..", "flows");

async function loadShipped(name: string) {
  const content = await readFile(join(FLOWS, name), "utf8");
  return parseFlowDocument(content, { externalInputs: inferExternalInputs(content) }).flow;
}

describe("shipped flows", () => {
  it("never ask a stage to write or review files its runtime cannot read", async () => {
    const blind: string[] = [];
    for (const name of (await readdir(FLOWS)).filter((file) => file.endsWith(".json")).sort()) {
      const flow = await loadShipped(name);
      for (const stage of flow.spec.stages) {
        if (!hasRuntimeCandidates(stage)) continue;
        for (const issue of stageReadIssues(stage, stageRuntimeCandidates(stage))) {
          blind.push(`${name} ${issue.stageId} (${issue.runtime})`);
        }
      }
    }
    expect(blind).toEqual([]);
  });

  it("let write-tests stages read the code they test", async () => {
    const flow = await loadShipped("implement-spec-bootstrap.json");
    const writeTests = flow.spec.stages.find((stage) => stage.id === "write-tests");
    expect(writeTests && "capabilities" in writeTests && writeTests.capabilities?.commands).toMatchObject({
      mode: "allow-list",
      allow: expect.arrayContaining(["cat *", "rg *", "sed -n *"]),
    });
    expect(writeTests && "prompt" in writeTests && writeTests.prompt).toMatch(
      /extend existing test files in place, never rewrite a file or drop its existing cases/,
    );
  });
});

describe("runtime file reads", () => {
  it("records how each runtime reads repository files", async () => {
    const { createDefaultAgentRuntimeRegistry } = await import("../../src/run/execution/local.js");
    const registry = createDefaultAgentRuntimeRegistry();
    const reads = Object.fromEntries(
      registry.supportedIds().map((id) => [id, registry.resolve(id).fileReads ?? "unestablished"]),
    );
    // Codex reads only through shell commands. Claude and Pi-based runtimes
    // have native file tools. GLM and Grok are not established yet.
    expect(reads).toMatchObject({
      codex: "shell",
      claude: "native",
      openrouter: "native",
      pi: "native",
      together: "native",
      glm: "unestablished",
      grok: "unestablished",
    });
  });
});
