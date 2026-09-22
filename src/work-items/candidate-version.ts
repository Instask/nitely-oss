import { createHash } from "node:crypto";

import type {
  WorkItemCandidateGuard,
  WorkItemCandidateVersion,
  WorkItemRecord,
} from "./types.js";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

/**
 * Fingerprint every persisted field that can affect Run eligibility or the
 * evaluated Run input. Timestamps and unconfirmed dependency suggestions are
 * intentionally excluded because background bookkeeping may update them while
 * an otherwise identical candidate is being evaluated.
 */
export function workItemCandidateFingerprint(
  record: Record<string, unknown>,
): string {
  const {
    updatedAt: _updatedAt,
    suggestedDependencies: _suggestedDependencies,
    ...candidate
  } = record;
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(candidate)), "utf8")
    .digest("hex");
}

export function workItemDependencyGuards(
  workItem: Pick<WorkItemRecord, "id" | "dependsOn">,
  workItems: WorkItemRecord[],
): WorkItemCandidateGuard[] {
  const byId = new Map(workItems.map((candidate) => [candidate.id, candidate]));
  return [...new Set(workItem.dependsOn ?? [])]
    .filter((id) => id && id !== workItem.id)
    .sort((left, right) => left.localeCompare(right))
    .map((workItemId) => {
      const dependency = byId.get(workItemId);
      return {
        workItemId,
        fingerprint: dependency
          ? workItemDependencyEligibilityFingerprint(dependency)
          : null,
      };
    });
}

export function workItemDependencyEligibilityFingerprint(
  workItem: Pick<WorkItemRecord, "status" | "changeRequestUrl">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalize({
          status: workItem.status,
          changeRequestUrl: workItem.changeRequestUrl,
        }),
      ),
      "utf8",
    )
    .digest("hex");
}

export function workItemCandidateVersionFingerprint(
  version: WorkItemCandidateVersion,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalize({
          store: version.store,
          fingerprint: version.fingerprint,
          dependencyGuards: version.dependencyGuards ?? [],
        }),
      ),
      "utf8",
    )
    .digest("hex");
}
