import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ContextManifestEntry } from "../context/manifest.js";
import type { ProviderConnectionStatus } from "../providers/types.js";
import type { RuntimeCandidate } from "../flow/schema.js";
import type { RunSandboxPolicy } from "./execution/sandbox.js";

export type Replayability = "replayable" | "partially-replayable" | "diagnostic-only";

export interface ReproducibilityInputSnapshot {
  id: string;
  connector: string;
  sourceUri: string;
  mediaType?: string;
  revision?: string;
  runRelativePath?: string;
  sha256?: string;
  policy?: ContextManifestEntry["policy"];
}

export interface ReproducibilityCommandStage {
  stageId: string;
  command: string;
  timeoutMs?: number;
}

export interface ReproducibilityRuntimeStage {
  stageId: string;
  kind: "agent" | "judge" | "review-gate";
  candidates: RuntimeCandidate[];
  selected?: RuntimeCandidate;
}

export interface ReproducibilitySkillSource {
  stageId: string;
  id: string;
  sourcePath: string;
  contentHash: string;
  resources: string[];
}

export interface ReproducibilityProviderStatus {
  id: string;
  configured: boolean;
  credential?: {
    scope?: string;
    source?: string;
    ownerId?: string;
    repositoryId?: string;
    organizationId?: string;
    vaultRef?: string;
  };
}

export interface ReproducibilityManifest {
  version: 1;
  runId: string;
  generatedAt: string;
  replayability: Replayability;
  repo: {
    path: string;
    name?: string;
    baseBranch?: string;
    baseCommit?: string;
    branch?: string;
    headCommit?: string;
    worktreePath?: string;
  };
  flow: {
    name: string;
    path?: string;
    documentSha256?: string;
    configurationSha256?: string;
  };
  inputs: ReproducibilityInputSnapshot[];
  context: {
    policySha256: string;
    constitution: {
      loaded: boolean;
      path: string;
      hash?: string;
    };
    projectInstructions?: {
      loaded: boolean;
      path: string;
      hash?: string;
    };
  };
  runtimes: ReproducibilityRuntimeStage[];
  commands: ReproducibilityCommandStage[];
  skills: ReproducibilitySkillSource[];
  providers: ReproducibilityProviderStatus[];
  environment: {
    nodeVersion: string;
    platform: NodeJS.Platform;
    arch: string;
    executionBackend?: string;
    imageReference?: string;
    imageIdentity?: string;
    sandboxPolicy?: RunSandboxPolicy;
  };
  nonDeterministicFactors: string[];
  missingReplayPrerequisites: string[];
}

export interface ReproducibilityDiagnostic {
  replayability: Replayability;
  manifestPath: string;
  summary: string;
  missingReplayPrerequisites: string[];
  nonDeterministicFactors: string[];
}

export function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export async function sha256File(path: string): Promise<string | undefined> {
  try {
    return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
  } catch {
    return undefined;
  }
}

export function reproducibilityManifestPath(runDirectory: string): string {
  return join(runDirectory, "reproducibility.json");
}

function providerStatusForManifest(
  status: ProviderConnectionStatus,
): ReproducibilityProviderStatus {
  return {
    id: status.id,
    configured: status.configured,
    ...(status.credential
      ? {
          credential: {
            scope: status.credential.scope,
            source: status.credential.source,
            ownerId: status.credential.ownerId,
            repositoryId: status.credential.repositoryId,
            organizationId: status.credential.organizationId,
            vaultRef: status.credential.vaultRef,
          },
        }
      : {}),
  };
}

export function classifyReplayability(input: {
  missingReplayPrerequisites: string[];
  nonDeterministicFactors: string[];
}): Replayability {
  if (input.missingReplayPrerequisites.length > 0) {
    return "diagnostic-only";
  }
  if (input.nonDeterministicFactors.length > 0) {
    return "partially-replayable";
  }
  return "replayable";
}

export function diagnosticForManifest(
  manifest: ReproducibilityManifest,
  manifestPath: string,
): ReproducibilityDiagnostic {
  const summary =
    manifest.replayability === "replayable"
      ? "all recorded prerequisites are available"
      : manifest.replayability === "partially-replayable"
        ? "recorded state is available with known non-determinism"
        : "missing prerequisites prevent replay";
  return {
    replayability: manifest.replayability,
    manifestPath,
    summary,
    missingReplayPrerequisites: manifest.missingReplayPrerequisites,
    nonDeterministicFactors: manifest.nonDeterministicFactors,
  };
}

export async function writeReproducibilityManifest(input: {
  runDirectory: string;
  runId: string;
  repo: ReproducibilityManifest["repo"];
  flow: ReproducibilityManifest["flow"];
  inputs: ReproducibilityInputSnapshot[];
  context: ReproducibilityManifest["context"];
  runtimes: ReproducibilityRuntimeStage[];
  commands: ReproducibilityCommandStage[];
  skills: ReproducibilitySkillSource[];
  providers: ProviderConnectionStatus[];
  executionBackend?: string;
  executionImage?: { reference: string; identity: string };
  sandboxPolicy?: RunSandboxPolicy;
  nonDeterministicFactors?: string[];
  missingReplayPrerequisites?: string[];
}): Promise<ReproducibilityManifest> {
  const missingReplayPrerequisites = input.missingReplayPrerequisites ?? [];
  const nonDeterministicFactors = input.nonDeterministicFactors ?? [];
  const manifest: ReproducibilityManifest = {
    version: 1,
    runId: input.runId,
    generatedAt: new Date().toISOString(),
    replayability: classifyReplayability({
      missingReplayPrerequisites,
      nonDeterministicFactors,
    }),
    repo: input.repo,
    flow: input.flow,
    inputs: input.inputs,
    context: input.context,
    runtimes: input.runtimes,
    commands: input.commands,
    skills: input.skills,
    providers: input.providers.map(providerStatusForManifest),
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      ...(input.executionBackend ? { executionBackend: input.executionBackend } : {}),
      ...(input.executionImage
        ? {
            imageReference: input.executionImage.reference,
            imageIdentity: input.executionImage.identity,
          }
        : {}),
      ...(input.sandboxPolicy ? { sandboxPolicy: input.sandboxPolicy } : {}),
    },
    nonDeterministicFactors,
    missingReplayPrerequisites,
  };
  await writeFile(
    reproducibilityManifestPath(input.runDirectory),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

export async function readReproducibilityManifest(input: {
  runDirectory: string;
}): Promise<ReproducibilityManifest | undefined> {
  try {
    return JSON.parse(
      await readFile(reproducibilityManifestPath(input.runDirectory), "utf8"),
    ) as ReproducibilityManifest;
  } catch {
    return undefined;
  }
}
