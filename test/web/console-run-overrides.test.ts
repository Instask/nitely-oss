import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const consolePath = join(process.cwd(), "src/web/static/console.dc.html");

function extractMember(source: string, name: string): string {
  const markers = [`  ${name} = async (`, `  ${name} = (`, `  async ${name}(`, `  ${name}(`];
  const marker = markers.find((value) => source.includes(value));
  if (!marker) throw new Error(`member not found: ${name}`);
  const start = source.indexOf(marker);
  const brace = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) {
      return source.slice(start, index + 1).trim()
        .replace(new RegExp(`^${name} = async \\((\\w*)\\) => \\{`), `async ${name}($1) {`)
        .replace(new RegExp(`^${name} = \\((\\w*)\\) => \\{`), `${name}($1) {`);
    }
  }
  throw new Error(`unterminated member: ${name}`);
}

async function component(members: string[]) {
  const html = await readFile(consolePath, "utf8");
  const body = members.map((name) => extractMember(html, name)).join(",\n");
  const result = new Function(`return ({ ${body} });`)() as Record<string, any>;
  result.setState = (patch: Record<string, unknown>) => { result.state = { ...result.state, ...patch }; };
  result.fetchData = vi.fn();
  result.navigate = vi.fn();
  result.api = vi.fn(async () => ({ runId: "run-1" }));
  return result;
}

function stubForm(data: Record<string, unknown>) {
  vi.stubGlobal("FormData", class {
    entries() { return Object.entries(data); }
  });
  return { reset: vi.fn(), querySelector: vi.fn() };
}

const event = () => ({ preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: { dataset: { id: "task/1" } } });

describe("Console execution selection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders labeled runtime/model/effort/question controls on new task and Run", async () => {
    const html = await readFile(consolePath, "utf8");
    expect(html.match(/name="runtime"/g)).toHaveLength(2);
    expect(html.match(/name="model"/g)).toHaveLength(2);
    expect(html.match(/name="effort"/g)).toHaveLength(2);
    expect(html.match(/name="questions"/g)).toHaveLength(2);
    expect(html.match(/<option value="">As defined in Flow<\/option>/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('this.api("/api/runtimes")');
    expect(html).toContain('aria-labelledby="run-options-title"');
    expect(html).toContain("selectedRun.effectiveRuntimeLabel");
  });

  it("opens Run options without starting a run and discards a previous readiness reason", async () => {
    const c = await component(["startRun"]);
    c.state = { runOptionsReason: "old reason" };
    c.startRun(event());
    expect(c.state).toMatchObject({ runOptionsTaskId: "task/1", runOptionsReason: null });
    expect(c.api).not.toHaveBeenCalled();
  });

  it("sends only explicit per-run fields so task defaults still merge on the server", async () => {
    const c = await component(["executionOverrides", "submitRunOptions"]);
    c.state = { runOptionsTaskId: "task/1", runOptionsReason: null, tasks: [{ id: "task/1", overrides: { runtime: "claude", effort: "high" } }] };
    c.runOptionsForm = { current: stubForm({ runtime: "", model: "  model-b  ", effort: "", questions: "auto" }) };
    await c.submitRunOptions(event());
    expect(c.api).toHaveBeenCalledWith("/api/tasks/task%2F1/runs", expect.objectContaining({
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ overrides: { model: "model-b", questions: "auto" } }),
    }));
    expect(c.state.runOptionsTaskId).toBeNull();
  });

  it("omits an empty override object and preserves readiness acknowledgement with selection", async () => {
    const c = await component(["executionOverrides", "submitRunOptions"]);
    c.state = { runOptionsTaskId: "task/1", runOptionsReason: null };
    c.runOptionsForm = { current: stubForm({ runtime: "", model: "", effort: "", questions: "" }) };
    await c.submitRunOptions(event());
    expect(JSON.parse(c.api.mock.calls[0][1].body)).toEqual({});
    c.state = { runOptionsTaskId: "task/1", runOptionsReason: "operator accepted readiness" };
    c.runOptionsForm = { current: stubForm({ runtime: "codex", effort: "off" }) };
    await c.submitRunOptions(event());
    expect(c.api).toHaveBeenLastCalledWith("/api/tasks/task%2F1/runs?override=true", expect.objectContaining({
      body: JSON.stringify({ overrides: { runtime: "codex", effort: "off" }, reason: "operator accepted readiness" }),
    }));
  });

  it("keeps the run options open after a rejected request", async () => {
    const c = await component(["executionOverrides", "submitRunOptions"]);
    c.state = { runOptionsTaskId: "task/1", runOptionsReason: null };
    c.runOptionsForm = { current: stubForm({ runtime: "codex" }) };
    c.api.mockResolvedValue(null);
    await c.submitRunOptions(event());
    expect(c.state.runOptionsTaskId).toBe("task/1");
    expect(c.navigate).not.toHaveBeenCalled();
  });

  it("stores new task defaults in the shared overrides object instead of top-level fields", async () => {
    const c = await component(["executionOverrides", "createTask"]);
    c.state = {};
    const form = stubForm({ title: "Task", repoId: "repo", runtime: "codex", model: "model-a", effort: "off", questions: "deny" });
    c.newTaskForm = { current: form };
    c.refresh = vi.fn();
    await c.createTask(event());
    expect(JSON.parse(c.api.mock.calls[0][1].body)).toEqual({
      title: "Task", repoId: "repo", overrides: { runtime: "codex", model: "model-a", effort: "off", questions: "deny" },
    });
    expect(form.reset).toHaveBeenCalled();
  });

  it("shows actual attempt runtime/model/native effort rather than task requests", async () => {
    const c = await component(["effectiveRuntimeLabel"]);
    expect(c.effectiveRuntimeLabel({ runtime: "pi", model: "actual", requestedEffort: "high", nativeEffort: "medium" })).toContain("pi · actual · effort medium");
    expect(c.effectiveRuntimeLabel({ process: { runtime: "codex", model: "actual" }, requestedEffort: "off" })).toBe("codex · actual · effort off");
    expect(c.effectiveRuntimeLabel({})).toBe("");
  });

  it("shows stored defaults while keeping blank run fields inheriting them", async () => {
    const c = await component(["runTaskDefaultsLabel"]);
    c.state = { runOptionsTaskId: "task/1", tasks: [], taskDetails: { "task/1": { task: { overrides: { runtime: "claude", effort: "high", questions: "ask" } } } } };
    expect(c.runTaskDefaultsLabel()).toBe("runtime=claude · effort=high · questions=ask");
  });
});
