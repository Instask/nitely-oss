import type { RunArtifact } from "../artifacts/types.js";

export const VISUAL_COMPARISON_RESULT_MEDIA_TYPE =
  "application/vnd.nitely.visual-comparison+json";

export type VisualComparisonStatus = "match" | "mismatch" | "inconclusive";

export type VisualComparisonInconclusiveReason =
  | "unsupported_format"
  | "corrupt_input"
  | "dimension_mismatch"
  | "pixel_density_mismatch"
  | "color_profile_mismatch";

export interface VisualComparisonImageInput {
  /**
   * Existing run Artifact id. If supplied with artifactProducer, the Artifact
   * registry is authoritative for path, integrity, and source metadata.
   */
  artifactId?: string;
  artifactProducer?: string;
  /**
   * Run-relative path used for uploaded/local references that are already
   * materialized under .nitely/runs/<runId>.
   */
  path?: string;
  label?: string;
  sourceUri?: string;
  mediaType?: string;
}

export interface VisualComparisonViewport {
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  preset?: string;
}

export interface VisualComparisonInput {
  repoPath: string;
  runId: string;
  id?: string;
  reference: VisualComparisonImageInput;
  implementation: VisualComparisonImageInput;
  /**
   * Pixelmatch color-distance threshold. 0 is most sensitive, 1 is least.
   */
  pixelmatchThreshold?: number;
  includeAntiAliased?: boolean;
  /**
   * Comparison still reports match when changed pixels are within both limits.
   */
  allowedChangedPixelCount?: number;
  allowedChangedPixelRatio?: number;
  overlayOpacity?: number;
  viewport?: VisualComparisonViewport;
  route?: string;
  revision?: string;
  stageId?: string;
  attempt?: number;
  createdAt?: Date;
  maximumImageBytes?: number;
  maximumBoundingRegions?: number;
  redactionSecrets?: Iterable<string>;
}

export interface VisualPngDensity {
  pixelsPerUnitX: number;
  pixelsPerUnitY: number;
  unitSpecifier: number;
  fingerprint: string;
}

export interface VisualPngColorProfileChunk {
  type: "sRGB" | "gAMA" | "iCCP";
  size: number;
  sha256: string;
}

export interface VisualPngMetadata {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlaceMethod: number;
  pixelDensity?: VisualPngDensity;
  colorProfile: VisualPngColorProfileChunk[];
}

export interface VisualComparisonImageRecord {
  role: "reference" | "implementation";
  label?: string;
  path: string;
  artifactId?: string;
  artifactProducer?: string;
  sourceUri?: string;
  mediaType: string;
  sha256: string;
  size: number;
  png?: VisualPngMetadata;
}

export interface VisualNormalizationDecision {
  action: "accepted" | "rejected";
  reason?: VisualComparisonInconclusiveReason;
  format: "png" | "unsupported";
  dimensions: {
    action: "matched" | "rejected" | "not_evaluated";
    reference?: { width: number; height: number };
    implementation?: { width: number; height: number };
  };
  pixelDensity: {
    action: "matched" | "absent" | "rejected" | "not_evaluated";
    reference?: VisualPngDensity;
    implementation?: VisualPngDensity;
  };
  colorProfile: {
    action: "matched" | "absent" | "rejected" | "not_evaluated";
    reference: VisualPngColorProfileChunk[];
    implementation: VisualPngColorProfileChunk[];
  };
}

export interface VisualDiffBoundingRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  pixelCount: number;
}

export interface VisualDiffMetrics {
  width: number;
  height: number;
  totalPixels: number;
  changedPixelCount: number;
  changedPixelRatio: number;
  boundingRegions: VisualDiffBoundingRegion[];
  regionsTruncated: boolean;
}

export interface VisualComparisonThresholds {
  pixelmatchThreshold: number;
  includeAntiAliased: boolean;
  allowedChangedPixelCount: number;
  allowedChangedPixelRatio: number;
  overlayOpacity: number;
}

export interface VisualComparisonArtifactPointer {
  artifactId: string;
  producer: string;
  path?: string;
  mediaType: string;
  sha256?: string;
  size?: number;
  sourceUri?: string;
}

export interface VisualComparisonResult {
  schemaVersion: 1;
  id: string;
  status: VisualComparisonStatus;
  reason?: VisualComparisonInconclusiveReason;
  createdAt: string;
  route?: string;
  viewport?: VisualComparisonViewport;
  revision?: string;
  tool: {
    name: "nitely-visual-diff";
    version: 1;
    pixelmatchVersion: string;
    pngjsVersion: string;
  };
  thresholds: VisualComparisonThresholds;
  inputs: {
    reference: VisualComparisonImageRecord;
    implementation: VisualComparisonImageRecord;
  };
  normalization: VisualNormalizationDecision;
  metrics?: VisualDiffMetrics;
  artifacts: {
    reference: VisualComparisonArtifactPointer;
    implementation: VisualComparisonArtifactPointer;
    diff?: VisualComparisonArtifactPointer;
    overlay?: VisualComparisonArtifactPointer;
    sideBySide?: VisualComparisonArtifactPointer;
  };
}

export interface VisualComparisonOutput {
  result: VisualComparisonResult;
  artifacts: {
    reference: RunArtifact;
    implementation: RunArtifact;
    report: RunArtifact;
    diff?: RunArtifact;
    overlay?: RunArtifact;
    sideBySide?: RunArtifact;
  };
}
