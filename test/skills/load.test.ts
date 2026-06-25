import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadStageSkills } from "../../src/skills/load.js";

async function createRepo() {
  return await mkdtemp(join(tmpdir(), "nitely-skills-repo-"));
}

async function writeSkill(
  repo: string,
  id: string,
  content: string,
): Promise<void> {
  const directory = join(repo, ".nitely", "skills", id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), content, "utf8");
}

async function loadOne(repo: string, id: string) {
  return await loadStageSkills({
    repoPath: repo,
    runDirectory: join(repo, ".nitely", "runs", "run-skills"),
    stageId: "implement",
    skillIds: [id],
  });
}

describe("loadStageSkills", () => {
  it("parses a valid skill and computes a deterministic hash", async () => {
    const repo = await createRepo();
    await writeSkill(
      repo,
      "tdd",
      [
        "---",
        "name: tdd",
        "description: Write tests before implementation",
        "---",
        "",
        "Follow red-green-refactor.",
        "",
      ].join("\n"),
    );

    const [first] = await loadOne(repo, "tdd");
    const [second] = await loadOne(repo, "tdd");

    expect(first).toMatchObject({
      id: "tdd",
      name: "tdd",
      description: "Write tests before implementation",
      sourcePath: ".nitely/skills/tdd/SKILL.md",
      body: "Follow red-green-refactor.\n",
      resources: [],
    });
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.contentHash).toBe(first.contentHash);
  });

  it("rejects a missing SKILL.md with an actionable error", async () => {
    const repo = await createRepo();

    await expect(loadOne(repo, "missing")).rejects.toThrow(
      /unknown skill "missing": expected \.nitely\/skills\/missing\/SKILL\.md/,
    );
  });

  it("rejects malformed frontmatter", async () => {
    const repo = await createRepo();
    await writeSkill(repo, "bad", "name: bad\n---\nBody\n");

    await expect(loadOne(repo, "bad")).rejects.toThrow(
      /stage "implement" skill "bad": has malformed frontmatter/,
    );
  });

  it("rejects missing name frontmatter", async () => {
    const repo = await createRepo();
    await writeSkill(
      repo,
      "missing-name",
      "---\ndescription: Has description\n---\nBody\n",
    );

    await expect(loadOne(repo, "missing-name")).rejects.toThrow(
      /stage "implement" skill "missing-name": missing required frontmatter field: name/,
    );
  });

  it("rejects missing description frontmatter", async () => {
    const repo = await createRepo();
    await writeSkill(repo, "missing-description", "---\nname: missing-description\n---\nBody\n");

    await expect(loadOne(repo, "missing-description")).rejects.toThrow(
      /stage "implement" skill "missing-description": missing required frontmatter field: description/,
    );
  });

  it("rejects a frontmatter name mismatch", async () => {
    const repo = await createRepo();
    await writeSkill(
      repo,
      "expected",
      "---\nname: actual\ndescription: Has description\n---\nBody\n",
    );

    await expect(loadOne(repo, "expected")).rejects.toThrow(
      /stage "implement" skill "expected": name mismatch: expected "expected", found "actual"/,
    );
  });

  it("rejects an empty body", async () => {
    const repo = await createRepo();
    await writeSkill(repo, "empty", "---\nname: empty\ndescription: Has description\n---\n  \n");

    await expect(loadOne(repo, "empty")).rejects.toThrow(
      /stage "implement" skill "empty": body must not be empty/,
    );
  });

  it("rejects invalid skill ids", async () => {
    const repo = await createRepo();

    await expect(loadOne(repo, "../escape")).rejects.toThrow(
      /invalid skill id "\.\.\/escape"/,
    );
  });

  it("snapshots bundled resources under the run directory", async () => {
    const repo = await createRepo();
    await writeSkill(
      repo,
      "review",
      "---\nname: review\ndescription: Review checklist\n---\nUse the checklist.\n",
    );
    await mkdir(join(repo, ".nitely", "skills", "review", "docs"), {
      recursive: true,
    });
    await writeFile(
      join(repo, ".nitely", "skills", "review", "docs", "checklist.md"),
      "Check tests\n",
      "utf8",
    );

    const [skill] = await loadOne(repo, "review");

    expect(skill.resources).toEqual([
      expect.objectContaining({
        path: ".nitely/skills/review/docs/checklist.md",
        snapshotPath: ".nitely/runs/run-skills/skills/review/docs/checklist.md",
        mediaType: "text/markdown",
        sizeBytes: 12,
      }),
    ]);
    await expect(
      readFile(
        join(repo, ".nitely", "runs", "run-skills", "skills", "review", "docs", "checklist.md"),
        "utf8",
      ),
    ).resolves.toBe("Check tests\n");
    await expect(stat(join(repo, "docs", "checklist.md"))).rejects.toThrow();
  });

  it("rejects symlink bundled resources", async () => {
    const repo = await createRepo();
    await writeSkill(
      repo,
      "unsafe",
      "---\nname: unsafe\ndescription: Unsafe resources\n---\nUse resources.\n",
    );
    await writeFile(join(repo, "outside.txt"), "outside", "utf8");
    await symlink(
      join(repo, "outside.txt"),
      join(repo, ".nitely", "skills", "unsafe", "outside-link.txt"),
    );

    await expect(loadOne(repo, "unsafe")).rejects.toThrow(
      /stage "implement" skill "unsafe": resource is a symlink: \.nitely\/skills\/unsafe\/outside-link\.txt/,
    );
  });
});
