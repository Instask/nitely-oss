import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as client from "openid-client";
import { withKnowledgeLease } from "../knowledge-repositories/lock.js";
import { WebForbiddenError, WebInputError, WebNotFoundError } from "./errors.js";
import { listOrganizationMembers, listPublicMemberships, type OrganizationActor, writeJsonAtomic as writePrivateJson } from "./organizations.js";
import { resolveOrganizationEnterpriseIdentity } from "./users.js";

export interface OrganizationOidcConfiguration {
  version: 1;
  issuer: string;
  clientId: string;
  clientSecretRef?: string;
  redirectUri: string;
  jit: { enabled: boolean; domains: string[] };
}

interface OidcGrant {
  state: string;
  nonce: string;
  verifier: string;
  browserHash: string;
  expiresAt: number;
  configurationHash: string;
  linkUserId?: string;
  linkSessionId?: string;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const root = (repo: string, org: string) => join(resolve(repo), ".nitely", "users", "oidc", hash(org));
const secretKey = (org: string, ref: string) => `NITELY_OIDC_SECRET_${hash(org)}_${ref}`;
const configurationPath = (repo: string, org: string) => join(root(repo, org), "configuration.json");

function allowedHosts(env: NodeJS.ProcessEnv) {
  return new Set((env.NITELY_OIDC_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
}

function allowedEndpoint(value: string, env: NodeJS.ProcessEnv): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443") || !allowedHosts(env).has(url.hostname.toLowerCase())) throw new WebInputError("OIDC endpoint requires HTTPS and an operator-approved host");
  return url;
}

async function requireOwner(repo: string, org: string, actor: OrganizationActor) {
  const members = await listOrganizationMembers(repo, org, actor);
  if (members.find((member) => member.userId === actor.id)?.role !== "owner") throw new WebForbiddenError();
}

export async function configureOrganizationOidc(repo: string, org: string, actor: OrganizationActor, value: Record<string, unknown>, env: NodeJS.ProcessEnv) {
  await requireOwner(repo, org, actor);
  let configuration: OrganizationOidcConfiguration;
  try {
    if (Object.keys(value).some((key) => !["version", "issuer", "clientId", "clientSecretRef", "redirectUri", "jit"].includes(key)) || value.version !== undefined && value.version !== 1) throw new Error();
    if (typeof value.issuer !== "string" || value.issuer.length > 2048 || typeof value.clientId !== "string" || !value.clientId || value.clientId.length > 512 || typeof value.redirectUri !== "string" || value.redirectUri.length > 2048) throw new Error();
    const issuer = allowedEndpoint(value.issuer, env);
    if (issuer.search) throw new Error();
    const redirect = new URL(value.redirectUri);
    const origins = (env.NITELY_OIDC_REDIRECT_ORIGINS ?? "").split(",").map((origin) => origin.trim());
    if (redirect.protocol !== "https:" || !origins.includes(redirect.origin) || redirect.username || redirect.password || redirect.search || redirect.hash || redirect.pathname !== `/api/organizations/${encodeURIComponent(org)}/sso/oidc/callback`) throw new Error();
    if (value.clientSecretRef !== undefined && (typeof value.clientSecretRef !== "string" || !/^[A-Z0-9_]{1,64}$/.test(value.clientSecretRef) || !env[secretKey(org, value.clientSecretRef)])) throw new Error();
    const jit = value.jit as { enabled?: unknown; domains?: unknown } | undefined;
    if (jit && (Object.keys(jit).some((key) => !["enabled", "domains"].includes(key)) || typeof jit.enabled !== "boolean" || !Array.isArray(jit.domains) || jit.domains.length > 100 || jit.domains.some((domain) => typeof domain !== "string" || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(domain)))) throw new Error();
    if (jit?.enabled && !(jit.domains as string[]).length) throw new Error();
    configuration = { version: 1, issuer: issuer.href, clientId: value.clientId, redirectUri: redirect.href,
      ...(value.clientSecretRef ? { clientSecretRef: value.clientSecretRef as string } : {}),
      jit: jit ? { enabled: jit.enabled as boolean, domains: jit.domains as string[] } : { enabled: false, domains: [] } };
  } catch { throw new WebInputError("invalid organization OIDC configuration or operator allowlist"); }
  return await withKnowledgeLease({ path: root(repo, org) + ".lock", waitMs: 10_000 }, async () => {
    await requireOwner(repo, org, actor);
    await mkdir(root(repo, org), { recursive: true, mode: 0o700 });
    await writePrivateJson(configurationPath(repo, org), configuration);
    return configuration;
  });
}

async function readConfiguration(repo: string, org: string): Promise<OrganizationOidcConfiguration> {
  try { return JSON.parse(await readFile(configurationPath(repo, org), "utf8")) as OrganizationOidcConfiguration; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WebNotFoundError("OIDC is not configured"); throw error; }
}

export async function getOrganizationOidc(repo: string, org: string, actor: OrganizationActor) {
  await requireOwner(repo, org, actor);
  return await readConfiguration(repo, org);
}

async function oidcClient(org: string, configuration: OrganizationOidcConfiguration, env: NodeJS.ProcessEnv) {
  const issuer = allowedEndpoint(configuration.issuer, env);
  const secret = configuration.clientSecretRef ? env[secretKey(org, configuration.clientSecretRef)] : undefined;
  if (configuration.clientSecretRef && !secret) throw new WebForbiddenError("OIDC secret reference is unavailable");
  const restrictedFetch: NonNullable<client.DiscoveryRequestOptions[typeof client.customFetch]> = async (input, options) => {
    const url = allowedEndpoint(String(input), env);
    const response = await fetch(url, { ...options, body: options.body instanceof Uint8Array ? Uint8Array.from(options.body) : options.body, redirect: "error", signal: AbortSignal.timeout(10_000) });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > 1024 * 1024) throw new Error("OIDC response is too large");
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); }
    return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
  };
  const discovered = await client.discovery(issuer, configuration.clientId, undefined,
    secret ? client.ClientSecretPost(secret) : client.None(),
    { [client.customFetch]: restrictedFetch, execute: [client.enableNonRepudiationChecks] });
  for (const endpoint of [discovered.serverMetadata().authorization_endpoint, discovered.serverMetadata().token_endpoint, discovered.serverMetadata().jwks_uri]) {
    if (!endpoint) throw new WebForbiddenError("OIDC discovery is incomplete");
    allowedEndpoint(endpoint, env);
  }
  return discovered;
}

export async function startOrganizationOidc(repo: string, org: string, env: NodeJS.ProcessEnv, link?: { userId: string; sessionId: string }) {
  const configuration = await readConfiguration(repo, org);
  if (link && !(await listPublicMemberships(repo, link.userId)).some((member) => member.organizationId === org)) throw new WebNotFoundError("organization not found");
  const discovered = await oidcClient(org, configuration, env);
  const state = client.randomState();
  const nonce = client.randomNonce();
  const verifier = client.randomPKCECodeVerifier();
  const browserToken = randomBytes(32).toString("base64url");
  const grant: OidcGrant = { state, nonce, verifier, browserHash: hash(browserToken), expiresAt: Date.now() + 600_000,
    configurationHash: hash(JSON.stringify(configuration)), ...(link ? { linkUserId: link.userId, linkSessionId: link.sessionId } : {}) };
  const url = client.buildAuthorizationUrl(discovered, { scope: "openid email", redirect_uri: configuration.redirectUri,
    state, nonce, code_challenge_method: "S256", code_challenge: await client.calculatePKCECodeChallenge(verifier) });
  await withKnowledgeLease({ path: root(repo, org) + ".lock", waitMs: 10_000 }, async () => {
    let active = 0;
    for (const name of await readdir(root(repo, org))) {
      if (!/^grant-[A-Za-z0-9_-]+\.json$/.test(name)) continue;
      const path = join(root(repo, org), name);
      const saved = JSON.parse(await readFile(path, "utf8")) as OidcGrant;
      if (saved.expiresAt <= Date.now()) await unlink(path); else active++;
    }
    // ponytail: 256 active attempts per org; distributed rate limits belong in a hosted ingress.
    if (active >= 256) throw new WebInputError("too many pending OIDC login attempts");
    await writePrivateJson(join(root(repo, org), `grant-${state}.json`), grant);
  });
  return { url: url.href, browserToken };
}

export async function finishOrganizationOidc(repo: string, org: string, env: NodeJS.ProcessEnv, query: URLSearchParams, browserToken?: string, linkSession?: { userId: string; sessionId: string }) {
  try {
    const state = query.get("state");
    if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !browserToken || browserToken.length !== 43) throw new Error();
    const grant = await withKnowledgeLease({ path: root(repo, org) + ".lock", waitMs: 10_000 }, async () => {
      const path = join(root(repo, org), `grant-${state}.json`);
      const saved = JSON.parse(await readFile(path, "utf8")) as OidcGrant;
      if (saved.expiresAt <= Date.now()) { await unlink(path); throw new Error(); }
      if (saved.state !== state || saved.browserHash !== hash(browserToken) ||
        (saved.linkUserId && (saved.linkUserId !== linkSession?.userId || saved.linkSessionId !== linkSession.sessionId))) throw new Error();
      await unlink(path);
      return saved;
    });
    const configuration = await readConfiguration(repo, org);
    if (hash(JSON.stringify(configuration)) !== grant.configurationHash) throw new Error();
    const discovered = await oidcClient(org, configuration, env);
    const callback = new URL(configuration.redirectUri);
    callback.search = query.toString();
    const tokens = await client.authorizationCodeGrant(discovered, callback,
      { expectedState: grant.state, expectedNonce: grant.nonce, pkceCodeVerifier: grant.verifier, idTokenExpected: true });
    const claims = tokens.claims()!;
    if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 512) throw new Error();
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : undefined;
    const allowCreate = configuration.jit.enabled && claims.email_verified === true && Boolean(email && email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) && configuration.jit.domains.includes(email.split("@")[1]));
    return await withKnowledgeLease({ path: root(repo, org) + ".lock", waitMs: 10_000 }, async () => {
      if (hash(JSON.stringify(await readConfiguration(repo, org))) !== grant.configurationHash) throw new Error();
      return await resolveOrganizationEnterpriseIdentity(repo, org, { issuer: claims.iss, subject: claims.sub, email, allowCreate, linkUserId: grant.linkUserId });
    });
  } catch { throw new WebForbiddenError("OIDC login failed"); }
}
