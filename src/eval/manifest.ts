import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import {
  containsSensitiveText,
  isSafeTokenCountField,
  isSensitiveKey,
} from "../context/redaction.js";
import { CODEX_SANDBOX_MODES } from "../run/execution/sandbox.js";

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,160}$/);
const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/i);
const gitRevisionSchema = z.string().regex(/^[0-9a-f]{40}$/i);
const relativePathSchema = z.string().min(1).refine((value) => {
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.includes("\0")) {
    return false;
  }
  const segments = value.split(/[\\/]/);
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}, "path must be a contained relative path");

const rateThresholdSchema = z.object({
  maxAbsoluteDecrease: z.number().min(0).max(1),
}).strict();

const increaseThresholdSchema = z.object({
  maxRelativeIncrease: z.number().min(0),
}).strict();

const reviewerRateThresholdSchema = z.object({
  maxAbsoluteDecrease: z.number().min(0).max(1),
}).strict();

const reviewerIncreaseThresholdSchema = z.object({
  maxRelativeIncrease: z.number().min(0),
}).strict();

function sensitiveConfigurationField(key: string, value: unknown): boolean {
  return /headers?/i.test(key) ||
    (isSensitiveKey(key) && !isSafeTokenCountField(key, value));
}

function sensitiveConfigurationValue(value: string): boolean {
  return containsSensitiveText(value);
}

const configurationSchema = z.record(
  idSchema,
  z.union([z.string(), z.number().finite(), z.boolean()]),
).superRefine((value, context) => {
  for (const [key, entry] of Object.entries(value)) {
    if (sensitiveConfigurationField(key, entry)) {
      context.addIssue({
        code: "custom",
        message: "secret-bearing configuration keys are not allowed",
        path: [key],
      });
    }
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && sensitiveConfigurationValue(entry)) {
      context.addIssue({
        code: "custom",
        message: "secret-bearing configuration values are not allowed",
        path: [key],
      });
    }
  }
});

function reportDuplicateIds(
  values: readonly string[],
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        message: `duplicate id: ${value}`,
        path,
      });
    }
    seen.add(value);
  }
}

const evalCaseSchema = z.object({
  id: idSchema,
  baselineRunId: idSchema,
  source: z.object({ revision: gitRevisionSchema }).strict(),
  flow: z.object({ path: relativePathSchema, sha256: sha256Schema }).strict(),
  inputs: z.array(z.object({
    id: idSchema,
    path: relativePathSchema,
    sha256: sha256Schema,
  }).strict()),
  runtime: z.object({
    executionBackend: idSchema,
    sandboxPolicy: z.object({
      codex: z.enum(CODEX_SANDBOX_MODES),
    }).strict(),
    stages: z.array(z.object({
      stageId: idSchema,
      runtime: idSchema,
      model: z.string().trim().min(1),
    }).strict()),
  }).strict(),
  configuration: configurationSchema.optional(),
  contextPolicy: z.object({ sha256: sha256Schema }).strict(),
  expectedGates: z.array(idSchema),
  reviewEvaluation: z.object({
    reviewerStageIds: z.array(idSchema).min(1),
    candidateDiff: z.object({ inputId: idSchema }).strict(),
    approvedSpec: z.object({ inputId: idSchema }).strict().optional(),
    technicalDesign: z.object({ inputId: idSchema }).strict().optional(),
    deterministicEvidence: z.array(z.object({ inputId: idSchema }).strict()),
    acceptedHumanFindings: z.array(z.object({
      defectId: idSchema,
      evidence: z.string().trim().min(1),
    }).strict()).optional(),
    knownGood: z.boolean(),
    expectedDefects: z.array(z.object({
      id: idSchema,
      category: idSchema,
      severity: z.enum(["critical", "high", "medium", "low"]),
      description: z.string().trim().min(1),
      file: relativePathSchema.optional(),
      line: z.number().int().positive().optional(),
      requirement: z.string().trim().min(1).optional(),
      provenance: z.enum([
        "historical-production-review-bug",
        "historical-human-review-finding",
        "deliberately-seeded",
        "mutation-generated",
        "known-good-negative",
      ]),
    }).strict()),
  }).strict().optional(),
  allowedNondeterminism: z.array(z.object({
    id: idSchema,
    description: z.string().trim().min(1),
  }).strict()),
  scoring: z.object({
    requireReviewablePr: z.boolean(),
    requireExpectedGates: z.boolean(),
  }).strict(),
}).strict().superRefine((value, context) => {
  reportDuplicateIds(value.inputs.map((entry) => entry.id), ["inputs"], context);
  reportDuplicateIds(
    value.runtime.stages.map((entry) => entry.stageId),
    ["runtime", "stages"],
    context,
  );
  reportDuplicateIds(value.expectedGates, ["expectedGates"], context);
  if (value.reviewEvaluation) {
    reportDuplicateIds(
      value.reviewEvaluation.reviewerStageIds,
      ["reviewEvaluation", "reviewerStageIds"],
      context,
    );
    reportDuplicateIds(
      value.reviewEvaluation.expectedDefects.map((entry) => entry.id),
      ["reviewEvaluation", "expectedDefects"],
      context,
    );
    const defectIds = new Set(
      value.reviewEvaluation.expectedDefects.map((entry) => entry.id),
    );
    for (const finding of value.reviewEvaluation.acceptedHumanFindings ?? []) {
      if (!defectIds.has(finding.defectId)) {
        context.addIssue({
          code: "custom",
          message: `accepted human finding references unknown defect: ${finding.defectId}`,
          path: ["reviewEvaluation", "acceptedHumanFindings"],
        });
      }
    }
  }
  reportDuplicateIds(
    value.allowedNondeterminism.map((entry) => entry.id),
    ["allowedNondeterminism"],
    context,
  );
  if (value.reviewEvaluation?.knownGood && value.reviewEvaluation.expectedDefects.length > 0) {
    context.addIssue({
      code: "custom",
      message: "known-good review cases must not declare expected defects",
      path: ["reviewEvaluation", "expectedDefects"],
    });
  }
});

export const evalCohortManifestSchema = z.object({
  schemaVersion: z.literal("nitely.eval-cohort.v1"),
  cohort: z.object({
    id: idSchema,
    baselineCohortId: idSchema.optional(),
  }).strict(),
  cases: z.array(evalCaseSchema).min(1),
  thresholds: z.object({
    reviewablePrRate: rateThresholdSchema.optional(),
    gatePassRate: rateThresholdSchema.optional(),
    retriesPerRun: increaseThresholdSchema.optional(),
    humanReworkPerRun: increaseThresholdSchema.optional(),
    latencyMs: increaseThresholdSchema.optional(),
    actualCostUsd: increaseThresholdSchema.optional(),
    estimatedCostUsd: increaseThresholdSchema.optional(),
    reviewerCriticalRecall: reviewerRateThresholdSchema.optional(),
    reviewerOverallRecall: reviewerRateThresholdSchema.optional(),
    reviewerFalsePositiveRate: reviewerIncreaseThresholdSchema.optional(),
    reviewerPassOnDefectiveRate: reviewerIncreaseThresholdSchema.optional(),
    reviewerFailOnKnownGoodRate: reviewerIncreaseThresholdSchema.optional(),
  }).strict(),
}).strict().superRefine((value, context) => {
  reportDuplicateIds(value.cases.map((entry) => entry.id), ["cases"], context);
});

export type EvalCohortManifest = z.infer<typeof evalCohortManifestSchema>;
export type EvalCase = EvalCohortManifest["cases"][number];

export function parseEvalCohortManifest(value: unknown): EvalCohortManifest {
  return evalCohortManifestSchema.parse(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error(`manifest contains a non-JSON value: ${typeof value}`);
}

export function canonicalEvalManifestDocument(
  manifest: EvalCohortManifest,
): string {
  return canonicalJson(manifest);
}

export function evalManifestSha256(manifest: EvalCohortManifest): string {
  return `sha256:${createHash("sha256")
    .update(canonicalEvalManifestDocument(manifest), "utf8")
    .digest("hex")}`;
}

export async function loadEvalCohortManifest(path: string): Promise<{
  manifest: EvalCohortManifest;
  document: string;
  sha256: string;
}> {
  const document = await readFile(path, "utf8");
  const manifest = parseEvalCohortManifest(JSON.parse(document) as unknown);
  return {
    manifest,
    document,
    sha256: evalManifestSha256(manifest),
  };
}
