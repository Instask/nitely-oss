import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  readArtifactRegistryWithPrivatePaths,
  writeArtifactRegistry,
} from "../artifacts/registry.js";
import type { RunArtifact } from "../artifacts/types.js";
import { UnsafeRunOwnedFileError } from "../run/owned-file.js";
import { validateRunId } from "../run/project.js";
import { WebInputError } from "../web/errors.js";
import type {
  PreviewScreenshotArtifact,
  PreviewSessionRecord,
} from "./types.js";

export interface PreviewScreenshotEvidenceAttachment {
  runId: string;
  artifact: RunArtifact;
  source: PreviewScreenshotArtifact;
}

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function isPathInside(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return !(
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}

function safePreviewScreenshotPath(input: {
  repoPath: string;
  session: PreviewSessionRecord;
  screenshot: PreviewScreenshotArtifact;
}): string {
  const repoRoot = resolve(input.repoPath);
  const expectedPrefix = portablePath(
    join(".nitely", "preview-sessions", input.session.id, "artifacts"),
  );
  if (!input.screenshot.path.startsWith(`${expectedPrefix}/`)) {
    throw new WebInputError("preview screenshot path is outside the session artifacts");
  }
  const absolutePath = resolve(repoRoot, input.screenshot.path);
  if (!isPathInside(repoRoot, absolutePath)) {
    throw new WebInputError("preview screenshot path escapes the repository");
  }
  return absolutePath;
}

export async function attachPreviewScreenshotToRun(input: {
  repoPath: string;
  runId: string;
  session: PreviewSessionRecord;
  screenshotId: string;
  actorId: string;
  note?: string;
  now?: Date;
  redactionSecrets?: Iterable<string>;
}): Promise<PreviewScreenshotEvidenceAttachment> {
  validateRunId(input.runId);
  const screenshot = input.session.screenshots.find((candidate) =>
    candidate.id === input.screenshotId
  );
  if (!screenshot) {
    throw new WebInputError("preview screenshot not found");
  }
  const sourcePath = safePreviewScreenshotPath({
    repoPath: input.repoPath,
    session: input.session,
    screenshot,
  });
  const content = await readFile(sourcePath);
  const sha256 = sha256Hex(content);
  if (sha256 !== screenshot.sha256 || content.byteLength !== screenshot.size) {
    throw new WebInputError("preview screenshot integrity check failed");
  }

  const runDirectory = join(resolve(input.repoPath), ".nitely", "runs", input.runId);
  const filename = `${input.session.id}-${screenshot.id}.png`;
  const artifactPath = portablePath(
    join("preview-evidence", input.session.id, filename),
  );

  const createdAt = (input.now ?? new Date()).toISOString();
  const artifact: RunArtifact = {
    id: `preview-${input.session.id}-${screenshot.id}`,
    name: "Web preview screenshot",
    type: "preview-screenshot",
    description: [
      `Captured from preview session ${input.session.id}.`,
      `Attached by ${input.actorId}.`,
      screenshot.url ? `URL: ${screenshot.url}` : undefined,
      input.note ? `Note: ${input.note}` : undefined,
    ].filter(Boolean).join(" "),
    producer: "web-preview",
    mediaType: screenshot.mediaType,
    path: artifactPath,
    filename,
    sourceUri: `nitely-preview-session://${input.session.id}/screenshots/${screenshot.id}`,
    createdAt,
    sha256,
    size: content.byteLength,
    createdByRunId: input.runId,
  };

  try {
    const existing = await readArtifactRegistryWithPrivatePaths({
      runDirectory,
      boundaryRoot: resolve(input.repoPath),
      runId: input.runId,
    });
    await mkdir(join(runDirectory, "preview-evidence", input.session.id), {
      recursive: true,
    });
    await writeFile(join(runDirectory, artifactPath), content, { mode: 0o600 });
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: resolve(input.repoPath),
      runId: input.runId,
      artifacts: [...(existing?.artifacts ?? []), artifact],
      redactionSecrets: input.redactionSecrets ?? [],
    });
  } catch (error) {
    if (
      error instanceof UnsafeRunOwnedFileError &&
      /requires Linux descriptor-relative path anchoring/i.test(error.message)
    ) {
      throw new WebInputError(
        "preview screenshot evidence attach requires Linux run-owned file anchoring",
      );
    }
    throw error;
  }

  return { runId: input.runId, artifact, source: screenshot };
}
