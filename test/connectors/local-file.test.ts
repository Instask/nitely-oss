import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
