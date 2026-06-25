import type { ResourceReference } from "../connectors/types.js";
import type { PlanningApprovalStatus } from "./planning.js";
import type {
  SpecApprovalStatus,
  TaskPlanningNotes,
  TaskSourceRecord,
} from "../web/tasks.js";

export type WorkItemStatus =
  | "draft"
  | "ready"
  | "running"
  | "completed"
  | "failed";

export interface WorkItemRecord {
  id: string;
  title: string;
  status: WorkItemStatus;
  repoId?: string;
  workItemType: string;
  flowPath: string;
  flowId?: string;
  inputs: Record<string, ResourceReference>;
  issueUrl?: string;
  latestRunId?: string;
  changeRequestUrl?: string;
  ownerId?: string;
  organizationId?: string;
  planning?: PlanningApprovalStatus;
  specStatus?: SpecApprovalStatus;
  techDesignStatus?: SpecApprovalStatus;
  planningNotes?: TaskPlanningNotes;
  planningSource?: TaskSourceRecord;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkItemInput {
  title: string;
  repoId?: string;
  workItemType: string;
  flowPath: string;
  flowId?: string;
  inputs: Record<string, ResourceReference>;
  issueUrl?: string;
  planning?: PlanningApprovalStatus;
}

export interface CreateWorkItemOptions {
  createId?: () => string;
  now?: () => Date;
  ownerId?: string;
  organizationId?: string;
  repoId?: string;
}

export type UpdateWorkItemPatch = Pick<WorkItemRecord, "status"> &
  Partial<Pick<WorkItemRecord, "latestRunId" | "changeRequestUrl" | "planning">>;
