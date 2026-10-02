import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { DOMParser } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
import { afterEach, expect, it } from "vitest";
import { configureOrganizationSaml, startOrganizationSaml, finishOrganizationSaml, organizationSamlMetadata } from "../../src/web/saml.js";
import { createUser, createSession, readSessionUser, resolveEnterpriseUser } from "../../src/web/users.js";
import { listPublicMemberships, addOrganizationMember, updateOrganizationSecurityPolicy, changeOrganizationMember } from "../../src/web/organizations.js";
import { startWebServer } from "../../src/web/server.js";
import { queryOrganizationAudit } from "../../src/web/security-audit.js";

const repos: string[] = [];
afterEach(async () => { await Promise.all(repos.splice(0).map((repo) => rm(repo, { recursive: true, force: true }))); });
const c14n = "http://www.w3.org/2001/10/xml-exc-c14n#";
const rsaSha256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), "nitely-saml-")); repos.push(repo);
  const certificates: Array<{ key: string; cert: string }> = [];
  for (const index of [0, 1]) {
    const key = join(repo, `key-${index}.pem`); const cert = join(repo, `cert-${index}.pem`);
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=nitely-test-idp"], { stdio: "ignore" });
    certificates.push({ key: await readFile(key, "utf8"), cert: await readFile(cert, "utf8") });
  }
  const owner = await createUser(repo, { email: "owner@example.test", password: "owner-password-passphrase", role: "admin" });
  const org = (await listPublicMemberships(repo, owner.id))[0].organizationId;
  const env = { NITELY_SAML_ALLOWED_HOSTS: "idp.example.test", NITELY_SAML_REDIRECT_ORIGINS: "https://nitely.example.test" };
  const configuration = { idpIssuer: "https://idp.example.test/entity", entryPoint: "https://idp.example.test/login", entityId: "https://nitely.example.test/sp", acsUrl: `https://nitely.example.test/api/organizations/${org}/sso/saml/acs`, certificates: [certificates[0].cert], jit: { enabled: true, domains: ["example.test"] } };
  await configureOrganizationSaml(repo, org, owner, configuration, env);
  const requestId = (url: string) => new DOMParser().parseFromString(inflateRawSync(Buffer.from(new URL(url).searchParams.get("SAMLRequest")!, "base64")).toString(), "application/xml").documentElement!.getAttribute("ID")!;
  const sign = (xml: string, element: string, keyIndex: number) => {
    const signed = new SignedXml({ privateKey: certificates[keyIndex].key, publicCert: certificates[keyIndex].cert, signatureAlgorithm: rsaSha256, canonicalizationAlgorithm: c14n });
    signed.addReference({ xpath: `/*[local-name()='${element}']`, digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256", transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", c14n] });
    signed.computeSignature(xml, { location: { reference: `/*[local-name()='${element}']/*[local-name()='Issuer']`, action: "after" } }); return signed.getSignedXml();
  };
  const response = (id: string, options: { issuer?: string; audience?: string; destination?: string; recipient?: string; subjectResponse?: string; date?: Date; signed?: boolean; keyIndex?: number; subject?: string; email?: string; conditions?: string } = {}) => {
    const date = options.date ?? new Date(); const before = new Date(date.getTime() - 1000).toISOString(); const after = new Date(date.getTime() + 120_000).toISOString(); const issuer = options.issuer ?? configuration.idpIssuer;
    const assertion = `<Assertion xmlns="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${randomUUID()}" Version="2.0" IssueInstant="${date.toISOString()}"><Issuer>${issuer}</Issuer><Subject><NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${options.subject ?? "immutable-person-1"}</NameID><SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><SubjectConfirmationData InResponseTo="${options.subjectResponse ?? id}" Recipient="${options.recipient ?? configuration.acsUrl}" NotOnOrAfter="${after}"/></SubjectConfirmation></Subject><Conditions NotBefore="${before}" NotOnOrAfter="${options.conditions ?? after}"><AudienceRestriction><Audience>${options.audience ?? configuration.entityId}</Audience></AudienceRestriction></Conditions><AuthnStatement AuthnInstant="${date.toISOString()}"/><AttributeStatement><Attribute Name="email"><AttributeValue>${options.email ?? "person@example.test"}</AttributeValue></Attribute></AttributeStatement></Assertion>`;
    const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${randomUUID()}" Version="2.0" IssueInstant="${date.toISOString()}" InResponseTo="${id}" Destination="${options.destination ?? configuration.acsUrl}"><saml:Issuer>${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${options.signed === false ? assertion : sign(assertion, "Assertion", options.keyIndex ?? 0)}</samlp:Response>`;
    return Buffer.from(options.signed === false ? xml : sign(xml, "Response", options.keyIndex ?? 0)).toString("base64");
  };
  const params = (started: { url: string }, options?: Parameters<typeof response>[1]) => new URLSearchParams({ RelayState: new URL(started.url).searchParams.get("RelayState")!, SAMLResponse: response(requestId(started.url), options) });
  return { repo, owner, org, env, configuration, certificates, requestId, response, params };
}

it("verifies real signed assertions, prevents replay, supports overlapping certificates and shares SSO session/membership policy", async () => {
  const f = await fixture();
  expect(await organizationSamlMetadata(f.repo, f.org)).toContain(f.configuration.acsUrl);
  const started = await startOrganizationSaml(f.repo, f.org, f.env);
  const params = f.params(started);
  const resolved = await finishOrganizationSaml(f.repo, f.org, params, started.browserToken);
  expect(resolved.created).toBe(true);
  const otherOwner = await createUser(f.repo, { email: "tenant-owner@example.test", password: "tenant-password-passphrase", role: "admin" });
  const otherOrg = (await listPublicMemberships(f.repo, otherOwner.id))[0].organizationId;
  await addOrganizationMember(f.repo, otherOrg, { userId: resolved.userId, role: "member" });
  const otherAcs = `https://nitely.example.test/api/organizations/${otherOrg}/sso/saml/acs`;
  await configureOrganizationSaml(f.repo, otherOrg, otherOwner, { ...f.configuration, acsUrl: otherAcs, certificates: [f.certificates[1].cert] }, f.env);
  const tenantAttempt = await startOrganizationSaml(f.repo, otherOrg, f.env);
  // The same issuer/subject signed by another tenant's independently pinned key cannot select this account.
  await expect(finishOrganizationSaml(f.repo, otherOrg, f.params(tenantAttempt, { keyIndex: 1, destination: otherAcs, recipient: otherAcs }), tenantAttempt.browserToken)).rejects.toThrow("SAML login failed");
  await expect(finishOrganizationSaml(f.repo, f.org, params, started.browserToken)).rejects.toThrow("SAML login failed");
  await updateOrganizationSecurityPolicy(f.repo, f.org, f.owner, { version: 1, maxSessionLifetimeSeconds: 3600, idleTimeoutSeconds: null, ssoRequired: true });
  const session = await createSession(f.repo, resolved.userId, { authenticationMethod: "saml", organizationId: f.org });
  expect((await readSessionUser(f.repo, session.id, { organizationId: f.org }))?.id).toBe(resolved.userId);
  const password = await createSession(f.repo, resolved.userId);
  expect(await readSessionUser(f.repo, password.id, { organizationId: f.org })).toBeNull();
  await configureOrganizationSaml(f.repo, f.org, f.owner, { ...f.configuration, certificates: f.certificates.map((pair) => pair.cert) }, f.env);
  for (const keyIndex of [0, 1]) {
    const attempt = await startOrganizationSaml(f.repo, f.org, f.env);
    expect((await finishOrganizationSaml(f.repo, f.org, f.params(attempt, { keyIndex }), attempt.browserToken)).userId).toBe(resolved.userId);
  }
  await changeOrganizationMember(f.repo, f.org, f.owner, resolved.userId);
  expect(await readSessionUser(f.repo, session.id, { organizationId: f.org })).toBeNull();
});

it.each([
  { signed: false }, { date: new Date("2020-01-01T00:00:00Z") }, { audience: "wrong-audience" }, { destination: "https://evil.example.test/acs" }, { recipient: "https://evil.example.test/recipient" }, { issuer: "wrong-issuer" }, { subjectResponse: "unknown-request" }, { keyIndex: 1 }, { conditions: "invalid-time" },
])("rejects invalid signed/unsigned SAML inputs: %j", async (options) => {
  const f = await fixture(); const started = await startOrganizationSaml(f.repo, f.org, f.env);
  await expect(finishOrganizationSaml(f.repo, f.org, f.params(started, options), started.browserToken)).rejects.toThrow("SAML login failed");
});

it("requires browser binding, configuration continuity and explicit linking without email or protocol collisions", async () => {
  const f = await fixture(); const started = await startOrganizationSaml(f.repo, f.org, f.env);
  await expect(finishOrganizationSaml(f.repo, f.org, f.params(started), "x".repeat(43))).rejects.toThrow();
  const own = await finishOrganizationSaml(f.repo, f.org, f.params(started), started.browserToken);
  await expect(resolveEnterpriseUser(f.repo, { issuer: f.configuration.idpIssuer, subject: "immutable-person-1", email: "person@example.test", allowCreate: true })).rejects.toThrow("explicit account linking");
  const altered = await startOrganizationSaml(f.repo, f.org, f.env);
  await configureOrganizationSaml(f.repo, f.org, f.owner, { ...f.configuration, entityId: "https://changed.example.test/sp" }, f.env);
  await expect(finishOrganizationSaml(f.repo, f.org, f.params(altered), altered.browserToken)).rejects.toThrow();
  await configureOrganizationSaml(f.repo, f.org, f.owner, f.configuration, f.env);
  const account = await createUser(f.repo, { email: "linked@example.test", password: "linked-password-passphrase", role: "user" });
  await addOrganizationMember(f.repo, f.org, { userId: account.id, role: "member" });
  const automatic = await startOrganizationSaml(f.repo, f.org, f.env);
  await expect(finishOrganizationSaml(f.repo, f.org, f.params(automatic, { subject: "another-persistent-person", email: account.email }), automatic.browserToken)).rejects.toThrow("SAML login failed");
  const linkSession = await createSession(f.repo, account.id);
  const linking = await startOrganizationSaml(f.repo, f.org, f.env, { userId: account.id, sessionId: linkSession.id });
  expect((await finishOrganizationSaml(f.repo, f.org, f.params(linking, { subject: "another-persistent-person", email: account.email }), linking.browserToken)).userId).toBe(account.id);
  expect(own.userId).not.toBe(account.id);
});

it("serves SP metadata and handles real browser ACS POST with shared session projection and metadata-only audit", async () => {
  const f = await fixture(); const ownerSession = await createSession(f.repo, f.owner.id);
  const server = await startWebServer({ repoPath: f.repo, host: "127.0.0.1", port: 0, authMode: "required", authEnv: f.env, providerEnv: {}, providerCommandStatus: async () => false });
  const root = `/api/organizations/${f.org}/sso/saml`;
  try {
    expect((await fetch(server.url + root + "/metadata")).status).toBe(200);
    expect((await fetch(server.url + root, { headers: { cookie: "nitely_session=" + ownerSession.id } })).status).toBe(200);
    const login = await fetch(server.url + root + "/login", { redirect: "manual" });
    expect(login.status).toBe(302); expect(login.headers.get("set-cookie")).toContain("SameSite=None; Secure");
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const params = f.params({ url: login.headers.get("location")! });
    const callback = await fetch(server.url + root + "/acs", { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded", accept: "text/html" }, body: params.toString() });
    expect(callback.status).toBe(303); expect(callback.headers.get("location")).toBe("/");
    const user = (await callback.json()).user; expect(user.currentOrganizationId).toBe(f.org);
    const sid = callback.headers.get("set-cookie")!.split(";")[0].split("=")[1];
    expect((await readSessionUser(f.repo, sid, { organizationId: f.org }))?.id).toBe(user.id);
    const linkHeaders = { cookie: "nitely_session=" + ownerSession.id, "content-type": "application/json" };
    expect((await fetch(server.url + root + "/link", { method: "POST", headers: linkHeaders, body: JSON.stringify({ password: "wrong" }), redirect: "manual" })).status).toBe(403);
    const linking = await fetch(server.url + root + "/link", { method: "POST", headers: linkHeaders, body: JSON.stringify({ password: "owner-password-passphrase" }), redirect: "manual" });
    expect(linking.status).toBe(302);
    const linked = await fetch(server.url + root + "/acs", { method: "POST", headers: { cookie: linking.headers.get("set-cookie")!.split(";")[0], "content-type": "application/x-www-form-urlencoded" }, body: f.params({ url: linking.headers.get("location")! }, { subject: "owner-persistent", email: f.owner.email }).toString() });
    expect(linked.status).toBe(200); expect((await linked.json()).user.id).toBe(f.owner.id);
    const audit = await queryOrganizationAudit(f.repo, { organizationId: f.org, action: "auth.saml.login" });
    expect(audit.events).toHaveLength(1); expect(JSON.stringify(audit)).not.toContain("SAMLResponse");
    expect((await fetch(server.url + root + "/acs", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: params.toString() })).status).toBe(403);
  } finally { await server.close(); }
});


it("imports explicitly trusted IdP metadata, restricts configuration to organization owners and rejects unsafe XML/certificates/endpoints", async () => {
  const f = await fixture();
  const cert = f.certificates[1].cert.replace(/-----[^-]+-----|\s+/g, "");
  const metadataXml = `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${f.configuration.idpIssuer}"><IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${cert}</X509Certificate></X509Data></KeyInfo></KeyDescriptor><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${f.configuration.entryPoint}"/></IDPSSODescriptor></EntityDescriptor>`;
  const configured = await configureOrganizationSaml(f.repo, f.org, f.owner, { entityId: f.configuration.entityId, acsUrl: f.configuration.acsUrl, metadataXml, jit: f.configuration.jit }, f.env);
  expect(configured.certificates).toHaveLength(1);
  const started = await startOrganizationSaml(f.repo, f.org, f.env);
  expect((await finishOrganizationSaml(f.repo, f.org, f.params(started, { keyIndex: 1 }), started.browserToken)).created).toBe(true);
  const other = await createUser(f.repo, { email: "other-admin@example.test", password: "other-password-passphrase", role: "admin" });
  await expect(configureOrganizationSaml(f.repo, f.org, other, f.configuration, f.env)).rejects.toThrow();
  for (const unsafe of [ { ...f.configuration, entryPoint: "http://idp.example.test/login" }, { ...f.configuration, certificates: ["not-a-certificate"] }, { entityId: f.configuration.entityId, acsUrl: f.configuration.acsUrl, metadataXml: '<!DOCTYPE EntityDescriptor [<!ENTITY secret SYSTEM "file:///etc/passwd">]>' + metadataXml } ]) {
    await expect(configureOrganizationSaml(f.repo, f.org, f.owner, unsafe, f.env)).rejects.toThrow("invalid organization SAML");
  }
});
