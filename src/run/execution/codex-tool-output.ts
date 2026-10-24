/**
 * Caps how much of each tool output Codex keeps in the model's context.
 *
 * Codex stores a tool's output in its context manager and resends it on every
 * later model call in the turn. A production implement turn made 38 model
 * calls after reading 12–30 KB outputs early on, and up to 59% of its input
 * tokens were those early outputs resent. `tool_output_token_limit` is
 * Codex's own budget for a stored tool output, so Codex truncates the output
 * before it enters the context, not Nitely.
 *
 * The override goes right after the `exec` subcommand, where both
 * `codex exec` and `codex exec resume` accept `-c`.
 */
export function withCodexToolOutputLimit(
  args: readonly string[],
  maxTokens: number | undefined,
): string[] {
  if (maxTokens === undefined) return [...args];
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error(`tool output token limit must be a positive integer, got ${maxTokens}`);
  }
  const at = args[0] === "exec" ? 1 : 0;
  return [
    ...args.slice(0, at),
    "-c",
    `tool_output_token_limit=${maxTokens}`,
    ...args.slice(at),
  ];
}
