import type { ResourceReference } from "../connectors/types.js";
import type { FlowConfiguration } from "../flows/configurables.js";
import type { FlowTemplateLineage } from "../flows/templates.js";
import type { PlanningApprovalStatus } from "./planning.js";
import type {
  SpecApprovalStatus,
  TaskPlanningArtifacts,
  TaskPlanningBaseline,
  SuggestedDependency,
  TaskPlanningNotes,
  TaskPriority,
  TaskSourceDriftOverride,
  TaskSourceRecord,
} from "../web/tasks.js";

export type WorkItemStatus =
  | "draft"
  | "ready"
  | "running"
  | "completed"
  | "failed";

export type WorkItemStoreKind = "generic" | "legacy-dev-pr";

export interface WorkItemCandidateGuard {
  workItemId: string;
  fingerprint: string | null;
}

export interface WorkItemCandidateVersion {
  store: WorkItemStoreKind;
  fingerprint: string;
  dependencyGuards?: WorkItemCandidateGuard[];
}

export interface WorkItemRecord {
  id: string;
  title: string;
  status: WorkItemStatus;
  repoId?: string;
  workItemType: string;
  flowPath: string;
  flowId?: string;
  template?: FlowTemplateLineage;
  inputs: Record<string, ResourceReference>;
  configuration?: FlowConfiguration;
  issueUrl?: string;
  latestRunId?: string;
  changeRequestUrl?: string;
  dependsOn?: string[];
  suggestedDependencies?: SuggestedDependency[];
  priority?: TaskPriority;
  ownerId?: string;
  organizationId?: string;
  planning?: PlanningApprovalStatus;
  planningArtifacts?: TaskPlanningArtifacts;
  activePlanningBaseline?: TaskPlanningBaseline;
  specStatus?: SpecApprovalStatus;
  techDesignStatus?: SpecApprovalStatus;
  specPath?: string;
  techDesignPath?: string;
  planningNotes?: TaskPlanningNotes;
  planningSource?: TaskSourceRecord;
  sourceDriftOverride?: TaskSourceDriftOverride;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkItemInput {
  title: string;
  repoId?: string;
  workItemType: string;
  flowPath: string;
  flowId?: string;
  template?: FlowTemplateLineage;
  inputs: Record<string, ResourceReference>;
  configuration?: FlowConfiguration;
  issueUrl?: string;
  dependsOn?: string[];
  suggestedDependencies?: SuggestedDependency[];
  priority?: TaskPriority;
  planning?: PlanningApprovalStatus;
}

export interface CreateWorkItemOptions {
  createId?: () => string;
  now?: () => Date;
  ownerId?: string;
  organizationId?: string;
  repoId?: string;
}

export type UpdateWorkItemPatch = Partial<
  Pick<
    WorkItemRecord,
    | "status"
    | "latestRunId"
    | "changeRequestUrl"
    | "planning"
    | "dependsOn"
    | "suggestedDependencies"
    | "priority"
  >
>;
