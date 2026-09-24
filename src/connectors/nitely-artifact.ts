import { join, relative, resolve } from "node:path";

import {
  readArtifactRegistry,
  readMaterializedArtifact,
} from "../artifacts/registry.js";
import { readRunOwnedFile } from "../run/owned-file.js";
import { runDirectoryPath, validateRunId } from "../run/project.js";
import type {
  Connector,
  FetchedResource,
  ResourceReference,
} from "./types.js";

interface ParsedArtifactUri {
  runId: string;
  artifactId: string;
}

function parseNitelyArtifactUri(uri: string): ParsedArtifactUri {
  if (uri.startsWith("nitely-artifact://")) {
    const rest = uri.slice("nitely-artifact://".length);
    const [runId, artifactId] = rest.split("/").filter(Boolean);
    if (!runId || !artifactId) {
      throw new Error(`invalid nitely artifact URI: ${uri}`);
    }
    validateRunId(runId);
    return { runId, artifactId };
  }

  const parts = uri.split("/").filter(Boolean);
  const dotNitelyIndex = parts.indexOf(".nitely");
  const runsIndex = dotNitelyIndex >= 0 ? dotNitelyIndex + 1 : -1;
  if (
    dotNitelyIndex >= 0 &&
    parts[runsIndex] === "runs" &&
    parts[runsIndex + 2] === "artifacts" &&
    parts[runsIndex + 1] &&
    parts[runsIndex + 3]
  ) {
    const runId = parts[runsIndex + 1];
    validateRunId(runId);
    return { runId, artifactId: parts[runsIndex + 3] };
  }

  throw new Error(`invalid nitely artifact URI: ${uri}`);
}

async function originFlowName(
  repoPath: string,
  runDirectory: string,
): Promise<string | undefined> {
  try {
    const { content } = await readRunOwnedFile({
      runDirectory: repoPath,
      path: relative(repoPath, join(runDirectory, "run.json")),
      subject: "Run metadata path",
    });
    const parsed = JSON.parse(content.toString("utf8")) as {
      flowName?: unknown;
    };
    return typeof parsed.flowName === "string" ? parsed.flowName : undefined;
  } catch {
    return undefined;
  }
}

export class NitelyArtifactConnector implements Connector {
  readonly type = "nitely-artifact";
  readonly #repoPath: string;

  constructor(repoPath: string) {
    this.#repoPath = resolve(repoPath);
  }

  async fetch(reference: ResourceReference): Promise<FetchedResource> {
    const parsed = parseNitelyArtifactUri(reference.uri);
    const runDirectory = runDirectoryPath(this.#repoPath, parsed.runId);
    const registry = await readArtifactRegistry({
      runDirectory,
      boundaryRoot: this.#repoPath,
    });
    const artifact = registry?.artifacts.find(
      (candidate) => candidate.id === parsed.artifactId,
    );
    if (!artifact) {
      throw new Error(
        `nitely artifact not found: ${parsed.runId}/${parsed.artifactId}`,
      );
    }

    const { content, filename } = await readMaterializedArtifact({
      runDirectory,
      boundaryRoot: this.#repoPath,
      artifact,
    });
    const flowName = await originFlowName(this.#repoPath, runDirectory);
    const originRunId = artifact.createdByRunId ?? parsed.runId;
    return {
      sourceUri: reference.uri,
      mediaType: artifact.mediaType,
      content,
      revision: artifact.sha256 ? `sha256:${artifact.sha256}` : undefined,
      metadata: {
        filename: artifact.filename ?? filename,
        originRunId,
        originArtifactId: artifact.id,
        ...(artifact.producer ? { originProducer: artifact.producer } : {}),
        ...(artifact.stageId ? { originStageId: artifact.stageId } : {}),
        ...(artifact.attempt !== undefined
          ? { originAttempt: String(artifact.attempt) }
          : {}),
        ...(artifact.sourceUri ? { originSourceUri: artifact.sourceUri } : {}),
        ...(flowName ? { originFlowName: flowName } : {}),
      },
    };
  }
}
