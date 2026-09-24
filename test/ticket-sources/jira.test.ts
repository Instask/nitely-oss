import { Buffer } from "node:buffer";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defaultJiraStatusPublisher,
  defaultJiraTicketFetcher,
  jiraDocumentToText,
  parseJiraTicketReference,
} from "../../src/ticket-sources/jira.js";
import {
  MissingConnectionError,
  type ProviderConnectionStore,
} from "../../src/providers/types.js";

function providerStore(input: {
  token?: string;
  email?: string;
  baseUrl?: string;
}): ProviderConnectionStore {
  return {
    getConnection: async (providerId) => {
      if (!input.token) {
        throw new MissingConnectionError(providerId, "missing test credential");
      }
      return {
        providerId,
        getAccessToken: async () => input.token!,
      };
    },
    resolveEnv: async () => ({
      ...(input.email ? { NITELY_JIRA_EMAIL: input.email } : {}),
      ...(input.baseUrl ? { NITELY_JIRA_BASE_URL: input.baseUrl } : {}),
    }),
    listStatuses: async () => [],
  };
}

describe("Jira ticket source", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses Atlassian Cloud URLs and configured ticket keys", () => {
    expect(
      parseJiraTicketReference(
        "https://acme.atlassian.net/browse/eng-123?focusedCommentId=7#comment-7",
      ),
    ).toEqual({
      baseUrl: "https://acme.atlassian.net",
      key: "ENG-123",
      url: "https://acme.atlassian.net/browse/ENG-123",
    });
    expect(
      parseJiraTicketReference("ENG-456", "https://jira.example.test/jira/"),
    ).toEqual({
      baseUrl: "https://jira.example.test/jira",
      key: "ENG-456",
      url: "https://jira.example.test/jira/browse/ENG-456",
    });
  });

  it("rejects unconfigured self-hosted, mismatched, and unsafe Jira URLs", () => {
    expect(() =>
      parseJiraTicketReference("https://jira.example.test/browse/ENG-123"),
    ).toThrow(/self-hosted Jira ticket URLs require/);
    expect(() =>
      parseJiraTicketReference(
        "https://other.atlassian.net/browse/ENG-123",
        "https://acme.atlassian.net",
      ),
    ).toThrow(/must match NITELY_JIRA_BASE_URL/);
    expect(() =>
      parseJiraTicketReference("http://acme.atlassian.net/browse/ENG-123"),
    ).toThrow(/must use HTTPS/);
    expect(() =>
      parseJiraTicketReference(
        "https://user:secret@acme.atlassian.net/browse/ENG-123",
      ),
    ).toThrow(/must not include credentials/);
    expect(() => parseJiraTicketReference("ENG-123")).toThrow(
      /base URL is required/,
    );
  });

  it("converts nested Atlassian Document Format content to deterministic text", () => {
    expect(
      jiraDocumentToText({
        version: 1,
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Investigate " },
              { type: "mention", attrs: { text: "@Sam" } },
              { type: "hardBreak" },
              { type: "inlineCard", attrs: { url: "https://example.test/log" } },
            ],
          },
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "First" }] },
                ],
              },
              {
                type: "listItem",
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "Second" }] },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe("Investigate @Sam\nhttps://example.test/log\nFirst\nSecond");
  });

  it("fetches and normalizes Jira metadata, paginated comments, attachments, and links", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            key: "ENG-123",
            fields: {
              summary: "Jira planning intake",
              description: {
                version: 1,
                type: "doc",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Preserve ticket context." }],
                  },
                ],
              },
              status: {
                name: "In Progress",
                statusCategory: { key: "indeterminate" },
              },
              updated: "2026-07-14T01:00:00.000+0000",
              creator: { displayName: "Creator" },
              reporter: { displayName: "Reporter" },
              assignee: { displayName: "Assignee" },
              labels: ["pilot", "priority-p1"],
              fixVersions: [{ name: "Pilot 1" }],
              attachment: [
                {
                  id: "att-1",
                  filename: "failure.log",
                  mimeType: "text/plain",
                  size: 321,
                  content:
                    "https://acme.atlassian.net/rest/api/3/attachment/content/att-1",
                },
              ],
              issuelinks: [
                {
                  type: { outward: "blocks", inward: "is blocked by" },
                  outwardIssue: {
                    key: "ENG-99",
                    fields: {
                      summary: "Prepare the repository",
                      status: { name: "Done" },
                    },
                  },
                },
              ],
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            startAt: 0,
            total: 2,
            comments: [
              {
                author: { displayName: "Reviewer One" },
                body: {
                  type: "doc",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "First comment" }],
                    },
                  ],
                },
                created: "2026-07-14T01:01:00.000+0000",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            startAt: 1,
            total: 2,
            comments: [
              {
                author: { displayName: "Reviewer Two" },
                body: "Second comment",
                updated: "2026-07-14T01:03:00.000+0000",
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const store = providerStore({
      token: "jira-token",
      email: "operator@example.test",
    });

    const ticket = await defaultJiraTicketFetcher(
      parseJiraTicketReference("https://acme.atlassian.net/browse/ENG-123"),
      { providerStore: store },
    );

    expect(ticket).toEqual({
      sourceType: "jira-ticket",
      externalId: "ENG-123",
      title: "Jira planning intake",
      body: "Preserve ticket context.",
      url: "https://acme.atlassian.net/browse/ENG-123",
      state: "In Progress",
      stateCategory: "indeterminate",
      updatedAt: "2026-07-14T01:00:00.000+0000",
      author: "Creator",
      reporter: "Reporter",
      assignees: ["Assignee"],
      labels: ["pilot", "priority-p1"],
      milestone: "Pilot 1",
      comments: [
        {
          author: "Reviewer One",
          body: "First comment",
          createdAt: "2026-07-14T01:01:00.000+0000",
        },
        {
          author: "Reviewer Two",
          body: "Second comment",
          updatedAt: "2026-07-14T01:03:00.000+0000",
        },
      ],
      attachments: [
        {
          id: "att-1",
          filename: "failure.log",
          mediaType: "text/plain",
          size: 321,
          url: "https://acme.atlassian.net/rest/api/3/attachment/content/att-1",
        },
      ],
      linkedIssues: [
        {
          relationship: "blocks",
          key: "ENG-99",
          title: "Prepare the repository",
          state: "Done",
          url: "https://acme.atlassian.net/browse/ENG-99",
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every((call) => call[1]?.redirect === "manual")).toBe(
      true,
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/rest/api/3/issue/ENG-123?fields=",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("startAt=0");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("startAt=1");
    const authorization = `Basic ${Buffer.from(
      "operator@example.test:jira-token",
    ).toString("base64")}`;
    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toMatchObject({ headers: { authorization } });
    }
  });

  it("reports missing, rejected, and rate-limited Jira access clearly", async () => {
    const reference = parseJiraTicketReference(
      "https://acme.atlassian.net/browse/ENG-123",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("not found", { status: 404 })),
    );
    await expect(
      defaultJiraTicketFetcher(reference, { providerStore: providerStore({}) }),
    ).rejects.toThrow(/Configure NITELY_JIRA_TOKEN/);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("forbidden", { status: 403 })),
    );
    await expect(
      defaultJiraTicketFetcher(reference, {
        providerStore: providerStore({ token: "rejected" }),
      }),
    ).rejects.toThrow(/configured Jira credentials were rejected/);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "30" },
        }),
      ),
    );
    await expect(
      defaultJiraTicketFetcher(reference, {
        providerStore: providerStore({ token: "limited" }),
      }),
    ).rejects.toThrow("Jira rate limit exceeded; retry after 30");
  });

  it("publishes bounded Jira ADF status comments with explicit links", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "comment-7",
          self: "https://acme.atlassian.net/rest/api/3/issue/ENG-123/comment/7",
        }),
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const reference = parseJiraTicketReference(
      "https://acme.atlassian.net/browse/ENG-123",
    );

    const result = await defaultJiraStatusPublisher(
      reference,
      {
        summary: "Nitely task task-1 is completed.",
        links: [
          { label: "Task", url: "https://nitely.example.test/tasks/task-1" },
          { label: "PR", url: "https://github.com/example/repo/pull/7" },
        ],
      },
      { providerStore: providerStore({ token: "oauth-token" }) },
    );

    expect(result).toEqual({
      id: "comment-7",
      url: "https://acme.atlassian.net/rest/api/3/issue/ENG-123/comment/7",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://acme.atlassian.net/rest/api/3/issue/ENG-123/comment",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer oauth-token",
          "content-type": "application/json",
        }),
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      body: { content: Array<Record<string, unknown>> };
    };
    expect(body.body).toMatchObject({ version: 1, type: "doc" });
    expect(JSON.stringify(body)).toContain("https://nitely.example.test/tasks/task-1");
    expect(JSON.stringify(body)).toContain('"type":"link"');
  });
});
