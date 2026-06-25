import { realpathSync } from "node:fs";

const tempEnvKeys = ["TMPDIR", "TMP", "TEMP"] as const;

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
