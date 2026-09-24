import type {
  ProviderAuthFlow,
  ProviderAuthMethod,
  ProviderId,
} from "./types.js";

export interface ProviderAuthMethodDescriptor {
  method: ProviderAuthMethod;
  label: string;
  /** How a connection of this method is established. */
  flow: ProviderAuthFlow;
  /** Environment variable the runtime reads for this method, if any. */
  env?: string;
  /** Other variables accepted as the same credential when reading the environment. */
  readAliases: string[];
  /** Whether the store may hold credential material for this method. */
  writable: boolean;
}

export interface ProviderDescriptor {
  id: ProviderId;
  name: string;
  /**
   * Supported auth methods in precedence order: when a caller does not name a
   * method, the first method with an active connection wins.
   */
  authMethods: ProviderAuthMethodDescriptor[];
  /** The variable a legacy single-value write projects to. */
  canonicalEnv?: string;
  /** Every variable any method reads, for "is anything configured" checks. */
  readAliases: string[];
  hints: string[];
  writable: boolean;
  /**
   * Compatibility only: assigns an auth method to a record written before
   * methods were explicit. Runtime resolution never inspects secret shapes.
   */
  legacyAuthMethod: (value: string) => ProviderAuthMethod;
}

interface ProviderDefinition {
  id: ProviderId;
  name: string;
  authMethods: ProviderAuthMethodDescriptor[];
  hints: string[];
  legacyAuthMethod?: (value: string) => ProviderAuthMethod;
}

function defineProvider(definition: ProviderDefinition): ProviderDescriptor {
  const writable = definition.authMethods.filter((m) => m.writable);
  const readAliases: string[] = [];
  for (const method of definition.authMethods) {
    for (const name of [method.env, ...method.readAliases]) {
      if (name && !readAliases.includes(name)) readAliases.push(name);
    }
  }
  const canonical = writable.find((m) => m.env)?.env;
  return {
    id: definition.id,
    name: definition.name,
    authMethods: definition.authMethods,
    ...(canonical ? { canonicalEnv: canonical } : {}),
    readAliases,
    hints: definition.hints,
    writable: writable.length > 0,
    legacyAuthMethod: definition.legacyAuthMethod ??
      (() => writable[0]?.method ?? definition.authMethods[0].method),
  };
}

export const PROVIDER_DESCRIPTORS: ProviderDescriptor[] = [
  defineProvider({
    id: "github",
    name: "GitHub",
    authMethods: [
      {
        method: "pat",
        label: "Personal access token",
        flow: "manual",
        env: "NITELY_GITHUB_TOKEN",
        readAliases: ["GITHUB_TOKEN"],
        writable: true,
      },
      {
        method: "oauth",
        label: "GitHub account",
        flow: "redirect",
        env: "NITELY_GITHUB_TOKEN",
        readAliases: [],
        writable: true,
      },
    ],
    hints: ["NITELY_GITHUB_TOKEN", "GITHUB_TOKEN", "provider: github-cli"],
    legacyAuthMethod: () => "pat",
  }),
  defineProvider({
    id: "codex",
    name: "Codex / OpenAI",
    authMethods: [
      { method: "cli_managed", label: "Codex CLI login", flow: "cli", readAliases: [], writable: false },
    ],
    hints: ["codex --version"],
  }),
  defineProvider({
    id: "anthropic",
    name: "Claude / Anthropic",
    authMethods: [
      {
        method: "api_key",
        label: "API key",
        flow: "manual",
        env: "ANTHROPIC_API_KEY",
        readAliases: [],
        writable: true,
      },
      {
        method: "oauth_token",
        label: "Subscription / OAuth token",
        flow: "manual",
        env: "CLAUDE_CODE_OAUTH_TOKEN",
        readAliases: [],
        writable: true,
      },
    ],
    hints: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "NITELY_CLAUDE_COMMAND"],
    // A Claude subscription token and a metered API key are both valid for the
    // same provider; only legacy records need the shape to tell them apart.
    legacyAuthMethod: (value) =>
      value.startsWith("sk-ant-oat") ? "oauth_token" : "api_key",
  }),
  defineProvider({
    id: "glm",
    name: "GLM / Zhipu",
    authMethods: [
      {
        method: "api_key",
        label: "API key",
        flow: "manual",
        env: "NITELY_GLM_API_KEY",
        readAliases: ["GLM_API_KEY", "ZHIPUAI_API_KEY"],
        writable: true,
      },
    ],
    hints: [
      "NITELY_GLM_API_KEY",
      "GLM_API_KEY",
      "ZHIPUAI_API_KEY",
      "NITELY_GLM_COMMAND",
    ],
  }),
  defineProvider({
    id: "grok",
    name: "Grok Build / xAI",
    authMethods: [
      {
        method: "api_key",
        label: "API key",
        flow: "manual",
        env: "XAI_API_KEY",
        readAliases: [],
        writable: true,
      },
      { method: "cli_managed", label: "grok login", flow: "cli", readAliases: [], writable: false },
    ],
    hints: ["grok login", "XAI_API_KEY", "NITELY_GROK_COMMAND"],
  }),
  defineProvider({
    id: "pi",
    name: "Pi Coding Agent",
    authMethods: [
      { method: "cli_managed", label: "Pi CLI", flow: "cli", readAliases: [], writable: false },
    ],
    hints: ["pi --version", "NITELY_PI_COMMAND"],
  }),
  defineProvider({
    id: "google-drive",
    name: "Google Drive",
    authMethods: [
      {
        method: "oauth",
        label: "Google account",
        flow: "redirect",
        env: "NITELY_GOOGLE_ACCESS_TOKEN",
        readAliases: [],
        writable: true,
      },
      {
        method: "oauth_token",
        label: "Access token",
        flow: "manual",
        env: "NITELY_GOOGLE_ACCESS_TOKEN",
        readAliases: ["NIGHTLY_GOOGLE_ACCESS_TOKEN"],
        writable: true,
      },
    ],
    hints: ["NITELY_GOOGLE_ACCESS_TOKEN", "NIGHTLY_GOOGLE_ACCESS_TOKEN"],
    legacyAuthMethod: () => "oauth_token",
  }),
  defineProvider({
    id: "jira",
    name: "Jira",
    authMethods: [
      {
        method: "api_key",
        label: "API token",
        flow: "manual",
        env: "NITELY_JIRA_TOKEN",
        readAliases: ["JIRA_API_TOKEN"],
        writable: true,
      },
    ],
    hints: [
      "NITELY_JIRA_BASE_URL",
      "NITELY_JIRA_EMAIL",
      "NITELY_JIRA_TOKEN",
      "JIRA_API_TOKEN",
    ],
  }),
];

export function findDescriptor(id: ProviderId): ProviderDescriptor {
  const d = PROVIDER_DESCRIPTORS.find((p) => p.id === id);
  if (!d) throw new Error(`unknown provider id: ${id}`);
  return d;
}

export function findAuthMethod(
  descriptor: ProviderDescriptor,
  method: ProviderAuthMethod,
): ProviderAuthMethodDescriptor {
  const found = descriptor.authMethods.find((m) => m.method === method);
  if (!found) {
    throw new Error(
      `provider ${descriptor.id} does not support auth method ${method}`,
    );
  }
  return found;
}

export function hasEnv(
  env: Record<string, string | undefined>,
  names: string[],
): boolean {
  return names.some((name) => Boolean(env[name]));
}

export function readFirstEnv(
  env: Record<string, string | undefined>,
  names: string[],
): string | undefined {
  for (const name of names) {
    if (env[name]) return env[name];
  }
  return undefined;
}
