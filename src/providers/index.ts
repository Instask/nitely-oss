import { FileProviderConnectionStore } from "./file-store.js";
import type { FileProviderConnectionStoreOptions } from "./file-store.js";
import type { ProviderConnectionStore } from "./types.js";

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

export { MissingConnectionError, ReconnectRequiredError } from "./types.js";

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
