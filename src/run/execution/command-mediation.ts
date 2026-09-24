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
 * for itself. Nothing in the first slice provides one: container isolation
 * bounds the filesystem and the network, not which binaries run inside the
 * image. A mechanism registered here is what flips a demanded policy from
 * fail-closed to enforced.
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
