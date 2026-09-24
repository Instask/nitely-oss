/**
 * Machine-wide runaway ceiling for uncached runtime tokens.
 *
 * Two dogfood runs burned ~12.5M Codex input tokens in about 40 minutes before
 * an operator killed the process by hand. A run that has spent this much
 * without finishing is not going to finish cheaply, so the default stops it and
 * says why. Set `NITELY_DEFAULT_MAX_RUNTIME_TOKENS=0` to opt a machine out, or
 * to another positive integer to change the cap. Flows cannot declare a
 * per-run budget; this ceiling is the only token stop.
 */
export const DEFAULT_MAX_RUNTIME_TOKENS = 2_000_000;

export function defaultMaxRuntimeTokens(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = env.NITELY_DEFAULT_MAX_RUNTIME_TOKENS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_MAX_RUNTIME_TOKENS;
  const configured = Number(raw);
  if (!Number.isFinite(configured) || configured < 0) {
    return DEFAULT_MAX_RUNTIME_TOKENS;
  }
  return configured === 0 ? undefined : Math.floor(configured);
}
