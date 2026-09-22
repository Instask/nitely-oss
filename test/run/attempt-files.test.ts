import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const attemptFileTrace = vi.hoisted(() => ({
  events: [] as string[],
  directorySyncPaths: [] as string[],
  afterDirectoryRequirement: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const flags = args[1];
      const directoryPath = process.platform === "linux" &&
          typeof flags === "number" &&
          (flags & constants.O_DIRECTORY) !== 0
        ? await actual.realpath(`/proc/self/fd/${handle.fd}`)
        : undefined;
      const syncEvent = flags === "wx"
        ? "temp.sync"
        : directoryPath !== undefined
          ? "parent.sync"
          : undefined;
      if (syncEvent) {
        const sync = handle.sync.bind(handle);
        Object.defineProperty(handle, "sync", {
          configurable: true,
          value: async () => {
            attemptFileTrace.events.push(syncEvent);
            if (directoryPath !== undefined) {
              attemptFileTrace.directorySyncPaths.push(directoryPath);
            }
            await sync();
          },
        });
      }
      return handle;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      attemptFileTrace.events.push("rename");
    },
  };
});

vi.mock("../../src/run/owned-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/run/owned-file.js")>();
  return {
    ...actual,
    requireRunOwnedDirectory: async (
      ...args: Parameters<typeof actual.requireRunOwnedDirectory>
    ) => {
      await actual.requireRunOwnedDirectory(...args);
      const callback = attemptFileTrace.afterDirectoryRequirement;
      if (callback) {
        attemptFileTrace.afterDirectoryRequirement = undefined;
        await callback();
      }
    },
  };
});

import {
  requireContainedAttemptDirectory,
  writeAttemptOwnedFile,
} from "../../src/run/attempt-files.js";

describe("attempt-owned files", () => {
  const roots: string[] = [];

  beforeEach(() => {
    attemptFileTrace.events = [];
    attemptFileTrace.directorySyncPaths = [];
    attemptFileTrace.afterDirectoryRequirement = undefined;
  });

  afterEach(async () => {
    attemptFileTrace.afterDirectoryRequirement = undefined;
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function createAttempt(): Promise<{
    root: string;
    runDirectory: string;
    attemptDirectory: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), "nitely-attempt-file-"));
    roots.push(root);
    const runDirectory = join(root, "runs", "run-1");
    const attemptDirectory = join(
      runDirectory,
      "stages",
      "implement",
      "1",
    );
    await mkdir(attemptDirectory, { recursive: true });
    return { root, runDirectory, attemptDirectory };
  }

  it.skipIf(process.platform !== "linux")(
    "rejects a logical Run root replaced with an outside symbolic link",
    async () => {
      const { root, runDirectory } = await createAttempt();
      const movedRunDirectory = join(root, "moved-run-1");
      const outsideRunDirectory = join(root, "outside-run-1");
      const outsideAttemptDirectory = join(
        outsideRunDirectory,
        "stages",
        "release",
        "1",
      );
      const logicalAttemptDirectory = join(
        runDirectory,
        "stages",
        "release",
        "1",
      );
      await mkdir(outsideAttemptDirectory, { recursive: true });
      await rename(runDirectory, movedRunDirectory);
      await symlink(outsideRunDirectory, runDirectory);

      await expect(requireContainedAttemptDirectory({
        runDirectory,
        attemptDirectory: logicalAttemptDirectory,
      })).rejects.toThrow(/run directory|symbolic link/i);
      await expect(readdir(outsideAttemptDirectory)).resolves.toEqual([]);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "requires an existing attempt directory without creating it",
    async () => {
      const { runDirectory } = await createAttempt();
      const missingAttemptDirectory = join(
        runDirectory,
        "stages",
        "release",
        "1",
      );

      await expect(requireContainedAttemptDirectory({
        runDirectory,
        attemptDirectory: missingAttemptDirectory,
      })).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(missingAttemptDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.skipIf(process.platform !== "linux")(
    "returns the lexical path of an existing contained attempt directory",
    async () => {
      const { runDirectory, attemptDirectory } = await createAttempt();

      await expect(requireContainedAttemptDirectory({
        runDirectory,
        attemptDirectory,
      })).resolves.toBe(attemptDirectory);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "rejects an attempt path whose existing parent is a symbolic-link alias",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "nitely-attempt-file-"));
      roots.push(root);
      const runDirectory = join(root, "runs", "run-1");
      const actualParent = join(runDirectory, "actual-implement");
      const aliasedParent = join(runDirectory, "stages", "implement");
      const attemptDirectory = join(aliasedParent, "1");
      await mkdir(join(actualParent, "1"), { recursive: true });
      await mkdir(dirname(aliasedParent), { recursive: true });
      await symlink(actualParent, aliasedParent);

      await expect(writeAttemptOwnedFile({
        runDirectory,
        attemptDirectory,
        filename: "stdout.log",
        content: "must stay in the logical attempt\n",
      })).rejects.toThrow(/symbolic link/i);
      await expect(access(join(actualParent, "1", "stdout.log"))).rejects
        .toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(process.platform !== "linux")(
    "rejects a parent replaced with an outside alias after containment validation",
    async () => {
      const { root, runDirectory, attemptDirectory } = await createAttempt();
      const originalParent = dirname(attemptDirectory);
      const movedParent = join(root, "moved-original-implement");
      const outsideParent = join(root, "outside-implement");
      await mkdir(join(outsideParent, "1"), { recursive: true });

      attemptFileTrace.afterDirectoryRequirement = async () => {
        await rename(originalParent, movedParent);
        await symlink(outsideParent, originalParent);
      };

      await expect(writeAttemptOwnedFile({
        runDirectory,
        attemptDirectory,
        filename: "stdout.log",
        content: "must not escape the Run\n",
      })).rejects.toThrow(/parent directory|symbolic link|changed/i);
      await expect(access(join(outsideParent, "1", "stdout.log"))).rejects
        .toMatchObject({ code: "ENOENT" });
      await expect(access(join(movedParent, "1", "stdout.log"))).rejects
        .toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(process.platform !== "linux")(
    "syncs the temporary attempt file before rename and its anchored parent after",
    async () => {
      const { runDirectory, attemptDirectory } = await createAttempt();
      const targetPath = join(attemptDirectory, "stdout.log");

      await expect(writeAttemptOwnedFile({
        runDirectory,
        attemptDirectory,
        filename: "stdout.log",
        content: "durable output\n",
      })).resolves.toBe(targetPath);

      await expect(readFile(targetPath, "utf8")).resolves.toBe(
        "durable output\n",
      );
      expect(attemptFileTrace.events).toEqual([
        "temp.sync",
        "rename",
        "parent.sync",
      ]);
      expect(attemptFileTrace.directorySyncPaths).toEqual([
        await realpath(attemptDirectory),
      ]);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "atomically replaces a regular attempt file with private permissions",
    async () => {
      const { runDirectory, attemptDirectory } = await createAttempt();
      const targetPath = join(attemptDirectory, "stdout.log");
      await writeFile(targetPath, "old output\n", { mode: 0o644 });

      await expect(writeAttemptOwnedFile({
        runDirectory,
        attemptDirectory,
        filename: "stdout.log",
        content: "new output\n",
      })).resolves.toBe(targetPath);

      await expect(readFile(targetPath, "utf8")).resolves.toBe("new output\n");
      const metadata = await stat(targetPath);
      expect(metadata.isFile()).toBe(true);
      expect(metadata.nlink).toBe(1);
      expect(metadata.mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "linux")(
    "fails closed when descriptor-relative Run anchoring is unavailable",
    async () => {
      const { runDirectory, attemptDirectory } = await createAttempt();
      const targetPath = join(attemptDirectory, "stdout.log");

      await expect(writeAttemptOwnedFile({
        runDirectory,
        attemptDirectory,
        filename: "stdout.log",
        content: "must not use a path-based fallback\n",
      })).rejects.toThrow(/requires Linux descriptor-relative path anchoring/i);
      await expect(access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("preserves filename and attempt-containment errors", async () => {
    const { root, runDirectory, attemptDirectory } = await createAttempt();

    await expect(writeAttemptOwnedFile({
      runDirectory,
      attemptDirectory,
      filename: "../stdout.log",
      content: "invalid\n",
    })).rejects.toThrow("invalid attempt filename: ../stdout.log");
    await expect(writeAttemptOwnedFile({
      runDirectory,
      attemptDirectory: join(root, "outside-attempt"),
      filename: "stdout.log",
      content: "invalid\n",
    })).rejects.toThrow(
      `attempt directory escapes run directory: ${join(root, "outside-attempt")}`,
    );
  });

  it("preserves the regular-file error without following the target alias", async () => {
    const { root, runDirectory, attemptDirectory } = await createAttempt();
    const outsidePath = join(root, "outside.log");
    const targetPath = join(attemptDirectory, "stdout.log");
    await writeFile(outsidePath, "outside must survive\n", "utf8");
    await symlink(outsidePath, targetPath);

    await expect(writeAttemptOwnedFile({
      runDirectory,
      attemptDirectory,
      filename: "stdout.log",
      content: "replacement\n",
    })).rejects.toThrow("stdout.log must be a regular file");
    await expect(readFile(outsidePath, "utf8")).resolves.toBe(
      "outside must survive\n",
    );
    expect((await lstat(targetPath)).isSymbolicLink()).toBe(true);
  });
});
