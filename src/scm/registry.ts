import { GitHubCliScmProvider, GitHubScmProvider } from "./github.js";
import type { GitHubScmProviderOptions } from "./github.js";
import type { ScmProvider } from "./types.js";

export type ScmProviderName = "github" | "github-cli";

export function createScmProvider(
  provider: string = "github",
  options: GitHubScmProviderOptions = {},
): ScmProvider {
  if (provider === "github") {
    return new GitHubScmProvider(options);
  }
  if (provider === "github-cli") {
    return new GitHubCliScmProvider();
  }
  throw new Error(`unsupported SCM provider: ${provider}`);
}
