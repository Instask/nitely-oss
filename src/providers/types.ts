export type ProviderId =
  | "github"
  | "codex"
  | "anthropic"
  | "glm"
  | "google-drive";

export class MissingConnectionError extends Error {
  constructor(
    public readonly providerId: ProviderId,
    message: string,
  ) {
    super(message);
    this.name = "MissingConnectionError";
  }
}

export interface ProviderConnection {
  readonly providerId: ProviderId;
  getAccessToken(): Promise<string>;
}

export interface ProviderConnectionStatus {
  readonly id: ProviderId;
  readonly name: string;
  readonly configured: boolean;
  readonly message: string;
  readonly hints: string[];
}

export interface SetConnectionInput {
  readonly providerId: ProviderId;
  readonly value: string;
}

export interface ProviderConnectionStore {
  getConnection(providerId: ProviderId): Promise<ProviderConnection>;
  resolveEnv(): Promise<Record<string, string | undefined>>;
  listStatuses(): Promise<ProviderConnectionStatus[]>;
  setConnection?(input: SetConnectionInput): Promise<void>;
  clearConnection?(providerId: ProviderId): Promise<void>;
}
