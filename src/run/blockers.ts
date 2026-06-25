export type RunBlockerReason =
  | "agent_usage_limit"
  | "agent_runtime_unavailable";

export interface RunBlocker {
  reason: RunBlockerReason;
  stageId: string;
  runtime?: string;
  message: string;
  retryAfter?: string;
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function combinedRuntimeOutput(error: unknown): string {
  const parts = [
    error instanceof Error ? error.message : undefined,
    stringField(error, "code"),
    stringField(error, "stdout"),
    stringField(error, "stderr"),
  ].filter((part): part is string => Boolean(part?.trim()));
  return parts.join("\n").trim();
}

function matchesUsageLimit(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes("hit your usage limit")) return true;
  if (lower.includes("usage limit")) return true;
  if (/\brate[-\s]?limit(?:ed)?\b/.test(lower)) return true;
  if (/\bquota\s+exceeded\b/.test(lower)) return true;
  if (/\bcapacity\b/.test(lower)) return true;
  return /\btry again\b/.test(lower) && /\b(?:usage|rate|quota)\b/.test(lower);
}

function matchesRuntimeUnavailable(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes("unsupported agent runtime")) return true;
  if (/agent runtime .+ is not configured/.test(lower)) return true;
  if (/unable to start agent runtime/.test(lower)) return true;
  if (/command .+ was not found/.test(lower)) return true;
  return /\benoent\b/.test(lower);
}

function extractRetryAfter(text: string): string | undefined {
  const patterns = [
    /\btry again at\s+(.+?)(?:[.\n\r]|$)/i,
    /\bretry after\s+(.+?)(?:[.\n\r]|$)/i,
    /\btry again in\s+(.+?)(?:[.\n\r]|$)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function classifyAgentRuntimeBlocker(input: {
  stageId: string;
  runtime?: string;
  error: unknown;
}): RunBlocker | undefined {
  const message = combinedRuntimeOutput(input.error);
  if (!message) {
    return undefined;
  }
  if (matchesUsageLimit(message)) {
    return {
      reason: "agent_usage_limit",
      stageId: input.stageId,
      runtime: input.runtime,
      message,
      retryAfter: extractRetryAfter(message),
    };
  }
  if (matchesRuntimeUnavailable(message)) {
    return {
      reason: "agent_runtime_unavailable",
      stageId: input.stageId,
      runtime: input.runtime,
      message,
    };
  }
  return undefined;
}
