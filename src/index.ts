#!/usr/bin/env node
import { runCli } from "./cli.js";

try {
  process.exitCode = await runCli(process.argv.slice(2), {
    stdout: console.log,
    stderr: console.error,
  });
} catch (error) {
  // Print the cause, not a Node stack trace; NITELY_DEBUG=1 keeps the stack.
  console.error(
    process.env.NITELY_DEBUG === "1" || !(error instanceof Error)
      ? error
      : `nitely: ${error.message}`,
  );
  process.exitCode = 1;
}
