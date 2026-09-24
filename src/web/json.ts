const REDACTED_KEYS: ReadonlySet<string> = new Set(["repoPath"]);

/**
 * Serialize a Web API payload. A repository's checkout location is a server
 * implementation detail, so every `repoPath` key is dropped here, at the one
 * place all JSON responses pass through, rather than at each of the sites
 * that assemble a task, run, skill, or notification view.
 */
export function serializeWebJson(value: unknown): string {
  return JSON.stringify(value, (key, entry) =>
    REDACTED_KEYS.has(key) ? undefined : entry,
  );
}
