import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { validateAttemptOutputs } from "../../src/run/attempt-outputs.js";

async function createAttempt() {
  const runDirectory = await mkdtemp(join(tmpdir(), "nitely-attempt-outputs-"));
  const attemptDirectory = join(runDirectory, "stages", "implement", "1");
  await mkdir(attemptDirectory, { recursive: true });
  return { runDirectory, attemptDirectory };
}

describe("validateAttemptOutputs", () => {
  it("discovers legacy text outputs and writes a synthesized manifest and summary", async () => {
    const { runDirectory, attemptDirectory } = await createAttempt();
    await writeFile(join(attemptDirectory, "implementation.md"), "# Done\n", "utf8");

    const result = await validateAttemptOutputs({
      runDirectory,
      attemptDirectory,
      stageId: "implement",
      attempt: 1,
      outputs: [{ id: "implementation" }],
    });

    expect(result.outputs).toEqual([
      expect.objectContaining({
        id: "implementation",
        attemptRelativePath: "implementation.md",
        runRelativePath: "stages/implement/1/implementation.md",
        mediaType: "text/markdown",
        manifestSource: "discovered",
      }),
    ]);
    expect(JSON.parse(await readFile(join(attemptDirectory, "artifact.json"), "utf8"))).toEqual({
      version: 1,
      stageId: "implement",
      attempt: 1,
      outputs: [
        {
          id: "implementation",
          path: "implementation.md",
          mediaType: "text/markdown",
        },
      ],
    });
    await expect(readFile(join(attemptDirectory, "output.md"), "utf8")).resolves.toContain(
      "- implementation: implementation.md (text/markdown)",
    );
  });

  it("validates an explicit manifest and infers json media type", async () => {
    const { runDirectory, attemptDirectory } = await createAttempt();
    await writeFile(join(attemptDirectory, "report.json"), "{\"ok\":true}\n", "utf8");
    await writeFile(
      join(attemptDirectory, "artifact.json"),
      JSON.stringify({
        version: 1,
        stageId: "implement",
        attempt: 1,
        outputs: [{ id: "implementation", path: "report.json" }],
      }),
      "utf8",
    );

    const result = await validateAttemptOutputs({
      runDirectory,
      attemptDirectory,
      stageId: "implement",
      attempt: 1,
      outputs: [{ id: "implementation" }],
    });

    expect(result.outputs).toEqual([
      expect.objectContaining({
        id: "implementation",
        attemptRelativePath: "report.json",
        mediaType: "application/json",
        manifestSource: "declared-manifest",
      }),
    ]);
  });

  it("rejects explicit manifest output paths that are symlinks outside the attempt directory", async () => {
    const { runDirectory, attemptDirectory } = await createAttempt();
    await writeFile(join(runDirectory, "outside.md"), "escaped\n", "utf8");
    await symlink(join(runDirectory, "outside.md"), join(attemptDirectory, "implementation.md"));
    await writeFile(
      join(attemptDirectory, "artifact.json"),
      JSON.stringify({
        version: 1,
        stageId: "implement",
        attempt: 1,
        outputs: [{ id: "implementation", path: "implementation.md" }],
      }),
      "utf8",
    );

    await expect(
      validateAttemptOutputs({
        runDirectory,
        attemptDirectory,
        stageId: "implement",
        attempt: 1,
        outputs: [{ id: "implementation" }],
      }),
    ).rejects.toThrow(/output implementation path escapes attempt directory/);
  });

  it("rejects discovered legacy output paths that are symlinks outside the attempt directory", async () => {
    const { runDirectory, attemptDirectory } = await createAttempt();
    await writeFile(join(runDirectory, "outside.md"), "escaped\n", "utf8");
    await symlink(join(runDirectory, "outside.md"), join(attemptDirectory, "implementation.md"));

    await expect(
      validateAttemptOutputs({
        runDirectory,
        attemptDirectory,
        stageId: "implement",
        attempt: 1,
        outputs: [{ id: "implementation" }],
      }),
    ).rejects.toThrow(/output implementation path escapes attempt directory/);
  });

  it("rejects missing required outputs", async () => {
    const { runDirectory, attemptDirectory } = await createAttempt();

    await expect(
      validateAttemptOutputs({
        runDirectory,
        attemptDirectory,
        stageId: "implement",
        attempt: 1,
        outputs: [{ id: "implementation" }],
      }),
    ).rejects.toThrow(/missing required output implementation/);
  });

  it("rejects undeclared manifest output ids", async () => {
    const { runDirectory, attemptDirectory } = await createAttempt();
    await writeFile(join(attemptDirectory, "extra.md"), "extra\n", "utf8");
    await writeFile(
      join(attemptDirectory, "artifact.json"),
      JSON.stringify({
        version: 1,
        stageId: "implement",
        attempt: 1,
        outputs: [{ id: "extra", path: "extra.md" }],
      }),
      "utf8",
    );

    await expect(
      validateAttemptOutputs({
        runDirectory,
        attemptDirectory,
        stageId: "implement",
        attempt: 1,
        outputs: [{ id: "implementation" }],
      }),
    ).rejects.toThrow(/undeclared output id extra/);
  });

  it("rejects manifest paths that escape the attempt directory", async () => {
    const { runDirectory, attemptDirectory } = await createAttempt();
    await writeFile(
      join(attemptDirectory, "artifact.json"),
      JSON.stringify({
        version: 1,
        stageId: "implement",
        attempt: 1,
        outputs: [{ id: "implementation", path: "../implementation.md" }],
      }),
      "utf8",
    );

    await expect(
      validateAttemptOutputs({
        runDirectory,
        attemptDirectory,
        stageId: "implement",
        attempt: 1,
        outputs: [{ id: "implementation" }],
      }),
    ).rejects.toThrow(/escapes attempt directory/);
  });

  it("rejects empty output files", async () => {
    const { runDirectory, attemptDirectory } = await createAttempt();
    await writeFile(join(attemptDirectory, "implementation.txt"), " \n\t", "utf8");

    await expect(
      validateAttemptOutputs({
        runDirectory,
        attemptDirectory,
        stageId: "implement",
        attempt: 1,
        outputs: [{ id: "implementation" }],
      }),
    ).rejects.toThrow(/output implementation is empty/);
  });
});
