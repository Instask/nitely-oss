import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  decideMediatedExec,
  normalizeCommandMediationPolicy,
  type CommandMediationPolicy,
} from "../../../src/run/execution/command-mediation.js";

const mediator = join(
  import.meta.dirname,
  "../../../src/run/execution/command-mediator.py",
);
const linuxX64 = process.platform === "linux" && process.arch === "x64";

interface Fixture {
  mode?: CommandMediationPolicy["mode"];
  allow?: string[];
  deny?: string[];
  requestedPath: string;
  canonicalPath: string | null;
  args?: string[];
  interpreterPath?: string | null;
}

const fixtures: Fixture[] = [
  {
    allow: ["git"],
    requestedPath: "/usr/bin/git",
    canonicalPath: "/usr/bin/git",
    args: ["status"],
  },
  {
    allow: ["git"],
    requestedPath: "/tmp/git",
    canonicalPath: "/bin/rm",
    args: ["-rf"],
  },
  {
    allow: ["sh"],
    requestedPath: "/bin/sh",
    canonicalPath: "/usr/bin/dash",
    args: ["-c", "true"],
  },
  {
    allow: ["shebang.sh"],
    deny: ["touch"],
    requestedPath: "/workspace/shebang.sh",
    canonicalPath: "/workspace/shebang.sh",
    interpreterPath: "/usr/bin/touch",
  },
  {
    allow: ["git"],
    requestedPath: "",
    canonicalPath: null,
  },
  {
    mode: "deny-list",
    deny: ["touch"],
    requestedPath: "/usr/bin/touch",
    canonicalPath: "/usr/bin/touch",
    args: ["/tmp/x"],
  },
  {
    mode: "deny-list",
    deny: ["touch"],
    requestedPath: "/usr/bin/id",
    canonicalPath: "/usr/bin/id",
  },
  {
    mode: "none",
    requestedPath: "/bin/true",
    canonicalPath: "/bin/true",
  },
  {
    mode: "unrestricted",
    requestedPath: "/bin/rm",
    canonicalPath: "/bin/rm",
  },
  {
    allow: ["git"],
    requestedPath: "/tmp/script",
    canonicalPath: "/tmp/script",
    interpreterPath: "",
  },
];

function policyFor(fixture: Fixture): CommandMediationPolicy {
  return normalizeCommandMediationPolicy({
    mode: fixture.mode ?? "allow-list",
    allow: fixture.allow ?? [],
    deny: fixture.deny ?? [],
    advisory: false,
  });
}

async function decideWithPython(fixture: Fixture): Promise<Record<string, string>> {
  const policy = policyFor(fixture);
  const payload = JSON.stringify({
    policy,
    requestedPath: fixture.requestedPath,
    canonicalPath: fixture.canonicalPath,
    args: fixture.args ?? [],
    interpreterPath: fixture.interpreterPath ?? null,
  });
  const child = spawn("python3", [mediator, "--decide-only"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  child.stdin.end(payload);
  const code = await exited;
  if (code !== 0) {
    throw new Error(Buffer.concat(stderr).toString() || `decide-only exited ${code}`);
  }
  return JSON.parse(Buffer.concat(stdout).toString()) as Record<string, string>;
}

describe.skipIf(!linuxX64)("command mediator", () => {
  it("matches the TypeScript decision for every shared fixture", async () => {
    for (const fixture of fixtures) {
      const typescript = decideMediatedExec(policyFor(fixture), {
        requestedPath: fixture.requestedPath,
        canonicalPath: fixture.canonicalPath,
        args: fixture.args ?? [],
        ...(fixture.interpreterPath !== undefined
          ? { interpreterPath: fixture.interpreterPath }
          : {}),
      });
      const python = await decideWithPython(fixture);
      expect(python).toEqual(typescript);
    }
  });

  it("denies direct, shell, symlink, shebang, and interpreter execs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nitely-mediator-"));
    try {
      await symlink("/usr/bin/touch", join(directory, "fake-id"));
      const policy = {
        mode: "allow-list",
        allow: ["id", "dash", "python3.11", "shebang.sh"],
        deny: ["touch"],
        advisory: false,
        policyId: "commands/v1:mediator-test",
      };
      await writeFile(join(directory, "policy.json"), JSON.stringify(policy));
      const script = [
        "set +e",
        '/usr/bin/id > "$OUT/id.txt"; echo id:$?',
        '/usr/bin/touch "$OUT/touched"; echo touch:$?',
        '/bin/sh -c \'/usr/bin/touch "$OUT/touched-sh"\'; echo sh:$?',
        '"$OUT/fake-id" "$OUT/touched-link"; echo link:$?',
        "printf '#!/usr/bin/touch\\n' > \"$OUT/shebang.sh\"",
        '"$OUT/shebang.sh" "$OUT/touched-shebang"; echo shebang:$?',
        `python3 -c 'import os; os.execv("/usr/bin/touch", ["touch", "'"$OUT"'/touched-py"])'; echo py:$?`,
      ].join("\n");
      const result = await runMediator(directory, ["/bin/sh", "-c", script], {
        OUT: directory,
      });
      expect(result.stdout).toContain("id:0");
      expect(result.code).toBe(0);
      const evidence = await readFile(join(directory, "evidence.jsonl"), "utf8");
      expect(evidence).toContain('"program":"touch"');
      expect(evidence).toContain('"event":"supervisor-exit"');
      expect(evidence).not.toContain("touched-py");
      for (const name of [
        "touched",
        "touched-sh",
        "touched-link",
        "touched-shebang",
        "touched-py",
      ]) {
        await expect(readFile(join(directory, name), "utf8")).rejects.toThrow();
      }
      expect(await readFile(join(directory, "id.txt"), "utf8")).toContain("uid=");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("kills the workload when the supervisor is killed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nitely-mediator-crash-"));
    const policy = {
      mode: "deny-list",
      allow: [],
      deny: [],
      advisory: false,
      policyId: "commands/v1:crash",
    };
    await writeFile(join(directory, "policy.json"), JSON.stringify(policy));
    const child = spawn(
      "python3",
      [
        mediator,
        "--policy",
        join(directory, "policy.json"),
        "--evidence",
        join(directory, "evidence.jsonl"),
        "--",
        "/bin/sleep",
        "30",
      ],
      { stdio: "ignore" },
    );
    try {
      const sleepPid = await waitForSleep(child.pid!);
      child.kill("SIGKILL");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("mediator did not exit")), 3_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await processExists(sleepPid)).toBe(false);
    } finally {
      child.kill("SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function runMediator(
  directory: string,
  argv: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(
    "python3",
    [
      mediator,
      "--policy",
      join(directory, "policy.json"),
      "--evidence",
      join(directory, "evidence.jsonl"),
      "--",
      ...argv,
    ],
    { env: { ...process.env, ...env } },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("mediator timed out"));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      });
    });
  });
}

async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForSleep(parent: number): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const listing = await readFile("/proc/" + parent + "/task/" + parent + "/children", "utf8").catch(
      () => "",
    );
    for (const entry of listing.trim().split(/\s+/u)) {
      if (entry === "") continue;
      const pid = Number(entry);
      const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
      if (command.startsWith("/bin/sleep") || command.startsWith("sleep")) return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("sleep workload did not start");
}
