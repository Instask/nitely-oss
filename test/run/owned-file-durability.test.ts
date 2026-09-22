import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const durabilityTrace = vi.hoisted(() => ({
  events: [] as string[],
  directorySyncPaths: [] as string[],
  failParentSync: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const { constants } = await import("node:fs");
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const flags = args[1];
      const directoryPath = typeof flags === "number" &&
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
            durabilityTrace.events.push(syncEvent);
            if (directoryPath !== undefined) {
              durabilityTrace.directorySyncPaths.push(directoryPath);
            }
            if (syncEvent === "parent.sync" && durabilityTrace.failParentSync) {
              throw Object.assign(new Error("directory sync failed"), {
                code: "EIO",
              });
            }
            await sync();
          },
        });
      }
      return handle;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      durabilityTrace.events.push("rename");
    },
  };
});

import { writeRunOwnedFileAtomically } from "../../src/run/owned-file.js";

describe("Run-owned file durability", () => {
  const roots: string[] = [];

  beforeEach(() => {
    durabilityTrace.events = [];
    durabilityTrace.directorySyncPaths = [];
    durabilityTrace.failParentSync = false;
  });

  afterEach(async () => {
    durabilityTrace.failParentSync = false;
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function createRunDirectory(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "nitely-owned-durability-"));
    roots.push(root);
    const runDirectory = join(root, "runs", "run-1");
    await mkdir(runDirectory, { recursive: true });
    return runDirectory;
  }

  it("syncs the temporary file before rename and its anchored parent after", async () => {
    const runDirectory = await createRunDirectory();
    const leafParent = join(runDirectory, "artifacts");
    await mkdir(leafParent);

    await writeRunOwnedFileAtomically({
      runDirectory,
      path: "artifacts/run.json",
      subject: "test Run metadata",
      content: "durable\n",
    });

    await expect(readFile(join(leafParent, "run.json"), "utf8")).resolves
      .toBe("durable\n");
    expect(durabilityTrace.events).toEqual([
      "temp.sync",
      "rename",
      "parent.sync",
    ]);
    expect(durabilityTrace.directorySyncPaths).toEqual([
      await realpath(leafParent),
    ]);
  });

  it("preserves the renamed file when syncing its anchored parent fails", async () => {
    const runDirectory = await createRunDirectory();
    const leafParent = join(runDirectory, "artifacts");
    await mkdir(leafParent);
    durabilityTrace.failParentSync = true;

    await expect(writeRunOwnedFileAtomically({
      runDirectory,
      path: "artifacts/run.json",
      subject: "test Run metadata",
      content: "not durable\n",
    })).rejects.toMatchObject({ code: "EIO" });
    expect(durabilityTrace.events).toEqual([
      "temp.sync",
      "rename",
      "parent.sync",
    ]);
    expect(durabilityTrace.directorySyncPaths).toEqual([
      await realpath(leafParent),
    ]);
    await expect(access(join(leafParent, "run.json"))).resolves.toBeUndefined();
    await expect(readFile(join(leafParent, "run.json"), "utf8")).resolves
      .toBe("not durable\n");
  });
});
