export interface ArtifactContract {
  id: string;
  name?: string;
  type?: string;
  description?: string;
  mediaType?: string;
  schema?: unknown;
  version?: string;
}

export type GateStateValue = "pending" | "approved" | "rejected";

export interface GateState {
  gateId: string;
  state: GateStateValue;
  actor?: string;
  reason?: string;
  decidedAt?: string;
}

export interface GateReviewOutput {
  id: string;
  path: string;
  filename: string;
  mediaType: "text/markdown" | "text/plain";
  content: string;
  truncated: boolean;
}

export interface GateResult {
  id: string;
  stageId: string;
  name?: string;
  mode: "deterministic" | "review" | "analysis";
  status: "passed" | "failed";
  command?: string;
  runtime?: string;
  reviewedArtifacts?: string[];
  reviewOutput?: GateReviewOutput;
  reason?: string;
  stdout?: string;
  stderr?: string;
  attempt?: number;
  createdAt: string;
}

export interface RunArtifact extends ArtifactContract {
  producer: string;
  mediaType: string;
  path?: string;
  sourceUri?: string;
  filename?: string;
  manifestSource?: "declared-manifest" | "discovered";
  createdAt?: string;
  gate?: GateState;
  gateResult?: GateResult;
  sha256?: string;
  size?: number;
  createdByRunId?: string;
  stageId?: string;
  attempt?: number;
}

export interface ArtifactRegistry {
  runId: string;
  artifacts: RunArtifact[];
}
