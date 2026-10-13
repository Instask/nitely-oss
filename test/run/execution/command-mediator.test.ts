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

  it("kills x32 syscall numbers in the seccomp program", async () => {
    const arch = 0xc000003e;
    const x32 = 0x40000000;
    expect(await seccompDecision(arch, 59)).toBe("TRACE");
    expect(await seccompDecision(arch, 322)).toBe("TRACE");
    expect(await seccompDecision(arch, 59 | x32)).toBe("KILL");
    expect(await seccompDecision(arch, 322 | x32)).toBe("KILL");
    expect(await seccompDecision(arch, x32)).toBe("KILL");
    expect(await seccompDecision(arch, 0)).toBe("ALLOW");
    expect(await seccompDecision(0x40000003, 59)).toBe("KILL");
  });

  it("stops sibling threads before an exec is allowed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nitely-mediator-threads-"));
    try {
      const good = join(directory, "goodbin");
      const bad = join(directory, "badbin");
      const goodMarker = join(directory, "good-ran");
      const badMarker = join(directory, "bad-ran");
      await compileMarker(good, goodMarker);
      await compileMarker(bad, badMarker);
      const racer = join(directory, "racer");
      await compile(racer, threadRacerSource());
      await writePolicy(directory, ["goodbin"], ["badbin"]);
      let sawGood = false;
      for (let attempt = 0; attempt < 4 && !sawGood; attempt += 1) {
        const result = await runMediator(directory, [racer, good, bad], {}, 20_000);
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        sawGood = await readFile(goodMarker, "utf8").then(() => true, () => false);
      }
      expect(sawGood).toBe(true);
      await expect(readFile(badMarker, "utf8")).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("executes the inode it checked when a symlink is replaced concurrently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nitely-mediator-symlink-"));
    const link = join(directory, "tool");
    try {
      const good = join(directory, "goodbin");
      const bad = join(directory, "badbin");
      const goodMarker = join(directory, "good-ran");
      const badMarker = join(directory, "bad-ran");
      await compileMarker(good, goodMarker);
      await compileMarker(bad, badMarker);
      await symlink(good, link);
      const loop = join(directory, "loopbin");
      await compile(loop, symlinkLoopSource());
      await writePolicy(directory, ["goodbin"], ["badbin"]);
      const swapper = spawn("python3", ["-c", swapperSource(), link, good, bad], {
        stdio: "ignore",
      });
      try {
        const result = await runMediator(directory, [loop, link], {}, 30_000);
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        await expect(readFile(goodMarker, "utf8")).resolves.toContain("1");
        await expect(readFile(badMarker, "utf8")).rejects.toThrow();
      } finally {
        swapper.kill("SIGKILL");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function runMediator(
  directory: string,
  argv: string[],
  env: Record<string, string>,
  timeoutMs = 15_000,
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
    }, timeoutMs);
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

function seccompDecision(arch: number, number: number): Promise<string> {
  const child = spawn("python3", [
    mediator,
    "--seccomp-decision",
    `0x${arch.toString(16)}`,
    `0x${number.toString(16)}`,
  ]);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString() || `seccomp decision exited ${code}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString().trim());
    });
  });
}

async function writePolicy(
  directory: string,
  allow: string[],
  deny: string[],
): Promise<void> {
  await writeFile(join(directory, "policy.json"), JSON.stringify({
    mode: "allow-list",
    allow,
    deny,
    advisory: false,
    policyId: "commands/v1:mediator-race",
  }));
}

function compile(output: string, source: string): Promise<void> {
  const child = spawn("gcc", ["-O2", "-pthread", "-x", "c", "-o", output, "-"], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  child.stdin.end(source);
  return exited.then((code) => {
    if (code !== 0) {
      throw new Error(Buffer.concat(stderr).toString() || `gcc exited ${code}`);
    }
  });
}

function compileMarker(output: string, marker: string): Promise<void> {
  return compile(output, `#include <fcntl.h>
#include <unistd.h>
int main(void) {
  int fd = open(${JSON.stringify(marker)}, O_CREAT | O_WRONLY | O_APPEND, 0644);
  if (fd < 0) return 1;
  if (write(fd, "1", 1) != 1) return 1;
  close(fd);
  return 0;
}
`);
}

function threadRacerSource(): string {
  return `#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <string.h>
#include <unistd.h>
static char pathbuf[4096];
static char *bad_path;
static void *mutate(void *unused) {
  (void)unused;
  size_t n = strlen(bad_path);
  for (;;) {
    memcpy(pathbuf, bad_path, n + 1);
    usleep(1000);
  }
  return NULL;
}
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  bad_path = argv[2];
  pthread_t thread;
  if (pthread_create(&thread, NULL, mutate, NULL) != 0) return 2;
  for (int i = 0; i < 80; i++) {
    size_t n = strlen(argv[1]);
    memcpy(pathbuf, argv[1], n + 1);
    char *args[] = {pathbuf, NULL};
    execve(pathbuf, args, environ);
    if (errno != EPERM) return 3;
  }
  return 0;
}
`;
}

function symlinkLoopSource(): string {
  return `#define _GNU_SOURCE
#include <errno.h>
#include <sys/wait.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  for (int i = 0; i < 40; i++) {
    pid_t child = fork();
    if (child < 0) return 2;
    if (child == 0) {
      char *args[] = {argv[1], NULL};
      execve(argv[1], args, environ);
      _exit(errno == EPERM ? 0 : 4);
    }
    int status = 0;
    if (waitpid(child, &status, 0) < 0) return 2;
  }
  return 0;
}
`;
}

function swapperSource(): string {
  return `import os, sys
link, good, bad = sys.argv[1:]
while True:
    for target in (good, bad):
        nxt = link + ".next"
        try:
            os.unlink(nxt)
        except FileNotFoundError:
            pass
        os.symlink(target, nxt)
        os.replace(nxt, link)
`;
}
