import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { identifierSchema } from "../flow/schema.js";
import type { OciExecutionBackendOptions } from "../run/execution/oci.js";
import type { ExecutionBackendDescription } from "../run/execution/types.js";
import { OciSkillSandboxProvider, selectSkillSandboxProvider, type SkillSandboxProvider } from "./sandbox.js";
import { ensureRunOwnedDirectory, writeRunOwnedFileAtomically } from "../run/owned-file.js";
import { snapshotSkillPackage } from "./package.js";
import { withKnowledgeLease } from "../knowledge-repositories/lock.js";
import { loadExecutionManifest, SkillManifestError, skillRelativePathSchema, type SkillManifest } from "./manifest.js";
import { requireSkillApproval, SkillTrustError, skillHashSchema, type SkillApproval, type SkillApprovalScope } from "./trust.js";

// Relative POSIX paths only: no shell syntax, hidden components or parent hops.
const pathSchema = skillRelativePathSchema;
export const skillExecutionSchema = z.object({
  skillId: identifierSchema,
  entrypoint: pathSchema,
  inputs: z.record(pathSchema, z.string().max(1024 * 1024)).default({}),
  outputs: z.array(pathSchema).max(16).default([]),
  timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
  expectedContentHash: skillHashSchema.optional(),
}).strict();
export type SkillExecutionRequest = z.input<typeof skillExecutionSchema>;
export interface SkillExecutionResult {
  executionId: string;
  skillId: string;
  contentHash: string;
  durationMs: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  failure?: "timeout" | "process-exit" | "output-limit" | "sandbox" | "artifact" | "cleanup";
  artifacts: { path: string; sha256: string; size: number }[];
}
export interface SkillRuntime {
  execute(repoPath: string, request: SkillExecutionRequest, scope?: SkillApprovalScope): Promise<SkillExecutionResult>;
}

const PYTHON_WRAPPER = `import base64, json, os, stat, subprocess, sys, tempfile
request = json.load(open('/workspace/request.json'))
assert sys.version_info.major == 3
log_limit = request['resources']['maxCapturedOutputBytes']
file_limit = request['resources']['maxFileBytes']
result = dict(stdout='', stderr='', exitCode=None, artifacts=[])
with tempfile.TemporaryDirectory(dir='/tmp') as logs:
    with open(logs + '/stdout', 'wb') as stdout, open(logs + '/stderr', 'wb') as stderr:
        process = subprocess.Popen([sys.executable, '-I', '/workspace/code/' + request['entrypoint']],
            cwd='/workspace/code', stdout=stdout, stderr=stderr,
            env=dict(os.environ, NITELY_INPUT_DIR='/workspace/inputs'), start_new_session=True)
        try:
            result['exitCode'] = process.wait(timeout=request['timeoutMs'] / 1000)
        except subprocess.TimeoutExpired:
            result['failure'] = 'timeout'
        finally:
            # Descendants may keep writing after the entrypoint exits. Capture only after killing its group.
            import signal
            try: os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            process.wait()
    total = 0
    for name in ('stdout', 'stderr'):
        with open(logs + '/' + name, 'rb') as log:
            data = log.read(log_limit + 1)
        total += len(data)
        result[name] = data[:log_limit].decode('utf8', errors='replace')
    if total > log_limit: result['failure'] = 'output-limit'
    if result.get('failure') is None and result['exitCode'] != 0: result['failure'] = 'process-exit'
    if result.get('failure') is None:
        try:
            total = 0
            for path in request['outputs']:
                segments = path.split('/')
                parent = os.open('/nitely/output', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    for segment in segments[:-1]:
                        following = os.open(segment, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                        os.close(parent)
                        parent = following
                    descriptor = os.open(segments[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                    with os.fdopen(descriptor, 'rb') as output:
                        details = os.fstat(output.fileno())
                        if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1: raise ValueError('unsafe output')
                        data = output.read(file_limit + 1)
                    total += len(data)
                    if len(data) > file_limit or total > 8388608: raise ValueError('oversized output')
                    result['artifacts'].append(dict(path=path, content=base64.b64encode(data).decode('ascii')))
                finally: os.close(parent)
        except Exception:
            result['failure'] = 'artifact'
            result['artifacts'] = []
print(json.dumps(result))
`;

/** Repository-local Python only; the operator supplies the preinstalled image. */
export class PythonSkillRuntime implements SkillRuntime {
  constructor(private readonly options: Pick<OciExecutionBackendOptions, "image" | "env" | "processRunner" | "engineSocketVerifier"> & { sandboxProviders?: readonly SkillSandboxProvider[] }) {}

  async execute(repoPath: string, raw: SkillExecutionRequest, scope?: SkillApprovalScope): Promise<SkillExecutionResult> {
    skillExecutionSchema.parse(raw);
    await ensureRunOwnedDirectory({ runDirectory: repoPath, path: ".nitely/skill-executions", subject: "Skill execution archive" });
    // ponytail: one active Skill per repository; per-tenant admission if throughput matters.
    return await withKnowledgeLease({ path: join(repoPath, ".nitely/skill-executions/execution.lock"), waitMs: 0 },
      async () => await this.executeIsolated(repoPath, raw, scope));
  }

  private async executeIsolated(repoPath: string, raw: SkillExecutionRequest, scope?: SkillApprovalScope): Promise<SkillExecutionResult> {
    const request = skillExecutionSchema.parse(raw);
    if (new Set(request.outputs).size !== request.outputs.length) throw new Error("duplicate Skill output paths");
    if (Object.keys(request.inputs).length > 16 || Object.values(request.inputs).reduce((size, value) => size + Buffer.byteLength(value), 0) > 1024 * 1024) {
      throw new Error("Skill inputs exceed the 1 MiB / 16 file limit");
    }
    const executionId = randomUUID();
    const temporaryRoot = await mkdtemp(join(tmpdir(), "nitely-skill-"));
    const workspace = join(temporaryRoot, "workspace");
    const started = Date.now();
    let contentHash: string | undefined;
    let manifest: SkillManifest | undefined;
    let approval: SkillApproval | undefined;
    try {
      await mkdir(workspace, { mode: 0o755 });
      const code = join(workspace, "code");
      await mkdir(code, { mode: 0o755 });
      const skill = await snapshotSkillPackage({ rootDirectory: repoPath, sourcePath: `.nitely/skills/${request.skillId}`, destination: code, skillId: request.skillId });
      contentHash = skill.contentHash;
      manifest = await loadExecutionManifest(code, request.skillId);
      const provider = selectSkillSandboxProvider(this.options.sandboxProviders ?? [new OciSkillSandboxProvider(this.options)], manifest);
      if (manifest.network.mode !== "none") throw new SkillManifestError("skill.yaml network: approved allowlist execution is unavailable; use mode none");
      if (manifest.secrets.length) throw new SkillManifestError("skill.yaml secrets: approved scoped-secret injection is unavailable");
      if (manifest.dependencies.mode !== "none") throw new SkillManifestError("skill.yaml dependencies: locked dependency installation is unavailable; use mode none");
      const entrypoint = Object.hasOwn(manifest.entrypoints, request.entrypoint) ? manifest.entrypoints[request.entrypoint] : Object.values(manifest.entrypoints).includes(request.entrypoint) ? request.entrypoint : undefined;
      if (!entrypoint || !skill.resources.some((file) => file.relativePath === entrypoint)) throw new SkillManifestError("skill.yaml must declare the requested package entrypoint");
      const filesystem = manifest.filesystem;
      if (Object.keys(request.inputs).some((path) => !filesystem.inputs.includes(path)) || request.outputs.some((path) => !filesystem.outputs.includes(path))) {
        throw new SkillManifestError("skill.yaml does not grant the requested input/output paths");
      }
      const timeoutMs = Math.min(request.timeoutMs, manifest.resources.timeoutMs);
      for (const [path, content] of Object.entries(request.inputs)) {
        await mkdir(dirname(join(workspace, "inputs", path)), { recursive: true, mode: 0o755 });
        await writeFile(join(workspace, "inputs", path), content, { flag: "wx", mode: 0o644 });
      }
      const output = join(workspace, "outputs");
      await mkdir(output, { mode: 0o700 });
      await writeFile(join(workspace, "request.json"), JSON.stringify({ ...request, entrypoint, timeoutMs, resources: manifest.resources }), { mode: 0o644 });
      await writeFile(join(workspace, "execute.py"), PYTHON_WRAPPER, { mode: 0o644 });
      const result: SkillExecutionResult = { executionId, skillId: request.skillId, contentHash: skill.contentHash,
        durationMs: 0, exitCode: null, stdout: "", stderr: "", artifacts: [] };
      let captured: Array<{ path: string; content: string }> = [];
      let sandbox: ExecutionBackendDescription | undefined;
      try {
        approval = await requireSkillApproval(repoPath, request.skillId, skill.contentHash, request.expectedContentHash, scope);
        const execution = await provider.execute({ workspace, outputDirectory: output, executionId, skillId: request.skillId, resources: manifest.resources, timeoutMs });
        sandbox = execution.evidence;
        const command = execution.command;
        if (command.exitCode !== 0) {
          result.exitCode = command.exitCode;
          result.failure = command.exitCode === 124 ? "timeout" : "process-exit";
        } else {
          const payload = z.object({ stdout: z.string().max(1024 * 1024), stderr: z.string().max(1024 * 1024),
            exitCode: z.number().int().nullable(), failure: z.enum(["timeout", "process-exit", "output-limit", "artifact"]).optional(),
            artifacts: z.array(z.object({ path: pathSchema, content: z.string().max(6 * 1024 * 1024) }).strict()).max(16) }).strict().parse(JSON.parse(command.stdout));
          Object.assign(result, { stdout: payload.stdout, stderr: payload.stderr, exitCode: payload.exitCode, ...(payload.failure ? { failure: payload.failure } : {}) });
          captured = payload.artifacts;
        }
      } catch (error) {
        if (error instanceof SkillManifestError) throw error;
        const failure = error as { code?: string; cleanupFailed?: boolean; sandboxEvidence?: ExecutionBackendDescription };
        sandbox = failure.sandboxEvidence;
        result.failure = failure.cleanupFailed ? "cleanup" : failure.code === "OUTPUT_LIMIT_EXCEEDED" ? "output-limit" : "sandbox";
        // No engine diagnostics, host paths or environment values in the tool response.
      }
      const archive = `.nitely/skill-executions/${executionId}`;
      await ensureRunOwnedDirectory({ runDirectory: repoPath, path: archive, subject: "Skill execution archive" });
      if (!result.failure) {
        try {
          let artifactBytes = 0;
          // Materialize bytes only after OCI cleanup. Workload writes stay in bounded tmpfs.
          if (captured.length !== request.outputs.length || new Set(captured.map((artifact) => artifact.path)).size !== captured.length) throw new Error("invalid artifact set");
          for (const artifact of captured) {
            const path = artifact.path;
            if (!request.outputs.includes(path) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(artifact.content)) throw new Error("invalid artifact");
            const file = { content: Buffer.from(artifact.content, "base64") };
            if (file.content.byteLength > 4 * 1024 * 1024) throw new Error("oversized artifact");
            artifactBytes += file.content.byteLength;
            if (artifactBytes > 8 * 1024 * 1024) throw new Error("Skill artifacts exceed 8 MiB");
            const artifactPath = `${archive}/outputs/${path}`;
            await ensureRunOwnedDirectory({ runDirectory: repoPath, path: dirname(artifactPath), subject: "Skill artifact directory" });
            await writeRunOwnedFileAtomically({ runDirectory: repoPath, path: artifactPath, subject: "Skill artifact", content: file.content });
            result.artifacts.push({ path: artifactPath, sha256: createHash("sha256").update(file.content).digest("hex"), size: file.content.byteLength });
          }
        } catch { result.failure = "artifact"; }
      }
      result.durationMs = Date.now() - started;
      await writeRunOwnedFileAtomically({ runDirectory: repoPath, path: `${archive}/execution.json`, subject: "Skill execution evidence",
        content: JSON.stringify({ ...result, manifest, approval, packageSource: "repository-local", packageVersion: manifest.version,
          grantedAuthority: { ...manifest.filesystem, network: "none", secrets: [], dependencies: "none", resources: manifest.resources },
          resolvedEntrypoint: entrypoint, provider: { id: provider.id, capabilities: [...provider.capabilities] }, request: { ...request, inputs: Object.fromEntries(Object.entries(request.inputs).map(([path, content]) => [path, { sha256: createHash("sha256").update(content).digest("hex"), size: Buffer.byteLength(content) }])) }, createdAt: new Date().toISOString(), sandbox }) });
      return result;
    } catch (error) {
      const archive = `.nitely/skill-executions/${executionId}`;
      await ensureRunOwnedDirectory({ runDirectory: repoPath, path: archive, subject: "Skill denied-execution archive" });
      await writeRunOwnedFileAtomically({ runDirectory: repoPath, path: `${archive}/execution.json`, subject: "Skill denied-execution evidence",
        content: JSON.stringify({ executionId, skillId: request.skillId, contentHash, packageVersion: manifest?.version, manifest,
          packageSource: "repository-local", outcome: "denied", reasonCode: error instanceof SkillTrustError ? error.code : error instanceof SkillManifestError ? "manifest-policy" : "package-validation",
          grantedAuthority: null, provider: null, approval, durationMs: Date.now() - started, createdAt: new Date().toISOString() }) });
      if (error instanceof Error) Object.assign(error, { executionId });
      throw error;
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}
