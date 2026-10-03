import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PythonSkillRuntime } from "../../src/skills/runtime.js";
import type { SandboxProcessInput } from "../../src/run/execution/oci.js";

it("stages only declared inputs, archives hashed outputs, bounds OCI execution and cleans every outcome", async () => {
  const repo = await mkdtemp(join(tmpdir(), "nitely-skill-test-"));
  const packagePath = join(repo, ".nitely/skills/example");
  await mkdir(packagePath, { recursive: true });
  await writeFile(join(packagePath, "SKILL.md"), "---\nname: example\ndescription: example skill\n---\nRun main.py.");
  await writeFile(join(packagePath, "main.py"), "print('example')");
  let workspace = "";
  let outcome = 0;
  let removed = false;
  const processRunner = async (input: SandboxProcessInput) => {
    if (input.args[0] === "info") return { stdout: '["name=rootless"]\t"2"\t[]', stderr: "", exitCode: 0 };
    if (input.args[0] === "image") return { stdout: `"sha256:${"a".repeat(64)}"\t[]`, stderr: "", exitCode: 0 };
    if (input.args[0] === "rm") { removed = true; return { stdout: "", stderr: outcome === 4 ? "engine cleanup failed" : "", exitCode: outcome === 4 ? 1 : 0 }; }
    const mounts = input.args.filter((arg) => arg.startsWith("type=bind,"));
    workspace = /src=(.*),dst=\/workspace,readonly/.exec(mounts[0])![1];
    expect(mounts).toEqual([`type=bind,src=${workspace},dst=/workspace,readonly`]);
    expect(input.args).toContain("--network=none");
    expect(input.args[input.args.indexOf("--user") + 1]).toBe("1000:1000");
    expect(input.args[input.args.indexOf("--memory") + 1]).toBe("268435456");
    expect(input.args[input.args.indexOf("--pids-limit") + 1]).toBe("64");
    expect(input.args).not.toContain("DOCKER_HOST");
    expect(await readFile(join(workspace, "inputs/value.txt"), "utf8")).toBe("declared");
    expect(await readFile(join(workspace, "code/main.py"), "utf8")).toContain("example");
    if (outcome === 2) throw Object.assign(new Error("too much output"), { code: "OUTPUT_LIMIT_EXCEEDED" });
    expect(input.args).toContain('/nitely/output:rw,nosuid,nodev,noexec,mode=1777,size=33554432');
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
    await expect(runtime.execute(repo, { skillId: "example", entrypoint: "../main.py" })).rejects.toThrow();
    await symlink("/etc/passwd", join(packagePath, "host.txt"));
    await expect(runtime.execute(repo, { skillId: "example", entrypoint: "main.py" })).rejects.toThrow();
  } finally { await chmod(repo, 0o700); await rm(repo, { recursive: true, force: true }); }
});
