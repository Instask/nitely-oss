import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { identifierSchema } from "../flow/schema.js";

export const skillRelativePathSchema = z.string().max(256).regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/);
const paths = z.array(skillRelativePathSchema).max(16).refine((values) => new Set(values).size === values.length, "duplicate paths");
export class SkillManifestError extends Error {}
export const skillManifestSchema = z.object({
  apiVersion: z.literal("nitely.dev/skill/v1"),
  name: identifierSchema,
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/),
  runtime: z.object({ language: z.literal("python"), major: z.literal(3) }).strict(),
  entrypoints: z.record(identifierSchema, skillRelativePathSchema.refine((path) => path.endsWith(".py"), "Python entrypoint required"))
    .refine((values) => Object.keys(values).length > 0 && Object.keys(values).length <= 16, "declare 1–16 named entrypoints"),
  resources: z.object({
    cpus: z.number().min(0.1).max(1),
    memoryBytes: z.number().int().min(32 * 1024 * 1024).max(256 * 1024 * 1024),
    pids: z.number().int().min(8).max(64),
    tmpfsBytes: z.number().int().min(1024 * 1024).max(32 * 1024 * 1024),
    maxFileBytes: z.number().int().min(1024).max(4 * 1024 * 1024),
    maxCapturedOutputBytes: z.number().int().min(1024).max(1024 * 1024),
    timeoutMs: z.number().int().min(100).max(60_000),
  }).strict(),
  filesystem: z.object({ package: z.literal("read-only"), inputs: paths, outputs: paths }).strict(),
  network: z.discriminatedUnion("mode", [z.object({ mode: z.literal("none") }).strict(),
    z.object({ mode: z.literal("allowlist"), domains: z.array(z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/)).min(1).max(16) }).strict()]),
  dependencies: z.discriminatedUnion("mode", [z.object({ mode: z.literal("none") }).strict(),
    z.object({ mode: z.literal("locked"), lockFile: skillRelativePathSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/), installHooks: z.literal(false) }).strict()]),
  secrets: z.array(z.object({ name: z.string().regex(/^NITELY_SKILL_SECRET_[A-Z0-9_]+$/), scope: z.literal("skill"), reference: identifierSchema }).strict()).max(16),
}).strict();
export type SkillManifest = z.infer<typeof skillManifestSchema>;

export function parseSkillManifest(text: string): SkillManifest {
  if (Buffer.byteLength(text) > 64 * 1024) throw new SkillManifestError("skill.yaml exceeds 64 KiB");
  const document = parseDocument(text, { strict: true, uniqueKeys: true, stringKeys: true, schema: "core" });
  if (document.errors.length || document.warnings.length) throw new SkillManifestError("skill.yaml: invalid YAML or unsupported tags");
  let value: unknown;
  try { value = document.toJS({ maxAliasCount: 0 }); }
  catch { throw new SkillManifestError("skill.yaml: aliases are not supported"); }
  const parsed = skillManifestSchema.safeParse(value);
  if (!parsed.success) throw new SkillManifestError("skill.yaml: " + parsed.error.issues.map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`).join("; "));
  return parsed.data;
}

/** Called on the already bounded, private package snapshot, never on a live source path. */
export async function loadExecutionManifest(packagePath: string, skillId: string): Promise<SkillManifest> {
  let text: string;
  try { text = await readFile(join(packagePath, "skill.yaml"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SkillManifestError("Skill is instruction-only: skill.yaml is required for execution");
    throw error;
  }
  const manifest = parseSkillManifest(text);
  if (manifest.name !== skillId) throw new SkillManifestError("skill.yaml name must match the package id");
  return manifest;
}
