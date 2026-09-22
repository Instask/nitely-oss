import { describe, expect, it } from "vitest";

import { projectRun } from "../../src/run/project.js";
import type { StoredRunEvent } from "../../src/events/types.js";

describe("knowledge retrieval run projection", () => {
  it("projects citation metadata without retaining passage or query bodies", () => {
    const commitSha = "a".repeat(40);
    const events: StoredRunEvent[] = [
      {
        sequence: 1,
        runId: "run-kb",
        type: "run.created",
        payload: { flowName: "kb-flow" },
        createdAt: "2026-07-21T00:00:00.000Z",
      },
      {
        sequence: 2,
        runId: "run-kb",
        stageId: "implement",
        attempt: 1,
        type: "knowledge.retrieved",
        payload: {
          queryFingerprint: "hmac-sha256:abc",
          query: "must-not-project",
          status: "ready",
          candidateCount: 12,
          selectedCount: 1,
          trimmedCount: 2,
          promptTokens: 140,
          matches: [
            {
              attachmentId: "platform",
              snapshotId: "snap-1",
              commitSha,
              indexDigest: "sha256:" + "b".repeat(64),
              chunkId: "chunk-1",
              citation: "kb://platform/" + commitSha + "/docs/api.md#L2-L8",
              rank: 1,
              lexicalScore: 0.7,
              semanticScore: 0.8,
              combinedScore: 0.75,
              providerId: "ollama",
              model: "nomic-embed-text",
              text: "must-not-project",
            },
          ],
        },
        createdAt: "2026-07-21T00:00:01.000Z",
      },
    ];

    const retrieval = projectRun(events).knowledgeRetrievals?.[0];
    expect(retrieval).toMatchObject({
      stageId: "implement",
      attempt: 1,
      queryFingerprint: "hmac-sha256:abc",
      status: "ready",
      candidateCount: 12,
      selectedCount: 1,
      trimmedCount: 2,
      matches: [
        {
          attachmentId: "platform",
          chunkId: "chunk-1",
          providerId: "ollama",
        },
      ],
    });
    expect(JSON.stringify(retrieval)).not.toContain("must-not-project");
  });
});
