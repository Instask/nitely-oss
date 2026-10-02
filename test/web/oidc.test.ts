import { execFileSync } from "node:child_process";
import { startWebServer } from "../../src/web/server.js";
import { listSecurityAuditEvents } from "../../src/web/security-audit.js";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureOrganizationOidc, startOrganizationOidc, finishOrganizationOidc } from "../../src/web/oidc.js";
import { createSession, createUser, getPublicUser, readSessionUser } from "../../src/web/users.js";
import { listPublicMemberships, addOrganizationMember, changeOrganizationMember } from "../../src/web/organizations.js";

const repos: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await Promise.all(repos.splice(0).map((repo) => rm(repo, { recursive: true, force: true }))); });
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const wrongKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });

async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), "nitely-oidc-")); repos.push(repo);
  const owner = await createUser(repo, { email: "owner@example.test", password: "owner-password-passphrase", role: "admin" });
  const org = (await listPublicMemberships(repo, owner.id))[0].organizationId;
  const env = { NITELY_OIDC_ALLOWED_HOSTS: "idp.example.test", NITELY_OIDC_REDIRECT_ORIGINS: "https://nitely.example.test" };
  const configuration = { issuer: "https://idp.example.test/realm", clientId: "nitely-client", redirectUri: `https://nitely.example.test/api/organizations/${org}/sso/oidc/callback`, jit: { enabled: true, domains: ["example.test"] } };
  await configureOrganizationOidc(repo, org, owner, configuration, env);
  let nonce = ""; let challenge = ""; let redirectUri = configuration.redirectUri; let expectedSecret: string | null = null;
  let overrides: Record<string, unknown> = {};
  let invalidSignature = false;
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: URL, options: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "127.0.0.1") return await realFetch(input, options);
    if (url.pathname.endsWith("openid-configuration")) return Response.json({ issuer: configuration.issuer, authorization_endpoint: "https://idp.example.test/authorize", token_endpoint: "https://idp.example.test/token", jwks_uri: "https://idp.example.test/jwks", response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"], code_challenge_methods_supported: ["S256"] });
    if (url.pathname === "/jwks") return Response.json({ keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256", use: "sig" }] });
    expect(url.pathname).toBe("/token");
    const body = new URLSearchParams(String(options.body));
    expect(body.get("client_secret")).toBe(expectedSecret);
    expect(body.get("redirect_uri")).toBe(redirectUri);
    expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(challenge);
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test" })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({ iss: configuration.issuer, sub: "stable-subject", aud: configuration.clientId, iat: now, exp: now + 300, nonce, email: "jit@example.test", email_verified: true, ...overrides })).toString("base64url");
    const content = header + "." + claims;
    const signature = sign("RSA-SHA256", Buffer.from(content), invalidSignature ? wrongKeys.privateKey : keys.privateKey).toString("base64url");
    return Response.json({ access_token: "not-persisted", token_type: "Bearer", id_token: content + "." + signature });
  });
  const observe = (url: URL) => { nonce = url.searchParams.get("nonce")!; challenge = url.searchParams.get("code_challenge")!; return new URLSearchParams({ state: url.searchParams.get("state")!, code: "authorization-code" }); };
  const start = async (link?: { userId: string; sessionId: string }) => {
    const result = await startOrganizationOidc(repo, org, env, link);
    return { result, query: observe(new URL(result.url)) };
  };
  return { repo, org, owner, env, configuration, start, observe, secret: (value: string) => { expectedSecret = value; }, redirect: (value: string) => { redirectUri = value; }, override: (value: Record<string, unknown>, signature = false) => { overrides = value; invalidSignature = signature; } };
}

it("validates signed OIDC claims, provisions within policy, and keeps issuer/subject identity after email changes", async () => {
  const f = await fixture();
  const first = await f.start();
  const result = await finishOrganizationOidc(f.repo, f.org, f.env, first.query, first.result.browserToken);
  expect(result.created).toBe(true);
  expect((await listPublicMemberships(f.repo, result.userId))).toContainEqual(expect.objectContaining({ organizationId: f.org, role: "member" }));
  expect(await readFile(join(f.repo, ".nitely/users/users.json"), "utf8")).not.toContain("not-persisted");
  await expect(finishOrganizationOidc(f.repo, f.org, f.env, first.query, first.result.browserToken)).rejects.toThrow("OIDC login failed");
  f.override({ email: "changed@another.test" });
  const second = await f.start();
  expect((await finishOrganizationOidc(f.repo, f.org, f.env, second.query, second.result.browserToken)).userId).toBe(result.userId);
  const session = await createSession(f.repo, result.userId, { authenticationMethod: "oidc", organizationId: f.org });
  expect(session.authenticationMethod).toBe("oidc");
  expect((await readSessionUser(f.repo, session.id))?.id).toBe(result.userId);
  await changeOrganizationMember(f.repo, f.org, f.owner, result.userId);
  expect(await readSessionUser(f.repo, session.id)).toBeNull();
});

it.each(["state", "browser", "nonce", "issuer", "audience", "signature", "expired-token", "unverified-email", "domain", "email-collision"])("fails closed for %s", async (failure) => {
  const f = await fixture();
  const start = await f.start();
  const overrides: Record<string, unknown> = failure === "nonce" ? { nonce: "wrong" } : failure === "issuer" ? { iss: "https://wrong.example.test/realm" } : failure === "audience" ? { aud: "another-client" } : failure === "expired-token" ? { exp: 1 } : failure === "unverified-email" ? { email_verified: false } : failure === "domain" ? { email: "jit@another.test" } : failure === "email-collision" ? { email: f.owner.email } : {};
  f.override(overrides, failure === "signature");
  if (failure === "state") start.query.set("state", "x".repeat(43));
  await expect(finishOrganizationOidc(f.repo, f.org, f.env, start.query, failure === "browser" ? "x".repeat(43) : start.result.browserToken)).rejects.toThrow("OIDC login failed");
  expect((await getPublicUser(f.repo, f.owner.id))?.email).toBe(f.owner.email);
});

it("links only an explicit session-bound account and prevents identity rebinding or cross-org admission", async () => {
  const f = await fixture();
  f.override({ email: f.owner.email });
  const wrong = await f.start({ userId: f.owner.id, sessionId: "session-a" });
  await expect(finishOrganizationOidc(f.repo, f.org, f.env, wrong.query, wrong.result.browserToken, { userId: f.owner.id, sessionId: "session-b" })).rejects.toThrow();
  const linked = await f.start({ userId: f.owner.id, sessionId: "session-a" });
  expect((await finishOrganizationOidc(f.repo, f.org, f.env, linked.query, linked.result.browserToken, { userId: f.owner.id, sessionId: "session-a" })).userId).toBe(f.owner.id);
  const other = await createUser(f.repo, { email: "other@example.test", password: "other-password-passphrase", role: "user" });
  await addOrganizationMember(f.repo, f.org, { userId: other.id, role: "member" });
  const rebind = await f.start({ userId: other.id, sessionId: "other-session" });
  await expect(finishOrganizationOidc(f.repo, f.org, f.env, rebind.query, rebind.result.browserToken, { userId: other.id, sessionId: "other-session" })).rejects.toThrow();
  await expect(configureOrganizationOidc(f.repo, f.org, other, f.configuration, f.env)).rejects.toThrow("forbidden");
  await expect(configureOrganizationOidc(f.repo, f.org, f.owner, { ...f.configuration, issuer: "https://unapproved.example.test" }, f.env)).rejects.toThrow("invalid organization OIDC");
});


it("runs browser login/link callbacks through the real Web API with reauthentication and metadata-only audit", async () => {
  const f = await fixture();
  execFileSync("git", ["init", "-q", f.repo]);
  const server = await startWebServer({ repoPath: f.repo, host: "127.0.0.1", port: 0, authMode: "required", authEnv: f.env, providerEnv: {} });
  try {
    const session = await createSession(f.repo, f.owner.id);
    const cookie = "nitely_session=" + session.id;
    const path = `/api/organizations/${f.org}/sso/oidc`;
    expect((await fetch(server.url + path, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(server.url + path + "/link", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ password: "wrong" }) })).status).toBe(403);
    const start = await fetch(server.url + path + "/link", { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ password: "owner-password-passphrase" }) });
    expect(start.status).toBe(302);
    const query = f.observe(new URL(start.headers.get("location")!));
    const binding = start.headers.get("set-cookie")!.split(";")[0];
    expect(start.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Lax; Secure");
    f.override({ email: f.owner.email });
    const callback = await fetch(server.url + path + "/callback?" + query, { headers: { cookie: cookie + "; " + binding } });
    expect(callback.status).toBe(200);
    expect(await callback.json()).toMatchObject({ user: { id: f.owner.id } });
    expect(callback.headers.get("set-cookie")).toContain("nitely_session=");
    const login = await fetch(server.url + path + "/login", { redirect: "manual" });
    const loginQuery = f.observe(new URL(login.headers.get("location")!));
    const browser = await fetch(server.url + path + "/callback?" + loginQuery, { redirect: "manual", headers: { accept: "text/html", cookie: login.headers.get("set-cookie")!.split(";")[0] } });
    expect(browser.status).toBe(303);
    expect(browser.headers.get("location")).toBe("/");
    const audit = await listSecurityAuditEvents(f.repo, { limit: 100 });
    expect(audit).toContainEqual(expect.objectContaining({ action: "auth.oidc.link", actor: { type: "user", id: f.owner.id, organizationId: f.org }, outcome: "success" }));
    expect(JSON.stringify(audit)).not.toContain("authorization-code");
    expect(JSON.stringify(audit)).not.toContain("not-persisted");
  } finally { await server.close(); }
});

it("rejects attempts after configuration changes and denies JIT when disabled", async () => {
  const f = await fixture();
  const stale = await f.start();
  await configureOrganizationOidc(f.repo, f.org, f.owner, { ...f.configuration, jit: { enabled: false, domains: [] } }, f.env);
  await expect(finishOrganizationOidc(f.repo, f.org, f.env, stale.query, stale.result.browserToken)).rejects.toThrow();
  const disabled = await f.start();
  await expect(finishOrganizationOidc(f.repo, f.org, f.env, disabled.query, disabled.result.browserToken)).rejects.toThrow();
});


it("expires login state and refuses an already linked identity outside its membership", async () => {
  const f = await fixture();
  const expired = await f.start();
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 601_000);
  await expect(finishOrganizationOidc(f.repo, f.org, f.env, expired.query, expired.result.browserToken)).rejects.toThrow();
  clock.mockRestore();
  const first = await f.start();
  await finishOrganizationOidc(f.repo, f.org, f.env, first.query, first.result.browserToken);
  const outsider = await createUser(f.repo, { email: "outsider@example.test", password: "outsider-password-passphrase", role: "admin" });
  const otherOrg = (await listPublicMemberships(f.repo, outsider.id))[0].organizationId;
  const redirectUri = `https://nitely.example.test/api/organizations/${otherOrg}/sso/oidc/callback`;
  await configureOrganizationOidc(f.repo, otherOrg, outsider, { ...f.configuration, redirectUri }, f.env);
  f.redirect(redirectUri);
  const otherStart = await startOrganizationOidc(f.repo, otherOrg, f.env);
  const query = f.observe(new URL(otherStart.url));
  await expect(finishOrganizationOidc(f.repo, otherOrg, f.env, query, otherStart.browserToken)).rejects.toThrow();
});


it("keeps client credentials behind an organization-bound operator reference", async () => {
  const f = await fixture();
  const key = "NITELY_OIDC_SECRET_" + createHash("sha256").update(f.org).digest("hex") + "_PRIMARY";
  const secret = "private-client-secret";
  const env = { ...f.env, [key]: secret };
  await expect(configureOrganizationOidc(f.repo, f.org, f.owner, { ...f.configuration, clientSecretRef: "PRIMARY" }, f.env)).rejects.toThrow();
  const configuration = await configureOrganizationOidc(f.repo, f.org, f.owner, { ...f.configuration, clientSecretRef: "PRIMARY" }, env);
  expect(JSON.stringify(configuration)).not.toContain(secret);
  f.secret(secret);
  const start = await startOrganizationOidc(f.repo, f.org, env);
  const query = f.observe(new URL(start.url));
  expect((await finishOrganizationOidc(f.repo, f.org, env, query, start.browserToken)).created).toBe(true);
  expect(await readFile(join(f.repo, ".nitely/users/oidc", createHash("sha256").update(f.org).digest("hex"), "configuration.json"), "utf8")).not.toContain(secret);
});
