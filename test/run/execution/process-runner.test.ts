import { describe, expect, it } from "vitest";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSandboxProcess } from "../../../src/run/execution/process-runner.js";

describe("runSandboxProcess", () => {
  it("captures stdout, stderr, and the process exit code", async () => {
    await expect(
      runSandboxProcess({
        command: "sh",
        args: ["-c", "printf out; printf err >&2; exit 7"],
        maxOutputBytes: 1024,
      }),
    ).resolves.toEqual({ stdout: "out", stderr: "err", exitCode: 7 });
  });

  it("terminates the process group and reports exit 124 after timeout", async () => {
    const result = await runSandboxProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 200)"],
      timeoutMs: 20,
      maxOutputBytes: 1024,
    });

    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("process timed out after 20ms");
  });

  it("rejects an aborted process with a stable abort code", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runSandboxProcess({
        command: "sh",
        args: ["-c", "echo should-not-run"],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      name: "AbortError",
      code: "ABORT_ERR",
    });
  });

  it("terminates a running process when its signal is aborted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    await expect(
      runSandboxProcess({
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 200)"],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
  });

  it("does not report abort completion until a TERM-resistant process is reaped", async () => {
    const controller = new AbortController();
    const directory = await mkdtemp(join(tmpdir(), "nitely-abort-reap-"));
    const ready = join(directory, "ready");
    const execution = runSandboxProcess({
      command: process.execPath,
      args: [
        "-e",
        `const fs=require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000)`,
      ],
      signal: controller.signal,
    });
    while (true) {
      try {
        await access(ready);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    const abortedAt = Date.now();
    controller.abort();

    await expect(
      execution,
    ).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });

    expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(90);
  });

  it("terminates execution when captured output exceeds the hard limit", async () => {
    await expect(
      runSandboxProcess({
        command: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(2048))"],
        maxOutputBytes: 32,
      }),
    ).rejects.toMatchObject({ code: "OUTPUT_LIMIT_EXCEEDED" });
  });
});
