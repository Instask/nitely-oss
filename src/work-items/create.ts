import type { ResourceReference } from "../connectors/types.js";
import { loadFlow, parseFlowDocument } from "../flow/load.js";
import { flowWorkItemType } from "../flow/schema.js";
import type { LoadedFlow } from "../flow/load.js";
import {
  BuiltinFlowPathError,
  resolveBuiltinFlowPath,
} from "../flows/paths.js";
import { openFlowStore } from "../flows/store.js";
import {
  flowTemplateLineage,
  getFlowTemplate,
  requiredFlowTemplateInputIds,
} from "../flows/templates.js";
import type { FlowTemplateLineage } from "../flows/templates.js";
import {
  FlowConfigurationError,
  normalizeFlowConfiguration,
  type FlowConfiguration,
} from "../flows/configurables.js";
import { WebInputError } from "../web/errors.js";
import { assertWorkItemTypeAllowed } from "./governance.js";
import { createWorkItem } from "./store.js";
import type { SuggestedDependency, TaskPriority } from "../web/tasks.js";
import type { CreateWorkItemOptions, WorkItemRecord } from "./types.js";

export interface CreateFlowWorkItemInput {
  title: string;
  repoId?: string;
  templateId?: string;
  flowPath?: string;
  flowId?: string;
  inputs: Record<string, ResourceReference>;
  configuration?: Record<string, unknown>;
  issueUrl?: string;
  workItemType?: string;
  dependsOn?: string[];
  suggestedDependencies?: SuggestedDependency[];
  priority?: TaskPriority;
}

function resolveStoredFlow(
  repoPath: string,
  flowId: string,
  externalInputs: string[],
): { loaded: LoadedFlow; flowPath: string } {
  const store = openFlowStore(repoPath);
  try {
    const record = store.getFlow(flowId);
    return {
      loaded: parseFlowDocument(record.document, { externalInputs }),
      flowPath: flowId,
    };
  } finally {
    store.close();
  }
}

/**
 * Create a generic work item from a flow. The flow comes from either a built-in
 * repository path (`flowPath`) or a stored user flow (`flowId`). The work item
 * type is canonical Flow metadata (defaulting to `dev.pr`); a caller may state
 * the same type explicitly, but cannot override it. Governance is enforced
 * before persistence so a high-risk Flow cannot be disguised as a safer type.
 */
export async function createFlowWorkItem(
  repoPath: string,
  input: CreateFlowWorkItemInput,
  options: CreateWorkItemOptions = {},
): Promise<WorkItemRecord> {
  const externalInputs = Object.keys(input.inputs ?? {});

  let loaded: LoadedFlow;
  let flowPath: string;
  let flowId: string | undefined;
  let template: FlowTemplateLineage | undefined;
  if (input.templateId) {
    const selectedTemplate = getFlowTemplate(input.templateId.trim());
    if (!selectedTemplate) {
      throw new WebInputError("flow template not found");
    }
    const requiredInputs = requiredFlowTemplateInputIds(selectedTemplate);
    const missingInputs = requiredInputs.filter(
      (id) => input.inputs?.[id] === undefined,
    );
    if (missingInputs.length > 0) {
      throw new WebInputError(
        `missing required template inputs: ${missingInputs.join(", ")}`,
      );
    }
    loaded = parseFlowDocument(selectedTemplate.document, {
      externalInputs: requiredInputs,
    });
    flowPath = `template:${selectedTemplate.id}`;
    template = flowTemplateLineage(selectedTemplate);
  } else if (input.flowId) {
    ({ loaded, flowPath } = resolveStoredFlow(
      repoPath,
      input.flowId,
      externalInputs,
    ));
    flowId = input.flowId;
  } else if (input.flowPath) {
    let resolvedFlowPath: Awaited<ReturnType<typeof resolveBuiltinFlowPath>>;
    try {
      resolvedFlowPath = await resolveBuiltinFlowPath(repoPath, input.flowPath);
    } catch (error) {
      if (error instanceof BuiltinFlowPathError) {
        throw new WebInputError(error.message);
      }
      throw error;
    }
    loaded = await loadFlow(resolvedFlowPath.absolutePath, { externalInputs });
    flowPath = resolvedFlowPath.flowPath;
  } else {
    throw new WebInputError("flowPath, flowId, or templateId is required");
  }

  const workItemType = input.workItemType ?? flowWorkItemType(loaded.flow);
  let configuration: FlowConfiguration;
  try {
    configuration = normalizeFlowConfiguration(loaded.flow, input.configuration ?? {});
  } catch (error) {
    if (error instanceof FlowConfigurationError) {
      throw new WebInputError(error.message);
    }
    throw error;
  }

  await assertWorkItemTypeAllowed({ repoPath, workItemType, loaded });

  return await createWorkItem(
    repoPath,
    {
      title: input.title,
      workItemType,
      flowPath,
      ...(flowId ? { flowId } : {}),
      ...(template ? { template } : {}),
      inputs: input.inputs ?? {},
      ...(Object.keys(configuration).length > 0 ? { configuration } : {}),
      ...(input.issueUrl ? { issueUrl: input.issueUrl } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.dependsOn ? { dependsOn: input.dependsOn } : {}),
      ...(input.suggestedDependencies
        ? { suggestedDependencies: input.suggestedDependencies }
        : {}),
    },
    options,
  );
}
