import { createHash } from "node:crypto";

import type { RunArtifact } from "./types.js";

export interface ArtifactIntegrity {
  sha256: string;
  size: number;
}

/** Compute the SHA-256 hex digest and byte size of artifact content. */
export function computeIntegrity(content: Buffer | string): ArtifactIntegrity {
  const buffer = Buffer.isBuffer(content)
    ? content
    : Buffer.from(content, "utf8");
  return {
    sha256: createHash("sha256").update(buffer).digest("hex"),
    size: buffer.byteLength,
  };
}

export interface ArtifactProvenance {
  runId: string;
  stageId?: string;
  attempt?: number;
}

/**
 * Attach integrity (sha256/size) and provenance (createdByRunId/stageId/attempt)
 * to an artifact. Existing values are preserved — this never clobbers a digest
 * or provenance field already set on the artifact.
 */
export function withProvenance(
  artifact: RunArtifact,
  content: Buffer | string,
  provenance: ArtifactProvenance,
): RunArtifact {
  const integrity = computeIntegrity(content);
  return {
    ...artifact,
    sha256: artifact.sha256 ?? integrity.sha256,
    size: artifact.size ?? integrity.size,
    createdByRunId: artifact.createdByRunId ?? provenance.runId,
    ...(provenance.stageId !== undefined
      ? { stageId: artifact.stageId ?? provenance.stageId }
      : {}),
    ...(provenance.attempt !== undefined
      ? { attempt: artifact.attempt ?? provenance.attempt }
      : {}),
  };
}
