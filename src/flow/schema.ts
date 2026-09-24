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
  "grok",
  "pi",
  "google-drive",
]);

export const knowledgeAttachmentIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,63}$/,
    "must be a lowercase knowledge attachment id using letters, numbers, underscores, or hyphens",
  );

export const externalKnowledgeContextSchema = z.union([
  z.boolean(),
  z.object({
    enabled: z.boolean().optional(),
    ids: z.array(knowledgeAttachmentIdSchema).min(1).optional(),
    topK: z.number().int().positive().max(50).optional(),
    maxPromptTokens: z.number().int().positive().max(32_768).optional(),
    availability: z.enum(["required", "degraded-ok"]).optional(),
  }),
]);

export const contextControlsSchema = z.object({
  isolated: z.boolean().optional(),
  instructionFiles: z.boolean().optional(),
  projectInstructions: z.boolean().optional(),
  contextKnowledge: z.boolean().optional(),
  externalKnowledge: externalKnowledgeContextSchema.optional(),
  previousFailures: z.boolean().optional(),
  // Input ids whose truncated preview is not enough. Only these inputs get an
  // absolute path plus an instruction to read the whole file; every other
  // truncated input is delivered as orientation.
  fullReadInputs: z.array(identifierSchema).optional(),
  // Whether the operator's user-global runtime skill packs may load into this
  // stage. Unset means isolate wherever the runtime supports it; false demands
  // isolation and fails closed when it is not available; true opts back in.
  globalSkills: z.boolean().optional(),
  // Whether a repeated execution of this stage in the same worktree continues
  // the runtime's previous session. Defaults to on for task-plan loop stages.
  sessionReuse: z.boolean().optional(),
});

/**
 * How much of the repository a stage may pull into the model's context while it
 * runs. This is a read-volume policy and is independent of the write and
 * sandbox constraints in `capabilities`.
 */
export const readPolicySchema = z.object({
  /** Largest single file the stage should take into context, in bytes. */
  maxFileBytes: z.number().int().positive().optional(),
  /** Repo-relative globs the stage must not read in bulk. */
  deny: z.array(z.string().min(1)).optional(),
  /**
   * `advisory` states the bound in the prompt and records it in evidence.
   * `required` demands byte-level enforcement from the execution backend and
   * fails the stage when no backend can provide it.
   */
  enforcement: z.enum(["advisory", "required"]).optional(),
});

export const timeoutControlsSchema = z.object({
  sessionMs: z.number().int().positive().optional(),
  turnMs: z.number().int().positive().optional(),
  stallMs: z.number().int().positive().optional(),
  busyIdleMs: z.number().int().positive().optional(),
  pauseMs: z.number().int().positive().optional(),
  commandMs: z.number().int().positive().optional(),
  gateMs: z.number().int().positive().optional(),
});

export const verificationBudgetSchema = z.object({
  maxAgentAttempts: z.number().int().positive().optional(),
  maxJudgeAttempts: z.number().int().positive().optional(),
  maxCiRuns: z.number().int().positive().optional(),
  maxRuntimeCostUsd: z.number().positive().finite().optional(),
});

export const stageCostClassSchema = z.enum([
  "cheap",
  "moderate",
  "expensive",
  "human",
]);

export const hookDefinitionSchema = z.object({
  id: identifierSchema,
  command: z.string().min(1),
  onFailure: z.enum(["block", "warn", "evidence-only"]).default("block"),
  timeoutMs: z.number().int().positive().optional(),
  maxToolOutputTokens: z.number().int().positive().optional(),
});

export const stageHooksSchema = z.object({
  pre: z.array(hookDefinitionSchema).default([]),
  post: z.array(hookDefinitionSchema).default([]),
});

export const flowHooksSchema = z.object({
  preRun: z.array(hookDefinitionSchema).default([]),
  postRun: z.array(hookDefinitionSchema).default([]),
});

export const resourceReferenceSchema = z.object({
  connector: z.string().min(1),
  uri: z.string().min(1),
  options: z.record(z.string(), z.unknown()).optional(),
});

const taskPlanLoopConfigSchema = z.object({
  input: identifierSchema,
  role: z.enum(["execute-current", "verify-advance", "final"]),
  maxIterations: z.number().int().positive().optional(),
  max_iterations: z.number().int().positive().optional(),
  maxTasks: z.number().int().positive().optional(),
  max_tasks: z.number().int().positive().optional(),
}).superRefine((config, context) => {
  if (
    config.maxIterations !== undefined &&
    config.max_iterations !== undefined &&
    config.maxIterations !== config.max_iterations
  ) {
    context.addIssue({
      code: "custom",
      path: ["max_iterations"],
      message: "maxIterations and max_iterations must match when both are set",
    });
  }
  if (
    config.maxTasks !== undefined &&
    config.max_tasks !== undefined &&
    config.maxTasks !== config.max_tasks
  ) {
    context.addIssue({
      code: "custom",
      path: ["max_tasks"],
      message: "maxTasks and max_tasks must match when both are set",
    });
  }
});

const convergenceConfigSchema = z.object({
  tasksInput: identifierSchema,
  reportOutput: identifierSchema,
  tasksOutput: identifierSchema,
});

const nonAgentConvergenceSchema = z
  .never({ error: "convergence is only valid on agent stages" })
  .optional();

const stageBase = z.object({
  id: identifierSchema,
  costClass: stageCostClassSchema.optional(),
  inputs: z.array(identifierSchema).default([]),
  outputs: z.array(outputDeclarationSchema).default([]),
  maxAttempts: z.number().int().positive().optional(),
  alwaysRun: z.boolean().optional(),
  context: contextControlsSchema.optional(),
  timeouts: timeoutControlsSchema.optional(),
  reads: readPolicySchema.optional(),
  hooks: stageHooksSchema.optional(),
  taskPlan: taskPlanLoopConfigSchema.optional(),
  convergence: nonAgentConvergenceSchema,
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

function addFullReadInputIssues(
  context: z.RefinementCtx,
  stage: {
    id: string;
    inputs: string[];
    context?: { fullReadInputs?: string[] };
  },
): void {
  const declared = stage.context?.fullReadInputs;
  if (!declared) return;
  const seen = new Set<string>();
  for (const id of declared) {
    if (!stage.inputs.includes(id)) {
      context.addIssue({
        code: "custom",
        path: ["context", "fullReadInputs"],
        message: `fullReadInputs id must be declared in stage ${stage.id} inputs: ${id}`,
      });
    }
    if (seen.has(id)) {
      context.addIssue({
        code: "custom",
        path: ["context", "fullReadInputs"],
        message: `duplicate fullReadInputs id on stage ${stage.id}: ${id}`,
      });
    }
    seen.add(id);
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
const pathCapabilitySchema = z.object({
  scope: z.string().min(1).optional(),
  allow: z.array(z.string().min(1)).default([]),
});
const commandCapabilitySchema = z.object({
  mode: z.enum(["none", "allow-list", "deny-list", "unrestricted"]).default("none"),
  allow: z.array(z.string().min(1)).default([]),
  deny: z.array(z.string().min(1)).default([]),
  advisory: z.boolean().default(true),
});
const networkCapabilitySchema = z.object({
  mode: z.enum(["disabled", "restricted", "allowed", "advisory"]).default("advisory"),
  advisory: z.boolean().default(true),
  /**
   * Optional domain allowlist for OCI network mode `restricted`.
   * When empty, the backend falls back to `NITELY_OCI_NETWORK_ALLOWLIST`.
   */
  domains: z.array(z.string().min(1)).default([]),
});
const instructionSourceCapabilitySchema = z.object({
  repo: z.boolean().default(true),
  generated: z.boolean().default(true),
  skills: z.boolean().default(true),
});
const evidenceCapabilitySchema = z.object({
  prompts: z.boolean().default(true),
  toolCalls: z.boolean().default(true),
  fileChanges: z.boolean().default(true),
  runtimeUsage: z.boolean().default(true),
});

export const agentCapabilityPolicySchema = z.object({
  read: pathCapabilitySchema.default({ scope: "repository", allow: [] }),
  write: pathCapabilitySchema.default({ scope: "worktree", allow: [] }),
  commands: commandCapabilitySchema.default({
    mode: "none",
    allow: [],
    deny: [],
    advisory: true,
  }),
  network: networkCapabilitySchema.default({
    mode: "advisory",
    advisory: true,
    domains: [],
  }),
  allowedRuntimes: z.array(z.string().min(1)).default([]),
  allowedModels: z.array(z.string().min(1)).default([]),
  instructions: instructionSourceCapabilitySchema.default({
    repo: true,
    generated: true,
    skills: true,
  }),
  evidence: evidenceCapabilitySchema.default({
    prompts: true,
    toolCalls: true,
    fileChanges: true,
    runtimeUsage: true,
  }),
});
const conformancePolicySchema = z.object({
  mode: z.enum(["strict", "advisory"]).default("advisory"),
  report: identifierSchema.default("conformance-report"),
  required: z.array(identifierSchema).default([]),
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

const nonAgentCapabilitiesSchema = z
  .never({ error: "capabilities are only valid on agent, judge, and review gate stages" })
  .optional();

function addConvergenceIssues(
  context: z.RefinementCtx,
  stage: {
    inputs: string[];
    outputs: Array<
      | string
      | { id: string; type?: string; mediaType?: string }
    >;
    convergence?: {
      tasksInput: string;
      reportOutput: string;
      tasksOutput: string;
    };
  },
): void {
  const config = stage.convergence;
  if (!config) return;
  if (
    new Set([config.tasksInput, config.reportOutput, config.tasksOutput]).size !==
    3
  ) {
    context.addIssue({
      code: "custom",
      path: ["convergence"],
      message: "tasksInput, reportOutput, and tasksOutput must be distinct",
    });
  }
  if (!stage.inputs.includes(config.tasksInput)) {
    context.addIssue({
      code: "custom",
      path: ["convergence", "tasksInput"],
      message: "tasksInput must be declared in stage inputs",
    });
  }
  const contract = (id: string) =>
    stage.outputs.find((output) =>
      typeof output === "string" ? output === id : output.id === id,
    );
  const report = contract(config.reportOutput);
  if (!report) {
    context.addIssue({
      code: "custom",
      path: ["convergence", "reportOutput"],
      message: "reportOutput must be declared in stage outputs",
    });
  } else if (typeof report === "string" || report.type !== "convergence.report") {
    context.addIssue({
      code: "custom",
      path: ["convergence", "reportOutput"],
      message: "reportOutput must declare type convergence.report",
    });
  } else if (
    report.mediaType !== "application/vnd.nitely.convergence+json"
  ) {
    context.addIssue({
      code: "custom",
      path: ["convergence", "reportOutput"],
      message:
        "reportOutput must declare mediaType application/vnd.nitely.convergence+json",
    });
  }
  const tasks = contract(config.tasksOutput);
  if (!tasks) {
    context.addIssue({
      code: "custom",
      path: ["convergence", "tasksOutput"],
      message: "tasksOutput must be declared in stage outputs",
    });
  } else if (typeof tasks === "string" || tasks.type !== "task.converged") {
    context.addIssue({
      code: "custom",
      path: ["convergence", "tasksOutput"],
      message: "tasksOutput must declare type task.converged",
    });
  } else if (tasks.mediaType !== "text/markdown") {
    context.addIssue({
      code: "custom",
      path: ["convergence", "tasksOutput"],
      message: "tasksOutput must declare mediaType text/markdown",
    });
  }
}

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
  capabilities: agentCapabilityPolicySchema.optional(),
  convergence: convergenceConfigSchema.optional(),
  outputs: z.array(outputDeclarationSchema).min(1),
}).superRefine((stage, context) => {
  addRuntimeCandidateIssues(context, stage);
  addAgentLikeDuplicateIssues(context, stage);
  addFullReadInputIssues(context, stage);
  addConvergenceIssues(context, stage);
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
  capabilities: nonAgentCapabilitiesSchema,
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
  capabilities: nonAgentCapabilitiesSchema,
});

const reviewGateStageSchema = stageBase.extend({
  type: z.literal("gate"),
  mode: z.literal("review"),
  name: z.string().min(1).optional(),
  /**
   * Whether this review's own verdict stops the run. A multi-perspective
   * review declares its perspectives non-blocking so every perspective runs,
   * and lets one `review-aggregate` gate own the single blocking decision.
   * Execution failures still fail the stage regardless of this flag. Unset
   * means blocking, so existing single-reviewer flows keep their behavior.
   */
  blocking: z.boolean().optional(),
  runtime: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  runtimes: z.array(runtimeCandidateSchema).min(1).optional(),
  skills: z.array(identifierSchema).default([]),
  required_mcp_servers: requiredMcpServersSchema,
  required_connectors: requiredConnectorsSchema,
  prompt: z.string().min(1),
  maxInputTokens: z.number().int().positive().optional(),
  maxToolOutputTokens: nonToolOutputBudgetedSchema,
  capabilities: agentCapabilityPolicySchema.optional(),
  outputs: z.array(outputDeclarationSchema).min(1),
  timeoutMs: z
    .never({ error: "timeoutMs is only valid on command and deterministic gate stages" })
    .optional(),
}).superRefine((stage, context) => {
  addRuntimeCandidateIssues(context, stage);
  addAgentLikeDuplicateIssues(context, stage);
  addFullReadInputIssues(context, stage);
});

const judgeStageSchema = z.preprocess(runtimeConfigValidationInput, stageBase.extend({
  type: z.literal("judge"),
  runtime: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  runtimes: z.array(runtimeCandidateSchema).min(1).optional(),
  skills: z.array(identifierSchema).default([]),
  required_mcp_servers: requiredMcpServersSchema,
  required_connectors: requiredConnectorsSchema,
  prompt: z.string().min(1),
  criteria: z.array(z.string().min(1)).min(1),
  onRework: identifierSchema.optional(),
  maxRework: z.number().int().nonnegative().optional(),
  maxInputTokens: z.number().int().positive().optional(),
  maxToolOutputTokens: nonToolOutputBudgetedSchema,
  capabilities: agentCapabilityPolicySchema.optional(),
  outputs: z.array(outputDeclarationSchema).min(1),
}).superRefine((stage, context) => {
  addRuntimeCandidateIssues(context, stage);
  addAgentLikeDuplicateIssues(context, stage);
  addFullReadInputIssues(context, stage);
}));

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
  capabilities: nonAgentCapabilitiesSchema,
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

/**
 * Collapses several independent review perspectives into one gate decision.
 * The topology stays static and readable: the perspectives are ordinary review
 * gates declared in the flow, and this stage consumes their outputs by id. It
 * carries no voting configuration on purpose — see
 * docs/multi-perspective-review.md.
 */
const reviewAggregateGateStageSchema = stageBase.extend({
  type: z.literal("gate"),
  mode: z.literal("review-aggregate"),
  name: z.string().min(1).optional(),
  blocking: z.boolean().optional(),
  /**
   * Review outputs to aggregate, at least two. Every id must also appear in
   * `inputs`; any remaining input is a reviewed artifact, which keeps rework
   * routing pointed at the work rather than at the reviewers.
   */
  perspectives: z.array(identifierSchema).min(2),
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
  capabilities: nonAgentCapabilitiesSchema,
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
}).superRefine((stage, context) => {
  const seen = new Set<string>();
  for (const perspective of stage.perspectives) {
    if (!stage.inputs.includes(perspective)) {
      context.addIssue({
        code: "custom",
        path: ["perspectives"],
        message: `perspective must be declared in stage ${stage.id} inputs: ${perspective}`,
      });
    }
    if (seen.has(perspective)) {
      context.addIssue({
        code: "custom",
        path: ["perspectives"],
        message: `duplicate perspective on stage ${stage.id}: ${perspective}`,
      });
    }
    seen.add(perspective);
  }
});

const securityGateStageSchema = stageBase.extend({
  type: z.literal("gate"),
  mode: z.literal("security"),
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
  capabilities: nonAgentCapabilitiesSchema,
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
  reviewAggregateGateStageSchema,
  analysisGateStageSchema,
  securityGateStageSchema,
]);

const approvalStageSchema = stageBase.extend({
  type: z.literal("approval"),
  prompt: z.string().min(1),
  skills: nonAgentSkillsSchema,
  required_mcp_servers: nonAgentRequiredMcpServersSchema,
  required_connectors: nonAgentRequiredConnectorsSchema,
  maxInputTokens: nonBudgetedMaxInputTokensSchema,
  maxToolOutputTokens: nonToolOutputBudgetedSchema,
  capabilities: nonAgentCapabilitiesSchema,
});

const publishChangeStageSchema = stageBase.extend({
  type: z.literal("publish-change"),
  provider: z.enum(["github", "github-cli"]).optional(),
  conformance: conformancePolicySchema.optional(),
  skills: nonAgentSkillsSchema,
  required_mcp_servers: nonAgentRequiredMcpServersSchema,
  required_connectors: nonAgentRequiredConnectorsSchema,
  maxInputTokens: nonBudgetedMaxInputTokensSchema,
  maxToolOutputTokens: nonToolOutputBudgetedSchema,
  capabilities: nonAgentCapabilitiesSchema,
});

const updateChangeStageSchema = stageBase.extend({
  type: z.literal("update-change"),
  provider: z.enum(["github", "github-cli"]).optional(),
  conformance: conformancePolicySchema.optional(),
  skills: nonAgentSkillsSchema,
  required_mcp_servers: nonAgentRequiredMcpServersSchema,
  required_connectors: nonAgentRequiredConnectorsSchema,
  maxInputTokens: nonBudgetedMaxInputTokensSchema,
  maxToolOutputTokens: nonToolOutputBudgetedSchema,
  capabilities: nonAgentCapabilitiesSchema,
});

const syncChangeStageSchema = stageBase.extend({
  type: z.literal("sync-change"),
  strategy: z.literal("merge").default("merge"),
  skills: nonAgentSkillsSchema,
  required_mcp_servers: nonAgentRequiredMcpServersSchema,
  required_connectors: nonAgentRequiredConnectorsSchema,
  maxInputTokens: nonBudgetedMaxInputTokensSchema,
  maxToolOutputTokens: nonToolOutputBudgetedSchema,
  capabilities: nonAgentCapabilitiesSchema,
});

export const stageSchema = z.union([
  agentStageSchema,
  judgeStageSchema,
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
  source: resourceReferenceSchema.optional(),
  sourceUrl: z.string().min(1).optional(),
  source_url: z.string().min(1).optional(),
  artifactUri: z.string().min(1).optional(),
  artifact_uri: z.string().min(1).optional(),
}).superRefine((input, context) => {
  const sources = [
    input.source,
    input.sourceUrl,
    input.source_url,
    input.artifactUri,
    input.artifact_uri,
  ].filter((source) => source !== undefined);
  if (sources.length > 1) {
    context.addIssue({
      code: "custom",
      path: ["source"],
      message: "input must declare only one of source, sourceUrl, source_url, artifactUri, or artifact_uri",
    });
  }
});

export const configurableInputSchema = z.object({
  key: identifierSchema,
  type: z.enum(["text", "textarea", "number", "boolean", "date", "url"]).default("text"),
  label: z.string().min(1),
  required: z.boolean().default(false),
  placeholder: z.string().min(1).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export const flowSchema = z.object({
  apiVersion: z.literal("nitely.dev/v1alpha1"),
  kind: z.literal("Flow"),
  metadata: z.object({
    name: z.string().min(1),
    workItemType: identifierSchema.optional(),
    inputs: z.array(inputContractSchema).optional(),
    configurables: z.array(configurableInputSchema).default([]),
  }),
  spec: z.object({
    context: contextControlsSchema.optional(),
    timeouts: timeoutControlsSchema.optional(),
    verificationBudget: verificationBudgetSchema.optional(),
    reads: readPolicySchema.optional(),
    hooks: flowHooksSchema.optional(),
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
export type ConfigurableInput = z.infer<typeof configurableInputSchema>;
export type ContextControls = z.infer<typeof contextControlsSchema>;
export type ReadPolicy = z.infer<typeof readPolicySchema>;
export type TimeoutControls = z.infer<typeof timeoutControlsSchema>;
export type VerificationBudget = z.infer<typeof verificationBudgetSchema>;
export type StageCostClass = z.infer<typeof stageCostClassSchema>;
export type HookDefinition = z.infer<typeof hookDefinitionSchema>;
export type AgentCapabilityPolicy = z.infer<typeof agentCapabilityPolicySchema>;

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
    | Extract<Stage, { type: "judge" }>
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
