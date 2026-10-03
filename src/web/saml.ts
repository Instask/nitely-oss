import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SAML, ValidateInResponseTo, type CacheProvider } from "@node-saml/node-saml";
import { DOMParser } from "@xmldom/xmldom";
import { withKnowledgeLease } from "../knowledge-repositories/lock.js";
import { listOrganizationMembers, listPublicMemberships, writeJsonAtomic, type OrganizationActor } from "./organizations.js";
import { readSessionUser, resolveOrganizationEnterpriseIdentity } from "./users.js";
import { WebForbiddenError, WebInputError, WebNotFoundError } from "./errors.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const root = (repo: string, org: string) => join(resolve(repo), ".nitely/users/saml", hash(org));
const md = "urn:oasis:names:tc:SAML:2.0:metadata";
const assertionNs = "urn:oasis:names:tc:SAML:2.0:assertion";
const protocolNs = "urn:oasis:names:tc:SAML:2.0:protocol";
const ds = "http://www.w3.org/2000/09/xmldsig#";
const persistentNameId = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";

export interface OrganizationSamlConfiguration {
  version: 1; idpIssuer: string; entryPoint: string; certificates: string[];
  entityId: string; acsUrl: string; emailAttribute: string;
  jit: { enabled: boolean; domains: string[] };
}
interface Grant {
  requestId: string; requestTime: string; browserHash: string; configurationHash: string; expiresAt: number;
  linkUserId?: string; linkSessionId?: string;
}
function parseXml(xml: string) {
  if (Buffer.byteLength(xml) > 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("invalid SAML XML");
  return new DOMParser({ onError: () => { throw new Error("invalid SAML XML"); } }).parseFromString(xml, "application/xml");
}
async function requireOwner(repo: string, org: string, actor: OrganizationActor) {
  if ((await listOrganizationMembers(repo, org, actor)).find((member) => member.userId === actor.id)?.role !== "owner") throw new WebForbiddenError();
}
function approvedEndpoint(value: string, env: NodeJS.ProcessEnv): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port && url.port !== "443" || !(env.NITELY_SAML_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).includes(url.hostname.toLowerCase())) throw new Error();
  return url.href;
}
export async function configureOrganizationSaml(repo: string, org: string, actor: OrganizationActor, value: Record<string, unknown>, env: NodeJS.ProcessEnv) {
  await requireOwner(repo, org, actor);
  let configuration: OrganizationSamlConfiguration;
  try {
    if (Object.keys(value).some((key) => !["version", "idpIssuer", "entryPoint", "certificates", "entityId", "acsUrl", "emailAttribute", "jit", "metadataXml"].includes(key)) || value.version !== undefined && value.version !== 1) throw new Error();
    if (value.metadataXml !== undefined) {
      if (typeof value.metadataXml !== "string" || ["idpIssuer", "entryPoint", "certificates"].some((key) => value[key] !== undefined)) throw new Error();
      const document = parseXml(value.metadataXml); const entity = document.documentElement;
      if (!entity || entity.namespaceURI !== md || entity.localName !== "EntityDescriptor" || entity.hasAttribute("validUntil") && (!Number.isFinite(Date.parse(entity.getAttribute("validUntil")!)) || Date.parse(entity.getAttribute("validUntil")!) <= Date.now())) throw new Error();
      const idps = entity.getElementsByTagNameNS(md, "IDPSSODescriptor"); if (idps.length !== 1 || !idps[0].getAttribute("protocolSupportEnumeration")?.split(/\s+/).includes(protocolNs)) throw new Error();
      const services = Array.from(idps[0].getElementsByTagNameNS(md, "SingleSignOnService")).filter((service) => service.getAttribute("Binding") === "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect");
      if (services.length !== 1) throw new Error();
      const certificates = Array.from(idps[0].getElementsByTagNameNS(md, "KeyDescriptor")).filter((key) => !key.hasAttribute("use") || key.getAttribute("use") === "signing").flatMap((key) => Array.from(key.getElementsByTagNameNS(ds, "X509Certificate")).map((cert) => `-----BEGIN CERTIFICATE-----\n${cert.textContent!.replace(/\s+/g, "")}\n-----END CERTIFICATE-----`));
      value = { ...value, idpIssuer: entity.getAttribute("entityID"), entryPoint: services[0].getAttribute("Location"), certificates };
    }
    if (typeof value.idpIssuer !== "string" || !value.idpIssuer || value.idpIssuer.length > 2048 || typeof value.entryPoint !== "string" || value.entryPoint.length > 2048 || typeof value.entityId !== "string" || !value.entityId || value.entityId.length > 2048 || typeof value.acsUrl !== "string" || value.acsUrl.length > 2048) throw new Error();
    if (![value.idpIssuer, value.entityId].every((id) => /^[a-z][a-z0-9+.-]*:[^\s<>]+$/i.test(id))) throw new Error();
    const entryPoint = approvedEndpoint(value.entryPoint, env); const acs = new URL(value.acsUrl);
    if (acs.protocol !== "https:" || !(env.NITELY_SAML_REDIRECT_ORIGINS ?? "").split(",").map((origin) => origin.trim()).includes(acs.origin) || acs.username || acs.password || acs.search || acs.hash || acs.pathname !== `/api/organizations/${encodeURIComponent(org)}/sso/saml/acs`) throw new Error();
    if (!Array.isArray(value.certificates) || !value.certificates.length || value.certificates.length > 3) throw new Error();
    const certificates = value.certificates.map((pem) => {
      if (typeof pem !== "string" || pem.length > 16_384 || !pem.startsWith("-----BEGIN CERTIFICATE-----")) throw new Error();
      const certificate = new X509Certificate(pem);
      if (certificate.publicKey.asymmetricKeyType !== "rsa" || (certificate.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 || Date.parse(certificate.validTo) <= Date.now()) throw new Error();
      return certificate.toString();
    });
    const emailAttribute = value.emailAttribute ?? "email";
    if (typeof emailAttribute !== "string" || !emailAttribute || emailAttribute.length > 256) throw new Error();
    const jit = value.jit as { enabled?: unknown; domains?: unknown } | undefined;
    if (jit && (typeof jit !== "object" || Array.isArray(jit) || Object.keys(jit).some((key) => !["enabled", "domains"].includes(key)) || typeof jit.enabled !== "boolean" || !Array.isArray(jit.domains) || jit.domains.length > 100 || jit.domains.some((domain) => typeof domain !== "string" || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(domain)))) throw new Error();
    if (jit?.enabled && !(jit.domains as string[]).length) throw new Error();
    configuration = { version: 1, idpIssuer: value.idpIssuer, entityId: value.entityId, entryPoint, acsUrl: acs.href, certificates, emailAttribute, jit: jit ? { enabled: jit.enabled as boolean, domains: jit.domains as string[] } : { enabled: false, domains: [] } };
  } catch { throw new WebInputError("invalid organization SAML configuration or operator allowlist"); }
  return await withKnowledgeLease({ path: root(repo, org) + ".lock", waitMs: 10_000 }, async () => { await requireOwner(repo, org, actor); await writeJsonAtomic(join(root(repo, org), "configuration.json"), configuration); return configuration; });
}
async function readConfiguration(repo: string, org: string): Promise<OrganizationSamlConfiguration> {
  try { return JSON.parse(await readFile(join(root(repo, org), "configuration.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WebNotFoundError("SAML is not configured"); throw error; }
}
export async function getOrganizationSaml(repo: string, org: string, actor: OrganizationActor) { await requireOwner(repo, org, actor); return await readConfiguration(repo, org); }
function adapter(configuration: OrganizationSamlConfiguration, grant: Grant) {
  const cacheProvider: CacheProvider = {
    saveAsync: async (key, value) => { grant.requestId = key; grant.requestTime = value; return { value, createdAt: Date.now() }; },
    getAsync: async (key) => key === grant.requestId ? grant.requestTime : null,
    removeAsync: async () => null, // Persistent single-use RelayState is consumed before validation.
  };
  const certificates = configuration.certificates.filter((pem) => { const certificate = new X509Certificate(pem); return Date.parse(certificate.validFrom) <= Date.now() && Date.parse(certificate.validTo) > Date.now(); });
  if (!certificates.length) throw new Error("no valid SAML signing certificate");
  return new SAML({ issuer: configuration.entityId, audience: configuration.entityId, callbackUrl: configuration.acsUrl, entryPoint: configuration.entryPoint, idpIssuer: configuration.idpIssuer, idpCert: certificates,
    wantAuthnResponseSigned: true, wantAssertionsSigned: true, validateInResponseTo: ValidateInResponseTo.always, requestIdExpirationPeriodMs: 600_000, maxAssertionAgeMs: 300_000, acceptedClockSkewMs: 30_000, identifierFormat: persistentNameId, signatureAlgorithm: "sha256", digestAlgorithm: "sha256", cacheProvider });
}
export async function organizationSamlMetadata(repo: string, org: string) { return adapter(await readConfiguration(repo, org), {} as Grant).generateServiceProviderMetadata(null); }
export async function startOrganizationSaml(repo: string, org: string, env: NodeJS.ProcessEnv, link?: { userId: string; sessionId: string }) {
  const configuration = await readConfiguration(repo, org); approvedEndpoint(configuration.entryPoint, env);
  if (link && !(await listPublicMemberships(repo, link.userId)).some((member) => member.organizationId === org)) throw new WebNotFoundError("organization not found");
  const state = randomBytes(32).toString("base64url"); const browserToken = randomBytes(32).toString("base64url");
  const grant: Grant = { requestId: "", requestTime: "", browserHash: hash(browserToken), configurationHash: hash(JSON.stringify(configuration)), expiresAt: Date.now() + 600_000, ...(link ? { linkUserId: link.userId, linkSessionId: link.sessionId } : {}) };
  const url = await adapter(configuration, grant).getAuthorizeUrlAsync(state, undefined, {});
  await withKnowledgeLease({ path: root(repo, org) + ".lock", waitMs: 10_000 }, async () => {
    await mkdir(root(repo, org), { recursive: true, mode: 0o700 }); let active = 0;
    for (const name of await readdir(root(repo, org))) { if (!/^grant-[A-Za-z0-9_-]{43}\.json$/.test(name)) continue; const path = join(root(repo, org), name); const saved = JSON.parse(await readFile(path, "utf8")) as Grant; if (saved.expiresAt <= Date.now()) await unlink(path); else active++; }
    // ponytail: 256 attempts per org; put distributed ingress limits in hosted deployments.
    if (active >= 256) throw new WebInputError("too many pending SAML login attempts");
    await writeJsonAtomic(join(root(repo, org), `grant-${state}.json`), grant);
  });
  return { url, browserToken };
}
export async function finishOrganizationSaml(repo: string, org: string, params: URLSearchParams, browserToken?: string) {
  try {
    const state = params.get("RelayState"); const encoded = params.get("SAMLResponse");
    if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !browserToken || browserToken.length !== 43 || !encoded || encoded.length > 1_400_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error();
    const grant = await withKnowledgeLease({ path: root(repo, org) + ".lock", waitMs: 10_000 }, async () => { const path = join(root(repo, org), `grant-${state}.json`); const saved = JSON.parse(await readFile(path, "utf8")) as Grant; if (saved.browserHash !== hash(browserToken)) throw new Error(); await unlink(path); if (saved.expiresAt <= Date.now()) throw new Error(); return saved; });
    const configuration = await readConfiguration(repo, org); if (hash(JSON.stringify(configuration)) !== grant.configurationHash) throw new Error();
    const xml = Buffer.from(encoded, "base64").toString("utf8"); const document = parseXml(xml); const response = document.documentElement;
    if (!response || response.namespaceURI !== protocolNs || response.localName !== "Response" || response.getAttribute("Version") !== "2.0" || response.getAttribute("Destination") !== configuration.acsUrl || response.getAttribute("InResponseTo") !== grant.requestId) throw new Error();
    const issuers = response.getElementsByTagNameNS(assertionNs, "Issuer"); if (issuers.length !== 2 || Array.from(issuers).some((issuer) => issuer.textContent !== configuration.idpIssuer)) throw new Error();
    const assertions = response.getElementsByTagNameNS(assertionNs, "Assertion"); if (assertions.length !== 1 || assertions[0].parentNode !== response || assertions[0].getAttribute("Version") !== "2.0") throw new Error();
    const conditions = assertions[0].getElementsByTagNameNS(assertionNs, "Conditions"); if (conditions.length !== 1 || !conditions[0].hasAttribute("NotBefore") || !conditions[0].hasAttribute("NotOnOrAfter")) throw new Error();
    const confirmation = assertions[0].getElementsByTagNameNS(assertionNs, "SubjectConfirmationData"); if (confirmation.length !== 1 || confirmation[0].getAttribute("Recipient") !== configuration.acsUrl || confirmation[0].getAttribute("InResponseTo") !== grant.requestId || !confirmation[0].hasAttribute("NotOnOrAfter")) throw new Error();
    const now = Date.now();
    for (const node of [response, assertions[0]]) { const issued = Date.parse(node.getAttribute("IssueInstant") ?? ""); if (!Number.isFinite(issued) || issued > now + 30_000 || issued < now - 330_000) throw new Error(); }
    for (const element of [response, assertions[0]]) if (!/^[_A-Za-z][A-Za-z0-9_.-]{0,255}$/.test(element.getAttribute("ID") ?? "")) throw new Error();
    if (confirmation[0].hasAttribute("NotBefore")) { const before = Date.parse(confirmation[0].getAttribute("NotBefore")!); if (!Number.isFinite(before) || before > now + 30_000) throw new Error(); }
    const before = Date.parse(conditions[0].getAttribute("NotBefore")!); const after = Date.parse(conditions[0].getAttribute("NotOnOrAfter")!); const confirmationAfter = Date.parse(confirmation[0].getAttribute("NotOnOrAfter")!);
    if (!Number.isFinite(before) || !Number.isFinite(after) || !Number.isFinite(confirmationAfter) || before >= after || before > now + 30_000 || after <= now - 30_000 || confirmationAfter <= now - 30_000 || confirmation[0].parentNode?.nodeType !== 1 || (confirmation[0].parentNode as import("@xmldom/xmldom").Element).getAttribute("Method") !== "urn:oasis:names:tc:SAML:2.0:cm:bearer") throw new Error();
    const statuses = response.getElementsByTagNameNS(protocolNs, "StatusCode"); if (statuses.length !== 1 || statuses[0].getAttribute("Value") !== "urn:oasis:names:tc:SAML:2.0:status:Success") throw new Error();
    for (const node of Array.from(document.getElementsByTagNameNS(ds, "SignatureMethod"))) if (!["http://www.w3.org/2001/04/xmldsig-more#rsa-sha256", "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512"].includes(node.getAttribute("Algorithm")!)) throw new Error();
    for (const node of Array.from(document.getElementsByTagNameNS(ds, "DigestMethod"))) if (!["http://www.w3.org/2001/04/xmlenc#sha256", "http://www.w3.org/2001/04/xmlenc#sha512"].includes(node.getAttribute("Algorithm")!)) throw new Error();
    const { profile, loggedOut } = await adapter(configuration, grant).validatePostResponseAsync({ SAMLResponse: encoded });
    if (!profile || loggedOut || profile.issuer !== configuration.idpIssuer || profile.nameIDFormat !== persistentNameId || !profile.nameID || profile.nameID.length > 512) throw new Error();
    const emailValue = profile[configuration.emailAttribute]; const email = typeof emailValue === "string" ? emailValue.trim().toLowerCase() : undefined;
    const allowCreate = configuration.jit.enabled && Boolean(email && email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) && configuration.jit.domains.includes(email.split("@")[1]));
    return await withKnowledgeLease({ path: root(repo, org) + ".lock", waitMs: 10_000 }, async () => {
      if (hash(JSON.stringify(await readConfiguration(repo, org))) !== grant.configurationHash) throw new Error();
      if (grant.linkUserId && (!grant.linkSessionId || (await readSessionUser(repo, grant.linkSessionId, { organizationId: org, touch: false }))?.id !== grant.linkUserId)) throw new Error();
      return await resolveOrganizationEnterpriseIdentity(repo, org, { issuer: profile.issuer, subject: profile.nameID, protocol: "saml", email, allowCreate, linkUserId: grant.linkUserId });
    });
  } catch { throw new WebForbiddenError("SAML login failed"); }
}
