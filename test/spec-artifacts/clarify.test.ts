import { describe, expect, it } from "vitest";

import {
  analyzeSpecClarifications,
  applySpecClarificationAnswers,
} from "../../src/spec-artifacts/clarify.js";

const clearSpec = `# Feature Spec: Repository Import

## Background

Operators need to import GitHub repositories into Nitely.

## User Stories

- **US-001:** As an operator, I can import a GitHub repository by URL.

## Acceptance Scenarios

- **US-001 / SC-001:** Given a public GitHub HTTPS URL, when I submit it, then the repository is cloned into the configured managed repositories directory.

## Functional Requirements

- **FR-001:** Nitely must accept HTTPS GitHub repository URLs that match \`https://github.com/<owner>/<repo>\`.

## Success Criteria

- **SC-001:** Importing \`https://github.com/Instask/nitely\` creates a repository record with the local clone path.

## Edge Cases

- Invalid URLs fail with a visible validation error.

## Assumptions

- Git is installed on the host.

## Out Of Scope

- Private repository credential management.
`;

const vagueSpec = `# Feature Spec: Secure Fast Sync

## Background

Teams need robust sync with external providers.

## User Stories

- **US-001:** As an operator, I can sync data simply.

## Acceptance Scenarios

- **US-001 / SC-001:** Given a provider, when sync runs, then it works fast.

## Functional Requirements

- **FR-001:** Nitely must sync provider data in a robust, secure, and scalable way.
- **FR-002:** Nitely must handle status changes.
- **FR-003:** Nitely must integrate with external APIs.

## Success Criteria

- **SC-001:** Sync is fast and reliable.

## Edge Cases

None.

## Assumptions

- Providers are available.

## Out Of Scope

- Billing.
`;

describe("spec clarification", () => {
  it("asks at most five targeted multiple-choice questions for ambiguous specs", () => {
    const result = analyzeSpecClarifications(vagueSpec);

    expect(result.questions.length).toBeGreaterThan(0);
    expect(result.questions.length).toBeLessThanOrEqual(5);
    expect(result.questions[0]).toMatchObject({
      id: "CQ-001",
      category: expect.any(String),
      recommendedOptionId: expect.any(String),
      rationale: expect.any(String),
    });
    expect(result.questions.every((question) => question.options.length >= 2)).toBe(true);
  });

  it("asks zero questions for a materially clear spec", () => {
    expect(analyzeSpecClarifications(clearSpec).questions).toEqual([]);
  });

  it("writes accepted answers under Clarifications and updates the target requirement", () => {
    const analysis = analyzeSpecClarifications(vagueSpec);
    const first = analysis.questions[0]!;
    const updated = applySpecClarificationAnswers(vagueSpec, {
      questions: analysis.questions,
      answers: [{ questionId: first.id, optionId: first.recommendedOptionId }],
      date: "2026-06-22",
      sessionId: "session-104",
    });

    expect(updated.markdown).toContain("## Clarifications");
    expect(updated.markdown).toContain("### 2026-06-22 session session-104");
    expect(updated.markdown).toContain(`**${first.id}`);
    expect(updated.markdown).toContain("Clarification:");
    expect(updated.applied).toBe(1);
  });

  it("preserves unrelated content when writing clarifications", () => {
    const withFooter = `${vagueSpec}\n<!-- keep me -->\n`;
    const analysis = analyzeSpecClarifications(withFooter);
    const updated = applySpecClarificationAnswers(withFooter, {
      questions: analysis.questions,
      answers: [
        {
          questionId: analysis.questions[0]!.id,
          optionId: analysis.questions[0]!.recommendedOptionId,
        },
      ],
      date: "2026-06-22",
      sessionId: "preserve",
    });

    expect(updated.markdown).toContain("<!-- keep me -->");
  });

  it("updates success criteria targets in the success criteria section", () => {
    const spec = clearSpec.replace(
      "- **SC-001:** Importing `https://github.com/Instask/nitely` creates a repository record with the local clone path.",
      "- **SC-001:** Import is fast and reliable.",
    );
    const analysis = analyzeSpecClarifications(spec);
    const successQuestion = analysis.questions.find(
      (question) => question.targetId === "SC-001",
    )!;
    const updated = applySpecClarificationAnswers(vagueSpec, {
      questions: analysis.questions,
      answers: [
        {
          questionId: successQuestion.id,
          optionId: successQuestion.recommendedOptionId,
        },
      ],
      date: "2026-06-22",
      sessionId: "success-target",
    });

    expect(updated.markdown).toContain(
      "- **SC-001:** Sync is fast and reliable. Clarification:",
    );
    expect(updated.markdown).toContain(
      "- **US-001 / SC-001:** Given a provider, when sync runs, then it works fast.",
    );
  });

  it("rejects answers for unknown questions", () => {
    expect(() =>
      applySpecClarificationAnswers(vagueSpec, {
        questions: analyzeSpecClarifications(vagueSpec).questions,
        answers: [{ questionId: "CQ-999", optionId: "A" }],
        date: "2026-06-22",
        sessionId: "bad",
      }),
    ).toThrow(/unknown clarification question/i);
  });
});
