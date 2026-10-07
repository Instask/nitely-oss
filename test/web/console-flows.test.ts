import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const consolePath = join(process.cwd(), "src/web/static/console.dc.html");

/** Extract a class member (`name(...) {`, `async name(...) {`, or `name = async (...) => {`). */
function extractMember(source: string, name: string): string {
  const markers = [`  ${name} = async (`, `  async ${name}(`, `  ${name}(`];
  const marker = markers.find((m) => source.includes(m));
  if (!marker) throw new Error(`member not found: ${name}`);
  const start = source.indexOf(marker);
  const brace = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        const text = source.slice(start, index + 1).trim();
        // Arrow members become plain methods for the object literal.
        return text.replace(new RegExp(`^${name} = async \\((\\w*)\\) => \\{`), `async ${name}($1) {`);
      }
    }
  }
  throw new Error(`unterminated member: ${name}`);
}

type FlowComponent = Record<string, any>;

async function flowComponent(members: string[]): Promise<FlowComponent> {
  const html = await readFile(consolePath, "utf8");
  const body = members.map((name) => extractMember(html, name)).join(",\n");
  const component = new Function(`return ({ ${body} });`)() as FlowComponent;
  component.setState = (patch: Record<string, unknown>) => {
    component.state = Object.assign({}, component.state, typeof patch === "function" ? (patch as any)(component.state) : patch);
  };
  return component;
}

const helpers = ["flowApiPath", "flowRepoBody", "flowErrorMessage"];

describe("console Flow management", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders repository selector, status badges, toggle, and reset controls", async () => {
    const html = await readFile(consolePath, "utf8");
    expect(html).toContain('onChange="{{ selectFlowRepository }}"');
    expect(html).toContain("{{ flowRepositoryOptions }}");
    expect(html).toContain('data-flow-badge="{{ b.key }}"');
    expect(html).toContain('onClick="{{ toggleFlowEnabled }}"');
    expect(html).toContain('onClick="{{ resetFlow }}"');
    expect(html).toContain("Reset to built-in");
    expect(html).toContain('role="alert"');
    // Toggle/reset are gated on the API's per-user `editable` flag.
    expect(html).toContain("canToggle: f.editable === true");
    expect(html).toContain('selectedFlowCanReset = selectedFlowCanToggle && selectedFlow.source === "builtin"');
  });

  it("scopes Flow and template API paths to the selected repository", async () => {
    const c = await flowComponent(helpers);
    c.state = { flowRepoId: "" };
    expect(c.flowApiPath("/api/flows")).toBe("/api/flows");
    expect(c.flowRepoBody({ document: "x" })).toEqual({ document: "x" });
    c.state = { flowRepoId: "repo b" };
    expect(c.flowApiPath("/api/flows/templates")).toBe("/api/flows/templates?repoId=repo%20b");
    expect(c.flowApiPath("/api/flows?x=1")).toBe("/api/flows?x=1&repoId=repo%20b");
    expect(c.flowRepoBody({ enabled: false })).toEqual({ enabled: false, repoId: "repo b" });

    const html = await readFile(consolePath, "utf8");
    expect(html).toContain('this.api(this.flowApiPath("/api/flows/templates"))');
    expect(html).not.toContain('this.api("/api/flows/templates")');
  });

  it("switching repository reloads that repository's Flows and templates", async () => {
    const c = await flowComponent([...helpers, "fetchFlowCatalog", "selectFlowRepository"]);
    c.state = { flowRepoId: "", flowDetails: { a: {} }, view: "flows" };
    const paths: string[] = [];
    c.api = async (path: string) => {
      paths.push(path);
      return path.includes("templates") ? { templates: [{ id: "t" }] } : { flows: [{ id: "f" }] };
    };
    await c.selectFlowRepository({ currentTarget: { value: "repo-b" } });
    expect(paths.sort()).toEqual(["/api/flows/templates?repoId=repo-b", "/api/flows?repoId=repo-b"]);
    expect(c.state.flowDetails).toEqual({});
    expect(c.state.flows).toEqual([{ id: "f" }]);
    expect(c.state.flowTemplates).toEqual([{ id: "t" }]);
  });

  it("toggles enabled with PUT carrying repoId and surfaces API errors", async () => {
    const c = await flowComponent([...helpers, "toggleFlowEnabled"]);
    c.state = { flowRepoId: "repo-b", flowDetails: {} };
    c.fetchFlowCatalog = vi.fn(async () => {});
    const fetchMock = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: "forbidden: flows:manage" }) }));
    vi.stubGlobal("fetch", fetchMock);
    const stopPropagation = vi.fn();
    await c.toggleFlowEnabled({ stopPropagation, currentTarget: { dataset: { id: "flows/foo.json", enabled: "false" } } });
    expect(stopPropagation).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/flows/flows%2Ffoo.json");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ enabled: false, repoId: "repo-b" });
    expect(c.state.flowManageError).toBe("forbidden: flows:manage");
    expect(c.fetchFlowCatalog).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) } as any);
    await c.toggleFlowEnabled({ currentTarget: { dataset: { id: "flows/foo.json", enabled: "true" } } });
    expect(c.state.flowManageError).toBe("");
    expect(c.fetchFlowCatalog).toHaveBeenCalled();
  });

  it("reset asks for confirmation and posts to the selected repository", async () => {
    const c = await flowComponent([...helpers, "resetFlow"]);
    c.state = { flowRepoId: "repo-b", flowDetails: { "flows/foo.json": { name: "Foo" } } };
    c.fetchFlowCatalog = vi.fn(async () => {});
    c.fetchFlowDetail = vi.fn(async () => {});
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const confirm = vi.fn(() => false);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { confirm });
    const event = { currentTarget: { dataset: { id: "flows/foo.json" } } };

    await c.resetFlow(event);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Foo"));
    expect(fetchMock).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await c.resetFlow(event);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/flows/flows%2Ffoo.json/reset?repoId=repo-b");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ repoId: "repo-b" });
    expect(c.fetchFlowDetail).toHaveBeenCalledWith("flows/foo.json");
  });

  it("saving an editable built-in Flow replaces it in place with PUT", async () => {
    const c = await flowComponent([...helpers, "saveFlow"]);
    c.state = {
      flowRepoId: "repo-b",
      flowDraftDocument: "{}",
      selectedFlowId: "flows/foo.json",
      flowDetails: { "flows/foo.json": { editable: true } },
    };
    c.fetchData = vi.fn(async () => {});
    c.fetchFlowDetail = vi.fn(async () => {});
    c.navigate = vi.fn();
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ flow: { id: "system-foo" } }) }));
    vi.stubGlobal("fetch", fetchMock);
    await c.saveFlow();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/flows/flows%2Ffoo.json");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ document: "{}", repoId: "repo-b" });
    expect(c.navigate).toHaveBeenCalledWith({ view: "flow-detail", flowId: "flows/foo.json" });
  });
});
