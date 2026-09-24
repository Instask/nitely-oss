import { z } from "zod";

import type { ReproducibilityManifest } from "../run/reproducibility.js";
import { CODEX_SANDBOX_MODES } from "../run/execution/sandbox.js";

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/i);
const commitShaSchema = z.string().regex(/^[0-9a-f]{40}$/i);
const runtimeCandidateSchema = z.object({
  runtime: z.string().min(1),
  model: z.string().min(1).optional(),
}).strict();

const contextDecisionSchema = z.object({
  decision: z.enum(["allowed", "excluded", "warned"]),
  reason: z.string().optional(),
  matchedPattern: z.string().optional(),
}).strict();

export const baselineReproducibilityManifestSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  generatedAt: z.string().datetime(),
  replayability: z.enum([
    "replayable",
    "partially-replayable",
    "diagnostic-only",
  ]),
  repo: z.object({
    path: z.string().min(1),
    name: z.string().min(1).optional(),
    baseBranch: z.string().min(1).optional(),
    baseCommit: commitShaSchema,
    branch: z.string().min(1).optional(),
    headCommit: commitShaSchema.optional(),
    worktreePath: z.string().min(1).optional(),
  }).strict(),
  flow: z.object({
    name: z.string().min(1),
    path: z.string().min(1).optional(),
    documentSha256: sha256Schema.optional(),
    configurationSha256: sha256Schema.optional(),
  }).strict(),
  inputs: z.array(z.object({
    id: z.string().min(1),
    connector: z.string().min(1),
    sourceUri: z.string().min(1),
    mediaType: z.string().min(1).optional(),
    revision: z.string().min(1).optional(),
    runRelativePath: z.string().min(1).optional(),
    sha256: sha256Schema.optional(),
    policy: contextDecisionSchema.optional(),
  }).strict()),
  context: z.object({
    policySha256: sha256Schema,
    constitution: z.object({
      loaded: z.boolean(),
      path: z.string().min(1),
      hash: sha256Schema.optional(),
    }).strict(),
    projectInstructions: z.object({
      loaded: z.boolean(),
      path: z.string().min(1),
      hash: sha256Schema.optional(),
    }).strict().optional(),
  }).strict(),
  runtimes: z.array(z.object({
    stageId: z.string().min(1),
    kind: z.enum(["agent", "judge", "review-gate"]),
    candidates: z.array(runtimeCandidateSchema),
    selected: runtimeCandidateSchema.optional(),
  }).strict()),
  commands: z.array(z.object({
    stageId: z.string().min(1),
    command: z.string(),
    timeoutMs: z.number().int().positive().optional(),
  }).strict()),
  skills: z.array(z.object({
    stageId: z.string().min(1),
    id: z.string().min(1),
    sourcePath: z.string().min(1),
    contentHash: sha256Schema,
    resources: z.array(z.string().min(1)),
  }).strict()),
  providers: z.array(z.object({
    id: z.string().min(1),
    configured: z.boolean(),
    credential: z.object({
      scope: z.string().optional(),
      source: z.string().optional(),
      ownerId: z.string().optional(),
      repositoryId: z.string().optional(),
      organizationId: z.string().optional(),
      vaultRef: z.string().optional(),
    }).strict().optional(),
  }).strict()),
  environment: z.object({
    nodeVersion: z.string().min(1),
    platform: z.string().min(1),
    arch: z.string().min(1),
    executionBackend: z.string().min(1).optional(),
    sandboxPolicy: z.object({
      codex: z.enum(CODEX_SANDBOX_MODES),
    }).strict().optional(),
  }).strict(),
  nonDeterministicFactors: z.array(z.string().min(1)),
  missingReplayPrerequisites: z.array(z.string().min(1)),
}).strict().superRefine((value, context) => {
  const expectedReplayability = value.missingReplayPrerequisites.length > 0
    ? "diagnostic-only"
    : value.nonDeterministicFactors.length > 0
      ? "partially-replayable"
      : "replayable";
  if (value.replayability !== expectedReplayability) {
    context.addIssue({
      code: "custom",
      path: ["replayability"],
      message:
        `replayability ${value.replayability} is inconsistent with recorded prerequisites and nondeterminism`,
    });
  }

  for (const [name, source] of [
    ["constitution", value.context.constitution],
    ["projectInstructions", value.context.projectInstructions],
  ] as const) {
    if (source && source.loaded !== (source.hash !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["context", name, "hash"],
        message: source.loaded
          ? "loaded prompt context requires a content hash"
          : "unloaded prompt context must not include a content hash",
      });
    }
  }

  for (const [path, ids] of [
    [["inputs"], value.inputs.map((entry) => entry.id)],
    [["runtimes"], value.runtimes.map((entry) => entry.stageId)],
    [["commands"], value.commands.map((entry) => entry.stageId)],
  ] as const) {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) {
        context.addIssue({
          code: "custom",
          path: [...path],
          message: `duplicate runtime manifest identity: ${id}`,
        });
      }
      seen.add(id);
    }
  }

  const seenSkills = new Set<string>();
  for (const [index, skill] of value.skills.entries()) {
    const identity = `${skill.stageId}\0${skill.id}`;
    if (seenSkills.has(identity)) {
      context.addIssue({
        code: "custom",
        path: ["skills", index],
        message: `duplicate skill manifest identity: ${skill.stageId}/${skill.id}`,
      });
    }
    seenSkills.add(identity);
  }
});

export function parseBaselineReproducibilityManifest(
  value: unknown,
): ReproducibilityManifest {
  return baselineReproducibilityManifestSchema.parse(
    value,
  ) as ReproducibilityManifest;
}
