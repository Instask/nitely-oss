import { createHash } from "node:crypto";

import { parseTaskArtifact } from "./parse.js";

export const CONVERGENCE_REPORT_VERSION = "nitely.convergence.v1";
export const CONVERGENCE_REPORT_MEDIA_TYPE =
  "application/vnd.nitely.convergence+json";

export const CONVERGENCE_REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "gaps"],
  properties: {
    version: { type: "string" },
    summary: { type: "string" },
    gaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["classification", "title", "sourceRefs", "evidence"],
        properties: {
          classification: { type: "string" },
          title: { type: "string" },
          sourceRefs: { type: "array", items: { type: "string" } },
          evidence: { type: "array", items: { type: "string" } },
          paths: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

export type ConvergenceClassification =
  | "missing"
  | "partial"
  | "contradicts"
  | "unrequested";

export interface ConvergenceGap {
  classification: ConvergenceClassification;
  title: string;
  sourceRefs: string[];
  evidence: string[];
  paths: string[];
}

export interface ConvergenceReport {
  version: typeof CONVERGENCE_REPORT_VERSION;
  summary?: string;
  gaps: ConvergenceGap[];
}

export interface AppendedConvergenceTask {
  taskId: string;
  fingerprint: string;
  gap: ConvergenceGap;
}

export interface ConvergenceAppendResult {
  content: Buffer;
  unchanged: boolean;
  appended: AppendedConvergenceTask[];
  skippedFingerprints: string[];
}

const CLASSIFICATIONS = new Set<ConvergenceClassification>([
  "missing",
  "partial",
  "contradicts",
  "unrequested",
]);
const GAP_KEYS = new Set([
  "classification",
  "title",
  "sourceRefs",
  "evidence",
  "paths",
]);
const REPORT_KEYS = new Set(["version", "summary", "gaps"]);
const SOURCE_ID_PATTERN = /^(?:FR|SC|US|AC|PD|D)-\d{3}$/i;
const SCENARIO_SOURCE_PATTERN = /^US-\d{3}\/AC-\d{3}$/i;
const NAMED_SOURCE_PATTERN = /^(?:plan|constitution):[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/i;
const FINGERPRINT_MARKER_PATTERN =
  /<!--\s*nitely-convergence:([a-f0-9]{64})\s*-->/gi;
const MAX_GAPS = 200;
const MAX_TITLE_LENGTH = 500;
const MAX_EVIDENCE_LENGTH = 2_000;
const MAX_PATH_LENGTH = 500;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string[] {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function inlineText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function stringArray(
  value: unknown,
  input: {
    field: string;
    index: number;
    maxItems: number;
    maxLength: number;
  },
): { values: string[]; errors: string[] } {
  if (!Array.isArray(value)) {
    return { values: [], errors: [`gaps[${input.index}].${input.field} must be an array`] };
  }
  if (value.length === 0) {
    return {
      values: [],
      errors: [`gaps[${input.index}].${input.field} must contain at least one value`],
    };
  }
  if (value.length > input.maxItems) {
    return {
      values: [],
      errors: [
        `gaps[${input.index}].${input.field} must contain at most ${input.maxItems} values`,
      ],
    };
  }
  const errors: string[] = [];
  const values: string[] = [];
  value.forEach((item, itemIndex) => {
    const normalized = inlineText(item);
    if (!normalized) {
      errors.push(
        `gaps[${input.index}].${input.field}[${itemIndex}] must be a non-empty string`,
      );
      return;
    }
    if (normalized.length > input.maxLength) {
      errors.push(
        `gaps[${input.index}].${input.field}[${itemIndex}] must be at most ${input.maxLength} characters`,
      );
      return;
    }
    values.push(normalized);
  });
  return { values, errors };
}

function normalizeSourceRef(value: string): string | undefined {
  if (SOURCE_ID_PATTERN.test(value) || SCENARIO_SOURCE_PATTERN.test(value)) {
    return value.toUpperCase();
  }
  if (NAMED_SOURCE_PATTERN.test(value)) {
    const separator = value.indexOf(":");
    return `${value.slice(0, separator).toLowerCase()}:${value
      .slice(separator + 1)
      .toLowerCase()}`;
  }
  return undefined;
}

function normalizeRepositoryPath(value: string): string | undefined {
  if (
    value.length > MAX_PATH_LENGTH ||
    value.includes("\\") ||
    value.includes("`") ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    return undefined;
  }
  const segments = value.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === "..",
    )
  ) {
    return undefined;
  }
  return value;
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(compareCanonicalText);
}

function parseGap(
  value: unknown,
  index: number,
): { gap?: ConvergenceGap; errors: string[] } {
  const record = asRecord(value);
  if (!record) {
    return { errors: [`gaps[${index}] must be an object`] };
  }
  const errors = unknownKeys(record, GAP_KEYS).map(
    (key) => `gaps[${index}] contains unknown field ${key}`,
  );
  const classification = inlineText(record.classification)?.toLowerCase();
  if (!classification || !CLASSIFICATIONS.has(classification as ConvergenceClassification)) {
    errors.push(`gaps[${index}].classification is invalid`);
  }
  const title = inlineText(record.title);
  if (!title) {
    errors.push(`gaps[${index}].title is required`);
  } else if (title.length > MAX_TITLE_LENGTH) {
    errors.push(`gaps[${index}].title must be at most ${MAX_TITLE_LENGTH} characters`);
  }

  const sourceRefs = stringArray(record.sourceRefs, {
    field: "sourceRefs",
    index,
    maxItems: 20,
    maxLength: 96,
  });
  errors.push(...sourceRefs.errors);
  const normalizedSourceRefs: string[] = [];
  sourceRefs.values.forEach((sourceRef, sourceIndex) => {
    const normalized = normalizeSourceRef(sourceRef);
    if (!normalized) {
      errors.push(
        `gaps[${index}].sourceRefs[${sourceIndex}] is not a supported source reference: ${sourceRef}`,
      );
      return;
    }
    normalizedSourceRefs.push(normalized);
  });

  const evidence = stringArray(record.evidence, {
    field: "evidence",
    index,
    maxItems: 50,
    maxLength: MAX_EVIDENCE_LENGTH,
  });
  errors.push(...evidence.errors);

  const paths: string[] = [];
  if (record.paths !== undefined) {
    if (!Array.isArray(record.paths)) {
      errors.push(`gaps[${index}].paths must be an array`);
    } else if (record.paths.length > 50) {
      errors.push(`gaps[${index}].paths must contain at most 50 values`);
    } else {
      record.paths.forEach((path, pathIndex) => {
        const normalizedText =
          typeof path === "string" && path.trim().length > 0
            ? path.trim()
            : undefined;
        const normalized = normalizedText
          ? normalizeRepositoryPath(normalizedText)
          : undefined;
        if (!normalized) {
          errors.push(
            `gaps[${index}].paths[${pathIndex}] must be a safe repository-relative path`,
          );
          return;
        }
        paths.push(normalized);
      });
    }
  }

  if (errors.length > 0 || !title || !classification) {
    return { errors };
  }
  return {
    errors: [],
    gap: {
      classification: classification as ConvergenceClassification,
      title,
      sourceRefs: normalizedUnique(normalizedSourceRefs),
      evidence: normalizedUnique(evidence.values),
      paths: normalizedUnique(paths),
    },
  };
}

export function convergenceGapFingerprint(gap: ConvergenceGap): string {
  const canonical = JSON.stringify({
    classification: gap.classification,
    title: inlineText(gap.title),
    sourceRefs: normalizedUnique(gap.sourceRefs),
    paths: normalizedUnique(gap.paths),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function parseConvergenceReport(
  value: unknown,
): { report?: ConvergenceReport; errors: string[] } {
  const root = asRecord(value);
  if (!root) {
    return { errors: ["convergence report must be an object"] };
  }
  const errors = unknownKeys(root, REPORT_KEYS).map(
    (key) => `convergence report contains unknown field ${key}`,
  );
  if (root.version !== CONVERGENCE_REPORT_VERSION) {
    errors.push(
      `convergence report version must be ${CONVERGENCE_REPORT_VERSION}`,
    );
  }
  const summary = root.summary === undefined ? undefined : inlineText(root.summary);
  if (root.summary !== undefined && !summary) {
    errors.push("convergence report summary must be a non-empty string");
  }
  if (!Array.isArray(root.gaps)) {
    errors.push("convergence report gaps must be an array");
    return { errors };
  }
  if (root.gaps.length > MAX_GAPS) {
    errors.push(`convergence report gaps must contain at most ${MAX_GAPS} entries`);
  }
  const gaps: ConvergenceGap[] = [];
  for (const [index, value] of root.gaps.entries()) {
    const parsed = parseGap(value, index);
    errors.push(...parsed.errors);
    if (parsed.gap) gaps.push(parsed.gap);
  }
  const fingerprints = new Map<string, number>();
  gaps.forEach((gap, index) => {
    const fingerprint = convergenceGapFingerprint(gap);
    const first = fingerprints.get(fingerprint);
    if (first !== undefined) {
      errors.push(
        `gaps[${index}] duplicates semantic gap gaps[${first}] (${fingerprint})`,
      );
    } else {
      fingerprints.set(fingerprint, index);
    }
  });
  if (errors.length > 0) return { errors };
  return {
    errors: [],
    report: {
      version: CONVERGENCE_REPORT_VERSION,
      ...(summary ? { summary } : {}),
      gaps,
    },
  };
}

export function parseConvergenceReportText(
  content: string,
): { report?: ConvergenceReport; errors: string[] } {
  try {
    return parseConvergenceReport(JSON.parse(content) as unknown);
  } catch (error) {
    return {
      errors: [
        `convergence report is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }
}

function existingFingerprints(markdown: string): Set<string> {
  const fingerprints = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    if (!/^-\s+\[(?: |x|X)\]\s+.*\bT\d{3}\b/.test(line)) continue;
    for (const match of line.matchAll(FINGERPRINT_MARKER_PATTERN)) {
      fingerprints.add(match[1]!.toLowerCase());
    }
  }
  return fingerprints;
}

function markdownInline(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "'")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function appendSeparator(markdown: string, newline: string): string {
  if (markdown.length === 0) return "";
  if (markdown.endsWith(`${newline}${newline}`)) return "";
  return markdown.endsWith(newline) ? newline : `${newline}${newline}`;
}

export function appendConvergenceTasks(
  taskArtifact: Buffer | string,
  report: ConvergenceReport,
): ConvergenceAppendResult {
  const source = Buffer.isBuffer(taskArtifact)
    ? Buffer.from(taskArtifact)
    : Buffer.from(taskArtifact, "utf8");
  const markdown = source.toString("utf8");
  const parsedTasks = parseTaskArtifact(markdown);
  if (!parsedTasks.valid) {
    throw new Error(
      `cannot converge invalid task artifact: ${parsedTasks.diagnostics
        .map((diagnostic) => `line ${diagnostic.line}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }

  const existing = existingFingerprints(markdown);
  const seenReportFingerprints = new Set<string>();
  const candidates = report.gaps
    .map((gap) => ({ gap, fingerprint: convergenceGapFingerprint(gap) }))
    .filter(({ fingerprint }) => {
      if (seenReportFingerprints.has(fingerprint)) {
        throw new Error(
          `convergence report contains duplicate semantic gap ${fingerprint}`,
        );
      }
      seenReportFingerprints.add(fingerprint);
      return !existing.has(fingerprint);
    })
    .sort((left, right) =>
      compareCanonicalText(left.fingerprint, right.fingerprint),
    );

  const skippedFingerprints = report.gaps
    .map(convergenceGapFingerprint)
    .filter((fingerprint) => existing.has(fingerprint));
  if (candidates.length === 0) {
    return {
      content: source,
      unchanged: true,
      appended: [],
      skippedFingerprints,
    };
  }

  let nextNumber = parsedTasks.tasks.reduce(
    (maximum, task) => Math.max(maximum, Number.parseInt(task.id.slice(1), 10)),
    0,
  );
  if (nextNumber + candidates.length > 999) {
    throw new Error(
      `cannot append ${candidates.length} convergence task(s): task ID space after T${String(
        nextNumber,
      ).padStart(3, "0")} is exhausted`,
    );
  }

  const appended: AppendedConvergenceTask[] = candidates.map(
    ({ gap, fingerprint }) => {
      nextNumber += 1;
      return {
        taskId: `T${String(nextNumber).padStart(3, "0")}`,
        fingerprint,
        gap,
      };
    },
  );
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = [
    "## Convergence",
    "",
    "<!-- Appended by Nitely from a validated convergence report. -->",
    "",
    ...appended.map(({ taskId, fingerprint, gap }) => {
      const refs = gap.sourceRefs.join(" ");
      const paths =
        gap.paths.length > 0
          ? ` in ${gap.paths.map((path) => `\`${path}\``).join(", ")}`
          : "";
      return `- [ ] ${taskId} [CONVERGENCE:${gap.classification}] ${refs} ${markdownInline(
        gap.title,
      )}${paths} <!-- nitely-convergence:${fingerprint} -->`;
    }),
    "",
  ];
  const suffix = `${appendSeparator(markdown, newline)}${lines.join(newline)}`;
  return {
    content: Buffer.concat([source, Buffer.from(suffix, "utf8")]),
    unchanged: false,
    appended,
    skippedFingerprints,
  };
}
