import type { ProviderAccountIdentity, ProviderId } from "../types.js";

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scopes?: string[];
}

export interface OAuthAuthorizeInput {
  state: string;
  redirectUri: string;
  codeChallenge: string;
}

export interface OAuthExchangeInput {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

/**
 * Provider-specific OAuth knowledge: endpoints, scopes, response shapes and
 * identity lookup. The Web flow, the state registry and the connection store
 * are provider-agnostic and talk only to this interface.
 */
export interface ProviderOAuthAdapter {
  readonly providerId: ProviderId;
  readonly scopes: string[];
  authorizeUrl(input: OAuthAuthorizeInput): string;
  exchangeCode(input: OAuthExchangeInput): Promise<OAuthTokenSet>;
  refresh(refreshToken: string): Promise<OAuthTokenSet>;
  fetchIdentity(accessToken: string): Promise<ProviderAccountIdentity>;
  /** Best-effort provider-side revocation; absence of support is not an error. */
  revoke(accessToken: string): Promise<void>;
}

export interface CreateProviderOAuthAdaptersInput {
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => Date;
}

export const PROVIDER_OAUTH_CLIENT_ENV: Record<
  "github" | "google-drive",
  { clientId: string; clientSecret: string }
> = {
  github: {
    clientId: "NITELY_GITHUB_OAUTH_CLIENT_ID",
    clientSecret: "NITELY_GITHUB_OAUTH_CLIENT_SECRET",
  },
  "google-drive": {
    clientId: "NITELY_GOOGLE_OAUTH_CLIENT_ID",
    clientSecret: "NITELY_GOOGLE_OAUTH_CLIENT_SECRET",
  },
};

interface OAuthClient {
  clientId: string;
  clientSecret: string;
  fetch: typeof fetch;
  now: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expiresAtFrom(expiresIn: unknown, now: Date): string | undefined {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) return undefined;
  return new Date(now.getTime() + expiresIn * 1000).toISOString();
}

function scopesFrom(scope: unknown, separator: RegExp): string[] | undefined {
  if (typeof scope !== "string" || !scope.trim()) return undefined;
  return scope.split(separator).map((s) => s.trim()).filter(Boolean);
}

/**
 * Reads a token endpoint response. The error message names the provider's
 * error code only: the description can echo request material, and it would
 * otherwise end up in logs and audit text.
 */
async function readTokenResponse(
  providerId: ProviderId,
  operation: string,
  response: Response,
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const error = isRecord(body) && typeof body.error === "string" ? body.error : undefined;
  if (!response.ok || error !== undefined) {
    throw new Error(
      `${providerId} ${operation} failed (${error ?? `HTTP ${response.status}`})`,
    );
  }
  if (!isRecord(body) || typeof body.access_token !== "string") {
    throw new Error(`${providerId} ${operation} returned no access token`);
  }
  return body;
}

function tokenSetFrom(
  body: Record<string, unknown>,
  now: Date,
  scopeSeparator: RegExp,
): OAuthTokenSet {
  const expiresAt = expiresAtFrom(body.expires_in, now);
  const scopes = scopesFrom(body.scope, scopeSeparator);
  return {
    accessToken: body.access_token as string,
    ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(scopes ? { scopes } : {}),
  };
}

function githubAdapter(client: OAuthClient): ProviderOAuthAdapter {
  const scopes = ["repo", "read:user", "user:email"];
  const scopeSeparator = /[,\s]+/;
  return {
    providerId: "github",
    scopes,
    authorizeUrl(input) {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", client.clientId);
      url.searchParams.set("redirect_uri", input.redirectUri);
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", input.state);
      url.searchParams.set("code_challenge", input.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },
    async exchangeCode(input) {
      const response = await client.fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: client.clientId,
          client_secret: client.clientSecret,
          code: input.code,
          redirect_uri: input.redirectUri,
          code_verifier: input.codeVerifier,
        }).toString(),
      });
      return tokenSetFrom(
        await readTokenResponse("github", "token exchange", response),
        client.now(),
        scopeSeparator,
      );
    },
    async refresh(refreshToken) {
      const response = await client.fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: client.clientId,
          client_secret: client.clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }).toString(),
      });
      return tokenSetFrom(
        await readTokenResponse("github", "token refresh", response),
        client.now(),
        scopeSeparator,
      );
    },
    async fetchIdentity(accessToken) {
      const response = await client.fetch("https://api.github.com/user", {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${accessToken}`,
          "user-agent": "nitely",
        },
      });
      if (!response.ok) {
        throw new Error(`github identity lookup failed (HTTP ${response.status})`);
      }
      const body: unknown = await response.json();
      if (!isRecord(body) || typeof body.login !== "string") {
        throw new Error("github identity lookup returned no login");
      }
      return {
        ...(body.id !== undefined && body.id !== null ? { id: String(body.id) } : {}),
        login: body.login,
        ...(typeof body.name === "string" && body.name ? { displayName: body.name } : {}),
        ...(typeof body.email === "string" && body.email ? { email: body.email } : {}),
      };
    },
    async revoke(accessToken) {
      const basic = Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64");
      await client.fetch(
        `https://api.github.com/applications/${encodeURIComponent(client.clientId)}/token`,
        {
          method: "DELETE",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Basic ${basic}`,
            "content-type": "application/json",
            "user-agent": "nitely",
          },
          body: JSON.stringify({ access_token: accessToken }),
        },
      );
    },
  };
}

function googleDriveAdapter(client: OAuthClient): ProviderOAuthAdapter {
  const scopes = [
    "openid",
    "email",
    "https://www.googleapis.com/auth/drive.readonly",
  ];
  const scopeSeparator = /\s+/;
  const tokenEndpoint = "https://oauth2.googleapis.com/token";
  return {
    providerId: "google-drive",
    scopes,
    authorizeUrl(input) {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("client_id", client.clientId);
      url.searchParams.set("redirect_uri", input.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", input.state);
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("code_challenge", input.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },
    async exchangeCode(input) {
      const response = await client.fetch(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.clientId,
          client_secret: client.clientSecret,
          code: input.code,
          redirect_uri: input.redirectUri,
          grant_type: "authorization_code",
          code_verifier: input.codeVerifier,
        }).toString(),
      });
      return tokenSetFrom(
        await readTokenResponse("google-drive", "token exchange", response),
        client.now(),
        scopeSeparator,
      );
    },
    async refresh(refreshToken) {
      const response = await client.fetch(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.clientId,
          client_secret: client.clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }).toString(),
      });
      return tokenSetFrom(
        await readTokenResponse("google-drive", "token refresh", response),
        client.now(),
        scopeSeparator,
      );
    },
    async fetchIdentity(accessToken) {
      const response = await client.fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        throw new Error(`google-drive identity lookup failed (HTTP ${response.status})`);
      }
      const body: unknown = await response.json();
      if (!isRecord(body) || typeof body.sub !== "string") {
        throw new Error("google-drive identity lookup returned no subject");
      }
      return {
        id: body.sub,
        ...(typeof body.email === "string" ? { login: body.email, email: body.email } : {}),
        ...(typeof body.name === "string" && body.name ? { displayName: body.name } : {}),
      };
    },
    async revoke(accessToken) {
      await client.fetch(
        `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(accessToken)}`,
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } },
      );
    },
  };
}

/**
 * Adapters for every provider whose OAuth client is configured in the
 * environment. A provider without client credentials has no adapter, and the
 * Web Console falls back to its manual methods for it.
 */
export function createProviderOAuthAdapters(
  input: CreateProviderOAuthAdaptersInput,
): Map<ProviderId, ProviderOAuthAdapter> {
  const adapters = new Map<ProviderId, ProviderOAuthAdapter>();
  const fetchImpl = input.fetch ?? fetch;
  const now = input.now ?? (() => new Date());
  const factories: Record<
    keyof typeof PROVIDER_OAUTH_CLIENT_ENV,
    (client: OAuthClient) => ProviderOAuthAdapter
  > = { github: githubAdapter, "google-drive": googleDriveAdapter };
  for (const [providerId, names] of Object.entries(PROVIDER_OAUTH_CLIENT_ENV) as Array<
    [keyof typeof PROVIDER_OAUTH_CLIENT_ENV, { clientId: string; clientSecret: string }]
  >) {
    const clientId = input.env[names.clientId]?.trim();
    const clientSecret = input.env[names.clientSecret]?.trim();
    if (!clientId || !clientSecret) continue;
    adapters.set(
      providerId,
      factories[providerId]({ clientId, clientSecret, fetch: fetchImpl, now }),
    );
  }
  return adapters;
}
