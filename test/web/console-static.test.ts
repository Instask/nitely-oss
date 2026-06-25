import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const consolePath = join(process.cwd(), "src/web/static/console.dc.html");

describe("Design Component console shell", () => {
  it("does not expose Runs as primary sidebar navigation", async () => {
    const html = await readFile(consolePath, "utf8");
    const navBlock = html.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? "";

    expect(navBlock).toContain('data-view="dashboard"');
    expect(navBlock).toContain('data-view="tasks"');
    expect(navBlock).toContain('data-view="providers"');
    expect(navBlock).not.toContain('data-view="runs"');
    expect(html).toContain('data-screen-label="Run detail"');
  });

  it("initializes SPA route state from browser paths", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain("routeFromPath(pathname)");
    expect(html).toContain('path === "/" || path === "/tasks"');
    expect(html).toContain('path === "/dashboard"');
    expect(html).toContain('path === "/providers"');
    expect(html).toContain('path.match(/^\\/tasks\\/([^/]+)$/)');
    expect(html).toContain('path.match(/^\\/runs\\/([^/]+)$/)');
    expect(html).toContain("window.addEventListener(\"popstate\"");
  });

  it("exposes a flows surface with editor, validation, and templates", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain('data-view="flows"');
    expect(html).toContain('data-screen-label="Flows"');
    expect(html).toContain('data-screen-label="Flow editor"');
    expect(html).toContain("/api/flows");
    expect(html).toContain("/api/flows/validate");
    expect(html).toContain("/api/flows/templates");
    expect(html).toContain('path === "/flows"');
    expect(html).toContain("editFlowDraft");
    expect(html).toContain("pickTemplate");
    expect(html).toContain("{{ flowDraftErrors }}");
  });

  it("contains manager dashboard workflow visibility without individual rankings", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain('data-view="dashboard"');
    expect(html).toContain('data-screen-label="Manager dashboard"');
    expect(html).toContain("/api/dashboard");
    expect(html).toContain("Blocked aging");
    expect(html).toContain("Cost attribution");
    expect(html).toContain("Outcome quality");
    expect(html).toContain("Repository attribution");
    expect(html).not.toMatch(/leaderboard|productivity scoreboard|PR count ranking|LOC/);
  });

  it("renders an evidence timeline in the run detail view", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain("Evidence timeline");
    expect(html).toContain("{{ selectedRun.evidenceTimeline }}");
    expect(html).toContain("evidenceSummary");
    expect(html).toContain("{{ ev.kind }}");
  });

  it("exposes Tasks as the only top-level task navigation item", async () => {
    const html = await readFile(consolePath, "utf8");
    const navBlock = html.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? "";

    expect(navBlock).toContain('data-view="tasks"');
    expect(navBlock).not.toContain('data-view="work-items"');
    expect(html).not.toContain('data-screen-label="Work Items"');
    expect(html).toContain('path === "/work-items"');
    expect(html).toContain("/api/tasks");
  });

  it("renders task rows as links to canonical task detail routes", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain('onClick="{{ openTask }}"');
    expect(html).toContain('this.navigate({ view: "task-detail", taskId: id })');
    expect(html).toContain('path === "/work-items"');
    expect(html).toContain('return { view: "tasks" }');
  });

  it("contains repository management controls on the task surface", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain("Add repository");
    expect(html).toContain('ref="{{ newRepoForm }}"');
    expect(html).toContain('name="githubUrl"');
    expect(html).toContain("Paste a GitHub URL");
    expect(html).toContain("/api/repositories");
    expect(html).toContain("createRepository");
    expect(html).toContain("toggleNewRepo");
  });

  it("contains login and session controls for required auth mode", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain('data-screen-label="Login"');
    expect(html).toContain("/api/session");
    expect(html).toContain("loginForm");
    expect(html).toContain("signOut");
    expect(html).toContain("authRequired");
  });

  it("uses provider storage copy that applies to local and required auth modes", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain("Secret values are stored by the active Web Console credential store");
    expect(html).toContain("never returned by the API");
    expect(html).not.toContain("Secrets are stored in");
  });

  it("contains first-class session filters and detail panels", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain('data-screen-label="Sessions"');
    expect(html).toContain('data-filter="session-pr"');
    expect(html).toContain('data-filter="session-status"');
    expect(html).toContain('data-filter="session-flow"');
    expect(html).toContain('data-filter="session-task"');
    expect(html).toContain('data-filter="session-owner"');
    expect(html).toContain("filteredRuns");
    expect(html).toContain("Context manifest");
    expect(html).toContain("Review findings");
    expect(html).toContain("Session chain");
    expect(html).toContain("Agent session");
  });

  it("polls active sessions and renders current stage observability fields", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain("startLiveRefresh");
    expect(html).toContain("stopLiveRefresh");
    expect(html).toContain("hasVisibleActiveRuns");
    expect(html).toContain("currentStageLabel");
    expect(html).toContain("latestOutputSummary");
    expect(html).toContain("currentStageState");
  });

  it("renders runtime token usage observability fields", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain("formatRuntimeUsage");
    expect(html).toContain("runtime tokens unknown");
    expect(html).toContain("selectedRun.runtimeUsageLabel");
    expect(html).toContain("stage.runtimeUsage");
    expect(html).toContain("formatBudgetSummary");
    expect(html).toContain("top token consumers");
    expect(html).toContain("selectedRun.budgetSummaryLabel");
  });

  it("renders expandable stage details without requiring stdout or stderr", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain("s.hasDetails");
    expect(html).toContain("s.showDetails");
    expect(html).toContain("Rendered prompt");
    expect(html).toContain("s.detailFields");
    expect(html).toContain("details.stdout");
    expect(html).not.toContain("if (!stage || !(stage.stdout || stage.stderr)) return;");
  });

  it("renders run detail change request actions as external links", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain('href="{{ selectedRun.changeUrl }}"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("View {{ selectedRun.cr }}");
    expect(html).not.toContain('<button onClick="{{ noop }}" style="display:inline-flex;align-items:center;gap:7px;border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:8px;padding:9px 14px;font:inherit;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;">View {{ selectedRun.cr }}</button>');
  });

  it("scopes polling to views that visibly render run state", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain('this.state.view === "run-detail"');
    expect(html).toContain('this.state.view === "runs"');
    expect(html).toContain('this.state.view === "task-detail"');
    expect(html).toContain('this.state.view === "dashboard"');
    expect(html).toContain("return detail?.runs || []");
    expect(html).toContain("return [];");
    expect(html).not.toContain("return this.state.runs;\n  }\n\n  hasVisibleActiveRuns");
  });

  it("uses latest display status and allows runnable generic task detail actions", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain("taskDisplayStatus(t)");
    expect(html).toContain("t.latestRunStatus || t.displayStatus || t.status");
    expect(html).toContain('!t.readOnly && t.status !== "running"');
    expect(html).not.toContain('t.workItemType === "dev.pr" && t.status !== "running"');
  });

  it("renders repository selection and repository metadata", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain("/api/repositories");
    expect(html).toContain('name="repoId"');
    expect(html).toContain("{{ repositories }}");
    expect(html).toContain("{{ t.repoName }}");
    expect(html).toContain("{{ selectedTask.repoName }}");
    expect(html).toContain("{{ selectedRun.repo }}");
  });

  it("contains Planner Agent intake and approval controls", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain("Plan work");
    expect(html).toContain('ref="{{ plannerForm }}"');
    expect(html).toContain('name="sourceType"');
    expect(html).toContain("/api/draft-specs");
    expect(html).toContain("planWork");
    expect(html).toContain("/approve-spec");
    expect(html).toContain("/draft-tech-design");
    expect(html).toContain("/approve-tech-design");
    expect(html).toContain("planningNotes.openQuestions");
    expect(html).toContain("Approve spec");
    expect(html).toContain("Draft tech design");
    expect(html).toContain("Approve tech design");
  });

  it("contains mobile responsive layout hooks for console lists and detail views", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain("@media (max-width: 860px)");
    expect(html).toContain("class=\"console-shell\"");
    expect(html).toContain("class=\"console-sidebar\"");
    expect(html).toContain("class=\"console-content\"");
    expect(html).toContain("class=\"mobile-grid-row\"");
    expect(html).toContain("class=\"mobile-detail-layout\"");
    expect(html).toContain("class=\"mobile-provider-grid\"");
    expect(html).toContain("class=\"mobile-slide-panel\"");
    expect(html).toContain("grid-template-columns:1fr !important");
    expect(html).toContain("overflow-wrap:anywhere");
  });
});
