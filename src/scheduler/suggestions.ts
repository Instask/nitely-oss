import { wouldCreateCycle } from "./graph.js";
import type { SuggestedDependency, TaskSourceRecord } from "../web/tasks.js";

export const SCHEDULER_DEPENDENCY_SUGGESTION_SOURCE = "scheduler-context";

export interface DependencySuggestionRecord {
  id: string;
  title: string;
  status?: string;
  repoId?: string;
  issueUrl?: string;
  dependsOn?: string[];
  suggestedDependencies?: SuggestedDependency[];
  source?: TaskSourceRecord;
  planningSource?: TaskSourceRecord;
  createdAt: string;
  updatedAt: string;
}

export interface GenerateDependencySuggestionsInput {
  subjectId: string;
  workItems: DependencySuggestionRecord[];
  now?: () => Date;
  maxSuggestions?: number;
}

const STOP_WORDS = new Set([
  "a",
  "add",
  "an",
  "and",
  "api",
  "for",
  "from",
  "in",
  "into",
  "make",
  "of",
  "on",
  "the",
  "to",
  "with",
]);

function normalizedSource(record: DependencySuggestionRecord): TaskSourceRecord | undefined {
  return record.planningSource ?? record.source;
}

function normalizedIssueUrl(record: DependencySuggestionRecord): string | undefined {
  const source = normalizedSource(record);
  const raw = source?.uri ?? source?.snapshot?.uri ?? record.issueUrl;
  const trimmed = raw?.trim().replace(/\/+$/, "");
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function normalizedLabels(record: DependencySuggestionRecord): string[] {
  const labels = normalizedSource(record)?.snapshot?.labels ?? [];
  return labels
    .map((label) => label.trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

function normalizedMilestone(record: DependencySuggestionRecord): string | undefined {
  const milestone = normalizedSource(record)?.snapshot?.milestone
    ?.trim()
    .toLowerCase();
  return milestone || undefined;
}

function textTerms(record: DependencySuggestionRecord): Set<string> {
  const source = normalizedSource(record);
  const parts = [
    record.title,
    source?.title,
    source?.snapshot?.title,
    normalizedMilestone(record),
    ...normalizedLabels(record),
  ];
  const terms = new Set<string>();
  for (const part of parts) {
    for (const term of (part ?? "").toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []) {
      if (!STOP_WORDS.has(term)) {
        terms.add(term);
      }
    }
  }
  return terms;
}

function intersection<T>(left: Iterable<T>, right: Set<T>): T[] {
  const values: T[] = [];
  for (const item of left) {
    if (right.has(item)) {
      values.push(item);
    }
  }
  return values;
}

function confidence(value: number): number {
  return Math.max(0, Math.min(0.98, Number(value.toFixed(2))));
}

function candidatePrecedesSubject(
  candidate: DependencySuggestionRecord,
  subject: DependencySuggestionRecord,
): boolean {
  const createdDelta = candidate.createdAt.localeCompare(subject.createdAt);
  return createdDelta < 0 || (createdDelta === 0 && candidate.id < subject.id);
}

function scoreCandidate(
  subject: DependencySuggestionRecord,
  candidate: DependencySuggestionRecord,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  const subjectIssueUrl = normalizedIssueUrl(subject);
  const candidateIssueUrl = normalizedIssueUrl(candidate);
  if (subjectIssueUrl && subjectIssueUrl === candidateIssueUrl) {
    score += 0.7;
    reasons.push("shares the same source issue");
  }

  const subjectMilestone = normalizedMilestone(subject);
  const candidateMilestone = normalizedMilestone(candidate);
  if (subjectMilestone && subjectMilestone === candidateMilestone) {
    score += 0.42;
    reasons.push(`shares milestone ${subjectMilestone}`);
  }

  const candidateLabels = new Set(normalizedLabels(candidate));
  const sharedLabels = intersection(normalizedLabels(subject), candidateLabels);
  if (sharedLabels.length > 0) {
    score += Math.min(0.36, sharedLabels.length * 0.12);
    reasons.push(`shares labels ${sharedLabels.slice(0, 3).join(", ")}`);
  }

  const candidateTerms = textTerms(candidate);
  const sharedTerms = intersection(textTerms(subject), candidateTerms);
  if (sharedTerms.length > 0) {
    score += Math.min(0.28, sharedTerms.length * 0.06);
    reasons.push(`overlaps context terms ${sharedTerms.slice(0, 4).join(", ")}`);
  }

  if (candidate.status === "completed") {
    score += 0.04;
  }

  return { score, reasons };
}

export function generateDependencySuggestions(
  input: GenerateDependencySuggestionsInput,
): SuggestedDependency[] {
  const subject = input.workItems.find((item) => item.id === input.subjectId);
  if (!subject) {
    return [];
  }
  const confirmed = new Set(subject.dependsOn ?? []);
  const suggestedAt = (input.now?.() ?? new Date()).toISOString();
  const taskGraph = input.workItems as unknown as Parameters<typeof wouldCreateCycle>[0];
  const suggestions = input.workItems
    .filter((candidate) => candidate.id !== subject.id)
    .filter((candidate) => !confirmed.has(candidate.id))
    .filter((candidate) => candidatePrecedesSubject(candidate, subject))
    .filter((candidate) => !wouldCreateCycle(taskGraph, subject.id, candidate.id))
    .map((candidate) => {
      const scored = scoreCandidate(subject, candidate);
      return {
        candidate,
        score: scored.score,
        reason: scored.reasons.slice(0, 2).join("; "),
      };
    })
    .filter((item) => item.score >= 0.18 && item.reason)
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) return scoreDelta;
      return left.candidate.createdAt.localeCompare(right.candidate.createdAt);
    })
    .slice(0, input.maxSuggestions ?? 5)
    .map((item) => ({
      dependsOn: item.candidate.id,
      reason: item.reason,
      confidence: confidence(item.score),
      source: SCHEDULER_DEPENDENCY_SUGGESTION_SOURCE,
      suggestedAt,
    }));

  const byDependency = new Map<string, SuggestedDependency>();
  for (const suggestion of suggestions) {
    if (!byDependency.has(suggestion.dependsOn)) {
      byDependency.set(suggestion.dependsOn, suggestion);
    }
  }
  return [...byDependency.values()];
}

export function mergeDependencySuggestions(
  existing: SuggestedDependency[] | undefined,
  generated: SuggestedDependency[],
): SuggestedDependency[] {
  const merged = new Map<string, SuggestedDependency>();
  for (const suggestion of existing ?? []) {
    if (suggestion.source !== SCHEDULER_DEPENDENCY_SUGGESTION_SOURCE) {
      merged.set(suggestion.dependsOn, suggestion);
    }
  }
  for (const suggestion of generated) {
    if (!merged.has(suggestion.dependsOn)) {
      merged.set(suggestion.dependsOn, suggestion);
    }
  }
  return [...merged.values()];
}
