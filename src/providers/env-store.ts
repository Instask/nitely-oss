import { execFile } from "node:child_process";

import { MISSING_GITHUB_TOKEN_MESSAGE } from "../scm/github.js";
import { hasEnv, PROVIDER_DESCRIPTORS } from "./descriptors.js";
import type { ProviderDescriptor } from "./descriptors.js";
import { MissingConnectionError } from "./types.js";
import type {
  ProviderAuthMethodStatus,
  ProviderConnection,
  ProviderConnectionStatus,
  ProviderConnectionStore,
  ProviderCredentialMetadata,
  ProviderId,
} from "./types.js";

/**
 * Projects environment variables into the connection model: each configured
 * method becomes one env-only connection so status consumers see one shape
 * whether a credential came from the environment or the Web Console.
 */
function envAuthMethods(
  descriptor: ProviderDescriptor,
  env: Record<string, string | undefined>,
  checkedAt: string,
): ProviderAuthMethodStatus[] {
  return descriptor.authMethods.map((method) => {
    const names = [...(method.env ? [method.env] : []), ...method.readAliases];
    const configured = method.flow !== "cli" && hasEnv(env, names);
    return {
      method: method.method,
      label: method.label,
      flow: method.flow,
      ...(method.env ? { env: method.env } : {}),
      writable: method.writable,
      configured,
      connections: configured
        ? [{
          id: `env:${descriptor.id}:${method.method}`,
          authMethod: method.method,
          state: "active",
          isDefault: true,
          reconnectRequired: false,
          refreshable: false,
          credential: {
            scope: "env-only",
            source: "environment",
            lastStatusCheckedAt: checkedAt,
          },
        }]
        : [],
    };
  });
}

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
    if (providerId === "jira") {
      const token = this.env.NITELY_JIRA_TOKEN ?? this.env.JIRA_API_TOKEN;
      if (!token) {
        throw new MissingConnectionError(
          "jira",
          "missing NITELY_JIRA_TOKEN or JIRA_API_TOKEN for Jira ticket ingestion",
        );
      }
      return {
        providerId: "jira",
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
    const checkedAt = new Date().toISOString();
    return Promise.all(
      PROVIDER_DESCRIPTORS.map(async (d) => {
        const authMethods = envAuthMethods(d, this.env, checkedAt);
        if (isCliManagedProvider(d.id)) {
          const envConfigured = hasEnv(this.env, d.readAliases);
          const installed = await this.commandStatus(
            cliCommandForProvider(d.id, this.env),
            cliVersionArgs(d.id),
          );
          const credential: ProviderCredentialMetadata | undefined =
            envConfigured
              ? {
                  scope: "env-only",
                  source: "environment",
                  lastStatusCheckedAt: new Date().toISOString(),
                }
              : undefined;
          return {
            id: d.id,
            name: d.name,
            configured: envConfigured || installed,
            reconnectRequired: false,
            message: envConfigured
              ? defaultConfiguredMessage(d.id)
              : installed
                ? cliInstalledMessage(d.id)
                : defaultMissingMessage(d.id, d.hints),
            hints: d.hints,
            authMethods: authMethods.map((method) =>
              method.flow === "cli" ? { ...method, configured: installed } : method,
            ),
            ...(credential ? { credential } : {}),
          };
        }
        const configured = hasEnv(this.env, d.readAliases);
        const credential: ProviderCredentialMetadata | undefined = configured
          ? {
            scope: "env-only",
            source: "environment",
            lastStatusCheckedAt: new Date().toISOString(),
          }
          : undefined;
        return {
          id: d.id,
          name: d.name,
          configured,
          reconnectRequired: false,
          message: configured
            ? defaultConfiguredMessage(d.id)
            : defaultMissingMessage(d.id, d.hints),
          hints: d.hints,
          authMethods,
          ...(credential ? { credential } : {}),
        };
      }),
    );
  }
}

function isCliManagedProvider(id: ProviderId): id is "codex" | "grok" | "pi" {
  return id === "codex" || id === "grok" || id === "pi";
}

function cliCommandForProvider(
  id: "codex" | "grok" | "pi",
  env: Record<string, string | undefined>,
): string {
  switch (id) {
    case "codex":
      return env.NITELY_CODEX_COMMAND ?? "codex";
    case "grok":
      return env.NITELY_GROK_COMMAND ?? "grok";
    case "pi":
      return env.NITELY_PI_COMMAND ?? "pi";
  }
}

function cliVersionArgs(id: "codex" | "grok" | "pi"): string[] {
  switch (id) {
    case "grok":
      return ["version"];
    case "codex":
    case "pi":
      return ["--version"];
  }
}

function cliInstalledMessage(id: "codex" | "grok" | "pi"): string {
  switch (id) {
    case "codex":
      return "Codex CLI is installed. Authentication is managed by the local CLI.";
    case "grok":
      return "Grok Build CLI is installed. Authentication is managed by the local CLI or XAI_API_KEY.";
    case "pi":
      return "Pi CLI is installed. Model provider configuration is managed by Pi.";
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
    case "grok":
      return "xAI API key environment variable is configured.";
    case "pi":
      return "Pi CLI is installed. Model provider configuration is managed by Pi.";
    case "google-drive":
      return "Google Drive connector environment is configured.";
    case "jira":
      return "Jira credential environment is configured.";
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
    case "grok":
      return "Run grok login or set XAI_API_KEY for the Grok Build runtime.";
    case "pi":
      return "Install and configure the Pi CLI for the Pi agent runtime.";
    case "google-drive":
      return "Set NITELY_GOOGLE_ACCESS_TOKEN for the Google Drive connector.";
    case "jira":
      return "Set NITELY_JIRA_TOKEN or JIRA_API_TOKEN; set NITELY_JIRA_BASE_URL for bare keys or self-hosted Jira and NITELY_JIRA_EMAIL for Jira Cloud Basic authentication.";
    default:
      return `Set one of: ${hints.join(", ")}`;
  }
}
