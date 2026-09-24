export const SUPPORTED_SECURITY_FINDING_CLASSES = [
  "path-traversal",
  "command-injection",
  "xss",
  "secret-exposure",
  "weak-credential-handling",
  "unsafe-temp-file",
] as const;

export type SecurityFindingClass =
  (typeof SUPPORTED_SECURITY_FINDING_CLASSES)[number];

export interface SecurityFindingAssessment {
  supported: boolean;
  vulnerabilityClass?: SecurityFindingClass;
  confidence: "high" | "medium" | "low";
  affectedFiles: string[];
  validationResult: "supported" | "unsupported";
  reason: string;
  assumptions: string[];
}

const classifiers: Array<{
  vulnerabilityClass: SecurityFindingClass;
  confidence: SecurityFindingAssessment["confidence"];
  patterns: RegExp[];
  reason: string;
}> = [
  {
    vulnerabilityClass: "path-traversal",
    confidence: "high",
    patterns: [/path traversal/i, /directory traversal/i, /\.\.[/\\]/],
    reason: "finding matches path traversal or directory traversal indicators",
  },
  {
    vulnerabilityClass: "command-injection",
    confidence: "high",
    patterns: [/command injection/i, /shell injection/i, /\bchild_process\b/i, /\bexec(File|Sync)?\s*\(/i, /\bspawn\s*\(/i],
    reason: "finding matches command or shell injection indicators",
  },
  {
    vulnerabilityClass: "xss",
    confidence: "high",
    patterns: [/cross-site scripting/i, /\bxss\b/i, /\binnerHTML\b/, /dangerouslySetInnerHTML/, /html injection/i],
    reason: "finding matches XSS or unsafe HTML rendering indicators",
  },
  {
    vulnerabilityClass: "secret-exposure",
    confidence: "medium",
    patterns: [/secret exposure/i, /credential leak/i, /token leak/i, /api[_ -]?key leak/i, /logs?.*(password|token|secret)/i],
    reason: "finding matches secret or credential exposure indicators",
  },
  {
    vulnerabilityClass: "weak-credential-handling",
    confidence: "medium",
    patterns: [/weak credential/i, /hardcoded (password|credential|token|secret)/i, /default password/i, /missing auth/i, /insecure credential/i],
    reason: "finding matches weak credential handling indicators",
  },
  {
    vulnerabilityClass: "unsafe-temp-file",
    confidence: "medium",
    patterns: [/unsafe temp/i, /temporary file/i, /\btmpdir\b/i, /\bmktemp\b/i, /symlink race/i, /world-writable temp/i],
    reason: "finding matches unsafe temporary file indicators",
  },
];

const filePathPattern =
  /(?:^|[\s"'(:])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.(?:c|cc|cpp|cs|css|go|h|hpp|html|java|js|jsx|json|kt|md|php|py|rb|rs|swift|ts|tsx|xml|ya?ml))/g;

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function extractAffectedFiles(text: string): string[] {
  return unique([...text.matchAll(filePathPattern)].map((match) => match[1]!));
}

export function classifySecurityFinding(text: string): SecurityFindingAssessment {
  const trimmed = text.trim();
  const affectedFiles = extractAffectedFiles(trimmed);
  if (!trimmed) {
    return {
      supported: false,
      confidence: "low",
      affectedFiles,
      validationResult: "unsupported",
      reason: "finding text is empty",
      assumptions: ["No security finding content was available to classify."],
    };
  }

  const match = classifiers.find((classifier) =>
    classifier.patterns.some((pattern) => pattern.test(trimmed)),
  );
  if (!match) {
    return {
      supported: false,
      confidence: "low",
      affectedFiles,
      validationResult: "unsupported",
      reason: `finding does not match supported classes: ${SUPPORTED_SECURITY_FINDING_CLASSES.join(", ")}`,
      assumptions: [
        "Unsupported security findings require manual triage or a new supported class before Nitely should modify code.",
      ],
    };
  }

  return {
    supported: true,
    vulnerabilityClass: match.vulnerabilityClass,
    confidence: match.confidence,
    affectedFiles,
    validationResult: "supported",
    reason: match.reason,
    assumptions: [
      affectedFiles.length > 0
        ? "Affected files were inferred from path-like references in the finding."
        : "No affected file path was detected; the implementation stage must identify the minimal affected files before editing.",
      "The fix must include regression tests or explicit verification evidence before publish.",
    ],
  };
}

export function renderSecurityAssessmentMarkdown(
  assessment: SecurityFindingAssessment,
): string {
  return [
    "# Security Finding Assessment",
    "",
    `Validation result: ${assessment.validationResult}`,
    `Supported: ${assessment.supported ? "yes" : "no"}`,
    `Class: ${assessment.vulnerabilityClass ?? "unsupported"}`,
    `Confidence: ${assessment.confidence}`,
    `Reason: ${assessment.reason}`,
    "",
    "## Affected Files",
    "",
    assessment.affectedFiles.length > 0
      ? assessment.affectedFiles.map((file) => `- ${file}`).join("\n")
      : "- none detected",
    "",
    "## Assumptions",
    "",
    assessment.assumptions.map((assumption) => `- ${assumption}`).join("\n"),
    "",
  ].join("\n");
}
