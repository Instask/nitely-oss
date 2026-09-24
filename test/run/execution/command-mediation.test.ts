import { describe, expect, it } from "vitest";

import {
  commandMediationPromptSection,
  commandRuleMatches,
  decideCommand,
  describeCommandMediation,
  normalizeCommandMediationPolicy,
  resolveCommandMediation,
  type CommandMediationMechanism,
  type CommandMediationPolicy,
} from "../../../src/run/execution/command-mediation.js";

function policy(
  overrides: Partial<{
    mode: CommandMediationPolicy["mode"];
    allow: string[];
    deny: string[];
    advisory: boolean;
  }> = {},
): CommandMediationPolicy {
  return normalizeCommandMediationPolicy({
    mode: overrides.mode ?? "allow-list",
    allow: overrides.allow ?? [],
    deny: overrides.deny ?? [],
    advisory: overrides.advisory ?? true,
  });
}

function mechanism(supports: boolean): CommandMediationMechanism {
  return { id: "test-mediator", supports: () => supports };
}

describe("command mediation policy", () => {
  it("normalizes rules and derives a value-free policy id", () => {
    const normalized = policy({
      allow: [" pnpm ", "git", "pnpm", ""],
      deny: ["curl"],
      advisory: false,
    });

    expect(normalized.allow).toEqual(["git", "pnpm"]);
    expect(normalized.deny).toEqual(["curl"]);
    expect(normalized.policyId).toBe(
      "commands/v1:allow-list:enforced:allow(git,pnpm):deny(curl)",
    );
  });

  it("matches bare program names by program or basename", () => {
    expect(commandRuleMatches("git", ["git", "status"])).toBe(true);
    expect(commandRuleMatches("git", ["/usr/bin/git", "status"])).toBe(true);
    expect(commandRuleMatches("git", ["gitk"])).toBe(false);
    expect(commandRuleMatches("/usr/bin/git", ["/usr/bin/git"])).toBe(true);
    expect(commandRuleMatches("/usr/bin/git", ["git"])).toBe(false);
  });

  it("matches argv patterns with and without the resolved directory", () => {
    expect(commandRuleMatches("pnpm test*", ["pnpm", "test", "--run"])).toBe(true);
    expect(commandRuleMatches("pnpm test*", ["/usr/bin/pnpm", "test"])).toBe(true);
    expect(commandRuleMatches("pnpm test*", ["pnpm", "publish"])).toBe(false);
    expect(commandRuleMatches("git push*", ["git", "pushd"])).toBe(true);
    expect(commandRuleMatches("git commit -m ?", ["git", "commit", "-m", "x"])).toBe(
      true,
    );
  });

  it("does not let a rule's regular-expression characters match loosely", () => {
    expect(commandRuleMatches("pnpm t.st*", ["pnpm", "test"])).toBe(false);
    expect(commandRuleMatches("pnpm t.st*", ["pnpm", "t.st", "run"])).toBe(true);
  });

  it("allows a command an allow rule names", () => {
    const decision = decideCommand(policy({ allow: ["pnpm test*"] }), [
      "pnpm",
      "test",
      "--run",
    ]);

    expect(decision).toEqual({
      decision: "allow",
      rule: "pnpm test*",
      reason: "allowed by allow rule pnpm test*",
    });
  });

  it("denies a command no allow rule names", () => {
    expect(
      decideCommand(policy({ allow: ["pnpm test*"] }), ["curl", "https://x"]),
    ).toEqual({ decision: "deny", reason: "no allow rule matched" });
  });

  it("lets a deny rule override an allow rule", () => {
    expect(
      decideCommand(policy({ allow: ["git*"], deny: ["git push*"] }), [
        "git",
        "push",
        "--force",
      ]),
    ).toEqual({
      decision: "deny",
      rule: "git push*",
      reason: "denied by deny rule git push*",
    });
  });

  it("allows anything unmatched under deny-list and nothing under none", () => {
    expect(
      decideCommand(policy({ mode: "deny-list", deny: ["curl"] }), ["git"]),
    ).toMatchObject({ decision: "allow" });
    expect(
      decideCommand(policy({ mode: "deny-list", deny: ["curl"] }), ["curl"]),
    ).toMatchObject({ decision: "deny" });
    expect(decideCommand(policy({ mode: "none" }), ["git"])).toEqual({
      decision: "deny",
      reason: "command mode none forbids every command",
    });
  });

  it("skips mediation entirely under unrestricted", () => {
    expect(
      decideCommand(policy({ mode: "unrestricted", deny: ["curl"] }), ["curl"]),
    ).toEqual({ decision: "allow", reason: "command mode unrestricted" });
  });

  it("denies a command with no program", () => {
    expect(decideCommand(policy({ allow: ["git"] }), [])).toEqual({
      decision: "deny",
      reason: "command has no program",
    });
  });
});

describe("command mediation resolution", () => {
  it("reports unrestricted policies as unmediated", () => {
    expect(
      resolveCommandMediation({
        policy: policy({ mode: "unrestricted" }),
        boundary: "OCI sandbox",
      }),
    ).toMatchObject({ status: "unmediated" });
  });

  it("reports enforcement when a mechanism covers the policy", () => {
    expect(
      resolveCommandMediation({
        policy: policy({ allow: ["git"], advisory: false }),
        boundary: "OCI sandbox",
        mechanism: mechanism(true),
      }),
    ).toMatchObject({ status: "enforced", mechanism: "test-mediator" });
  });

  it("states an advisory policy when no mechanism covers it", () => {
    const outcome = resolveCommandMediation({
      policy: policy({ allow: ["git"], advisory: true }),
      boundary: "OCI sandbox",
      mechanism: mechanism(false),
    });

    expect(outcome.status).toBe("stated");
    expect(outcome).toMatchObject({
      reason: expect.stringContaining("OCI sandbox has no mechanism"),
    });
  });

  it("fails closed when enforcement is demanded and unavailable", () => {
    const outcome = resolveCommandMediation({
      policy: policy({ allow: ["git"], advisory: false }),
      boundary: "OCI sandbox",
    });

    expect(outcome.status).toBe("unenforceable");
    expect(outcome).toMatchObject({
      reason: expect.stringContaining("demands enforcement"),
    });
  });
});

describe("command mediation reporting", () => {
  it("states allow and deny rules to the agent without claiming enforcement", () => {
    const section = commandMediationPromptSection(
      policy({ allow: ["pnpm test*"], deny: ["git push*"] }),
    );

    expect(section).toContain("You may only run commands matching: pnpm test*");
    expect(section).toContain("You must not run commands matching: git push*");
    expect(section).toContain("stated, not enforced");
  });

  it("tells an agent under mode none to run nothing", () => {
    expect(commandMediationPromptSection(policy({ mode: "none" }))).toContain(
      "must not run any shell command",
    );
  });

  it("describes each outcome with rule names only", () => {
    const restricted = policy({ allow: ["git"], deny: ["curl"] });

    expect(
      describeCommandMediation({ status: "unmediated", policy: policy({ mode: "unrestricted" }) }),
    ).toBe("unrestricted (no mediation requested)");
    expect(
      describeCommandMediation({
        status: "enforced",
        policy: restricted,
        mechanism: "test-mediator",
      }),
    ).toBe("allow-list enforced by test-mediator; allow git; deny curl");
    expect(
      describeCommandMediation({
        status: "stated",
        policy: restricted,
        reason: "no mechanism",
      }),
    ).toBe("allow-list stated to the agent, not enforced; allow git; deny curl");
  });
});
