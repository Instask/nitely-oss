import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const consolePath = join(process.cwd(), "src/web/static/console.dc.html");
const legacyServerRenderPath = join(process.cwd(), "src/web/ui.ts");

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("Design Component console shell", () => {
  it("does not keep a legacy server-rendered console implementation", async () => {
    await expect(exists(legacyServerRenderPath)).resolves.toBe(false);
  });

  it("does not expose Runs as primary sidebar navigation", async () => {
    const html = await readFile(consolePath, "utf8");
    const navBlock = html.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? "";

    expect(navBlock).toContain('data-view="dashboard"');
    expect(navBlock).toContain('data-view="tasks"');
    expect(navBlock).toContain('data-view="providers"');
    expect(navBlock).not.toContain('data-view="runs"');
    expect(html).toContain('data-screen-label="Run detail"');
  });

  it("exposes an Agent Stability surface with API fetch hook", async () => {
    const html = await readFile(consolePath, "utf8");
    const navBlock = html.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? "";

    expect(navBlock).toContain('data-view="agent-stability"');
    expect(html).toContain('data-screen-label="Agent Stability"');
    expect(html).toContain('path === "/agent-stability"');
    expect(html).toContain("/api/agent-stability");
    expect(html).toContain("agentStability");
    expect(html).toContain("isAgentStability");
    expect(html).toContain("summaryCards");
    expect(html).toContain("failureClusters");
    expect(html).toContain("runnerReadiness");
    expect(html).toContain("changeRecords");
    expect(html).toContain("ossExtraction");
    expect(html).toContain("OSS extraction candidates");
  });

  it("initializes SPA route state from browser paths", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain('routeFromPath(pathname, search = "")');
    expect(html).toContain('path === "/" || path === "/tasks"');
    expect(html).toContain('path === "/dashboard"');
    expect(html).toContain('path === "/agent-stability"');
    expect(html).toContain('path === "/providers"');
    expect(html).toContain('path === "/context-kg"');
    expect(html).toContain('new URLSearchParams(search).get("entry")');
    expect(html).toContain('path.match(/^\\/tasks\\/([^/]+)$/)');
    expect(html).toContain('path.match(/^\\/runs\\/([^/]+)$/)');
    expect(html).toContain("window.addEventListener(\"popstate\"");
  });

  it("renders an exact context-knowledge proposal link target", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain('data-screen-label="Context knowledge proposal"');
    expect(html).toContain('view: "context-knowledge"');
    expect(html).toContain('"/api/context-kg/" + encodeURIComponent(entryId)');
    expect(html).toContain("selectedContextKnowledgeEntry");
    expect(html).toContain("contextKnowledgeProposalStatus");
    expect(html).toContain("Back to inbox");
  });

  it("exposes a flows surface with editor, validation, and templates", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain('data-view="flows"');
    expect(html).toContain('data-screen-label="Flows"');
    expect(html).toContain('data-screen-label="Flow editor"');
    expect(html).toContain("/api/flows");
    expect(html).toContain("/api/flows/validate");
    expect(html).toContain("/api/flows/templates");
    expect(html).toContain("taskFlowTemplates");
    expect(html).toContain('name="templateId"');
    expect(html).toContain('ref="{{ flowSkillForm }}"');
    expect(html).toContain("addSkillToFlowStage");
    expect(html).toContain("hasFlowSkillPicker");
    expect(html).toContain("Add skill to stage");
    expect(html).toContain('name="skillId"');
    expect(html).toContain("selectedFlowConfigurables");
    expect(html).toContain("selectedFlowHasConfigurables");
    expect(html).toContain('data-key="{{ configurable.key }}"');
    expect(html).toContain("editFlowConfig");
    expect(html).toContain("flowRunConfiguration");
    expect(html).toContain("configuration");
    expect(html).toContain('stage.mode === "review"');
    expect(html).not.toContain('skill.repoId === "default"');
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
    expect(html).toContain("dashboardApiPath");
    expect(html).toContain("setDashboardFilter");
    expect(html).toContain("clearDashboardFilters");
    expect(html).toContain('data-filter-key="repo"');
    expect(html).toContain('data-filter-key="flow"');
    expect(html).toContain('data-filter-key="status"');
    expect(html).toContain('data-filter-key="priority"');
    expect(html).toContain('data-filter-key="owner"');
    expect(html).toContain('data-filter-key="window"');
    expect(html).toContain("Blocked aging");
    expect(html).toContain("Cost attribution");
    expect(html).toContain("Outcome quality");
    expect(html).toContain("Pilot ROI");
    expect(html).toContain("Merge rate");
    expect(html).toContain("Repository attribution");
    expect(html).toContain("Flow-template drilldown");
    expect(html).toContain("Lifecycle evidence");
    expect(html).toContain("Phase duration");
    expect(html).toContain("dashboard.lifecycle");
    expect(html).toContain("hasLifecycle");
    expect(html).toContain("dashboard.phaseDurations");
    expect(html).toContain("hasPhaseDurations");
    expect(html).toContain("averageLabel");
    expect(html).toContain("dashboard.outcomeBreakdown");
    expect(html).toContain("hasOutcomeBreakdown");
    expect(html).toContain("Not tracked");
    expect(html).toContain("reviewablePrsLabel");
    expect(html).toContain("pilotRoiSummaryLabel");
    expect(html).toContain("reviewableEvidenceRunId");
    expect(html).toContain("acceptedEvidenceRunId");
    expect(html).toContain("mergedEvidenceRunId");
    expect(html).toContain("mergeRateLabel");
    expect(html).toContain("mergeStatusCoverageLabel");
    expect(html).toContain("recoverableEvidenceRunId");
    expect(html).toContain("evidenceCompleteEvidenceRunId");
    expect(html).toContain("hasEvidenceCompleteEvidenceLink");
    expect(html).toContain("hasRuntimeEvidenceLink");
    expect(html).toContain("hasCompletionEvidenceLink");
    expect(html).toContain("hasReviewGateEvidenceLink");
    expect(html).toContain("dashboard.flowTemplates");
    expect(html).toContain("hasFlowTemplates");
    expect(html).toContain("evidenceRunId");
    expect(html).not.toMatch(/leaderboard|productivity scoreboard|PR count ranking|LOC/);
  });

  it("exposes a mocked golden path demo trigger on the dashboard", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain('data-screen-label="Manager dashboard"');
    expect(html).toContain("Run mocked demo");
    expect(html).toContain("Mocked golden path demo");
    expect(html).toContain("/api/demo/golden-path");
    expect(html).toContain("runGoldenPathDemo");
    expect(html).toContain("hasDemoStatus");
    expect(html).toContain("hasDemoResult");
    expect(html).toContain("demoResult.implementationRunId");
    expect(html).toContain("demoResult.reworkRunId");
    expect(html).toContain("Implementation evidence");
    expect(html).toContain("Rework evidence");
    expect(html).toContain('this.navigate({ view: "task-detail", taskId: demo.taskId })');
  });

  it("exposes a scheduler DAG and execution queue surface", async () => {
    const html = await readFile(consolePath, "utf8");
    const navBlock = html.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? "";

    expect(navBlock).toContain('data-view="scheduler"');
    expect(html).toContain('data-screen-label="Scheduler"');
    expect(html).toContain('path === "/scheduler"');
    expect(html).toContain("/api/scheduler");
    expect(html).toContain("schedulerQueue");
    expect(html).toContain("schedulerGraph");
    expect(html).toContain("schedulerDagNodes");
    expect(html).toContain("schedulerDagEdges");
    expect(html).toContain('data-scheduler-cooldowns="true"');
    expect(html).toContain("Runtime cooldowns");
    expect(html).toContain("schedulerNextWakeUpLabel");
    expect(html).toContain('data-scheduler-dag-edge-layer="true"');
    expect(html).toContain('data-scheduler-dag-node-card="true"');
    expect(html).not.toContain('data-scheduler-dag-svg="true"');
    expect(html).toContain("confirmedEdges");
    expect(html).toContain("suggestedEdges");
    expect(html).toContain("Run preflight");
    expect(html).toContain("selectedTask.preflightBadge");
    expect(html).toContain("/preflight");
    expect(html).toContain("run preflight blocks execution");
    expect(html).toContain("Spec readiness");
    expect(html).toContain("selectedTask.specReadinessBadge");
    expect(html).toContain("specApprovalReadiness");
    expect(html).toContain("showDisabledApproveSpec");
    expect(html).toContain("specApprovalReadinessIssues");
    expect(html).toContain("specApprovalRepairHint");
    expect(html).toContain("Line ");
    expect(html).toContain("sourceDriftDiff");
    expect(html).toContain("hasSourceDriftDiff");
    expect(html).toContain("Source override acknowledged");
    expect(html).toContain("sourceDriftOverrideLabel");
    expect(html).toContain("Previous");
    expect(html).toContain("Latest");
    expect(html).toContain("Start with readiness override");
    expect(html).toContain("addDependency");
    expect(html).toContain("removeDependency");
    expect(html).toContain("acceptDependencySuggestion");
    expect(html).toContain("dismissDependencySuggestion");
    expect(html).toContain("refreshDependencySuggestions");
    expect(html).toContain("/dependencies");
    expect(html).toContain("/dependency-suggestions/");
    expect(html).toContain("/suggestions:refresh");
    expect(html).toContain("data-upstream");
  });

  it("presents providers as a connection center with per-method auth UX", async () => {
    const html = await readFile(consolePath, "utf8");
    const section = html.match(
      /<!-- ============ PROVIDERS ============ -->[\s\S]*?<\/section>/,
    )?.[0] ?? "";
    expect(section).toContain('data-screen-label="Providers"');
    // Each provider lists the auth methods it actually supports.
    expect(section).toContain('list="{{ p.authMethods }}"');
    expect(section).toContain("{{ m.label }}");
    // OAuth-capable methods use the redirect connect flow, never a paste box.
    expect(section).toContain('value="{{ m.isRedirect }}"');
    expect(section).toContain('onClick="{{ connectProvider }}"');
    expect(section).toContain('onClick="{{ reconnectProvider }}"');
    expect(section).toContain('onClick="{{ disconnectProvider }}"');
    expect(section).toContain("Connected as");
    expect(section).toContain("{{ c.accountLabel }}");
    expect(section).toContain("{{ c.scopesLabel }}");
    // API-key methods get a masked, write-only form with update and clear.
    expect(section).toContain('value="{{ m.isManual }}"');
    expect(section).toContain('type="password"');
    expect(section).toContain('onClick="{{ saveConnection }}"');
    expect(section).toContain('onClick="{{ clearConnection }}"');
    expect(section).toContain("data-auth-method=");
    expect(section).toContain("data-connection=");
    // CLI-managed methods show status and remediation only.
    expect(section).toContain('value="{{ m.isCli }}"');
    expect(section).toContain("{{ m.remediation }}");
    // Reconnect-required state is visible; stored values never are.
    expect(section).toContain("{{ c.badge.label }}");
    expect(section).not.toMatch(/\{\{\s*c\.value\s*\}\}/);
    expect(section).not.toContain("credentialRef");
    expect(section).not.toContain("accessToken");
    // The connect flow starts at the API and follows the provider's redirect.
    expect(html).toContain("/oauth/start");
    expect(html).toContain("window.location.assign(");
    expect(html).toContain("/disconnect");
    expect(html).toContain("/validate");
    expect(html).toContain("oauthError");
    expect(html).toContain('get("connected")');
    expect(html).toContain('onClick="{{ validateProviderConnection }}"');
  });

  it("exposes a Schedules view with state, trigger, history and operational controls", async () => {
    const html = await readFile(consolePath, "utf8");
    const navBlock = html.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(navBlock).toContain('data-view="schedules"');
    expect(html).toContain('data-screen-label="Schedules"');
    expect(html).toContain('path === "/schedules"');
    expect(html).toContain("/api/schedules");
    const section = html.match(
      /<!-- ============ SCHEDULES ============ -->[\s\S]*?<!-- ============ END SCHEDULES ============ -->/,
    )?.[0] ?? "";
    // List: state, trigger + timezone, next run, last occurrence/result, linked task/run.
    expect(section).toContain('list="{{ scheduleRows }}"');
    expect(section).toContain("{{ s.stateBadge.label }}");
    expect(section).toContain("{{ s.triggerLabel }}");
    expect(section).toContain("{{ s.timezone }}");
    expect(section).toContain("{{ s.nextRunLabel }}");
    expect(section).toContain("{{ s.lastOccurrenceLabel }}");
    expect(section).toContain('onClick="{{ openScheduleTask }}"');
    expect(section).toContain('onClick="{{ openScheduleRun }}"');
    // Controls: pause/resume, edit, delete, run-now.
    expect(section).toContain('onClick="{{ pauseSchedule }}"');
    expect(section).toContain('onClick="{{ resumeSchedule }}"');
    expect(section).toContain('onClick="{{ deleteSchedule }}"');
    expect(section).toContain('onClick="{{ runScheduleNow }}"');
    expect(section).toContain('onClick="{{ openSchedule }}"');
    expect(section).toContain('onClick="{{ saveScheduleEdit }}"');
    // History with intended vs. materialized time, reason, revision and lineage.
    expect(section).toContain('list="{{ scheduleHistory }}"');
    expect(section).toContain("{{ o.intendedFireAt }}");
    expect(section).toContain("{{ o.materializedAt }}");
    expect(section).toContain("{{ o.reason }}");
    expect(section).toContain("{{ o.scheduleRevision }}");
    expect(section).toContain("{{ o.lineageLabel }}");
    // Creation form covers trigger, timezone, template, admission, misfire and overlap.
    expect(section).toContain('name="triggerType"');
    expect(section).toContain('name="cronExpression"');
    expect(section).toContain('name="timezone"');
    expect(section).toContain('name="misfirePolicy"');
    expect(section).toContain('name="catchUpLimit"');
    expect(section).toContain('name="overlap"');
    expect(section).toContain('name="admission"');
    expect(section).toContain('onClick="{{ createSchedule }}"');
    expect(html).toContain("/pause");
    expect(html).toContain("/resume");
    expect(html).toContain("/run-now");
  });

  it("exposes an approval inbox for pending human review actions", async () => {
    const html = await readFile(consolePath, "utf8");
    const navBlock = html.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? "";

    expect(navBlock).toContain('data-view="inbox"');
    expect(html).toContain('data-screen-label="Approval inbox"');
    expect(html).toContain('path === "/inbox"');
    expect(html).toContain("/api/notifications");
    expect(html).toContain("/api/users");
    expect(html).toContain("notificationsSummary");
    expect(html).toContain("pendingNotifications");
    expect(html).toContain("performNotificationAction");
    expect(html).toContain('"/actions"');
    expect(html).toContain("supportedActions");
    expect(html).toContain("requiredReasonActions");
    expect(html).toContain('name="reason"');
    expect(html).toContain("Request changes");
    expect(html).toContain("Override");
    expect(html).toContain("Cancel run");
    expect(html).toContain("deliveryLabel");
    expect(html).toContain('"Sending: " + pendingChannels.join(", ")');
    expect(html).toContain("deliveries");
    expect(html).toContain("assignNotification");
    expect(html).toContain('supportedActions.includes("assign")');
    expect(html).toContain('name="targetUserId"');
    expect(html).toContain("Review scope");
    expect(html).toContain("scopeLabel");
  });

  it("renders an evidence timeline in the run detail view", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain("Evidence timeline");
    expect(html).toContain("{{ selectedRun.evidenceTimeline }}");
    expect(html).toContain("evidenceSummary");
    expect(html).toContain("{{ ev.kind }}");
    expect(html).toContain("Checkpoints");
    expect(html).toContain("selectedRun.checkpoints");
    expect(html).toContain("hasCheckpoints");
    expect(html).toContain("rd.trace");
    expect(html).toContain("Review feedback");
    expect(html).toContain("selectedRun.hasReviewFeedback");
    expect(html).toContain("reviewFeedbackRouteLabel");
    expect(html).toContain("reviewFeedbackMemoryProposals");
    expect(html).toContain("resolveContextKnowledgeProposal");
    expect(html).toContain("editContextKnowledgeProposal");
    expect(html).toContain("/api/context-kg/");
    expect(html).toContain("contextKnowledgeEntryId");
    expect(html).toContain("Task plan");
    expect(html).toContain("selectedRun.hasTaskPlan");
    expect(html).toContain("selectedRun.taskPlanHistory");
    expect(html).toContain("taskPlanProgressLabel");
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
    expect(html).not.toContain('name="path"');
    expect(html).not.toContain('name="id" autocomplete="off" placeholder="instask-nitely"');
    expect(html).not.toContain("{{ repo.path }}");
    expect(html).not.toContain('repo.id === "default"');
  });

  it("exposes repositories and skills as first-class sidebar surfaces", async () => {
    const html = await readFile(consolePath, "utf8");
    const navBlock = html.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? "";

    expect(navBlock).toContain('data-view="repositories"');
    expect(navBlock).toContain('data-view="skills"');
    expect(html).toContain('data-screen-label="Repositories"');
    expect(html).toContain('data-screen-label="Skills"');
    expect(html).toContain('path === "/repositories"');
    expect(html).toContain('path === "/skills"');
    expect(html).toContain("/api/skills");
    expect(html).toContain("/api/skills/preview");
    expect(html).toContain("/api/skills/import");
    expect(html).toContain('ref="{{ skillImportForm }}"');
    expect(html).toContain("previewSkillImport");
    expect(html).toContain("confirmSkillImport");
    expect(html).toContain("Local skill path");
    expect(html).toContain("overwrite required");
    expect(html).toContain("{{ skills }}");
    expect(html).toContain("skillCount");
  });

  it("exposes the Web preview runtime panel and controls", async () => {
    const html = await readFile(consolePath, "utf8");
    const navBlock = html.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? "";

    expect(navBlock).toContain('data-view="preview"');
    expect(html).toContain('data-screen-label="Preview"');
    expect(html).toContain('path === "/preview"');
    expect(html).toContain('return "/preview"');
    expect(html).toContain("/api/preview-sessions");
    expect(html).toContain("previewViewportPresets");
    expect(html).toContain("previewStartForm");
    expect(html).toContain('onSubmit="{{ startPreviewSession }}"');
    expect(html).toContain('name="workItemId"');
    expect(html).toContain('name="runId"');
    expect(html).toContain("startPreviewSession");
    expect(html).toContain("selectPreviewSession");
    expect(html).toContain("restartPreview");
    expect(html).toContain('sandbox="allow-scripts allow-forms allow-pointer-lock allow-downloads"');
    expect(html).toContain("/proxy");
    expect(html).toContain('onSubmit="{{ navigatePreview }}"');
    expect(html).toContain("navigatePreview");
    expect(html).toContain('onSubmit="{{ clickPreview }}"');
    expect(html).toContain('onSubmit="{{ typePreview }}"');
    expect(html).toContain('onSubmit="{{ scrollPreview }}"');
    expect(html).toContain("capturePreviewScreenshot");
    expect(html).toContain("attachPreviewScreenshot");
    expect(html).toContain("attach-screenshot");
    expect(html).toContain("refreshPreviewDiagnostics");
    expect(html).toContain("refreshPreviewHierarchy");
    expect(html).toContain("previewDiagnosticEvents");
    expect(html).toContain("previewHierarchyNodes");
    expect(html).toContain("styleLabel");
    expect(html).toContain("previewScreenshots");
    expect(html).toContain("Preview sessions refreshed");
  });

  it("uses a persistent compact sidebar on mobile", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain("grid-template-columns:68px minmax(0,1fr) !important");
    expect(html).toContain("height:100dvh !important");
    expect(html).toContain(".console-sidebar nav{ display:flex !important; flex-direction:column !important");
    expect(html).toContain(".console-sidebar nav button{ width:100% !important");
    expect(html).toContain(".console-sidebar nav button span:first-of-type");
    expect(html).not.toContain("mobile-nav-drawer");
    expect(html).not.toContain("mobile-nav-toggle");
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
    expect(html).toContain("Context knowledge");
    expect(html).toContain("selectedRun.contextKnowledgeItems");
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
    expect(html).toContain("statusSummary");
    expect(html).toContain("Process: {{ s.processStatusLabel }}");
    expect(html).toContain("Artifacts: {{ s.artifactReadinessLabel }}");
    expect(html).toContain("heartbeat active");
    expect(html).toContain("latestMeaningfulOutput");
    expect(html).toContain("Published change");
    expect(html).toContain("publicationLabel");
    expect(html).toContain("Recovery artifact");
    expect(html).toContain("recoveryArtifactLabel");
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
    expect(html).toContain("Factory funnel");
    expect(html).toContain("rawDashboard.factoryMetrics");
    expect(html).toContain("formatVerificationBudget");
    expect(html).toContain("selectedRun.verificationBudgetLabel");
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

  it("renders structured operator question actions on run detail", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain("Operator question");
    expect(html).toContain("selectedRun.hasActiveQuestion");
    expect(html).toContain("selectedRun.operatorQuestionOptions");
    expect(html).toContain("answerOperatorQuestion");
    expect(html).toContain("submitOperatorQuestionText");
    expect(html).toContain("/questions/");
    expect(html).toContain("Answer recorded. Resume this run");
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
    expect(html).toContain('<option value="github-issue">GitHub issue</option>');
    expect(html).toContain('<option value="jira-ticket">Jira ticket</option>');
    expect(html).toContain('<option value="external-document">External document</option>');
    expect(html).toContain('<option value="prompt">Prompt</option>');
    expect(html).toContain('name="documentBody"');
    expect(html).toContain('name="documentVersion"');
    expect(html).toContain('name="syncStatus"');
    expect(html).toContain('name="guidance"');
    expect(html).toContain("Planning guidance");
    expect(html).toContain("Template");
    expect(html).toContain("/api/draft-specs");
    expect(html).toContain("planWork");
    expect(html).toContain("templateId: data.templateId");
    expect(html).toContain("payload.guidance");
    expect(html).toContain("payload.publicBaseUrl = window.location.origin");
    expect(html).toContain("/sync-source-status");
    expect(html).toContain("Sync to Jira");
    expect(html).toContain("selectedTask.planningGuidance");
    expect(html).toContain("selectedTask.hasPlanningGuidance");
    expect(html).toContain("/approve-spec");
    expect(html).toContain("approvalReadiness?.ready === false");
    expect(html).toContain("aria-disabled=\"true\"");
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
    expect(html).toContain("class=\"mobile-page-head mobile-task-detail-header\"");
    expect(html).toContain("class=\"mobile-task-title\"");
    expect(html).toContain("class=\"mobile-actions mobile-task-actions\"");
    expect(html).toContain("class=\"mobile-doc-panel\"");
    expect(html).toContain("grid-template-columns:minmax(0,1fr) !important");
    expect(html).toContain(".mobile-detail-layout > *,.mobile-flow-editor > *,.mobile-provider-grid > *{ min-width:0 !important; max-width:100% !important; }");
    expect(html).toContain(".mobile-task-actions{ display:grid !important; grid-template-columns:minmax(0,1fr) !important");
    expect(html).toContain(".mobile-doc-panel{ width:100% !important; min-width:0 !important; max-width:100% !important");
    expect(html).toContain(".mobile-task-rail button div{ white-space:normal !important; overflow-wrap:anywhere !important; text-overflow:clip !important; }");
    expect(html).toContain(".mobile-task-rail button [style*=\"white-space:nowrap\"]{ white-space:normal !important; overflow-wrap:anywhere !important; }");
    expect(html).toContain(".mobile-task-rail span{ min-width:0 !important; overflow-wrap:anywhere !important; word-break:break-word !important; }");
    expect(html).toContain("overflow-wrap:anywhere");
  });

  it("shows artifact io labels on collapsed pipeline rows", async () => {
    const html = await readFile(consolePath, "utf8");
    const summary = html.match(
      /class="mobile-stage-summary"[\s\S]*?<\/div>/,
    )?.[0] ?? "";

    expect(summary).toContain("{{ s.ioLabel }}");
    expect(html).toContain("hasIoLabel");
  });

  it("renders a flow stage graph from the validated artifact graph", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain("data-flow-graph");
    expect(html).toContain("artifactGraph");
    expect(html).toContain("flowGraph.hasGraph");
    expect(html).toContain("flowGraph.canvasStyle");
    expect(html).toContain('list="{{ flowGraph.nodes }}"');
    expect(html).toContain('list="{{ flowGraph.edgeSegments }}"');
    expect(html).toContain("flowGraph.unavailableLabel");
  });

  it("lets an operator select a stage node in the flow graph", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain("selectedFlowStageId");
    expect(html).toContain("selectFlowStage");
    expect(html).toContain('data-stage="{{ node.id }}" onClick="{{ selectFlowStage }}"');
  });

  it("inspects what the selected flow stage does", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain("flowStageInspector");
    expect(html).toContain("flowStageInspector.hasSelection");
    expect(html).toContain("flowStageInspector.typeLabel");
    expect(html).toContain("flowStageInspector.runtimeLabel");
    expect(html).toContain("flowStageInspector.prompt");
    expect(html).toContain("flowStageInspector.emptyLabel");
    expect(html).toContain('list="{{ flowStageInspector.chips }}"');
  });

  it("labels where each inspected stage artifact comes from and goes to", async () => {
    const html = await readFile(consolePath, "utf8");

    expect(html).toContain('list="{{ flowStageInspector.inputs }}"');
    expect(html).toContain('list="{{ flowStageInspector.outputs }}"');
    expect(html).toContain("originLabel");
    expect(html).toContain("consumersLabel");
  });

  it("keeps the syncing pill and bar mounted as overlays so polls do not shift layout", async () => {
    const html = await readFile(consolePath, "utf8");
    const cssRule = (selector: string) => html.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\{[^}]+\\}`))?.[0] ?? "";

    expect(html).toContain("nitely-loading-bar");
    expect(html).toContain("nitely-loading-pill");
    expect(html).not.toMatch(/<sc-if value="\{\{ showDataLoadingBar \}}"[^>]*>\s*<div class="nitely-loading-bar/);
    expect(html).not.toMatch(/<sc-if value="\{\{ showDataLoadingBar \}}"[^>]*>\s*<div class="nitely-loading-pill/);

    const barCss = cssRule(".nitely-loading-bar");
    const pillCss = cssRule(".nitely-loading-pill");
    expect(barCss).toMatch(/position:\s*(absolute|fixed)/);
    expect(barCss).not.toMatch(/position:\s*sticky/);
    expect(pillCss).toMatch(/position:\s*(absolute|fixed)/);
    expect(pillCss).not.toMatch(/position:\s*sticky/);

    expect(html).not.toMatch(/class="nitely-loading-bar"[^>]*role="progressbar"/);
    expect(
      html.includes('aria-busy="{{ dataLoadingBusy }}"') || html.includes('role="{{ dataLoadingBarRole }}"'),
    ).toBe(true);
    expect(html).not.toMatch(/dataLoadingLabel:\s*this\.state\.dataLoadError \|\| "Syncing"/);
  });

  it("refreshes live run state without repeating the full workspace fetch", async () => {
    const html = await readFile(consolePath, "utf8");
    const refreshLiveData = extractMethod(html, "refreshLiveData");
    const fetchData = extractMethod(html, "fetchData");

    expect(refreshLiveData).toContain('"/api/runs"');
    expect(refreshLiveData).not.toContain("fetchData()");
    expect(refreshLiveData).not.toContain("/api/tasks");
    expect(refreshLiveData).not.toContain("/api/providers");
    expect(fetchData).toContain('this.api("/api/tasks")');
    expect(html).toContain("await this.fetchData()");
  });

  it("joins overlapping fetchData callers onto one in-flight load", async () => {
    const html = await readFile(consolePath, "utf8");
    const fetchData = extractMethod(html, "fetchData");

    expect(html).toContain("this.fetchDataInFlight = null");
    expect(fetchData).toMatch(
      /if \(this\.fetchDataInFlight\) return this\.fetchDataInFlight/,
    );
  });
});

function extractMethod(source: string, name: string): string {
  const marker = `async ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const brace = source.indexOf("{", start);
  if (brace < 0) return "";
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return source.slice(start);
}
