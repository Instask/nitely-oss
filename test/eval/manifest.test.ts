import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evalManifestSha256,
  loadEvalCohortManifest,
  parseEvalCohortManifest,
} from "../../src/eval/manifest.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const REVISION = "b".repeat(40);

function validManifest(): unknown {
  return {
    schemaVersion: "nitely.eval-cohort.v1",
    cohort: {
      id: "candidate-2026-07-16",
      baselineCohortId: "baseline-2026-07-15",
    },
    cases: [
      {
        id: "upgrade-zod",
        baselineRunId: "run-baseline-zod",
        source: { revision: REVISION },
        flow: { path: "flows/eval-upgrade.json", sha256: DIGEST },
        inputs: [
          {
            id: "ticket",
            path: "fixtures/upgrade-zod.md",
            sha256: DIGEST,
          },
        ],
        runtime: {
          executionBackend: "local",
          sandboxPolicy: { codex: "danger-full-access" },
          stages: [
            { stageId: "implement", runtime: "codex", model: "gpt-5.1-codex" },
          ],
        },
        contextPolicy: { sha256: DIGEST },
        expectedGates: ["review"],
        allowedNondeterminism: [
          { id: "model-output", description: "Equivalent implementation text may differ." },
        ],
        scoring: {
          requireReviewablePr: true,
          requireExpectedGates: true,
        },
      },
    ],
    thresholds: {
      reviewablePrRate: { maxAbsoluteDecrease: 0.05 },
      gatePassRate: { maxAbsoluteDecrease: 0.05 },
      retriesPerRun: { maxRelativeIncrease: 0.25 },
      humanReworkPerRun: { maxRelativeIncrease: 0.25 },
      latencyMs: { maxRelativeIncrease: 0.2 },
      actualCostUsd: { maxRelativeIncrease: 0.1 },
      estimatedCostUsd: { maxRelativeIncrease: 0.1 },
    },
  };
}

describe("eval cohort manifest", () => {
  it("parses a versioned cohort with immutable case references", () => {
    const manifest = parseEvalCohortManifest(validManifest());

    expect(manifest.schemaVersion).toBe("nitely.eval-cohort.v1");
    expect(manifest.cases[0]).toMatchObject({
      id: "upgrade-zod",
      source: { revision: REVISION },
      flow: { sha256: DIGEST },
      contextPolicy: { sha256: DIGEST },
    });
  });

  it("rejects mutable revisions, unpinned content, unsafe paths, and secret fields", () => {
    const mutations: Array<(manifest: any) => void> = [
      (manifest) => { manifest.cases[0].source.revision = "main"; },
      (manifest) => { manifest.cases[0].flow.sha256 = "latest"; },
      (manifest) => { manifest.cases[0].inputs[0].path = "../secret.md"; },
      (manifest) => { manifest.cases[0].inputs[0].revision = "main"; },
      (manifest) => { delete manifest.cases[0].runtime.stages[0].model; },
      (manifest) => { manifest.cases[0].runtime.stages[0].model = ""; },
      (manifest) => { manifest.cases[0].token = "must-not-be-a-manifest-field"; },
      (manifest) => {
        manifest.cases[0].configuration = { githubToken: "must-not-be-a-config-value" };
      },
      (manifest) => {
        manifest.cases[0].configuration = { accessTokens: "must-not-be-a-config-value" };
      },
      (manifest) => {
        manifest.cases[0].configuration = { refresh_tokens: "must-not-be-a-config-value" };
      },
      (manifest) => {
        manifest.cases[0].configuration = {
          accessInputTokens: "must-not-be-a-config-value",
        };
      },
      (manifest) => {
        manifest.cases[0].configuration = {
          refreshOutputTokens: "must-not-be-a-config-value",
        };
      },
      (manifest) => {
        manifest.cases[0].configuration = {
          accessTokensList: "must-not-be-a-config-value",
        };
      },
      (manifest) => {
        manifest.cases[0].configuration = {
          inputTokens: "opaque-secret-in-input-token-count",
        };
      },
      (manifest) => {
        manifest.cases[0].configuration = { inputTokens: -1 };
      },
      (manifest) => {
        manifest.cases[0].configuration = { inputTokens: 1.5 };
      },
      (manifest) => {
        manifest.cases[0].configuration = {
          inputTokens: Number.MAX_SAFE_INTEGER + 1,
        };
      },
      (manifest) => {
        manifest.cases[0].configuration = {
          notes: "accessTokens=must-not-be-a-config-value",
        };
      },
      (manifest) => {
        manifest.cases[0].configuration = {
          notes: "refresh_tokens=must-not-be-a-config-value",
        };
      },
      (manifest) => {
        manifest.cases[0].configuration = { credential: "opaque-private-value" };
      },
      (manifest) => {
        manifest.cases[0].configuration = {
          endpoint: "https://operator:private-password@example.test/api",
        };
      },
      (manifest) => {
        manifest.cases[0].configuration = {
          headers: "Bearer opaque-private-value",
        };
      },
      (manifest) => {
        manifest.cases[0].configuration = {
          passphrase: "opaque-private-value",
        };
      },
      (manifest) => {
        manifest.cases[0].configuration = {
          notes: "passphrase=opaque-private-value",
        };
      },
      (manifest) => {
        manifest.cases[0].configuration = {
          notes: "private_key=opaque-private-value",
        };
      },
    ];

    for (const mutate of mutations) {
      const manifest = validManifest() as any;
      mutate(manifest);
      expect(() => parseEvalCohortManifest(manifest)).toThrow();
    }
  });

  it("allows token usage counters in configuration", () => {
    const manifest = validManifest() as any;
    manifest.cases[0].configuration = {
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 20,
    };

    expect(parseEvalCohortManifest(manifest).cases[0].configuration).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 20,
    });
  });

  it("parses a blind reviewer case with pinned production inputs and gold defects", () => {
    const manifest = validManifest() as any;
    manifest.cases[0].inputs.push({
      id: "candidate-diff",
      path: "fixtures/candidate.diff",
      sha256: DIGEST,
    });
    manifest.cases[0].reviewEvaluation = {
      reviewerStageIds: ["review"],
      candidateDiff: { inputId: "candidate-diff" },
      approvedSpec: { inputId: "ticket" },
      technicalDesign: { inputId: "ticket" },
      deterministicEvidence: [],
      acceptedHumanFindings: [{
        defectId: "missing-authz",
        evidence: "human review identified the missing authorization",
      }],
      knownGood: false,
      expectedDefects: [{
        id: "missing-authz",
        category: "authorization",
        severity: "critical",
        description: "authorization is missing",
        file: "src/api.ts",
        provenance: "deliberately-seeded",
      }],
    };

    expect(parseEvalCohortManifest(manifest).cases[0].reviewEvaluation).toMatchObject({
      candidateDiff: { inputId: "candidate-diff" },
      expectedDefects: [{ id: "missing-authz", severity: "critical" }],
    });
  });

  it("rejects duplicate case-local identifiers and invalid threshold ratios", () => {
    const duplicateCase = validManifest() as any;
    duplicateCase.cases.push(structuredClone(duplicateCase.cases[0]));

    const duplicateInput = validManifest() as any;
    duplicateInput.cases[0].inputs.push(structuredClone(duplicateInput.cases[0].inputs[0]));

    const duplicateRuntime = validManifest() as any;
    duplicateRuntime.cases[0].runtime.stages.push(
      structuredClone(duplicateRuntime.cases[0].runtime.stages[0]),
    );

    const invalidRate = validManifest() as any;
    invalidRate.thresholds.gatePassRate.maxAbsoluteDecrease = 1.01;

    const invalidIncrease = validManifest() as any;
    invalidIncrease.thresholds.latencyMs.maxRelativeIncrease = -0.01;

    const emptyCohort = validManifest() as any;
    emptyCohort.cases = [];

    for (const manifest of [
      duplicateCase,
      duplicateInput,
      duplicateRuntime,
      invalidRate,
      invalidIncrease,
      emptyCohort,
    ]) {
      expect(() => parseEvalCohortManifest(manifest)).toThrow();
    }
  });

  it("loads a manifest with a stable canonical digest independent of JSON formatting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nitely-eval-manifest-"));
    const path = join(directory, "cohort.json");
    const document = `${JSON.stringify(validManifest(), null, 2)}\n`;
    await writeFile(path, document, "utf8");

    const loaded = await loadEvalCohortManifest(path);
    const compactPath = join(directory, "cohort-compact.json");
    await writeFile(compactPath, JSON.stringify(validManifest()), "utf8");
    const compact = await loadEvalCohortManifest(compactPath);

    expect(loaded.manifest.cohort.id).toBe("candidate-2026-07-16");
    expect(loaded.document).toBe(document);
    expect(loaded.sha256).toBe(evalManifestSha256(loaded.manifest));
    expect(compact.sha256).toBe(loaded.sha256);
  });
});
