import { execFile } from "node:child_process";

import { MISSING_GITHUB_TOKEN_MESSAGE } from "../scm/github.js";
import { hasEnv, PROVIDER_DESCRIPTORS } from "./descriptors.js";
import { MissingConnectionError } from "./types.js";
import type {
  ProviderConnection,
  ProviderConnectionStatus,
  ProviderConnectionStore,
  ProviderId,
} from "./types.js";

function defaultCommandStatus(
  command: string,
  args: string[],
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile(command, args, { timeout: 5000 }, (error) => {
      resolve(!error);
    });
    child.on("error", () => resolve(false));
  });
}

export interface EnvProviderConnectionStoreOptions {
  env?: Record<string, string | undefined>;
  commandStatus?: (command: string, args: string[]) => Promise<boolean>;
}

export class EnvProviderConnectionStore implements ProviderConnectionStore {
  private readonly env: Record<string, string | undefined>;
  private readonly commandStatus: (
    command: string,
    args: string[],
  ) => Promise<boolean>;

  constructor(options: EnvProviderConnectionStoreOptions = {}) {
    this.env = options.env ?? process.env;
    this.commandStatus = options.commandStatus ?? defaultCommandStatus;
  }

  async getConnection(providerId: ProviderId): Promise<ProviderConnection> {
    if (providerId === "github") {
      const token =
        this.env.NITELY_GITHUB_TOKEN ?? this.env.GITHUB_TOKEN;
      if (!token) {
        throw new MissingConnectionError("github", MISSING_GITHUB_TOKEN_MESSAGE);
      }
      return {
        providerId: "github",
        getAccessToken: async () => token,
      };
    }
    if (providerId === "google-drive") {
      const token =
        this.env.NITELY_GOOGLE_ACCESS_TOKEN ??
        this.env.NIGHTLY_GOOGLE_ACCESS_TOKEN;
      if (!token) {
        throw new MissingConnectionError(
          "google-drive",
          "missing NITELY_GOOGLE_ACCESS_TOKEN for google-drive connector",
        );
      }
      return {
        providerId: "google-drive",
        getAccessToken: async () => token,
      };
    }
    throw new MissingConnectionError(
      providerId,
      `provider ${providerId} credentials are not available via direct token access`,
    );
  }

  resolveEnv(): Promise<Record<string, string | undefined>> {
    return Promise.resolve({ ...this.env });
  }

  async listStatuses(): Promise<ProviderConnectionStatus[]> {
    return Promise.all(
      PROVIDER_DESCRIPTORS.map(async (d) => {
        if (d.id === "codex") {
          const installed = await this.commandStatus("codex", ["--version"]);
          return {
            id: d.id,
            name: d.name,
            configured: installed,
            message: installed
              ? "Codex CLI is installed. Authentication is managed by the local CLI."
              : "Install and authenticate the local Codex CLI.",
            hints: d.hints,
          };
        }
        const configured = hasEnv(this.env, d.readAliases);
        return {
          id: d.id,
          name: d.name,
          configured,
          message: configured
            ? defaultConfiguredMessage(d.id)
            : defaultMissingMessage(d.id, d.hints),
          hints: d.hints,
        };
      }),
    );
  }
}

function defaultConfiguredMessage(id: ProviderId): string {
  switch (id) {
    case "github":
      return "Token environment variable is configured.";
    case "anthropic":
      return "Anthropic API environment variable is configured.";
    case "glm":
      return "GLM credential environment variable is configured.";
    case "google-drive":
      return "Google Drive connector environment is configured.";
    default:
      return "Configured.";
  }
}

function defaultMissingMessage(
  id: ProviderId,
  hints: string[],
): string {
  switch (id) {
    case "github":
      return "Set NITELY_GITHUB_TOKEN or GITHUB_TOKEN.";
    case "anthropic":
      return "Set ANTHROPIC_API_KEY for the Claude agent runtime.";
    case "glm":
      return "Set NITELY_GLM_API_KEY, GLM_API_KEY, or ZHIPUAI_API_KEY for the GLM agent runtime.";
    case "google-drive":
      return "Set NITELY_GOOGLE_ACCESS_TOKEN for the Google Drive connector.";
    default:
      return `Set one of: ${hints.join(", ")}`;
  }
}
