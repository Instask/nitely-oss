import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createNitelyMcpServer } from "../../src/mcp/server.js";
import { PythonSkillRuntime } from "../../src/skills/runtime.js";
import { startWebServer } from "../../src/web/server.js";
import { createSession, createUser } from "../../src/web/users.js";
import { addOrganizationMember, listPublicMemberships } from "../../src/web/organizations.js";
import { createApiToken } from "../../src/web/api-tokens.js";
import { queryOrganizationAudit } from "../../src/web/security-audit.js";

it("requires owner-approved package hashes, denies agent self-approval and audits tamper, scope, revocation and privilege denials", async () => {
  const repo = await mkdtemp(join(tmpdir(), "nitely-trust-test-"));
  const code = join(repo, ".nitely/skills/example"); await mkdir(code, { recursive: true });
  await writeFile(join(code, "SKILL.md"), "---\nname: example\ndescription: example\n---\nUse main.py.");
  await writeFile(join(code, "main.py"), "print('hello')");
  const manifest = { apiVersion: "nitely.dev/skill/v1", name: "example", version: "1.0.0", runtime: { language: "python", major: 3 }, entrypoints: { main: "main.py" },
    resources: { cpus: 1, memoryBytes: 268435456, pids: 64, tmpfsBytes: 33554432, maxFileBytes: 4194304, maxCapturedOutputBytes: 1048576, timeoutMs: 10000 },
    filesystem: { package: "read-only", inputs: [], outputs: [] }, network: { mode: "none" }, dependencies: { mode: "none" }, secrets: [] };
  await writeFile(join(code, "skill.yaml"), JSON.stringify(manifest));
  const password = "owner trust password passphrase";
  const owner = await createUser(repo, { email: "owner@example.test", password, role: "admin" });
  const org = (await listPublicMemberships(repo, owner.id))[0].organizationId;
  const member = await createUser(repo, { email: "member@example.test", password: "member trust password", role: "user" });
  await addOrganizationMember(repo, org, { userId: member.id, role: "member" });
  const outsider = await createUser(repo, { email: "outsider@example.test", password: "outsider trust password", role: "admin" });
  const ownerCookie = "nitely_session=" + (await createSession(repo, owner.id)).id;
  const memberCookie = "nitely_session=" + (await createSession(repo, member.id)).id;
  const outsiderCookie = "nitely_session=" + (await createSession(repo, outsider.id)).id;
  const token = await createApiToken(repo, { ownerUserId: owner.id, name: "skill-agent", capabilities: ["runs:read", "runs:start"], allowHighImpact: true });
  let executions = 0;
  const runtime = new PythonSkillRuntime({ image: "python-test:local", env: {}, processRunner: async (input) => {
    if (input.args[0] === "info") return { stdout: '["name=rootless"]\t"2"\t[]', stderr: "", exitCode: 0 };
    if (input.args[0] === "image") return { stdout: '"sha256:' + "a".repeat(64) + '"\t[]', stderr: "", exitCode: 0 };
    if (input.args[0] === "rm" || input.args.at(-1)?.includes("sys.version_info")) return { stdout: "", stderr: "", exitCode: 0 };
    executions++; return { stdout: JSON.stringify({ stdout: "hello", stderr: "", exitCode: 0, artifacts: [] }), stderr: "", exitCode: 0 };
  } });
  const web = await startWebServer({ repoPath: repo, host: "127.0.0.1", port: 0, authMode: "required", authEnv: {},
    providerEnv: { NITELY_EXECUTION_BACKEND: "local", NITELY_ALLOW_UNSAFE_LOCAL_EXECUTION: "true" },
    repositories: [{ id: "home", path: repo, synthetic: true, organizationId: org }], skillRuntime: runtime });
  const mcp = createNitelyMcpServer({ serverUrl: web.url, apiToken: token.token });
  const client = new Client({ name: "trust-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);
  const base = { repoId: "home", skillId: "example" };
  const request = (action: string, body: unknown, cookie = ownerCookie, authorization?: string) => fetch(web.url + "/api/skills/" + action, {
    method: "POST", headers: { "content-type": "application/json", cookie, ...(authorization ? { authorization } : {}) }, body: JSON.stringify(body) });
  try {
    const inspect = async () => ((await client.callTool({ name: "inspect_skill", arguments: base })).structuredContent as any).skill;
    const original = await inspect(); expect(original.trust).toBe("untrusted");
    expect((await client.listTools()).tools.some((tool) => /approve/.test(tool.name) && /skill/.test(tool.name))).toBe(false);
    expect((await client.callTool({ name: "execute_skill", arguments: { ...base, entrypoint: "main" } })).isError).toBe(true);
    expect(executions).toBe(0);
    const approval = { ...base, contentHash: original.contentHash, password };
    expect((await request("approve", { ...approval, password: "wrong" })).status).toBe(403);
    expect((await request("approve", approval, memberCookie)).status).toBe(403);
    expect((await request("inspect", base, outsiderCookie)).status).toBe(404);
    expect((await request("approve", { ...approval, authority: "all" })).status).toBe(400);
    expect((await request("approve", approval, ownerCookie, "Bearer " + token.token)).status).toBe(403);
    expect((await request("approve", { ...approval, contentHash: "0".repeat(64) })).status).toBe(400);
    expect((await request("approve", approval)).status).toBe(200);
    expect((await inspect()).trust).toBe("approved");
    const result = await client.callTool({ name: "execute_skill", arguments: { ...base, entrypoint: "main", expectedContentHash: original.contentHash } });
    expect(result.isError).not.toBe(true); expect(executions).toBe(1);
    const execution = (result.structuredContent as any).execution;
    const evidence = JSON.parse(await readFile(join(repo, ".nitely/skill-executions", execution.executionId, "execution.json"), "utf8"));
    expect(evidence).toMatchObject({ contentHash: original.contentHash, packageVersion: "1.0.0", approval: { actorId: owner.id, scope: { organizationId: org, repositoryId: "home" } },
      grantedAuthority: { network: "none", secrets: [], dependencies: "none" }, provider: { id: "oci" } });
    await writeFile(join(code, "main.py"), "print('changed')");
    const changed = await inspect(); expect(changed.contentHash).not.toBe(original.contentHash); expect(changed.trust).toBe("untrusted");
    expect((await client.callTool({ name: "execute_skill", arguments: { ...base, entrypoint: "main" } })).isError).toBe(true);
    expect((await request("approve", approval)).status).toBe(400);
    expect((await request("approve", { ...approval, contentHash: changed.contentHash })).status).toBe(200);
    expect((await client.callTool({ name: "execute_skill", arguments: { ...base, entrypoint: "main", expectedContentHash: original.contentHash } })).isError).toBe(true);
    await expect(runtime.execute(repo, { skillId: "example", entrypoint: "main" }, { organizationId: org, repositoryId: "another" })).rejects.toThrow(/repository and organization/);
    expect((await request("revoke-approval", { ...base, password })).status).toBe(200);
    expect((await client.callTool({ name: "execute_skill", arguments: { ...base, entrypoint: "main" } })).isError).toBe(true);
    for (const privileged of [{ network: { mode: "allowlist", domains: ["example.test"] } }, { secrets: [{ name: "NITELY_SKILL_SECRET_TEST", scope: "skill", reference: "connection-id" }] },
      { dependencies: { mode: "locked", lockFile: "requirements.txt", sha256: "a".repeat(64), installHooks: false } }]) {
      await writeFile(join(code, "skill.yaml"), JSON.stringify({ ...manifest, ...privileged }));
      const identity = await inspect();
      expect((await request("approve", { ...approval, contentHash: identity.contentHash })).status).toBe(400);
      expect((await client.callTool({ name: "execute_skill", arguments: { ...base, entrypoint: "main" } })).isError).toBe(true);
    }
    expect(executions).toBe(1);
    const audit = await queryOrganizationAudit(repo, { organizationId: org, limit: 100 });
    expect(audit.events.map((event) => event.action)).toEqual(expect.arrayContaining(["skills.approved", "skills.approval.revoked", "skills.execution.denied", "skills.execution.finished"]));
    const archives = await readdir(join(repo, ".nitely/skill-executions"));
    const records = await Promise.all(archives.filter((id) => id !== "execution.lock").map(async (id) => JSON.parse(await readFile(join(repo, ".nitely/skill-executions", id, "execution.json"), "utf8"))));
    expect(records.filter((record) => record.outcome === "denied").every((record) => record.grantedAuthority === null && record.provider === null)).toBe(true);
    expect(records.map((record) => record.reasonCode)).toEqual(expect.arrayContaining(["approval-required", "identity-changed", "approval-revoked", "manifest-policy"]));
    expect(JSON.stringify({ records, audit })).not.toContain(password); expect(JSON.stringify({ records, audit })).not.toContain(token.token);
  } finally { await client.close(); await mcp.close(); await web.close(); await rm(repo, { recursive: true, force: true }); }
});
