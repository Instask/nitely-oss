import { basename } from "node:path";

import type { AgentCapabilityPolicy } from "../../flow/schema.js";

export type CommandMediationMode = AgentCapabilityPolicy["commands"]["mode"];

/**
 * An agent stage's command allow/deny policy, normalized for matching and for
 * evidence. Entries are argv patterns, never values: `policyId` and every
 * description built from this carry rule names only.
 */
export interface CommandMediationPolicy {
  readonly mode: CommandMediationMode;
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  /**
   * `true` states the policy to the agent and records it. `false` demands
   * byte-level enforcement and fails closed when no mechanism provides it.
   */
  readonly advisory: boolean;
  /** Stable identifier for evidence. Rule names only, no argv, no values. */
  readonly policyId: string;
}

export interface CommandDecision {
  readonly decision: "allow" | "deny";
  /** The rule that decided, when a rule rather than the mode decided. */
  readonly rule?: string;
  readonly reason: string;
}

/**
 * A backend-supplied way to enforce the policy on the commands an agent spawns
 * for itself. The OCI backend registers `oci-ptrace-seccomp` for this. A
 * mechanism that cannot actually supervise those commands must not report
 * support: the backend refuses to launch rather than downgrade to a prompt.
 */
export interface CommandMediationMechanism {
  readonly id: string;
  supports(policy: CommandMediationPolicy): boolean;
}

export type CommandMediationOutcome =
  /** `unrestricted`: the stage asked for no mediation. */
  | { readonly status: "unmediated"; readonly policy: CommandMediationPolicy }
  /** A mechanism covers the commands the agent spawns for itself. */
  | {
      readonly status: "enforced";
      readonly policy: CommandMediationPolicy;
      readonly mechanism: string;
    }
  /** Advisory: the policy is stated to the agent and recorded, not enforced. */
  | {
      readonly status: "stated";
      readonly policy: CommandMediationPolicy;
      readonly reason: string;
    }
  /** Enforcement was demanded and is unavailable. The stage must not run. */
  | {
      readonly status: "unenforceable";
      readonly policy: CommandMediationPolicy;
      readonly reason: string;
    };

function normalizeEntries(entries: readonly string[]): string[] {
  return [
    ...new Set(entries.map((entry) => entry.trim()).filter((entry) => entry !== "")),
  ].sort();
}

function ruleList(entries: readonly string[]): string {
  return entries.length > 0 ? entries.join(",") : "none";
}

export function normalizeCommandMediationPolicy(
  commands: AgentCapabilityPolicy["commands"],
): CommandMediationPolicy {
  const allow = normalizeEntries(commands.allow);
  const deny = normalizeEntries(commands.deny);
  return {
    mode: commands.mode,
    allow,
    deny,
    advisory: commands.advisory,
    policyId: `commands/v1:${commands.mode}:${
      commands.advisory ? "advisory" : "enforced"
    }:allow(${ruleList(allow)}):deny(${ruleList(deny)})`,
  };
}

function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split("")
    .map((character) => {
      if (character === "*") return ".*";
      if (character === "?") return ".";
      return character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`, "u");
}

function commandLines(argv: readonly string[]): string[] {
  const [program, ...rest] = argv;
  if (program === undefined) return [];
  const lines = [[program, ...rest].join(" ")];
  const program0 = basename(program);
  if (program0 !== program) lines.push([program0, ...rest].join(" "));
  return lines;
}

/**
 * A rule is either a bare program name (`git`), an explicit path (`/bin/git`),
 * or an argv pattern with `*`/`?` wildcards (`git push*`, `rm -rf *`). Bare
 * names match the program regardless of the directory it was resolved from;
 * patterns match the whole command line, with and without that directory.
 */
export function commandRuleMatches(
  rule: string,
  argv: readonly string[],
): boolean {
  const program = argv[0];
  if (program === undefined) return false;
  const trimmed = rule.trim();
  if (trimmed === "") return false;
  if (!/[\s*?]/u.test(trimmed)) {
    return trimmed.includes("/")
      ? program === trimmed
      : program === trimmed || basename(program) === trimmed;
  }
  const expression = globToRegExp(trimmed);
  return commandLines(argv).some((line) => expression.test(line));
}

export interface MediatedExec {
  /** Path string passed to execve or execveat. Empty when the kernel gave none. */
  readonly requestedPath: string;
  /**
   * Canonical path in the tracee's mount namespace. Null when the path cannot
   * be resolved, including memfd, AT_EMPTY_PATH, and a symlink loop.
   */
  readonly canonicalPath: string | null;
  /** Arguments after the program slot. The tracee's argv[0] is ignored. */
  readonly args: readonly string[];
  /**
   * Canonical interpreter of a shebang, when the file is a script. An empty
   * string means a shebang was present and its interpreter could not be
   * trusted. Omit it when the file has no shebang.
   */
  readonly interpreterPath?: string | null;
}

/**
 * Decide an exec the mediator actually observed. Allow-list matches only the
 * resolved file, so a symlink whose basename is allowed and whose target is
 * not stays denied. Deny matches either the requested path or the resolved
 * file. A shebang runs its interpreter inside that same exec, so the
 * interpreter has to pass the same policy.
 */
export function decideMediatedExec(
  policy: CommandMediationPolicy,
  exec: MediatedExec,
): CommandDecision {
  if (policy.mode === "unrestricted") {
    return { decision: "allow", reason: "command mode unrestricted" };
  }
  if (
    exec.canonicalPath === null ||
    !exec.canonicalPath.startsWith("/") ||
    exec.canonicalPath.trim() === ""
  ) {
    return { decision: "deny", reason: "executable path could not be resolved" };
  }
  if (exec.interpreterPath === "") {
    return { decision: "deny", reason: "shebang interpreter denied" };
  }
  const canonicalArgv = [exec.canonicalPath, ...exec.args];
  const requestedArgv =
    exec.requestedPath === ""
      ? canonicalArgv
      : [exec.requestedPath, ...exec.args];
  const views =
    requestedArgv[0] === canonicalArgv[0]
      ? [canonicalArgv]
      : [canonicalArgv, requestedArgv];
  for (const argv of views) {
    const denyRule = policy.deny.find((rule) => commandRuleMatches(rule, argv));
    if (denyRule) {
      return {
        decision: "deny",
        rule: denyRule,
        reason: `denied by deny rule ${denyRule}`,
      };
    }
  }
  if (policy.mode === "none") {
    return { decision: "deny", reason: "command mode none forbids every command" };
  }
  const interpreterDenial = (): CommandDecision | undefined => {
    if (exec.interpreterPath === undefined || exec.interpreterPath === null) {
      return undefined;
    }
    const interpreter = decideMediatedExec(policy, {
      requestedPath: exec.interpreterPath,
      canonicalPath: exec.interpreterPath,
      args: [],
    });
    if (interpreter.decision === "allow") return undefined;
    return interpreter.rule
      ? {
          decision: "deny",
          rule: interpreter.rule,
          reason: `shebang interpreter denied by rule ${interpreter.rule}`,
        }
      : { decision: "deny", reason: "shebang interpreter denied" };
  };
  if (policy.mode === "deny-list") {
    return interpreterDenial() ?? { decision: "allow", reason: "no deny rule matched" };
  }
  const allowRule = policy.allow.find((rule) =>
    commandRuleMatches(rule, canonicalArgv),
  );
  if (!allowRule) {
    return {
      decision: "deny",
      reason: "no allow rule matched the resolved executable",
    };
  }
  return (
    interpreterDenial() ?? {
      decision: "allow",
      rule: allowRule,
      reason: `allowed by allow rule ${allowRule}`,
    }
  );
}

export function decideCommand(
  policy: CommandMediationPolicy,
  argv: readonly string[],
): CommandDecision {
  if (policy.mode === "unrestricted") {
    return { decision: "allow", reason: "command mode unrestricted" };
  }
  if (argv.length === 0 || argv[0] === undefined || argv[0].trim() === "") {
    return { decision: "deny", reason: "command has no program" };
  }
  const denyRule = policy.deny.find((rule) => commandRuleMatches(rule, argv));
  if (denyRule) {
    return {
      decision: "deny",
      rule: denyRule,
      reason: `denied by deny rule ${denyRule}`,
    };
  }
  if (policy.mode === "none") {
    return { decision: "deny", reason: "command mode none forbids every command" };
  }
  if (policy.mode === "deny-list") {
    return { decision: "allow", reason: "no deny rule matched" };
  }
  const allowRule = policy.allow.find((rule) => commandRuleMatches(rule, argv));
  return allowRule
    ? {
        decision: "allow",
        rule: allowRule,
        reason: `allowed by allow rule ${allowRule}`,
      }
    : { decision: "deny", reason: "no allow rule matched" };
}

/**
 * Decide how a boundary should treat the policy before any workload starts.
 * `boundary` names the enforcement surface in the failure text, so an operator
 * reading it knows which backend could not honor the stage's demand.
 */
export function resolveCommandMediation(input: {
  policy: CommandMediationPolicy;
  boundary: string;
  mechanism?: CommandMediationMechanism;
}): CommandMediationOutcome {
  const { policy, boundary, mechanism } = input;
  if (policy.mode === "unrestricted") {
    return { status: "unmediated", policy };
  }
  if (mechanism?.supports(policy)) {
    return { status: "enforced", policy, mechanism: mechanism.id };
  }
  const reason = `${boundary} has no mechanism that mediates the commands an agent spawns inside it`;
  if (policy.advisory) {
    return { status: "stated", policy, reason };
  }
  return {
    status: "unenforceable",
    policy,
    reason: `${reason}; the stage declares capabilities.commands.mode ${policy.mode} with advisory false, which demands enforcement. Set advisory true to accept a stated policy, use mode unrestricted, or run the stage on a backend that registers a command mediation mechanism`,
  };
}

export function commandMediationError(
  stageId: string,
  outcome: Extract<CommandMediationOutcome, { status: "unenforceable" }>,
): Error {
  return new Error(`stage ${stageId}: ${outcome.reason}`);
}

/**
 * The policy as the agent is told it, when no mechanism can impose it. Rule
 * names only; this text is appended to the stage prompt.
 */
export function commandMediationPromptSection(
  policy: CommandMediationPolicy,
): string {
  const lines = ["## Command Policy", ""];
  if (policy.mode === "none") {
    lines.push("You must not run any shell command in this stage.");
  } else if (policy.mode === "allow-list") {
    lines.push(
      `You may only run commands matching: ${ruleList(policy.allow)}. Anything else is out of policy.`,
    );
  } else {
    lines.push("You may run commands except those listed below.");
  }
  if (policy.deny.length > 0) {
    lines.push(`You must not run commands matching: ${ruleList(policy.deny)}.`);
  }
  lines.push(
    "",
    "This policy is stated, not enforced by the sandbox. Treat a command it forbids as a blocker to report, not an obstacle to work around.",
  );
  return lines.join("\n");
}

/** One evidence line. Mode, advisory flag, and rule names; never argv. */
export function describeCommandMediation(
  outcome: CommandMediationOutcome,
): string {
  const { policy } = outcome;
  const rules = `allow ${ruleList(policy.allow)}; deny ${ruleList(policy.deny)}`;
  switch (outcome.status) {
    case "unmediated":
      return "unrestricted (no mediation requested)";
    case "enforced":
      return `${policy.mode} enforced by ${outcome.mechanism}; ${rules}`;
    case "stated":
      return `${policy.mode} stated to the agent, not enforced; ${rules}`;
    case "unenforceable":
      return `${policy.mode} demanded enforcement that is unavailable; ${rules}`;
  }
}

const MEDIATION_LOG_KEYS = new Set([
  "advisory",
  "argc",
  "decision",
  "decisions",
  "denials",
  "event",
  "mechanism",
  "mode",
  "policyId",
  "program",
  "reason",
  "rule",
]);

/**
 * Redacted lines from one mediator log. Records that carry anything beyond the
 * fixed fields are dropped, so an argv or a secret written into the file cannot
 * ride into evidence. Program names are basenames only.
 */
export function summarizeCommandMediationLog(text: string): string[] {
  const decisions: Array<{
    decision: string;
    program: string;
    rule?: string;
    argc?: number;
    reason: string;
  }> = [];
  let effective: string | undefined;
  let sawExit = false;
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).some((key) => !MEDIATION_LOG_KEYS.has(key))) continue;
    const strings = Object.values(record).filter(
      (value): value is string => typeof value === "string",
    );
    if (strings.some((value) => value.length > 300 || value.includes("\n"))) {
      continue;
    }
    const event = record.event;
    if (event === "effective") {
      const mechanism = stringField(record.mechanism) ?? "unknown";
      const mode = stringField(record.mode) ?? "unknown";
      const policyId = stringField(record.policyId) ?? "unknown";
      effective = `effective ${mechanism} ${mode} ${policyId}`;
      continue;
    }
    if (event === "supervisor-exit") {
      sawExit = true;
      continue;
    }
    if (event !== "decision" && event !== "launch" && event !== "error") continue;
    const decision = event === "error" ? "error" : stringField(record.decision);
    if (decision !== "allow" && decision !== "deny" && decision !== "error") {
      continue;
    }
    const program = programField(record.program);
    const reason = stringField(record.reason) ?? "unspecified";
    const rule = stringField(record.rule);
    const argc = typeof record.argc === "number" && Number.isSafeInteger(record.argc)
      ? record.argc
      : undefined;
    decisions.push({
      decision,
      program,
      reason,
      ...(rule ? { rule } : {}),
      ...(argc !== undefined ? { argc } : {}),
    });
  }
  if (effective === undefined && decisions.length === 0 && !sawExit) return [];
  const denials = decisions.filter((item) => item.decision === "deny");
  return [
    effective ?? "effective record missing",
    `decisions ${decisions.length}; denials ${denials.length}`,
    ...denials.slice(0, 20).map((item) => {
      const rule = item.rule ? ` rule ${item.rule}` : "";
      const argc = item.argc === undefined ? "unknown" : String(item.argc);
      return `denied ${item.program}${rule} argc ${argc} (${item.reason})`;
    }),
    sawExit ? "supervisor exit recorded" : "supervisor exit missing",
  ];
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function programField(value: unknown): string {
  if (typeof value !== "string") return "unresolved";
  if (value === "unresolved") return value;
  return /^[A-Za-z0-9._+-]{1,128}$/u.test(value) ? value : "unresolved";
}
