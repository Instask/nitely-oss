import { z } from "zod";

export const IDENTIFIER_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_.-]{0,160}$/;

export const identifierSchema = z
  .string()
  .regex(
    IDENTIFIER_PATTERN,
    "must start with a letter or number and contain only letters, numbers, dots, underscores, and hyphens",
  );

export const outputDeclarationSchema = z.union([
  identifierSchema,
  z.object({
    id: identifierSchema,
    name: z.string().min(1).optional(),
    type: identifierSchema.optional(),
    description: z.string().min(1).optional(),
    mediaType: z.string().min(1).optional(),
    schema: z.unknown().optional(),
    version: z.string().min(1).optional(),
  }),
]);

export const providerIdSchema = z.enum([
  "github",
  "codex",
  "anthropic",
  "glm",
  "google-drive",
]);

const stageBase = z.object({
  id: identifierSchema,
  inputs: z.array(identifierSchema).default([]),
  outputs: z.array(outputDeclarationSchema).default([]),
  maxAttempts: z.number().int().positive().optional(),
});

function addDuplicateArrayIssue(
  context: z.RefinementCtx,
  stageId: string,
  field: "skills" | "required_mcp_servers" | "required_connectors",
  values: readonly string[],
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      const duplicateLabel = field === "skills" ? "skill" : field;
      context.addIssue({
        code: "custom",
        path: [field],
        message: `duplicate ${duplicateLabel} id on stage ${stageId}: ${value}`,
      });
    }
    seen.add(value);
  }
}

function addAgentLikeDuplicateIssues(
  context: z.RefinementCtx,
  stage: {
    id: string;
    skills: string[];
    required_mcp_servers: string[];
    required_connectors: string[];
  },
): void {
  addDuplicateArrayIssue(context, stage.id, "skills", stage.skills);
  addDuplicateArrayIssue(
    context,
    stage.id,
    "required_mcp_servers",
    stage.required_mcp_servers,
  );
  addDuplicateArrayIssue(
    context,
    stage.id,
    "required_connectors",
    stage.required_connectors,
  );
}

const requiredMcpServersSchema = z.array(identifierSchema).default([]);
const requiredConnectorsSchema = z.array(providerIdSchema).default([]);
const runtimeCandidateSchema = z.object({
  runtime: z.string().min(1),
  model: z.string().min(1).optional(),
});

function addRuntimeCandidateIssues(
  context: z.RefinementCtx,
  stage: {
    runtime?: string;
    model?: string;
    runtimes?: unknown;
  },
): void {
  if (stage.runtime && stage.runtimes !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["runtimes"],
      message: "stage must declare either runtime/model or runtimes, not both",
    });
  }
  if (stage.model && !stage.runtime) {
    context.addIssue({
      code: "custom",
      path: ["model"],
      message: "model requires runtime",
    });
  }
  if (!stage.runtime && stage.runtimes === undefined) {
    context.addIssue({
      code: "custom",
      path: ["runtime"],
      message: "stage must declare runtime or runtimes",
    });
  }
}

function runtimeConfigValidationInput(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (record.runtime === undefined && record.runtimes === undefined) {
    return { ...record, runtime: "" };
  }
  return value;
}

const nonToolOutputBudgetedSchema = z
  .never({ error: "maxToolOutputTokens is only valid on command and deterministic gate stages" })
  .optional();

const agentStageSchema = z.preprocess(runtimeConfigValidationInput, stageBase.extend({
  type: z.literal("agent"),
  runtime: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  runtimes: z.array(runtimeCandidateSchema).min(1).optional(),
  skills: z.array(identifierSchema).default([]),
  required_mcp_servers: requiredMcpServersSchema,
  required_connectors: requiredConnectorsSchema,
  prompt: z.string().min(1),
  maxInputTokens: z.number().int().positive().optional(),
  maxToolOutputTokens: nonToolOutputBudgetedSchema,
  outputs: z.array(outputDeclarationSchema).min(1),
}).superRefine((stage, context) => {
  addRuntimeCandidateIssues(context, stage);
  addAgentLikeDuplicateIssues(context, stage);
}));

const nonAgentSkillsSchema = z
  .never({ error: "skills are only valid on agent stages" })
  .optional();

const nonAgentRequiredMcpServersSchema = z
  .never({
    error: "required_mcp_servers are only valid on agent and review gate stages",
  })
  .optional();

const nonAgentRequiredConnectorsSchema = z
  .never({
    error: "required_connectors are only valid on agent and review gate stages",
  })
  .optional();

const nonBudgetedMaxInputTokensSchema = z
  .never({ error: "maxInputTokens is only valid on agent and review gate stages" })
  .optional();

const commandStageSchema = stageBase.extend({
  type: z.literal("command"),
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
  maxToolOutputTokens: z.number().int().positive().optional(),
  skills: nonAgentSkillsSchema,
  required_mcp_servers: nonAgentRequiredMcpServersSchema,
  required_connectors: nonAgentRequiredConnectorsSchema,
  maxInputTokens: nonBudgetedMaxInputTokensSchema,
});

const gateBase = stageBase.extend({
  type: z.literal("gate"),
  mode: z.enum(["deterministic", "review"]),
  name: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const deterministicGateStageSchema = gateBase.extend({
  mode: z.literal("deterministic"),
  command: z.string().min(1),
  maxToolOutputTokens: z.number().int().positive().optional(),
  skills: nonAgentSkillsSchema,
  required_mcp_servers: nonAgentRequiredMcpServersSchema,
  required_connectors: nonAgentRequiredConnectorsSchema,
  maxInputTokens: nonBudgetedMaxInputTokensSchema,
});

const reviewGateStageSchema = stageBase.extend({
  type: z.literal("gate"),
  mode: z.literal("review"),
  name: z.string().min(1).optional(),
  runtime: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  runtimes: z.array(runtimeCandidateSchema).min(1).optional(),
  skills: z.array(identifierSchema).default([]),
  required_mcp_servers: requiredMcpServersSchema,
  required_connectors: requiredConnectorsSchema,
  prompt: z.string().min(1),
  maxInputTokens: z.number().int().positive().optional(),
  maxToolOutputTokens: nonToolOutputBudgetedSchema,
  outputs: z.array(outputDeclarationSchema).min(1),
  timeoutMs: z
    .never({ error: "timeoutMs is only valid on command and deterministic gate stages" })
    .optional(),
}).superRefine((stage, context) => {
  addRuntimeCandidateIssues(context, stage);
  addAgentLikeDuplicateIssues(context, stage);
});

const analysisGateStageSchema = stageBase.extend({
  type: z.literal("gate"),
  mode: z.literal("analysis"),
  name: z.string().min(1).optional(),
  blocking: z.boolean().default(true),
  outputs: z.array(outputDeclarationSchema).min(1),
  command: z
    .never({ error: "command is only valid on deterministic gate stages" })
    .optional(),
  timeoutMs: z
    .never({ error: "timeoutMs is only valid on command and deterministic gate stages" })
    .optional(),
  skills: nonAgentSkillsSchema,
  required_mcp_servers: nonAgentRequiredMcpServersSchema,
  required_connectors: nonAgentRequiredConnectorsSchema,
  maxInputTokens: nonBudgetedMaxInputTokensSchema,
  maxToolOutputTokens: nonToolOutputBudgetedSchema,
  runtime: z
    .never({ error: "runtime is only valid on agent and review gate stages" })
    .optional(),
  model: z
    .never({ error: "model is only valid on agent and review gate stages" })
    .optional(),
  runtimes: z
    .never({ error: "runtimes are only valid on agent and review gate stages" })
    .optional(),
  prompt: z
    .never({ error: "prompt is only valid on agent and review gate stages" })
    .optional(),
});

const gateStageSchema = z.discriminatedUnion("mode", [
  deterministicGateStageSchema,
  reviewGateStageSchema,
  analysisGateStageSchema,
]);

const approvalStageSchema = stageBase.extend({
  type: z.literal("approval"),
  prompt: z.string().min(1),
  skills: nonAgentSkillsSchema,
  required_mcp_servers: nonAgentRequiredMcpServersSchema,
  required_connectors: nonAgentRequiredConnectorsSchema,
  maxInputTokens: nonBudgetedMaxInputTokensSchema,
  maxToolOutputTokens: nonToolOutputBudgetedSchema,
});

const publishChangeStageSchema = stageBase.extend({
  type: z.literal("publish-change"),
  provider: z.enum(["github", "github-cli"]).optional(),
  skills: nonAgentSkillsSchema,
  required_mcp_servers: nonAgentRequiredMcpServersSchema,
  required_connectors: nonAgentRequiredConnectorsSchema,
  maxInputTokens: nonBudgetedMaxInputTokensSchema,
  maxToolOutputTokens: nonToolOutputBudgetedSchema,
});

const updateChangeStageSchema = stageBase.extend({
  type: z.literal("update-change"),
  provider: z.enum(["github", "github-cli"]).optional(),
  skills: nonAgentSkillsSchema,
  required_mcp_servers: nonAgentRequiredMcpServersSchema,
  required_connectors: nonAgentRequiredConnectorsSchema,
  maxInputTokens: nonBudgetedMaxInputTokensSchema,
  maxToolOutputTokens: nonToolOutputBudgetedSchema,
});

const syncChangeStageSchema = stageBase.extend({
  type: z.literal("sync-change"),
  strategy: z.literal("merge").default("merge"),
  skills: nonAgentSkillsSchema,
  required_mcp_servers: nonAgentRequiredMcpServersSchema,
  required_connectors: nonAgentRequiredConnectorsSchema,
  maxInputTokens: nonBudgetedMaxInputTokensSchema,
  maxToolOutputTokens: nonToolOutputBudgetedSchema,
});

export const stageSchema = z.union([
  agentStageSchema,
  commandStageSchema,
  gateStageSchema,
  approvalStageSchema,
  publishChangeStageSchema,
  updateChangeStageSchema,
  syncChangeStageSchema,
]);

export const inputContractSchema = z.object({
  id: identifierSchema,
  type: identifierSchema.optional(),
});

export const flowSchema = z.object({
  apiVersion: z.literal("nitely.dev/v1alpha1"),
  kind: z.literal("Flow"),
  metadata: z.object({
    name: z.string().min(1),
    workItemType: identifierSchema.optional(),
    inputs: z.array(inputContractSchema).optional(),
  }),
  spec: z.object({
    maxAttempts: z.number().int().positive().optional(),
    maxInputTokens: z.number().int().positive().optional(),
    maxToolOutputTokens: z.number().int().positive().optional(),
    stages: z.array(stageSchema).min(1),
  }),
});

export type Flow = z.infer<typeof flowSchema>;
export type Stage = z.infer<typeof stageSchema>;
export type OutputDeclaration = z.infer<typeof outputDeclarationSchema>;
export type InputContract = z.infer<typeof inputContractSchema>;

export interface RuntimeCandidate {
  runtime: string;
  model?: string;
}

export const DEFAULT_WORK_ITEM_TYPE = "dev.pr";

export function flowWorkItemType(
  flow: Pick<Flow, "metadata">,
): string {
  return flow.metadata.workItemType ?? DEFAULT_WORK_ITEM_TYPE;
}

export function outputId(output: OutputDeclaration): string {
  return typeof output === "string" ? output : output.id;
}

export function outputContract(output: OutputDeclaration): {
  id: string;
  name?: string;
  type?: string;
  description?: string;
  mediaType?: string;
  schema?: unknown;
  version?: string;
} {
  return typeof output === "string" ? { id: output } : output;
}

export function stageOutputIds(stage: Pick<Stage, "outputs">): string[] {
  return stage.outputs.map(outputId);
}

export function stageOutputContracts(
  stage: Pick<Stage, "outputs">,
): ReturnType<typeof outputContract>[] {
  return stage.outputs.map(outputContract);
}

export function stageRuntimeCandidates(
  stage:
    | Extract<Stage, { type: "agent" }>
    | Extract<Stage, { type: "gate"; mode: "review" }>,
): RuntimeCandidate[] {
  return "runtimes" in stage && stage.runtimes
    ? stage.runtimes.map((candidate) => ({
        runtime: candidate.runtime.trim(),
        ...(candidate.model ? { model: candidate.model } : {}),
      }))
    : [
        {
          runtime: stage.runtime?.trim() ?? "",
          ...(stage.model ? { model: stage.model } : {}),
        },
      ];
}

export function stageOutputContract(
  stage: Pick<Stage, "outputs">,
  id: string,
): ReturnType<typeof outputContract> | undefined {
  return stage.outputs.map(outputContract).find((contract) => contract.id === id);
}
