import { spawn } from "node:child_process";

import type {
  SandboxProcessInput,
  SandboxProcessResult,
} from "./oci.js";

function processAbortError(): Error & { code: "ABORT_ERR" } {
  return Object.assign(new Error("sandbox process aborted"), {
    name: "AbortError",
    code: "ABORT_ERR" as const,
  });
}

function outputLimitError(limit: number): Error & {
  code: "OUTPUT_LIMIT_EXCEEDED";
} {
  return Object.assign(
    new Error(`sandbox process output exceeded ${limit} bytes`),
    { code: "OUTPUT_LIMIT_EXCEEDED" as const },
  );
}

export async function runSandboxProcess(
  input: SandboxProcessInput,
): Promise<SandboxProcessResult> {
  if (input.signal?.aborted) {
    throw processAbortError();
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stdoutCapture = input.stdoutCapture;
    let capturedBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    let terminalError: Error | undefined;
    let terminationStarted = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
    };
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall through to the direct child when the process group is gone.
        }
      }
      child.kill(signal);
    };
    const terminate = (error?: Error) => {
      terminalError ??= error;
      if (terminationStarted) return;
      terminationStarted = true;
      killGroup("SIGTERM");
      forceKillTimeout = setTimeout(() => killGroup("SIGKILL"), 100);
    };
    const abort = () => terminate(processAbortError());
    input.signal?.addEventListener("abort", abort, { once: true });
    const removeAbortListener = () =>
      input.signal?.removeEventListener("abort", abort);
    let stderrBytes = 0;
    const exceeded = () => {
      if (!outputExceeded && input.maxOutputBytes !== undefined) {
        outputExceeded = true;
        terminate(outputLimitError(input.maxOutputBytes));
      }
    };
    const capture = (target: Buffer[], chunk: Buffer) => {
      capturedBytes += chunk.byteLength;
      if (
        input.maxOutputBytes !== undefined &&
        capturedBytes > input.maxOutputBytes
      ) {
        exceeded();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (!stdoutCapture) {
        capture(stdout, chunk);
        return;
      }
      if (outputExceeded) return;
      stdoutCapture.write(chunk);
      if (
        input.maxOutputBytes !== undefined &&
        stdoutCapture.size() + stderrBytes > input.maxOutputBytes
      ) {
        exceeded();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (!stdoutCapture) {
        capture(stderr, chunk);
        return;
      }
      if (outputExceeded) return;
      stderrBytes += chunk.byteLength;
      if (
        input.maxOutputBytes !== undefined &&
        stdoutCapture.size() + stderrBytes > input.maxOutputBytes
      ) {
        exceeded();
        return;
      }
      stderr.push(chunk);
    });
    const captured = () => ({
      stdout: stdoutCapture ? stdoutCapture.text() : Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    });
    child.on("error", (error) => {
      clearTimers();
      removeAbortListener();
      reject(error);
    });
    if (input.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        stderr.push(
          Buffer.from(`process timed out after ${input.timeoutMs}ms\n`, "utf8"),
        );
        terminate();
      }, input.timeoutMs);
    }
    child.on("close", (code) => {
      clearTimers();
      removeAbortListener();
      if (terminalError) {
        // Keep what the process wrote before it was stopped: a cancelled or
        // capped agent still reported (and was billed for) model calls.
        reject(Object.assign(terminalError, captured()));
        return;
      }
      resolve({
        ...captured(),
        exitCode: timedOut ? 124 : code ?? 1,
      });
    });
    child.stdin.end(input.stdin);
  });
}
