import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const consolePath = join(process.cwd(), "src/web/static/console.dc.html");

/** Extract a class member (`name(...) {`, `async name(...) {`, or `name = async (...) => {`). */
function extractMember(source: string, name: string): string {
  const markers = [`  ${name} = async (`, `  ${name} = (`, `  async ${name}(`, `  ${name}(`];
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
        return text
          .replace(new RegExp(`^${name} = async \\((\\w*)\\) => \\{`), `async ${name}($1) {`)
          .replace(new RegExp(`^${name} = \\((\\w*)\\) => \\{`), `${name}($1) {`);
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

const routing = [
  ...helpers,
  "routeFromPath",
  "pathForRoute",
  "applyRoute",
  "navigate",
  "fetchFlowCatalog",
  "fetchFlowDetail",
  "flowRepoResetPatch",
  "flowRoute",
  "selectFlowRepository",
  "openFlow",
  "newFlow",
];

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function stubLocation(path: string) {
  const url = new URL(path, "http://console.test");
  const location = { pathname: url.pathname, search: url.search };
  const history = {
    pushState: vi.fn((_s: unknown, _t: string, next: string) => {
      const u = new URL(next, "http://console.test");
      location.pathname = u.pathname;
      location.search = u.search;
    }),
    replaceState: vi.fn((_s: unknown, _t: string, next: string) => {
      const u = new URL(next, "http://console.test");
      location.pathname = u.pathname;
      location.search = u.search;
    }),
  };
  vi.stubGlobal("window", { location, history });
  return { location, history };
}

async function routedComponent(): Promise<FlowComponent> {
  const c = await flowComponent(routing);
  c.fetchTaskDetail = vi.fn();
  c.fetchRunDetail = vi.fn();
  c.fetchContextKnowledgeEntry = vi.fn();
  return c;
}

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

  it("extracts Flow API error messages from nested, string, and plain bodies", async () => {
    const c = await flowComponent(helpers);
    const res = (status: number, body: unknown) => ({ status, json: async () => body });
    await expect(c.flowErrorMessage(res(403, { error: { code: "forbidden", message: "Flow management requires admin" } }), "Save failed")).resolves.toBe("Flow management requires admin");
    await expect(c.flowErrorMessage(res(403, { error: { code: "forbidden" } }), "Save failed")).resolves.toBe("forbidden");
    await expect(c.flowErrorMessage(res(403, { error: {} }), "Save failed")).resolves.toBe("Save failed (403)");
    await expect(c.flowErrorMessage(res(400, { error: "bad flow" }), "Save failed")).resolves.toBe("bad flow");
    await expect(c.flowErrorMessage(res(400, { message: "plain message" }), "Save failed")).resolves.toBe("plain message");
    await expect(c.flowErrorMessage({ status: 500, json: async () => { throw new Error("x"); } }, "Reset failed")).resolves.toBe("Reset failed (500)");
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
    stubLocation("/flows");
    const c = await routedComponent();
    c.state = { flowRepoId: "", flowDetails: { a: {} }, view: "flows" };
    const paths: string[] = [];
    c.api = async (path: string) => {
      paths.push(path);
      return path.includes("templates") ? { templates: [{ id: "t" }] } : { flows: [{ id: "f" }] };
    };
    await c.selectFlowRepository({ currentTarget: { value: "repo-b" } });
    await flush();
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
    const c = await flowComponent([...helpers, "flowRoute", "saveFlow"]);
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
    expect(c.navigate).toHaveBeenCalledWith({ view: "flow-detail", flowId: "flows/foo.json", repoId: "repo-b" });
  });

  describe("repository in Flow routes", () => {
    it("parses repoId from Flow URLs", async () => {
      const c = await flowComponent(["routeFromPath"]);
      expect(c.routeFromPath("/flows/flows%2Ffoo.json", "?repoId=repo-b")).toEqual({
        view: "flow-detail",
        flowId: "flows/foo.json",
        repoId: "repo-b",
      });
      expect(c.routeFromPath("/flows", "?repoId=repo-b")).toEqual({ view: "flows", repoId: "repo-b" });
      expect(c.routeFromPath("/flows/new", "?repoId=repo-b")).toEqual({ view: "flow-new", repoId: "repo-b" });
      expect(c.routeFromPath("/flows", "")).toEqual({ view: "flows", repoId: "" });
    });

    it("writes repoId back into Flow URLs and omits it for home", async () => {
      const c = await flowComponent(["pathForRoute"]);
      expect(c.pathForRoute({ view: "flow-detail", flowId: "flows/foo.json", repoId: "repo-b" })).toBe(
        "/flows/flows%2Ffoo.json?repoId=repo-b",
      );
      expect(c.pathForRoute({ view: "flows", repoId: "repo-b" })).toBe("/flows?repoId=repo-b");
      expect(c.pathForRoute({ view: "flow-new", repoId: "repo-b" })).toBe("/flows/new?repoId=repo-b");
      expect(c.pathForRoute({ view: "flows", repoId: "" })).toBe("/flows");
      expect(c.pathForRoute({ view: "flow-detail", flowId: "flows/foo.json" })).toBe("/flows/flows%2Ffoo.json");
    });

    function twoRepoApi(paths: string[], missingInRepoB = false) {
      return async (path: string) => {
        paths.push(path);
        if (path.startsWith("/api/flows/templates")) return { templates: [] };
        if (path === "/api/flows/flows%2Ffoo.json") return { flow: { id: "flows/foo.json", document: "home custom" } };
        if (path === "/api/flows/flows%2Ffoo.json?repoId=repo-b") {
          return missingInRepoB ? null : { flow: { id: "flows/foo.json", document: "repo-b custom" } };
        }
        return { flows: [] };
      };
    }

    it("deep link / refresh loads the Flow from the repository in the URL", async () => {
      const { location } = stubLocation("/flows/flows%2Ffoo.json?repoId=repo-b");
      const c = await routedComponent();
      c.state = { flowRepoId: "", flowDetails: {}, configValues: {} };
      const paths: string[] = [];
      c.api = twoRepoApi(paths);
      c.applyRoute(c.routeFromPath(location.pathname, location.search), { replace: true });
      await flush();
      expect(paths).toContain("/api/flows/flows%2Ffoo.json?repoId=repo-b");
      expect(paths).not.toContain("/api/flows/flows%2Ffoo.json");
      expect(c.state.flowRepoId).toBe("repo-b");
      expect(c.state.flowDraftDocument).toBe("repo-b custom");
      expect(c.state.flowDetails["flows/foo.json"].document).toBe("repo-b custom");
      expect(location.search).toBe("?repoId=repo-b");
    });

    it("selector change updates the route and openFlow/newFlow keep the repo", async () => {
      const { location, history } = stubLocation("/flows");
      const c = await routedComponent();
      c.state = { flowRepoId: "", flowDetails: {}, view: "flows", configValues: {} };
      c.api = twoRepoApi([]);
      await c.selectFlowRepository({ currentTarget: { value: "repo-b" } });
      expect(history.pushState).toHaveBeenCalledWith({}, "", "/flows?repoId=repo-b");
      expect(c.state.flowRepoId).toBe("repo-b");
      c.openFlow({ currentTarget: { dataset: { id: "flows/foo.json" } } });
      expect(location.pathname + location.search).toBe("/flows/flows%2Ffoo.json?repoId=repo-b");
      c.newFlow();
      expect(location.pathname + location.search).toBe("/flows/new?repoId=repo-b");
      await c.selectFlowRepository({ currentTarget: { value: "" } });
      expect(location.pathname + location.search).toBe("/flows/new");
      await flush();
    });

    it("popstate (Back/Forward) restores the repository from the URL", async () => {
      const { location } = stubLocation("/flows/flows%2Ffoo.json?repoId=repo-b");
      const c = await routedComponent();
      c.state = { flowRepoId: "", flowDetails: {}, configValues: {} };
      c.api = twoRepoApi([]);
      c.applyRoute(c.routeFromPath(location.pathname, location.search), { replace: true });
      await flush();
      // Back to the home-repo URL.
      location.pathname = "/flows/flows%2Ffoo.json";
      location.search = "";
      c.applyRoute(c.routeFromPath(location.pathname, location.search), { replace: true });
      await flush();
      expect(c.state.flowRepoId).toBe("");
      expect(c.state.flowDraftDocument).toBe("home custom");
      // Forward again.
      location.search = "?repoId=repo-b";
      c.applyRoute(c.routeFromPath(location.pathname, location.search), { replace: true });
      await flush();
      expect(c.state.flowRepoId).toBe("repo-b");
      expect(c.state.flowDraftDocument).toBe("repo-b custom");
    });

    it("switching repo on a detail page never shows the previous repo's Flow, even on 404", async () => {
      stubLocation("/flows/flows%2Ffoo.json");
      const c = await routedComponent();
      c.state = {
        view: "flow-detail",
        flowRepoId: "",
        selectedFlowId: "flows/foo.json",
        selectedFlowStageId: "build",
        flowDetails: { "flows/foo.json": { document: "home custom" } },
        flowDraftDocument: "home edited draft",
        flowDraftReport: { ok: true },
        flowDraftStatus: "Saving...",
        configValues: { "flows/foo.json::verifyCommand": "npm test", other: 1 },
      };
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const base = twoRepoApi([], true);
      c.api = async (path: string) => {
        if (path.startsWith("/api/flows/flows%2Ffoo.json")) await gate;
        return base(path);
      };
      const pending = c.selectFlowRepository({ currentTarget: { value: "repo-b" } });
      // While loading: no stale home detail/draft.
      expect(c.state.flowRepoId).toBe("repo-b");
      expect(c.state.flowDetails).toEqual({});
      expect(c.state.flowDraftDocument).toBe("");
      expect(c.state.flowDraftReport).toBeNull();
      expect(c.state.flowDraftStatus).toBe("");
      expect(c.state.selectedFlowStageId).toBeNull();
      expect(c.state.configValues).toEqual({ other: 1 });
      release();
      await pending;
      await flush();
      // Not found in repo-b: clear error, still nothing from home.
      expect(c.state.flowDraftDocument).toBe("");
      expect(c.state.flowDetails["flows/foo.json"]).toBeUndefined();
      expect(c.state.flowDetailError).toContain("not found in repository repo-b");
    });

    it("drops a late detail response from a repository the user switched away from", async () => {
      stubLocation("/flows/flows%2Ffoo.json?repoId=repo-b");
      const c = await routedComponent();
      c.state = { flowRepoId: "repo-b", selectedFlowId: "flows/foo.json", flowDetails: {}, configValues: {} };
      c.api = twoRepoApi([]);
      const pending = c.fetchFlowDetail("flows/foo.json", "repo-b");
      c.state.flowRepoId = "";
      await pending;
      expect(c.state.flowDraftDocument).toBeUndefined();
      expect(c.state.flowDetails).toEqual({});
    });
  });

  it("shows the repository on the Flow detail header", async () => {
    const html = await readFile(consolePath, "utf8");
    expect(html).toContain('data-flow-repo-label="true"');
    expect(html).toContain("{{ flowRepositoryLabel }}");
    expect(html).toContain("{{ flowDetailError }}");
  });
});
