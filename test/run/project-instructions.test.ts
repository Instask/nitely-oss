import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Stage } from "../../src/flow/schema.js";
import {
  loadProjectInstructions,
  projectInstructionGlobMatches,
  selectProjectInstructions,
} from "../../src/run/project-instructions.js";

async function createRepo(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "nitely-project-instructions-"));
}

async function writeInstructions(repoPath: string, value: string): Promise<void> {
  await mkdir(join(repoPath, ".nitely"), { recursive: true });
  await writeFile(join(repoPath, ".nitely", "instructions.json"), value, "utf8");
}

const agentStage = {
  id: "implement",
  type: "agent",
  runtime: "codex",
  prompt: "Implement.",
  inputs: ["spec"],
  outputs: ["implementation"],
} as Stage;

const reviewStage = {
  id: "review",
  type: "gate",
  mode: "review",
  runtime: "codex",
  prompt: "Review.",
  inputs: ["implementation"],
  outputs: ["review"],
} as Stage;

describe("loadProjectInstructions", () => {
  it("returns unloaded metadata when no instruction file exists", async () => {
    const repoPath = await createRepo();

    await expect(loadProjectInstructions(repoPath)).resolves.toEqual({
      loaded: false,
      path: ".nitely/instructions.json",
    });
  });

  it("treats an empty instruction file as unloaded", async () => {
    const repoPath = await createRepo();
    await writeInstructions(repoPath, "  \n");

    await expect(loadProjectInstructions(repoPath)).resolves.toEqual({
      loaded: false,
      path: ".nitely/instructions.json",
    });
  });

  it("loads instruction groups with a deterministic file hash", async () => {
    const repoPath = await createRepo();
    await writeInstructions(
      repoPath,
      JSON.stringify({
        version: 1,
        instructions: [
          {
            id: "frontend",
            title: "Frontend rules",
            appliesTo: "both",
            include: ["src/web/**"],
            exclude: ["src/web/**/*.test.ts"],
            text: "Keep UI copy short.",
          },
        ],
      }),
    );

    const loaded = await loadProjectInstructions(repoPath);

    expect(loaded.loaded).toBe(true);
    if (!loaded.loaded) return;
    expect(loaded.path).toBe(".nitely/instructions.json");
    expect(loaded.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(loaded.groups).toEqual([
      {
        id: "frontend",
        title: "Frontend rules",
        appliesTo: "both",
        include: ["src/web/**"],
        exclude: ["src/web/**/*.test.ts"],
        text: "Keep UI copy short.",
      },
    ]);
  });

  it("reports invalid instruction JSON and schema paths", async () => {
    const repoPath = await createRepo();
    await writeInstructions(repoPath, "{ bad json");
    await expect(loadProjectInstructions(repoPath)).rejects.toThrow(
      /invalid \.nitely\/instructions\.json: not valid JSON/,
    );

    await writeInstructions(
      repoPath,
      JSON.stringify({ version: 1, instructions: [{ id: "x" }] }),
    );
    await expect(loadProjectInstructions(repoPath)).rejects.toThrow(
      /instructions\.0\.text: Invalid input/,
    );
  });
});

describe("selectProjectInstructions", () => {
  it("matches include and exclude globs", () => {
    expect(projectInstructionGlobMatches("src/web/**", "src/web/dashboard.ts")).toBe(true);
    expect(projectInstructionGlobMatches("src/web/*.ts", "src/web/nested/a.ts")).toBe(false);
  });

  it("targets agent and review stages by stage type and candidate paths", async () => {
    const repoPath = await createRepo();
    await writeInstructions(
      repoPath,
      JSON.stringify({
        version: 1,
        instructions: [
          { id: "all", text: "Always apply." },
          {
            id: "specs",
            appliesTo: "agent",
            include: ["specs/**"],
            text: "Spec-scoped implementation rule.",
          },
          {
            id: "review-generated",
            appliesTo: "review",
            include: ["stages/implement/**"],
            text: "Review the generated implementation artifact.",
          },
          {
            id: "excluded",
            include: ["specs/**"],
            exclude: ["specs/private/**"],
            text: "Do not match excluded private specs.",
          },
        ],
      }),
    );
    const instructions = await loadProjectInstructions(repoPath);

    expect(
      selectProjectInstructions({
        instructions,
        stage: agentStage,
        candidatePaths: ["specs/change.md"],
      }).map((instruction) => instruction.id),
    ).toEqual(["all", "specs", "excluded"]);
    expect(
      selectProjectInstructions({
        instructions,
        stage: agentStage,
        candidatePaths: ["specs/private/change.md"],
      }).map((instruction) => instruction.id),
    ).toEqual(["all", "specs"]);
    expect(
      selectProjectInstructions({
        instructions,
        stage: reviewStage,
        candidatePaths: ["stages/implement/1/implementation.md"],
      }).map((instruction) => instruction.id),
    ).toEqual(["all", "review-generated"]);
  });
});
