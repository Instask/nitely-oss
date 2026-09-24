import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadCodeOwners, type CodeOwners } from "../policy/codeowners.js";
import { normalizeRelativePath } from "../policy/glob.js";
import {
  classifyChangeRisk,
  parseNameStatusDiff,
  parseShortStatLines,
  type ChangeDiff,
  type DiffFileChange,
  type RiskClassification,
} from "../policy/risk.js";
import {
  declaredRiskBaseline,
  loadReviewPolicy,
  resolveReviewRequirement,
  type ReviewPolicy,
  type ReviewRequirement,
} from "../policy/review-policy.js";

const execFileAsync = promisify(execFile);
const GIT_DIFF_MAX_BUFFER = 8 * 1024 * 1024;

export type RunGit = (
  cwd: string,
  args: string[],
) => Promise<string | undefined>;

const defaultRunGit: RunGit = async (cwd, args) => {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: GIT_DIFF_MAX_BUFFER,
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
};

/**
 * The change this run actually produced, as git sees it.
 *
 * Covers both what is already committed on this branch and what is still
 * pending in the worktree, because the two publication paths commit at
 * different moments: a publish stage commits before it classifies, while a
 * rework update leaves the commit to the provider. Classifying only committed
 * work would let a rework's real diff go unclassified.
 */
export async function collectChangeDiff(input: {
  worktreePath: string;
  baseBranch: string;
  git?: RunGit;
}): Promise<ChangeDiff> {
  const git = input.git ?? defaultRunGit;
  const byPath = new Map<string, DiffFileChange>();
  let changedLines: number | undefined;

  const addLines = (value: number | undefined): void => {
    if (value === undefined) return;
    changedLines = (changedLines ?? 0) + value;
  };
  const overlay = (files: readonly DiffFileChange[]): void => {
    for (const file of files) {
      byPath.set(normalizeRelativePath(file.path), file);
    }
  };

  for (const candidate of [
    `${input.baseBranch}...HEAD`,
    `${input.baseBranch}..HEAD`,
  ]) {
    const nameStatus = await git(input.worktreePath, [
      "diff",
      "--name-status",
      candidate,
    ]);
    if (nameStatus === undefined) continue;
    overlay(parseNameStatusDiff(nameStatus));
    addLines(
      parseShortStatLines(
        (await git(input.worktreePath, ["diff", "--shortstat", candidate])) ?? "",
      ),
    );
    break;
  }

  // Pending work overlays the committed range: it is the newer state.
  const pending = await git(input.worktreePath, ["diff", "--name-status", "HEAD"]);
  if (pending !== undefined) {
    overlay(parseNameStatusDiff(pending));
    addLines(
      parseShortStatLines(
        (await git(input.worktreePath, ["diff", "--shortstat", "HEAD"])) ?? "",
      ),
    );
  }

  const untracked = await git(input.worktreePath, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  for (const path of (untracked ?? "").split(/\r?\n/)) {
    if (path.trim().length === 0) continue;
    byPath.set(normalizeRelativePath(path), { path, status: "added" });
  }

  return {
    files: [...byPath.values()],
    ...(changedLines !== undefined ? { changedLines } : {}),
  };
}

export interface ChangeRiskEvaluation {
  classification: RiskClassification;
  requirement: ReviewRequirement;
  /** Whether the repository supplied a review policy file. */
  policyConfigured: boolean;
  /** Repo-relative CODEOWNERS path consulted, when one existed. */
  codeOwnersPath?: string;
}

/**
 * Compute the effective risk of what this run changed, and the review it
 * therefore needs. Always computed from the current diff, so a rework that
 * changes the diff is re-classified before the next publication decision
 * rather than inheriting the previous answer.
 */
export async function evaluateChangeRisk(input: {
  repoPath: string;
  worktreePath: string;
  baseBranch: string;
  workItemType?: string;
  highRiskWorkItemType?: boolean;
  policy?: ReviewPolicy;
  codeOwners?: CodeOwners;
  diff?: ChangeDiff;
  git?: RunGit;
}): Promise<ChangeRiskEvaluation> {
  const policy = input.policy ?? (await loadReviewPolicy(input.repoPath));
  const codeOwners = input.codeOwners ?? (await loadCodeOwners(input.repoPath));
  const diff =
    input.diff ??
    (await collectChangeDiff({
      worktreePath: input.worktreePath,
      baseBranch: input.baseBranch,
      ...(input.git ? { git: input.git } : {}),
    }));
  const classification = classifyChangeRisk({
    declared: declaredRiskBaseline({
      policy,
      ...(input.workItemType ? { workItemType: input.workItemType } : {}),
      ...(input.highRiskWorkItemType !== undefined
        ? { highRiskWorkItemType: input.highRiskWorkItemType }
        : {}),
    }),
    diff,
    policy: policy.signals,
    codeOwners,
  });
  return {
    classification,
    requirement: resolveReviewRequirement({ policy, classification }),
    policyConfigured: policy.configured,
    ...(codeOwners.sourcePath ? { codeOwnersPath: codeOwners.sourcePath } : {}),
  };
}
