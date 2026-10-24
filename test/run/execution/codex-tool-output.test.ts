import { describe, expect, it } from "vitest";

import { withCodexToolOutputLimit } from "../../../src/run/execution/codex-tool-output.js";

describe("withCodexToolOutputLimit", () => {
  it("adds the override right after exec for a cold launch", () => {
    expect(withCodexToolOutputLimit(["exec", "--sandbox", "read-only", "-"], 2500)).toEqual([
      "exec",
      "-c",
      "tool_output_token_limit=2500",
      "--sandbox",
      "read-only",
      "-",
    ]);
  });

  it("puts it before resume so codex exec resume accepts it", () => {
    expect(withCodexToolOutputLimit(["exec", "resume", "thread-1", "--json", "-"], 4000)).toEqual([
      "exec",
      "-c",
      "tool_output_token_limit=4000",
      "resume",
      "thread-1",
      "--json",
      "-",
    ]);
  });

  it("leaves the launch alone when no limit is set", () => {
    const args = ["exec", "-"];
    expect(withCodexToolOutputLimit(args, undefined)).toEqual(args);
  });

  it("rejects a limit that is not a positive integer", () => {
    expect(() => withCodexToolOutputLimit(["exec"], 0)).toThrow(/positive integer/);
    expect(() => withCodexToolOutputLimit(["exec"], 1.5)).toThrow(/positive integer/);
  });
});
