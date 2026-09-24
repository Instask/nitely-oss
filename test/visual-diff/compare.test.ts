import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { computeIntegrity } from "../../src/artifacts/integrity.js";
import {
  readArtifactRegistryWithPrivatePaths,
  writeArtifactRegistry,
} from "../../src/artifacts/registry.js";
import type { RunArtifact } from "../../src/artifacts/types.js";
import {
  compareVisualArtifacts,
  type VisualComparisonResult,
} from "../../src/visual-diff/index.js";

type Rgba = [number, number, number, number];

const FIXED_CREATED_AT = new Date("2026-07-23T00:00:00.000Z");

function pngImage(input: {
  width: number;
  height: number;
  fill?: Rgba;
  pixels?: Array<{ x: number; y: number; rgba: Rgba }>;
}): Buffer {
  const png = new PNG({ width: input.width, height: input.height });
  png.data = Buffer.alloc(input.width * input.height * 4);
  const fill = input.fill ?? [255, 255, 255, 255];
  for (let index = 0; index < png.data.byteLength; index += 4) {
    png.data[index] = fill[0];
    png.data[index + 1] = fill[1];
    png.data[index + 2] = fill[2];
    png.data[index + 3] = fill[3];
  }
  for (const pixel of input.pixels ?? []) {
    const offset = (pixel.y * input.width + pixel.x) * 4;
    png.data[offset] = pixel.rgba[0];
    png.data[offset + 1] = pixel.rgba[1];
    png.data[offset + 2] = pixel.rgba[2];
    png.data[offset + 3] = pixel.rgba[3];
  }
  return PNG.sync.write(png);
}

async function createRun(): Promise<{
  repoPath: string;
  runId: string;
  runDirectory: string;
}> {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-visual-diff-"));
  const runId = "run-visual-diff";
  const runDirectory = join(repoPath, ".nitely", "runs", runId);
  await mkdir(join(runDirectory, "inputs"), { recursive: true });
  return { repoPath, runId, runDirectory };
}

async function writeRunInput(
  runDirectory: string,
  relativePath: string,
  content: Buffer,
): Promise<void> {
  await mkdir(dirname(join(runDirectory, relativePath)), { recursive: true });
  await writeFile(join(runDirectory, relativePath), content, { mode: 0o600 });
}

function crc32(content: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function insertAfterIhdr(png: Buffer, type: string, data: Buffer): Buffer {
  const signatureLength = 8;
  const ihdrLength = png.readUInt32BE(signatureLength);
  const ihdrType = png
    .subarray(signatureLength + 4, signatureLength + 8)
    .toString("ascii");
  if (ihdrType !== "IHDR") {
    throw new Error("test PNG is missing IHDR");
  }
  const insertOffset = signatureLength + 12 + ihdrLength;
  return Buffer.concat([
    png.subarray(0, insertOffset),
    pngChunk(type, data),
    png.subarray(insertOffset),
  ]);
}

function pngDensityChunk(
  pixelsPerUnitX: number,
  pixelsPerUnitY: number,
  unitSpecifier: number,
): Buffer {
  const data = Buffer.alloc(9);
  data.writeUInt32BE(pixelsPerUnitX, 0);
  data.writeUInt32BE(pixelsPerUnitY, 4);
  data[8] = unitSpecifier;
  return data;
}

function pngGammaChunk(value: number): Buffer {
  const data = Buffer.alloc(4);
  data.writeUInt32BE(value, 0);
  return data;
}

async function readReport(
  runDirectory: string,
  path: string,
): Promise<VisualComparisonResult> {
  return JSON.parse(await readFile(join(runDirectory, path), "utf8")) as
    VisualComparisonResult;
}

async function comparePaths(input: {
  id: string;
  repoPath: string;
  runId: string;
  referencePath?: string;
  implementationPath?: string;
  pixelmatchThreshold?: number;
  allowedChangedPixelCount?: number;
  allowedChangedPixelRatio?: number;
}): Promise<Awaited<ReturnType<typeof compareVisualArtifacts>>> {
  return compareVisualArtifacts({
    repoPath: input.repoPath,
    runId: input.runId,
    id: input.id,
    reference: { path: input.referencePath ?? "inputs/reference.png" },
    implementation: {
      path: input.implementationPath ?? "inputs/implementation.png",
    },
    createdAt: FIXED_CREATED_AT,
    route: "/preview",
    revision: "abc123",
    viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
    ...(input.pixelmatchThreshold !== undefined
      ? { pixelmatchThreshold: input.pixelmatchThreshold }
      : {}),
    ...(input.allowedChangedPixelCount !== undefined
      ? { allowedChangedPixelCount: input.allowedChangedPixelCount }
      : {}),
    ...(input.allowedChangedPixelRatio !== undefined
      ? { allowedChangedPixelRatio: input.allowedChangedPixelRatio }
      : {}),
  });
}

describe.skipIf(process.platform !== "linux")("visual diff artifacts", () => {
  it("persists exact-match artifacts and supports existing Artifact selectors", async () => {
    const { repoPath, runId, runDirectory } = await createRun();
    const reference = pngImage({ width: 2, height: 2 });
    const implementation = Buffer.from(reference);
    await writeRunInput(runDirectory, "inputs/reference.png", reference);
    await writeRunInput(
      runDirectory,
      "inputs/implementation.png",
      implementation,
    );

    const referenceIntegrity = computeIntegrity(reference);
    const approvedReference: RunArtifact = {
      id: "approved-reference",
      name: "Approved reference",
      type: "fixture.reference",
      producer: "fixtures",
      mediaType: "image/png",
      path: "inputs/reference.png",
      filename: "reference.png",
      sourceUri: "nitely-fixture://approved-reference",
      sha256: referenceIntegrity.sha256,
      size: referenceIntegrity.size,
      createdByRunId: runId,
    };
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId,
      artifacts: [approvedReference],
      redactionSecrets: [],
    });

    const output = await compareVisualArtifacts({
      repoPath,
      runId,
      id: "exact",
      reference: {
        artifactId: "approved-reference",
        artifactProducer: "fixtures",
      },
      implementation: { path: "inputs/implementation.png" },
      createdAt: FIXED_CREATED_AT,
      route: "/preview",
      revision: "abc123",
      viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
    });

    expect(output.result.status).toBe("match");
    expect(output.result.metrics?.changedPixelCount).toBe(0);
    expect(output.result.inputs.reference.artifactId).toBe(
      "approved-reference",
    );
    expect(output.artifacts.diff?.path).toBe(
      "visual-comparisons/exact/diff.png",
    );
    expect(output.artifacts.overlay?.path).toBe(
      "visual-comparisons/exact/overlay.png",
    );
    expect(output.artifacts.sideBySide?.path).toBe(
      "visual-comparisons/exact/side-by-side.png",
    );

    const diffContent = await readFile(
      join(runDirectory, output.artifacts.diff?.path ?? ""),
    );
    expect(createHash("sha256").update(diffContent).digest("hex")).toBe(
      output.artifacts.diff?.sha256,
    );

    const registry = await readArtifactRegistryWithPrivatePaths({
      runDirectory,
      boundaryRoot: repoPath,
      runId,
    });
    expect(registry?.artifacts.map((artifact) => artifact.id)).toEqual(
      expect.arrayContaining([
        "approved-reference",
        "exact-reference",
        "exact-implementation",
        "exact-diff",
        "exact-overlay",
        "exact-side-by-side",
        "exact-result",
      ]),
    );
    const report = await readReport(
      runDirectory,
      output.artifacts.report.path ?? "",
    );
    expect(report).toMatchObject({
      schemaVersion: 1,
      id: "exact",
      status: "match",
      route: "/preview",
      revision: "abc123",
    });
  });

  it("reports localized mismatches with changed-pixel metrics and bounding regions", async () => {
    const { repoPath, runId, runDirectory } = await createRun();
    await writeRunInput(
      runDirectory,
      "inputs/reference.png",
      pngImage({ width: 4, height: 4 }),
    );
    await writeRunInput(
      runDirectory,
      "inputs/implementation.png",
      pngImage({
        width: 4,
        height: 4,
        pixels: [{ x: 2, y: 1, rgba: [255, 0, 0, 255] }],
      }),
    );

    const output = await comparePaths({
      id: "localized",
      repoPath,
      runId,
      pixelmatchThreshold: 0,
    });

    expect(output.result.status).toBe("mismatch");
    expect(output.result.metrics?.changedPixelCount).toBe(1);
    expect(output.result.metrics?.changedPixelRatio).toBe(1 / 16);
    expect(output.result.metrics?.boundingRegions).toEqual([
      { x: 2, y: 1, width: 1, height: 1, pixelCount: 1 },
    ]);
  });

  it("honors pixelmatch tolerance thresholds", async () => {
    const { repoPath, runId, runDirectory } = await createRun();
    await writeRunInput(
      runDirectory,
      "inputs/reference.png",
      pngImage({ width: 1, height: 1, fill: [120, 120, 120, 255] }),
    );
    await writeRunInput(
      runDirectory,
      "inputs/implementation.png",
      pngImage({ width: 1, height: 1, fill: [128, 120, 120, 255] }),
    );

    const sensitive = await comparePaths({
      id: "tolerance-sensitive",
      repoPath,
      runId,
      pixelmatchThreshold: 0,
    });
    const tolerant = await comparePaths({
      id: "tolerance-lenient",
      repoPath,
      runId,
      pixelmatchThreshold: 1,
    });

    expect(sensitive.result.status).toBe("mismatch");
    expect(sensitive.result.metrics?.changedPixelCount).toBe(1);
    expect(tolerant.result.status).toBe("match");
    expect(tolerant.result.metrics?.changedPixelCount).toBe(0);
  });

  it("returns inconclusive for dimension mismatch", async () => {
    const { repoPath, runId, runDirectory } = await createRun();
    await writeRunInput(
      runDirectory,
      "inputs/reference.png",
      pngImage({ width: 2, height: 2 }),
    );
    await writeRunInput(
      runDirectory,
      "inputs/implementation.png",
      pngImage({ width: 3, height: 2 }),
    );

    const output = await comparePaths({ id: "dimension", repoPath, runId });

    expect(output.result.status).toBe("inconclusive");
    expect(output.result.reason).toBe("dimension_mismatch");
    expect(output.result.metrics).toBeUndefined();
    expect(output.artifacts.diff).toBeUndefined();
    expect(output.result.normalization.dimensions).toMatchObject({
      action: "rejected",
      reference: { width: 2, height: 2 },
      implementation: { width: 3, height: 2 },
    });
  });

  it("compares transparent RGBA pixels", async () => {
    const { repoPath, runId, runDirectory } = await createRun();
    await writeRunInput(
      runDirectory,
      "inputs/reference.png",
      pngImage({ width: 2, height: 2, fill: [0, 0, 0, 0] }),
    );
    await writeRunInput(
      runDirectory,
      "inputs/implementation.png",
      pngImage({
        width: 2,
        height: 2,
        fill: [0, 0, 0, 0],
        pixels: [{ x: 1, y: 1, rgba: [255, 0, 0, 128] }],
      }),
    );

    const output = await comparePaths({
      id: "transparency",
      repoPath,
      runId,
      pixelmatchThreshold: 0,
    });

    expect(output.result.status).toBe("mismatch");
    expect(output.result.metrics?.changedPixelCount).toBe(1);
    expect(output.result.metrics?.boundingRegions).toEqual([
      { x: 1, y: 1, width: 1, height: 1, pixelCount: 1 },
    ]);
  });

  it("returns inconclusive for unsupported and corrupt inputs", async () => {
    const { repoPath, runId, runDirectory } = await createRun();
    await writeRunInput(
      runDirectory,
      "inputs/reference.txt",
      Buffer.from("not a png", "utf8"),
    );
    await writeRunInput(
      runDirectory,
      "inputs/implementation.png",
      pngImage({ width: 1, height: 1 }),
    );
    const unsupported = await comparePaths({
      id: "unsupported-format",
      repoPath,
      runId,
      referencePath: "inputs/reference.txt",
    });
    expect(unsupported.result.status).toBe("inconclusive");
    expect(unsupported.result.reason).toBe("unsupported_format");

    await writeRunInput(
      runDirectory,
      "inputs/corrupt.png",
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("broken", "utf8"),
      ]),
    );
    const corrupt = await comparePaths({
      id: "corrupt-input",
      repoPath,
      runId,
      referencePath: "inputs/corrupt.png",
    });
    expect(corrupt.result.status).toBe("inconclusive");
    expect(corrupt.result.reason).toBe("corrupt_input");
  });

  it("rejects incompatible pixel density and color profile metadata", async () => {
    const { repoPath, runId, runDirectory } = await createRun();
    const base = pngImage({ width: 2, height: 2 });
    await writeRunInput(runDirectory, "inputs/reference.png", base);
    await writeRunInput(
      runDirectory,
      "inputs/implementation.png",
      insertAfterIhdr(base, "pHYs", pngDensityChunk(2835, 2835, 1)),
    );
    const density = await comparePaths({ id: "density", repoPath, runId });
    expect(density.result.status).toBe("inconclusive");
    expect(density.result.reason).toBe("pixel_density_mismatch");
    expect(density.result.normalization.pixelDensity.action).toBe("rejected");

    await writeRunInput(runDirectory, "inputs/reference.png", base);
    await writeRunInput(
      runDirectory,
      "inputs/implementation.png",
      insertAfterIhdr(base, "gAMA", pngGammaChunk(45455)),
    );
    const profile = await comparePaths({ id: "profile", repoPath, runId });
    expect(profile.result.status).toBe("inconclusive");
    expect(profile.result.reason).toBe("color_profile_mismatch");
    expect(profile.result.normalization.colorProfile.action).toBe("rejected");
  });
});
