import { describe, expect, it } from "vitest";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPiJsonCapture, readPiJsonStream } from "../../../src/run/execution/pi-json.js";
import { runSandboxProcess } from "../../../src/run/execution/process-runner.js";

const usage = (input: number, output: number, cost: number) => ({
  input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { total: cost },
});
/** A node script that prints Pi JSON records, then stays alive until killed. */
function piScript(records: unknown[], extra = "") {
  return `${records.map((record) => `process.stdout.write(${JSON.stringify(`${JSON.stringify(record)}\n`)});`).join("")}${extra} setInterval(() => {}, 1000);`;
}

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

  it("keeps the output an aborted process already wrote", async () => {
    const controller = new AbortController();
    const execution = runSandboxProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('partial out\\n'); process.stderr.write('partial err\\n'); setInterval(() => {}, 1000)"],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 150);
    await expect(execution).rejects.toMatchObject({
      code: "ABORT_ERR",
      stdout: "partial out\n",
      stderr: "partial err\n",
    });
  });

  it("keeps the output captured before the output limit stopped the process", async () => {
    await expect(
      runSandboxProcess({
        command: process.execPath,
        args: ["-e", "process.stdout.write('a'.repeat(16)); setTimeout(() => process.stdout.write('b'.repeat(2048)), 50); setInterval(() => {}, 1000)"],
        maxOutputBytes: 32,
      }),
    ).rejects.toMatchObject({ code: "OUTPUT_LIMIT_EXCEEDED", stdout: "a".repeat(16) });
  });

  it("caps a Pi capture by what it holds, so tool-output snapshots do not trip the limit", async () => {
    const snapshot = "x".repeat(50 * 1024);
    const records = [
      { type: "session", version: 3, id: "s", timestamp: "t", cwd: "/w" },
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: usage(100, 5, 0.001), stopReason: "stop" } },
      { type: "agent_end", messages: [{ role: "user", content: snapshot }], willRetry: false },
      { type: "agent_settled" },
    ];
    // 40 x 50 KB of tool snapshots: 2 MB of raw stream against a 256 KB cap.
    const snapshots = `for (let i = 0; i < 40; i++) process.stdout.write(JSON.stringify({type:"tool_execution_update",toolCallId:"c",toolName:"bash",args:{},partialResult:{content:[{type:"text",text:${JSON.stringify(snapshot)}}]}}) + "\\n");`;
    const result = await runSandboxProcess({
      command: process.execPath,
      args: ["-e", `${snapshots}${records.map((record) => `process.stdout.write(${JSON.stringify(`${JSON.stringify(record)}\n`)});`).join("")}`],
      maxOutputBytes: 256 * 1024,
      stdoutCapture: createPiJsonCapture(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeLessThan(1024);
    expect(readPiJsonStream(result.stdout)).toMatchObject({ text: "done\n", usage: { inputTokens: 100, outputTokens: 5 } });
  });

  it("returns a cancelled Pi run's partial usage through the capture", async () => {
    const controller = new AbortController();
    const execution = runSandboxProcess({
      command: process.execPath,
      args: ["-e", piScript([
        { type: "message_start", message: { role: "assistant", content: [] } },
        { type: "message_end", message: { role: "assistant", content: [], usage: usage(1000, 10, 0.01), stopReason: "toolUse" } },
        { type: "message_start", message: { role: "assistant", content: [] } },
        { type: "message_update", usage: usage(1200, 3, 0.012), assistantMessageEvent: { type: "text_delta", delta: "x" } },
      ])],
      signal: controller.signal,
      stdoutCapture: createPiJsonCapture(),
    });
    setTimeout(() => controller.abort(), 200);
    const error = await execution.then(() => undefined, (thrown: unknown) => thrown as { code: string; stdout: string });
    expect(error?.code).toBe("ABORT_ERR");
    expect(readPiJsonStream(error!.stdout).usage).toMatchObject({ inputTokens: 2200, outputTokens: 13, raw: { calls: 2 } });
  });
});
