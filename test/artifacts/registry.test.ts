import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readArtifactRegistry,
  readArtifactRegistryWithPrivatePaths,
  readMaterializedArtifact,
  reconcileArtifactSources,
  readReconciledArtifactRegistryWithPrivatePaths,
  restorePrivateArtifactPaths,
  writeArtifactRegistry,
} from "../../src/artifacts/registry.js";

async function referencedPrivateRegistryPath(
  runDirectory: string,
): Promise<string> {
  const publicRegistry = JSON.parse(
    await readFile(join(runDirectory, "artifacts.json"), "utf8"),
  ) as { privatePathRef?: string };
  if (!publicRegistry.privatePathRef) {
    throw new Error("expected public privatePathRef");
  }
  return join(
    runDirectory,
    `artifact-paths.private.${publicRegistry.privatePathRef}.json`,
  );
}

async function privateRegistryFilenames(runDirectory: string): Promise<string[]> {
  return (await readdir(runDirectory))
    .filter((filename) =>
      /^artifact-paths\.private\.[a-f0-9]{32}\.json$/u.test(filename)
    )
    .sort();
}

describe("Artifact registry", () => {
  it("reconciles registry enrichment with the canonical event projection", () => {
    expect(reconcileArtifactSources({
      registry: [
        {
          id: "implementation",
          name: "Implementation summary",
          producer: "implement",
          mediaType: "text/plain",
          path: "stale/output.md",
          sha256: "registry-digest",
          size: 17,
        },
        {
          id: "registry-only",
          producer: "implement",
          mediaType: "application/json",
        },
        {
          id: "implementation",
          producer: "review",
          mediaType: "text/markdown",
        },
      ],
      eventProjection: [
        {
          id: "implementation",
          name: undefined,
          producer: "implement",
          mediaType: "text/markdown",
          path: "stages/implement/1/output.md",
          sha256: "event-digest",
        },
        {
          id: "event-only",
          producer: "publish",
          mediaType: "application/vnd.nitely.change+json",
        },
      ],
    })).toEqual([
      {
        id: "implementation",
        name: "Implementation summary",
        producer: "implement",
        mediaType: "text/markdown",
        path: "stages/implement/1/output.md",
        sha256: "event-digest",
        size: 17,
      },
      {
        id: "registry-only",
        producer: "implement",
        mediaType: "application/json",
      },
      {
        id: "implementation",
        producer: "review",
        mediaType: "text/markdown",
      },
      {
        id: "event-only",
        producer: "publish",
        mediaType: "application/vnd.nitely.change+json",
      },
    ]);
  });

  it("writes and reads a regular Run-owned registry", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
    const runDirectory = join(repoPath, ".nitely", "runs", "run-1");
    await mkdir(runDirectory, { recursive: true });

    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-1",
      artifacts: [{
        id: "implementation",
        producer: "implement",
        mediaType: "text/markdown",
        path: "attempts/output.md",
      }],
      redactionSecrets: [],
    });

    await expect(readArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
    })).resolves.toEqual({
      runId: "run-1",
      generation: 1,
      privatePathRef: expect.stringMatching(/^[a-f0-9]{32}$/u),
      artifacts: [{
        id: "implementation",
        producer: "implement",
        mediaType: "text/markdown",
        path: "attempts/output.md",
      }],
    });
    const metadata = await stat(join(runDirectory, "artifacts.json"));
    expect(metadata.mode & 0o777).toBe(0o600);
  });

  it("reads a legacy public registry without a private sidecar reference", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
    const runDirectory = join(repoPath, ".nitely", "runs", "run-legacy");
    await mkdir(runDirectory, { recursive: true });
    await writeFile(join(runDirectory, "artifacts.json"), JSON.stringify({
      runId: "run-legacy",
      artifacts: [{
        id: "output",
        producer: "review",
        mediaType: "text/plain",
        path: "stages/output.txt",
      }],
    }, null, 2), { mode: 0o600 });

    await expect(readArtifactRegistryWithPrivatePaths({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-legacy",
    })).resolves.toEqual({
      runId: "run-legacy",
      artifacts: [{
        id: "output",
        producer: "review",
        mediaType: "text/plain",
        path: "stages/output.txt",
      }],
    });
  });

  it("does not redact Artifact integrity digests", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
    const runDirectory = join(repoPath, ".nitely", "runs", "run-1");
    const sha256 = "0123456789abcdef".repeat(4);
    await mkdir(runDirectory, { recursive: true });

    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-1",
      artifacts: [
        {
          id: "implementation",
          description: `contains ${sha256.slice(0, 8)} in display metadata`,
          producer: "implement",
          mediaType: "application/octet-stream",
          path: "attempts/output.bin",
          sha256,
          size: 17,
        },
      ],
      redactionSecrets: [sha256.slice(0, 8)],
    });

    const registry = await readArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
    });
    expect(registry?.artifacts[0]).toMatchObject({
      description: "contains [REDACTED] in display metadata",
      sha256,
      size: 17,
    });
  });

  it("keeps raw paths private and joins them through the redacted public identity", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
    const runDirectory = join(repoPath, ".nitely", "runs", "run-private");
    const secret = "artifact-identity-secret";
    const rawPath = `stages/${secret}/output.bin`;
    await mkdir(runDirectory, { recursive: true });

    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-private",
      artifacts: [{
        id: `output-${secret}`,
        producer: `producer-${secret}`,
        mediaType: "application/octet-stream",
        path: rawPath,
      }],
      redactionSecrets: [secret],
    });

    const publicRegistry = await readArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
    });
    expect(publicRegistry?.artifacts).toEqual([expect.objectContaining({
      id: "output-[REDACTED]",
      producer: "producer-[REDACTED]",
      path: "stages/[REDACTED]/output.bin",
    })]);
    const internalRegistry = await readArtifactRegistryWithPrivatePaths({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-private",
    });
    expect(internalRegistry?.artifacts).toEqual([expect.objectContaining({
      id: "output-[REDACTED]",
      producer: "producer-[REDACTED]",
      path: rawPath,
    })]);

    const privateRegistryPath = await referencedPrivateRegistryPath(runDirectory);
    const privateRegistry = JSON.parse(
      await readFile(privateRegistryPath, "utf8"),
    ) as {
      schemaVersion: number;
      privatePathRef: string;
      publicRegistry: { generation: number; sha256: string };
      artifacts: Array<{ id: string; producer: string; path: string }>;
    };
    expect(privateRegistry.schemaVersion).toBe(1);
    expect(privateRegistry.privatePathRef).toMatch(/^[a-f0-9]{32}$/u);
    expect(privateRegistry.publicRegistry).toEqual({
      generation: 1,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(privateRegistry.artifacts).toEqual([expect.objectContaining({
      id: "output-[REDACTED]",
      producer: "producer-[REDACTED]",
      path: rawPath,
      publicPath: "stages/[REDACTED]/output.bin",
      materializationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })]);
    expect((await stat(privateRegistryPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects raw identities that collide after redaction before writing either registry", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
    const runDirectory = join(repoPath, ".nitely", "runs", "run-collision");
    await mkdir(runDirectory, { recursive: true });

    await expect(writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-collision",
      artifacts: [
        {
          id: "output-private-one",
          producer: "review",
          mediaType: "text/plain",
          path: "stages/one.txt",
        },
        {
          id: "output-private-two",
          producer: "review",
          mediaType: "text/plain",
          path: "stages/two.txt",
        },
      ],
      redactionSecrets: ["private-one", "private-two"],
    })).rejects.toThrow(/duplicate Artifact identity/i);
    await expect(readFile(join(runDirectory, "artifacts.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await privateRegistryFilenames(runDirectory)).toEqual([]);
  });

  it("keeps the old pair readable after a private-first crash and self-heals on the next write", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
    const runDirectory = join(repoPath, ".nitely", "runs", "run-window");
    const publicPath = join(runDirectory, "artifacts.json");
    await mkdir(runDirectory, { recursive: true });
    const artifact = (path: string) => ({
      id: "output",
      producer: "review",
      mediaType: "text/plain",
      path,
    });
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-window",
      artifacts: [artifact("stages/secret=first/output.txt")],
      redactionSecrets: [],
    });
    const oldPublic = await readFile(publicPath, "utf8");
    const oldPrivatePath = await referencedPrivateRegistryPath(runDirectory);
    const oldPrivate = await readFile(oldPrivatePath, "utf8");
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-window",
      artifacts: [artifact("stages/secret=second/output.txt")],
      redactionSecrets: [],
    });
    const orphanPrivatePath = await referencedPrivateRegistryPath(runDirectory);
    await writeFile(publicPath, oldPublic, "utf8");
    await writeFile(oldPrivatePath, oldPrivate, {
      encoding: "utf8",
      mode: 0o600,
    });

    await expect(readArtifactRegistryWithPrivatePaths({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-window",
    })).resolves.toEqual(expect.objectContaining({
      artifacts: [expect.objectContaining({
        path: "stages/secret=first/output.txt",
      })],
    }));
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-window",
      artifacts: [artifact("stages/secret=third/output.txt")],
      redactionSecrets: [],
    });

    const currentPrivatePath = await referencedPrivateRegistryPath(runDirectory);
    expect(currentPrivatePath).not.toBe(oldPrivatePath);
    expect(currentPrivatePath).not.toBe(orphanPrivatePath);
    await expect(readFile(oldPrivatePath, "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(orphanPrivatePath, "utf8")).resolves.toContain(
      "secret=second",
    );
    await expect(readArtifactRegistryWithPrivatePaths({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-window",
    })).resolves.toEqual(expect.objectContaining({
      artifacts: [expect.objectContaining({
        path: "stages/secret=third/output.txt",
      })],
    }));
  });

  it("treats an initial immutable private sidecar orphan as inert", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
    const runDirectory = join(repoPath, ".nitely", "runs", "run-initial-orphan");
    const orphanRef = "f".repeat(32);
    const orphanFilename = `artifact-paths.private.${orphanRef}.json`;
    await mkdir(runDirectory, { recursive: true });
    await writeFile(join(runDirectory, orphanFilename), JSON.stringify({
      schemaVersion: 1,
      runId: "run-initial-orphan",
      privatePathRef: orphanRef,
      publicRegistry: { generation: 1, sha256: "0".repeat(64) },
      artifacts: [],
    }, null, 2), { mode: 0o600 });

    await expect(readArtifactRegistryWithPrivatePaths({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-initial-orphan",
    })).resolves.toBeUndefined();
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-initial-orphan",
      artifacts: [{
        id: "output",
        producer: "review",
        mediaType: "text/plain",
        path: "stages/output.txt",
      }],
      redactionSecrets: [],
    });

    expect(await privateRegistryFilenames(runDirectory)).toContain(orphanFilename);
    await expect(readArtifactRegistryWithPrivatePaths({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-initial-orphan",
    })).resolves.toEqual(expect.objectContaining({
      artifacts: [expect.objectContaining({ path: "stages/output.txt" })],
    }));
  });

  it("fails closed when the public registry references a missing private sidecar", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
    const runDirectory = join(repoPath, ".nitely", "runs", "run-missing-private");
    await mkdir(runDirectory, { recursive: true });
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-missing-private",
      artifacts: [],
      redactionSecrets: [],
    });
    await rm(await referencedPrivateRegistryPath(runDirectory));

    await expect(readArtifactRegistryWithPrivatePaths({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-missing-private",
    })).rejects.toThrow(/referenced private artifact path registry is missing/i);
    await expect(writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-missing-private",
      artifacts: [],
      redactionSecrets: [],
    })).rejects.toThrow(/referenced private artifact path registry is missing/i);
  });

  it("binds private paths to the exact public registry bytes", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
    const runDirectory = join(repoPath, ".nitely", "runs", "run-digest");
    const publicPath = join(runDirectory, "artifacts.json");
    await mkdir(runDirectory, { recursive: true });
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-digest",
      artifacts: [{
        id: "output",
        producer: "review",
        mediaType: "text/plain",
        path: "stages/secret=digest/output.txt",
      }],
      redactionSecrets: [],
    });
    await writeFile(publicPath, `${await readFile(publicPath, "utf8")}\n`, "utf8");

    await expect(readArtifactRegistryWithPrivatePaths({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-digest",
    })).rejects.toThrow(/binding does not match artifacts\.json/i);
  });

  it("keeps a newer event materialization canonical instead of pairing it with old raw bytes", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
    const runDirectory = join(repoPath, ".nitely", "runs", "run-event-newer");
    const publicPath = "stages/[REDACTED]/output.bin";
    await mkdir(runDirectory, { recursive: true });
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-event-newer",
      artifacts: [{
        id: "output",
        producer: "review",
        mediaType: "application/octet-stream",
        path: "stages/private-value/output.bin",
        sha256: "a".repeat(64),
        size: 10,
        stageId: "review",
        attempt: 1,
      }],
      redactionSecrets: ["private-value"],
    });

    await expect(readReconciledArtifactRegistryWithPrivatePaths({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-event-newer",
      readEventProjection: async () => [{
        id: "output",
        producer: "review",
        mediaType: "application/octet-stream",
        path: publicPath,
        sha256: "b".repeat(64),
        size: 20,
        stageId: "review",
        attempt: 2,
      }],
    })).resolves.toEqual([expect.objectContaining({
      path: publicPath,
      sha256: "b".repeat(64),
      size: 20,
      attempt: 2,
    })]);
  });

  it("carries superseded raw paths for retention without restoring old materializations", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
    const runDirectory = join(repoPath, ".nitely", "runs", "run-history");
    const oldRawPath = "stages/old-private/output.bin";
    const newRawPath = "stages/new-private/output.bin";
    await mkdir(runDirectory, { recursive: true });
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-history",
      artifacts: [{
        id: "output",
        producer: "review",
        mediaType: "application/octet-stream",
        path: oldRawPath,
        sha256: "a".repeat(64),
        size: 10,
        attempt: 1,
      }],
      redactionSecrets: ["old-private"],
    });
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-history",
      artifacts: [{
        id: "output",
        producer: "review",
        mediaType: "application/octet-stream",
        path: newRawPath,
        sha256: "b".repeat(64),
        size: 20,
        attempt: 2,
      }],
      redactionSecrets: ["old-private", "new-private"],
    });

    const privateRegistry = JSON.parse(
      await readFile(await referencedPrivateRegistryPath(runDirectory), "utf8"),
    ) as { historicalPaths: string[] };
    expect(privateRegistry.historicalPaths).toEqual([oldRawPath]);
    await expect(readArtifactRegistryWithPrivatePaths({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-history",
    })).resolves.toEqual(expect.objectContaining({
      artifacts: [expect.objectContaining({
        path: newRawPath,
        sha256: "b".repeat(64),
        size: 20,
        attempt: 2,
      })],
    }));
  });

  it("captures the bound registry pair before loading the event projection", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
    const runDirectory = join(repoPath, ".nitely", "runs", "run-interleaved");
    const oldRawPath = "stages/first-private/output.bin";
    const oldPublicPath = "stages/[REDACTED]/output.bin";
    await mkdir(runDirectory, { recursive: true });
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-interleaved",
      artifacts: [{
        id: "output",
        producer: "review",
        mediaType: "application/octet-stream",
        path: oldRawPath,
        sha256: "a".repeat(64),
        size: 10,
        attempt: 1,
      }],
      redactionSecrets: ["first-private"],
    });

    const reconciled = await readReconciledArtifactRegistryWithPrivatePaths({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-interleaved",
      readEventProjection: async () => {
        await writeArtifactRegistry({
          runDirectory,
          boundaryRoot: repoPath,
          runId: "run-interleaved",
          artifacts: [{
            id: "output",
            producer: "review",
            mediaType: "application/octet-stream",
            path: "stages/second-private/output.bin",
            sha256: "b".repeat(64),
            size: 20,
            attempt: 2,
          }],
          redactionSecrets: ["second-private"],
        });
        return [{
          id: "output",
          producer: "review",
          mediaType: "application/octet-stream",
          path: oldPublicPath,
          sha256: "a".repeat(64),
          size: 10,
          attempt: 1,
        }];
      },
    });

    expect(reconciled).toEqual([expect.objectContaining({
      path: oldRawPath,
      sha256: "a".repeat(64),
      size: 10,
      attempt: 1,
    })]);
  });

  it("treats private state as inert without public metadata and ignores orphan identities", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
    const runDirectory = join(repoPath, ".nitely", "runs", "run-orphan");
    await mkdir(runDirectory, { recursive: true });
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-orphan",
      artifacts: [{
        id: "registered",
        producer: "review",
        mediaType: "text/plain",
        path: "stages/secret=registered/output.txt",
      }],
      redactionSecrets: [],
    });
    const privatePath = await referencedPrivateRegistryPath(runDirectory);
    const privateRegistry = JSON.parse(await readFile(privatePath, "utf8")) as {
      artifacts: Array<Record<string, unknown>>;
    };
    privateRegistry.artifacts.push({
      ...privateRegistry.artifacts[0],
      id: "event-only",
      producer: "publish",
      path: "stages/secret=orphan/output.txt",
    });
    await writeFile(privatePath, JSON.stringify(privateRegistry, null, 2), "utf8");
    const eventOnly = {
      id: "event-only",
      producer: "publish",
      mediaType: "text/plain",
      path: privateRegistry.artifacts[0]?.publicPath as string,
    };
    await expect(readReconciledArtifactRegistryWithPrivatePaths({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-orphan",
      readEventProjection: async () => [eventOnly],
    })).resolves.toContainEqual(eventOnly);

    const publicRegistry = await readArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
    });
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-orphan",
      artifacts: publicRegistry?.artifacts ?? [],
      redactionSecrets: [],
    });
    const rewrittenPrivatePath = await referencedPrivateRegistryPath(runDirectory);
    const rewrittenPrivate = JSON.parse(
      await readFile(rewrittenPrivatePath, "utf8"),
    ) as {
      artifacts: Array<{ id: string }>;
    };
    expect(rewrittenPrivate.artifacts.map((artifact) => artifact.id))
      .toEqual(["registered"]);

    await rm(join(runDirectory, "artifacts.json"));
    await expect(restorePrivateArtifactPaths({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-orphan",
      artifacts: [eventOnly],
    })).resolves.toEqual([eventOnly]);
  });

  it("rejects an unknown private registry schema version", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
    const runDirectory = join(repoPath, ".nitely", "runs", "run-schema");
    await mkdir(runDirectory, { recursive: true });
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-schema",
      artifacts: [],
      redactionSecrets: [],
    });
    const privatePath = await referencedPrivateRegistryPath(runDirectory);
    const privateRegistry = JSON.parse(await readFile(privatePath, "utf8")) as {
      schemaVersion: number;
    };
    privateRegistry.schemaVersion = 99;
    await writeFile(privatePath, JSON.stringify(privateRegistry, null, 2), "utf8");

    await expect(readArtifactRegistryWithPrivatePaths({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-schema",
    })).rejects.toThrow(/schemaVersion/i);
  });

  it("does not lose a private path when a public-only caller rewrites the registry", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
    const runDirectory = join(repoPath, ".nitely", "runs", "run-private");
    const secret = "artifact-path-secret";
    const rawPath = `stages/review/${secret}/output.bin`;
    await mkdir(runDirectory, { recursive: true });
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-private",
      artifacts: [{
        id: "existing",
        producer: "review",
        mediaType: "application/octet-stream",
        path: rawPath,
      }],
      redactionSecrets: [secret],
    });
    const publicRegistry = await readArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
    });

    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-private",
      artifacts: [
        ...(publicRegistry?.artifacts ?? []),
        {
          id: "new",
          producer: "review",
          mediaType: "text/plain",
          path: "stages/review/new.txt",
        },
      ],
      redactionSecrets: [secret],
    });

    await expect(readArtifactRegistryWithPrivatePaths({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-private",
    })).resolves.toEqual(expect.objectContaining({
      artifacts: expect.arrayContaining([
        expect.objectContaining({ id: "existing", path: rawPath }),
        expect.objectContaining({ id: "new", path: "stages/review/new.txt" }),
      ]),
    }));
  });

  it("preserves a private path when a public-only rewrite applies stricter path redaction", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
    const runDirectory = join(repoPath, ".nitely", "runs", "run-stricter-redaction");
    const oldSecret = "old-sensitive-value";
    const newSecret = "new-sensitive-value";
    const rawPath = `stages/${oldSecret}/${newSecret}/output.bin`;
    await mkdir(runDirectory, { recursive: true });
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-stricter-redaction",
      artifacts: [{
        id: "output",
        producer: "review",
        mediaType: "application/octet-stream",
        path: rawPath,
        sha256: "a".repeat(64),
        size: 10,
        stageId: "review",
        attempt: 1,
      }],
      redactionSecrets: [oldSecret],
    });
    const publicRegistry = await readArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
    });

    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-stricter-redaction",
      artifacts: publicRegistry?.artifacts ?? [],
      redactionSecrets: [oldSecret, newSecret],
    });

    const publicContent = await readFile(join(runDirectory, "artifacts.json"), "utf8");
    expect(publicContent).not.toContain(oldSecret);
    expect(publicContent).not.toContain(newSecret);
    expect(publicContent).toContain("stages/[REDACTED]/[REDACTED]/output.bin");
    await expect(readArtifactRegistryWithPrivatePaths({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-stricter-redaction",
    })).resolves.toEqual(expect.objectContaining({
      artifacts: [expect.objectContaining({
        path: rawPath,
        sha256: "a".repeat(64),
        size: 10,
        stageId: "review",
        attempt: 1,
      })],
    }));
  });

  it("keeps path redaction monotonic when a later writer no longer knows the secret", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
    const runDirectory = join(repoPath, ".nitely", "runs", "run-monotonic");
    const secret = "old-sensitive-value";
    const rawPath = `stages/review/${secret}/output.bin`;
    await mkdir(runDirectory, { recursive: true });
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-monotonic",
      artifacts: [{
        id: "output",
        producer: "review",
        mediaType: "application/octet-stream",
        path: rawPath,
      }],
      redactionSecrets: [secret],
    });
    const internal = await readArtifactRegistryWithPrivatePaths({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-monotonic",
    });

    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-monotonic",
      artifacts: internal?.artifacts ?? [],
      redactionSecrets: [],
    });

    const publicContent = await readFile(join(runDirectory, "artifacts.json"), "utf8");
    expect(publicContent).not.toContain(secret);
    expect(publicContent).toContain("stages/review/[REDACTED]/output.bin");
    await expect(readArtifactRegistryWithPrivatePaths({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-monotonic",
    })).resolves.toEqual(expect.objectContaining({
      artifacts: [expect.objectContaining({ path: rawPath })],
    }));
  });

  it("does not bind updated public-only materialization metadata to old raw bytes", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
    const runDirectory = join(repoPath, ".nitely", "runs", "run-public-update");
    await mkdir(runDirectory, { recursive: true });
    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-public-update",
      artifacts: [{
        id: "output",
        producer: "review",
        mediaType: "application/octet-stream",
        path: "stages/private-value/output.bin",
        sha256: "a".repeat(64),
        size: 10,
        attempt: 1,
      }],
      redactionSecrets: ["private-value"],
    });
    const publicRegistry = await readArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
    });
    if (!publicRegistry?.artifacts[0]) {
      throw new Error("expected public Artifact metadata");
    }
    const updated = {
      ...publicRegistry.artifacts[0],
      sha256: "b".repeat(64),
      size: 20,
      attempt: 2,
    };

    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-public-update",
      artifacts: [updated],
      redactionSecrets: ["private-value"],
    });

    const internal = await readArtifactRegistryWithPrivatePaths({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-public-update",
    });
    expect(internal?.artifacts[0]).toMatchObject({
      path: "stages/[REDACTED]/output.bin",
      sha256: "b".repeat(64),
      size: 20,
      attempt: 2,
    });
    const privatePath = await referencedPrivateRegistryPath(runDirectory);
    const privateRegistry = JSON.parse(await readFile(privatePath, "utf8")) as {
      artifacts: unknown[];
    };
    expect(privateRegistry.artifacts).toEqual([]);
  });

  it("does not read or write through private registry links", async () => {
    for (const kind of ["symbolic", "hard"] as const) {
      const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
      const runDirectory = join(repoPath, ".nitely", "runs", `run-${kind}`);
      const outsidePath = join(repoPath, `outside-${kind}.json`);
      await mkdir(runDirectory, { recursive: true });
      await writeArtifactRegistry({
        runDirectory,
        boundaryRoot: repoPath,
        runId: `run-${kind}`,
        artifacts: [],
        redactionSecrets: [],
      });
      const privateRegistryPath = await referencedPrivateRegistryPath(runDirectory);
      await rm(privateRegistryPath);
      await writeFile(outsidePath, JSON.stringify({ runId: "outside", artifacts: [] }));
      if (kind === "symbolic") {
        await symlink(outsidePath, privateRegistryPath);
      } else {
        await link(outsidePath, privateRegistryPath);
      }

      await expect(readArtifactRegistryWithPrivatePaths({
        runDirectory,
        boundaryRoot: repoPath,
        runId: `run-${kind}`,
      })).rejects.toThrow(new RegExp(`${kind} link`, "i"));
      await expect(writeArtifactRegistry({
        runDirectory,
        boundaryRoot: repoPath,
        runId: `run-${kind}`,
        artifacts: [],
        redactionSecrets: [],
      })).rejects.toThrow(new RegExp(`${kind} link`, "i"));
      await expect(readFile(outsidePath, "utf8")).resolves.toContain('"runId":"outside"');
    }
  });

  it("keeps materialized Artifact paths Run-relative when boundary-anchored", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
    const runDirectory = join(repoPath, ".nitely", "runs", "run-1");
    const artifactPath = join(runDirectory, "stages", "output.bin");
    await mkdir(join(runDirectory, "stages"), { recursive: true });
    await writeFile(artifactPath, Buffer.from([0, 1, 2, 255]));

    await expect(readMaterializedArtifact({
      runDirectory,
      boundaryRoot: repoPath,
      artifact: {
        id: "output",
        producer: "implement",
        mediaType: "application/octet-stream",
        path: "stages/output.bin",
      },
    })).resolves.toMatchObject({
      relativePath: "stages/output.bin",
      filename: "output.bin",
      content: Buffer.from([0, 1, 2, 255]),
    });
  });

  it("does not follow an existing artifacts.json symbolic link", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
    const runDirectory = join(repoPath, ".nitely", "runs", "run-1");
    const outsidePath = join(repoPath, "outside.json");
    await mkdir(runDirectory, { recursive: true });
    await writeFile(outsidePath, "do not overwrite\n", "utf8");
    await symlink(outsidePath, join(runDirectory, "artifacts.json"));

    await expect(
      writeArtifactRegistry({
        runDirectory,
        boundaryRoot: repoPath,
        runId: "run-1",
        artifacts: [],
        redactionSecrets: [],
      }),
    ).rejects.toThrow(/symbolic link/i);
    await expect(readFile(outsidePath, "utf8")).resolves.toBe(
      "do not overwrite\n",
    );
  });

  it("does not write through a symbolic-link ancestor of the Run", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
    const repoPath = join(root, "repo");
    const outsideRuns = join(root, "outside-runs");
    const runDirectory = join(repoPath, ".nitely", "runs", "run-1");
    const outsideRunDirectory = join(outsideRuns, "run-1");
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    await mkdir(outsideRunDirectory, { recursive: true });
    await symlink(outsideRuns, join(repoPath, ".nitely", "runs"));

    await expect(
      writeArtifactRegistry({
        runDirectory,
        boundaryRoot: repoPath,
        runId: "run-1",
        artifacts: [],
        redactionSecrets: [],
      }),
    ).rejects.toThrow(/symbolic link/i);
    await expect(
      readFile(join(outsideRunDirectory, "artifacts.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replaces an existing artifacts.json hard link without mutating its peer", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
    const runDirectory = join(repoPath, ".nitely", "runs", "run-1");
    const registryPath = join(runDirectory, "artifacts.json");
    const outsidePath = join(repoPath, "outside.json");
    await mkdir(runDirectory, { recursive: true });
    await writeFile(outsidePath, "do not overwrite\n", "utf8");
    await link(outsidePath, registryPath);

    await writeArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
      runId: "run-1",
      artifacts: [],
      redactionSecrets: [],
    });

    await expect(readFile(outsidePath, "utf8")).resolves.toBe(
      "do not overwrite\n",
    );
    await expect(readFile(registryPath, "utf8")).resolves.toContain(
      '"runId": "run-1"',
    );
  });

  it("does not read an artifacts.json symbolic link", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
    const runDirectory = join(repoPath, ".nitely", "runs", "run-1");
    const outsidePath = join(repoPath, "outside.json");
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      outsidePath,
      JSON.stringify({ runId: "outside", artifacts: [] }),
      "utf8",
    );
    await symlink(outsidePath, join(runDirectory, "artifacts.json"));

    await expect(readArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
    })).rejects.toThrow(
      /symbolic link/i,
    );
  });

  it("does not read an artifacts.json hard link", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-registry-"));
    const runDirectory = join(repoPath, ".nitely", "runs", "run-1");
    const outsidePath = join(repoPath, "outside.json");
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      outsidePath,
      JSON.stringify({ runId: "outside", artifacts: [] }),
      "utf8",
    );
    await link(outsidePath, join(runDirectory, "artifacts.json"));

    await expect(readArtifactRegistry({
      runDirectory,
      boundaryRoot: repoPath,
    })).rejects.toThrow(
      /hard link/i,
    );
  });
});
