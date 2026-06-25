import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type TechnicalPlanDiagnosticCode =
  | "missing-section"
  | "duplicate-decision-id"
  | "placeholder"
  | "incomplete-complexity-tracking";

export type TechnicalPlanDiagnosticSeverity = "error" | "warning";

export interface TechnicalPlanDiagnostic {
  code: TechnicalPlanDiagnosticCode;
  severity: TechnicalPlanDiagnosticSeverity;
  line: number;
  message: string;
  id?: string;
  section?: string;
}

export interface TechnicalPlanDecision {
  id: string;
  line: number;
  text: string;
  section: string;
}

export interface TechnicalPlanComplexityItem {
  decisionId: string;
  line: number;
  complexityIntroduced: boolean;
  simplerAlternativeRejected: boolean;
  reason: boolean;
}

export interface ParsedTechnicalPlan {
  valid: boolean;
  decisions: TechnicalPlanDecision[];
  files: string[];
  testStrategy: string[];
  constitutionChecks: string[];
  complexityItems: TechnicalPlanComplexityItem[];
  diagnostics: TechnicalPlanDiagnostic[];
}

interface SectionDefinition {
  key: string;
  label: string;
  aliases: RegExp[];
}

interface SectionRange {
  definition: SectionDefinition;
  headingLine: number;
  startLine: number;
  endLine: number;
}

const REQUIRED_SECTIONS: SectionDefinition[] = [
  { key: "summary", label: "Summary", aliases: [/^summary$/] },
  {
    key: "technical-context",
    label: "Technical Context",
    aliases: [/^technical context$/],
  },
  {
    key: "files-modules",
    label: "Files / Modules Touched",
    aliases: [/^files\s*\/\s*modules touched$/, /^files modules touched$/],
  },
  {
    key: "data-model",
    label: "Data Model Or Schema Changes",
    aliases: [/^data model or schema changes$/, /^schema changes$/],
  },
  {
    key: "contract-changes",
    label: "Flow / API / CLI Contract Changes",
    aliases: [
      /^flow\s*\/\s*api\s*\/\s*cli contract changes$/,
      /^api contract changes$/,
      /^contract changes$/,
    ],
  },
  {
    key: "failure-modes",
    label: "Failure Modes And Recovery Behavior",
    aliases: [/^failure modes and recovery behavior$/, /^failure modes$/],
  },
  {
    key: "compatibility",
    label: "Compatibility And Migration Plan",
    aliases: [/^compatibility and migration plan$/, /^migration plan$/],
  },
  {
    key: "test-strategy",
    label: "Test Strategy",
    aliases: [/^test strategy$/, /^testing strategy$/],
  },
  {
    key: "constitution-check",
    label: "Constitution Check",
    aliases: [/^constitution check$/],
  },
  {
    key: "complexity-tracking",
    label: "Complexity Tracking",
    aliases: [/^complexity tracking$/, /^complexity justification$/],
  },
];

const HEADING_PATTERN = /^(#{2,4})\s+(.+?)\s*$/;
const DECISION_PATTERN = /\bPD-\d{3}\b/gi;
const BACKTICK_PATTERN = /`([^`]+)`/g;
const PLACEHOLDER_PATTERN =
  /\b(?:TBD|TODO|FIXME)\b|\{\{[^}]+\}\}|<([A-Z][A-Z0-9_-]*)>/;

function normalizeHeading(input: string): string {
  return input
    .replace(/[*_`]/g, "")
    .replace(/:$/, "")
    .trim()
    .toLowerCase();
}

function findSectionDefinition(heading: string): SectionDefinition | undefined {
  const normalized = normalizeHeading(heading);
  return REQUIRED_SECTIONS.find((definition) =>
    definition.aliases.some((alias) => alias.test(normalized)),
  );
}

function sectionRanges(markdown: string): SectionRange[] {
  const lines = markdown.split(/\r?\n/);
  const headings: Array<{
    definition: SectionDefinition;
    headingLine: number;
    startLine: number;
  }> = [];

  lines.forEach((line, index) => {
    const match = HEADING_PATTERN.exec(line);
    if (!match) return;
    const definition = findSectionDefinition(match[2] ?? "");
    if (!definition) return;
    headings.push({
      definition,
      headingLine: index + 1,
      startLine: index + 2,
    });
  });

  return headings.map((heading, index) => ({
    ...heading,
    endLine: (headings[index + 1]?.headingLine ?? lines.length + 1) - 1,
  }));
}

function sectionLines(lines: string[], range?: SectionRange): string[] {
  if (!range) return [];
  return lines.slice(range.startLine - 1, range.endLine);
}

function parseFiles(lines: string[], range?: SectionRange): string[] {
  const files = new Set<string>();
  for (const line of sectionLines(lines, range)) {
    for (const match of line.matchAll(BACKTICK_PATTERN)) {
      const value = match[1]?.trim();
      if (!value) continue;
      if (value.includes("/") || /\.[A-Za-z0-9]+$/.test(value)) {
        files.add(value);
      }
    }
  }
  return [...files];
}

function parseDecisions(input: {
  lines: string[];
  ranges: SectionRange[];
  diagnostics: TechnicalPlanDiagnostic[];
}): TechnicalPlanDecision[] {
  const decisions: TechnicalPlanDecision[] = [];
  const seen = new Map<string, number>();
  const decisionRanges = input.ranges.filter(
    (range) => range.definition.key !== "complexity-tracking",
  );

  for (const range of decisionRanges) {
    const lines = sectionLines(input.lines, range);
    lines.forEach((line, offset) => {
      const lineNumber = range.startLine + offset;
      for (const match of line.matchAll(DECISION_PATTERN)) {
        const id = match[0].toUpperCase();
        const firstSeen = seen.get(id);
        if (firstSeen !== undefined) {
          input.diagnostics.push({
            code: "duplicate-decision-id",
            severity: "error",
            line: lineNumber,
            id,
            section: range.definition.label,
            message: `duplicate ${id}; first seen on line ${firstSeen}`,
          });
        } else {
          seen.set(id, lineNumber);
        }
        decisions.push({
          id,
          line: lineNumber,
          text: line.trim(),
          section: range.definition.label,
        });
      }
    });
  }
  return decisions;
}

function parseComplexity(input: {
  lines: string[];
  range?: SectionRange;
  diagnostics: TechnicalPlanDiagnostic[];
}): TechnicalPlanComplexityItem[] {
  const range = input.range;
  if (!range) return [];
  const lines = sectionLines(input.lines, range);
  const nonEmptyLines = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (
    nonEmptyLines.length > 0 &&
    nonEmptyLines.every((line) => /^[-*]?\s*(?:none|n\/a)\.?\s*$/i.test(line))
  ) {
    return [];
  }

  const items: TechnicalPlanComplexityItem[] = [];
  let current: TechnicalPlanComplexityItem | undefined;
  for (const [offset, line] of lines.entries()) {
    const lineNumber = range.startLine + offset;
    const idMatch = /\bPD-\d{3}\b/i.exec(line);
    if (/^\s*[-*]\s+\*\*PD-\d{3}\*\*/i.test(line) && idMatch) {
      if (current) items.push(current);
      current = {
        decisionId: idMatch[0].toUpperCase(),
        line: lineNumber,
        complexityIntroduced: false,
        simplerAlternativeRejected: false,
        reason: false,
      };
      continue;
    }
    if (!current) continue;
    if (/complexity introduced/i.test(line)) current.complexityIntroduced = true;
    if (/simpler alternative rejected/i.test(line)) {
      current.simplerAlternativeRejected = true;
    }
    if (/\breason\b/i.test(line)) current.reason = true;
  }
  if (current) items.push(current);

  if (items.length === 0 && nonEmptyLines.length > 0) {
    input.diagnostics.push({
      code: "incomplete-complexity-tracking",
      severity: "error",
      line: range.startLine,
      section: range.definition.label,
      message: "complexity tracking must be None/N/A or include PD-### entries",
    });
  }

  for (const item of items) {
    if (
      item.complexityIntroduced &&
      item.simplerAlternativeRejected &&
      item.reason
    ) {
      continue;
    }
    input.diagnostics.push({
      code: "incomplete-complexity-tracking",
      severity: "error",
      line: item.line,
      id: item.decisionId,
      section: range.definition.label,
      message: `${item.decisionId} complexity tracking must include complexity introduced, simpler alternative rejected, and reason`,
    });
  }

  return items;
}

function loadTemplate(): string {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const templatePath = join(
    currentDirectory,
    "../../docs/templates/nitely-technical-plan.md",
  );
  return readFileSync(templatePath, "utf8");
}

export const technicalPlanTemplate = loadTemplate();

export function parseTechnicalPlan(markdown: string): ParsedTechnicalPlan {
  const diagnostics: TechnicalPlanDiagnostic[] = [];
  const lines = markdown.split(/\r?\n/);
  const ranges = sectionRanges(markdown);

  for (const definition of REQUIRED_SECTIONS) {
    if (!ranges.some((range) => range.definition.key === definition.key)) {
      diagnostics.push({
        code: "missing-section",
        severity: "error",
        line: 1,
        section: definition.label,
        message: `missing required section: ${definition.label}`,
      });
    }
  }

  lines.forEach((line, index) => {
    if (!PLACEHOLDER_PATTERN.test(line)) return;
    diagnostics.push({
      code: "placeholder",
      severity: "error",
      line: index + 1,
      message: `unresolved placeholder on line ${index + 1}`,
    });
  });

  const rangeByKey = new Map(ranges.map((range) => [range.definition.key, range]));
  const decisions = parseDecisions({ lines, ranges, diagnostics });
  const complexityItems = parseComplexity({
    lines,
    range: rangeByKey.get("complexity-tracking"),
    diagnostics,
  });

  return {
    valid: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
    decisions,
    files: parseFiles(lines, rangeByKey.get("files-modules")),
    testStrategy: sectionLines(lines, rangeByKey.get("test-strategy")).filter(
      (line) => line.trim().length > 0,
    ),
    constitutionChecks: sectionLines(
      lines,
      rangeByKey.get("constitution-check"),
    ).filter((line) => line.trim().length > 0),
    complexityItems,
    diagnostics,
  };
}

export function validateTechnicalPlan(markdown: string): ParsedTechnicalPlan {
  return parseTechnicalPlan(markdown);
}
