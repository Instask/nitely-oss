import { describe, expect, it } from "vitest";

import {
  codexConfigOverrides,
  codexConfiguredMcpServers,
  codexMcpServerDisableOverrides,
  parseCodexFeatureState,
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

describe("codexMcpServerDisableOverrides", () => {
  it("turns the Apps connector off through its feature", () => {
    expect(codexMcpServerDisableOverrides(["github", "codex_apps"])).toEqual([
      "-c",
      "mcp_servers.github.enabled=false",
      "-c",
      "features.apps=false",
    ]);
  });

  it("carries features.apps=false into both exec and exec resume", () => {
    expect(withCodexMcpServersDisabled(["exec", "--json", "-"], ["codex_apps"])).toEqual([
      "exec", "-c", "features.apps=false", "--json", "-",
    ]);
    expect(withCodexMcpServersDisabled(["exec", "resume", "id", "-"], ["codex_apps"])).toEqual([
      "exec", "-c", "features.apps=false", "resume", "id", "-",
    ]);
  });
});

describe("parseCodexFeatureState", () => {
  it("reads the effective state column of codex features list", () => {
    const stdout = [
      "apps                                     stable             false",
      "apps_mcp_path_override                   removed            true",
      "enable_mcp_apps                          under development  true",
    ].join("\n");
    expect(parseCodexFeatureState(stdout, "apps")).toBe(false);
    expect(parseCodexFeatureState(stdout, "enable_mcp_apps")).toBe(true);
    expect(parseCodexFeatureState(stdout, "missing")).toBeUndefined();
  });
});

describe("restrictCodexMcpServers", () => {
  it("disables every enabled undeclared server and the Apps connector, and verifies both", async () => {
    const lister = fakeCodexMcpList({ context7: true, github: true, playwright: true, off: false });
    const result = await restrictCodexMcpServers({
      request: { mode: "declared-required", declared: ["github", "missing"] },
      stageId: "implement",
      list: lister.list,
      features: lister.features,
      baseOverrides: ["-c", "model_reasoning_effort=high"],
    });

    expect(result).toEqual({
      disable: ["context7", "playwright", "codex_apps"],
      outcome: {
        enforcement: "enforced",
        enabled: ["github"],
        disabled: ["context7", "playwright", "codex_apps"],
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
        "-c",
        "features.apps=false",
      ],
    ]);
  });

  it("turns the Apps connector off even when no configured server is undeclared", async () => {
    const lister = fakeCodexMcpList({ github: true });
    const result = await restrictCodexMcpServers({
      request: { mode: "declared-required", declared: ["github"] },
      stageId: "implement",
      list: lister.list,
      features: lister.features,
    });
    expect(result).toEqual({
      disable: ["codex_apps"],
      outcome: { enforcement: "enforced", enabled: ["github"], disabled: ["codex_apps"] },
    });
  });

  it("keeps the Apps connector for a stage that declares codex_apps", async () => {
    const lister = fakeCodexMcpList({ github: true });
    const result = await restrictCodexMcpServers({
      request: { mode: "declared-required", declared: ["codex_apps"] },
      stageId: "implement",
      list: lister.list,
      features: lister.features,
    });
    expect(result).toEqual({
      disable: ["github"],
      outcome: { enforcement: "enforced", enabled: ["codex_apps"], disabled: ["github"] },
    });

    // With the feature off in the operator's config there is nothing to keep.
    const off = fakeCodexMcpList({}, { apps: false });
    await expect(
      restrictCodexMcpServers({
        request: { mode: "declared-if-supported", declared: ["codex_apps"] },
        stageId: "implement",
        list: off.list,
        features: off.features,
      }),
    ).resolves.toMatchObject({
      outcome: { enforcement: "enforced", enabled: [], unconfigured: ["codex_apps"] },
    });
  });

  it("is partial when the apps feature cannot be confirmed off, and fails closed when required", async () => {
    const pinned = fakeCodexMcpList({}, { pinApps: true });
    const result = await restrictCodexMcpServers({
      request: { mode: "declared-if-supported", declared: [] },
      stageId: "reflect",
      list: pinned.list,
      features: pinned.features,
    });
    expect(result.disable).toEqual(["codex_apps"]);
    expect(result.outcome).toMatchObject({
      enforcement: "partial",
      disabled: [],
      reason: expect.stringMatching(/apps feature stayed on/),
    });

    const unreadable = fakeCodexMcpList({});
    await expect(
      restrictCodexMcpServers({
        request: { mode: "declared-required", declared: [] },
        stageId: "reflect",
        list: unreadable.list,
        features: async () => "",
      }),
    ).rejects.toThrow(/requires only its declared MCP servers but codex features list did not report the apps feature/);
    await expect(
      restrictCodexMcpServers({
        request: { mode: "declared-required", declared: [] },
        stageId: "reflect",
        list: unreadable.list,
      }),
    ).rejects.toThrow(/effective Codex apps feature cannot be read/);
  });

  it("reports an unaddressable server as partial, and fails closed when required", async () => {
    const lister = fakeCodexMcpList({ "dotted.name": true, ok: true });
    const result = await restrictCodexMcpServers({
      request: { mode: "declared-if-supported", declared: [] },
      stageId: "implement",
      list: lister.list,
      features: lister.features,
    });
    expect(result.disable).toEqual(["ok", "codex_apps"]);
    expect(result.outcome).toMatchObject({
      enforcement: "partial",
      enabled: ["dotted.name"],
      disabled: ["ok", "codex_apps"],
      reason: expect.stringMatching(/cannot address MCP server name\(s\) dotted\.name/),
    });

    await expect(
      restrictCodexMcpServers({
        request: { mode: "declared-required", declared: [] },
        stageId: "implement",
        list: lister.list,
        features: lister.features,
      }),
    ).rejects.toThrow(/stage implement requires only its declared MCP servers but codex cannot address/);
  });

  it("is partial when a disabled server still reports enabled", async () => {
    const lister = fakeCodexMcpList({ stubborn: true }, { ignoreOverrides: ["stubborn"] });
    const result = await restrictCodexMcpServers({
      request: { mode: "declared-if-supported", declared: [] },
      stageId: "implement",
      list: lister.list,
      features: lister.features,
    });
    expect(result.outcome).toMatchObject({
      enforcement: "partial",
      disabled: ["codex_apps"],
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
    expect(result.disable).toEqual(["drop", "codex_apps"]);
    expect(result.outcome).toMatchObject({
      enforcement: "partial",
      disabled: ["drop", "codex_apps"],
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

  it("keeps only the Apps override when verifying the server overrides breaks Codex", async () => {
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
    expect(result.disable).toEqual(["codex_apps"]);
    expect(result.outcome).toMatchObject({
      enforcement: "partial",
      enabled: ["a"],
      reason: expect.stringMatching(/while verifying the disable overrides/),
    });
  });
});
