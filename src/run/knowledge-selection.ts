/**
 * How attached knowledge and task-repository retrieval share a stage's
 * external-knowledge slots.
 *
 * Attached knowledge repositories keep precedence: they come first in the
 * prompt and take every slot the repository quota leaves. The quota reserves
 * `max(1, floor(topK / 4))` slots for task-repository passages when `topK` is
 * at least 2, so a stage whose attachments alone fill `topK` still receives
 * repository context when `NITELY_HYBRID_RETRIEVAL=1`. With `topK` of 1 the
 * single slot goes to attached knowledge first. Repository passages also fill
 * any slots attached knowledge leaves empty.
 *
 * The quota holds against the prompt-token budget too. When the selection
 * does not fit, repository passages beyond the quota are dropped first, then
 * attached passages from the end, and the reserved repository passages last.
 */
export function repositoryKnowledgeQuota(topK: number): number {
  return topK >= 2 ? Math.max(1, Math.floor(topK / 4)) : 0;
}

export function selectStageKnowledgeMatches<T>(input: {
  attached: readonly T[];
  repository: readonly T[];
  topK: number;
  fits: (matches: readonly T[]) => boolean;
}): T[] {
  const topK = Math.max(0, input.topK);
  const quota = Math.min(input.repository.length, repositoryKnowledgeQuota(topK));
  const attached = input.attached.slice(0, Math.max(0, topK - quota));
  const repository = input.repository.slice(0, Math.max(0, topK - attached.length));
  while (attached.length + repository.length > 0 && !input.fits([...attached, ...repository])) {
    if (repository.length > quota || attached.length === 0) repository.pop();
    else attached.pop();
  }
  return [...attached, ...repository];
}
