import { describe, expect, it } from "vitest";

import {
  classifyNitelyCommand,
  parseNitelyCommand,
} from "../../src/pr-comments/commands.js";

describe("parseNitelyCommand", () => {
  it("parses supported commands case-insensitively", () => {
    expect(parseNitelyCommand("@nitely rework fix auth")).toEqual({
      action: "rework",
      instruction: "fix auth",
      rawCommandLine: "@nitely rework fix auth",
    });
    expect(parseNitelyCommand("  @Nitely address this add a test")).toEqual({
      action: "address",
      instruction: "add a test",
      rawCommandLine: "@Nitely address this add a test",
    });
    expect(parseNitelyCommand("@NITELY explain why configured")).toEqual({
      action: "explain",
      instruction: "why configured",
      rawCommandLine: "@NITELY explain why configured",
    });
  });

  it("ignores fenced code and quoted review text", () => {
    expect(
      parseNitelyCommand(
        [
          "```",
          "@nitely rework ignored",
          "```",
          "> @nitely rework quoted",
          "",
          "@nitely explain actual question",
        ].join("\n"),
      ),
    ).toEqual({
      action: "explain",
      instruction: "actual question",
      rawCommandLine: "@nitely explain actual question",
    });
  });

  it("rejects unsupported commands and empty actionable instructions", () => {
    expect(parseNitelyCommand("please @nitely rework later")).toBeNull();
    expect(parseNitelyCommand("@nitely approve this")).toBeNull();
    expect(parseNitelyCommand("@nitely rework")).toBeNull();
    expect(parseNitelyCommand("@nitely address this   ")).toBeNull();
  });

  it("classifies empty actionable commands separately from unsupported commands", () => {
    expect(classifyNitelyCommand("@nitely rework")).toEqual({
      status: "invalid",
      reason: "empty instruction",
    });
    expect(classifyNitelyCommand("@nitely address this   ")).toEqual({
      status: "invalid",
      reason: "empty instruction",
    });
    expect(classifyNitelyCommand("@nitely approve this")).toEqual({
      status: "invalid",
      reason: "unsupported command",
    });
  });
});
