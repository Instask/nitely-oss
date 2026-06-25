import type { ProviderId } from "./types.js";

export interface ProviderDescriptor {
  id: ProviderId;
  name: string;
  canonicalEnv?: string;
  readAliases: string[];
  hints: string[];
  writable: boolean;
}

export const PROVIDER_DESCRIPTORS: ProviderDescriptor[] = [
  {
    id: "github",
    name: "GitHub",
    canonicalEnv: "NITELY_GITHUB_TOKEN",
    readAliases: ["NITELY_GITHUB_TOKEN", "GITHUB_TOKEN"],
    hints: ["NITELY_GITHUB_TOKEN", "GITHUB_TOKEN", "provider: github-cli"],
    writable: true,
  },
  {
    id: "codex",
    name: "Codex / OpenAI",
    readAliases: [],
    hints: ["codex --version"],
    writable: false,
  },
  {
    id: "anthropic",
    name: "Claude / Anthropic",
    canonicalEnv: "ANTHROPIC_API_KEY",
    readAliases: ["ANTHROPIC_API_KEY"],
    hints: ["ANTHROPIC_API_KEY", "NITELY_CLAUDE_COMMAND"],
    writable: true,
  },
  {
    id: "glm",
    name: "GLM / Zhipu",
    canonicalEnv: "NITELY_GLM_API_KEY",
    readAliases: ["NITELY_GLM_API_KEY", "GLM_API_KEY", "ZHIPUAI_API_KEY"],
    hints: [
      "NITELY_GLM_API_KEY",
      "GLM_API_KEY",
      "ZHIPUAI_API_KEY",
      "NITELY_GLM_COMMAND",
    ],
    writable: true,
  },
  {
    id: "google-drive",
    name: "Google Drive",
    canonicalEnv: "NITELY_GOOGLE_ACCESS_TOKEN",
    readAliases: ["NITELY_GOOGLE_ACCESS_TOKEN", "NIGHTLY_GOOGLE_ACCESS_TOKEN"],
    hints: ["NITELY_GOOGLE_ACCESS_TOKEN", "NIGHTLY_GOOGLE_ACCESS_TOKEN"],
    writable: true,
  },
];

export function findDescriptor(id: ProviderId): ProviderDescriptor {
  const d = PROVIDER_DESCRIPTORS.find((p) => p.id === id);
  if (!d) throw new Error(`unknown provider id: ${id}`);
  return d;
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
