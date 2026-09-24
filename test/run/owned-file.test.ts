import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  copyRunOwnedFile,
  createRunOwnedDirectory,
  ensureRunOwnedDirectory,
  listRunOwnedDirectory,
  readRunOwnedFile,
  removeRunOwnedDirectoryRecursively,
  removeRunOwnedFile,
} from "../../src/run/owned-file.js";

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("Run-owned files", () => {
  it.skipIf(process.platform !== "linux")(
    "creates a nested Run directory through an exclusive anchored boundary",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "nitely-run-owned-file-"));
      const runDirectory = join(root, "runs", "run-1");
      const attemptDirectory = join(runDirectory, "stages", "release", "1");
      await mkdir(runDirectory, { recursive: true });

      await expect(
        createRunOwnedDirectory({
          runDirectory,
          path: "stages/release/1",
          subject: "test release attempt directory",
        }),
      ).resolves.toBeUndefined();
      await expect(stat(attemptDirectory)).resolves.toMatchObject({
        mode: expect.any(Number),
      });
    },
  );

  it.skipIf(process.platform !== "linux")(
    "preserves EEXIST when an exclusive Run directory leaf already exists",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "nitely-run-owned-file-"));
      const runDirectory = join(root, "runs", "run-1");
      await mkdir(join(runDirectory, "stages", "release", "1"), {
        recursive: true,
      });

      await expect(
        createRunOwnedDirectory({
          runDirectory,
          path: "stages/release/1",
          subject: "test release attempt directory",
        }),
      ).rejects.toMatchObject({ code: "EEXIST" });
    },
  );

  it.skipIf(process.platform !== "linux")(
    "does not create an exclusive Run directory through a symbolic-link ancestor",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "nitely-run-owned-file-"));
      const runDirectory = join(root, "runs", "run-1");
      const outsideDirectory = join(root, "outside");
      await mkdir(join(runDirectory, "stages"), { recursive: true });
      await mkdir(outsideDirectory);
      await symlink(
        outsideDirectory,
        join(runDirectory, "stages", "release"),
      );

      await expect(
        createRunOwnedDirectory({
          runDirectory,
          path: "stages/release/1",
          subject: "test release attempt directory",
        }),
      ).rejects.toThrow(/symbolic link/i);
      await expect(readdir(outsideDirectory)).resolves.toEqual([]);
    },
  );

  it("creates a nested Run directory through its anchored boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-run-owned-file-"));
    const repoPath = join(root, "repo");
    const directoryPath = join(
      repoPath,
      ".nitely",
      "runs",
      "run-1",
      "stages",
      "review",
      "1",
    );
    await mkdir(repoPath);

    await expect(ensureRunOwnedDirectory({
      runDirectory: repoPath,
      path: ".nitely/runs/run-1/stages/review/1",
      subject: "test attempt directory",
    })).resolves.toBeUndefined();
    await expect(stat(directoryPath)).resolves.toMatchObject({
      mode: expect.any(Number),
    });
  });

  it("does not create a Run directory through a symbolic-link ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-run-owned-file-"));
    const repoPath = join(root, "repo");
    const outsidePath = join(root, "outside");
    await mkdir(repoPath);
    await mkdir(outsidePath);
    await symlink(outsidePath, join(repoPath, ".nitely"));

    await expect(ensureRunOwnedDirectory({
      runDirectory: repoPath,
      path: ".nitely/runs/run-1",
      subject: "test attempt directory",
    })).rejects.toThrow(/symbolic link/i);
    await expect(access(join(outsidePath, "runs"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("allows a filename that begins with two dots", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-run-owned-file-"));
    const runDirectory = join(root, "runs", "run-1");
    await mkdir(runDirectory, { recursive: true });
    await writeFile(join(runDirectory, "..notes"), "inside Run\n", "utf8");

    const result = await readRunOwnedFile({
      runDirectory,
      path: "..notes",
      subject: "test Artifact path",
    });

    expect(result.content.toString("utf8")).toBe("inside Run\n");
    expect(result.relativePath).toBe("..notes");
  });

  it("copies a multi-chunk file through a verified source handle", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-run-owned-file-"));
    const runDirectory = join(root, "runs", "run-1");
    const sourcePath = join(runDirectory, "stages", "implement", "output.md");
    const destinationPath = join(root, "export", "output.md");
    const content = Buffer.alloc(1024 * 1024 + 37);
    for (let index = 0; index < content.length; index += 1) {
      content[index] = index % 251;
    }
    await mkdir(dirname(sourcePath), { recursive: true });
    await mkdir(dirname(destinationPath), { recursive: true });
    await writeFile(sourcePath, content);

    await expect(
      copyRunOwnedFile({
        runDirectory,
        path: "stages/implement/output.md",
        subject: "test Artifact path",
        destinationPath,
      }),
    ).resolves.toEqual({
      relativePath: "stages/implement/output.md",
      filename: "output.md",
      sha256: sha256(content),
      size: content.byteLength,
    });

    const copied = await readFile(destinationPath);
    await expect(stat(destinationPath)).resolves.toMatchObject({
      size: content.length,
    });
    expect(sha256(copied)).toBe(sha256(content));
  });

  it("does not replace or remove an existing copy destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-run-owned-file-"));
    const runDirectory = join(root, "runs", "run-1");
    const sourcePath = join(runDirectory, "output.md");
    const destinationPath = join(root, "export", "output.md");
    await mkdir(runDirectory, { recursive: true });
    await mkdir(dirname(destinationPath), { recursive: true });
    await writeFile(sourcePath, "Run-owned\n", "utf8");
    await writeFile(destinationPath, "Keep existing\n", "utf8");

    await expect(
      copyRunOwnedFile({
        runDirectory,
        path: "output.md",
        subject: "test Artifact path",
        destinationPath,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(readFile(destinationPath, "utf8")).resolves.toBe(
      "Keep existing\n",
    );
  });

  it("removes a copy whose bytes do not match the expected digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-run-owned-file-"));
    const runDirectory = join(root, "runs", "run-1");
    const sourcePath = join(runDirectory, "output.md");
    const destinationPath = join(root, "export", "output.md");
    const content = "changed after publication\n";
    await mkdir(runDirectory, { recursive: true });
    await mkdir(dirname(destinationPath), { recursive: true });
    await writeFile(sourcePath, content, "utf8");

    await expect(
      copyRunOwnedFile({
        runDirectory,
        path: "output.md",
        subject: "test Artifact path",
        destinationPath,
        expectedSha256: "0".repeat(64),
        expectedSize: Buffer.byteLength(content),
      }),
    ).rejects.toThrow(/sha256/i);
    await expect(access(destinationPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not remove a replacement destination when a copy fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-run-owned-file-"));
    try {
      const runDirectory = join(root, "runs", "run-1");
      const sourcePath = join(runDirectory, "payload.bin");
      const destinationPath = join(root, "export", "payload.bin");
      const movedDestinationPath = join(root, "export", "original-copy.bin");
      await mkdir(runDirectory, { recursive: true });
      await mkdir(dirname(destinationPath), { recursive: true });
      await writeFile(sourcePath, "");
      await truncate(sourcePath, 128 * 1024 * 1024);

      const copying = copyRunOwnedFile({
        runDirectory,
        path: "payload.bin",
        subject: "test Artifact path",
        destinationPath,
        expectedSha256: "f".repeat(64),
        expectedSize: 128 * 1024 * 1024,
      });
      let destinationOpened = false;
      for (let attempt = 0; attempt < 10_000; attempt += 1) {
        try {
          await access(destinationPath);
          destinationOpened = true;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await new Promise<void>((resolveWait) => setImmediate(resolveWait));
        }
      }
      expect(destinationOpened).toBe(true);
      await rename(destinationPath, movedDestinationPath);
      await writeFile(destinationPath, "replacement must survive\n", "utf8");

      await expect(copying).rejects.toThrow(/sha256/i);
      await expect(readFile(destinationPath, "utf8")).resolves.toBe(
        "replacement must survive\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a successful copy whose destination entry is replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-run-owned-file-"));
    try {
      const runDirectory = join(root, "runs", "run-1");
      const sourcePath = join(runDirectory, "payload.bin");
      const destinationPath = join(root, "export", "payload.bin");
      const movedDestinationPath = join(root, "export", "original-copy.bin");
      await mkdir(runDirectory, { recursive: true });
      await mkdir(dirname(destinationPath), { recursive: true });
      await writeFile(sourcePath, "");
      await truncate(sourcePath, 128 * 1024 * 1024);

      const copying = copyRunOwnedFile({
        runDirectory,
        path: "payload.bin",
        subject: "test Artifact path",
        destinationPath,
      });
      let destinationOpened = false;
      for (let attempt = 0; attempt < 10_000; attempt += 1) {
        try {
          await access(destinationPath);
          destinationOpened = true;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await new Promise<void>((resolveWait) => setImmediate(resolveWait));
        }
      }
      expect(destinationOpened).toBe(true);
      await rename(destinationPath, movedDestinationPath);
      await writeFile(destinationPath, "replacement must survive\n", "utf8");

      await expect(copying).rejects.toThrow(/destination.*changed|changed/i);
      await expect(readFile(destinationPath, "utf8")).resolves.toBe(
        "replacement must survive\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes a regular file through its anchored Run parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-run-owned-file-"));
    const runDirectory = join(root, "runs", "run-1");
    const path = join(runDirectory, "stages", "implement", "output.md");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "delete me\n", "utf8");

    await expect(
      removeRunOwnedFile({
        runDirectory,
        path: "stages/implement/output.md",
        subject: "test Artifact path",
      }),
    ).resolves.toBe(true);
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not delete through a symbolic-link parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-run-owned-file-"));
    const runDirectory = join(root, "runs", "run-1");
    const outsideDirectory = join(root, "outside");
    const outsidePath = join(outsideDirectory, "output.md");
    await mkdir(runDirectory, { recursive: true });
    await mkdir(outsideDirectory, { recursive: true });
    await writeFile(outsidePath, "outside must survive\n", "utf8");
    await symlink(outsideDirectory, join(runDirectory, "stages"));

    await expect(
      removeRunOwnedFile({
        runDirectory,
        path: "stages/output.md",
        subject: "test Artifact path",
      }),
    ).rejects.toThrow(/symbolic link/i);
    await expect(readFile(outsidePath, "utf8")).resolves.toBe(
      "outside must survive\n",
    );
  });

  it("removes a Run directory through its anchored runs root", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-run-owned-file-"));
    const runsRoot = join(root, "runs");
    const runDirectory = join(runsRoot, "run-1");
    await mkdir(join(runDirectory, "stages"), { recursive: true });
    await writeFile(join(runDirectory, "stages", "output.md"), "delete me\n", "utf8");

    await expect(
      removeRunOwnedDirectoryRecursively({
        runDirectory: runsRoot,
        path: "run-1",
        subject: "test Run directory",
      }),
    ).resolves.toBe(true);
    await expect(access(runDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not recursively remove a symbolic-link Run directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-run-owned-file-"));
    const runsRoot = join(root, "runs");
    const outsideDirectory = join(root, "outside-run");
    const outsidePath = join(outsideDirectory, "keep.md");
    await mkdir(runsRoot, { recursive: true });
    await mkdir(outsideDirectory, { recursive: true });
    await writeFile(outsidePath, "outside must survive\n", "utf8");
    await symlink(outsideDirectory, join(runsRoot, "run-1"));

    await expect(
      removeRunOwnedDirectoryRecursively({
        runDirectory: runsRoot,
        path: "run-1",
        subject: "test Run directory",
      }),
    ).rejects.toThrow(/symbolic link/i);
    await expect(readFile(outsidePath, "utf8")).resolves.toBe(
      "outside must survive\n",
    );
  });

  it("does not recursively remove through a symbolic-link runs root", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-run-owned-file-"));
    const repoPath = join(root, "repo");
    const outsideRunsRoot = join(root, "outside-runs");
    const outsideRunDirectory = join(outsideRunsRoot, "run-1");
    const outsidePath = join(outsideRunDirectory, "keep.md");
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    await mkdir(outsideRunDirectory, { recursive: true });
    await writeFile(outsidePath, "outside must survive\n", "utf8");
    await symlink(outsideRunsRoot, join(repoPath, ".nitely", "runs"));

    await expect(
      removeRunOwnedDirectoryRecursively({
        runDirectory: repoPath,
        path: ".nitely/runs/run-1",
        subject: "test Run directory",
      }),
    ).rejects.toThrow(/symbolic link/i);
    await expect(readFile(outsidePath, "utf8")).resolves.toBe(
      "outside must survive\n",
    );
  });

  it("does not list through a symbolic-link runs root", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-run-owned-file-"));
    const repoPath = join(root, "repo");
    const outsideRunsRoot = join(root, "outside-runs");
    await mkdir(join(repoPath, ".nitely"), { recursive: true });
    await mkdir(join(outsideRunsRoot, "run-outside"), { recursive: true });
    await symlink(outsideRunsRoot, join(repoPath, ".nitely", "runs"));

    await expect(
      listRunOwnedDirectory({
        runDirectory: repoPath,
        path: ".nitely/runs",
        subject: "test runs root",
      }),
    ).rejects.toThrow(/symbolic link/i);
  });

  it("does not let a replacement Run directory enter recursive removal", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-run-owned-file-"));
    const runsRoot = join(root, "runs");
    const runDirectory = join(runsRoot, "run-1");
    await mkdir(runDirectory, { recursive: true });
    await Promise.all(
      Array.from({ length: 1_000 }, (_, index) =>
        writeFile(join(runDirectory, `artifact-${index}.txt`), "delete me\n"),
      ),
    );

    const removing = removeRunOwnedDirectoryRecursively({
      runDirectory: runsRoot,
      path: "run-1",
      subject: "test Run directory",
    });
    let sawQuarantine = false;
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      const entries = await readdir(runsRoot);
      if (entries.some((entry) => entry.endsWith(".removing"))) {
        sawQuarantine = true;
        break;
      }
      await new Promise<void>((resolveWait) => setImmediate(resolveWait));
    }
    expect(sawQuarantine).toBe(true);
    await mkdir(runDirectory);
    await writeFile(join(runDirectory, "replacement.txt"), "must survive\n", "utf8");

    await expect(removing).resolves.toBe(true);
    await expect(
      readFile(join(runDirectory, "replacement.txt"), "utf8"),
    ).resolves.toBe("must survive\n");
  });

  it("does not remove through a symbolic-link boundary root", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-run-owned-file-"));
    const actualRoot = join(root, "actual-root");
    const aliasedRoot = join(root, "aliased-root");
    const filePath = join(actualRoot, "output.md");
    await mkdir(actualRoot, { recursive: true });
    await writeFile(filePath, "must survive\n", "utf8");
    await symlink(actualRoot, aliasedRoot);

    await expect(
      removeRunOwnedFile({
        runDirectory: aliasedRoot,
        path: "output.md",
        subject: "test Artifact path",
      }),
    ).rejects.toThrow(/symbolic link|symbolic-link alias/i);
    await expect(readFile(filePath, "utf8")).resolves.toBe("must survive\n");
  });

  it("rejects a copy when an opened parent directory leaves the Run", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-run-owned-file-"));
    try {
      const runDirectory = join(root, "runs", "run-1");
      const sourceParent = join(runDirectory, "stages", "implement");
      const sourcePath = join(sourceParent, "payload.bin");
      const destinationPath = join(root, "export", "payload.bin");
      await mkdir(sourceParent, { recursive: true });
      await mkdir(dirname(destinationPath), { recursive: true });
      await writeFile(sourcePath, "");
      await truncate(sourcePath, 128 * 1024 * 1024);

      const copying = copyRunOwnedFile({
        runDirectory,
        path: "stages/implement/payload.bin",
        subject: "test Artifact path",
        destinationPath,
      });
      let destinationOpened = false;
      for (let attempt = 0; attempt < 10_000; attempt += 1) {
        try {
          await access(destinationPath);
          destinationOpened = true;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await new Promise<void>((resolveWait) => setImmediate(resolveWait));
        }
      }
      expect(destinationOpened).toBe(true);
      await rename(sourceParent, join(root, "moved-outside-run"));

      await expect(copying).rejects.toThrow(/parent directory|changed/i);
      await expect(access(destinationPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
