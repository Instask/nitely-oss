import { EnvProviderConnectionStore } from "./env-store.js";
import { FileProviderConnectionStore } from "./file-store.js";
import type { ProviderConnectionStore } from "./types.js";

export {
  EnvProviderConnectionStore,
} from "./env-store.js";

export {
  FileProviderConnectionStore,
} from "./file-store.js";

export {
  PROVIDER_DESCRIPTORS,
  findDescriptor,
} from "./descriptors.js";

export type {
  ProviderId,
  ProviderConnection,
  ProviderConnectionStatus,
  ProviderConnectionStore,
  SetConnectionInput,
} from "./types.js";

export { MissingConnectionError } from "./types.js";

export function resolveProviderStore(
  nitelyDir: string,
  env?: Record<string, string | undefined>,
  commandStatus?: (command: string, args: string[]) => Promise<boolean>,
): ProviderConnectionStore {
  return new FileProviderConnectionStore({
    path: `${nitelyDir}/connections.json`,
    env: env ?? process.env,
    commandStatus,
  });
}
