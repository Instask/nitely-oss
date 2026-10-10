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

  it("renders a confirmed Delete control only for editable custom Flows", async () => {
    const html = await readFile(consolePath, "utf8");
    expect(html).toContain('onClick="{{ deleteFlow }}"');
    expect(html).toContain('selectedFlowCanDelete = selectedFlowCanToggle && selectedFlow.source === "user"');
  });

  it("delete asks for confirmation, targets the selected repository, and returns to the list", async () => {
    const c = await flowComponent([...helpers, "flowRoute", "deleteFlow"]);
    c.state = { flowRepoId: "repo-b", flowDetails: { "user/x": { name: "Mine", source: "user" }, "flows/foo.json": { name: "Foo", source: "builtin" } } };
    c.fetchFlowCatalog = vi.fn(async () => {});
    c.navigate = vi.fn();
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const confirm = vi.fn(() => false);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { confirm });

    await c.deleteFlow({ currentTarget: { dataset: { id: "flows/foo.json" } } });
    expect(confirm).not.toHaveBeenCalled();
    await c.deleteFlow({ currentTarget: { dataset: { id: "user/x" } } });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Mine"));
    expect(fetchMock).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await c.deleteFlow({ currentTarget: { dataset: { id: "user/x" } } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/flows/user%2Fx?repoId=repo-b");
    expect(init.method).toBe("DELETE");
    expect(c.state.flowDetails["user/x"]).toBeUndefined();
    expect(c.navigate).toHaveBeenCalledWith({ view: "flows", repoId: "repo-b" });
    expect(c.fetchFlowCatalog).toHaveBeenCalledWith("repo-b");
  });

  it("delete surfaces API errors and keeps the Flow", async () => {
    const c = await flowComponent([...helpers, "flowRoute", "deleteFlow"]);
    c.state = { flowRepoId: "", flowDetails: { "user/x": { name: "Mine", source: "user" } } };
    c.navigate = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: { code: "forbidden", message: "not yours" } }) })));
    vi.stubGlobal("window", { confirm: () => true });
    await c.deleteFlow({ currentTarget: { dataset: { id: "user/x" } } });
    expect(c.state.flowManageError).toBe("not yours");
    expect(c.state.flowDetails["user/x"]).toBeDefined();
    expect(c.navigate).not.toHaveBeenCalled();
  });

  describe("Planner and New Task template pickers", () => {
    const repos = [
      { id: "repo-a", name: "A" },
      { id: "repo-b", name: "B" },
      { id: "repo-c", name: "C" },
      { id: "repo-d", name: "D" },
    ];

    function taskTemplate(id: string, name: string, document: string) {
      return {
        id,
        name,
        document,
        flowPath: `flows/${id}.json`,
        inputs: [{ id: "spec" }, { id: "tech-design" }],
      };
    }

    function sliceBetween(html: string, start: string, end: string) {
      const from = html.indexOf(start);
      const to = html.indexOf(end, from + start.length);
      expect(from).toBeGreaterThan(-1);
      expect(to).toBeGreaterThan(from);
      return html.slice(from, to);
    }

    async function picker() {
      const c = await flowComponent([
        ...helpers,
        "taskFormFlowTemplates",
        "selectPlannerRepository",
        "selectNewTaskRepository",
        "ensurePlannerRepository",
        "toggleNewTask",
      ]);
      c.state = {
        repositories: repos,
        plannerTemplateRepoId: "",
        plannerTemplates: null,
        newTaskTemplateRepoId: "",
        newTaskTemplates: null,
        showNewTask: false,
        flowRepoId: "repo-flows",
        flowTemplates: [{ id: "flow-page" }],
      };
      return c;
    }

    function formStub(fields: Record<string, string>) {
      const nodes: Record<string, { value: string; checked: boolean; focus: () => void }> = {};
      return {
        fields,
        reset() {},
        querySelector(selector: string) {
          nodes[selector] ??= { value: "", checked: false, focus() {} };
          return nodes[selector];
        },
      };
    }

    it("renders each form from its own repository and template list", async () => {
      const html = await readFile(consolePath, "utf8");
      const planner = sliceBetween(html, 'ref="{{ plannerForm }}"', "</form>");
      const drawer = sliceBetween(html, 'ref="{{ newTaskForm }}"', "</form>");
      expect(planner).toContain('value="{{ plannerTemplateRepoId }}"');
      expect(planner).toContain('onChange="{{ selectPlannerRepository }}"');
      expect(planner).toContain('list="{{ plannerFlowTemplates }}"');
      expect(planner).not.toContain("newTask");
      expect(drawer).toContain('value="{{ newTaskTemplateRepoId }}"');
      expect(drawer).toContain('onChange="{{ selectNewTaskRepository }}"');
      expect(drawer).toContain('list="{{ newTaskFlowTemplates }}"');
      expect(drawer).not.toContain("planner");
      expect(html).not.toContain("selectTaskRepository");
      expect(html).not.toContain("taskFlowTemplates");
      expect(html).not.toContain("taskTemplateRepoId");
    });

    it("initializes the Planner from the first repository and preserves a later selection", async () => {
      const c = await picker();
      const paths: string[] = [];
      c.api = async (path: string) => {
        paths.push(path);
        return { templates: [taskTemplate("a-t", "A template", "doc-a")] };
      };
      await c.ensurePlannerRepository();
      expect(paths).toEqual(["/api/flows/templates?repoId=repo-a"]);
      expect(c.state.plannerTemplateRepoId).toBe("repo-a");
      expect(c.state.plannerTemplates).toEqual([taskTemplate("a-t", "A template", "doc-a")]);
      expect(c.taskFormFlowTemplates(c.state.plannerTemplates)).toEqual(c.state.plannerTemplates);
      expect(c.state.newTaskTemplateRepoId).toBe("");
      expect(c.state.newTaskTemplates).toBeNull();
      expect(c.state.flowRepoId).toBe("repo-flows");
      expect(c.state.flowTemplates).toEqual([{ id: "flow-page" }]);

      paths.length = 0;
      c.state.plannerTemplateRepoId = "repo-b";
      c.state.plannerTemplates = [taskTemplate("b-t", "B template", "doc-b")];
      await c.ensurePlannerRepository();
      expect(paths).toEqual([]);
      expect(c.state.plannerTemplateRepoId).toBe("repo-b");
      expect(c.state.plannerTemplates).toEqual([taskTemplate("b-t", "B template", "doc-b")]);

      c.state.repositories = [{ id: "repo-a", name: "A" }];
      c.state.plannerTemplateRepoId = "repo-gone";
      await c.ensurePlannerRepository();
      expect(c.state.plannerTemplateRepoId).toBe("repo-a");
      expect(paths).toEqual(["/api/flows/templates?repoId=repo-a"]);
    });

    it("loads Planner templates after repositories load, without resetting a valid selection", async () => {
      const c = await flowComponent([
        ...helpers,
        "dashboardApiPath",
        "dashboardFromResponse",
        "fetchData",
        "ensurePlannerRepository",
        "selectPlannerRepository",
      ]);
      c.showSyncIndicatorWhenSlow = () => {};
      c.hideSyncIndicator = () => {};
      c.state = {
        dashboardFilters: {},
        flowRepoId: "",
        repositories: [],
        plannerTemplateRepoId: "",
        plannerTemplates: null,
        newTaskTemplateRepoId: "repo-b",
        newTaskTemplates: [taskTemplate("kept", "Kept", "kept")],
        flowTemplates: [{ id: "home-t" }],
      };
      const paths: string[] = [];
      c.api = async (path: string) => {
        if (path === "/api/repositories") return { repositories: [{ id: "repo-a" }, { id: "repo-b" }] };
        if (path.startsWith("/api/flows/templates")) {
          paths.push(path);
          const id = path.includes("repo-a") ? "a-t" : "home-t";
          return { templates: [taskTemplate(id, id, id)] };
        }
        return {};
      };
      await c.fetchData();
      expect(c.state.plannerTemplateRepoId).toBe("repo-a");
      expect(c.state.plannerTemplates).toEqual([taskTemplate("a-t", "a-t", "a-t")]);
      expect(paths).toContain("/api/flows/templates?repoId=repo-a");
      expect(c.state.newTaskTemplateRepoId).toBe("repo-b");
      expect(c.state.newTaskTemplates).toEqual([taskTemplate("kept", "Kept", "kept")]);

      paths.length = 0;
      c.state.plannerTemplateRepoId = "repo-b";
      c.state.plannerTemplates = [taskTemplate("b-t", "B template", "doc-b")];
      await c.fetchData();
      expect(c.state.plannerTemplateRepoId).toBe("repo-b");
      expect(c.state.plannerTemplates).toEqual([taskTemplate("b-t", "B template", "doc-b")]);
      expect(paths.some((path) => path.includes("repoId="))).toBe(false);
    });

    it("opening New Task does not change the Planner or the Flows page", async () => {
      const c = await picker();
      c.state.plannerTemplateRepoId = "repo-b";
      c.state.plannerTemplates = [taskTemplate("b-template", "B", "doc-b")];
      const paths: string[] = [];
      c.api = async (path: string) => {
        paths.push(path);
        return { templates: [taskTemplate("a-template", "A", "doc-a")] };
      };
      await c.toggleNewTask();
      expect(c.state.showNewTask).toBe(true);
      expect(paths).toEqual(["/api/flows/templates?repoId=repo-a"]);
      expect(c.state.newTaskTemplateRepoId).toBe("repo-a");
      expect(c.state.newTaskTemplates).toEqual([taskTemplate("a-template", "A", "doc-a")]);
      expect(c.state.plannerTemplateRepoId).toBe("repo-b");
      expect(c.state.plannerTemplates).toEqual([taskTemplate("b-template", "B", "doc-b")]);
      expect(c.state.flowRepoId).toBe("repo-flows");
      expect(c.state.flowTemplates).toEqual([{ id: "flow-page" }]);
    });

    it("changing New Task repository does not change the Planner", async () => {
      const c = await picker();
      c.state.plannerTemplateRepoId = "repo-b";
      c.state.plannerTemplates = [taskTemplate("b-template", "B", "doc-b")];
      c.state.newTaskTemplateRepoId = "repo-a";
      c.state.newTaskTemplates = [taskTemplate("a-template", "A", "doc-a")];
      c.state.showNewTask = true;
      c.api = async () => ({ templates: [taskTemplate("c-template", "C", "doc-c")] });
      await c.selectNewTaskRepository({ currentTarget: { value: "repo-c" } });
      expect(c.state.newTaskTemplateRepoId).toBe("repo-c");
      expect(c.state.newTaskTemplates).toEqual([taskTemplate("c-template", "C", "doc-c")]);
      expect(c.state.plannerTemplateRepoId).toBe("repo-b");
      expect(c.state.plannerTemplates).toEqual([taskTemplate("b-template", "B", "doc-b")]);
      expect(c.state.flowTemplates).toEqual([{ id: "flow-page" }]);
    });

    it("changing the Planner repository does not change New Task", async () => {
      const c = await picker();
      c.state.plannerTemplateRepoId = "repo-b";
      c.state.plannerTemplates = [taskTemplate("b-template", "B", "doc-b")];
      c.state.newTaskTemplateRepoId = "repo-a";
      c.state.newTaskTemplates = [taskTemplate("a-template", "A", "doc-a")];
      c.api = async () => ({ templates: [taskTemplate("c-template", "C", "doc-c")] });
      await c.selectPlannerRepository({ currentTarget: { value: "repo-c" } });
      expect(c.state.plannerTemplateRepoId).toBe("repo-c");
      expect(c.state.plannerTemplates).toEqual([taskTemplate("c-template", "C", "doc-c")]);
      expect(c.state.newTaskTemplateRepoId).toBe("repo-a");
      expect(c.state.newTaskTemplates).toEqual([taskTemplate("a-template", "A", "doc-a")]);
      expect(c.state.flowRepoId).toBe("repo-flows");
    });

    it("drops late template responses independently for each form", async () => {
      const c = await picker();
      const resolvers: Array<(value: unknown) => void> = [];
      c.api = () => new Promise((resolve) => { resolvers.push(resolve); });

      const plannerSlow = c.selectPlannerRepository({ currentTarget: { value: "repo-b" } });
      const newTaskSlow = c.selectNewTaskRepository({ currentTarget: { value: "repo-d" } });
      const plannerFast = c.selectPlannerRepository({ currentTarget: { value: "repo-c" } });
      const newTaskFast = c.selectNewTaskRepository({ currentTarget: { value: "repo-a" } });
      resolvers[2]({ templates: [taskTemplate("c-fast", "C", "doc-c")] });
      resolvers[3]({ templates: [taskTemplate("a-fast", "A", "doc-a")] });
      await plannerFast;
      await newTaskFast;
      resolvers[0]({ templates: [taskTemplate("b-late", "B late", "doc-b-late")] });
      resolvers[1]({ templates: [taskTemplate("d-late", "D late", "doc-d-late")] });
      await plannerSlow;
      await newTaskSlow;

      expect(c.state.plannerTemplateRepoId).toBe("repo-c");
      expect(c.state.plannerTemplates).toEqual([taskTemplate("c-fast", "C", "doc-c")]);
      expect(c.state.newTaskTemplateRepoId).toBe("repo-a");
      expect(c.state.newTaskTemplates).toEqual([taskTemplate("a-fast", "A", "doc-a")]);
    });

    it("does not accept a stale response just because the other form selected that repository", async () => {
      const c = await picker();
      const resolvers: Array<(value: unknown) => void> = [];
      c.api = () => new Promise((resolve) => { resolvers.push(resolve); });

      const plannerSlow = c.selectPlannerRepository({ currentTarget: { value: "repo-b" } });
      const plannerFast = c.selectPlannerRepository({ currentTarget: { value: "repo-c" } });
      const newTask = c.selectNewTaskRepository({ currentTarget: { value: "repo-b" } });
      resolvers[1]({ templates: [taskTemplate("planner-c", "Planner C", "doc-c")] });
      resolvers[2]({ templates: [taskTemplate("new-task-b", "New Task B", "doc-b")] });
      await plannerFast;
      await newTask;
      resolvers[0]({ templates: [taskTemplate("planner-b-late", "Stale B", "doc-stale")] });
      await plannerSlow;

      expect(c.state.plannerTemplateRepoId).toBe("repo-c");
      expect(c.state.plannerTemplates).toEqual([taskTemplate("planner-c", "Planner C", "doc-c")]);
      expect(c.state.newTaskTemplateRepoId).toBe("repo-b");
      expect(c.state.newTaskTemplates).toEqual([taskTemplate("new-task-b", "New Task B", "doc-b")]);
    });

    it("shows each repository's own copy when both forms use the same template id", async () => {
      const c = await picker();
      c.api = async (path: string) => ({
        templates: [taskTemplate("dev-pr", path.includes("repo-b") ? "Variant B" : "Variant A", path.includes("repo-b") ? "document-b" : "document-a")],
      });
      await c.selectPlannerRepository({ currentTarget: { value: "repo-b" } });
      await c.selectNewTaskRepository({ currentTarget: { value: "repo-a" } });
      expect(c.taskFormFlowTemplates(c.state.plannerTemplates)).toEqual([
        taskTemplate("dev-pr", "Variant B", "document-b"),
      ]);
      expect(c.taskFormFlowTemplates(c.state.newTaskTemplates)).toEqual([
        taskTemplate("dev-pr", "Variant A", "document-a"),
      ]);
    });

    it("submits each form's own repository and template together", async () => {
      const c = await flowComponent([
        ...helpers,
        "taskFormFlowTemplates",
        "planWork",
        "createTask",
        "executionOverrides",
      ]);
      c.state = {
        plannerTemplateRepoId: "repo-b",
        plannerTemplates: [taskTemplate("dev-pr", "Variant B", "document-b")],
        newTaskTemplateRepoId: "repo-a",
        newTaskTemplates: [taskTemplate("dev-pr", "Variant A", "document-a")],
        showNewTask: true,
      };
      c.plannerForm = { current: formStub({ sourceType: "prompt", intake: "ship the fix", repoId: "repo-b", templateId: "dev-pr", title: "", guidance: "", documentBody: "", documentVersion: "" }) };
      c.newTaskForm = { current: formStub({ title: "Independent task", repoId: "repo-a", templateId: "dev-pr", issueUrl: "", spec: "spec", techDesign: "design" }) };
      c.fetchData = vi.fn(async () => {});
      c.navigate = vi.fn();
      c.refresh = vi.fn(async () => {});
      const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
      c.api = async (path: string, options: { body: string }) => {
        bodies.push({ path, body: JSON.parse(options.body) });
        return { task: { id: "task-1" } };
      };
      vi.stubGlobal("FormData", class {
        form: { fields: Record<string, string> };
        constructor(form: { fields: Record<string, string> }) { this.form = form; }
        entries() { return Object.entries(this.form.fields); }
      });

      await c.planWork({ preventDefault() {} });
      await c.createTask({ preventDefault() {} });

      expect(bodies[0]).toEqual({
        path: "/api/draft-specs",
        body: expect.objectContaining({ repoId: "repo-b", templateId: "dev-pr", prompt: "ship the fix" }),
      });
      expect(bodies[1]).toEqual({
        path: "/api/tasks",
        body: expect.objectContaining({ repoId: "repo-a", templateId: "dev-pr", title: "Independent task" }),
      });
      expect(c.taskFormFlowTemplates(c.state.plannerTemplates)[0].name).toBe("Variant B");
      expect(c.taskFormFlowTemplates(c.state.newTaskTemplates)[0].name).toBe("Variant A");
    });
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

describe("console run resume", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function resumeComponent(runId: string | null) {
    const c = await flowComponent(["flowErrorMessage", "networkErrorMessage", "resumeRun"]);
    c.state = { selectedRunId: runId, runActionError: "" };
    c.fetchRunDetail = vi.fn(async () => {});
    return c;
  }

  it("posts resume for the displayed run and refreshes it", async () => {
    const c = await resumeComponent("run-1");
    const fetchMock = vi.fn(async () => ({ ok: true, status: 202, json: async () => ({ runId: "run-1" }) }));
    vi.stubGlobal("fetch", fetchMock);
    await c.resumeRun();
    expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-1/resume", { method: "POST", credentials: "same-origin" });
    expect(c.fetchRunDetail).toHaveBeenCalledWith("run-1", { force: true });
    expect(c.state.runActionError).toBe("");
  });

  it("shows why the server refused the resume instead of doing nothing", async () => {
    const c = await resumeComponent("run-1");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: { message: "run is already being resumed" } }),
    })));
    await c.resumeRun();
    expect(c.state.runActionError).toBe("run is already being resumed");
    expect(c.fetchRunDetail).not.toHaveBeenCalled();
  });

  it("cancels the displayed run with the operator's reason, or not at all", async () => {
    const c = await flowComponent(["flowErrorMessage", "networkErrorMessage", "cancelRun"]);
    c.state = { selectedRunId: "run-1", runActionError: "" };
    c.fetchRunDetail = vi.fn(async () => {});
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ runId: "run-1", status: "cancelled" }) }));
    vi.stubGlobal("fetch", fetchMock);

    vi.stubGlobal("window", { prompt: () => null });
    await c.cancelRun();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubGlobal("window", { prompt: () => "  stuck on a bad key  " });
    await c.cancelRun();
    expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-1/cancel", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "stuck on a bad key" }),
    });
    expect(c.fetchRunDetail).toHaveBeenCalledWith("run-1", { force: true });
  });

  it("reports a resume or cancel that never reached the server", async () => {
    const resume = await flowComponent(["flowErrorMessage", "networkErrorMessage", "resumeRun"]);
    resume.state = { selectedRunId: "run-1", runActionError: "" };
    resume.fetchRunDetail = vi.fn(async () => {});
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(resume.resumeRun()).resolves.toBeUndefined();
    expect(resume.state.runActionError).toBe(
      "Resume request did not reach the server: Failed to fetch. Check the connection and try again.",
    );
    expect(resume.fetchRunDetail).not.toHaveBeenCalled();

    const cancel = await flowComponent(["flowErrorMessage", "networkErrorMessage", "cancelRun"]);
    cancel.state = { selectedRunId: "run-1", runActionError: "" };
    cancel.fetchRunDetail = vi.fn(async () => {});
    vi.stubGlobal("window", { prompt: () => "stop" });
    await expect(cancel.cancelRun()).resolves.toBeUndefined();
    expect(cancel.state.runActionError).toMatch(/^Cancel request did not reach the server/);
    expect(cancel.fetchRunDetail).not.toHaveBeenCalled();
  });
});
