import { parseTaskArtifact, type ParsedTask } from "../task-artifacts/parse.js";
import { validateStructuredSpec } from "../spec-artifacts/parse.js";
import { validateTechnicalPlan } from "../plan-artifacts/parse.js";

export type AnalysisSeverity = "critical" | "warning" | "info";

export interface AnalysisArtifact {
  id: string;
  content: string;
}

export interface AnalysisFinding {
  severity: AnalysisSeverity;
  code:
    | "missing-requirement-coverage"
    | "missing-success-coverage"
    | "unmapped-task"
    | "placeholder"
    | "invalid-plan-artifact"
    | "invalid-spec-artifact"
    | "invalid-task-artifact"
    | "dependency-order"
    | "constitution-conflict"
    | "missing-verification-task";
  message: string;
  artifactIds: string[];
  relatedIds?: string[];
  line?: number;
}

export interface AnalysisSummary {
  critical: number;
  warning: number;
  info: number;
}

export interface AnalysisReport {
  findings: AnalysisFinding[];
  summary: AnalysisSummary;
  markdown: string;
}

const REQUIREMENT_PATTERN = /\bFR-\d{3}\b/g;
const SUCCESS_PATTERN = /\bSC-\d{3}\b/g;
const STORY_PATTERN = /\bUS-\d{3}\b/g;
const PLAN_DECISION_PATTERN = /\b(?:PD|D)-\d{3}\b/g;
const PLACEHOLDER_PATTERN = /\b(?:TBD|TODO|FIXME)\b|\{\{[^}]+\}\}|<([A-Z][A-Z0-9_-]*)>/g;
const VERIFY_PATTERN = /\b(?:test|verify|check|assert|validation|verification)\b/i;
const MAINTENANCE_PATTERN = /\b(?:maintenance|refactor|cleanup|docs|documentation|chore|verification)\b/i;
const MUST_NOT_PATTERN = /\bmust\s+not\s+([^.\n]+)/gi;

function uniqueMatches(content: string, pattern: RegExp): string[] {
  return [...new Set([...content.matchAll(pattern)].map((match) => match[0].toUpperCase()))];
}

function allContent(artifacts: AnalysisArtifact[]): string {
  return artifacts.map((artifact) => artifact.content).join("\n");
}

function hasOutOfScopeNote(content: string, id: string): boolean {
  const lines = content.split(/\r?\n/);
  return lines.some(
    (line) => line.toUpperCase().includes(id) && /out\s+of\s+scope/i.test(line),
  );
}

function taskText(tasks: ParsedTask[]): string {
  return tasks.map((task) => task.raw).join("\n").toUpperCase();
}

function markdownTable(findings: AnalysisFinding[]): string {
  if (findings.length === 0) return "No findings.";
  return [
    "| Severity | Code | Related | Message |",
    "|---|---|---|---|",
    ...findings.map((finding) =>
      [
        finding.severity,
        finding.code,
        finding.relatedIds?.join(", ") ?? "",
        finding.message.replace(/\|/g, "\\|"),
      ].join(" | "),
    ),
  ].join("\n");
}

function countSummary(findings: AnalysisFinding[]): AnalysisSummary {
  return {
    critical: findings.filter((finding) => finding.severity === "critical").length,
    warning: findings.filter((finding) => finding.severity === "warning").length,
    info: findings.filter((finding) => finding.severity === "info").length,
  };
}

function mappedTask(task: ParsedTask): boolean {
  const text = task.raw;
  return (
    REQUIREMENT_PATTERN.test(text) ||
    SUCCESS_PATTERN.test(text) ||
    STORY_PATTERN.test(text) ||
    PLAN_DECISION_PATTERN.test(text) ||
    MAINTENANCE_PATTERN.test(text)
  );
}

function resetGlobalPatterns(): void {
  REQUIREMENT_PATTERN.lastIndex = 0;
  SUCCESS_PATTERN.lastIndex = 0;
  STORY_PATTERN.lastIndex = 0;
  PLAN_DECISION_PATTERN.lastIndex = 0;
  MAINTENANCE_PATTERN.lastIndex = 0;
}

function constitutionRules(constitution?: string): string[] {
  if (!constitution) return [];
  return [...constitution.matchAll(MUST_NOT_PATTERN)]
    .map((match) => match[1]?.trim().toLowerCase())
    .filter((rule): rule is string => Boolean(rule));
}

function looksStructuredSpec(content: string): boolean {
  return /^(#{2,4})\s+(?:User Stories|Functional Requirements|Success Criteria|Acceptance Scenarios)\s*$/im.test(
    content,
  );
}

function specLikeArtifacts(artifacts: AnalysisArtifact[]): AnalysisArtifact[] {
  return artifacts.filter(
    (artifact) =>
      artifact.id.toLowerCase().includes("spec") &&
      looksStructuredSpec(artifact.content),
  );
}

function looksStructuredPlan(content: string): boolean {
  return /^(#{2,4})\s+(?:Technical Context|Files\s*\/\s*Modules Touched|Test Strategy|Constitution Check|Complexity Tracking)\s*$/im.test(
    content,
  );
}

function planLikeArtifacts(artifacts: AnalysisArtifact[]): AnalysisArtifact[] {
  return artifacts.filter((artifact) => {
    const id = artifact.id.toLowerCase();
    return (
      (id.includes("plan") || id.includes("tech") || id.includes("design")) &&
      looksStructuredPlan(artifact.content)
    );
  });
}

export function analyzeSpecPlanTasks(input: {
  artifacts: AnalysisArtifact[];
  constitution?: string;
}): AnalysisReport {
  const findings: AnalysisFinding[] = [];
  const content = allContent(input.artifacts);
  const structuredSpecArtifacts = specLikeArtifacts(input.artifacts);
  const structuredSpecArtifactIds = new Set(
    structuredSpecArtifacts.map((artifact) => artifact.id),
  );
  const structuredPlanArtifacts = planLikeArtifacts(input.artifacts);
  const structuredPlanArtifactIds = new Set(
    structuredPlanArtifacts.map((artifact) => artifact.id),
  );
  const parsedSpecs = structuredSpecArtifacts.map((artifact) => ({
    artifact,
    parsed: validateStructuredSpec(artifact.content),
  }));
  const parsedPlans = structuredPlanArtifacts.map((artifact) => ({
    artifact,
    parsed: validateTechnicalPlan(artifact.content),
  }));
  const requirementIds =
    parsedSpecs.length > 0
      ? [
          ...new Set(
            parsedSpecs.flatMap(({ parsed }) =>
              parsed.requirements.map((requirement) => requirement.id),
            ),
          ),
        ]
      : uniqueMatches(content, REQUIREMENT_PATTERN);
  const successIds =
    parsedSpecs.length > 0
      ? [
          ...new Set(
            parsedSpecs.flatMap(({ parsed }) =>
              parsed.successCriteria.map((criterion) => criterion.id),
            ),
          ),
        ]
      : uniqueMatches(content, SUCCESS_PATTERN);
  const taskArtifact = input.artifacts.find((artifact) =>
    /\bT\d{3}\b/.test(artifact.content),
  );
  const parsedTasks = taskArtifact ? parseTaskArtifact(taskArtifact.content) : undefined;
  const tasks = parsedTasks?.tasks ?? [];
  const tasksUpper = taskText(tasks);

  for (const { artifact, parsed } of parsedSpecs) {
    for (const diagnostic of parsed.diagnostics) {
      findings.push({
        severity: diagnostic.severity === "error" ? "critical" : "warning",
        code: "invalid-spec-artifact",
        message: diagnostic.message,
        artifactIds: [artifact.id],
        relatedIds: diagnostic.id ? [diagnostic.id] : undefined,
        line: diagnostic.line,
      });
    }
  }

  for (const { artifact, parsed } of parsedPlans) {
    for (const diagnostic of parsed.diagnostics) {
      findings.push({
        severity: diagnostic.severity === "error" ? "critical" : "warning",
        code: "invalid-plan-artifact",
        message: diagnostic.message,
        artifactIds: [artifact.id],
        relatedIds: diagnostic.id ? [diagnostic.id] : undefined,
        line: diagnostic.line,
      });
    }
  }

  if (parsedTasks && !parsedTasks.valid) {
    for (const diagnostic of parsedTasks.diagnostics) {
      findings.push({
        severity: "critical",
        code: "invalid-task-artifact",
        message: diagnostic.message,
        artifactIds: taskArtifact ? [taskArtifact.id] : [],
        relatedIds: diagnostic.taskId ? [diagnostic.taskId] : undefined,
        line: diagnostic.line,
      });
    }
  }

  for (const id of requirementIds) {
    if (!tasksUpper.includes(id) && !hasOutOfScopeNote(content, id)) {
      findings.push({
        severity: "critical",
        code: "missing-requirement-coverage",
        message: `${id} has no covering task or explicit out-of-scope note`,
        artifactIds: input.artifacts.map((artifact) => artifact.id),
        relatedIds: [id],
      });
    }
  }

  for (const id of successIds) {
    if (!tasksUpper.includes(id) && !hasOutOfScopeNote(content, id)) {
      findings.push({
        severity: "critical",
        code: "missing-success-coverage",
        message: `${id} has no covering task or explicit out-of-scope note`,
        artifactIds: input.artifacts.map((artifact) => artifact.id),
        relatedIds: [id],
      });
    }
    const hasVerificationTask = tasks.some(
      (task) => task.raw.toUpperCase().includes(id) && VERIFY_PATTERN.test(task.raw),
    );
    if (!hasVerificationTask) {
      findings.push({
        severity: "warning",
        code: "missing-verification-task",
        message: `${id} has no explicit verification task`,
        artifactIds: taskArtifact ? [taskArtifact.id] : [],
        relatedIds: [id],
      });
    }
  }

  for (const task of tasks) {
    resetGlobalPatterns();
    if (!mappedTask(task)) {
      findings.push({
        severity: "warning",
        code: "unmapped-task",
        message: `${task.id} does not reference a requirement, story, success criterion, plan decision, or maintenance reason`,
        artifactIds: taskArtifact ? [taskArtifact.id] : [],
        relatedIds: [task.id],
        line: task.line,
      });
    }
  }

  for (const artifact of input.artifacts) {
    if (structuredSpecArtifactIds.has(artifact.id)) continue;
    if (structuredPlanArtifactIds.has(artifact.id)) continue;
    const lines = artifact.content.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (PLACEHOLDER_PATTERN.test(line)) {
        findings.push({
          severity: "critical",
          code: "placeholder",
          message: `unresolved placeholder in ${artifact.id} on line ${index + 1}`,
          artifactIds: [artifact.id],
          line: index + 1,
        });
      }
      PLACEHOLDER_PATTERN.lastIndex = 0;
    });
  }

  const order = new Map(tasks.map((task, index) => [task.id, index]));
  for (const task of tasks) {
    const taskIndex = order.get(task.id) ?? 0;
    for (const dependency of task.dependencies) {
      const dependencyIndex = order.get(dependency);
      if (dependencyIndex !== undefined && dependencyIndex > taskIndex) {
        findings.push({
          severity: "critical",
          code: "dependency-order",
          message: `${task.id} depends on later task ${dependency}`,
          artifactIds: taskArtifact ? [taskArtifact.id] : [],
          relatedIds: [task.id, dependency],
          line: task.line,
        });
      }
    }
  }

  for (const rule of constitutionRules(input.constitution)) {
    for (const artifact of input.artifacts) {
      if (artifact.content.toLowerCase().includes(rule)) {
        findings.push({
          severity: "critical",
          code: "constitution-conflict",
          message: `${artifact.id} conflicts with constitution rule "must not ${rule}"`,
          artifactIds: [artifact.id],
        });
      }
    }
  }

  const summary = countSummary(findings);
  const markdown = [
    "# Spec Plan Task Analysis",
    "",
    `Critical: ${summary.critical}`,
    `Warnings: ${summary.warning}`,
    `Info: ${summary.info}`,
    "",
    markdownTable(findings),
    "",
  ].join("\n");
  return { findings, summary, markdown };
}
