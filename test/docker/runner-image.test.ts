import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = join(import.meta.dirname, "..", "..");
const buildScript = resolve(repositoryRoot, "docker/runner/build.sh");

async function readRunnerFile(name: string): Promise<string> {
  return await readFile(join(repositoryRoot, "docker", "runner", name), "utf8");
}

describe("nitely runner image", () => {
  it("ships a command baseline and an agent variant that installs nothing by default", async () => {
    const dockerfile = await readRunnerFile("Dockerfile");

    expect(dockerfile).toContain("AS command");
    expect(dockerfile).toContain("FROM command AS agent");
    expect(dockerfile).toContain("ARG AGENT_CLIS=\"\"");
    // A command stage is executed as `sh -c <command>`, so sh has to be there.
    expect(dockerfile).toContain('CMD ["sh"]');
    for (const tool of ["bash", "ca-certificates", "git"]) {
      expect(dockerfile).toContain(tool);
    }
  });

  it("lets an operator add apt packages the target repository's verification needs", async () => {
    const [dockerfile, buildScript_, readme] = await Promise.all([
      readRunnerFile("Dockerfile"),
      readRunnerFile("build.sh"),
      readRunnerFile("README.md"),
    ]);

    // Chromium for browser-backed tests is the motivating case: CI's
    // ubuntu-latest has a browser, the slim base image does not.
    expect(dockerfile).toContain('ARG EXTRA_APT_PACKAGES=""');
    expect(dockerfile).toMatch(/if \[ -n "\$\{EXTRA_APT_PACKAGES\}" \]; then/u);
    expect(buildScript_).toContain("--apt");
    expect(buildScript_).toContain("EXTRA_APT_PACKAGES=");
    expect(readme).toContain("--apt");
    expect(readme).toContain("chromium");

    const { stdout } = await execFileAsync("bash", [
      buildScript,
      "--print",
      "--variant",
      "agent",
      "--apt",
      "chromium fonts-liberation",
    ]);
    expect(stdout).toContain("EXTRA_APT_PACKAGES=chromium\\ fonts-liberation");
  });

  it("relocates every tool cache under the tmpfs the sandbox provides", async () => {
    const dockerfile = await readRunnerFile("Dockerfile");

    // Nitely runs the image read-only with HOME=/tmp/nitely-home, so a cache
    // left under / or /root makes the first install fail at run time.
    for (const variable of [
      "HOME=/tmp/nitely-home",
      "PNPM_HOME=/tmp/nitely-home",
      "XDG_CACHE_HOME=/tmp/nitely-home",
      "npm_config_cache=/tmp/nitely-home",
    ]) {
      expect(dockerfile).toContain(variable);
    }
    // Nitely already runs the container with --init and supplies the argv.
    expect(dockerfile).not.toMatch(/^ENTRYPOINT/mu);
  });

  it("keeps credentials out of the image and says why", async () => {
    const [dockerfile, readme] = await Promise.all([
      readRunnerFile("Dockerfile"),
      readRunnerFile("README.md"),
    ]);

    expect(dockerfile).toContain("Nothing here bakes a credential");
    // The agent target refuses to publish a baked agent credential file.
    expect(dockerfile).toContain("/root/.codex/auth.json");
    expect(dockerfile).toContain("refusing to publish an image containing");
    expect(readme).toContain("## No credentials in the image");
    expect(readme).toContain("NITELY_OCI_SECRET_ALLOWLIST");

    for (const source of [dockerfile, await readRunnerFile("build.sh")]) {
      expect(source).not.toMatch(/\b(?:sk-|ghp_|gho_)[A-Za-z0-9_-]{8,}/u);
    }
  });

  it("documents the allowlists and the egress an agent variant needs", async () => {
    const readme = await readRunnerFile("README.md");

    expect(readme).toContain("### Allowlist tips");
    expect(readme).toContain("NITELY_OCI_ENV_ALLOWLIST");
    expect(readme).toContain("NITELY_OCI_NETWORK_ALLOWLIST");
    expect(readme).toContain("carry **names**");
    expect(readme).toContain("HTTP CONNECT");
    expect(readme).toContain("Command stages need no egress");
    const flattened = readme.replace(/\s+/g, " ");
    expect(flattened).toContain("linked-worktree Git metadata is never mounted");
    expect(flattened).toContain(
      "Host-side workspace create/commit is the only Git write path",
    );
  });

  it("prints the build argv for each variant without invoking the engine", async () => {
    const command = await execFileAsync(buildScript, ["--print"]);
    expect(command.stdout).toContain("--target command");
    expect(command.stdout).toContain("--tag nitely-runner:local");
    expect(command.stdout).not.toContain("AGENT_CLIS");

    const agent = await execFileAsync(buildScript, [
      "--print",
      "--variant",
      "agent",
      "--agent-clis",
      "@openai/codex@latest",
    ]);
    expect(agent.stdout).toContain("--target agent");
    expect(agent.stdout).toContain("--tag nitely-runner-agent:local");
    expect(agent.stdout).toContain("AGENT_CLIS=@openai/codex@latest");
  });

  it("rejects an unknown variant and agent CLIs on the command variant", async () => {
    await expect(
      execFileAsync(buildScript, ["--variant", "sidecar"]),
    ).rejects.toMatchObject({
      code: 64,
      stderr: expect.stringContaining("invalid --variant sidecar"),
    });

    await expect(
      execFileAsync(buildScript, ["--agent-clis", "@openai/codex"]),
    ).rejects.toMatchObject({
      code: 64,
      stderr: expect.stringContaining("--agent-clis requires --variant agent"),
    });
  });

  it("verifies the image the way Nitely launches it", async () => {
    const script = await readRunnerFile("build.sh");

    expect(script).toContain("--read-only");
    expect(script).toContain("--network=none");
    expect(script).toContain("--tmpfs /tmp:rw,nosuid,nodev");
    expect(script).toContain("command -v sh");
    expect(script).toContain("pnpm --version");
  });
});
