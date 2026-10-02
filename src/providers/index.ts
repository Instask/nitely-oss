import { FileProviderConnectionStore } from "./file-store.js";
import type { FileProviderConnectionStoreOptions } from "./file-store.js";
import { PROVIDER_DESCRIPTORS } from "./descriptors.js";
import type { ProviderId, ProviderConnectionStore } from "./types.js";

export {
  EnvProviderConnectionStore,
} from "./env-store.js";

export {
  FileProviderConnectionStore,
} from "./file-store.js";
export type {
  FileProviderConnectionStoreOptions,
  ProviderOAuthOptions,
  ProviderOAuthRefreshInput,
  ProviderOAuthRefreshResult,
} from "./file-store.js";

export { createProviderOAuthAdapters, PROVIDER_OAUTH_CLIENT_ENV } from "./oauth/adapters.js";
export type { ProviderOAuthAdapter, OAuthTokenSet } from "./oauth/adapters.js";

export {
  PROVIDER_DESCRIPTORS,
  findAuthMethod,
  findDescriptor,
} from "./descriptors.js";
export type {
  ProviderAuthMethodDescriptor,
  ProviderDescriptor,
} from "./descriptors.js";

export { FileProviderSecretStore } from "./secret-store.js";
export type { ProviderSecretMaterial, ProviderSecretStore } from "./secret-store.js";

export type {
  ProviderAuthMethod,
  ProviderAuthMethodStatus,
  ProviderConnectionRecord,
  ProviderConnectionSelector,
  ProviderConnectionState,
  ProviderConnectionSummary,
  ProviderId,
  ProviderConnection,
  ProviderConnectionStatus,
  ProviderConnectionStore,
  SetConnectionInput,
} from "./types.js";

export { ConnectionManagementDeniedError, MissingConnectionError, ReconnectRequiredError } from "./types.js";

export function resolveProviderStore(
  nitelyDir: string,
  env?: Record<string, string | undefined>,
  commandStatus?: (command: string, args: string[]) => Promise<boolean>,
  options: Pick<FileProviderConnectionStoreOptions, "oauth" | "now"> = {},
): ProviderConnectionStore {
  return new FileProviderConnectionStore({
    path: `${nitelyDir}/connections.json`,
    env: env ?? process.env,
    commandStatus,
    ...options,
  });
}


export function validateProviderConnectionBindings(value: unknown): Partial<Record<ProviderId, string>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid provider connections");
  const entries = Object.entries(value);
  if (entries.some(([provider, id]) => !PROVIDER_DESCRIPTORS.some((descriptor) => descriptor.id === provider) || typeof id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(id))) throw new Error("invalid provider connection binding");
  return Object.fromEntries(entries);
}

export function bindProviderConnections(store: ProviderConnectionStore, value: unknown): ProviderConnectionStore {
  const bindings = validateProviderConnectionBindings(value);
  if (!bindings || !Object.keys(bindings).length) return store;
  if (!store.withConnectionBindings) throw new Error("provider store does not support explicit connection bindings");
  return store.withConnectionBindings(bindings);
}
