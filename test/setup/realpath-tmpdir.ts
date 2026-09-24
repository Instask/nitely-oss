import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempEnvKeys = ["TMPDIR", "TMP", "TEMP"] as const;

if (!process.env.NITELY_CONFIG_DIR) {
  process.env.NITELY_CONFIG_DIR = mkdtempSync(join(tmpdir(), "nitely-test-config-"));
}

export function normalizeTempDirectoryEnvironment(
  env: Record<string, string | undefined> = process.env,
): void {
  for (const key of tempEnvKeys) {
    const value = env[key];
    if (!value) {
      continue;
    }
    try {
      env[key] = realpathSync(value);
    } catch {
      // Leave invalid or unavailable temp directories unchanged so Vitest can
      // report the original environment problem.
    }
  }
}

normalizeTempDirectoryEnvironment();
