import { describe, expect, it } from "vitest";

import {
  conversationIntakeSummary,
  IntakeConversationError,
  MAX_INTAKE_CONVERSATION_TURNS,
  normalizeIntakeConversation,
  renderIntakeConversationSection,
} from "../../src/intake/conversation.js";

describe("conversation intake", () => {
  it("normalizes planning turns into durable audit history", () => {
    const turns = normalizeIntakeConversation([
      { role: "operator", text: "  Import repositories from a pasted URL.  " },
      { role: "agent", text: "Which providers?", at: "2026-09-18T04:00:00Z" },
      { role: "operator", text: "GitHub only for the first slice." },
    ]);

    expect(turns).toEqual([
      { role: "operator", text: "Import repositories from a pasted URL." },
      {
        role: "agent",
        text: "Which providers?",
        at: "2026-09-18T04:00:00.000Z",
      },
      { role: "operator", text: "GitHub only for the first slice." },
    ]);
  });

  it("summarizes the operator's own words when no explicit prompt is given", () => {
    const turns = normalizeIntakeConversation([
      { role: "operator", text: "Import repositories from a pasted URL." },
      { role: "agent", text: "Which providers?" },
      { role: "operator", text: "GitHub only for the first slice." },
    ]);

    expect(conversationIntakeSummary(turns)).toBe(
      "Import repositories from a pasted URL.\n\nGitHub only for the first slice.",
    );
  });

  it("rejects turns that cannot be audited", () => {
    expect(() => normalizeIntakeConversation("nope")).toThrow(
      IntakeConversationError,
    );
    expect(() => normalizeIntakeConversation([])).toThrow(
      "conversation must contain at least one turn",
    );
    expect(() => normalizeIntakeConversation([{ role: "system", text: "x" }])).toThrow(
      "conversation turn 1 role must be operator or agent",
    );
    expect(() => normalizeIntakeConversation([{ role: "operator", text: " " }])).toThrow(
      "conversation turn 1 text is required",
    );
    expect(() =>
      normalizeIntakeConversation([
        { role: "operator", text: "ok", at: "not-a-timestamp" },
      ]),
    ).toThrow("conversation turn 1 at must be an ISO timestamp");
    expect(() =>
      normalizeIntakeConversation(
        Array.from({ length: MAX_INTAKE_CONVERSATION_TURNS + 1 }, () => ({
          role: "operator",
          text: "turn",
        })),
      ),
    ).toThrow(
      `conversation must contain at most ${MAX_INTAKE_CONVERSATION_TURNS} turns`,
    );
  });

  it("renders the transcript as intake history rather than requirements", () => {
    const section = renderIntakeConversationSection([
      { role: "operator", text: "Import repositories.", at: "2026-09-18T04:00:00.000Z" },
      { role: "agent", text: "Line one\nLine two" },
    ]);

    expect(section).toContain("## Conversation Intake");
    expect(section).toContain("intake\nhistory, not approved requirements");
    expect(section).toContain("**Operator** (2026-09-18T04:00:00.000Z):");
    expect(section).toContain("**Planner**:");
    expect(section).toContain("  Line one\n  Line two");
    expect(renderIntakeConversationSection(undefined)).toBe("");
  });
});
