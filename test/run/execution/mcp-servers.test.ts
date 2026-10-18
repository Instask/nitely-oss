import { describe, expect, it } from "vitest";

import {
  codexConfiguredMcpServers,
  planMcpServerRestriction,
  withCodexMcpServersDisabled,
} from "../../../src/run/execution/mcp-servers.js";

describe("codexConfiguredMcpServers", () => {
  it("reads server tables, sub-tables, and quoted names in file order", () => {
    const config = [
      'model = "gpt-5"',
      'model_provider = "openai"',
      "",
      "[mcp_servers.context7]",
      'command = "npx"',
      'args = ["-y", "@upstash/context7-mcp"]',
      "",
      "[mcp_servers.node_repl.env]",
      'PATH = "/usr/bin"',
      "",
      '[mcp_servers."computer-use"]',
      'command = "cu"',
      "",
      "[mcp_servers.context7.env]",
      'X = "1"',
      "",
      '[projects."/repo"]',
      'trust_level = "trusted"',
    ].join("\n");

    expect(codexConfiguredMcpServers(config)).toEqual([
      "context7",
      "node_repl",
      "computer-use",
    ]);
  });

  it("reads servers declared as keys of a bare mcp_servers table or as dotted keys", () => {
    const config = [
      "mcp_servers.top.command = \"a\"",
      "[mcp_servers]",
      'inline = { command = "b" }',
      'dotted.url = "https://example.invalid/mcp"',
      "[features]",
      "inline_two = true",
    ].join("\n");

    expect(codexConfiguredMcpServers(config)).toEqual(["top", "inline", "dotted"]);
  });

  it("ignores headers inside multi-line strings and array tables", () => {
    const config = [
      'instructions = """',
      "[mcp_servers.fake]",
      '"""',
      "[[mcp_servers.listed]]",
      'name = "x"',
      "[mcp_servers.real]",
      'command = "true"',
    ].join("\n");

    expect(codexConfiguredMcpServers(config)).toEqual(["real"]);
  });

  it("finds nothing in a config without MCP servers", () => {
    expect(codexConfiguredMcpServers('model = "gpt-5"\n')).toEqual([]);
  });
});

describe("withCodexMcpServersDisabled", () => {
  it("adds one enabled=false override per server right after exec", () => {
    expect(
      withCodexMcpServersDisabled(["exec", "--sandbox", "read-only", "-"], ["a", "b-c"]),
    ).toEqual([
      "exec",
      "-c",
      "mcp_servers.a.enabled=false",
      "-c",
      "mcp_servers.b-c.enabled=false",
      "--sandbox",
      "read-only",
      "-",
    ]);
  });

  it("puts the overrides before a resume subcommand", () => {
    expect(withCodexMcpServersDisabled(["exec", "resume", "id", "-"], ["a"])).toEqual([
      "exec",
      "-c",
      "mcp_servers.a.enabled=false",
      "resume",
      "id",
      "-",
    ]);
  });

  it("leaves the args alone when nothing is disabled", () => {
    expect(withCodexMcpServersDisabled(["exec", "-"], [])).toEqual(["exec", "-"]);
  });
});

describe("planMcpServerRestriction", () => {
  it("keeps exactly the declared servers and disables the rest", () => {
    expect(
      planMcpServerRestriction({
        request: { mode: "declared-if-supported", declared: ["github", "missing"] },
        configured: ["context7", "github", "playwright"],
        stageId: "implement",
      }),
    ).toEqual({
      disable: ["context7", "playwright"],
      outcome: {
        restricted: true,
        enabled: ["github"],
        disabled: ["context7", "playwright"],
        unconfigured: ["missing"],
      },
    });
  });

  it("disables every configured server when the stage declares none", () => {
    expect(
      planMcpServerRestriction({
        request: { mode: "declared-if-supported", declared: [] },
        configured: ["context7", "playwright"],
        stageId: "reflect",
      }).disable,
    ).toEqual(["context7", "playwright"]);
  });

  it("leaves an unaddressable name enabled and says so", () => {
    const plan = planMcpServerRestriction({
      request: { mode: "declared-if-supported", declared: [] },
      configured: ["dotted.name", "ok"],
      stageId: "implement",
    });
    expect(plan.disable).toEqual(["ok"]);
    expect(plan.outcome).toMatchObject({
      restricted: true,
      enabled: ["dotted.name"],
      disabled: ["ok"],
    });
    expect(plan.outcome.reason).toMatch(/cannot address MCP server name\(s\) dotted\.name/);
  });

  it("fails closed on a required restriction it cannot complete", () => {
    expect(() =>
      planMcpServerRestriction({
        request: { mode: "declared-required", declared: [] },
        configured: ["ok"],
        stageId: "implement",
        incompleteReason: "plugins still load",
      }),
    ).toThrow(/stage implement requires only its declared MCP servers but plugins still load/);
  });
});
