import type { ProviderStatus } from "./providers.js";
import type { WebRunDetail, WebRunSummary } from "./runs.js";
import type { TaskDetail, TaskRecord } from "./tasks.js";

// Legacy compatibility render helpers. The active Web Console server serves
// src/web/static/console.dc.html for shipped routes instead of these helpers.
export interface ConsoleRenderInput {
  tasks: TaskRecord[];
  runs: WebRunSummary[];
  providers: ProviderStatus[];
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function jsonScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function shell(title: string, active: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f6f1;
      --panel: #fffdfa;
      --ink: #25231f;
      --muted: #706b61;
      --line: #ded8cc;
      --accent: #31675b;
      --accent-ink: #f9fffb;
      --warn: #9a4f1f;
      --ok: #2f7356;
      --bad: #9b2f36;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-size: 15px;
      line-height: 1.45;
    }
    a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 3px; }
    .layout {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 240px minmax(0, 1fr);
    }
    aside {
      border-right: 1px solid var(--line);
      padding: 24px 18px;
      background: #efebe2;
    }
    .brand {
      font-size: 20px;
      font-weight: 750;
      margin-bottom: 24px;
      letter-spacing: 0;
    }
    nav { display: grid; gap: 6px; }
    nav a {
      display: block;
      padding: 9px 10px;
      border-radius: 6px;
      color: var(--ink);
      text-decoration: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    nav a.active { background: var(--panel); border: 1px solid var(--line); }
    main {
      min-width: 0;
      padding: clamp(18px, 4vw, 40px);
    }
    .topline {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 22px;
    }
    h1 { margin: 0; font-size: clamp(26px, 3vw, 38px); line-height: 1.1; letter-spacing: 0; }
    h2 { margin: 30px 0 12px; font-size: 18px; letter-spacing: 0; }
    .muted { color: var(--muted); }
    .grid { display: grid; gap: 18px; grid-template-columns: minmax(0, 1.2fr) minmax(320px, .8fr); align-items: start; }
    .detail-grid { display: grid; gap: 18px; grid-template-columns: minmax(0, 1fr) minmax(280px, 360px); align-items: start; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      min-width: 0;
    }
    form { display: grid; gap: 12px; }
    label { display: grid; gap: 5px; font-weight: 650; }
    input, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
      padding: 9px 10px;
      font: inherit;
      min-width: 0;
    }
    textarea { min-height: 120px; resize: vertical; }
    button {
      border: 1px solid var(--accent);
      background: var(--accent);
      color: var(--accent-ink);
      border-radius: 6px;
      padding: 9px 12px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      min-width: 0;
    }
    button.secondary {
      color: var(--accent);
      background: transparent;
    }
    .table { display: grid; gap: 8px; }
    .row {
      display: grid;
      grid-template-columns: minmax(180px, 1.6fr) minmax(80px, .6fr) minmax(120px, .8fr) minmax(110px, .7fr);
      gap: 12px;
      align-items: center;
      padding: 10px 0;
      border-bottom: 1px solid var(--line);
      min-width: 0;
    }
    .cell { min-width: 0; overflow-wrap: anywhere; }
    .title { font-weight: 700; }
    .badge {
      display: inline-block;
      width: fit-content;
      max-width: 100%;
      padding: 3px 7px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    .configured { color: var(--ok); }
    .missing { color: var(--bad); }
    pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: #24221e;
      color: #fbf8ef;
      border-radius: 8px;
      padding: 12px;
      overflow: auto;
      max-height: 460px;
    }
    .empty {
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 18px;
      color: var(--muted);
      background: color-mix(in srgb, var(--panel) 60%, transparent);
    }
    .status { min-height: 20px; color: var(--warn); overflow-wrap: anywhere; }
    .meta { display: grid; gap: 8px; }
    .actions { margin-top: 16px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    @media (max-width: 860px) {
      .layout { grid-template-columns: 1fr; }
      aside { border-right: 0; border-bottom: 1px solid var(--line); padding: 14px 16px; }
      .brand { margin-bottom: 10px; }
      nav { display: flex; overflow-x: auto; }
      nav a { flex: 0 0 auto; }
      .grid, .detail-grid { grid-template-columns: 1fr; }
      .row { grid-template-columns: 1fr; gap: 5px; }
    }
  </style>
</head>
<body>
  <div class="layout">
    <aside>
      <div class="brand">Nitely Console</div>
      <nav>
        <a class="${active === "tasks" ? "active" : ""}" href="/tasks">Tasks</a>
        <a class="${active === "runs" ? "active" : ""}" href="/runs">Runs</a>
        <a class="${active === "providers" ? "active" : ""}" href="/providers">Providers</a>
      </nav>
    </aside>
    <main>${body}</main>
  </div>
</body>
</html>`;
}

function taskRows(tasks: TaskRecord[]): string {
  if (tasks.length === 0) {
    return `<div class="empty">No tasks yet. Create one with a specification and technical design.</div>`;
  }
  return `<div class="table">${tasks
    .map(
      (task) => `<div class="row">
  <div class="cell"><div class="title"><a href="/tasks/${encodeURIComponent(task.id)}">${escapeHtml(task.title)}</a></div><div class="muted">${escapeHtml(task.issueUrl ?? "No issue URL")}</div></div>
  <div class="cell"><span class="badge">${escapeHtml(task.status)}</span></div>
  <div class="cell">${escapeHtml(task.createdAt)}</div>
  <div class="cell">${
    task.latestRunId
      ? `<a href="/runs/${encodeURIComponent(task.latestRunId)}">${escapeHtml(task.latestRunId)}</a>`
      : `<form data-start-run="${escapeHtml(task.id)}"><button class="secondary" type="submit">Start run</button></form>`
  }${task.changeRequestUrl ? `<div><a href="${escapeHtml(task.changeRequestUrl)}">Change request</a></div>` : ""}</div>
</div>`,
    )
    .join("")}</div>`;
}

function runRows(runs: WebRunSummary[]): string {
  if (runs.length === 0) {
    return `<div class="empty">No runs found under .nitely/runs.</div>`;
  }
  return `<div class="table">${runs
    .map(
      (run) => `<div class="row">
  <div class="cell"><div class="title"><a href="/runs/${encodeURIComponent(run.runId)}">${escapeHtml(run.runId)}</a></div><div class="muted">${escapeHtml(run.flowName ?? "Unknown flow")}</div></div>
  <div class="cell"><span class="badge">${escapeHtml(run.status)}</span><div class="muted">${escapeHtml(run.completedStages.length)} stages</div></div>
  <div class="cell">${escapeHtml(run.branchName ?? "No branch")}</div>
  <div class="cell">${run.changeRequestUrl ? `<a href="${escapeHtml(run.changeRequestUrl)}">Change request</a>` : "No change request"}</div>
</div>`,
    )
    .join("")}</div>`;
}

function providerRows(providers: ProviderStatus[]): string {
  return `<div class="table">${providers
    .map(
      (provider) => `<div class="row">
  <div class="cell"><div class="title">${escapeHtml(provider.name)}</div><div class="muted">${escapeHtml(provider.hints.join(", "))}</div></div>
  <div class="cell ${provider.configured ? "configured" : "missing"}">${provider.configured ? "Configured" : "Missing"}</div>
  <div class="cell">${escapeHtml(provider.message)}</div>
  <div class="cell"></div>
</div>`,
    )
    .join("")}</div>`;
}

export function renderConsole(input: ConsoleRenderInput): string {
  const body = `<div class="topline"><h1>Tasks</h1><span class="muted">${escapeHtml(input.tasks.length)} tasks, ${escapeHtml(input.runs.length)} runs</span></div>
<div class="grid">
  <section class="panel">
    <h2>Task List</h2>
    ${taskRows(input.tasks)}
  </section>
  <section class="panel">
    <h2>Create Task</h2>
    <form id="create-task">
      <label>Title <input name="title" autocomplete="off" required></label>
      <label>GitHub issue URL <input name="issueUrl" autocomplete="off"></label>
      <label>Specification <textarea name="spec" required></textarea></label>
      <label>Technical design <textarea name="techDesign" required></textarea></label>
      <label>Flow <input name="flowPath" value="flows/implement-spec-bootstrap.json"></label>
      <button type="submit">Create task</button>
      <div class="status" id="form-status"></div>
    </form>
  </section>
</div>
<section>
  <h2>Recent Runs</h2>
  ${runRows(input.runs)}
</section>
<section>
  <h2>Providers</h2>
  ${providerRows(input.providers)}
</section>
<script type="application/json" id="console-data">${jsonScript(input)}</script>
<script>
const form = document.querySelector("#create-task");
const status = document.querySelector("#form-status");
form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  status.textContent = "Creating task...";
  const response = await fetch("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data)
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    status.textContent = body.error?.message || "Task creation failed";
    return;
  }
  location.reload();
});
document.querySelectorAll("form[data-start-run]").forEach((runForm) => {
  runForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const taskId = runForm.getAttribute("data-start-run");
    const button = runForm.querySelector("button");
    if (button) button.textContent = "Running...";
    const response = await fetch("/api/tasks/" + encodeURIComponent(taskId) + "/runs", { method: "POST" });
    if (!response.ok && button) button.textContent = "Run failed";
    if (response.ok) location.reload();
  });
});
</script>`;
  return shell("Nitely Console", "tasks", body);
}

function startRunForm(task: TaskRecord): string {
  if (task.status === "running") {
    return `<span class="badge">running</span>`;
  }
  if (task.latestRunId) {
    return "";
  }
  return `<form data-start-run="${escapeHtml(task.id)}"><button class="secondary" type="submit">Start run</button></form>`;
}

function taskDetailScript(): string {
  return `<script>
document.querySelectorAll("form[data-start-run]").forEach((runForm) => {
  runForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const taskId = runForm.getAttribute("data-start-run");
    const button = runForm.querySelector("button");
    if (button) button.textContent = "Running...";
    const response = await fetch("/api/tasks/" + encodeURIComponent(taskId) + "/runs", { method: "POST" });
    if (!response.ok && button) button.textContent = "Run failed";
    if (response.ok) location.reload();
  });
});
</script>`;
}

export function renderTaskDetail(
  detail: TaskDetail,
  runs: WebRunSummary[] = [],
): string {
  const { task } = detail;
  const latestRun = task.latestRunId
    ? runs.find((run) => run.runId === task.latestRunId)
    : undefined;
  const latestRunBody = task.latestRunId
    ? `<div><strong>Run:</strong> <a href="/runs/${encodeURIComponent(task.latestRunId)}">${escapeHtml(task.latestRunId)}</a></div>
  <div><strong>Status:</strong> ${escapeHtml(latestRun?.status ?? "unknown")}</div>
  <div><strong>Completed stages:</strong> ${escapeHtml(latestRun?.completedStages.join(", ") || "None")}</div>`
    : `<div class="empty">No run has been started for this task.</div>`;
  const body = `<div class="topline"><h1>${escapeHtml(task.title)}</h1><a href="/tasks">Tasks</a></div>
<div class="detail-grid">
  <section>
    <h2>Specification</h2>
    <pre>${escapeHtml(detail.spec)}</pre>
    <h2>Technical Design</h2>
    <pre>${escapeHtml(detail.techDesign)}</pre>
  </section>
  <section class="panel">
    <h2>Metadata</h2>
    <div class="meta">
      <div><strong>Status:</strong> <span class="badge">${escapeHtml(task.status)}</span></div>
      <div><strong>Task ID:</strong> ${escapeHtml(task.id)}</div>
      <div><strong>Flow:</strong> ${escapeHtml(task.flowPath)}</div>
      <div><strong>Spec:</strong> ${escapeHtml(task.specPath)}</div>
      <div><strong>Technical design:</strong> ${escapeHtml(task.techDesignPath)}</div>
      <div><strong>Created:</strong> ${escapeHtml(task.createdAt)}</div>
      <div><strong>Updated:</strong> ${escapeHtml(task.updatedAt)}</div>
      <div><strong>Issue:</strong> ${task.issueUrl ? `<a href="${escapeHtml(task.issueUrl)}">${escapeHtml(task.issueUrl)}</a>` : "None"}</div>
      <div><strong>Change request:</strong> ${task.changeRequestUrl ? `<a href="${escapeHtml(task.changeRequestUrl)}">${escapeHtml(task.changeRequestUrl)}</a>` : "None"}</div>
    </div>
    <div class="actions">${startRunForm(task)}</div>
    <h2>Latest Run</h2>
    <div class="meta">${latestRunBody}</div>
  </section>
</div>
${taskDetailScript()}`;
  return shell(`Nitely Task ${task.title}`, "tasks", body);
}

export function renderRunsPage(runs: WebRunSummary[]): string {
  return shell(
    "Nitely Runs",
    "runs",
    `<div class="topline"><h1>Runs</h1><span class="muted">${escapeHtml(runs.length)} local runs</span></div>${runRows(runs)}`,
  );
}

export function renderRunDetail(run: WebRunDetail): string {
  const logs =
    run.logs.length === 0
      ? `<div class="empty">No stage logs found for this run.</div>`
      : run.logs
          .map(
            (log) => `<h2>${escapeHtml(log.stageId)} attempt ${escapeHtml(log.attempt)}</h2>
${log.stdout ? `<pre>${escapeHtml(log.stdout)}</pre>` : ""}
${log.stderr ? `<pre>${escapeHtml(log.stderr)}</pre>` : ""}`,
          )
          .join("");
  const body = `<div class="topline"><h1>${escapeHtml(run.runId)}</h1><a href="/runs">Runs</a></div>
<section class="panel">
  <div><strong>Status:</strong> <span class="badge">${escapeHtml(run.status)}</span></div>
  <div><strong>Flow:</strong> ${escapeHtml(run.flowName ?? "Unknown")}</div>
  <div><strong>Branch:</strong> ${escapeHtml(run.branchName ?? "None")}</div>
  <div><strong>Worktree:</strong> ${escapeHtml(run.worktreePath ?? "None")}</div>
  <div><strong>Completed stages:</strong> ${escapeHtml(run.completedStages.join(", ") || "None")}</div>
  <div><strong>Change request:</strong> ${run.changeRequestUrl ? `<a href="${escapeHtml(run.changeRequestUrl)}">${escapeHtml(run.changeRequestUrl)}</a>` : "None"}</div>
</section>
<h2>Inputs</h2>
<pre>${escapeHtml(JSON.stringify(run.inputs, null, 2))}</pre>
<h2>Evidence</h2>
${run.evidence ? `<pre>${escapeHtml(run.evidence)}</pre>` : `<div class="empty">No evidence file found.</div>`}
${logs}`;
  return shell(`Nitely Run ${run.runId}`, "runs", body);
}

export function renderProvidersPage(providers: ProviderStatus[]): string {
  return shell(
    "Nitely Providers",
    "providers",
    `<div class="topline"><h1>Providers</h1><span class="muted">Local environment only</span></div>${providerRows(providers)}`,
  );
}
