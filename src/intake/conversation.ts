export type IntakeConversationRole = "operator" | "agent";

export interface IntakeConversationTurn {
  role: IntakeConversationRole;
  text: string;
  at?: string;
}

export const MAX_INTAKE_CONVERSATION_TURNS = 50;
export const MAX_INTAKE_CONVERSATION_TURN_LENGTH = 8_000;
export const MAX_INTAKE_CONVERSATION_LENGTH = 40_000;

export class IntakeConversationError extends Error {}

const roleLabels: Record<IntakeConversationRole, string> = {
  operator: "Operator",
  agent: "Planner",
};

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTurn(value: unknown, index: number): IntakeConversationTurn {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IntakeConversationError(
      `conversation turn ${index + 1} must be an object with role and text`,
    );
  }
  const record = value as Record<string, unknown>;
  const role = normalizeText(record.role);
  if (role !== "operator" && role !== "agent") {
    throw new IntakeConversationError(
      `conversation turn ${index + 1} role must be operator or agent`,
    );
  }
  const text = normalizeText(record.text);
  if (!text) {
    throw new IntakeConversationError(
      `conversation turn ${index + 1} text is required`,
    );
  }
  if (text.length > MAX_INTAKE_CONVERSATION_TURN_LENGTH) {
    throw new IntakeConversationError(
      `conversation turn ${index + 1} must be at most ${MAX_INTAKE_CONVERSATION_TURN_LENGTH} characters`,
    );
  }
  const at = normalizeText(record.at);
  if (at && Number.isNaN(Date.parse(at))) {
    throw new IntakeConversationError(
      `conversation turn ${index + 1} at must be an ISO timestamp`,
    );
  }
  return {
    role,
    text,
    ...(at ? { at: new Date(at).toISOString() } : {}),
  };
}

/**
 * Normalize a multi-turn planning conversation into the durable turns Nitely
 * keeps for auditability. Turns are operator-supplied text only: nothing here
 * carries provider credentials, so the intake history stays inspectable
 * without storing secrets.
 */
export function normalizeIntakeConversation(
  value: unknown,
): IntakeConversationTurn[] {
  if (!Array.isArray(value)) {
    throw new IntakeConversationError("conversation must be an array of turns");
  }
  if (value.length === 0) {
    throw new IntakeConversationError("conversation must contain at least one turn");
  }
  if (value.length > MAX_INTAKE_CONVERSATION_TURNS) {
    throw new IntakeConversationError(
      `conversation must contain at most ${MAX_INTAKE_CONVERSATION_TURNS} turns`,
    );
  }
  const turns = value.map((turn, index) => normalizeTurn(turn, index));
  const total = turns.reduce((sum, turn) => sum + turn.text.length, 0);
  if (total > MAX_INTAKE_CONVERSATION_LENGTH) {
    throw new IntakeConversationError(
      `conversation must be at most ${MAX_INTAKE_CONVERSATION_LENGTH} characters in total`,
    );
  }
  return turns;
}

/**
 * The intake summary a conversation stands for when the caller did not write
 * one: the operator's own words, in order, with planner turns left to the
 * transcript.
 */
export function conversationIntakeSummary(
  turns: IntakeConversationTurn[],
): string {
  return turns
    .filter((turn) => turn.role === "operator")
    .map((turn) => turn.text)
    .join("\n\n")
    .trim();
}

export function renderIntakeConversationSection(
  turns: IntakeConversationTurn[] | undefined,
): string {
  if (!turns || turns.length === 0) return "";
  const rendered = turns
    .map((turn) => {
      const stamp = turn.at ? ` (${turn.at})` : "";
      const quoted = turn.text
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
      return `- **${roleLabels[turn.role]}**${stamp}:\n${quoted}`;
    })
    .join("\n");
  return `## Conversation Intake

The turns below are the recorded planning conversation. They are intake
history, not approved requirements.

${rendered}

`;
}
