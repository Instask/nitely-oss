import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

export const EVIDENCE_POLICY_FILENAME = "nitely.evidence.json";

export interface EvidenceRetentionPolicy {
  runsDays: number | null;
  eventsDays: number | null;
  logsDays: number | null;
  artifactsDays: number | null;
  evidenceDays: number | null;
}

export interface LoadedEvidencePolicy {
  source: "default" | "file";
  path: string;
  retention: EvidenceRetentionPolicy;
  effectiveRetention: EvidenceRetentionPolicy;
}

const retentionDaysSchema = z.number().int().nonnegative().nullable().optional();

const evidencePolicySchema = z.object({
  apiVersion: z.literal("nitely.dev/v1alpha1"),
  kind: z.literal("EvidencePolicy"),
  spec: z.object({
    retention: z.object({
      runsDays: retentionDaysSchema,
      eventsDays: retentionDaysSchema,
      logsDays: retentionDaysSchema,
      artifactsDays: retentionDaysSchema,
      evidenceDays: retentionDaysSchema,
    }).strict(),
  }).strict(),
}).strict();

const DEFAULT_RETENTION: EvidenceRetentionPolicy = {
  runsDays: null,
  eventsDays: null,
  logsDays: null,
  artifactsDays: null,
  evidenceDays: null,
};

function componentEffectiveDays(
  componentDays: number | null,
  runsDays: number | null,
): number | null {
  if (runsDays === null) return componentDays;
  if (componentDays === null) return runsDays;
  return Math.min(componentDays, runsDays);
}

export function effectiveEvidenceRetention(
  retention: EvidenceRetentionPolicy,
): EvidenceRetentionPolicy {
  return {
    runsDays: retention.runsDays,
    eventsDays: retention.eventsDays,
    logsDays: componentEffectiveDays(retention.logsDays, retention.runsDays),
    artifactsDays: componentEffectiveDays(
      retention.artifactsDays,
      retention.runsDays,
    ),
    evidenceDays: componentEffectiveDays(
      retention.evidenceDays,
      retention.runsDays,
    ),
  };
}
export function evidencePolicyPath(repoPath: string): string {
  return join(resolve(repoPath), EVIDENCE_POLICY_FILENAME);
}

function policyValidationMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "document";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function normalizeRetention(
  parsed: z.infer<typeof evidencePolicySchema>,
): EvidenceRetentionPolicy {
  return {
    runsDays: parsed.spec.retention.runsDays ?? null,
    eventsDays: parsed.spec.retention.eventsDays ?? null,
    logsDays: parsed.spec.retention.logsDays ?? null,
    artifactsDays: parsed.spec.retention.artifactsDays ?? null,
    evidenceDays: parsed.spec.retention.evidenceDays ?? null,
  };
}

function validateRetentionOrdering(retention: EvidenceRetentionPolicy): void {
  if (
    retention.runsDays !== null &&
    retention.eventsDays !== null &&
    retention.eventsDays < retention.runsDays
  ) {
    throw new Error(
      "invalid evidence policy: eventsDays must be greater than or equal to runsDays so terminal state is retained until run directories are eligible",
    );
  }
}

export async function loadEvidencePolicy(
  repoPath: string,
): Promise<LoadedEvidencePolicy> {
  const path = evidencePolicyPath(repoPath);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        source: "default",
        path,
        retention: { ...DEFAULT_RETENTION },
        effectiveRetention: { ...DEFAULT_RETENTION },
      };
    }
    throw error;
  }

  let document: unknown;
  try {
    document = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `invalid evidence policy ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = evidencePolicySchema.safeParse(document);
  if (!result.success) {
    throw new Error(
      `invalid evidence policy ${path}: ${policyValidationMessage(result.error)}`,
    );
  }
  const retention = normalizeRetention(result.data);
  validateRetentionOrdering(retention);
  return {
    source: "file",
    path,
    retention,
    effectiveRetention: effectiveEvidenceRetention(retention),
  };
}
