export const CODEX_SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;

export type CodexSandboxMode = typeof CODEX_SANDBOX_MODES[number];

export interface RunSandboxPolicy {
  codex: CodexSandboxMode;
}

export function isCodexSandboxMode(value: unknown): value is CodexSandboxMode {
  return typeof value === "string" &&
    (CODEX_SANDBOX_MODES as readonly string[]).includes(value);
}

export function requireCodexSandboxMode(value: unknown): CodexSandboxMode {
  if (!isCodexSandboxMode(value)) {
    throw new Error(
      `unsupported Codex sandbox mode: ${String(value)}. Supported modes: ${CODEX_SANDBOX_MODES.join(", ")}`,
    );
  }
  return value;
}
