import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { parseSkillManifest } from "../../src/skills/manifest.js";
import { loadStageSkills } from "../../src/skills/load.js";
import { expect, it } from "vitest";
import { PythonSkillRuntime } from "../../src/skills/runtime.js";
import type { SandboxProcessInput } from "../../src/run/execution/oci.js";

const manifest = {
  apiVersion: "nitely.dev/skill/v1", name: "example", version: "1.0.0",
  runtime: { language: "python", major: 3 }, entrypoints: { main: "main.py" },
  resources: { cpus: 1, memoryBytes: 268435456, pids: 64, tmpfsBytes: 33554432,
    maxFileBytes: 4194304, maxCapturedOutputBytes: 1048576, timeoutMs: 10000 },
  filesystem: { package: "read-only", inputs: ["value.txt"], outputs: ["result.txt"] },
  network: { mode: "none" }, dependencies: { mode: "none" }, secrets: [],
};

it("validates versioned YAML without aliases, duplicate keys, unknown authority or unsafe entrypoints", () => {
  expect(parseSkillManifest(stringify(manifest))).toEqual(manifest);
  for (const value of [
    { ...manifest, apiVersion: "future" }, { ...manifest, privileged: true },
    { ...manifest, entrypoints: { main: "../host.py" } },
    { ...manifest, runtime: { ...manifest.runtime, privileged: true } },
    { ...manifest, resources: { ...manifest.resources, memoryBytes: 9999999999 } },
    { ...manifest, filesystem: { ...manifest.filesystem, package: "read-write" } },
    { ...manifest, secrets: [{ name: "PATH", scope: "global", reference: "all" }] },
    { ...manifest, dependencies: { mode: "locked", lockFile: "requirements.txt", sha256: "a".repeat(64), installHooks: true } },
  ]) expect(() => parseSkillManifest(stringify(value))).toThrow(/skill.yaml/);
  expect(() => parseSkillManifest(stringify(manifest) + "name: duplicate\n")).toThrow();
  expect(() => parseSkillManifest(stringify(manifest).replace("name: example", "name: &alias example").replace("version: 1.0.0", "version: *alias"))).toThrow(/aliases/);
});

it("stages only declared inputs, archives hashed outputs, bounds OCI execution and cleans every outcome", async () => {
  const repo = await mkdtemp(join(tmpdir(), "nitely-skill-test-"));
  const packagePath = join(repo, ".nitely/skills/example");
  await mkdir(packagePath, { recursive: true });
  await writeFile(join(packagePath, "SKILL.md"), "---\nname: example\ndescription: example skill\n---\nRun main.py.");
  await writeFile(join(packagePath, "main.py"), "print('example')");
  await writeFile(join(packagePath, "skill.yaml"), stringify(manifest));
  let policy = structuredClone(manifest);
  let workspace = "";
  let outcome = 0;
  let removed = false;
  let launches = 0;
  const processRunner = async (input: SandboxProcessInput) => {
    if (input.args[0] === "info") return { stdout: '["name=rootless"]\t"2"\t[]', stderr: "", exitCode: 0 };
    if (input.args[0] === "image") return { stdout: `"sha256:${"a".repeat(64)}"\t[]`, stderr: "", exitCode: 0 };
    if (input.args[0] === "rm") { removed = true; return { stdout: "", stderr: outcome === 4 ? "engine cleanup failed" : "", exitCode: outcome === 4 ? 1 : 0 }; }
    launches++;
    const mounts = input.args.filter((arg) => arg.startsWith("type=bind,"));
    workspace = /src=(.*),dst=\/workspace,readonly/.exec(mounts[0])![1];
    expect(mounts).toEqual([`type=bind,src=${workspace},dst=/workspace,readonly`]);
    expect(input.args).toContain("--network=none");
    expect(input.args[input.args.indexOf("--user") + 1]).toBe("1000:1000");
    expect(input.args[input.args.indexOf("--memory") + 1]).toBe(String(policy.resources.memoryBytes));
    expect(input.args[input.args.indexOf("--pids-limit") + 1]).toBe(String(policy.resources.pids));
    expect(input.args).not.toContain("DOCKER_HOST");
    expect(await readFile(join(workspace, "inputs/value.txt"), "utf8")).toBe("declared");
    expect(await readFile(join(workspace, "code/main.py"), "utf8")).toContain("example");
    if (outcome === 2) throw Object.assign(new Error("too much output"), { code: "OUTPUT_LIMIT_EXCEEDED" });
    expect(input.args).toContain(`/nitely/output:rw,nosuid,nodev,noexec,mode=1777,size=${policy.resources.tmpfsBytes}`);
    expect(input.args[input.args.indexOf('--cpus') + 1]).toBe(String(policy.resources.cpus));
    expect(input.timeoutMs).toBe(policy.resources.timeoutMs + 5000);
    return { stdout: JSON.stringify({ stdout: "bounded", stderr: "", exitCode: 0,
      artifacts: [{ path: "result.txt", content: outcome === 3 ? "invalid%base64" : Buffer.from("artifact").toString("base64") }] }), stderr: "", exitCode: outcome === 1 ? 124 : 0 };
  };
  try {
    const runtime = new PythonSkillRuntime({ image: "skill-image:local", env: {}, processRunner });
    for (outcome = 0; outcome < 5; outcome++) {
      removed = false;
      const result = await runtime.execute(repo, { skillId: "example", entrypoint: "main.py", inputs: { "value.txt": "declared" }, outputs: ["result.txt"] });
      expect(removed).toBe(true);
      await expect(stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
      expect(result.failure).toBe([undefined, "timeout", "output-limit", "artifact", "cleanup"][outcome]);
      if (outcome === 0) {
        expect(result.artifacts[0]).toMatchObject({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/), size: 8 });
        expect(await readFile(join(repo, result.artifacts[0].path), "utf8")).toBe("artifact");
      }
      expect(JSON.parse(await readFile(join(repo, ".nitely/skill-executions", result.executionId, "execution.json"), "utf8")).contentHash).toBe(result.contentHash);
    }
    outcome = 0;
    policy = { ...manifest, resources: { ...manifest.resources, cpus: 0.5, memoryBytes: 134217728, pids: 32, tmpfsBytes: 16777216, timeoutMs: 500 } };
    await writeFile(join(packagePath, "skill.yaml"), stringify(policy));
    const reduced = await runtime.execute(repo, { skillId: "example", entrypoint: "main", inputs: { "value.txt": "declared" }, outputs: ["result.txt"], timeoutMs: 60000 });
    expect(reduced.failure).toBeUndefined();
    const evidence = JSON.parse(await readFile(join(repo, ".nitely/skill-executions", reduced.executionId, "execution.json"), "utf8"));
    expect(evidence.manifest.resources).toEqual(policy.resources);
    expect(evidence.resolvedEntrypoint).toBe("main.py");
    expect(evidence.request.inputs["value.txt"]).toMatchObject({ sha256: expect.any(String), size: 8 });
    const authorizedLaunches = launches;
    for (const requested of [{ entrypoint: "undeclared" }, { entrypoint: "main", inputs: { "undeclared.txt": "value" } }, { entrypoint: "main", outputs: ["undeclared.txt"] }]) {
      await expect(runtime.execute(repo, { skillId: "example", ...requested })).rejects.toThrow(/skill.yaml/);
    }
    for (const denied of [{ network: { mode: "allowlist", domains: ["example.test"] } }, { secrets: [{ name: "NITELY_SKILL_SECRET_TEST", scope: "skill", reference: "test" }] }, { dependencies: { mode: "locked", lockFile: "requirements.txt", sha256: "a".repeat(64), installHooks: false } }]) {
      await writeFile(join(packagePath, "skill.yaml"), stringify({ ...policy, ...denied }));
      await expect(runtime.execute(repo, { skillId: "example", entrypoint: "main" })).rejects.toThrow(/unavailable/);
    }
    expect(launches).toBe(authorizedLaunches);
    await rm(join(packagePath, "skill.yaml"));
    const loaded = await loadStageSkills({ repoPath: repo, runDirectory: join(repo, ".nitely/runs/instructions"), stageId: "instructions", skillIds: ["example"] });
    expect(loaded[0].body).toContain("Run main.py");
    await expect(runtime.execute(repo, { skillId: "example", entrypoint: "main" })).rejects.toThrow(/instruction-only/);
    await expect(runtime.execute(repo, { skillId: "example", entrypoint: "../main.py" })).rejects.toThrow();
    await symlink("/etc/passwd", join(packagePath, "host.txt"));
    await expect(runtime.execute(repo, { skillId: "example", entrypoint: "main.py" })).rejects.toThrow();
  } finally { await chmod(repo, 0o700); await rm(repo, { recursive: true, force: true }); }
});
