import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type StructuredSpecDiagnosticCode =
  | "missing-section"
  | "missing-id"
  | "duplicate-id"
  | "placeholder";

export type StructuredSpecDiagnosticSeverity = "error" | "warning";
export type StructuredSpecStatus = "draft" | "approved";

export interface StructuredSpecDiagnostic {
  code: StructuredSpecDiagnosticCode;
  severity: StructuredSpecDiagnosticSeverity;
  line: number;
  message: string;
  id?: string;
  section?: string;
}

export interface StructuredSpecItem {
  id: string;
  line: number;
  text: string;
  section: string;
}

export interface ParsedStructuredSpec {
  valid: boolean;
  status?: StructuredSpecStatus;
  stories: StructuredSpecItem[];
  requirements: StructuredSpecItem[];
  successCriteria: StructuredSpecItem[];
  diagnostics: StructuredSpecDiagnostic[];
}

interface SectionDefinition {
  key: string;
  label: string;
  aliases: RegExp[];
  idPrefix?: "US" | "FR" | "SC";
}

interface SectionRange {
  definition: SectionDefinition;
  headingLine: number;
  startLine: number;
  endLine: number;
}

const PLACEHOLDER_PATTERN =
  /\b(?:TBD|TODO|FIXME)\b|\{\{[^}]+\}\}|<([A-Z][A-Z0-9_-]*)>/;
const HEADING_PATTERN = /^(#{2,4})\s+(.+?)\s*$/;
const LIST_ITEM_PATTERN = /^\s*[-*]\s+(.*)$/;
const STATUS_LINE_PATTERN = /^Status:\s*(draft|approved)\s*$/i;

const REQUIRED_SECTIONS: SectionDefinition[] = [
  {
    key: "background",
    label: "Background",
    aliases: [/^background$/, /^problem statement$/],
  },
  {
    key: "user-stories",
    label: "User Stories",
    aliases: [/^user stories$/, /^operator stories$/],
    idPrefix: "US",
  },
  {
    key: "acceptance-scenarios",
    label: "Acceptance Scenarios",
    aliases: [/^acceptance scenarios?$/, /^acceptance criteria$/],
  },
  {
    key: "functional-requirements",
    label: "Functional Requirements",
    aliases: [/^functional requirements?$/, /^requirements$/],
    idPrefix: "FR",
  },
  {
    key: "success-criteria",
    label: "Success Criteria",
    aliases: [/^success criteria$/, /^verification criteria$/],
    idPrefix: "SC",
  },
  {
    key: "edge-cases",
    label: "Edge Cases",
    aliases: [/^edge cases?(?: and failure behavior)?$/, /^failure behavior$/],
  },
  {
    key: "assumptions",
    label: "Assumptions",
    aliases: [/^assumptions?(?: and dependencies)?$/],
  },
  {
    key: "out-of-scope",
    label: "Out Of Scope",
    aliases: [/^out of scope$/, /^non-goals?$/],
  },
];

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

function idPattern(prefix: "US" | "FR" | "SC"): RegExp {
  return new RegExp(`\\b${prefix}-\\d{3}\\b`, "i");
}

function sectionRanges(markdown: string): SectionRange[] {
  const lines = markdown.split(/\r?\n/);
  const ranges: SectionRange[] = [];
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

  headings.forEach((heading, index) => {
    ranges.push({
      ...heading,
      endLine: (headings[index + 1]?.headingLine ?? lines.length + 1) - 1,
    });
  });
  return ranges;
}

function leadingMetadataEndLine(lines: string[]): number {
  const sectionIndex = lines.findIndex((line) => /^#{2,6}\s+/.test(line));
  return sectionIndex === -1 ? lines.length : sectionIndex;
}

function parseStructuredSpecStatus(lines: string[]): StructuredSpecStatus | undefined {
  for (const line of lines.slice(0, leadingMetadataEndLine(lines))) {
    const match = STATUS_LINE_PATTERN.exec(line.trim());
    if (match) {
      return match[1]?.toLowerCase() as StructuredSpecStatus;
    }
  }
  return undefined;
}

export function setStructuredSpecStatus(
  markdown: string,
  status: StructuredSpecStatus,
): string {
  const lines = markdown.split(/\r?\n/);
  const metadataEndLine = leadingMetadataEndLine(lines);
  const statusLine = `Status: ${status}`;

  for (let index = 0; index < metadataEndLine; index += 1) {
    if (STATUS_LINE_PATTERN.test(lines[index]?.trim() ?? "")) {
      lines[index] = statusLine;
      return lines.join("\n");
    }
  }

  const insertAt = lines[0]?.startsWith("# ") ? 1 : 0;
  const nextLineIsBlank = lines[insertAt]?.trim() === "";
  const insertion = nextLineIsBlank ? ["", statusLine] : [statusLine, ""];
  lines.splice(insertAt, 0, ...insertion);
  return lines.join("\n");
}

function sectionText(lines: string[], range: SectionRange): string[] {
  return lines.slice(range.startLine - 1, range.endLine);
}

function parseItems(input: {
  lines: string[];
  range: SectionRange;
  diagnostics: StructuredSpecDiagnostic[];
}): StructuredSpecItem[] {
  const prefix = input.range.definition.idPrefix;
  if (!prefix) return [];
  const pattern = idPattern(prefix);
  const items: StructuredSpecItem[] = [];
  const seen = new Map<string, number>();
  const lines = sectionText(input.lines, input.range);

  lines.forEach((line, offset) => {
    const lineNumber = input.range.startLine + offset;
    const listItem = LIST_ITEM_PATTERN.exec(line);
    if (!listItem) return;
    const text = listItem[1]?.trim() ?? "";
    const match = pattern.exec(text);
    if (!match) {
      input.diagnostics.push({
        code: "missing-id",
        severity: "error",
        line: lineNumber,
        section: input.range.definition.label,
        message: `${input.range.definition.label} list item must include a ${prefix}-### id`,
      });
      return;
    }
    const id = match[0].toUpperCase();
    const firstSeen = seen.get(id);
    if (firstSeen !== undefined) {
      input.diagnostics.push({
        code: "duplicate-id",
        severity: "error",
        line: lineNumber,
        id,
        section: input.range.definition.label,
        message: `duplicate ${id}; first seen on line ${firstSeen}`,
      });
    } else {
      seen.set(id, lineNumber);
    }
    items.push({
      id,
      line: lineNumber,
      text,
      section: input.range.definition.label,
    });
  });

  return items;
}

function loadTemplate(): string {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const templatePath = join(currentDirectory, "../../docs/templates/nitely-spec.md");
  return readFileSync(templatePath, "utf8");
}

export const structuredSpecTemplate = loadTemplate();

export function parseStructuredSpec(markdown: string): ParsedStructuredSpec {
  const diagnostics: StructuredSpecDiagnostic[] = [];
  const lines = markdown.split(/\r?\n/);
  const ranges = sectionRanges(markdown);
  const status = parseStructuredSpecStatus(lines);

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

  const stories: StructuredSpecItem[] = [];
  const requirements: StructuredSpecItem[] = [];
  const successCriteria: StructuredSpecItem[] = [];

  for (const range of ranges) {
    const items = parseItems({ lines, range, diagnostics });
    if (range.definition.idPrefix === "US") stories.push(...items);
    if (range.definition.idPrefix === "FR") requirements.push(...items);
    if (range.definition.idPrefix === "SC") successCriteria.push(...items);
  }

  return {
    valid: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
    ...(status ? { status } : {}),
    stories,
    requirements,
    successCriteria,
    diagnostics,
  };
}

export function validateStructuredSpec(markdown: string): ParsedStructuredSpec {
  return parseStructuredSpec(markdown);
}
