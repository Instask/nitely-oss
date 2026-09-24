import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateAttemptOutputs } from "../../src/run/attempt-outputs.js";

const temporaryRunDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRunDirectories.splice(0).map(async (path) =>
      await rm(path, { recursive: true, force: true }),
    ),
  );
});

async function createAttempt() {
  const runDirectory = await mkdtemp(join(tmpdir(), "nitely-attempt-outputs-"));
  temporaryRunDirectories.push(runDirectory);
  const attemptDirectory = join(runDirectory, "stages", "implement", "1");
  await mkdir(attemptDirectory, { recursive: true });
  return { runDirectory, attemptDirectory };
}

describe("validateAttemptOutputs", () => {
  it("rejects artifact.json symlinks and non-regular files before reading them", async () => {
    const cases = ["symlink", "directory"] as const;

    for (const kind of cases) {
      const { runDirectory, attemptDirectory } = await createAttempt();
      await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
      const manifestPath = join(attemptDirectory, "artifact.json");
      const sentinelPath = join(runDirectory, `manifest-${kind}-sentinel.json`);
      const sentinel = `${JSON.stringify({
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
      })}\n`;
      await writeFile(sentinelPath, sentinel, "utf8");
      if (kind === "symlink") {
        await symlink(sentinelPath, manifestPath);
      } else {
        await mkdir(manifestPath);
      }

      await expect(
        validateAttemptOutputs({
          runDirectory,
          attemptDirectory,
          stageId: "implement",
          attempt: 1,
          outputs: [{ id: "implementation" }],
        }),
        kind,
      ).rejects.toThrow(
        /attempt output manifest path.*(?:symbolic link|regular file)/,
      );
      await expect(readFile(sentinelPath, "utf8")).resolves.toBe(sentinel);
    }
  });

  it("rejects non-regular adapter output files before reading them", async () => {
    const cases = ["symlink", "directory"] as const;

    for (const kind of cases) {
      const { runDirectory, attemptDirectory } = await createAttempt();
      const outputPath = join(attemptDirectory, "implementation.md");
      const sentinelPath = join(attemptDirectory, `implementation-${kind}-sentinel.md`);
      await writeFile(sentinelPath, "harmless sentinel\n", "utf8");
      if (kind === "symlink") {
        await symlink(sentinelPath, outputPath);
      } else {
        await mkdir(outputPath);
      }
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
        kind,
      ).rejects.toThrow(
        /output implementation path.*(?:symbolic link|regular file)/,
      );
      await expect(readFile(sentinelPath, "utf8")).resolves.toBe(
        "harmless sentinel\n",
      );
    }
  });

  it("rejects a non-regular existing output.md summary without following it", async () => {
    const cases = ["symlink", "directory"] as const;

    for (const kind of cases) {
      const { runDirectory, attemptDirectory } = await createAttempt();
      await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
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
      const summaryPath = join(attemptDirectory, "output.md");
      const sentinelPath = join(runDirectory, `summary-${kind}-sentinel.md`);
      await writeFile(sentinelPath, "harmless summary sentinel\n", "utf8");
      if (kind === "symlink") {
        await symlink(sentinelPath, summaryPath);
      } else {
        await mkdir(summaryPath);
      }

      await expect(
        validateAttemptOutputs({
          runDirectory,
          attemptDirectory,
          stageId: "implement",
          attempt: 1,
          outputs: [{ id: "implementation" }],
        }),
        kind,
      ).rejects.toThrow(
        /attempt output summary path.*(?:symbolic link|regular file)/,
      );
      await expect(readFile(sentinelPath, "utf8")).resolves.toBe(
        "harmless summary sentinel\n",
      );
    }
  });

  it("preserves an existing regular output.md summary", async () => {
    const { runDirectory, attemptDirectory } = await createAttempt();
    await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
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
    await writeFile(join(attemptDirectory, "output.md"), "existing summary\n", "utf8");

    await validateAttemptOutputs({
      runDirectory,
      attemptDirectory,
      stageId: "implement",
      attempt: 1,
      outputs: [{ id: "implementation" }],
    });

    await expect(readFile(join(attemptDirectory, "output.md"), "utf8")).resolves.toBe(
      "existing summary\n",
    );
  });

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

  it("fills a missing attempt and stageId from the runner", async () => {
    const { runDirectory, attemptDirectory } = await createAttempt();
    await writeFile(
      join(attemptDirectory, "task-plan.json"),
      '{"tasks":[{"id":"t1"}]}\n',
      "utf8",
    );
    await writeFile(
      join(attemptDirectory, "artifact.json"),
      JSON.stringify({
        version: 1,
        outputs: [{ id: "task-plan", path: "task-plan.json" }],
      }),
      "utf8",
    );

    const result = await validateAttemptOutputs({
      runDirectory,
      attemptDirectory,
      stageId: "implement",
      attempt: 1,
      outputs: [{ id: "task-plan" }],
    });

    expect(result.outputs).toEqual([
      expect.objectContaining({
        id: "task-plan",
        attemptRelativePath: "task-plan.json",
        mediaType: "application/json",
        manifestSource: "declared-manifest",
      }),
    ]);
    await expect(readFile(join(attemptDirectory, "output.md"), "utf8")).resolves.toContain(
      "Attempt: 1",
    );
  });

  it("lets the runner win over a manifest that contradicts stageId and attempt", async () => {
    const { runDirectory, attemptDirectory } = await createAttempt();
    await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
    await writeFile(
      join(attemptDirectory, "artifact.json"),
      JSON.stringify({
        version: 1,
        stageId: "review",
        attempt: 7,
        outputs: [{ id: "implementation", path: "implementation.md" }],
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
      expect.objectContaining({ id: "implementation", manifestSource: "declared-manifest" }),
    ]);
    const summary = await readFile(join(attemptDirectory, "output.md"), "utf8");
    expect(summary).toContain("Stage: implement");
    expect(summary).toContain("Attempt: 1");
  });

  it("still rejects a non-integer attempt and a non-string stageId", async () => {
    for (const [field, value] of [
      ["attempt", 1.5],
      ["stageId", 7],
    ] as const) {
      const { runDirectory, attemptDirectory } = await createAttempt();
      await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
      await writeFile(
        join(attemptDirectory, "artifact.json"),
        JSON.stringify({
          version: 1,
          [field]: value,
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
        field,
      ).rejects.toThrow(
        field === "attempt"
          ? "artifact.json attempt must be an integer"
          : "artifact.json stageId must be a string",
      );
    }
  });

  it("discovers a json output without any manifest", async () => {
    const { runDirectory, attemptDirectory } = await createAttempt();
    await writeFile(
      join(attemptDirectory, "task-plan.json"),
      '{"tasks":[{"id":"t1","title":"Do it"}]}\n',
      "utf8",
    );

    const result = await validateAttemptOutputs({
      runDirectory,
      attemptDirectory,
      stageId: "plan-tasks",
      attempt: 2,
      outputs: [{ id: "task-plan", mediaType: "application/json" }],
      validateContracts: true,
    });

    expect(result.outputs).toEqual([
      expect.objectContaining({
        id: "task-plan",
        attemptRelativePath: "task-plan.json",
        mediaType: "application/json",
        manifestSource: "discovered",
      }),
    ]);
    expect(
      JSON.parse(await readFile(join(attemptDirectory, "artifact.json"), "utf8")),
    ).toEqual({
      version: 1,
      stageId: "plan-tasks",
      attempt: 2,
      outputs: [
        { id: "task-plan", path: "task-plan.json", mediaType: "application/json" },
      ],
    });
  });

  it("prefers a markdown output over a json output of the same id", async () => {
    const { runDirectory, attemptDirectory } = await createAttempt();
    await writeFile(join(attemptDirectory, "implementation.md"), "# Done\n", "utf8");
    await writeFile(join(attemptDirectory, "implementation.json"), "{}\n", "utf8");

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
        mediaType: "text/markdown",
      }),
    ]);
  });

  it("still rejects a manifest path escape when attempt and stageId are omitted", async () => {
    const { runDirectory, attemptDirectory } = await createAttempt();
    await writeFile(join(runDirectory, "outside.md"), "escaped\n", "utf8");
    await writeFile(
      join(attemptDirectory, "artifact.json"),
      JSON.stringify({
        version: 1,
        outputs: [{ id: "implementation", path: "../../../outside.md" }],
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
    ).rejects.toThrow(/symbolic link|escapes attempt directory/i);
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
    ).rejects.toThrow(/symbolic link|escapes attempt directory/i);
  });

  it("rejects output files hard-linked outside the Run", async () => {
    const { runDirectory, attemptDirectory } = await createAttempt();
    const outsidePath = join(runDirectory, "..", "outside.md");
    await writeFile(outsidePath, "outside Run\n", "utf8");
    await link(outsidePath, join(attemptDirectory, "implementation.md"));
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
    ).rejects.toThrow(/hard link/i);
  });

  it("does not accept a symbolic-linked output summary", async () => {
    const { runDirectory, attemptDirectory } = await createAttempt();
    const outsidePath = join(runDirectory, "..", "outside-summary.md");
    await writeFile(outsidePath, "outside must survive\n", "utf8");
    await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
    await symlink(outsidePath, join(attemptDirectory, "output.md"));

    await expect(
      validateAttemptOutputs({
        runDirectory,
        attemptDirectory,
        stageId: "implement",
        attempt: 1,
        outputs: [{ id: "implementation" }],
      }),
    ).rejects.toThrow(/symbolic link/i);
    await expect(readFile(outsidePath, "utf8")).resolves.toBe(
      "outside must survive\n",
    );
  });

  it("does not accept a hard-linked output summary", async () => {
    const { runDirectory, attemptDirectory } = await createAttempt();
    const outsidePath = join(runDirectory, "..", "outside-summary.md");
    await writeFile(outsidePath, "outside must survive\n", "utf8");
    await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
    await link(outsidePath, join(attemptDirectory, "output.md"));

    await expect(
      validateAttemptOutputs({
        runDirectory,
        attemptDirectory,
        stageId: "implement",
        attempt: 1,
        outputs: [{ id: "implementation" }],
      }),
    ).rejects.toThrow(/hard link/i);
    await expect(readFile(outsidePath, "utf8")).resolves.toBe(
      "outside must survive\n",
    );
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

  it("rejects duplicate manifest output ids before validating files", async () => {
    const { runDirectory, attemptDirectory } = await createAttempt();
    await writeFile(join(attemptDirectory, "implementation.md"), "done\n", "utf8");
    await writeFile(
      join(attemptDirectory, "artifact.json"),
      JSON.stringify({
        version: 1,
        stageId: "implement",
        attempt: 1,
        outputs: [
          { id: "implementation", path: "implementation.md" },
          { id: "implementation", path: "implementation.md" },
        ],
      }),
      "utf8",
    );

    await expect(
      validateAttemptOutputs({
        runDirectory,
        attemptDirectory,
        stageId: "implement",
        attempt: 1,
        outputs: [{ id: "implementation", mediaType: "text/markdown" }],
        validateContracts: true,
      }),
    ).rejects.toThrow(/duplicate output id implementation/);
  });

  it("fails rich output media, JSON, and schema contracts closed", async () => {
    const cases = [
      {
        name: "media mismatch",
        filename: "report.txt",
        content: "plain text\n",
        entryMediaType: "text/plain",
        contract: { id: "report", mediaType: "text/markdown" },
        error: /media type text\/plain does not match text\/markdown/,
      },
      {
        name: "invalid JSON",
        filename: "report.json",
        content: "not-json\n",
        entryMediaType: "application/json",
        contract: { id: "report", mediaType: "application/json" },
        error: /output report is not valid JSON/,
      },
      {
        name: "schema mismatch",
        filename: "report.json",
        content: '{"ok":"yes"}\n',
        entryMediaType: "application/json",
        contract: {
          id: "report",
          mediaType: "application/json",
          schema: {
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
          },
        },
        error: /failed schema validation.*expected boolean, got string/,
      },
    ] as const;

    for (const testCase of cases) {
      const { runDirectory, attemptDirectory } = await createAttempt();
      await writeFile(
        join(attemptDirectory, testCase.filename),
        testCase.content,
        "utf8",
      );
      await writeFile(
        join(attemptDirectory, "artifact.json"),
        JSON.stringify({
          version: 1,
          stageId: "verify",
          attempt: 1,
          outputs: [
            {
              id: "report",
              path: testCase.filename,
              mediaType: testCase.entryMediaType,
            },
          ],
        }),
        "utf8",
      );

      await expect(
        validateAttemptOutputs({
          runDirectory,
          attemptDirectory,
          stageId: "verify",
          attempt: 1,
          outputs: [testCase.contract],
          validateContracts: true,
        }),
        testCase.name,
      ).rejects.toThrow(testCase.error);
    }
  });

  it("allows only the narrow single Markdown output.md fallback", async () => {
    const fallback = await createAttempt();
    await writeFile(join(fallback.attemptDirectory, "output.md"), "# Redacted command output\n", "utf8");
    const result = await validateAttemptOutputs({
      ...fallback,
      stageId: "verify",
      attempt: 1,
      outputs: [{ id: "verification", mediaType: "text/markdown" }],
      validateContracts: true,
      allowMarkdownFallback: true,
    });
    expect(result.outputs).toEqual([
      expect.objectContaining({
        id: "verification",
        attemptRelativePath: "output.md",
        mediaType: "text/markdown",
      }),
    ]);

    const forbiddenCases = [
      [
        { id: "first", mediaType: "text/markdown" },
        { id: "second", mediaType: "text/markdown" },
      ],
      [{ id: "report", mediaType: "application/json" }],
      [
        {
          id: "report",
          mediaType: "text/markdown",
          schema: { type: "object" },
        },
      ],
    ];
    for (const outputs of forbiddenCases) {
      const attempt = await createAttempt();
      await writeFile(join(attempt.attemptDirectory, "output.md"), "command output\n", "utf8");
      await expect(
        validateAttemptOutputs({
          ...attempt,
          stageId: "verify",
          attempt: 1,
          outputs,
          validateContracts: true,
          allowMarkdownFallback: true,
        }),
      ).rejects.toThrow(/missing required output/);
    }
  });

  it("does not discover Nitely-owned output.md as one member of a multi-output set", async () => {
    const { runDirectory, attemptDirectory } = await createAttempt();
    await writeFile(
      join(attemptDirectory, "output.md"),
      "# Nitely command attempt summary\n",
      "utf8",
    );
    await writeFile(join(attemptDirectory, "smoke.md"), "smoke passed\n", "utf8");

    await expect(
      validateAttemptOutputs({
        runDirectory,
        attemptDirectory,
        stageId: "release",
        attempt: 1,
        outputs: [
          { id: "output", mediaType: "text/markdown" },
          { id: "smoke", mediaType: "text/markdown" },
        ],
        validateContracts: true,
        allowMarkdownFallback: true,
      }),
    ).rejects.toThrow(/missing required output output/);
  });

  it("rejects explicit manifests that reference Nitely-owned output.md", async () => {
    const { runDirectory, attemptDirectory } = await createAttempt();
    await writeFile(
      join(attemptDirectory, "output.md"),
      "# Nitely command attempt summary\n",
      "utf8",
    );
    await writeFile(
      join(attemptDirectory, "artifact.json"),
      JSON.stringify({
        version: 1,
        stageId: "release",
        attempt: 1,
        outputs: [
          {
            id: "release-report",
            path: "./output.md",
            mediaType: "text/markdown",
          },
        ],
      }),
      "utf8",
    );

    await expect(
      validateAttemptOutputs({
        runDirectory,
        attemptDirectory,
        stageId: "release",
        attempt: 1,
        outputs: [
          { id: "release-report", mediaType: "text/markdown" },
        ],
        validateContracts: true,
        allowMarkdownFallback: true,
      }),
    ).rejects.toThrow(/explicit artifact\.json cannot reference reserved output\.md/);
  });

  it("rejects case-variant manifest paths that resolve to the physical output.md file", async () => {
    const { runDirectory, attemptDirectory } = await createAttempt();
    const reservedPath = join(attemptDirectory, "output.md");
    const caseVariantPath = join(attemptDirectory, "OUTPUT.md");
    await writeFile(reservedPath, "# Nitely command attempt summary\n", "utf8");
    await writeFile(
      join(attemptDirectory, "artifact.json"),
      JSON.stringify({
        version: 1,
        stageId: "release",
        attempt: 1,
        outputs: [
          {
            id: "release-report",
            path: "OUTPUT.md",
            mediaType: "text/markdown",
          },
        ],
      }),
      "utf8",
    );
    const validate = () =>
      validateAttemptOutputs({
        runDirectory,
        attemptDirectory,
        stageId: "release",
        attempt: 1,
        outputs: [
          { id: "release-report", mediaType: "text/markdown" },
        ],
        validateContracts: true,
        allowMarkdownFallback: true,
      });

    const caseVariantExists = await lstat(caseVariantPath)
      .then(() => true)
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      });
    if (!caseVariantExists) {
      // On a case-sensitive filesystem, a genuinely distinct uppercase file is
      // allowed; then replace it with a hardlink to exercise the same identity
      // invariant as Darwin's default case-insensitive filesystem.
      await writeFile(caseVariantPath, "case-sensitive adapter evidence\n", "utf8");
      await expect(validate()).resolves.toEqual(
        expect.objectContaining({
          outputs: [
            expect.objectContaining({
              id: "release-report",
              content: Buffer.from("case-sensitive adapter evidence\n", "utf8"),
            }),
          ],
        }),
      );
      await rm(caseVariantPath);
      await link(reservedPath, caseVariantPath);
    }

    await expect(validate()).rejects.toThrow(
      /explicit artifact\.json cannot reference reserved output\.md/,
    );
  });

  it("requires every declared output id to resolve to a distinct physical file", async () => {
    for (const aliasKind of ["same-path", "hardlink"] as const) {
      const { runDirectory, attemptDirectory } = await createAttempt();
      const firstPath = join(attemptDirectory, "first.md");
      const secondPath = join(attemptDirectory, "second.md");
      await writeFile(firstPath, "shared release evidence\n", "utf8");
      if (aliasKind === "hardlink") {
        await link(firstPath, secondPath);
      }
      await writeFile(
        join(attemptDirectory, "artifact.json"),
        JSON.stringify({
          version: 1,
          stageId: "release",
          attempt: 1,
          outputs: [
            { id: "release-report", path: "first.md" },
            {
              id: "smoke-report",
              path: aliasKind === "same-path" ? "first.md" : "second.md",
            },
          ],
        }),
        "utf8",
      );

      await expect(
        validateAttemptOutputs({
          runDirectory,
          attemptDirectory,
          stageId: "release",
          attempt: 1,
          outputs: [
            { id: "release-report", mediaType: "text/markdown" },
            { id: "smoke-report", mediaType: "text/markdown" },
          ],
          validateContracts: true,
        }),
        aliasKind,
      ).rejects.toThrow(/distinct physical file|hard link/i);
    }
  });
});
