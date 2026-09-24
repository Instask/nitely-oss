import { link, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { NitelyArtifactConnector } from "../../src/connectors/nitely-artifact.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

describe("NitelyArtifactConnector", () => {
  it("rejects a registered Artifact that is a symbolic link", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-"));
    const runDirectory = join(
      repoPath,
      ".nitely",
      "runs",
      "run-producer",
    );
    const artifactPath = join(runDirectory, "attempts", "output.md");
    const outsidePath = join(repoPath, "outside.md");
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(outsidePath, "outside Run\n", "utf8");
    await symlink(outsidePath, artifactPath);
    await writeJson(join(runDirectory, "artifacts.json"), {
      runId: "run-producer",
      artifacts: [{
        id: "implementation",
        producer: "implement",
        mediaType: "text/markdown",
        path: "attempts/output.md",
      }],
    });

    const connector = new NitelyArtifactConnector(repoPath);

    await expect(
      connector.fetch({
        connector: "nitely-artifact",
        uri: "nitely-artifact://run-producer/implementation",
      }),
    ).rejects.toThrow(/symbolic link/i);
  });

  it("rejects an Artifact path that traverses a symbolic link", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-"));
    const runDirectory = join(
      repoPath,
      ".nitely",
      "runs",
      "run-producer",
    );
    const realDirectory = join(runDirectory, "attempts-real");
    await mkdir(realDirectory, { recursive: true });
    await writeFile(join(realDirectory, "output.md"), "inside Run\n", "utf8");
    await symlink(realDirectory, join(runDirectory, "attempts"));
    await writeJson(join(runDirectory, "artifacts.json"), {
      runId: "run-producer",
      artifacts: [{
        id: "implementation",
        producer: "implement",
        mediaType: "text/markdown",
        path: "attempts/output.md",
      }],
    });

    const connector = new NitelyArtifactConnector(repoPath);

    await expect(
      connector.fetch({
        connector: "nitely-artifact",
        uri: "nitely-artifact://run-producer/implementation",
      }),
    ).rejects.toThrow(/symbolic link/i);
  });

  it("rejects a registered Artifact that is hard-linked outside its Run", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-"));
    const runDirectory = join(
      repoPath,
      ".nitely",
      "runs",
      "run-producer",
    );
    const artifactPath = join(runDirectory, "attempts", "output.md");
    const outsidePath = join(repoPath, "outside.md");
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(outsidePath, "outside Run\n", "utf8");
    await link(outsidePath, artifactPath);
    await writeJson(join(runDirectory, "artifacts.json"), {
      runId: "run-producer",
      artifacts: [{
        id: "implementation",
        producer: "implement",
        mediaType: "text/markdown",
        path: "attempts/output.md",
      }],
    });

    const connector = new NitelyArtifactConnector(repoPath);

    await expect(
      connector.fetch({
        connector: "nitely-artifact",
        uri: "nitely-artifact://run-producer/implementation",
      }),
    ).rejects.toThrow(/hard link/i);
  });

  it("rejects a registered Artifact whose content no longer matches its digest", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-"));
    const runDirectory = join(
      repoPath,
      ".nitely",
      "runs",
      "run-producer",
    );
    const artifactPath = join(runDirectory, "attempts", "output.md");
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, "changed after publication\n", "utf8");
    await writeJson(join(runDirectory, "artifacts.json"), {
      runId: "run-producer",
      artifacts: [{
        id: "implementation",
        producer: "implement",
        mediaType: "text/markdown",
        path: "attempts/output.md",
        sha256: "0".repeat(64),
        size: Buffer.byteLength("changed after publication\n"),
      }],
    });

    const connector = new NitelyArtifactConnector(repoPath);

    await expect(
      connector.fetch({
        connector: "nitely-artifact",
        uri: "nitely-artifact://run-producer/implementation",
      }),
    ).rejects.toThrow(/sha256|size/i);
  });

  it("does not derive metadata from a symlinked run.json", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-"));
    const runDirectory = join(
      repoPath,
      ".nitely",
      "runs",
      "run-producer",
    );
    const artifactPath = join(runDirectory, "attempts", "output.md");
    const outsideRunMetadata = join(repoPath, "outside-run.json");
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, "inside Run\n", "utf8");
    await writeFile(
      outsideRunMetadata,
      JSON.stringify({ flowName: "outside-flow" }),
      "utf8",
    );
    await symlink(outsideRunMetadata, join(runDirectory, "run.json"));
    await writeJson(join(runDirectory, "artifacts.json"), {
      runId: "run-producer",
      artifacts: [{
        id: "implementation",
        producer: "implement",
        mediaType: "text/markdown",
        path: "attempts/output.md",
      }],
    });

    const connector = new NitelyArtifactConnector(repoPath);
    const result = await connector.fetch({
      connector: "nitely-artifact",
      uri: "nitely-artifact://run-producer/implementation",
    });

    expect(result.content.toString("utf8")).toBe("inside Run\n");
    expect(result.metadata).not.toHaveProperty("originFlowName");
  });

  it("rejects a Run directory symbolic-link alias", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-"));
    const actualRunDirectory = join(repoPath, "stored-runs", "run-producer");
    const runDirectory = join(
      repoPath,
      ".nitely",
      "runs",
      "run-producer",
    );
    const artifactPath = join(actualRunDirectory, "attempts", "output.md");
    await mkdir(dirname(artifactPath), { recursive: true });
    await mkdir(dirname(runDirectory), { recursive: true });
    await writeFile(artifactPath, "inside aliased Run\n", "utf8");
    await writeJson(join(actualRunDirectory, "run.json"), {
      flowName: "aliased-flow",
    });
    await writeJson(join(actualRunDirectory, "artifacts.json"), {
      runId: "run-producer",
      artifacts: [{
        id: "implementation",
        producer: "implement",
        mediaType: "text/markdown",
        path: "attempts/output.md",
      }],
    });
    await symlink(actualRunDirectory, runDirectory);

    const connector = new NitelyArtifactConnector(repoPath);
    await expect(
      connector.fetch({
        connector: "nitely-artifact",
        uri: "nitely-artifact://run-producer/implementation",
      }),
    ).rejects.toThrow(/symbolic link/i);
  });

  it("rejects a symbolic-link runs root", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-artifact-"));
    const outsideRunsRoot = join(repoPath, "outside-runs");
    const actualRunDirectory = join(outsideRunsRoot, "run-producer");
    const artifactPath = join(actualRunDirectory, "attempts", "output.md");
    await mkdir(dirname(artifactPath), { recursive: true });
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    await writeFile(artifactPath, "outside logical runs root\n", "utf8");
    await writeJson(join(actualRunDirectory, "artifacts.json"), {
      runId: "run-producer",
      artifacts: [
        {
          id: "implementation",
          producer: "implement",
          mediaType: "text/markdown",
          path: "attempts/output.md",
        },
      ],
    });
    await symlink(outsideRunsRoot, join(repoPath, ".nitely", "runs"));

    const connector = new NitelyArtifactConnector(repoPath);
    await expect(
      connector.fetch({
        connector: "nitely-artifact",
        uri: "nitely-artifact://run-producer/implementation",
      }),
    ).rejects.toThrow(/symbolic link/i);
  });
});
