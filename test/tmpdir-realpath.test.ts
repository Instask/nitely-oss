import { mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeTempDirectoryEnvironment } from "./setup/realpath-tmpdir.js";

describe("vitest temp directory setup", () => {
  it("normalizes temp directory environment variables through realpath", async () => {
    const root = await mkdtemp(join(tmpdir(), "nitely-tmpdir-root-"));
    const target = await mkdtemp(join(root, "target-"));
    const link = join(root, "tmp-link");
    await symlink(target, link);
    const env: Record<string, string | undefined> = {
      TMPDIR: link,
      TMP: link,
      TEMP: link,
    };

    normalizeTempDirectoryEnvironment(env);

    const expected = await realpath(target);
    expect(env.TMPDIR).toBe(expected);
    expect(env.TMP).toBe(expected);
    expect(env.TEMP).toBe(expected);
  });
});
