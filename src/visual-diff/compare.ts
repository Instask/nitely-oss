import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { resolve } from "node:path";

import pixelmatch from "pixelmatch";
import { PNG, type PNGWithMetadata } from "pngjs";

import { withProvenance } from "../artifacts/integrity.js";
import {
  readArtifactRegistryWithPrivatePaths,
  writeArtifactRegistry,
} from "../artifacts/registry.js";
import type { RunArtifact } from "../artifacts/types.js";
import { redactUnknown } from "../context/redaction.js";
import { validateRunId } from "../run/project.js";
import {
  ensureRunOwnedDirectory,
  readRunOwnedFile,
  writeRunOwnedFileAtomically,
} from "../run/owned-file.js";
import type {
  VisualComparisonArtifactPointer,
  VisualComparisonImageInput,
  VisualComparisonImageRecord,
  VisualComparisonInconclusiveReason,
  VisualComparisonInput,
  VisualComparisonOutput,
  VisualComparisonResult,
  VisualComparisonStatus,
  VisualDiffBoundingRegion,
  VisualDiffMetrics,
  VisualNormalizationDecision,
  VisualPngColorProfileChunk,
  VisualPngDensity,
  VisualPngMetadata,
} from "./types.js";
import { VISUAL_COMPARISON_RESULT_MEDIA_TYPE } from "./types.js";

const require = createRequire(import.meta.url);
const DEFAULT_PIXELMATCH_THRESHOLD = 0.1;
const DEFAULT_OVERLAY_OPACITY = 0.5;
const DEFAULT_MAXIMUM_IMAGE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAXIMUM_BOUNDING_REGIONS = 100;
const PNG_SIGNATURE = Buffer.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);

interface LoadedVisualImage {
  role: "reference" | "implementation";
  input: VisualComparisonImageInput;
  artifact?: RunArtifact;
  path: string;
  content: Buffer;
  sha256: string;
  size: number;
  filename: string;
  sourceUri?: string;
  mediaType: string;
}

type PngAnalysis =
  | {
      ok: true;
      metadata: VisualPngMetadata;
      image: PNGWithMetadata;
    }
  | {
      ok: false;
      reason: "unsupported_format" | "corrupt_input";
      metadata?: VisualPngMetadata;
    };

interface ComparisonContext {
  repoPath: string;
  runDirectory: string;
  runId: string;
  comparisonId: string;
  createdAt: string;
  thresholds: {
    pixelmatchThreshold: number;
    includeAntiAliased: boolean;
    allowedChangedPixelCount: number;
    allowedChangedPixelRatio: number;
    overlayOpacity: number;
  };
  stageId?: string;
  attempt?: number;
  redactionSecrets: string[];
  existingArtifacts: RunArtifact[];
  maximumBoundingRegions: number;
}

function dependencyVersion(packageName: string): string {
  try {
    const manifest = require(`${packageName}/package.json`) as {
      version?: unknown;
    };
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeComparisonId(id: string | undefined, seed: string): string {
  if (id === undefined) {
    const digest = createHash("sha256")
      .update(seed)
      .digest("hex")
      .slice(0, 16);
    return `visual-${digest}`;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/u.test(id)) {
    throw new Error("visual comparison id must be filename-safe");
  }
  return id;
}

function normalizeUnitInterval(
  name: string,
  value: number | undefined,
  fallback: number,
): number {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate) || candidate < 0 || candidate > 1) {
    throw new Error(`${name} must be a number between 0 and 1`);
  }
  return candidate;
}

function normalizeNonNegativeInteger(
  name: string,
  value: number | undefined,
  fallback: number,
): number {
  const candidate = value ?? fallback;
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < 0
  ) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return candidate;
}

function findInputArtifact(
  artifacts: RunArtifact[],
  input: VisualComparisonImageInput,
): RunArtifact | undefined {
  if (!input.artifactId) return undefined;
  if (input.artifactProducer) {
    return artifacts.find((artifact) =>
      artifact.id === input.artifactId &&
      artifact.producer === input.artifactProducer
    );
  }
  const matches = artifacts.filter((artifact) => artifact.id === input.artifactId);
  if (matches.length > 1) {
    throw new Error(
      `artifact ${input.artifactId} is ambiguous; artifactProducer is required`,
    );
  }
  return matches[0];
}

async function loadVisualImage(input: {
  role: "reference" | "implementation";
  runDirectory: string;
  artifacts: RunArtifact[];
  image: VisualComparisonImageInput;
  maximumImageBytes: number;
}): Promise<LoadedVisualImage> {
  const artifact = findInputArtifact(input.artifacts, input.image);
  if (input.image.artifactId && !artifact) {
    throw new Error(`${input.role} image Artifact was not found`);
  }
  const artifactPath = artifact?.path;
  const path = artifactPath ?? input.image.path;
  if (!path) {
    throw new Error(`${input.role} image requires an artifactId or path`);
  }
  if (
    artifactPath &&
    input.image.path &&
    portablePath(input.image.path) !== portablePath(artifactPath)
  ) {
    throw new Error(`${input.role} image path does not match its Artifact`);
  }

  const materialized = await readRunOwnedFile({
    runDirectory: input.runDirectory,
    path,
    subject: `${input.role} visual comparison image`,
    expectedSha256: artifact?.sha256,
    expectedSize: artifact?.size,
    maximumBytes: input.maximumImageBytes,
  });
  const sha256 = sha256Hex(materialized.content);
  return {
    role: input.role,
    input: input.image,
    ...(artifact ? { artifact } : {}),
    path: materialized.relativePath,
    content: materialized.content,
    sha256,
    size: materialized.content.byteLength,
    filename: materialized.filename,
    sourceUri: input.image.sourceUri ?? artifact?.sourceUri,
    mediaType: input.image.mediaType ?? artifact?.mediaType ?? "image/png",
  };
}

function hasPngSignature(content: Buffer): boolean {
  return content.byteLength >= PNG_SIGNATURE.byteLength &&
    content.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE);
}

function chunkSha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function parsePngMetadata(content: Buffer): VisualPngMetadata | undefined {
  if (!hasPngSignature(content)) return undefined;

  let offset = PNG_SIGNATURE.byteLength;
  let metadata: VisualPngMetadata | undefined;
  let sawIend = false;
  while (offset < content.byteLength) {
    if (offset + 12 > content.byteLength) {
      throw new Error("truncated PNG chunk header");
    }
    const length = content.readUInt32BE(offset);
    offset += 4;
    const type = content.subarray(offset, offset + 4).toString("ascii");
    offset += 4;
    if (offset + length + 4 > content.byteLength) {
      throw new Error(`truncated PNG ${type} chunk`);
    }
    const data = content.subarray(offset, offset + length);
    offset += length + 4; // skip data and CRC

    if (type === "IHDR") {
      if (length !== 13) throw new Error("invalid PNG IHDR chunk");
      metadata = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8] ?? 0,
        colorType: data[9] ?? 0,
        interlaceMethod: data[12] ?? 0,
        colorProfile: [],
      };
      continue;
    }
    if (!metadata) {
      throw new Error("PNG chunk appears before IHDR");
    }
    if (type === "pHYs") {
      if (length !== 9) throw new Error("invalid PNG pHYs chunk");
      const density: VisualPngDensity = {
        pixelsPerUnitX: data.readUInt32BE(0),
        pixelsPerUnitY: data.readUInt32BE(4),
        unitSpecifier: data[8] ?? 0,
        fingerprint: chunkSha256(data),
      };
      metadata.pixelDensity = density;
    } else if (type === "sRGB" || type === "gAMA" || type === "iCCP") {
      metadata.colorProfile.push({
        type,
        size: data.byteLength,
        sha256: chunkSha256(data),
      });
    } else if (type === "IEND") {
      sawIend = true;
      break;
    }
  }

  if (!metadata || !sawIend) {
    throw new Error("PNG is missing required chunks");
  }
  return metadata;
}

function analyzePng(content: Buffer): PngAnalysis {
  if (!hasPngSignature(content)) {
    return { ok: false, reason: "unsupported_format" };
  }
  let metadata: VisualPngMetadata | undefined;
  try {
    metadata = parsePngMetadata(content);
    const image = PNG.sync.read(content);
    return {
      ok: true,
      metadata: {
        ...(metadata ?? {
          width: image.width,
          height: image.height,
          bitDepth: image.depth,
          colorType: image.colorType,
          interlaceMethod: image.interlace ? 1 : 0,
          colorProfile: [],
        }),
        width: image.width,
        height: image.height,
      },
      image,
    };
  } catch {
    return {
      ok: false,
      reason: "corrupt_input",
      ...(metadata ? { metadata } : {}),
    };
  }
}

function colorProfileFingerprint(chunks: VisualPngColorProfileChunk[]): string {
  return JSON.stringify(chunks.map((chunk) => ({
    type: chunk.type,
    size: chunk.size,
    sha256: chunk.sha256,
  })));
}

function densityFingerprint(density: VisualPngDensity | undefined): string {
  return density
    ? JSON.stringify({
      pixelsPerUnitX: density.pixelsPerUnitX,
      pixelsPerUnitY: density.pixelsPerUnitY,
      unitSpecifier: density.unitSpecifier,
      fingerprint: density.fingerprint,
    })
    : "";
}

function normalizationRejected(
  reason: VisualComparisonInconclusiveReason,
  reference: PngAnalysis,
  implementation: PngAnalysis,
): VisualNormalizationDecision {
  const referenceMetadata = reference.metadata;
  const implementationMetadata = implementation.metadata;
  return {
    action: "rejected",
    reason,
    format: reason === "unsupported_format" ? "unsupported" : "png",
    dimensions: {
      action: referenceMetadata && implementationMetadata
        ? "matched"
        : "not_evaluated",
      ...(referenceMetadata
        ? {
          reference: {
            width: referenceMetadata.width,
            height: referenceMetadata.height,
          },
        }
        : {}),
      ...(implementationMetadata
        ? {
          implementation: {
            width: implementationMetadata.width,
            height: implementationMetadata.height,
          },
        }
        : {}),
    },
    pixelDensity: {
      action: "not_evaluated",
      ...(referenceMetadata?.pixelDensity
        ? { reference: referenceMetadata.pixelDensity }
        : {}),
      ...(implementationMetadata?.pixelDensity
        ? { implementation: implementationMetadata.pixelDensity }
        : {}),
    },
    colorProfile: {
      action: "not_evaluated",
      reference: referenceMetadata?.colorProfile ?? [],
      implementation: implementationMetadata?.colorProfile ?? [],
    },
  };
}

function decideNormalization(
  reference: PngAnalysis,
  implementation: PngAnalysis,
): VisualNormalizationDecision {
  if (!reference.ok) {
    return normalizationRejected(reference.reason, reference, implementation);
  }
  if (!implementation.ok) {
    return normalizationRejected(implementation.reason, reference, implementation);
  }

  const referenceDimensions = {
    width: reference.metadata.width,
    height: reference.metadata.height,
  };
  const implementationDimensions = {
    width: implementation.metadata.width,
    height: implementation.metadata.height,
  };
  if (
    referenceDimensions.width !== implementationDimensions.width ||
    referenceDimensions.height !== implementationDimensions.height
  ) {
    return {
      action: "rejected",
      reason: "dimension_mismatch",
      format: "png",
      dimensions: {
        action: "rejected",
        reference: referenceDimensions,
        implementation: implementationDimensions,
      },
      pixelDensity: {
        action: "not_evaluated",
        ...(reference.metadata.pixelDensity
          ? { reference: reference.metadata.pixelDensity }
          : {}),
        ...(implementation.metadata.pixelDensity
          ? { implementation: implementation.metadata.pixelDensity }
          : {}),
      },
      colorProfile: {
        action: "not_evaluated",
        reference: reference.metadata.colorProfile,
        implementation: implementation.metadata.colorProfile,
      },
    };
  }

  const referenceDensity = densityFingerprint(reference.metadata.pixelDensity);
  const implementationDensity = densityFingerprint(
    implementation.metadata.pixelDensity,
  );
  if (referenceDensity !== implementationDensity) {
    return {
      action: "rejected",
      reason: "pixel_density_mismatch",
      format: "png",
      dimensions: {
        action: "matched",
        reference: referenceDimensions,
        implementation: implementationDimensions,
      },
      pixelDensity: {
        action: "rejected",
        ...(reference.metadata.pixelDensity
          ? { reference: reference.metadata.pixelDensity }
          : {}),
        ...(implementation.metadata.pixelDensity
          ? { implementation: implementation.metadata.pixelDensity }
          : {}),
      },
      colorProfile: {
        action: "not_evaluated",
        reference: reference.metadata.colorProfile,
        implementation: implementation.metadata.colorProfile,
      },
    };
  }

  const referenceProfile = colorProfileFingerprint(
    reference.metadata.colorProfile,
  );
  const implementationProfile = colorProfileFingerprint(
    implementation.metadata.colorProfile,
  );
  const hasColorProfile =
    reference.metadata.colorProfile.length > 0 ||
    implementation.metadata.colorProfile.length > 0;
  if (referenceProfile !== implementationProfile) {
    return {
      action: "rejected",
      reason: "color_profile_mismatch",
      format: "png",
      dimensions: {
        action: "matched",
        reference: referenceDimensions,
        implementation: implementationDimensions,
      },
      pixelDensity: {
        action: referenceDensity ? "matched" : "absent",
        ...(reference.metadata.pixelDensity
          ? { reference: reference.metadata.pixelDensity }
          : {}),
        ...(implementation.metadata.pixelDensity
          ? { implementation: implementation.metadata.pixelDensity }
          : {}),
      },
      colorProfile: {
        action: "rejected",
        reference: reference.metadata.colorProfile,
        implementation: implementation.metadata.colorProfile,
      },
    };
  }

  return {
    action: "accepted",
    format: "png",
    dimensions: {
      action: "matched",
      reference: referenceDimensions,
      implementation: implementationDimensions,
    },
    pixelDensity: {
      action: referenceDensity ? "matched" : "absent",
      ...(reference.metadata.pixelDensity
        ? { reference: reference.metadata.pixelDensity }
        : {}),
      ...(implementation.metadata.pixelDensity
        ? { implementation: implementation.metadata.pixelDensity }
        : {}),
    },
    colorProfile: {
      action: hasColorProfile ? "matched" : "absent",
      reference: reference.metadata.colorProfile,
      implementation: implementation.metadata.colorProfile,
    },
  };
}

function imageRecord(
  image: LoadedVisualImage,
  png: PngAnalysis,
): VisualComparisonImageRecord {
  return {
    role: image.role,
    ...(image.input.label ? { label: image.input.label } : {}),
    path: image.path,
    ...(image.artifact
      ? {
        artifactId: image.artifact.id,
        artifactProducer: image.artifact.producer,
      }
      : {}),
    ...(image.sourceUri ? { sourceUri: image.sourceUri } : {}),
    mediaType: image.mediaType,
    sha256: image.sha256,
    size: image.size,
    ...(png.metadata ? { png: png.metadata } : {}),
  };
}

function artifactPointer(artifact: RunArtifact): VisualComparisonArtifactPointer {
  return {
    artifactId: artifact.id,
    producer: artifact.producer,
    ...(artifact.path ? { path: artifact.path } : {}),
    mediaType: artifact.mediaType,
    ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
    ...(artifact.size !== undefined ? { size: artifact.size } : {}),
    ...(artifact.sourceUri ? { sourceUri: artifact.sourceUri } : {}),
  };
}

function createInputArtifact(input: {
  context: ComparisonContext;
  image: LoadedVisualImage;
}): RunArtifact {
  const roleName = input.image.role === "reference"
    ? "Reference image"
    : "Implementation screenshot";
  return {
    id: `${input.context.comparisonId}-${input.image.role}`,
    name: `Visual comparison ${roleName}`,
    type: `visual-comparison.${input.image.role}`,
    description: [
      `${roleName} linked for visual comparison ${input.context.comparisonId}.`,
      input.image.artifact
        ? `Source Artifact ${input.image.artifact.producer}/${input.image.artifact.id}.`
        : undefined,
    ].filter(Boolean).join(" "),
    producer: "visual-diff",
    mediaType: input.image.mediaType,
    path: input.image.path,
    filename: input.image.filename,
    sourceUri: input.image.sourceUri ??
      `nitely-run://${input.context.runId}/${input.image.path}`,
    createdAt: input.context.createdAt,
    sha256: input.image.sha256,
    size: input.image.size,
    createdByRunId: input.context.runId,
    ...(input.context.stageId ? { stageId: input.context.stageId } : {}),
    ...(input.context.attempt !== undefined ? { attempt: input.context.attempt } : {}),
  };
}

function createOutputArtifact(input: {
  context: ComparisonContext;
  idSuffix: string;
  type: string;
  name: string;
  filename: string;
  content: Buffer;
}): RunArtifact {
  const artifactPath = portablePath(
    join(
      "visual-comparisons",
      input.context.comparisonId,
      input.filename,
    ),
  );
  return withProvenance(
    {
      id: `${input.context.comparisonId}-${input.idSuffix}`,
      name: input.name,
      type: input.type,
      description: `Generated by visual comparison ${input.context.comparisonId}.`,
      producer: "visual-diff",
      mediaType: "image/png",
      path: artifactPath,
      filename: input.filename,
      sourceUri: artifactPath,
      createdAt: input.context.createdAt,
    },
    input.content,
    {
      runId: input.context.runId,
      ...(input.context.stageId ? { stageId: input.context.stageId } : {}),
      ...(input.context.attempt !== undefined ? { attempt: input.context.attempt } : {}),
    },
  );
}

function createReportArtifact(input: {
  context: ComparisonContext;
  content: string;
}): RunArtifact {
  const filename = "comparison.json";
  const artifactPath = portablePath(
    join("visual-comparisons", input.context.comparisonId, filename),
  );
  return withProvenance(
    {
      id: `${input.context.comparisonId}-result`,
      name: "Visual comparison result",
      type: "visual-comparison.result",
      description: `Typed visual comparison result for ${input.context.comparisonId}.`,
      producer: "visual-diff",
      mediaType: VISUAL_COMPARISON_RESULT_MEDIA_TYPE,
      path: artifactPath,
      filename,
      sourceUri: artifactPath,
      createdAt: input.context.createdAt,
      schema: {
        type: "object",
        required: ["schemaVersion", "id", "status", "inputs", "normalization"],
        properties: {
          schemaVersion: { type: "number" },
          id: { type: "string" },
          status: { type: "string" },
          inputs: { type: "object" },
          normalization: { type: "object" },
        },
      },
      version: "1",
    },
    input.content,
    {
      runId: input.context.runId,
      ...(input.context.stageId ? { stageId: input.context.stageId } : {}),
      ...(input.context.attempt !== undefined ? { attempt: input.context.attempt } : {}),
    },
  );
}

function changedRegionsFromDiffMask(
  diffMask: Buffer,
  width: number,
  height: number,
  maximumRegions: number,
): Pick<VisualDiffMetrics, "boundingRegions" | "regionsTruncated"> {
  const totalPixels = width * height;
  const visited = new Uint8Array(totalPixels);
  const boundingRegions: VisualDiffBoundingRegion[] = [];
  let regionsTruncated = false;

  for (let index = 0; index < totalPixels; index += 1) {
    if (visited[index] || diffMask[index * 4 + 3] === 0) continue;

    let minX = index % width;
    let maxX = minX;
    let minY = Math.floor(index / width);
    let maxY = minY;
    let pixelCount = 0;
    const pending = [index];
    visited[index] = 1;

    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) continue;
      const x = current % width;
      const y = Math.floor(current / width);
      pixelCount += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);

      const neighbors = [
        x > 0 ? current - 1 : undefined,
        x + 1 < width ? current + 1 : undefined,
        y > 0 ? current - width : undefined,
        y + 1 < height ? current + width : undefined,
      ];
      for (const neighbor of neighbors) {
        if (
          neighbor === undefined ||
          visited[neighbor] ||
          diffMask[neighbor * 4 + 3] === 0
        ) {
          continue;
        }
        visited[neighbor] = 1;
        pending.push(neighbor);
      }
    }

    if (boundingRegions.length < maximumRegions) {
      boundingRegions.push({
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        pixelCount,
      });
    } else {
      regionsTruncated = true;
    }
  }

  return { boundingRegions, regionsTruncated };
}

function createOverlayPng(
  reference: PNGWithMetadata,
  implementation: PNGWithMetadata,
  opacity: number,
): Buffer {
  const output = new PNG({ width: reference.width, height: reference.height });
  output.data = Buffer.alloc(reference.width * reference.height * 4);
  for (let index = 0; index < output.data.byteLength; index += 4) {
    output.data[index] = Math.round(
      reference.data[index] * (1 - opacity) +
        implementation.data[index] * opacity,
    );
    output.data[index + 1] = Math.round(
      reference.data[index + 1] * (1 - opacity) +
        implementation.data[index + 1] * opacity,
    );
    output.data[index + 2] = Math.round(
      reference.data[index + 2] * (1 - opacity) +
        implementation.data[index + 2] * opacity,
    );
    output.data[index + 3] = Math.round(
      reference.data[index + 3] * (1 - opacity) +
        implementation.data[index + 3] * opacity,
    );
  }
  return PNG.sync.write(output);
}

function createSideBySidePng(
  reference: PNGWithMetadata,
  implementation: PNGWithMetadata,
): Buffer {
  const output = new PNG({
    width: reference.width * 2,
    height: reference.height,
  });
  output.data = Buffer.alloc(output.width * output.height * 4);
  for (let y = 0; y < reference.height; y += 1) {
    for (let x = 0; x < reference.width; x += 1) {
      const sourceIndex = (y * reference.width + x) * 4;
      const leftIndex = (y * output.width + x) * 4;
      const rightIndex = (y * output.width + reference.width + x) * 4;
      reference.data.copy(output.data, leftIndex, sourceIndex, sourceIndex + 4);
      implementation.data.copy(
        output.data,
        rightIndex,
        sourceIndex,
        sourceIndex + 4,
      );
    }
  }
  return PNG.sync.write(output);
}

function comparePngs(input: {
  context: ComparisonContext;
  reference: PNGWithMetadata;
  implementation: PNGWithMetadata;
}): {
  status: VisualComparisonStatus;
  metrics: VisualDiffMetrics;
  diffContent: Buffer;
  overlayContent: Buffer;
  sideBySideContent: Buffer;
} {
  const width = input.reference.width;
  const height = input.reference.height;
  const diff = new PNG({ width, height });
  diff.data = Buffer.alloc(width * height * 4);
  const changedPixelCount = pixelmatch(
    input.reference.data,
    input.implementation.data,
    diff.data,
    width,
    height,
    {
      threshold: input.context.thresholds.pixelmatchThreshold,
      includeAA: input.context.thresholds.includeAntiAliased,
      diffMask: true,
    },
  );
  const totalPixels = width * height;
  const changedPixelRatio = totalPixels === 0
    ? 0
    : changedPixelCount / totalPixels;
  const { boundingRegions, regionsTruncated } = changedRegionsFromDiffMask(
    diff.data,
    width,
    height,
    input.context.maximumBoundingRegions,
  );
  const metrics: VisualDiffMetrics = {
    width,
    height,
    totalPixels,
    changedPixelCount,
    changedPixelRatio,
    boundingRegions,
    regionsTruncated,
  };
  const status =
    changedPixelCount <= input.context.thresholds.allowedChangedPixelCount &&
      changedPixelRatio <= input.context.thresholds.allowedChangedPixelRatio
      ? "match"
      : "mismatch";

  return {
    status,
    metrics,
    diffContent: PNG.sync.write(diff),
    overlayContent: createOverlayPng(
      input.reference,
      input.implementation,
      input.context.thresholds.overlayOpacity,
    ),
    sideBySideContent: createSideBySidePng(
      input.reference,
      input.implementation,
    ),
  };
}

async function persistVisualComparison(input: {
  context: ComparisonContext;
  result: VisualComparisonResult;
  artifacts: Omit<VisualComparisonOutput["artifacts"], "report">;
  outputContents?: {
    diff: Buffer;
    overlay: Buffer;
    sideBySide: Buffer;
  };
}): Promise<VisualComparisonOutput> {
  await ensureRunOwnedDirectory({
    runDirectory: input.context.runDirectory,
    path: portablePath(
      join("visual-comparisons", input.context.comparisonId),
    ),
    subject: `visual comparison ${input.context.comparisonId} directory`,
  });

  if (input.outputContents && input.artifacts.diff && input.artifacts.overlay) {
    await writeRunOwnedFileAtomically({
      runDirectory: input.context.runDirectory,
      path: input.artifacts.diff.path ?? "",
      subject: `visual comparison ${input.context.comparisonId} diff`,
      content: input.outputContents.diff,
    });
    await writeRunOwnedFileAtomically({
      runDirectory: input.context.runDirectory,
      path: input.artifacts.overlay.path ?? "",
      subject: `visual comparison ${input.context.comparisonId} overlay`,
      content: input.outputContents.overlay,
    });
    if (!input.artifacts.sideBySide) {
      throw new Error("side-by-side artifact is missing");
    }
    await writeRunOwnedFileAtomically({
      runDirectory: input.context.runDirectory,
      path: input.artifacts.sideBySide.path ?? "",
      subject: `visual comparison ${input.context.comparisonId} side-by-side`,
      content: input.outputContents.sideBySide,
    });
  }

  const persistedResult = redactUnknown(
    input.result,
    input.context.redactionSecrets,
  ) as VisualComparisonResult;
  const reportContent = `${JSON.stringify(persistedResult, null, 2)}\n`;
  const report = createReportArtifact({
    context: input.context,
    content: reportContent,
  });
  await writeRunOwnedFileAtomically({
    runDirectory: input.context.runDirectory,
    path: report.path ?? "",
    subject: `visual comparison ${input.context.comparisonId} result`,
    content: reportContent,
  });

  await writeArtifactRegistry({
    runDirectory: input.context.runDirectory,
    boundaryRoot: input.context.repoPath,
    runId: input.context.runId,
    artifacts: [
      ...input.context.existingArtifacts,
      input.artifacts.reference,
      input.artifacts.implementation,
      ...(input.artifacts.diff ? [input.artifacts.diff] : []),
      ...(input.artifacts.overlay ? [input.artifacts.overlay] : []),
      ...(input.artifacts.sideBySide ? [input.artifacts.sideBySide] : []),
      report,
    ],
    redactionSecrets: input.context.redactionSecrets,
  });

  return {
    result: persistedResult,
    artifacts: {
      ...input.artifacts,
      report,
    },
  };
}

function baseResult(input: {
  context: ComparisonContext;
  reference: LoadedVisualImage;
  implementation: LoadedVisualImage;
  referenceAnalysis: PngAnalysis;
  implementationAnalysis: PngAnalysis;
  normalization: VisualNormalizationDecision;
  status: VisualComparisonStatus;
  reason?: VisualComparisonInconclusiveReason;
  metrics?: VisualDiffMetrics;
  artifacts: {
    reference: RunArtifact;
    implementation: RunArtifact;
    diff?: RunArtifact;
    overlay?: RunArtifact;
    sideBySide?: RunArtifact;
  };
  route?: string;
  viewport?: VisualComparisonInput["viewport"];
  revision?: string;
}): VisualComparisonResult {
  return {
    schemaVersion: 1,
    id: input.context.comparisonId,
    status: input.status,
    ...(input.reason ? { reason: input.reason } : {}),
    createdAt: input.context.createdAt,
    ...(input.route ? { route: input.route } : {}),
    ...(input.viewport ? { viewport: input.viewport } : {}),
    ...(input.revision ? { revision: input.revision } : {}),
    tool: {
      name: "nitely-visual-diff",
      version: 1,
      pixelmatchVersion: dependencyVersion("pixelmatch"),
      pngjsVersion: dependencyVersion("pngjs"),
    },
    thresholds: input.context.thresholds,
    inputs: {
      reference: imageRecord(input.reference, input.referenceAnalysis),
      implementation: imageRecord(
        input.implementation,
        input.implementationAnalysis,
      ),
    },
    normalization: input.normalization,
    ...(input.metrics ? { metrics: input.metrics } : {}),
    artifacts: {
      reference: artifactPointer(input.artifacts.reference),
      implementation: artifactPointer(input.artifacts.implementation),
      ...(input.artifacts.diff
        ? { diff: artifactPointer(input.artifacts.diff) }
        : {}),
      ...(input.artifacts.overlay
        ? { overlay: artifactPointer(input.artifacts.overlay) }
        : {}),
      ...(input.artifacts.sideBySide
        ? { sideBySide: artifactPointer(input.artifacts.sideBySide) }
        : {}),
    },
  };
}

function outputArtifacts(input: {
  context: ComparisonContext;
  diffContent: Buffer;
  overlayContent: Buffer;
  sideBySideContent: Buffer;
}): Pick<VisualComparisonOutput["artifacts"], "diff" | "overlay" | "sideBySide"> {
  return {
    diff: createOutputArtifact({
      context: input.context,
      idSuffix: "diff",
      type: "visual-comparison.diff",
      name: "Visual pixel diff",
      filename: "diff.png",
      content: input.diffContent,
    }),
    overlay: createOutputArtifact({
      context: input.context,
      idSuffix: "overlay",
      type: "visual-comparison.overlay",
      name: "Visual overlay",
      filename: "overlay.png",
      content: input.overlayContent,
    }),
    sideBySide: createOutputArtifact({
      context: input.context,
      idSuffix: "side-by-side",
      type: "visual-comparison.side-by-side",
      name: "Visual side-by-side",
      filename: "side-by-side.png",
      content: input.sideBySideContent,
    }),
  };
}

/**
 * Compare two run-owned PNG artifacts and persist a typed visual comparison
 * report plus linked diff/overlay/side-by-side artifacts.
 */
export async function compareVisualArtifacts(
  input: VisualComparisonInput,
): Promise<VisualComparisonOutput> {
  validateRunId(input.runId);
  const repoPath = resolve(input.repoPath);
  const runDirectory = join(repoPath, ".nitely", "runs", input.runId);
  const registry = await readArtifactRegistryWithPrivatePaths({
    runDirectory,
    boundaryRoot: repoPath,
    runId: input.runId,
  });
  const existingArtifacts = registry?.artifacts ?? [];
  const maximumImageBytes = normalizeNonNegativeInteger(
    "maximumImageBytes",
    input.maximumImageBytes,
    DEFAULT_MAXIMUM_IMAGE_BYTES,
  );
  const redactionSecrets = [...(input.redactionSecrets ?? [])];
  const thresholds = {
    pixelmatchThreshold: normalizeUnitInterval(
      "pixelmatchThreshold",
      input.pixelmatchThreshold,
      DEFAULT_PIXELMATCH_THRESHOLD,
    ),
    includeAntiAliased: input.includeAntiAliased ?? false,
    allowedChangedPixelCount: normalizeNonNegativeInteger(
      "allowedChangedPixelCount",
      input.allowedChangedPixelCount,
      0,
    ),
    allowedChangedPixelRatio: normalizeUnitInterval(
      "allowedChangedPixelRatio",
      input.allowedChangedPixelRatio,
      0,
    ),
    overlayOpacity: normalizeUnitInterval(
      "overlayOpacity",
      input.overlayOpacity,
      DEFAULT_OVERLAY_OPACITY,
    ),
  };

  const reference = await loadVisualImage({
    role: "reference",
    runDirectory,
    artifacts: existingArtifacts,
    image: input.reference,
    maximumImageBytes,
  });
  const implementation = await loadVisualImage({
    role: "implementation",
    runDirectory,
    artifacts: existingArtifacts,
    image: input.implementation,
    maximumImageBytes,
  });
  const comparisonId = normalizeComparisonId(
    input.id,
    JSON.stringify({
      runId: input.runId,
      reference: {
        path: reference.path,
        sha256: reference.sha256,
        sourceUri: reference.sourceUri,
      },
      implementation: {
        path: implementation.path,
        sha256: implementation.sha256,
        sourceUri: implementation.sourceUri,
      },
      route: input.route,
      viewport: input.viewport,
      revision: input.revision,
      thresholds,
    }),
  );
  const context: ComparisonContext = {
    repoPath,
    runDirectory,
    runId: input.runId,
    comparisonId,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    thresholds,
    ...(input.stageId ? { stageId: input.stageId } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    redactionSecrets,
    existingArtifacts,
    maximumBoundingRegions: normalizeNonNegativeInteger(
      "maximumBoundingRegions",
      input.maximumBoundingRegions,
      DEFAULT_MAXIMUM_BOUNDING_REGIONS,
    ),
  };
  const referenceAnalysis = analyzePng(reference.content);
  const implementationAnalysis = analyzePng(implementation.content);
  const normalization = decideNormalization(
    referenceAnalysis,
    implementationAnalysis,
  );
  const referenceArtifact = createInputArtifact({ context, image: reference });
  const implementationArtifact = createInputArtifact({
    context,
    image: implementation,
  });

  if (
    !referenceAnalysis.ok ||
    !implementationAnalysis.ok ||
    normalization.action === "rejected"
  ) {
    const reason = normalization.reason ??
      (!referenceAnalysis.ok
        ? referenceAnalysis.reason
        : !implementationAnalysis.ok
        ? implementationAnalysis.reason
        : "corrupt_input");
    const artifacts = {
      reference: referenceArtifact,
      implementation: implementationArtifact,
    };
    const result = baseResult({
      context,
      reference,
      implementation,
      referenceAnalysis,
      implementationAnalysis,
      normalization,
      status: "inconclusive",
      reason,
      artifacts,
      route: input.route,
      viewport: input.viewport,
      revision: input.revision,
    });
    return persistVisualComparison({
      context,
      result,
      artifacts,
    });
  }

  const comparison = comparePngs({
    context,
    reference: referenceAnalysis.image,
    implementation: implementationAnalysis.image,
  });
  const generatedArtifacts = outputArtifacts({
    context,
    diffContent: comparison.diffContent,
    overlayContent: comparison.overlayContent,
    sideBySideContent: comparison.sideBySideContent,
  });
  const artifacts = {
    reference: referenceArtifact,
    implementation: implementationArtifact,
    ...generatedArtifacts,
  };
  const result = baseResult({
    context,
    reference,
    implementation,
    referenceAnalysis,
    implementationAnalysis,
    normalization,
    status: comparison.status,
    metrics: comparison.metrics,
    artifacts,
    route: input.route,
    viewport: input.viewport,
    revision: input.revision,
  });

  return persistVisualComparison({
    context,
    result,
    artifacts,
    outputContents: {
      diff: comparison.diffContent,
      overlay: comparison.overlayContent,
      sideBySide: comparison.sideBySideContent,
    },
  });
}
