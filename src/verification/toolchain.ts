import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PINNED_VERIFICATION_TOOLS = Object.freeze({
  codex: "0.162.0",
  claude: "2.1.300",
} as const);

export type VerificationTool = keyof typeof PINNED_VERIFICATION_TOOLS;

export interface VerifyPinnedCliInput {
  tool: string;
  executable: string;
}

export interface PinnedCliVerification {
  tool: VerificationTool;
  version: string;
  matched: true;
}

export class VerificationEnvironmentError extends Error {
  readonly code:
    | "VERIFICATION_CLI_MISSING"
    | "VERIFICATION_CLI_VERSION_MISMATCH"
    | "VERIFICATION_CLI_UNREADABLE";
  readonly tool: VerificationTool;
  readonly expectedVersion: string;
  readonly actualVersion?: string;

  constructor(input: {
    code: VerificationEnvironmentError["code"];
    tool: VerificationTool;
    expectedVersion: string;
    message: string;
    actualVersion?: string;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "VerificationEnvironmentError";
    this.code = input.code;
    this.tool = input.tool;
    this.expectedVersion = input.expectedVersion;
    this.actualVersion = input.actualVersion;
  }
}

function versionFromOutput(tool: VerificationTool, output: string): string | undefined {
  // Both CLIs print their semantic version on --version, but Claude may add a
  // product label and Codex may add a leading label in future releases.
  const match = output.match(/\b(\d+\.\d+\.\d+)\b/);
  if (!match) return undefined;
  return match[1];
}

export async function verifyPinnedCli(
  input: VerifyPinnedCliInput,
): Promise<PinnedCliVerification> {
  if (!(input.tool in PINNED_VERIFICATION_TOOLS)) {
    throw new TypeError(`unsupported verification CLI ${input.tool}`);
  }
  const tool = input.tool as VerificationTool;
  const expectedVersion = PINNED_VERIFICATION_TOOLS[tool];
  let stdout: string;
  let stderr: string;
  try {
    // --version is deliberately the only invocation: it does not authenticate,
    // contact a model, or consume a provider request.
    ({ stdout, stderr } = await execFileAsync(input.executable, ["--version"], {
      shell: false,
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    }));
  } catch (error) {
    const cause = error as NodeJS.ErrnoException;
    if (cause.code === "ENOENT") {
      throw new VerificationEnvironmentError({
        code: "VERIFICATION_CLI_MISSING",
        tool,
        expectedVersion,
        message: `${tool} ${expectedVersion} is missing at ${input.executable}; install the pinned verification CLI or set its executable path/PATH`,
        cause: error,
      });
    }
    throw new VerificationEnvironmentError({
      code: "VERIFICATION_CLI_UNREADABLE",
      tool,
      expectedVersion,
      message: `could not run ${tool} at ${input.executable} to verify pinned version ${expectedVersion}: ${cause.message ?? String(error)}`,
      cause: error,
    });
  }

  const actualVersion = versionFromOutput(tool, `${stdout}\n${stderr}`);
  if (!actualVersion || actualVersion !== expectedVersion) {
    throw new VerificationEnvironmentError({
      code: "VERIFICATION_CLI_VERSION_MISMATCH",
      tool,
      expectedVersion,
      actualVersion,
      message: `${tool} verification CLI version mismatch: expected ${expectedVersion}, found ${actualVersion ?? "unknown"} at ${input.executable}; install the pinned version`,
    });
  }

  return { tool, version: expectedVersion, matched: true };
}
