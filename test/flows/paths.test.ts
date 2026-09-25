import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { withBundledFlowArgument } from "../../src/cli.js";
import {
  BuiltinFlowPathError,
  bundledFlowsRoot,
  resolveBuiltinFlowPath,
  resolveRepositoryFlowPath,
  RepositoryFlowPathError,
} from "../../src/flows/paths.js";

async function rootWithFlows(flows: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nitely-flow-paths-"));
  await mkdir(join(root, "flows"), { recursive: true });
  for (const [name, content] of Object.entries(flows)) {
    await writeFile(join(root, "flows", name), content);
  }
  return root;
}

describe("built-in flow resolution", () => {
  it("uses the flow shipped with the installation when the repository has none", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-flow-repo-"));
    const bundled = await rootWithFlows({ "shipped.json": "{}" });

    await expect(
      resolveBuiltinFlowPath(repo, "flows/shipped.json", bundled),
    ).resolves.toEqual({
      flowPath: "flows/shipped.json",
      absolutePath: join(bundled, "flows", "shipped.json"),
    });
    await expect(
      resolveRepositoryFlowPath(repo, "flows/shipped.json", bundled),
    ).resolves.toEqual({
      flowPath: "flows/shipped.json",
      absolutePath: join(bundled, "flows", "shipped.json"),
    });
  });

  it("prefers the repository's own copy of a built-in flow", async () => {
    const repo = await rootWithFlows({ "shipped.json": "{}" });
    const bundled = await rootWithFlows({ "shipped.json": "{}" });

    await expect(
      resolveBuiltinFlowPath(repo, "flows/shipped.json", bundled),
    ).resolves.toMatchObject({ absolutePath: join(repo, "flows", "shipped.json") });
    await expect(
      resolveRepositoryFlowPath(repo, "flows/shipped.json", bundled),
    ).resolves.toMatchObject({ absolutePath: join(repo, "flows", "shipped.json") });
  });

  it("still rejects missing flows, traversal, and repository escapes", async () => {
    const repo = await mkdtemp(join(tmpdir(), "nitely-flow-repo-"));
    const bundled = await rootWithFlows({ "shipped.json": "{}" });

    await expect(
      resolveBuiltinFlowPath(repo, "flows/missing.json", bundled),
    ).rejects.toBeInstanceOf(BuiltinFlowPathError);
    await expect(
      resolveBuiltinFlowPath(repo, "flows/../shipped.json", bundled),
    ).rejects.toBeInstanceOf(BuiltinFlowPathError);
    await expect(
      resolveRepositoryFlowPath(repo, "flows/missing.json", bundled),
    ).rejects.toBeInstanceOf(RepositoryFlowPathError);
    await expect(
      resolveRepositoryFlowPath(repo, "../outside/flows/shipped.json", bundled),
    ).rejects.toBeInstanceOf(RepositoryFlowPathError);
  });

  it("does not follow a repository flows symlink out of the repository", async () => {
    const outside = await rootWithFlows({ "shipped.json": "{}" });
    const repo = await mkdtemp(join(tmpdir(), "nitely-flow-repo-"));
    await symlink(join(outside, "flows"), join(repo, "flows"));
    const bundled = await rootWithFlows({ "shipped.json": "{}" });

    await expect(
      resolveBuiltinFlowPath(repo, "flows/shipped.json", bundled),
    ).rejects.toBeInstanceOf(BuiltinFlowPathError);
  });

  it("ships the built-in flows with the installation", async () => {
    await expect(
      resolveBuiltinFlowPath(
        await mkdtemp(join(tmpdir(), "nitely-flow-repo-")),
        "flows/implement-spec-bootstrap.json",
      ),
    ).resolves.toMatchObject({
      absolutePath: join(bundledFlowsRoot(), "flows", "implement-spec-bootstrap.json"),
    });
  });
});

describe("CLI flow argument", () => {
  it("maps a built-in flow path the current directory lacks to the shipped flow", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nitely-flow-cwd-"));
    const bundled = await rootWithFlows({ "shipped.json": "{}" });

    await expect(
      withBundledFlowArgument(
        ["validate", "flows/shipped.json", "--external-input", "spec"],
        cwd,
        bundled,
      ),
    ).resolves.toEqual([
      "validate",
      join(bundled, "flows", "shipped.json"),
      "--external-input",
      "spec",
    ]);
  });

  it("keeps a flow file that exists relative to the current directory", async () => {
    const cwd = await rootWithFlows({ "shipped.json": "{}" });
    const bundled = await rootWithFlows({ "shipped.json": "{}" });
    const argv = ["run", "flows/shipped.json", "--repo", "."];

    await expect(withBundledFlowArgument(argv, cwd, bundled)).resolves.toEqual(argv);
  });

  it("leaves subcommands and other commands alone", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nitely-flow-cwd-"));
    const bundled = await rootWithFlows({ "list.json": "{}" });

    for (const argv of [
      ["run", "list"],
      ["task", "flows/list.json"],
      ["run", "--help"],
    ]) {
      await expect(withBundledFlowArgument(argv, cwd, bundled)).resolves.toEqual(argv);
    }
  });
});
