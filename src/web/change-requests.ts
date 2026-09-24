export interface ChangeRequestIdentityInput {
  changeRequestUrl?: string;
  prUrl?: string;
  prNumber?: number;
  repoId?: string;
  repoPath?: string;
}

export interface CanonicalChangeRequestTarget {
  key: string;
  target: string;
  prNumber?: number;
}

function positiveInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function canonicalChangeRequestTarget(
  value: string | undefined,
): CanonicalChangeRequestTarget | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const segments = url.pathname.split("/").filter(Boolean);
    if (
      hostname === "github.com" &&
      segments.length >= 4 &&
      segments[2]?.toLowerCase() === "pull" &&
      /^\d+$/.test(segments[3] ?? "")
    ) {
      const owner = segments[0]!;
      const repository = segments[1]!.replace(/\.git$/i, "");
      const prNumber = Number.parseInt(segments[3]!, 10);
      return {
        key: `github:${owner.toLowerCase()}/${repository.toLowerCase()}#${prNumber}`,
        target: `https://github.com/${owner}/${repository}/pull/${prNumber}`,
        prNumber,
      };
    }
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return {
      key: url.toString(),
      target: url.toString(),
    };
  } catch {
    const target = raw.replace(/#.*$/, "").replace(/\/+$/, "");
    return target ? { key: target, target } : undefined;
  }
}

export function changeRequestIdentity(
  input: ChangeRequestIdentityInput,
): string | undefined {
  const canonical = canonicalChangeRequestTarget(
    input.changeRequestUrl ?? input.prUrl,
  );
  if (canonical) return canonical.key;
  return localChangeRequestIdentity(input);
}

export function localChangeRequestIdentity(
  input: ChangeRequestIdentityInput,
): string | undefined {
  const canonical = canonicalChangeRequestTarget(
    input.changeRequestUrl ?? input.prUrl,
  );
  const prNumber = canonical?.prNumber ?? positiveInteger(input.prNumber);
  const repositoryScope = input.repoId?.trim() || input.repoPath?.trim();
  if (prNumber !== undefined && repositoryScope) {
    return `repository:${repositoryScope}#${prNumber}`;
  }
  return prNumber !== undefined ? `unknown-repository#${prNumber}` : undefined;
}
