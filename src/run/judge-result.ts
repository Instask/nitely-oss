export type JudgeVerdict = "PASS" | "REWORK" | "HUMAN_REVIEW";

export interface JudgeResult {
  verdict: JudgeVerdict;
  findings: string[];
  evidence: string[];
  reworkTarget?: string;
  reworkInstructions?: string;
  humanReviewReason?: string;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function textArray(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  return Array.isArray(value)
    ? value.map(text).filter((item): item is string => item !== undefined)
    : [];
}

function verdict(value: unknown): JudgeVerdict | undefined {
  const normalized = text(value)?.toUpperCase().replace(/[ -]+/g, "_");
  if (normalized === "PASS" || normalized === "PASSED") return "PASS";
  if (normalized === "REWORK" || normalized === "NEEDS_REWORK") return "REWORK";
  if (normalized === "HUMAN_REVIEW" || normalized === "HUMAN" || normalized === "ESCALATE") {
    return "HUMAN_REVIEW";
  }
  return undefined;
}

function field(line: string, name: string): string | undefined {
  return line.match(new RegExp(`^\\s*(?:[-*]\\s*)?${name}\\s*:\\s*(.+)$`, "i"))?.[1]?.trim();
}

export function parseJudgeResult(content: string): JudgeResult | undefined {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const parsedVerdict = verdict(parsed.verdict);
    if (parsedVerdict) {
      return {
        verdict: parsedVerdict,
        findings: textArray(parsed.findings),
        evidence: textArray(parsed.evidence),
        ...(text(parsed.reworkTarget) ? { reworkTarget: text(parsed.reworkTarget) } : {}),
        ...(text(parsed.reworkInstructions) ? { reworkInstructions: text(parsed.reworkInstructions) } : {}),
        ...(text(parsed.humanReviewReason) ? { humanReviewReason: text(parsed.humanReviewReason) } : {}),
      };
    }
  } catch {
    // Markdown key-value output is supported for runtimes that cannot emit JSON.
  }

  let parsedVerdict: JudgeVerdict | undefined;
  let reworkTarget: string | undefined;
  let reworkInstructions: string | undefined;
  let humanReviewReason: string | undefined;
  const findings: string[] = [];
  const evidence: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    parsedVerdict = verdict(field(line, "verdict")) ?? parsedVerdict;
    reworkTarget = field(line, "reworkTarget") ?? field(line, "rework target") ?? reworkTarget;
    reworkInstructions = field(line, "reworkInstructions") ?? field(line, "rework instructions") ?? reworkInstructions;
    humanReviewReason = field(line, "humanReviewReason") ?? field(line, "human review reason") ?? humanReviewReason;
    const finding = field(line, "finding");
    if (finding) findings.push(finding);
    const evidenceItem = field(line, "evidence");
    if (evidenceItem) evidence.push(evidenceItem);
  }
  return parsedVerdict
    ? {
        verdict: parsedVerdict,
        findings,
        evidence,
        ...(reworkTarget ? { reworkTarget } : {}),
        ...(reworkInstructions ? { reworkInstructions } : {}),
        ...(humanReviewReason ? { humanReviewReason } : {}),
      }
    : undefined;
}
