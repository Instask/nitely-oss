export type ProviderId =
  | "github"
  | "codex"
  | "anthropic"
  | "glm"
  | "grok"
  | "pi"
  | "google-drive"
  | "jira";

/**
 * How a connection authenticates. A provider declares the subset it supports
 * in its descriptor; the vocabulary is deliberately open-ended so a hosted
 * deployment can add `github_app` or `service_account` without touching the
 * generic store.
 */
export type ProviderAuthMethod =
  | "api_key"
  | "oauth"
  | "oauth_token"
  | "pat"
  | "cli_managed";

export type ProviderConnectionState = "active" | "expired" | "revoked";

export type ReconnectRequiredReason = "expired" | "revoked";

export class MissingConnectionError extends Error {
  constructor(
    public readonly providerId: ProviderId,
    message: string,
  ) {
    super(message);
    this.name = "MissingConnectionError";
  }
}

/**
 * A stored credential exists but can no longer authenticate: it expired
 * without a usable refresh token, the refresh was rejected, or an operator
 * revoked it. Consumers surface this as "reconnect required" rather than as a
 * missing configuration.
 */
export class ReconnectRequiredError extends Error {
  constructor(
    public readonly providerId: ProviderId,
    public readonly connectionId: string,
    public readonly authMethod: ProviderAuthMethod,
    public readonly reason: ReconnectRequiredReason,
    message: string,
  ) {
    super(message);
    this.name = "ReconnectRequiredError";
  }
}

export interface ProviderAccountIdentity {
  readonly id?: string;
  readonly login?: string;
  readonly displayName?: string;
  readonly email?: string;
}

export interface ProviderConnection {
  readonly providerId: ProviderId;
  readonly connectionId?: string;
  readonly authMethod?: ProviderAuthMethod;
  readonly account?: ProviderAccountIdentity;
  readonly scopes?: string[];
  getAccessToken(): Promise<string>;
}

export interface ProviderConnectionSelector {
  readonly connectionId?: string;
  readonly authMethod?: ProviderAuthMethod;
}

export type ProviderCredentialScope =
  | "user"
  | "repo"
  | "org"
  | "env-only"
  | "external-vault-backed";

export type ProviderCredentialSource =
  | "web-console"
  | "environment"
  | "external-vault";

export interface ProviderCredentialMetadata {
  readonly scope: ProviderCredentialScope;
  readonly source: ProviderCredentialSource;
  readonly ownerId?: string;
  readonly repositoryId?: string;
  readonly organizationId?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly lastStatusCheckedAt?: string;
  readonly rotationHint?: string;
  readonly vaultRef?: string;
}

/**
 * The durable description of one connection. Secret material never lives
 * here: `credentialRef` names it in the secret store.
 */
export interface ProviderConnectionRecord {
  readonly id: string;
  readonly providerId: ProviderId;
  readonly authMethod: ProviderAuthMethod;
  readonly label?: string;
  readonly state: ProviderConnectionState;
  readonly isDefault: boolean;
  readonly scopes?: string[];
  readonly account?: ProviderAccountIdentity;
  readonly credentialRef: string;
  readonly expiresAt?: string;
  readonly refreshable: boolean;
  readonly credential: ProviderCredentialMetadata;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastValidatedAt?: string;
}

/** The public projection of a record: what Web/API callers may see. */
export interface ProviderConnectionSummary {
  readonly id: string;
  readonly authMethod: ProviderAuthMethod;
  readonly label?: string;
  readonly state: ProviderConnectionState;
  readonly isDefault: boolean;
  readonly reconnectRequired: boolean;
  readonly refreshable: boolean;
  readonly scopes?: string[];
  readonly account?: ProviderAccountIdentity;
  readonly expiresAt?: string;
  readonly credential: ProviderCredentialMetadata;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly lastValidatedAt?: string;
}

export type ProviderAuthFlow = "manual" | "redirect" | "cli";

export interface ProviderAuthMethodStatus {
  readonly method: ProviderAuthMethod;
  readonly label: string;
  readonly flow: ProviderAuthFlow;
  readonly env?: string;
  readonly writable: boolean;
  readonly configured: boolean;
  readonly connections: ProviderConnectionSummary[];
}

export interface ProviderConnectionStatus {
  readonly id: ProviderId;
  readonly name: string;
  readonly configured: boolean;
  readonly reconnectRequired: boolean;
  readonly message: string;
  readonly hints: string[];
  readonly authMethods: ProviderAuthMethodStatus[];
  /** Metadata of the connection the runtime would select, for policy checks. */
  readonly credential?: ProviderCredentialMetadata;
}

export interface SetConnectionInput {
  readonly providerId: ProviderId;
  /** The access token or API key. */
  readonly value: string;
  /**
   * Omitted only by legacy callers; the descriptor's migration rule then
   * assigns one from the value shape.
   */
  readonly authMethod?: ProviderAuthMethod;
  /** Update this connection instead of creating one. */
  readonly connectionId?: string;
  readonly label?: string;
  readonly makeDefault?: boolean;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly scopes?: string[];
  readonly account?: ProviderAccountIdentity;
  readonly metadata?: Partial<ProviderCredentialMetadata>;
}

export interface ProviderConnectionStore {
  getConnection(
    providerId: ProviderId,
    selector?: ProviderConnectionSelector,
  ): Promise<ProviderConnection>;
  resolveEnv(): Promise<Record<string, string | undefined>>;
  listStatuses(): Promise<ProviderConnectionStatus[]>;
  listConnections?(providerId?: ProviderId): Promise<ProviderConnectionRecord[]>;
  setConnection?(input: SetConnectionInput): Promise<ProviderConnectionRecord>;
  clearConnection?(
    providerId: ProviderId,
    selector?: ProviderConnectionSelector,
  ): Promise<void>;
  revokeConnection?(
    providerId: ProviderId,
    selector: ProviderConnectionSelector,
  ): Promise<void>;
  /** Makes one connection the runtime default for its (provider, method). */
  setDefaultConnection?(providerId: ProviderId, connectionId: string): Promise<void>;
  /** Files consulted for credentials, primary first, for operator-facing messages. */
  describeCredentialSources?(): string[];
}
