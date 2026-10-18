import { describe, expect, it } from "vitest";

import {
  codexConfigOverrides,
  codexConfiguredMcpServers,
  parseCodexMcpList,
  restrictCodexMcpServers,
  withCodexMcpServersDisabled,
} from "../../../src/run/execution/mcp-servers.js";
import { fakeCodexMcpList } from "../../helpers/fake-codex-mcp-list.js";

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

describe("codexConfigOverrides", () => {
  it("collects every -c pair of a launch", () => {
    expect(
      codexConfigOverrides(["exec", "-m", "x", "-c", "model_reasoning_effort=high", "--json", "-"]),
    ).toEqual(["-c", "model_reasoning_effort=high"]);
  });
});

describe("parseCodexMcpList", () => {
  it("keeps only name and enabled", () => {
    expect(
      parseCodexMcpList(JSON.stringify([
        { name: "a", enabled: true, transport: { env: { TOKEN: "secret" } } },
        { name: "b", enabled: false },
      ])),
    ).toEqual([{ name: "a", enabled: true }, { name: "b", enabled: false }]);
  });

  it("rejects output that is not a server list", () => {
    expect(parseCodexMcpList("ok\n")).toBeUndefined();
    expect(parseCodexMcpList("{}")).toBeUndefined();
    expect(parseCodexMcpList('[{"name":"a"}]')).toBeUndefined();
  });
});

describe("restrictCodexMcpServers", () => {
  it("disables every enabled undeclared server and verifies it", async () => {
    const lister = fakeCodexMcpList({ context7: true, github: true, playwright: true, off: false });
    const result = await restrictCodexMcpServers({
      request: { mode: "declared-required", declared: ["github", "missing"] },
      stageId: "implement",
      list: lister.list,
      baseOverrides: ["-c", "model_reasoning_effort=high"],
    });

    expect(result).toEqual({
      disable: ["context7", "playwright"],
      outcome: {
        enforcement: "enforced",
        enabled: ["github"],
        disabled: ["context7", "playwright"],
        unconfigured: ["missing"],
      },
    });
    // One listing to enumerate, one to verify, both with the launch's overrides.
    expect(lister.calls).toEqual([
      ["-c", "model_reasoning_effort=high"],
      [
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "mcp_servers.context7.enabled=false",
        "-c",
        "mcp_servers.playwright.enabled=false",
      ],
    ]);
  });

  it("needs no verification when nothing is enabled beyond the declared servers", async () => {
    const lister = fakeCodexMcpList({ github: true });
    const result = await restrictCodexMcpServers({
      request: { mode: "declared-required", declared: ["github"] },
      stageId: "implement",
      list: lister.list,
    });
    expect(result.outcome).toEqual({ enforcement: "enforced", enabled: ["github"], disabled: [] });
    expect(lister.calls).toHaveLength(1);
  });

  it("reports an unaddressable server as partial, and fails closed when required", async () => {
    const lister = fakeCodexMcpList({ "dotted.name": true, ok: true });
    const result = await restrictCodexMcpServers({
      request: { mode: "declared-if-supported", declared: [] },
      stageId: "implement",
      list: lister.list,
    });
    expect(result.disable).toEqual(["ok"]);
    expect(result.outcome).toMatchObject({
      enforcement: "partial",
      enabled: ["dotted.name"],
      disabled: ["ok"],
      reason: expect.stringMatching(/cannot address MCP server name\(s\) dotted\.name/),
    });

    await expect(
      restrictCodexMcpServers({
        request: { mode: "declared-required", declared: [] },
        stageId: "implement",
        list: lister.list,
      }),
    ).rejects.toThrow(/stage implement requires only its declared MCP servers but codex cannot address/);
  });

  it("is partial when a disabled server still reports enabled", async () => {
    const lister = fakeCodexMcpList({ stubborn: true }, { ignoreOverrides: ["stubborn"] });
    const result = await restrictCodexMcpServers({
      request: { mode: "declared-if-supported", declared: [] },
      stageId: "implement",
      list: lister.list,
    });
    expect(result.outcome).toMatchObject({
      enforcement: "partial",
      disabled: [],
      reason: expect.stringMatching(/stubborn stayed enabled/),
    });
  });

  it("falls back to the user config only in the default mode when Codex cannot list", async () => {
    const list = async () => "not json";
    const result = await restrictCodexMcpServers({
      request: { mode: "declared-if-supported", declared: ["keep"] },
      stageId: "implement",
      list,
      fallbackServers: async () => ["keep", "drop", "dotted.name"],
    });
    expect(result.disable).toEqual(["drop"]);
    expect(result.outcome).toMatchObject({
      enforcement: "partial",
      disabled: ["drop"],
      reason: expect.stringMatching(/did not print a server list/),
    });

    await expect(
      restrictCodexMcpServers({
        request: { mode: "declared-required", declared: [] },
        stageId: "implement",
        list: async () => {
          throw new Error("spawn codex ENOENT");
        },
      }),
    ).rejects.toThrow(/requires only its declared MCP servers but codex mcp list failed: spawn codex ENOENT/);
  });

  it("drops the overrides when verifying them breaks Codex", async () => {
    let call = 0;
    const result = await restrictCodexMcpServers({
      request: { mode: "declared-if-supported", declared: [] },
      stageId: "implement",
      list: async () => {
        call++;
        if (call === 1) return JSON.stringify([{ name: "a", enabled: true }]);
        throw new Error("failed to load bootstrap configuration");
      },
    });
    expect(result.disable).toEqual([]);
    expect(result.outcome).toMatchObject({
      enforcement: "partial",
      enabled: ["a"],
      reason: expect.stringMatching(/while verifying the disable overrides/),
    });
  });
});
