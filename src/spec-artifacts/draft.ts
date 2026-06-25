export type DraftSpecSourceType = "prompt" | "text" | "github-issue";

export interface DraftSpecSource {
  type: DraftSpecSourceType;
  title?: string;
  body: string;
  uri?: string;
}

export interface GeneratedDraftSpec {
  title: string;
  markdown: string;
  source: {
    type: DraftSpecSourceType;
    uri?: string;
    title?: string;
  };
}

export interface GitHubIssueReference {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

export interface GitHubIssueContent {
  title: string;
  body: string;
  url: string;
}

export type GitHubIssueFetcher = (
  reference: GitHubIssueReference,
) => Promise<GitHubIssueContent>;

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function firstSentence(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return "the requested behavior";
  const sentence = compact.match(/^(.{1,180}?)(?:[.!?]\s|$)/)?.[1] ?? compact;
  return sentence.slice(0, 180);
}

function titleFromSource(source: DraftSpecSource): string {
  const title = singleLine(normalizeText(source.title));
  if (title) return title.slice(0, 120);
  return firstSentence(source.body).replace(/^#+\s*/, "").slice(0, 120);
}

function sourceExcerpt(body: string): string {
  return body.slice(0, 4000).replaceAll("```", "` ` `");
}

function sourceLine(source: DraftSpecSource): string {
  const parts: string[] = [source.type];
  if (source.uri) parts.push(source.uri);
  return parts.join(" ");
}

export function generateDraftSpec(source: DraftSpecSource): GeneratedDraftSpec {
  const body = normalizeText(source.body);
  if (!body) {
    throw new Error("draft spec source text is required");
  }
  const title = titleFromSource(source);
  const sourceTitle = normalizeText(source.title);
  const sourceUri = normalizeText(source.uri);
  const problem = firstSentence(body);

  const markdown = `# Feature Spec: ${title}

Status: draft
Source: ${sourceLine(source)}
${sourceTitle ? `Source title: ${sourceTitle}\n` : ""}
## Background

Draft generated from ${source.type} intake. Original source summary:

> ${problem}

## User Stories

- **US-001:** As an operator, I can request this change so Nitely can support the described workflow.
- **US-002:** As a reviewer, I can inspect the generated draft and refine it before implementation.

## Acceptance Scenarios

- **US-001 / SC-001:** Given the approved version of this spec, when implementation runs, then the requested behavior is delivered with traceable evidence.
- **US-002 / SC-002:** Given this generated draft, when a reviewer opens the task, then the source reference and draft status are visible.

## Functional Requirements

- **FR-001:** Nitely must implement the requested behavior described by the source intake.
- **FR-002:** The implementation must preserve a traceable link back to the source intake.
- **FR-003:** The draft must not be implemented until a human approves or replaces it with a ready spec.

## Success Criteria

- **SC-001:** The approved implementation can be verified against the final refined requirements.
- **SC-002:** The task record links the source intake and generated draft spec.
- **SC-003:** Draft specs are blocked from implementation runs until approved.

## Edge Cases And Failure Behavior

- Ambiguous source details remain as open questions instead of invented requirements.
- Missing source references are recorded as prompt or text intake.

## Assumptions

- The generated draft is a starting point for review, not an approved product contract.
- The reviewer will refine requirements before implementation.

## Out Of Scope

- Automatic approval of generated specs.
- LLM-based semantic expansion in this deterministic draft generator.

## Open Questions

- Which user-visible behavior should be considered the minimum acceptable slice?
- Which compatibility, migration, or failure-mode constraints should be added before approval?
- Which tests should be required for final acceptance?

## Source Excerpt

\`\`\`text
${sourceExcerpt(body)}
\`\`\`
`;

  return {
    title,
    markdown,
    source: {
      type: source.type,
      ...(sourceUri ? { uri: sourceUri } : {}),
      ...(sourceTitle ? { title: sourceTitle } : {}),
    },
  };
}

export function parseGitHubIssueReference(
  value: string,
  defaultRepository = "Instask/nitely",
): GitHubIssueReference {
  const input = normalizeText(value);
  if (!input) {
    throw new Error("GitHub issue reference is required");
  }
  const urlMatch = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/?#].*)?$/i.exec(
    input,
  );
  if (urlMatch) {
    const owner = urlMatch[1]!;
    const repo = urlMatch[2]!;
    const number = Number(urlMatch[3]!);
    return {
      owner,
      repo,
      number,
      url: `https://github.com/${owner}/${repo}/issues/${number}`,
    };
  }
  if (/^\d+$/.test(input)) {
    const [owner, repo] = defaultRepository.split("/");
    if (!owner || !repo) {
      throw new Error("default GitHub repository must be owner/repo");
    }
    const number = Number(input);
    return {
      owner,
      repo,
      number,
      url: `https://github.com/${owner}/${repo}/issues/${number}`,
    };
  }
  throw new Error("GitHub issue reference must be an issue number or URL");
}

export async function defaultGitHubIssueFetcher(
  reference: GitHubIssueReference,
): Promise<GitHubIssueContent> {
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}/issues/${reference.number}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        ...(process.env.GITHUB_TOKEN
          ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {}),
      },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub issue fetch failed with ${response.status}`);
  }
  const payload = (await response.json()) as {
    title?: unknown;
    body?: unknown;
    html_url?: unknown;
  };
  return {
    title: typeof payload.title === "string" ? payload.title : "",
    body: typeof payload.body === "string" ? payload.body : "",
    url: typeof payload.html_url === "string" ? payload.html_url : reference.url,
  };
}
