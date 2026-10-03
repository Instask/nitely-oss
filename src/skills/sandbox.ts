import { OciExecutionBackend, type OciExecutionBackendOptions } from "../run/execution/oci.js";
import type { CommandResult, ExecutionBackendDescription } from "../run/execution/types.js";
import { SkillManifestError, type SkillManifest } from "./manifest.js";

export type SkillSandboxCapability = "python:3" | "identity:non-root" | "filesystem:readonly-staging" |
  "network:none" | "network:allowlist" | "resource:cpu" | "resource:memory" | "resource:pids" |
  "resource:tmpfs" | "resource:file" | "resource:output" | "resource:timeout" |
  "artifacts:bounded" | "cleanup:blocking" | "ttl:workload" | "secrets:scoped" | "dependencies:locked" | "snapshots";

export interface SkillSandboxProvider {
  readonly id: string;
  readonly capabilities: ReadonlySet<SkillSandboxCapability>;
  /** Atomic lifecycle: provision, stage read-only, execute, collect, remove workload before settling. */
  execute(input: { workspace: string; outputDirectory: string; executionId: string; skillId: string;
    resources: SkillManifest["resources"]; timeoutMs: number }): Promise<{ command: CommandResult; evidence: ExecutionBackendDescription }>;
}

const REQUIRED_CAPABILITIES: SkillSandboxCapability[] = ["python:3", "identity:non-root", "filesystem:readonly-staging",
  "resource:cpu", "resource:memory", "resource:pids", "resource:tmpfs", "resource:file", "resource:output", "resource:timeout",
  "artifacts:bounded", "cleanup:blocking", "ttl:workload"];

export function selectSkillSandboxProvider(providers: readonly SkillSandboxProvider[], manifest: SkillManifest): SkillSandboxProvider {
  const required = [...REQUIRED_CAPABILITIES, `network:${manifest.network.mode}` as SkillSandboxCapability,
    ...(manifest.secrets.length ? ["secrets:scoped" as const] : []),
    ...(manifest.dependencies.mode === "locked" ? ["dependencies:locked" as const] : [])];
  const provider = providers.find((candidate) => required.every((capability) => candidate.capabilities.has(capability)));
  if (!provider) {
    const missing = required.filter((capability) => !providers.some((candidate) => candidate.capabilities.has(capability)));
    throw new SkillManifestError(`No sandbox provider satisfies the Skill policy: ${missing.length ? missing.join(", ") : "required capabilities must belong to one provider"}`);
  }
  return provider;
}

/** Reuses the OCI backend's rootless/cgroup verification, pinned image and blocking cleanup. */
export class OciSkillSandboxProvider implements SkillSandboxProvider {
  readonly id = "oci";
  readonly capabilities: ReadonlySet<SkillSandboxCapability> = new Set([...REQUIRED_CAPABILITIES, "network:none"]);
  constructor(private readonly options: Pick<OciExecutionBackendOptions, "image" | "env" | "processRunner" | "engineSocketVerifier">) {}

  async execute(input: Parameters<SkillSandboxProvider["execute"]>[0]): ReturnType<SkillSandboxProvider["execute"]> {
    const backend = new OciExecutionBackend({ ...this.options, uid: 1000, gid: 1000,
      environmentAllowlist: [], secretAllowlist: [], networkAllowlist: [],
      resources: { ...input.resources, maxCapturedOutputBytes: 20 * 1024 * 1024, timeoutMs: input.timeoutMs + 5000 } });
    const evidence = (): ExecutionBackendDescription => ({ ...backend.describeExecution(), mounts: ["staged-code-and-inputs:read-only", "outputs:bounded-tmpfs"],
      limitations: ["Python standard library only; no dependency installation"] });
    try {
      await backend.prepareForRun();
      const workspace = { runId: input.executionId, path: input.workspace };
      const options = { isolatedWorkspace: true, outputDirectory: input.outputDirectory, runId: input.executionId, stageId: input.skillId };
      // Probe the pinned image before executing package code; no interpreter installation or fallback.
      const probe = await backend.runCommand(workspace, "python3 -I -c 'import sys; assert sys.version_info.major == 3'", { ...options, timeoutMs: 5000 });
      if (probe.exitCode !== 0) throw new SkillManifestError("Selected sandbox image lacks the required Python 3 runtime");
      const command = await backend.runCommand(workspace, "python3 -I /workspace/execute.py", { ...options, timeoutMs: input.timeoutMs + 5000 });
      return { command, evidence: evidence() };
    } catch (error) {
      if (error instanceof Error) Object.assign(error, { sandboxEvidence: evidence() });
      throw error;
    }
  }
}
