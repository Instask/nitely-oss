import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { loadFlow } from "../flow/load.js";
import { loadContextPolicy } from "../context/policy.js";

const execFileAsync = promisify(execFile);

export type PilotSetupStatus = "pass" | "warn" | "fail";

export interface PilotSetupCheck {
  id: string;
  label: string;
  status: PilotSetupStatus;
  detail: string;
  remediation?: string;
}

export interface PilotSetupCommandResult {
  stdout: string;
  stderr: string;
}

export type PilotSetupCommandRunner = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env: Record<string, string | undefined>;
  },
) => Promise<PilotSetupCommandResult>;

export interface GeneratePilotSetupReportInput {
  repoPath: string;
  flowPath: string;
  outputPath?: string;
  runtimes: string[];
  verifyCommands: string[];
  packageManager?: string;
  env?: Record<string, string | undefined>;
  now?: Date;
  commandRunner?: PilotSetupCommandRunner;
}

export interface PilotSetupReport {
  ready: boolean;
  checks: PilotSetupCheck[];
  markdown: string;
}

interface RuntimeRequirement {
  command: string;
  commandEnv?: string;
  versionArgs?: string[];
  requiredEnvGroups: string[][];
}

const runtimeRequirements: Record<string, RuntimeRequirement> = {
  codex: {
    command: "codex",
    commandEnv: "NITELY_CODEX_COMMAND",
    requiredEnvGroups: [],
  },
  claude: {
    command: "claude",
    commandEnv: "NITELY_CLAUDE_COMMAND",
    requiredEnvGroups: [["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]],
  },
  glm: {
    command: "glm",
    commandEnv: "NITELY_GLM_COMMAND",
    requiredEnvGroups: [["NITELY_GLM_API_KEY", "GLM_API_KEY", "ZHIPUAI_API_KEY"]],
  },
  grok: {
    command: "grok",
    commandEnv: "NITELY_GROK_COMMAND",
    versionArgs: ["version"],
    requiredEnvGroups: [],
  },
  pi: {
    command: "pi",
    commandEnv: "NITELY_PI_COMMAND",
    requiredEnvGroups: [],
  },
};

const packageManagerLocks: Array<{ name: string; path: string }> = [
  { name: "pnpm", path: "pnpm-lock.yaml" },
  { name: "npm", path: "package-lock.json" },
  { name: "yarn", path: "yarn.lock" },
  { name: "bun", path: "bun.lockb" },
];

async function defaultCommandRunner(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env: Record<string, string | undefined>;
  },
): Promise<PilotSetupCommandResult> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
  });
  return { stdout, stderr };
}

async function runCheckCommand(
  commandRunner: PilotSetupCommandRunner,
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env: Record<string, string | undefined>;
  },
): Promise<{ ok: true; output: string } | { ok: false; message: string }> {
  try {
    const result = await commandRunner(command, args, options);
    const output = `${result.stdout}\n${result.stderr}`.trim();
    return { ok: true, output };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function inferPackageManager(repoPath: string): Promise<string | undefined> {
  for (const candidate of packageManagerLocks) {
    if (await pathExists(join(repoPath, candidate.path))) {
      return candidate.name;
    }
  }
  return undefined;
}

function hasAnyEnv(
  env: Record<string, string | undefined>,
  names: string[],
): boolean {
  return names.some((name) => Boolean(env[name]));
}

function missingEnvMessage(groups: string[][]): string | undefined {
  const missing = groups.map((group) =>
    group.length === 1 ? group[0] : `one of ${group.join(", ")}`,
  );
  return missing.length > 0 ? `Set ${missing.join("; ")}.` : undefined;
}

function addCheck(checks: PilotSetupCheck[], check: PilotSetupCheck): void {
  checks.push(check);
}

function renderMarkdown(input: {
  generatedAt: Date;
  repoPath: string;
  flowName: string;
  flowPath: string;
  outputPath?: string;
  runtimes: string[];
  verifyCommands: string[];
  packageManager?: string;
  checks: PilotSetupCheck[];
}): string {
  const passCount = input.checks.filter((check) => check.status === "pass").length;
  const warnCount = input.checks.filter((check) => check.status === "warn").length;
  const failCount = input.checks.filter((check) => check.status === "fail").length;
  const ready = failCount === 0;
  const rows = input.checks.map((check) => {
    const remediation = check.remediation ?? "";
    return `| ${check.status} | ${check.label} | ${check.detail} | ${remediation} |`;
  });
  return [
    "# Customer-Hosted Runner Setup Report",
    "",
    `Generated: ${input.generatedAt.toISOString()}`,
    `Ready: **${ready ? "yes" : "no"}**`,
    `Repository: \`${input.repoPath}\``,
    `Flow: \`${input.flowName}\``,
    `Flow path: \`${input.flowPath}\``,
    input.outputPath ? `Report path: \`${input.outputPath}\`` : undefined,
    `Package manager: \`${input.packageManager ?? "not confirmed"}\``,
    `Runtimes checked: ${input.runtimes.map((runtime) => `\`${runtime}\``).join(", ") || "none"}`,
    "",
    "## Summary",
    "",
    `- Pass: ${passCount}`,
    `- Warn: ${warnCount}`,
    `- Fail: ${failCount}`,
    "",
    "## Checks",
    "",
    "| Status | Check | Detail | Remediation |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "## Credential And Data Boundaries",
    "",
    "- Repository source, worktrees, raw prompts, command logs, provider credentials, and generated artifacts stay in the customer environment by default.",
    "- GitHub publishing uses a customer-managed token or authenticated GitHub CLI; Nitely should not custody production credentials for the pilot.",
    "- Agent runtimes run as local customer-managed CLIs with credentials configured in the customer environment.",
    "",
    "## Setup Report Evidence",
    "",
    "- Attach this report to the pilot evidence before the first run.",
    "- Keep the report with local `.nitely` run state unless the customer explicitly allows upload.",
    "- Re-run the report when branch policy, credentials, runtimes, verification commands, or context policy changes.",
    "",
    "## Verification Commands",
    "",
    ...(input.verifyCommands.length > 0
      ? input.verifyCommands.map((command) => `- \`${command}\``)
      : ["- Not configured."]),
    "",
  ].filter((line): line is string => line !== undefined).join("\n");
}

export async function generatePilotSetupReport(
  input: GeneratePilotSetupReportInput,
): Promise<PilotSetupReport> {
  const repoPath = resolve(input.repoPath);
  const flowPath = resolve(repoPath, input.flowPath);
  const env = input.env ?? process.env;
  const commandRunner = input.commandRunner ?? defaultCommandRunner;
  const now = input.now ?? new Date();
  const checks: PilotSetupCheck[] = [];
  let flowName = "unknown";

  try {
    const flow = await loadFlow(flowPath);
    flowName = flow.flow.metadata.name;
    addCheck(checks, {
      id: "flow.load",
      label: "Flow",
      status: "pass",
      detail: `Flow loaded: ${flowName}`,
    });
  } catch (error) {
    addCheck(checks, {
      id: "flow.load",
      label: "Flow",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      remediation: "Fix the pilot flow file before the first run.",
    });
  }

  const node = await runCheckCommand(commandRunner, "node", ["--version"], { env });
  addCheck(checks, node.ok
    ? {
      id: "tool.node",
      label: "Node.js",
      status: "pass",
      detail: node.output || "node --version succeeded",
    }
    : {
      id: "tool.node",
      label: "Node.js",
      status: "fail",
      detail: node.message,
      remediation: "Install Node.js 24 or newer on the customer runner.",
    });

  const pnpm = await runCheckCommand(commandRunner, "pnpm", ["--version"], { env });
  addCheck(checks, pnpm.ok
    ? {
      id: "tool.pnpm",
      label: "pnpm",
      status: "pass",
      detail: pnpm.output || "pnpm --version succeeded",
    }
    : {
      id: "tool.pnpm",
      label: "pnpm",
      status: "fail",
      detail: pnpm.message,
      remediation: "Install pnpm 11 or confirm an alternate package manager.",
    });

  const git = await runCheckCommand(commandRunner, "git", ["--version"], { env });
  addCheck(checks, git.ok
    ? {
      id: "tool.git",
      label: "Git",
      status: "pass",
      detail: git.output || "git --version succeeded",
    }
    : {
      id: "tool.git",
      label: "Git",
      status: "fail",
      detail: git.message,
      remediation: "Install Git on the customer runner.",
    });

  try {
    await access(repoPath, constants.R_OK | constants.W_OK);
    addCheck(checks, {
      id: "repo.access",
      label: "Repository filesystem access",
      status: "pass",
      detail: "Repository path is readable and writable.",
    });
  } catch (error) {
    addCheck(checks, {
      id: "repo.access",
      label: "Repository filesystem access",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      remediation: "Run the report from a writable customer repository checkout.",
    });
  }

  const gitRoot = await runCheckCommand(
    commandRunner,
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd: repoPath, env },
  );
  addCheck(checks, gitRoot.ok
    ? {
      id: "repo.checkout",
      label: "Git checkout",
      status: "pass",
      detail: `Git worktree root: ${gitRoot.output}`,
    }
    : {
      id: "repo.checkout",
      label: "Git checkout",
      status: "fail",
      detail: gitRoot.message,
      remediation: "Use a real Git checkout for the target repository.",
    });

  const branch = await runCheckCommand(
    commandRunner,
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd: repoPath, env },
  );
  addCheck(checks, branch.ok
    ? {
      id: "repo.branch-policy",
      label: "Branch policy",
      status: branch.output === "HEAD" ? "warn" : "pass",
      detail: branch.output === "HEAD"
        ? "Repository is in detached HEAD state."
        : `Current branch: ${branch.output}`,
      remediation: branch.output === "HEAD"
        ? "Check out the pilot base branch and confirm PR branch policy."
        : "Confirm this base branch and PR policy with the customer owner.",
    }
    : {
      id: "repo.branch-policy",
      label: "Branch policy",
      status: "warn",
      detail: branch.message,
      remediation: "Confirm branch naming and draft PR policy before the first run.",
    });

  const packageManager = input.packageManager ?? await inferPackageManager(repoPath);
  addCheck(checks, packageManager
    ? {
      id: "package-manager",
      label: "Package manager",
      status: "pass",
      detail: `Package manager: ${packageManager}`,
    }
    : {
      id: "package-manager",
      label: "Package manager",
      status: "warn",
      detail: "Package manager was not inferred from a known lockfile.",
      remediation: "Pass --package-manager or document the install command in the pilot checklist.",
    });

  addCheck(checks, input.verifyCommands.length > 0
    ? {
      id: "verify-commands",
      label: "Verification commands",
      status: "pass",
      detail: input.verifyCommands.join("; "),
    }
    : {
      id: "verify-commands",
      label: "Verification commands",
      status: "fail",
      detail: "No verification commands were provided.",
      remediation: "Pass at least one --verify-command before the first pilot run.",
    });

  const githubHasToken = hasAnyEnv(env, ["NITELY_GITHUB_TOKEN", "GITHUB_TOKEN"]);
  if (githubHasToken) {
    addCheck(checks, {
      id: "github-publishing",
      label: "GitHub publishing",
      status: "pass",
      detail: "GitHub token environment variable is configured.",
    });
  } else {
    const gh = await runCheckCommand(commandRunner, "gh", ["auth", "status"], {
      cwd: repoPath,
      env,
    });
    addCheck(checks, gh.ok
      ? {
        id: "github-publishing",
        label: "GitHub publishing",
        status: "pass",
        detail: "GitHub CLI authentication is available.",
      }
      : {
        id: "github-publishing",
        label: "GitHub publishing",
        status: "fail",
        detail: "No NITELY_GITHUB_TOKEN/GITHUB_TOKEN and GitHub CLI auth check failed.",
        remediation: "Set a least-privilege GitHub token or authenticate gh for draft PR publishing.",
      });
  }

  for (const runtime of input.runtimes) {
    const requirement = runtimeRequirements[runtime];
    if (!requirement) {
      addCheck(checks, {
        id: `runtime.${runtime}`,
        label: `Runtime ${runtime}`,
        status: "fail",
        detail: `Unsupported runtime: ${runtime}`,
        remediation: "Use one of codex, claude, glm, grok, or pi for pilot setup checks.",
      });
      continue;
    }

    const missingGroups = requirement.requiredEnvGroups.filter((group) =>
      !hasAnyEnv(env, group),
    );
    if (missingGroups.length > 0) {
      addCheck(checks, {
        id: `runtime.${runtime}.credentials`,
        label: `Runtime ${runtime}`,
        status: "fail",
        detail: `Missing credentials for ${runtime}.`,
        remediation: missingEnvMessage(missingGroups),
      });
      continue;
    }

    const command = requirement.commandEnv && env[requirement.commandEnv]
      ? env[requirement.commandEnv] ?? requirement.command
      : requirement.command;
    const versionArgs = requirement.versionArgs ?? ["--version"];
    const version = await runCheckCommand(commandRunner, command, versionArgs, {
      cwd: repoPath,
      env,
    });
    addCheck(checks, version.ok
      ? {
        id: `runtime.${runtime}.command`,
        label: `Runtime ${runtime}`,
        status: "pass",
        detail: version.output || `${command} ${versionArgs.join(" ")} succeeded`,
      }
      : {
        id: `runtime.${runtime}.command`,
        label: `Runtime ${runtime}`,
        status: "fail",
        detail: version.message,
        remediation: `Install ${runtime} CLI or set ${requirement.commandEnv ?? `${runtime.toUpperCase()} command`} before the first run.`,
      });
  }

  try {
    await readFile(join(repoPath, "nitely.context.json"), "utf8");
    const policy = await loadContextPolicy(repoPath);
    addCheck(checks, {
      id: "context-policy",
      label: "Context policy",
      status: "pass",
      detail: `Context policy loaded with ${policy.include.length} include pattern(s), ${policy.exclude.length} exclude pattern(s), warnOnly=${policy.warnOnly}.`,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    addCheck(checks, code === "ENOENT"
      ? {
        id: "context-policy",
        label: "Context policy",
        status: "warn",
        detail: "nitely.context.json is missing; built-in secret excludes still apply.",
        remediation: "Add nitely.context.json for sensitive pilot repositories before the first run.",
      }
      : {
        id: "context-policy",
        label: "Context policy",
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
        remediation: "Fix nitely.context.json before running customer code.",
      });
  }

  const stateDir = join(repoPath, ".nitely");
  addCheck(checks, {
    id: "local-state-retention",
    label: "Local .nitely state",
    status: "warn",
    detail: `Local state and setup evidence should remain under ${stateDir}.`,
    remediation: "Confirm retention expectations and upload allow-list with the customer.",
  });

  const ready = checks.every((check) => check.status !== "fail");
  return {
    ready,
    checks,
    markdown: renderMarkdown({
      generatedAt: now,
      repoPath,
      flowName,
      flowPath,
      outputPath: input.outputPath,
      runtimes: input.runtimes,
      verifyCommands: input.verifyCommands,
      packageManager,
      checks,
    }),
  };
}

export function defaultPilotSetupReportPath(repoPath: string): string {
  return join(resolve(repoPath), ".nitely", "pilot-setup-report.md");
}
