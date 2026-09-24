import { createHash } from "node:crypto";

import { globMatches, normalizeRelativePath } from "./glob.js";
import {
  codeOwnersForPaths,
  type CodeOwners,
} from "./codeowners.js";

/**
 * How much accountability a change needs, from least to most. The ladder is
 * deliberately short: it maps to how many humans have to look, not to project
 * priority.
 */
export const RISK_CLASSES = [
  "mechanical",
  "normal",
  "high",
  "protected",
] as const;

export type RiskClass = (typeof RISK_CLASSES)[number];

export function riskRank(riskClass: RiskClass): number {
  return RISK_CLASSES.indexOf(riskClass);
}

export function maxRiskClass(left: RiskClass, right: RiskClass): RiskClass {
  return riskRank(left) >= riskRank(right) ? left : right;
}

export type DiffChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type-changed"
  | "unknown";

export interface DiffFileChange {
  path: string;
  status: DiffChangeStatus;
  /** Set for renames and copies. */
  previousPath?: string;
}

export interface ChangeDiff {
  files: DiffFileChange[];
  /** Total added and removed lines, when the caller could measure them. */
  changedLines?: number;
}

export type RiskSignalId =
  | "protected-path"
  | "database-migration"
  | "dependency-manifest"
  | "destructive-change"
  | "diff-size"
  | "code-owner";

export interface RiskSignal {
  id: RiskSignalId;
  /** Sub-kind for signals with several domains, such as `auth` or `payment`. */
  domain?: string;
  /** The floor this signal puts under the effective class. */
  riskClass: RiskClass;
  /** One sentence naming what was observed. */
  detail: string;
  /** The exact changed paths that raised it. */
  paths: string[];
  /** CODEOWNERS entries owning the matched paths. */
  owners?: string[];
}

export interface RiskClassification {
  declared: RiskClass;
  effective: RiskClass;
  escalated: boolean;
  signals: RiskSignal[];
  /** CODEOWNERS entries owning any changed path. */
  requiredOwners: string[];
  /** Human sentence for the approval inbox and the change request evidence. */
  explanation: string;
  /** Identity of the diff this classification was computed from. */
  diffDigest: string;
  changedFileCount: number;
  changedLines?: number;
}

export interface ProtectedDomainPatterns {
  domain: string;
  patterns: string[];
}

export interface RiskSignalPolicy {
  protectedPaths: ProtectedDomainPatterns[];
  migrations: string[];
  dependencyManifests: string[];
  diffSize: { files: number; lines: number };
}

/**
 * Conservative built-in patterns. A repository narrows or widens them in
 * `.nitely/review-policy.json`; the defaults are meant to escalate a little
 * too often rather than to miss an auth change.
 */
export const DEFAULT_RISK_SIGNAL_POLICY: RiskSignalPolicy = {
  protectedPaths: [
    {
      domain: "auth",
      patterns: [
        "**/auth/**",
        "**/authn/**",
        "**/authz/**",
        "**/oauth/**",
        "**/session/**",
        "**/*permission*",
        "**/*authorization*",
        "**/*login*",
      ],
    },
    {
      domain: "payment",
      patterns: [
        "**/payment/**",
        "**/payments/**",
        "**/billing/**",
        "**/checkout/**",
        "**/invoice*/**",
      ],
    },
    {
      domain: "crypto",
      patterns: [
        "**/crypto/**",
        "**/*cipher*",
        "**/*encrypt*",
        "**/*signing*",
        "**/*signature*",
      ],
    },
    {
      domain: "secrets",
      patterns: [
        "**/secret/**",
        "**/secrets/**",
        "**/credential*/**",
        "**/*credentials*",
        "**/*.pem",
        "**/*.key",
        ".env",
        "**/.env",
        "**/.env.*",
      ],
    },
  ],
  migrations: [
    "**/migrations/**",
    "**/migrate/**",
    "**/db/migrate/**",
    "**/*.sql",
  ],
  dependencyManifests: [
    "package.json",
    "**/package.json",
    "pnpm-lock.yaml",
    "**/pnpm-lock.yaml",
    "package-lock.json",
    "**/package-lock.json",
    "yarn.lock",
    "**/yarn.lock",
    "requirements.txt",
    "**/requirements.txt",
    "Pipfile.lock",
    "**/Pipfile.lock",
    "poetry.lock",
    "**/poetry.lock",
    "go.mod",
    "**/go.mod",
    "go.sum",
    "**/go.sum",
    "Cargo.toml",
    "**/Cargo.toml",
    "Cargo.lock",
    "**/Cargo.lock",
    "Gemfile.lock",
    "**/Gemfile.lock",
    "**/pom.xml",
    "**/build.gradle",
    "**/build.gradle.kts",
  ],
  diffSize: { files: 40, lines: 800 },
};

function matchPaths(
  files: readonly DiffFileChange[],
  patterns: readonly string[],
): string[] {
  const matched = new Set<string>();
  for (const file of files) {
    for (const candidate of [file.path, file.previousPath]) {
      if (!candidate) continue;
      const normalized = normalizeRelativePath(candidate);
      if (patterns.some((pattern) => globMatches(pattern, normalized))) {
        matched.add(normalized);
      }
    }
  }
  return [...matched].sort((left, right) => left.localeCompare(right));
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function describePaths(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).join(", ");
  return paths.length > 3 ? `${shown}, and ${paths.length - 3} more` : shown;
}

function protectedPathSignals(
  files: readonly DiffFileChange[],
  policy: RiskSignalPolicy,
): RiskSignal[] {
  const signals: RiskSignal[] = [];
  for (const domain of policy.protectedPaths) {
    const paths = matchPaths(files, domain.patterns);
    if (paths.length === 0) continue;
    signals.push({
      id: "protected-path",
      domain: domain.domain,
      riskClass: "protected",
      detail: `the diff changes ${domain.domain}-sensitive ${plural(paths.length, "path")} (${describePaths(paths)})`,
      paths,
    });
  }
  return signals;
}

function destructiveSignal(
  files: readonly DiffFileChange[],
): RiskSignal | undefined {
  const paths = files
    .filter((file) => file.status === "deleted")
    .map((file) => normalizeRelativePath(file.path))
    .sort((left, right) => left.localeCompare(right));
  if (paths.length === 0) return undefined;
  return {
    id: "destructive-change",
    riskClass: "high",
    detail: `the diff deletes ${plural(paths.length, "file")} (${describePaths(paths)})`,
    paths,
  };
}

function diffSizeSignal(
  diff: ChangeDiff,
  policy: RiskSignalPolicy,
): RiskSignal | undefined {
  const fileCount = diff.files.length;
  const overFiles = fileCount > policy.diffSize.files;
  const overLines =
    diff.changedLines !== undefined && diff.changedLines > policy.diffSize.lines;
  if (!overFiles && !overLines) return undefined;
  const detail = overFiles
    ? `the diff changes ${plural(fileCount, "file")}, over the ${policy.diffSize.files}-file threshold`
    : `the diff changes ${diff.changedLines} lines, over the ${policy.diffSize.lines}-line threshold`;
  return {
    id: "diff-size",
    riskClass: "high",
    detail,
    paths: [],
  };
}

function codeOwnerSignal(
  files: readonly DiffFileChange[],
  codeOwners: CodeOwners | undefined,
): RiskSignal | undefined {
  if (!codeOwners || codeOwners.rules.length === 0) return undefined;
  const matched = codeOwnersForPaths(
    codeOwners,
    files.map((file) => normalizeRelativePath(file.path)),
  );
  if (matched.owners.length === 0) return undefined;
  return {
    id: "code-owner",
    // Ownership names who must look, and does not by itself make a change
    // riskier than an ordinary scoped change.
    riskClass: "normal",
    detail: `the diff changes ${plural(matched.paths.length, "owned path")} owned by ${matched.owners.join(", ")}`,
    paths: matched.paths,
    owners: matched.owners,
  };
}

export function diffDigest(diff: ChangeDiff): string {
  const hash = createHash("sha256");
  const lines = diff.files
    .map(
      (file) =>
        `${file.status}\t${normalizeRelativePath(file.path)}${
          file.previousPath
            ? `\t${normalizeRelativePath(file.previousPath)}`
            : ""
        }`,
    )
    .sort((left, right) => left.localeCompare(right));
  hash.update(lines.join("\n"));
  hash.update(`\nlines:${diff.changedLines ?? ""}`);
  return hash.digest("hex");
}

function explain(input: {
  declared: RiskClass;
  effective: RiskClass;
  signals: readonly RiskSignal[];
}): string {
  if (input.effective === input.declared) {
    const reason =
      input.signals.length > 0
        ? ` The diff matched ${plural(input.signals.length, "risk signal")}, none above the declared class.`
        : " No diff signal raised it.";
    return `Effective risk is ${input.effective}, the declared baseline.${reason}`;
  }
  const raising = input.signals.filter(
    (signal) => riskRank(signal.riskClass) === riskRank(input.effective),
  );
  const because =
    raising.length > 0
      ? raising.map((signal) => signal.detail).join(", and ")
      : "repository policy";
  return `Escalated from ${input.declared} to ${input.effective} risk because ${because}.`;
}

/**
 * Combine the declared baseline with what the change actually did.
 *
 * The effective class is the maximum of the declared baseline and every
 * deterministic diff signal, so a nominally low-risk task that touches a
 * protected path is escalated automatically. There is no path that lowers a
 * class below its declared baseline: only repository policy sets the
 * baseline, and only upward from there.
 */
export function classifyChangeRisk(input: {
  declared: RiskClass;
  diff: ChangeDiff;
  policy?: RiskSignalPolicy;
  codeOwners?: CodeOwners;
}): RiskClassification {
  const policy = input.policy ?? DEFAULT_RISK_SIGNAL_POLICY;
  const files = input.diff.files;
  const signals: RiskSignal[] = [...protectedPathSignals(files, policy)];

  const migrations = matchPaths(files, policy.migrations);
  if (migrations.length > 0) {
    signals.push({
      id: "database-migration",
      riskClass: "high",
      detail: `the diff changes ${plural(migrations.length, "database migration")} (${describePaths(migrations)})`,
      paths: migrations,
    });
  }

  const manifests = matchPaths(files, policy.dependencyManifests);
  if (manifests.length > 0) {
    signals.push({
      id: "dependency-manifest",
      riskClass: "high",
      detail: `the diff changes ${plural(manifests.length, "dependency manifest")} (${describePaths(manifests)})`,
      paths: manifests,
    });
  }

  const destructive = destructiveSignal(files);
  if (destructive) signals.push(destructive);

  const size = diffSizeSignal(input.diff, policy);
  if (size) signals.push(size);

  const owners = codeOwnerSignal(files, input.codeOwners);
  if (owners) signals.push(owners);

  const effective = signals.reduce(
    (current, signal) => maxRiskClass(current, signal.riskClass),
    input.declared,
  );
  return {
    declared: input.declared,
    effective,
    escalated: effective !== input.declared,
    signals,
    requiredOwners: owners?.owners ?? [],
    explanation: explain({ declared: input.declared, effective, signals }),
    diffDigest: diffDigest(input.diff),
    changedFileCount: files.length,
    ...(input.diff.changedLines !== undefined
      ? { changedLines: input.diff.changedLines }
      : {}),
  };
}

/**
 * Whether a stored classification still describes the current diff. Rework
 * changes the diff, so a stale classification must be recomputed before any
 * publication or merge decision is made from it.
 */
export function isRiskClassificationStale(
  classification: Pick<RiskClassification, "diffDigest">,
  diff: ChangeDiff,
): boolean {
  return classification.diffDigest !== diffDigest(diff);
}

const NAME_STATUS_CODES: Record<string, DiffChangeStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type-changed",
};

/**
 * Parse `git diff --name-status`. Rename and copy codes carry a similarity
 * score (`R094`) and a second path, which is the pre-rename path.
 */
export function parseNameStatusDiff(output: string): DiffFileChange[] {
  const files: DiffFileChange[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const [code, ...paths] = line.split("\t");
    const status = NAME_STATUS_CODES[(code ?? "").charAt(0)] ?? "unknown";
    if (status === "renamed" || status === "copied") {
      const previousPath = paths[0];
      const path = paths[1];
      if (!path) continue;
      files.push({
        path,
        status,
        ...(previousPath ? { previousPath } : {}),
      });
      continue;
    }
    const path = paths[0];
    if (!path) continue;
    files.push({ path, status });
  }
  return files;
}

/** Parse the trailing summary line of `git diff --shortstat`. */
export function parseShortStatLines(output: string): number | undefined {
  const insertions = /(\d+) insertions?\(\+\)/.exec(output);
  const deletions = /(\d+) deletions?\(-\)/.exec(output);
  if (!insertions && !deletions) return undefined;
  return (
    Number.parseInt(insertions?.[1] ?? "0", 10) +
    Number.parseInt(deletions?.[1] ?? "0", 10)
  );
}
