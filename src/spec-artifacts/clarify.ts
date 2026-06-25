import { parseStructuredSpec } from "./parse.js";

export type ClarificationCategory =
  | "functional_scope"
  | "entities_state"
  | "error_edge_cases"
  | "security_privacy"
  | "performance_reliability"
  | "external_dependencies"
  | "terminology";

export interface ClarificationOption {
  id: "A" | "B" | "C";
  label: string;
  description: string;
}

export interface ClarificationQuestion {
  id: string;
  category: ClarificationCategory;
  question: string;
  targetId?: string;
  targetSection?: string;
  options: ClarificationOption[];
  recommendedOptionId: ClarificationOption["id"];
  rationale: string;
}

export interface ClarificationAnalysis {
  questions: ClarificationQuestion[];
}

export interface ClarificationAnswer {
  questionId: string;
  optionId: string;
}

export interface ApplyClarificationInput {
  questions: ClarificationQuestion[];
  answers: ClarificationAnswer[];
  date: string;
  sessionId: string;
}

export interface ApplyClarificationResult {
  markdown: string;
  applied: number;
}

interface CandidateQuestion extends Omit<ClarificationQuestion, "id"> {
  priority: number;
}

const vaguePattern =
  /\b(?:robust|simple|simply|fast|secure|scalable|reliable|works?|easy|efficient)\b/i;
const performancePattern =
  /\b(?:fast|performance|latency|reliable|availability|scalable|efficient)\b/i;
const securityPattern = /\b(?:secure|security|privacy|secret|credential|token)\b/i;
const statePattern = /\b(?:status|state|transition|lifecycle|approval|pending|complete)\b/i;
const externalPattern = /\b(?:external|provider|api|webhook|integration|third-party)\b/i;

function questionOptions(
  recommended: ClarificationOption["id"],
  descriptions: [string, string, string],
): {
  options: ClarificationOption[];
  recommendedOptionId: ClarificationOption["id"];
} {
  return {
    recommendedOptionId: recommended,
    options: [
      { id: "A", label: "Constrain now", description: descriptions[0] },
      { id: "B", label: "Defer", description: descriptions[1] },
      { id: "C", label: "Reviewer decides", description: descriptions[2] },
    ],
  };
}

function sectionBody(markdown: string, headingPattern: RegExp): string | undefined {
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => headingPattern.test(line));
  if (headingIndex < 0) {
    return undefined;
  }
  const body: string[] = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index] ?? "")) {
      break;
    }
    body.push(lines[index] ?? "");
  }
  return body.join("\n").trim();
}

function sectionLines(markdown: string, headingPattern: RegExp): string[] {
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => headingPattern.test(line));
  if (headingIndex < 0) {
    return lines;
  }
  const body: string[] = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index] ?? "")) {
      break;
    }
    body.push(lines[index] ?? "");
  }
  return body;
}

function lineForTarget(markdown: string, targetId: string): string | undefined {
  const target = targetId.toUpperCase();
  const heading =
    target.startsWith("FR-")
      ? /^##\s+Functional Requirements\s*$/i
      : target.startsWith("SC-")
        ? /^##\s+Success Criteria\s*$/i
        : target.startsWith("US-")
          ? /^##\s+User Stories\s*$/i
          : undefined;
  const lines = heading ? sectionLines(markdown, heading) : markdown.split(/\r?\n/);
  return lines.find((line) => line.toUpperCase().includes(target));
}

function addCandidate(
  candidates: CandidateQuestion[],
  candidate: CandidateQuestion,
): void {
  const key = `${candidate.category}:${candidate.targetId ?? candidate.targetSection}`;
  if (
    candidates.some(
      (existing) =>
        `${existing.category}:${existing.targetId ?? existing.targetSection}` === key,
    )
  ) {
    return;
  }
  candidates.push(candidate);
}

export function analyzeSpecClarifications(
  markdown: string,
  options: { maxQuestions?: number } = {},
): ClarificationAnalysis {
  const maxQuestions = Math.max(0, Math.min(options.maxQuestions ?? 5, 5));
  const parsed = parseStructuredSpec(markdown);
  const candidates: CandidateQuestion[] = [];

  for (const requirement of parsed.requirements) {
    if (vaguePattern.test(requirement.text)) {
      addCandidate(candidates, {
        priority: 10,
        category: "functional_scope",
        targetId: requirement.id,
        question: `What exact behavior should ${requirement.id} require instead of vague wording?`,
        ...questionOptions("A", [
          "Replace vague wording with a testable behavior and explicit boundary.",
          "Leave the requirement broad and clarify during implementation review.",
          "Ask the reviewer to rewrite this requirement before implementation.",
        ]),
        rationale: `${requirement.id} contains wording that is hard to verify in tests.`,
      });
    }
    if (securityPattern.test(requirement.text)) {
      addCandidate(candidates, {
        priority: 20,
        category: "security_privacy",
        targetId: requirement.id,
        question: `Which security or privacy constraint should ${requirement.id} enforce?`,
        ...questionOptions("A", [
          "Name the protected data, forbidden exposure, and expected failure behavior.",
          "Track security details in a later hardening task.",
          "Require reviewer approval before implementation chooses the constraint.",
        ]),
        rationale: "Security language without a concrete constraint can hide unsafe assumptions.",
      });
    }
    if (statePattern.test(requirement.text)) {
      addCandidate(candidates, {
        priority: 30,
        category: "entities_state",
        targetId: requirement.id,
        question: `Which states and transitions should ${requirement.id} support?`,
        ...questionOptions("A", [
          "List allowed states, valid transitions, and invalid transition behavior.",
          "Keep state handling implicit for this slice.",
          "Ask the reviewer to add a state table before implementation.",
        ]),
        rationale: "Stateful behavior needs explicit transitions to be testable.",
      });
    }
    if (externalPattern.test(requirement.text)) {
      addCandidate(candidates, {
        priority: 40,
        category: "external_dependencies",
        targetId: requirement.id,
        question: `Which external dependency contract should ${requirement.id} assume?`,
        ...questionOptions("A", [
          "Name the dependency, expected response shape, timeout, and failure mode.",
          "Mock the dependency and defer contract details.",
          "Block implementation until the dependency contract is known.",
        ]),
        rationale: "External integrations fail unpredictably without contract boundaries.",
      });
    }
  }

  for (const criterion of parsed.successCriteria) {
    if (performancePattern.test(criterion.text) && !/\d+\s*(?:ms|s|sec|seconds?|%)\b/i.test(criterion.text)) {
      addCandidate(candidates, {
        priority: 50,
        category: "performance_reliability",
        targetId: criterion.id,
        question: `What measurable target should ${criterion.id} use?`,
        ...questionOptions("A", [
          "Add a concrete threshold such as duration, retry count, or success rate.",
          "Treat this as qualitative and verify manually.",
          "Move this criterion out of scope until a metric is known.",
        ]),
        rationale: "Performance and reliability criteria need measurable thresholds.",
      });
    }
  }

  const edgeCases = sectionBody(
    markdown,
    /^##\s+Edge Cases(?: And Failure Behavior)?\s*$/i,
  );
  if (edgeCases !== undefined && /^(?:None\.?|N\/A|TBD)?$/i.test(edgeCases)) {
    addCandidate(candidates, {
      priority: 60,
      category: "error_edge_cases",
      targetSection: "Edge Cases",
      question: "Which failure or edge case must be handled before implementation?",
      ...questionOptions("A", [
        "Add at least one concrete invalid input, unavailable dependency, or conflict case.",
        "Declare that no edge cases are in scope for this slice.",
        "Ask the reviewer to provide edge cases before implementation.",
      ]),
      rationale: "Empty edge-case sections usually hide important failure behavior.",
    });
  }

  if (/\bthing|things|stuff|data|it works\b/i.test(markdown)) {
    addCandidate(candidates, {
      priority: 70,
      category: "terminology",
      targetSection: "Terminology",
      question: "Which ambiguous term should the spec define before implementation?",
      ...questionOptions("A", [
        "Replace generic terms with domain nouns used consistently across the spec.",
        "Keep terminology informal for now.",
        "Ask the reviewer to add a glossary.",
      ]),
      rationale: "Generic terms can cause implementation and review drift.",
    });
  }

  return {
    questions: candidates
      .sort((left, right) => left.priority - right.priority)
      .slice(0, maxQuestions)
      .map(({ priority: _priority, ...question }, index) => ({
        ...question,
        id: `CQ-${String(index + 1).padStart(3, "0")}`,
      })),
  };
}

function selectedAnswerText(
  question: ClarificationQuestion,
  answer: ClarificationAnswer,
): string {
  const option = question.options.find((candidate) => candidate.id === answer.optionId);
  if (!option) {
    throw new Error(`unknown option ${answer.optionId} for ${answer.questionId}`);
  }
  return `Selected \`${option.id}\`: ${option.description}`;
}

function appendClarificationSection(
  markdown: string,
  entries: string[],
  date: string,
  sessionId: string,
): string {
  const block = [`### ${date} session ${sessionId}`, "", ...entries, ""].join("\n");
  if (/^##\s+Clarifications\s*$/im.test(markdown)) {
    return markdown.replace(
      /^##\s+Clarifications\s*$/im,
      (heading) => `${heading}\n\n${block}`,
    );
  }
  return `${markdown.trimEnd()}\n\n## Clarifications\n\n${block}`;
}

function appendClarificationToTarget(
  markdown: string,
  question: ClarificationQuestion,
  answerText: string,
): string {
  if (!question.targetId) {
    return markdown;
  }
  const targetLine = lineForTarget(markdown, question.targetId);
  if (!targetLine || targetLine.includes("Clarification:")) {
    return markdown;
  }
  return markdown.replace(
    targetLine,
    `${targetLine} Clarification: ${answerText.replace(/^Selected `.\`: /, "")}`,
  );
}

export function applySpecClarificationAnswers(
  markdown: string,
  input: ApplyClarificationInput,
): ApplyClarificationResult {
  const questionsById = new Map(input.questions.map((question) => [question.id, question]));
  let updated = markdown;
  const entries: string[] = [];

  for (const answer of input.answers) {
    const question = questionsById.get(answer.questionId);
    if (!question) {
      throw new Error(`unknown clarification question: ${answer.questionId}`);
    }
    const answerText = selectedAnswerText(question, answer);
    entries.push(
      `- **${question.id}${question.targetId ? ` / ${question.targetId}` : ""}:** ${answerText}`,
    );
    updated = appendClarificationToTarget(updated, question, answerText);
  }

  if (entries.length === 0) {
    return { markdown, applied: 0 };
  }

  return {
    markdown: appendClarificationSection(
      updated,
      entries,
      input.date,
      input.sessionId,
    ),
    applied: entries.length,
  };
}
