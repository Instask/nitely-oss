import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = resolve("scripts/nitely-prod-web-deploy");
const repositoryRoot = resolve(import.meta.dirname, "..", "..");

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd });
}

async function createFakeBin(root: string) {
  const fakeBin = join(root, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(
    join(fakeBin, "ssh"),
    ["#!/usr/bin/env bash", "shift", 'exec "$@"', ""].join("\n"),
  );
  await writeFile(
    join(fakeBin, "pnpm"),
    ["#!/usr/bin/env bash", "exit 0", ""].join("\n"),
  );
  await chmod(join(fakeBin, "ssh"), 0o755);
  await chmod(join(fakeBin, "pnpm"), 0o755);
  return fakeBin;
}

async function createRestartScript(root: string) {
  const restartScript = join(root, "restart-nitely");
  await writeFile(
    restartScript,
    ["#!/usr/bin/env bash", "exit 0", ""].join("\n"),
  );
  await chmod(restartScript, 0o755);
  return restartScript;
}

/**
 * Origin history: main has two commits (mainOldHead, mainHead); master
 * branches off main's first commit with its own commit (masterHead). This
 * lets tests distinguish which branch actually got deployed.
 */
async function createOriginRepo(root: string) {
  const originDir = join(root, "origin");
  await mkdir(originDir, { recursive: true });
  await git(originDir, ["init", "-q", "-b", "main"]);
  await git(originDir, ["config", "user.email", "deploy-test@example.com"]);
  await git(originDir, ["config", "user.name", "Deploy Test"]);

  await writeFile(join(originDir, "release.txt"), "main-v1\n");
  await git(originDir, ["add", "release.txt"]);
  await git(originDir, ["commit", "-q", "-m", "main v1"]);
  const mainOldHead = (
    await git(originDir, ["rev-parse", "HEAD"])
  ).stdout.trim();

  await writeFile(join(originDir, "release.txt"), "main-v2\n");
  await git(originDir, ["add", "release.txt"]);
  await git(originDir, ["commit", "-q", "-m", "main v2"]);
  const mainHead = (await git(originDir, ["rev-parse", "HEAD"])).stdout.trim();

  await git(originDir, ["checkout", "-q", "-b", "master", mainOldHead]);
  await writeFile(join(originDir, "release.txt"), "master-v1\n");
  await git(originDir, ["add", "release.txt"]);
  await git(originDir, ["commit", "-q", "-m", "master v1"]);
  const masterHead = (
    await git(originDir, ["rev-parse", "HEAD"])
  ).stdout.trim();

  await git(originDir, ["checkout", "-q", "main"]);

  return { originDir, mainOldHead, mainHead, masterHead };
}

/** Clones origin and resets local `main` to `mainOldHead`, one commit behind. */
async function createStaleProdCheckout(root: string, originDir: string, mainOldHead: string) {
  const prodDir = join(root, "prod");
  await execFileAsync("git", ["clone", "-q", originDir, prodDir]);
  await git(prodDir, ["checkout", "-q", "main"]);
  await git(prodDir, ["reset", "-q", "--hard", mainOldHead]);
  return prodDir;
}

async function setupDeployFixture() {
  const root = await mkdtemp(join(tmpdir(), "nitely-prod-web-deploy-"));
  const fakeBin = await createFakeBin(root);
  const restartScript = await createRestartScript(root);
  const { originDir, mainOldHead, mainHead, masterHead } =
    await createOriginRepo(root);
  const prodDir = await createStaleProdCheckout(root, originDir, mainOldHead);
  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    NITELY_DEPLOY_BRANCH: "",
  };
  return { root, prodDir, restartScript, mainOldHead, mainHead, masterHead, env };
}

describe("production deploy helper", () => {
  it("documents dirty remote worktree handling in help output", async () => {
    const { stdout } = await execFileAsync(script, ["--help"]);

    expect(stdout).toContain("--dirty-mode MODE");
    expect(stdout).toContain("--node-bin PATH");
    expect(stdout).toContain("Default: stash");
    expect(stdout).toContain("NITELY_DEPLOY_REMOTE");
    expect(stdout).toContain("NITELY_PROD_NODE_BIN");
  });

  it("documents main, not master, as the default --branch in help output", async () => {
    const { stdout } = await execFileAsync(script, ["--help"]);

    expect(stdout).toContain("--branch NAME");
    expect(stdout).toContain("Default: main");
    expect(stdout).not.toContain("Default: master");
  });

  it("rejects invalid dirty modes before opening an SSH connection", async () => {
    try {
      await execFileAsync(script, ["--dirty-mode", "overwrite"]);
      throw new Error("expected deploy helper to reject invalid dirty mode");
    } catch (error) {
      const failure = error as Error & { code?: number; stderr?: string };
      expect(failure.code).toBe(64);
      expect(failure.stderr).toContain("invalid --dirty-mode overwrite");
    }
  });

  it("requires the deployment target instead of assuming a host", async () => {
    try {
      await execFileAsync(script, [], {
        env: { ...process.env, NITELY_DEPLOY_REMOTE: "", NITELY_PROD_DIR: "" },
      });
      throw new Error("expected deploy helper to require --remote");
    } catch (error) {
      const failure = error as Error & { code?: number; stderr?: string };
      expect(failure.code).toBe(64);
      expect(failure.stderr).toContain("missing --remote");
    }
  });

  it("fetches and fast-forwards main by default when neither --branch nor NITELY_DEPLOY_BRANCH is given", async () => {
    const { prodDir, restartScript, mainHead, env } = await setupDeployFixture();

    const { stdout } = await execFileAsync(
      script,
      [
        "--remote",
        "fake-remote",
        "--prod-dir",
        prodDir,
        "--restart-script",
        restartScript,
      ],
      { env },
    );

    expect(stdout).toContain("target_branch=main");
    expect(stdout).not.toContain("target_branch=master");
    expect(stdout).toContain(`deployed_commit=${mainHead}`);

    const { stdout: headOut } = await git(prodDir, ["rev-parse", "HEAD"]);
    expect(headOut.trim()).toBe(mainHead);
    const { stdout: branchOut } = await git(prodDir, [
      "branch",
      "--show-current",
    ]);
    expect(branchOut.trim()).toBe("main");
  });

  it("still deploys master when --branch master is given explicitly", async () => {
    const { prodDir, restartScript, masterHead, env } =
      await setupDeployFixture();

    const { stdout } = await execFileAsync(
      script,
      [
        "--remote",
        "fake-remote",
        "--prod-dir",
        prodDir,
        "--restart-script",
        restartScript,
        "--branch",
        "master",
      ],
      { env },
    );

    expect(stdout).toContain("target_branch=master");
    expect(stdout).toContain(`deployed_commit=${masterHead}`);

    const { stdout: headOut } = await git(prodDir, ["rev-parse", "HEAD"]);
    expect(headOut.trim()).toBe(masterHead);
  });

  it("still deploys master when NITELY_DEPLOY_BRANCH=master is set explicitly", async () => {
    const { prodDir, restartScript, masterHead, env } =
      await setupDeployFixture();

    const { stdout } = await execFileAsync(
      script,
      [
        "--remote",
        "fake-remote",
        "--prod-dir",
        prodDir,
        "--restart-script",
        restartScript,
      ],
      { env: { ...env, NITELY_DEPLOY_BRANCH: "master" } },
    );

    expect(stdout).toContain("target_branch=master");
    expect(stdout).toContain(`deployed_commit=${masterHead}`);

    const { stdout: headOut } = await git(prodDir, ["rev-parse", "HEAD"]);
    expect(headOut.trim()).toBe(masterHead);
  });
});

describe("deployment docs branch references", () => {
  it("documents main, not master, as the branch the production checkout stays on and the helper deploys", async () => {
    const [en, zh] = await Promise.all([
      readFile(join(repositoryRoot, "docs", "deployment.md"), "utf8"),
      readFile(join(repositoryRoot, "docs", "deployment.zh-CN.md"), "utf8"),
    ]);

    expect(en).toContain("The deployed server should stay on `main`");
    expect(en).toContain("origin/main");
    expect(en).not.toContain("master");

    expect(zh).toContain("`main`");
    expect(zh).toContain("origin/main");
    expect(zh).not.toContain("master");
  });
});
