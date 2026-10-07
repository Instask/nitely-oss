import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli.js";
import { CatalogFlowDisabledError, resolveCatalogFlow } from "../../src/flows/catalog.js";
import { openFlowStore } from "../../src/flows/store.js";
import { startWebServer, type WebServer } from "../../src/web/server.js";

function flowDocument(name: string, command = "true"): string {
  return JSON.stringify({
    apiVersion: "nitely.dev/v1alpha1",
    kind: "Flow",
    metadata: { name },
    spec: { stages: [{ id: "build", type: "command", command, inputs: [], outputs: ["out"] }] },
  });
}

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "nitely-flow-cli-"));
  await mkdir(join(repo, "flows"), { recursive: true });
  await writeFile(join(repo, "flows/shipped.json"), flowDocument("shipped"), "utf8");
  return repo;
}

async function cli(argv: string[], dependencies: Parameters<typeof runCli>[2] = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  }, { env: {}, ...dependencies });
  return { code, stdout, stderr };
}

async function listJson(repo: string) {
  const result = await cli(["flow", "list", "--repo", repo, "--json"]);
  expect(result.code).toBe(0);
  return (JSON.parse(result.stdout[0]!) as { flows: Array<Record<string, unknown>> }).flows;
}

const servers: WebServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("nitely flow (local store, --repo)", () => {
  it("lists built-in and user Flows with seed key, origin, enabled and edit state", async () => {
    const repo = await createRepo();
    const store = openFlowStore(repo);
    store.createFlow({ name: "mine", document: flowDocument("mine") }, { createId: () => "flow-mine" });
    store.close();

    const flows = await listJson(repo);
    expect(flows.find((flow) => flow.id === "flows/shipped.json")).toMatchObject({
      seedKey: "flows/shipped.json",
      origin: "system",
      enabled: true,
      edited: false,
      newerShippedVersion: false,
    });
    expect(flows.find((flow) => flow.id === "flow-mine")).toMatchObject({ origin: "user", edited: false });

    const text = await cli(["flow", "list", "--repo", repo]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("flows/shipped.json  system  enabled,unedited  shipped");
    expect(text.stdout).toContain("flow-mine  user  enabled  mine");
  });

  it("shows a Flow document as JSON", async () => {
    const repo = await createRepo();
    const shown = await cli(["flow", "show", "flows/shipped.json", "--repo", repo]);
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.stdout.join("\n"))).toEqual(JSON.parse(flowDocument("shipped")));

    const asJson = await cli(["flow", "show", "flows/shipped.json", "--repo", repo, "--json"]);
    expect(JSON.parse(asJson.stdout[0]!)).toMatchObject({
      flow: { id: "flows/shipped.json", origin: "system" },
      document: { metadata: { name: "shipped" } },
    });

    const missing = await cli(["flow", "show", "flows/missing.json", "--repo", repo]);
    expect(missing).toMatchObject({ code: 1, stderr: ["flow not found"] });
  });

  it("disables and re-enables a Flow, and a disabled Flow cannot be resolved for work", async () => {
    const repo = await createRepo();
    expect((await cli(["flow", "disable", "flows/shipped.json", "--repo", repo])).stdout)
      .toEqual(["DISABLED flows/shipped.json  disabled,unedited"]);
    await expect(resolveCatalogFlow(repo, "flows/shipped.json"))
      .rejects.toBeInstanceOf(CatalogFlowDisabledError);
    expect((await listJson(repo)).find((flow) => flow.id === "flows/shipped.json"))
      .toMatchObject({ enabled: false });

    expect((await cli(["flow", "enable", "flows/shipped.json", "--repo", repo])).code).toBe(0);
    await expect(resolveCatalogFlow(repo, "flows/shipped.json")).resolves.toBeDefined();
  });

  it("rejects an invalid document and keeps the stored one", async () => {
    const repo = await createRepo();
    const bad = join(repo, "bad.json");
    await writeFile(bad, JSON.stringify({ apiVersion: "nitely.dev/v1alpha1", kind: "Flow" }), "utf8");
    const result = await cli(["flow", "update", "flows/shipped.json", "--file", bad, "--repo", repo]);
    expect(result.code).toBe(1);
    expect(result.stderr[0]).toMatch(/^invalid flow document: /);
    expect((await resolveCatalogFlow(repo, "flows/shipped.json")).document).toBe(flowDocument("shipped"));

    const notJson = join(repo, "not.json");
    await writeFile(notJson, "{", "utf8");
    expect((await cli(["flow", "update", "flows/shipped.json", "--file", notJson, "--repo", repo])).code)
      .toBe(1);
    expect((await cli(["flow", "update", "flows/shipped.json", "--repo", repo])).stderr)
      .toEqual(["Missing --file <path> with the new Flow document"]);
  });

  it("edits a built-in Flow, keeps it over a newer shipped version, then resets to the shipped version", async () => {
    const repo = await createRepo();
    const edited = join(repo, "edited.json");
    await writeFile(edited, flowDocument("shipped", "echo edited"), "utf8");
    const update = await cli(["flow", "update", "flows/shipped.json", "--file", edited, "--repo", repo]);
    expect(update.stdout).toEqual(["UPDATED flows/shipped.json  enabled,edited"]);

    // A newer shipped version does not overwrite the edit; it is flagged.
    const v2 = flowDocument("shipped", "echo v2");
    await writeFile(join(repo, "flows/shipped.json"), v2, "utf8");
    expect((await listJson(repo)).find((flow) => flow.id === "flows/shipped.json"))
      .toMatchObject({ edited: true, newerShippedVersion: true });
    expect((await resolveCatalogFlow(repo, "flows/shipped.json")).document)
      .toBe(await readFile(edited, "utf8"));

    await cli(["flow", "disable", "flows/shipped.json", "--repo", repo]);
    const reset = await cli(["flow", "reset", "flows/shipped.json", "--repo", repo, "--json"]);
    expect(reset.code).toBe(0);
    expect(JSON.parse(reset.stdout[0]!)).toMatchObject({
      flow: { edited: false, newerShippedVersion: false, enabled: false },
    });
    const { document } = await resolveCatalogFlow(repo, "flows/shipped.json", { requireEnabled: false });
    expect(document).toBe(v2);
  });

  it("refuses to reset a user Flow and to delete a built-in Flow, and deletes a user Flow", async () => {
    const repo = await createRepo();
    const store = openFlowStore(repo);
    store.createFlow({ name: "mine", document: flowDocument("mine") }, { createId: () => "flow-mine" });
    store.close();

    expect(await cli(["flow", "reset", "flow-mine", "--repo", repo])).toMatchObject({
      code: 1,
      stderr: ["only built-in flows have a shipped version to reset to"],
    });
    expect(await cli(["flow", "delete", "flows/shipped.json", "--repo", repo])).toMatchObject({
      code: 1,
      stderr: ["built-in flows cannot be deleted; disable them instead"],
    });
    expect(await cli(["flow", "delete", "flow-mine", "--repo", repo, "--json"])).toMatchObject({
      code: 0,
      stdout: [JSON.stringify({ deleted: "flow-mine" })],
    });
    expect((await listJson(repo)).map((flow) => flow.id)).not.toContain("flow-mine");
  });

  it("rejects bad arguments", async () => {
    const repo = await createRepo();
    expect((await cli(["flow", "enable", "--repo", repo])).code).toBe(1);
    expect((await cli(["flow", "list", "--repo", repo, "--server", "http://x.test"])).stderr)
      .toEqual(["Use either --repo or --server, not both"]);
    expect((await cli(["flow", "frobnicate"])).code).toBe(1);
  });
});

describe("nitely flow (remote server)", () => {
  it("manages built-in Flows on a local-mode server", async () => {
    const repo = await createRepo();
    const server = await startWebServer({
      repoPath: repo,
      host: "127.0.0.1",
      port: 0,
      providerCommandStatus: async () => false,
      repositories: [{ id: "home", name: "home", path: repo }],
    });
    servers.push(server);
    const remote = ["--server", server.url];

    expect((await cli(["flow", "disable", "flows/shipped.json", ...remote])).stdout)
      .toEqual(["DISABLED flows/shipped.json  disabled,unedited"]);
    const list = await cli(["flow", "list", ...remote]);
    expect(list.stdout).toContain("flows/shipped.json  builtin  blocked  shipped  [disabled,unedited]");

    const edited = join(repo, "edited.json");
    await writeFile(edited, flowDocument("shipped", "echo edited"), "utf8");
    expect((await cli(["flow", "update", "flows/shipped.json", "--file", edited, ...remote])).stdout)
      .toEqual(["UPDATED flows/shipped.json  disabled,edited"]);
    expect((await cli(["flow", "reset", "flows/shipped.json", ...remote])).stdout)
      .toEqual(["RESET flows/shipped.json  disabled,unedited"]);
    expect(JSON.parse((await cli(["flow", "show", "flows/shipped.json", ...remote])).stdout.join("\n")))
      .toEqual(JSON.parse(flowDocument("shipped")));

    const bad = join(repo, "bad.json");
    await writeFile(bad, JSON.stringify({ kind: "Flow" }), "utf8");
    const invalid = await cli(["flow", "update", "flows/shipped.json", "--file", bad, ...remote]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr[0]).toMatch(/^invalid flow document: /);
    expect(await cli(["flow", "delete", "flows/shipped.json", ...remote])).toMatchObject({
      code: 1,
      stderr: ["remote flow delete failed (HTTP 400): built-in flows cannot be deleted; disable them instead"],
    });
  });

  it("reports the server's permission denial", async () => {
    const result = await cli(["flow", "disable", "flows/shipped.json", "--server", "http://server.test"], {
      env: { NITELY_API_TOKEN: "nitely_api_secret" },
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "record write access required nitely_api_secret" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    });
    expect(result).toMatchObject({
      code: 1,
      stderr: ["remote flow disable failed (HTTP 403): record write access required [REDACTED]"],
    });
  });
});
