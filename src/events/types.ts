export type RunEventType =
  | "run.created"
  | "workspace.created"
  | "stage.ready"
  | "stage.started"
  | "stage.skills.loaded"
  | "stage.requirements.checked"
  | "stage.requirements.failed"
  | "stage.context.usage"
  | "stage.runtime.usage"
  | "knowledge.generated"
  | "stage.runtime.fallback"
  | "stage.runtime.unavailable"
  | "stage.runtime.selected"
  | "budget.trimmed"
  | "budget.exceeded"
  | "agent.session.started"
  | "agent.message.delta"
  | "agent.tool.started"
  | "agent.tool.completed"
  | "artifact.published"
  | "context.excluded"
  | "context.warned"
  | "context.manifest.updated"
  | "repo.index.queried"
  | "task.scope.selected"
  | "task.scope.completed"
  | "gate.completed"
  | "command.completed"
  | "stage.completed"
  | "stage.failed"
  | "stage.blocked"
  | "orchestrator.decision"
  | "stage.retrying"
  | "stage.rework.requested"
  | "approval.requested"
  | "approval.resolved"
  | "change.target.resolved"
  | "change.sync.completed"
  | "change.sync.conflicted"
  | "change.published"
  | "change.updated"
  | "run.completed"
  | "run.failed"
  | "run.blocked"
  | "run.cancelled";

export interface NewRunEvent {
  runId: string;
  stageId?: string;
  attempt?: number;
  type: RunEventType;
  payload: unknown;
  createdAt?: string;
}

export interface StoredRunEvent {
  sequence: number;
  runId: string;
  stageId?: string;
  attempt?: number;
  type: RunEventType;
  payload: unknown;
  createdAt: string;
}
