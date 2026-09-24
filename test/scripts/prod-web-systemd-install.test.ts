import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = resolve("scripts/nitely-prod-web-systemd-install");

async function fakeRemote(existingUnit: string) {
  const root = await mkdtemp(join(tmpdir(), "nitely-systemd-installer-"));
  const fakeBin = join(root, "fake-bin");
  const config = join(root, "config");
  const prodDir = join(root, "prod");
  const nodeBin = join(root, "node-bin");
  const restartScript = join(root, "bin", "restart-nitely");
  const unitDir = join(config, "systemd", "user");
  const unitPath = join(unitDir, "nitely-web.service");
  await Promise.all([
    mkdir(fakeBin, { recursive: true }),
    mkdir(join(prodDir, ".git"), { recursive: true }),
    mkdir(nodeBin, { recursive: true }),
    mkdir(unitDir, { recursive: true }),
  ]);
  await writeFile(join(fakeBin, "ssh"), [
    "#!/usr/bin/env bash",
    "shift",
    "exec \"$@\"",
    "",
  ].join("\n"));
  await writeFile(join(fakeBin, "systemctl"), [
    "#!/usr/bin/env bash",
    "unit_path=\"$XDG_CONFIG_HOME/systemd/user/nitely-web.service\"",
    "if [[ \"$*\" == *\"--property=FragmentPath --value\"* ]]; then printf '%s\\n' \"$unit_path\"; fi",
    "if [[ \"$*\" == *\"--property=DropInPaths --value\"* ]]; then",
    "  matches=(\"$unit_path.d\"/*.conf)",
    "  if [[ -e \"${matches[0]}\" ]]; then printf '%s\\n' \"${matches[*]}\"; fi",
    "fi",
    "if [[ \"$*\" == *\"--property=MainPID --value\"* ]]; then printf '4242\\n'; fi",
    "exit 0",
    "",
  ].join("\n"));
  await writeFile(join(nodeBin, "node"), "#!/usr/bin/env bash\nexit 0\n");
  await writeFile(unitPath, existingUnit);
  await Promise.all([
    chmod(join(fakeBin, "ssh"), 0o755),
    chmod(join(fakeBin, "systemctl"), 0o755),
    chmod(join(nodeBin, "node"), 0o755),
  ]);
  return {
    root,
    config,
    prodDir,
    nodeBin,
    restartScript,
    unitDir,
    unitPath,
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: config,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    },
  };
}

function remoteArgs(remote: Awaited<ReturnType<typeof fakeRemote>>): string[] {
  return [
    "--remote",
    "fake-remote",
    "--prod-dir",
    remote.prodDir,
    "--node-bin",
    remote.nodeBin,
    "--restart-script",
    remote.restartScript,
    "--no-start",
  ];
}

describe("production web systemd installer", () => {
  it("documents the managed unit options in help output", async () => {
    const { stdout } = await execFileAsync(script, ["--help"]);

    expect(stdout).toContain("--unit-name NAME");
    expect(stdout).toContain("--restart-script PATH");
    expect(stdout).toContain("--print-unit");
    expect(stdout).toContain("--trusted-proxy");
    expect(stdout).toContain("--replace-existing");
    expect(stdout).toContain("NITELY_PROD_WEB_UNIT");
  });

  it("renders the user-systemd unit without opening an SSH connection", async () => {
    const { stdout } = await execFileAsync(script, [
      "--print-unit",
      "--prod-dir",
      "/srv/nitely",
      "--node-bin",
      "/opt/node/bin",
      "--port",
      "4417",
      "--host",
      "127.0.0.1",
    ]);

    expect(stdout).toContain("[Unit]");
    expect(stdout).toContain("X-Nitely-Managed-Unit: production-web-v2");
    expect(stdout).toContain("Description=Nitely production Web");
    expect(stdout).toContain("WorkingDirectory=/srv/nitely");
    expect(stdout).toContain(
      "Environment=PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
    expect(stdout).toContain(
      "ExecStart=/opt/node/bin/node /srv/nitely/dist/index.js web --home /srv/nitely --host 127.0.0.1 --port 4417 --auth required",
    );
    expect(stdout).toContain("Environment=NITELY_WEB_AUTH=required");
    expect(stdout).not.toContain("NITELY_ADMIN_PASSWORD");
    expect(stdout).toContain("Restart=on-failure");
    expect(stdout).toContain("StandardOutput=append:/srv/nitely/.nitely/web.log");
  });

  it("defaults production rendering to an authenticated loopback bind", async () => {
    const { stdout } = await execFileAsync(script, ["--print-unit"]);

    expect(stdout).toContain("--host 127.0.0.1");
    expect(stdout).toContain("--auth required");
    expect(stdout).not.toContain("NITELY_WEB_TRUSTED_PROXY=true");
    expect(stdout).not.toContain("NITELY_WEB_SECURE_COOKIE=true");
  });

  it("rejects a network bind unless trusted-proxy mode is explicit", async () => {
    await expect(
      execFileAsync(script, ["--print-unit", "--host", "0.0.0.0"]),
    ).rejects.toMatchObject({
      code: 64,
      stderr: expect.stringContaining("--trusted-proxy"),
    });
    await expect(
      execFileAsync(script, ["--print-unit", "--host", "127.example.test"]),
    ).rejects.toMatchObject({
      code: 64,
      stderr: expect.stringContaining("--trusted-proxy"),
    });

    const { stdout } = await execFileAsync(script, [
      "--print-unit",
      "--host",
      "0.0.0.0",
      "--trusted-proxy",
    ]);
    expect(stdout).toContain("Environment=NITELY_WEB_TRUSTED_PROXY=true");
    expect(stdout).toContain("Environment=NITELY_WEB_SECURE_COOKIE=true");
  });

  it("rejects invalid ports before opening an SSH connection", async () => {
    try {
      await execFileAsync(script, ["--port", "web"]);
      throw new Error("expected systemd installer to reject invalid port");
    } catch (error) {
      const failure = error as Error & { code?: number; stderr?: string };
      expect(failure.code).toBe(64);
      expect(failure.stderr).toContain("invalid --port web");
    }
  });

  it("preserves an existing secure unit instead of replacing its effective configuration", async () => {
    const existing = [
      "[Service]",
      "Environment=NITELY_WEB_AUTH=required",
      "ExecStart=/opt/node/bin/node /srv/nitely/dist/index.js web --host 127.0.0.1 --auth required",
      "",
    ].join("\n");
    const remote = await fakeRemote(existing);

    const { stdout } = await execFileAsync(script, remoteArgs(remote), {
      env: remote.env,
    });

    expect(stdout).toContain("unit_action=preserved");
    expect(await readFile(remote.unitPath, "utf8")).toBe(existing);
  });

  it("refuses an insecure existing unit until replacement is explicit", async () => {
    const existing = [
      "[Service]",
      "Environment=NITELY_WEB_AUTH=local",
      "ExecStart=/opt/node/bin/node /srv/nitely/dist/index.js web --host 0.0.0.0",
      "",
    ].join("\n");
    const remote = await fakeRemote(existing);

    await expect(
      execFileAsync(script, remoteArgs(remote), { env: remote.env }),
    ).rejects.toMatchObject({
      code: 78,
      stderr: expect.stringMatching(/insecure existing.*--replace-existing/is),
    });
    expect(await readFile(remote.unitPath, "utf8")).toBe(existing);

    const { stdout } = await execFileAsync(
      script,
      [...remoteArgs(remote), "--replace-existing"],
      { env: remote.env },
    );
    expect(stdout).toContain("unit_action=replaced");
    expect(await readFile(remote.unitPath, "utf8")).toContain(
      "Environment=NITELY_WEB_AUTH=required",
    );
    expect(await readdir(remote.unitDir)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^nitely-web\.service\.bak\./),
      ]),
    );
  });

  it("preserves a network unit only when both proxy and secure-cookie controls are effective", async () => {
    const secure = await fakeRemote([
      "[Service]",
      "Environment=NITELY_WEB_AUTH=required",
      "Environment=NITELY_WEB_TRUSTED_PROXY=true",
      "Environment=NITELY_WEB_SECURE_COOKIE=true",
      "ExecStart=/opt/node/bin/node /srv/nitely/dist/index.js web --host 0.0.0.0 --auth required",
      "",
    ].join("\n"));
    await expect(
      execFileAsync(script, remoteArgs(secure), { env: secure.env }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining("unit_action=preserved"),
    });

    const missingCookie = await fakeRemote([
      "[Service]",
      "Environment=NITELY_WEB_AUTH=required",
      "Environment=NITELY_WEB_TRUSTED_PROXY=true",
      "ExecStart=/opt/node/bin/node /srv/nitely/dist/index.js web --host 0.0.0.0 --auth required",
      "",
    ].join("\n"));
    await expect(
      execFileAsync(script, remoteArgs(missingCookie), {
        env: missingCookie.env,
      }),
    ).rejects.toMatchObject({
      code: 78,
      stderr: expect.stringContaining("insecure existing"),
    });
  });

  it("does not accept an apparently secure unit when a drop-in can change its effective boundary", async () => {
    const existing = [
      "[Service]",
      "Environment=NITELY_WEB_AUTH=required",
      "ExecStart=/opt/node/bin/node /srv/nitely/dist/index.js web --host 127.0.0.1 --auth required",
      "",
    ].join("\n");
    const remote = await fakeRemote(existing);
    const dropInDir = `${remote.unitPath}.d`;
    await mkdir(dropInDir, { recursive: true });
    await writeFile(
      join(dropInDir, "override.conf"),
      "[Service]\nEnvironment=NITELY_WEB_AUTH=local\n",
    );

    await expect(
      execFileAsync(script, remoteArgs(remote), { env: remote.env }),
    ).rejects.toMatchObject({
      code: 78,
      stderr: expect.stringContaining("unclassifiable"),
    });

    await expect(
      execFileAsync(script, [...remoteArgs(remote), "--replace-existing"], {
        env: remote.env,
      }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining("unit_action=replaced"),
    });
    await expect(readFile(join(dropInDir, "override.conf"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects effective drop-ins outside the managed user unit even with replacement authorization", async () => {
    const existing = [
      "[Service]",
      "Environment=NITELY_WEB_AUTH=required",
      "ExecStart=/opt/node/bin/node /srv/nitely/dist/index.js web --host 127.0.0.1 --auth required",
      "",
    ].join("\n");
    const remote = await fakeRemote(existing);
    const systemctlPath = join(remote.root, "fake-bin", "systemctl");
    await writeFile(systemctlPath, [
      "#!/usr/bin/env bash",
      "unit_path=\"$XDG_CONFIG_HOME/systemd/user/nitely-web.service\"",
      "if [[ \"$*\" == *\"--property=FragmentPath --value\"* ]]; then printf '%s\\n' \"$unit_path\"; fi",
      "if [[ \"$*\" == *\"--property=DropInPaths --value\"* ]]; then printf '/etc/systemd/user/nitely-web.service.d/override.conf\\n'; fi",
      "exit 0",
      "",
    ].join("\n"));
    await chmod(systemctlPath, 0o755);

    await expect(
      execFileAsync(script, [...remoteArgs(remote), "--replace-existing"], {
        env: remote.env,
      }),
    ).rejects.toMatchObject({
      code: 78,
      stderr: expect.stringMatching(/external effective drop-in.*not replace/is),
    });
    expect(await readFile(remote.unitPath, "utf8")).toBe(existing);
  });
});
