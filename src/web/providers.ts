import { EnvProviderConnectionStore } from "../providers/env-store.js";
import type { ProviderConnectionStatus, ProviderConnectionStore } from "../providers/types.js";

export type { ProviderConnectionStatus as ProviderStatus } from "../providers/types.js";

export interface ProviderStatusOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  commandStatus?: (command: string, args: string[]) => Promise<boolean>;
  store?: ProviderConnectionStore;
}

export async function getProviderStatuses(
  options: ProviderStatusOptions = {},
): Promise<ProviderConnectionStatus[]> {
  const store =
    options.store ??
    new EnvProviderConnectionStore({
      env: options.env,
      commandStatus: options.commandStatus,
    });
  return store.listStatuses();
}
