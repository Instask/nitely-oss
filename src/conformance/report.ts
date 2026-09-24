export const DEFAULT_CONFORMANCE_REPORT_ID = "conformance-report";
export const CONFORMANCE_REPORT_MEDIA_TYPE =
  "application/vnd.nitely.conformance+json";

export const CONFORMANCE_REPORT_SCHEMA = {
  type: "object",
  required: ["items"],
  properties: {
    version: { type: "number" },
    summary: { type: "string" },
    mode: { type: "string" },
    items: { type: "array" },
    scopeDrift: { type: "array" },
  },
};

export type ConformanceMode = "strict" | "advisory";
export type ConformanceStatus =
  | "satisfied"
  | "partially_satisfied"
  | "not_satisfied"
  | "not_verified"
  | "not_applicable";

export type ConformanceFindingSeverity = "info" | "warning" | "blocking";

export interface ConformanceItem {
  id: string;
  status: ConformanceStatus;
  evidence: string[];
  files: string[];
  tests: string[];
  artifacts: string[];
  rationale?: string;
}

export interface ScopeDriftFinding {
  severity: ConformanceFindingSeverity;
  description: string;
  files: string[];
  rationale?: string;
}

export interface ConformanceReport {
  version?: number;
  summary?: string;
  mode?: ConformanceMode;
  items: ConformanceItem[];
  scopeDrift: ScopeDriftFinding[];
}

export interface ConformancePolicy {
  mode: ConformanceMode;
  reportId: string;
  requiredIds: string[];
}

export interface ConformanceFinding {
  severity: ConformanceFindingSeverity;
  code:
    | "missing-report"
    | "invalid-report"
    | "missing-required-id"
    | "unsatisfied-item"
    | "scope-drift";
  message: string;
  itemId?: string;
}

const VALID_STATUSES = new Set<ConformanceStatus>([
  "satisfied",
  "partially_satisfied",
  "not_satisfied",
  "not_verified",
  "not_applicable",
]);

const VALID_MODES = new Set<ConformanceMode>(["strict", "advisory"]);
const VALID_SEVERITIES = new Set<ConformanceFindingSeverity>([
  "info",
  "warning",
  "blocking",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function parseConformanceReport(
  value: unknown,
): { report?: ConformanceReport; errors: string[] } {
  const root = asRecord(value);
  if (!root) {
    return { errors: ["conformance report must be an object"] };
  }
  if (!Array.isArray(root.items)) {
    return { errors: ["conformance report items must be an array"] };
  }
  const errors: string[] = [];
  const items: ConformanceItem[] = [];
  for (const [index, rawItem] of root.items.entries()) {
    const item = asRecord(rawItem);
    const id = stringValue(item?.id);
    const status = stringValue(item?.status);
    if (!id) {
      errors.push(`items[${index}].id is required`);
      continue;
    }
    if (!status || !VALID_STATUSES.has(status as ConformanceStatus)) {
      errors.push(`items[${index}].status is invalid for ${id}`);
      continue;
    }
    items.push({
      id,
      status: status as ConformanceStatus,
      evidence: stringArray(item?.evidence),
      files: stringArray(item?.files),
      tests: stringArray(item?.tests),
      artifacts: stringArray(item?.artifacts),
      ...(stringValue(item?.rationale)
        ? { rationale: stringValue(item?.rationale) }
        : {}),
    });
  }

  const scopeDrift: ScopeDriftFinding[] = [];
  if (Array.isArray(root.scopeDrift)) {
    for (const [index, rawFinding] of root.scopeDrift.entries()) {
      const finding = asRecord(rawFinding);
      const description = stringValue(finding?.description);
      const severity = stringValue(finding?.severity) ?? "warning";
      if (!description) {
        errors.push(`scopeDrift[${index}].description is required`);
        continue;
      }
      if (!VALID_SEVERITIES.has(severity as ConformanceFindingSeverity)) {
        errors.push(`scopeDrift[${index}].severity is invalid`);
        continue;
      }
      scopeDrift.push({
        severity: severity as ConformanceFindingSeverity,
        description,
        files: stringArray(finding?.files),
        ...(stringValue(finding?.rationale)
          ? { rationale: stringValue(finding?.rationale) }
          : {}),
      });
    }
  }

  const mode = stringValue(root.mode);
  if (mode && !VALID_MODES.has(mode as ConformanceMode)) {
    errors.push("conformance report mode is invalid");
  }

  if (errors.length > 0) {
    return { errors };
  }

  return {
    errors: [],
    report: {
      ...(typeof root.version === "number" ? { version: root.version } : {}),
      ...(stringValue(root.summary) ? { summary: stringValue(root.summary) } : {}),
      ...(mode ? { mode: mode as ConformanceMode } : {}),
      items,
      scopeDrift,
    },
  };
}

export function parseConformanceReportText(
  content: string,
): { report?: ConformanceReport; errors: string[] } {
  try {
    return parseConformanceReport(JSON.parse(content) as unknown);
  } catch (error) {
    return {
      errors: [
        `conformance report is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }
}

export function evaluateConformanceReport(
  report: ConformanceReport | undefined,
  policy: ConformancePolicy,
  parseErrors: string[] = [],
): ConformanceFinding[] {
  const severity: ConformanceFindingSeverity =
    policy.mode === "strict" ? "blocking" : "warning";
  if (!report) {
    return [
      {
        severity,
        code: parseErrors.length > 0 ? "invalid-report" : "missing-report",
        message:
          parseErrors.length > 0
            ? parseErrors.join("; ")
            : `missing conformance report "${policy.reportId}"`,
      },
    ];
  }

  const findings: ConformanceFinding[] = [];
  const byId = new Map(report.items.map((item) => [item.id, item]));
  for (const id of policy.requiredIds) {
    if (!byId.has(id)) {
      findings.push({
        severity,
        code: "missing-required-id",
        itemId: id,
        message: `missing required conformance coverage for ${id}`,
      });
    }
  }

  for (const item of report.items) {
    if (
      item.status === "partially_satisfied" ||
      item.status === "not_satisfied" ||
      item.status === "not_verified"
    ) {
      findings.push({
        severity,
        code: "unsatisfied-item",
        itemId: item.id,
        message: `${item.id} is ${item.status}`,
      });
    }
  }

  for (const drift of report.scopeDrift) {
    findings.push({
      severity:
        policy.mode === "strict"
          ? drift.severity
          : drift.severity === "info"
            ? "info"
            : "warning",
      code: "scope-drift",
      message: drift.description,
    });
  }

  return findings;
}

function listOrNone(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

export function formatConformanceReportEvidence(input: {
  reportId: string;
  policy?: ConformancePolicy;
  report?: ConformanceReport;
  findings: ConformanceFinding[];
  errors?: string[];
}): string {
  const lines = [
    `### ${input.reportId}`,
    "",
    input.policy
      ? `Policy: ${input.policy.mode}; required: ${listOrNone(input.policy.requiredIds)}`
      : "Policy: none",
  ];
  if (!input.report) {
    lines.push(
      `Report: ${input.errors && input.errors.length > 0 ? "invalid" : "missing"}`,
    );
  } else {
    lines.push(
      `Report mode: ${input.report.mode ?? "unspecified"}`,
      `Summary: ${input.report.summary ?? "none"}`,
      "",
      "| ID | Status | Evidence | Files | Tests | Artifacts | Rationale |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...input.report.items.map(
        (item) =>
          `| ${item.id} | ${item.status} | ${listOrNone(item.evidence)} | ${listOrNone(item.files)} | ${listOrNone(item.tests)} | ${listOrNone(item.artifacts)} | ${item.rationale ?? ""} |`,
      ),
    );
    if (input.report.scopeDrift.length > 0) {
      lines.push("", "Scope drift:");
      for (const drift of input.report.scopeDrift) {
        lines.push(
          `- ${drift.severity}: ${drift.description} (files: ${listOrNone(drift.files)})`,
        );
      }
    }
  }
  const allFindings =
    input.findings.length > 0
      ? input.findings
      : (input.errors ?? []).map(
          (message): ConformanceFinding => ({
            severity: "blocking",
            code: "invalid-report",
            message,
          }),
        );
  lines.push("", "Findings:");
  if (allFindings.length === 0) {
    lines.push("- none");
  } else {
    for (const finding of allFindings) {
      lines.push(
        `- ${finding.severity} ${finding.code}: ${finding.message}`,
      );
    }
  }
  return lines.join("\n");
}
