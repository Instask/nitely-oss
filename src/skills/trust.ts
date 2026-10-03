import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { identifierSchema } from "../flow/schema.js";
import { withKnowledgeLease } from "../knowledge-repositories/lock.js";
import { ensureRunOwnedDirectory, readRunOwnedFile, writeRunOwnedFileAtomically } from "../run/owned-file.js";
import { loadExecutionManifest, SkillManifestError, type SkillManifest } from "./manifest.js";
import { snapshotSkillPackage } from "./package.js";

export const skillHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const approvalSchema = z.object({ version: z.literal(1), skillId: identifierSchema, contentHash: skillHashSchema,
  actorId: z.string().min(1).max(256), approvedAt: z.iso.datetime(), revokedAt: z.iso.datetime().optional(),
  scope: z.object({ organizationId: z.string().min(1).max(256), repositoryId: z.string().min(1).max(256) }).strict().optional(),
  authority: z.object({ network: z.literal("none"), secrets: z.array(z.never()).max(0), dependencies: z.literal("none") }).strict() }).strict();
export interface SkillApprovalScope { organizationId?: string; repositoryId: string }
export type SkillApproval = z.infer<typeof approvalSchema>;
export class SkillTrustError extends SkillManifestError {
  constructor(readonly code: "approval-required" | "identity-changed" | "approval-revoked", message: string) { super(message); }
}

export function requireUnprivilegedSkillPolicy(manifest: SkillManifest): void {
  if (manifest.network.mode !== "none" || manifest.secrets.length || manifest.dependencies.mode !== "none") {
    throw new SkillManifestError("Skill policy requires unsupported network, secret or dependency installation authority; none is approved");
  }
}

async function readApproval(repoPath: string, skillId: string): Promise<SkillApproval | null> {
  identifierSchema.parse(skillId);
  try {
    const file = await readRunOwnedFile({ runDirectory: repoPath, path: `.nitely/skill-approvals/${skillId}.json`, subject: "Skill approval", maximumBytes: 16 * 1024 });
    const record = approvalSchema.parse(JSON.parse(file.content.toString("utf8")));
    if (record.skillId !== skillId) throw new Error("invalid approval identity");
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SkillTrustError("approval-required", "Skill approval record is invalid; approve the current package again");
  }
}

export async function inspectRepositorySkill(repoPath: string, skillId: string, scope?: SkillApprovalScope) {
  identifierSchema.parse(skillId);
  const temporary = await mkdtemp(join(tmpdir(), "nitely-skill-inspect-"));
  try {
    const code = join(temporary, "code"); await mkdir(code);
    const skill = await snapshotSkillPackage({ rootDirectory: repoPath, sourcePath: `.nitely/skills/${skillId}`, destination: code, skillId });
    const manifest = skill.resources.some((file) => file.relativePath === "skill.yaml") ? await loadExecutionManifest(code, skillId) : undefined;
    let approval: SkillApproval | null;
    try { approval = await readApproval(repoPath, skillId); }
    catch (error) { if (error instanceof SkillTrustError) approval = null; else throw error; }
    return { skillId, contentHash: skill.contentHash, version: manifest?.version ?? "unversioned", manifest,
      executable: Boolean(manifest), trust: approval && !approval.revokedAt && approval.contentHash === skill.contentHash &&
        (!scope || (approval.scope?.organizationId === scope.organizationId && approval.scope?.repositoryId === scope.repositoryId)) ? "approved" as const : "untrusted" as const,
      approval: approval ? { contentHash: approval.contentHash, actorId: approval.actorId, approvedAt: approval.approvedAt, revokedAt: approval.revokedAt } : undefined };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** Privileged operator entrypoint; Web callers must authenticate/recheck repository ownership first. */
export async function approveRepositorySkill(repoPath: string, input: { skillId: string; contentHash: string; actorId: string; scope?: { organizationId: string; repositoryId: string } }): Promise<SkillApproval> {
  identifierSchema.parse(input.skillId); skillHashSchema.parse(input.contentHash);
  const identity = await inspectRepositorySkill(repoPath, input.skillId);
  if (!identity.manifest) throw new SkillManifestError("Instruction-only Skills cannot receive execution approval");
  requireUnprivilegedSkillPolicy(identity.manifest);
  if (identity.contentHash !== input.contentHash) throw new SkillTrustError("identity-changed", "Skill package changed since inspection; inspect and approve again");
  const approval = approvalSchema.parse({ version: 1, ...input, approvedAt: new Date().toISOString(), authority: { network: "none", secrets: [], dependencies: "none" } });
  await ensureRunOwnedDirectory({ runDirectory: repoPath, path: ".nitely/skill-approvals", subject: "Skill approval store" });
  await withKnowledgeLease({ path: join(repoPath, ".nitely/skill-approvals/approvals.lock"), waitMs: 10_000 }, async () => {
    await writeRunOwnedFileAtomically({ runDirectory: repoPath, path: `.nitely/skill-approvals/${input.skillId}.json`, subject: "Skill approval", content: JSON.stringify(approval) });
  });
  return approval;
}

export async function revokeRepositorySkill(repoPath: string, skillId: string): Promise<void> {
  identifierSchema.parse(skillId);
  await ensureRunOwnedDirectory({ runDirectory: repoPath, path: ".nitely/skill-approvals", subject: "Skill approval store" });
  await withKnowledgeLease({ path: join(repoPath, ".nitely/skill-approvals/approvals.lock"), waitMs: 10_000 }, async () => {
    const record = await readApproval(repoPath, skillId);
    if (record) await writeRunOwnedFileAtomically({ runDirectory: repoPath, path: `.nitely/skill-approvals/${skillId}.json`, subject: "Skill approval", content: JSON.stringify({ ...record, revokedAt: new Date().toISOString() }) });
  });
}

export async function requireSkillApproval(repoPath: string, skillId: string, contentHash: string, expectedHash?: string, scope?: SkillApprovalScope): Promise<SkillApproval> {
  if (expectedHash && expectedHash !== contentHash) throw new SkillTrustError("identity-changed", "Skill package differs from the requested content hash");
  const approval = await readApproval(repoPath, skillId);
  if (!approval) throw new SkillTrustError("approval-required", "Skill is untrusted; an operator must approve this exact package hash");
  if (scope && (approval.scope?.organizationId !== scope.organizationId || approval.scope?.repositoryId !== scope.repositoryId)) {
    throw new SkillTrustError("approval-required", "Skill approval does not match the current repository and organization");
  }
  if (approval.revokedAt) throw new SkillTrustError("approval-revoked", "Skill execution approval has been revoked");
  if (approval.contentHash !== contentHash) throw new SkillTrustError("identity-changed", "Skill package changed after approval; inspect and approve again");
  return approval;
}
