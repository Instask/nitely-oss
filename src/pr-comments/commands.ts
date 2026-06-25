export type NitelyCommentAction = "rework" | "address" | "explain";

export interface ParsedNitelyCommand {
  action: NitelyCommentAction;
  instruction: string;
  rawCommandLine: string;
}

export type NitelyCommandClassification =
  | { status: "parsed"; command: ParsedNitelyCommand }
  | { status: "invalid"; reason: "empty instruction" | "unsupported command" };

function stripFencedCodeBlocks(body: string): string {
  const lines = body.split(/\r?\n/);
  let inFence = false;
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      kept.push(line);
    }
  }
  return kept.join("\n");
}

function parseLine(line: string): ParsedNitelyCommand | null {
  const trimmed = line.trim();
  const match = /^@nitely\s+(rework|address\s+this|explain)(?:\s+(.*))?$/i.exec(
    trimmed,
  );
  if (!match) {
    return null;
  }
  const command = (match[1] ?? "").toLowerCase().replace(/\s+/g, " ");
  const instruction = (match[2] ?? "").trim();
  const action: NitelyCommentAction =
    command === "address this" ? "address" : (command as NitelyCommentAction);
  if ((action === "rework" || action === "address") && !instruction) {
    return null;
  }
  return {
    action,
    instruction,
    rawCommandLine: trimmed,
  };
}

export function parseNitelyCommand(body: string): ParsedNitelyCommand | null {
  const classified = classifyNitelyCommand(body);
  return classified.status === "parsed" ? classified.command : null;
}

export function classifyNitelyCommand(body: string): NitelyCommandClassification {
  for (const line of stripFencedCodeBlocks(body).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(">")) {
      continue;
    }
    if (/^@nitely\s+(?:rework|address\s+this)\s*$/i.test(trimmed)) {
      return { status: "invalid", reason: "empty instruction" };
    }
    const parsed = parseLine(line);
    if (parsed) {
      return { status: "parsed", command: parsed };
    }
  }
  return { status: "invalid", reason: "unsupported command" };
}
