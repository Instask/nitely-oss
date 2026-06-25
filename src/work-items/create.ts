import type { ResourceReference } from "../connectors/types.js";
import { loadFlow, parseFlowDocument } from "../flow/load.js";
import { flowWorkItemType } from "../flow/schema.js";
import type { LoadedFlow } from "../flow/load.js";
import {
  BuiltinFlowPathError,
  resolveBuiltinFlowPath,
} from "../flows/paths.js";
import { openFlowStore } from "../flows/store.js";
import { WebInputError } from "../web/errors.js";
import { assertWorkItemTypeAllowed } from "./governance.js";
import { createWorkItem } from "./store.js";
import type { CreateWorkItemOptions, WorkItemRecord } from "./types.js";

export interface CreateFlowWorkItemInput {
  title: string;
  repoId?: string;
  flowPath?: string;
  flowId?: string;
  inputs: Record<string, ResourceReference>;
  issueUrl?: string;
  workItemType?: string;
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
 * type is taken from the caller or the flow metadata (defaulting to `dev.pr`).
 * Governance is enforced before the record is persisted so high-risk types
 * cannot be created from arbitrary flows.
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
  if (input.flowId) {
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
    throw new WebInputError("flowPath or flowId is required");
  }

  const workItemType = input.workItemType ?? flowWorkItemType(loaded.flow);

  await assertWorkItemTypeAllowed({ repoPath, workItemType, flow: loaded.flow });

  return await createWorkItem(
    repoPath,
    {
      title: input.title,
      workItemType,
      flowPath,
      ...(flowId ? { flowId } : {}),
      inputs: input.inputs ?? {},
      ...(input.issueUrl ? { issueUrl: input.issueUrl } : {}),
    },
    options,
  );
}
