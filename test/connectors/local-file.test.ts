import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  rename,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { LocalFileConnector } from "../../src/connectors/local-file.js";

async function createFixture() {
  const parent = await mkdtemp(join(tmpdir(), "nitely-local-file-"));
  const baseDirectory = join(parent, "project");
  const specPath = join(baseDirectory, "docs", "spec.md");
  await mkdir(dirname(specPath), { recursive: true });
  await writeFile(specPath, "# Specification\n", "utf8");
  return { parent, baseDirectory, specPath };
}

describe("LocalFileConnector", () => {
  it("fetches a relative file from its base directory", async () => {
    const { baseDirectory } = await createFixture();
    const connector = new LocalFileConnector(baseDirectory);

    const result = await connector.fetch({
      connector: "local-file",
      uri: "docs/spec.md",
    });

    expect(result.content.toString("utf8")).toBe("# Specification\n");
    expect(result.mediaType).toBe("text/markdown");
    expect(result.metadata?.filename).toBe("spec.md");
  });

  it("accepts a file URL within its base directory", async () => {
    const { baseDirectory, specPath } = await createFixture();
    const connector = new LocalFileConnector(baseDirectory);

    const result = await connector.fetch({
      connector: "local-file",
      uri: pathToFileURL(specPath).href,
    });

    expect(result.sourceUri).toBe(pathToFileURL(specPath).href);
    expect(result.content.toString("utf8")).toContain("Specification");
  });

  it("validates an expected digest against the consumed bytes and uses it as revision", async () => {
    const { baseDirectory } = await createFixture();
    const connector = new LocalFileConnector(baseDirectory);
    const sha256 = createHash("sha256")
      .update("# Specification\n")
      .digest("hex");

    const prefixed = await connector.fetch({
      connector: "local-file",
      uri: "docs/spec.md",
      options: { expectedSha256: `sha256:${sha256}` },
    });
    const bare = await connector.fetch({
      connector: "local-file",
      uri: "docs/spec.md",
      options: { expectedSha256: sha256.toUpperCase() },
    });

    expect(prefixed.revision).toBe(`sha256:${sha256}`);
    expect(bare.revision).toBe(`sha256:${sha256}`);
  });

  it("fails closed when the consumed bytes do not match the expected digest", async () => {
    const { baseDirectory } = await createFixture();
    const connector = new LocalFileConnector(baseDirectory);

    await expect(connector.fetch({
      connector: "local-file",
      uri: "docs/spec.md",
      options: { expectedSha256: "0".repeat(64) },
    })).rejects.toThrow(/sha256.*does not match/i);
  });

  it("rejects malformed expected digests instead of ignoring them", async () => {
    const { baseDirectory } = await createFixture();
    const connector = new LocalFileConnector(baseDirectory);

    for (const expectedSha256 of [
      "sha256:not-a-digest",
      `sha512:${"0".repeat(64)}`,
      `SHA256:${"0".repeat(64)}`,
      ` sha256:${"0".repeat(64)}`,
      123,
    ]) {
      await expect(connector.fetch({
        connector: "local-file",
        uri: "docs/spec.md",
        options: { expectedSha256 },
      })).rejects.toThrow(/invalid expected sha256/i);
    }
  });

  it("fails closed when the verified path is swapped before descriptor consumption", async () => {
    const { parent, baseDirectory, specPath } = await createFixture();
    const outsidePath = join(parent, "outside-secret.md");
    const originalPath = join(baseDirectory, "docs", "original-spec.md");
    await writeFile(outsidePath, "outside secret\n", "utf8");
    let hookRan = false;
    const connector = new LocalFileConnector(baseDirectory, {
      afterFileOpened: async () => {
        hookRan = true;
        await rename(specPath, originalPath);
        await symlink(outsidePath, specPath);
      },
    });

    await expect(connector.fetch({
      connector: "local-file",
      uri: "docs/spec.md",
    })).rejects.toThrow(/changed while it was being read/i);
    expect(hookRan).toBe(true);
  });

  it("rejects files above the bounded local-input read limit", async () => {
    const { baseDirectory, specPath } = await createFixture();
    await truncate(specPath, 16 * 1024 * 1024 + 1);
    const connector = new LocalFileConnector(baseDirectory);

    let readError: unknown;
    try {
      await connector.fetch({
        connector: "local-file",
        uri: "docs/spec.md",
      });
    } catch (error) {
      readError = error;
    }

    expect(readError).toBeInstanceOf(Error);
    expect((readError as Error).message).toMatch(/exceeds.*read limit/i);
  });

  it("supports a stricter caller-owned read limit", async () => {
    const { baseDirectory, specPath } = await createFixture();
    await writeFile(specPath, "12345", "utf8");
    const connector = new LocalFileConnector(baseDirectory, {
      maximumBytes: 4,
    });

    await expect(connector.fetch({
      connector: "local-file",
      uri: "docs/spec.md",
    })).rejects.toThrow(/exceeds the 4-byte read limit/i);
  });

  it("can require the consumed file to have a single directory entry", async () => {
    const { baseDirectory, specPath } = await createFixture();
    await link(specPath, join(baseDirectory, "docs", "spec-copy.md"));
    const connector = new LocalFileConnector(baseDirectory, {
      requireSingleLink: true,
    });

    await expect(connector.fetch({
      connector: "local-file",
      uri: "docs/spec.md",
    })).rejects.toThrow(/exactly one directory entry/i);
  });

  it("rejects an in-base symbolic link when single-link ownership is required", async () => {
    const { baseDirectory, specPath } = await createFixture();
    await symlink(specPath, join(baseDirectory, "docs", "spec-link.md"));
    const connector = new LocalFileConnector(baseDirectory, {
      requireSingleLink: true,
    });

    await expect(connector.fetch({
      connector: "local-file",
      uri: "docs/spec-link.md",
    })).rejects.toThrow(/symbolic link/i);
  });

  it("rejects a symbolic-link parent when single-link ownership is required", async () => {
    const { baseDirectory } = await createFixture();
    const docsPath = join(baseDirectory, "docs");
    const actualDocsPath = join(baseDirectory, "actual-docs");
    await rename(docsPath, actualDocsPath);
    await symlink(actualDocsPath, docsPath, "dir");
    const connector = new LocalFileConnector(baseDirectory, {
      requireSingleLink: true,
    });

    await expect(connector.fetch({
      connector: "local-file",
      uri: "docs/spec.md",
    })).rejects.toThrow(/symbolic link/i);
  });

  it("rejects paths outside its base directory", async () => {
    const { parent, baseDirectory } = await createFixture();
    await writeFile(join(parent, "secret.txt"), "secret", "utf8");
    const connector = new LocalFileConnector(baseDirectory);

    await expect(
      connector.fetch({
        connector: "local-file",
        uri: "../secret.txt",
      }),
    ).rejects.toThrow(/outside local-file base directory/);
  });

  it("accepts an absolute path under an allowed root outside the base directory", async () => {
    const { parent, baseDirectory } = await createFixture();
    const cwdRoot = join(parent, "operator-cwd");
    const externalSpec = join(cwdRoot, "local-spec.md");
    await mkdir(cwdRoot, { recursive: true });
    await writeFile(externalSpec, "# External Spec\n", "utf8");
    const connector = new LocalFileConnector(baseDirectory, {
      allowedRoots: [cwdRoot],
    });

    const result = await connector.fetch({
      connector: "local-file",
      uri: externalSpec,
    });

    expect(result.content.toString("utf8")).toBe("# External Spec\n");
    expect(result.mediaType).toBe("text/markdown");
    expect(result.metadata?.filename).toBe("local-spec.md");
  });

  it("rejects an absolute path that is outside both the base directory and allowed roots", async () => {
    const { parent, baseDirectory } = await createFixture();
    const cwdRoot = join(parent, "operator-cwd");
    const thirdParty = join(parent, "third-party");
    await mkdir(cwdRoot, { recursive: true });
    await mkdir(thirdParty, { recursive: true });
    const secretPath = join(thirdParty, "secret.md");
    await writeFile(secretPath, "secret\n", "utf8");
    const connector = new LocalFileConnector(baseDirectory, {
      allowedRoots: [cwdRoot],
    });

    await expect(
      connector.fetch({
        connector: "local-file",
        uri: secretPath,
      }),
    ).rejects.toThrow(/outside local-file base directory/);
  });

  it("rejects a symlink under an allowed root whose target escapes all allowed roots", async () => {
    const { parent, baseDirectory } = await createFixture();
    const cwdRoot = join(parent, "operator-cwd");
    const thirdParty = join(parent, "third-party");
    await mkdir(cwdRoot, { recursive: true });
    await mkdir(thirdParty, { recursive: true });
    const secretPath = join(thirdParty, "secret.md");
    await writeFile(secretPath, "secret\n", "utf8");
    const linkPath = join(cwdRoot, "escape.md");
    await symlink(secretPath, linkPath);
    const connector = new LocalFileConnector(baseDirectory, {
      allowedRoots: [cwdRoot],
    });

    await expect(
      connector.fetch({
        connector: "local-file",
        uri: linkPath,
      }),
    ).rejects.toThrow(/outside local-file base directory/);
  });

  it("rejects a local path whose symlink target escapes the base directory", async () => {
    const { parent, baseDirectory, specPath } = await createFixture();
    const outsidePath = join(parent, "outside.md");
    await writeFile(outsidePath, "outside\n", "utf8");
    await rename(specPath, join(baseDirectory, "docs", "original.md"));
    await symlink(outsidePath, specPath);
    const connector = new LocalFileConnector(baseDirectory);

    await expect(connector.fetch({
      connector: "local-file",
      uri: "docs/spec.md",
    })).rejects.toThrow(/outside local-file base directory/);
  });

  it("rejects directories", async () => {
    const { baseDirectory } = await createFixture();
    const connector = new LocalFileConnector(baseDirectory);

    await expect(
      connector.fetch({
        connector: "local-file",
        uri: "docs",
      }),
    ).rejects.toThrow(/not a regular file/);
  });

  it("rejects missing files", async () => {
    const { baseDirectory } = await createFixture();
    const connector = new LocalFileConnector(baseDirectory);

    await expect(
      connector.fetch({
        connector: "local-file",
        uri: "missing.md",
      }),
    ).rejects.toThrow(/unable to read local resource/);
  });
});
