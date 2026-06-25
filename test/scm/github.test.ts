import { describe, expect, it } from "vitest";

import {
  GitHubCliScmProvider,
  GitHubScmProvider,
  MissingGitHubTokenError,
  parseGitHubPullRequestTarget,
  parseGitHubRemoteUrl,
} from "../../src/scm/github.js";
import type { ProviderConnection } from "../../src/providers/types.js";

describe("GitHubScmProvider", () => {
  it("parses HTTPS GitHub remotes", () => {
    expect(parseGitHubRemoteUrl("https://github.com/Instask/nitely.git")).toEqual({
      owner: "Instask",
      repository: "nitely",
    });
  });

  it("parses SSH GitHub remotes", () => {
    expect(parseGitHubRemoteUrl("git@github.com:Instask/nitely.git")).toEqual({
      owner: "Instask",
      repository: "nitely",
    });
  });

  it("parses GitHub pull request URLs and numbers", () => {
    expect(
      parseGitHubPullRequestTarget("https://github.com/Instask/nitely/pull/22"),
    ).toEqual({
      owner: "Instask",
      repository: "nitely",
      number: 22,
    });
    expect(parseGitHubPullRequestTarget("22")).toEqual({ number: 22 });
  });

  it("fails with an actionable error when no token is configured", async () => {
    const provider = new GitHubScmProvider({
      env: {},
      git: async () => "git@github.com:Instask/nitely.git\n",
      fetch: async () =>
        new Response(JSON.stringify({ html_url: "unused", number: 1 }), {
          status: 201,
        }),
    });

    await expect(
      provider.publishChange({
        repoPath: "/repo",
        worktreePath: "/repo/.nitely/worktree",
        remoteName: "origin",
        baseBranch: "main",
        headBranch: "nitely/run-1",
        title: "Nitely: test",
        body: "Evidence",
      }),
    ).rejects.toThrow(MissingGitHubTokenError);
    await expect(
      provider.publishChange({
        repoPath: "/repo",
        worktreePath: "/repo/.nitely/worktree",
        remoteName: "origin",
        baseBranch: "main",
        headBranch: "nitely/run-1",
        title: "Nitely: test",
        body: "Evidence",
      }),
    ).rejects.toThrow(
      "Missing GitHub token. Set NITELY_GITHUB_TOKEN or configure a GitHub provider connection.",
    );
  });

  it("pushes the branch and creates a draft pull request through the GitHub API", async () => {
    const gitCalls: Array<{ cwd: string; args: string[] }> = [];
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const provider = new GitHubScmProvider({
      env: { NITELY_GITHUB_TOKEN: "nitely-token", GITHUB_TOKEN: "compat-token" },
      git: async (cwd, args) => {
        gitCalls.push({ cwd, args });
        if (args[0] === "remote") {
          return "git@github.com:Instask/nitely.git\n";
        }
        return "";
      },
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        if (init?.method === "GET") {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            html_url: "https://github.com/Instask/nitely/pull/8",
            number: 8,
            draft: true,
            base: { ref: "main" },
            head: { ref: "nitely/run-1" },
          }),
          { status: 201 },
        );
      },
    });

    const result = await provider.publishChange({
      repoPath: "/repo",
      worktreePath: "/repo/.nitely/worktree",
      remoteName: "origin",
      baseBranch: "main",
      headBranch: "nitely/run-1",
      title: "Nitely: test",
      body: "Evidence body",
    });

    expect(gitCalls).toEqual([
      {
        cwd: "/repo/.nitely/worktree",
        args: ["remote", "get-url", "origin"],
      },
      {
        cwd: "/repo/.nitely/worktree",
        args: ["push", "-u", "origin", "nitely/run-1"],
      },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(
      "https://api.github.com/repos/Instask/nitely/pulls?state=open&head=Instask%3Anitely%2Frun-1&base=main&per_page=1",
    );
    expect(requests[0]?.init?.method).toBe("GET");
    expect(requests[1]?.url).toBe(
      "https://api.github.com/repos/Instask/nitely/pulls",
    );
    expect(requests[1]?.init?.method).toBe("POST");
    expect(requests[1]?.init?.headers).toMatchObject({
      Authorization: "Bearer nitely-token",
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      title: "Nitely: test",
      head: "nitely/run-1",
      base: "main",
      body: "Evidence body",
      draft: true,
    });
    expect(result).toEqual({
      provider: "github",
      url: "https://github.com/Instask/nitely/pull/8",
      number: 8,
      owner: "Instask",
      repository: "nitely",
      baseBranch: "main",
      headBranch: "nitely/run-1",
      draft: true,
      outcome: "created",
    });
  });

  it("reuses an existing pull request through the GitHub API", async () => {
    const requests: Array<{ url: string; method: string | undefined }> = [];
    const provider = new GitHubScmProvider({
      env: { NITELY_GITHUB_TOKEN: "nitely-token" },
      git: async (_cwd, args) => {
        if (args[0] === "remote") {
          return "git@github.com:Instask/nitely.git\n";
        }
        return "";
      },
      fetch: async (url, init) => {
        requests.push({ url: String(url), method: init?.method });
        return new Response(
          JSON.stringify([
            {
              html_url: "https://github.com/Instask/nitely/pull/158",
              number: 158,
              draft: false,
            },
          ]),
          { status: 200 },
        );
      },
    });

    const result = await provider.publishChange({
      repoPath: "/repo",
      worktreePath: "/repo/.nitely/worktree",
      remoteName: "origin",
      baseBranch: "master",
      headBranch: "nitely/2026-06-23T012659386Z-de754f18",
      title: "Nitely: retry",
      body: "Evidence body",
    });

    expect(requests).toEqual([
      {
        url: "https://api.github.com/repos/Instask/nitely/pulls?state=open&head=Instask%3Anitely%2F2026-06-23T012659386Z-de754f18&base=master&per_page=1",
        method: "GET",
      },
    ]);
    expect(result).toEqual({
      provider: "github",
      url: "https://github.com/Instask/nitely/pull/158",
      number: 158,
      owner: "Instask",
      repository: "nitely",
      baseBranch: "master",
      headBranch: "nitely/2026-06-23T012659386Z-de754f18",
      draft: false,
      outcome: "reused",
    });
  });

  it("reuses an existing draft pull request through the GitHub API", async () => {
    const provider = new GitHubScmProvider({
      env: { NITELY_GITHUB_TOKEN: "nitely-token" },
      git: async (_cwd, args) => {
        if (args[0] === "remote") {
          return "https://github.com/Instask/nitely.git\n";
        }
        return "";
      },
      fetch: async () =>
        new Response(
          JSON.stringify([
            {
              html_url: "https://github.com/Instask/nitely/pull/159",
              number: 159,
              draft: true,
            },
          ]),
          { status: 200 },
        ),
    });

    await expect(
      provider.publishChange({
        repoPath: "/repo",
        worktreePath: "/repo/.nitely/worktree",
        remoteName: "origin",
        baseBranch: "master",
        headBranch: "nitely/run-draft",
        title: "Nitely: retry",
        body: "Evidence body",
      }),
    ).resolves.toMatchObject({
      url: "https://github.com/Instask/nitely/pull/159",
      draft: true,
      outcome: "reused",
    });
  });

  it("uses GITHUB_TOKEN as a compatibility fallback", async () => {
    let authorization = "";
    const provider = new GitHubScmProvider({
      env: { GITHUB_TOKEN: "compat-token" },
      git: async (_cwd, args) => {
        if (args[0] === "remote") {
          return "https://github.com/Instask/nitely.git\n";
        }
        return "";
      },
      fetch: async (_url, init) => {
        authorization = String(
          (init?.headers as Record<string, string>)?.Authorization,
        );
        return new Response(
          JSON.stringify({
            html_url: "https://github.com/Instask/nitely/pull/9",
            number: 9,
          }),
          { status: 201 },
        );
      },
    });

    await provider.publishChange({
      repoPath: "/repo",
      worktreePath: "/repo/worktree",
      remoteName: "origin",
      baseBranch: "main",
      headBranch: "nitely/run-2",
      title: "Nitely: test",
      body: "Evidence",
    });

    expect(authorization).toBe("Bearer compat-token");
  });

  it("uses an injected provider connection token for GitHub API calls", async () => {
    let authorization = "";
    const connection: ProviderConnection = {
      providerId: "github",
      getAccessToken: async () => "injected-token",
    };
    const provider = new GitHubScmProvider({
      env: {},
      connection,
      git: async (_cwd, args) => {
        if (args[0] === "remote") {
          return "https://github.com/Instask/nitely.git\n";
        }
        return "";
      },
      fetch: async (_url, init) => {
        authorization = String(
          (init?.headers as Record<string, string>)?.Authorization,
        );
        return new Response(
          JSON.stringify({
            html_url: "https://github.com/Instask/nitely/pull/10",
            number: 10,
          }),
          { status: 201 },
        );
      },
    });

    await provider.publishChange({
      repoPath: "/repo",
      worktreePath: "/repo/worktree",
      remoteName: "origin",
      baseBranch: "main",
      headBranch: "nitely/run-3",
      title: "Nitely: test",
      body: "Evidence",
    });

    expect(authorization).toBe("Bearer injected-token");
  });

  it("resolves same-repository pull request targets through the GitHub API", async () => {
    const requests: string[] = [];
    const provider = new GitHubScmProvider({
      env: { NITELY_GITHUB_TOKEN: "nitely-token" },
      git: async (_cwd, args) => {
        if (args[0] === "remote") {
          return "git@github.com:Instask/nitely.git\n";
        }
        return "";
      },
      fetch: async (url) => {
        requests.push(String(url));
        return new Response(
          JSON.stringify({
            html_url: "https://github.com/Instask/nitely/pull/22",
            number: 22,
            base: { ref: "master" },
            head: {
              ref: "nitely/run-1",
              sha: "abc123",
              repo: {
                name: "nitely",
                full_name: "Instask/nitely",
                owner: { login: "Instask" },
              },
            },
          }),
          { status: 200 },
        );
      },
    });

    const result = await provider.resolveChangeRequestTarget?.({
      repoPath: "/repo",
      remoteName: "origin",
      target: "22",
    });

    expect(requests).toEqual([
      "https://api.github.com/repos/Instask/nitely/pulls/22",
    ]);
    expect(result).toEqual({
      provider: "github",
      owner: "Instask",
      repository: "nitely",
      number: 22,
      url: "https://github.com/Instask/nitely/pull/22",
      baseBranch: "master",
      headBranch: "nitely/run-1",
      headSha: "abc123",
      headRepository: { owner: "Instask", repository: "nitely" },
      isCrossRepository: false,
    });
  });

  it("lists issue and review comments for a pull request", async () => {
    const requests: string[] = [];
    const provider = new GitHubScmProvider({
      env: { NITELY_GITHUB_TOKEN: "nitely-token" },
      git: async (_cwd, args) => {
        if (args[0] === "remote") {
          return "git@github.com:Instask/nitely.git\n";
        }
        return "";
      },
      fetch: async (url) => {
        requests.push(String(url));
        if (String(url).endsWith("/issues/22/comments?per_page=100")) {
          return new Response(
            JSON.stringify([
              {
                id: 10,
                html_url: "https://github.com/Instask/nitely/pull/22#issuecomment-10",
                body: "@nitely rework fix it",
                user: { login: "alice" },
                author_association: "MEMBER",
                created_at: "2026-06-20T00:00:00Z",
                updated_at: "2026-06-20T00:00:01Z",
              },
            ]),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify([
            {
              id: 11,
              html_url: "https://github.com/Instask/nitely/pull/22#discussion_r11",
              body: "@nitely address this test",
              user: { login: "bob" },
              author_association: "COLLABORATOR",
              created_at: "2026-06-20T00:00:02Z",
              updated_at: "2026-06-20T00:00:03Z",
              path: "src/app.ts",
              line: 42,
              in_reply_to_id: 9,
            },
          ]),
          { status: 200 },
        );
      },
    });

    const result = await provider.listPullRequestDiscussion?.({
      repoPath: "/repo",
      remoteName: "origin",
      target: {
        provider: "github",
        owner: "Instask",
        repository: "nitely",
        number: 22,
        url: "https://github.com/Instask/nitely/pull/22",
        baseBranch: "master",
        headBranch: "nitely/run-1",
        headSha: "abc123",
        headRepository: { owner: "Instask", repository: "nitely" },
        isCrossRepository: false,
      },
    });

    expect(requests).toEqual([
      "https://api.github.com/repos/Instask/nitely/issues/22/comments?per_page=100",
      "https://api.github.com/repos/Instask/nitely/pulls/22/comments?per_page=100",
    ]);
    expect(result).toEqual([
      {
        provider: "github",
        kind: "issue-comment",
        id: "10",
        url: "https://github.com/Instask/nitely/pull/22#issuecomment-10",
        body: "@nitely rework fix it",
        authorLogin: "alice",
        authorAssociation: "MEMBER",
        createdAt: "2026-06-20T00:00:00Z",
        updatedAt: "2026-06-20T00:00:01Z",
      },
      {
        provider: "github",
        kind: "review-comment",
        id: "11",
        url: "https://github.com/Instask/nitely/pull/22#discussion_r11",
        body: "@nitely address this test",
        authorLogin: "bob",
        authorAssociation: "COLLABORATOR",
        createdAt: "2026-06-20T00:00:02Z",
        updatedAt: "2026-06-20T00:00:03Z",
        path: "src/app.ts",
        line: 42,
        inReplyToId: "9",
      },
    ]);
  });

  it("lists issue comments across paginated GitHub responses", async () => {
    const requests: string[] = [];
    const provider = new GitHubScmProvider({
      env: { NITELY_GITHUB_TOKEN: "nitely-token" },
      git: async (_cwd, args) => {
        if (args[0] === "remote") {
          return "git@github.com:Instask/nitely.git\n";
        }
        return "";
      },
      fetch: async (url) => {
        const requestUrl = String(url);
        requests.push(requestUrl);
        if (requestUrl.endsWith("/issues/22/comments?per_page=100")) {
          return new Response(
            JSON.stringify([
              {
                id: 20,
                html_url: "https://github.com/Instask/nitely/pull/22#issuecomment-20",
                body: "@nitely rework first",
                user: { login: "alice" },
                author_association: "MEMBER",
                created_at: "2026-06-20T00:00:00Z",
                updated_at: "2026-06-20T00:00:01Z",
              },
            ]),
            {
              status: 200,
              headers: {
                Link: '<https://api.github.com/repos/Instask/nitely/issues/22/comments?page=2&per_page=100>; rel="next"',
              },
            },
          );
        }
        if (requestUrl.endsWith("/issues/22/comments?page=2&per_page=100")) {
          return new Response(
            JSON.stringify([
              {
                id: 21,
                html_url: "https://github.com/Instask/nitely/pull/22#issuecomment-21",
                body: "@nitely rework second",
                user: { login: "bob" },
                author_association: "COLLABORATOR",
                created_at: "2026-06-20T00:00:02Z",
                updated_at: "2026-06-20T00:00:03Z",
              },
            ]),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify([]), { status: 200 });
      },
    });

    const result = await provider.listPullRequestDiscussion?.({
      repoPath: "/repo",
      remoteName: "origin",
      target: {
        provider: "github",
        owner: "Instask",
        repository: "nitely",
        number: 22,
        url: "https://github.com/Instask/nitely/pull/22",
        baseBranch: "master",
        headBranch: "nitely/run-1",
        headSha: "abc123",
        headRepository: { owner: "Instask", repository: "nitely" },
        isCrossRepository: false,
      },
    });

    expect(requests).toContain(
      "https://api.github.com/repos/Instask/nitely/issues/22/comments?per_page=100",
    );
    expect(requests).toContain(
      "https://api.github.com/repos/Instask/nitely/issues/22/comments?page=2&per_page=100",
    );
    expect(result?.filter((item) => item.kind === "issue-comment")).toMatchObject([
      { id: "20", body: "@nitely rework first" },
      { id: "21", body: "@nitely rework second" },
    ]);
  });

  it("lists review comments across paginated GitHub responses", async () => {
    const requests: string[] = [];
    const provider = new GitHubScmProvider({
      env: { NITELY_GITHUB_TOKEN: "nitely-token" },
      git: async (_cwd, args) => {
        if (args[0] === "remote") {
          return "git@github.com:Instask/nitely.git\n";
        }
        return "";
      },
      fetch: async (url) => {
        const requestUrl = String(url);
        requests.push(requestUrl);
        if (requestUrl.endsWith("/pulls/22/comments?per_page=100")) {
          return new Response(
            JSON.stringify([
              {
                id: 30,
                html_url: "https://github.com/Instask/nitely/pull/22#discussion_r30",
                body: "@nitely address this first",
                user: { login: "alice" },
                author_association: "MEMBER",
                created_at: "2026-06-20T00:00:00Z",
                updated_at: "2026-06-20T00:00:01Z",
                path: "src/app.ts",
                line: 42,
              },
            ]),
            {
              status: 200,
              headers: {
                Link: '<https://api.github.com/repos/Instask/nitely/pulls/22/comments?page=2&per_page=100>; rel="next"',
              },
            },
          );
        }
        if (requestUrl.endsWith("/pulls/22/comments?page=2&per_page=100")) {
          return new Response(
            JSON.stringify([
              {
                id: 31,
                html_url: "https://github.com/Instask/nitely/pull/22#discussion_r31",
                body: "@nitely address this second",
                user: { login: "bob" },
                author_association: "COLLABORATOR",
                created_at: "2026-06-20T00:00:02Z",
                updated_at: "2026-06-20T00:00:03Z",
                path: "src/app.ts",
                line: 43,
              },
            ]),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify([]), { status: 200 });
      },
    });

    const result = await provider.listPullRequestDiscussion?.({
      repoPath: "/repo",
      remoteName: "origin",
      target: {
        provider: "github",
        owner: "Instask",
        repository: "nitely",
        number: 22,
        url: "https://github.com/Instask/nitely/pull/22",
        baseBranch: "master",
        headBranch: "nitely/run-1",
        headSha: "abc123",
        headRepository: { owner: "Instask", repository: "nitely" },
        isCrossRepository: false,
      },
    });

    expect(requests).toContain(
      "https://api.github.com/repos/Instask/nitely/pulls/22/comments?per_page=100",
    );
    expect(requests).toContain(
      "https://api.github.com/repos/Instask/nitely/pulls/22/comments?page=2&per_page=100",
    );
    expect(result?.filter((item) => item.kind === "review-comment")).toMatchObject([
      { id: "30", body: "@nitely address this first" },
      { id: "31", body: "@nitely address this second" },
    ]);
  });

  it("rejects mismatched repositories before listing pull request discussion", async () => {
    let fetchCalls = 0;
    const provider = new GitHubScmProvider({
      env: { NITELY_GITHUB_TOKEN: "nitely-token" },
      git: async (_cwd, args) => {
        if (args[0] === "remote") {
          return "git@github.com:Instask/nitely.git\n";
        }
        return "";
      },
      fetch: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify([]), { status: 200 });
      },
    });

    await expect(
      provider.listPullRequestDiscussion?.({
        repoPath: "/repo",
        remoteName: "origin",
        target: {
          provider: "github",
          owner: "Other",
          repository: "nitely",
          number: 22,
          url: "https://github.com/Other/nitely/pull/22",
          baseBranch: "master",
          headBranch: "nitely/run-1",
          headSha: "abc123",
          headRepository: { owner: "Other", repository: "nitely" },
          isCrossRepository: false,
        },
      }),
    ).rejects.toThrow("does not match configured repository");
    expect(fetchCalls).toBe(0);
  });

  it("creates issue-style pull request comments", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const provider = new GitHubScmProvider({
      env: { NITELY_GITHUB_TOKEN: "nitely-token" },
      git: async (_cwd, args) => {
        if (args[0] === "remote") {
          return "git@github.com:Instask/nitely.git\n";
        }
        return "";
      },
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(
          JSON.stringify({
            id: 12,
            html_url: "https://github.com/Instask/nitely/pull/22#issuecomment-12",
            body: "Nitely reply",
            user: { login: "nitely" },
            author_association: "MEMBER",
            created_at: "2026-06-20T00:00:04Z",
            updated_at: "2026-06-20T00:00:04Z",
          }),
          { status: 201 },
        );
      },
    });

    const result = await provider.createPullRequestComment?.({
      repoPath: "/repo",
      remoteName: "origin",
      target: {
        provider: "github",
        owner: "Instask",
        repository: "nitely",
        number: 22,
        url: "https://github.com/Instask/nitely/pull/22",
        baseBranch: "master",
        headBranch: "nitely/run-1",
        headSha: "abc123",
        headRepository: { owner: "Instask", repository: "nitely" },
        isCrossRepository: false,
      },
      body: "Nitely reply",
    });

    expect(requests[0]?.url).toBe(
      "https://api.github.com/repos/Instask/nitely/issues/22/comments",
    );
    expect(requests[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      body: "Nitely reply",
    });
    expect(result).toMatchObject({
      provider: "github",
      kind: "issue-comment",
      id: "12",
      body: "Nitely reply",
      authorLogin: "nitely",
    });
  });

  it("rejects mismatched repositories before creating pull request comments", async () => {
    let fetchCalls = 0;
    const provider = new GitHubScmProvider({
      env: { NITELY_GITHUB_TOKEN: "nitely-token" },
      git: async (_cwd, args) => {
        if (args[0] === "remote") {
          return "git@github.com:Instask/nitely.git\n";
        }
        return "";
      },
      fetch: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({}), { status: 201 });
      },
    });

    await expect(
      provider.createPullRequestComment?.({
        repoPath: "/repo",
        remoteName: "origin",
        target: {
          provider: "github",
          owner: "Other",
          repository: "nitely",
          number: 22,
          url: "https://github.com/Other/nitely/pull/22",
          baseBranch: "master",
          headBranch: "nitely/run-1",
          headSha: "abc123",
          headRepository: { owner: "Other", repository: "nitely" },
          isCrossRepository: false,
        },
        body: "Nitely reply",
      }),
    ).rejects.toThrow("does not match configured repository");
    expect(fetchCalls).toBe(0);
  });

  it("rejects fork pull request targets before checkout", async () => {
    const provider = new GitHubScmProvider({
      env: { NITELY_GITHUB_TOKEN: "nitely-token" },
      git: async (_cwd, args) => {
        if (args[0] === "remote") {
          return "git@github.com:Instask/nitely.git\n";
        }
        return "";
      },
      fetch: async () =>
        new Response(
          JSON.stringify({
            html_url: "https://github.com/Instask/nitely/pull/22",
            number: 22,
            base: { ref: "master" },
            head: {
              ref: "contributor-branch",
              sha: "abc123",
              repo: {
                name: "nitely",
                full_name: "Contributor/nitely",
                owner: { login: "Contributor" },
              },
            },
          }),
          { status: 200 },
        ),
    });

    await expect(
      provider.resolveChangeRequestTarget?.({
        repoPath: "/repo",
        remoteName: "origin",
        target: "22",
      }),
    ).rejects.toThrow(/cross-repository pull requests are not supported/);
  });

  it("pushes updates to the existing pull request head branch", async () => {
    const gitCalls: Array<{ cwd: string; args: string[] }> = [];
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const provider = new GitHubScmProvider({
      env: { NITELY_GITHUB_TOKEN: "nitely-token" },
      git: async (cwd, args) => {
        gitCalls.push({ cwd, args });
        if (args[0] === "status") {
          return " M README.md\n";
        }
        if (args[0] === "rev-parse") {
          return "def456\n";
        }
        return "";
      },
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response("{}", { status: 200 });
      },
    });

    const result = await provider.updateChangeRequest?.({
      repoPath: "/repo",
      worktreePath: "/repo/.nitely/runs/run-1/worktree",
      remoteName: "origin",
      target: {
        provider: "github",
        owner: "Instask",
        repository: "nitely",
        number: 22,
        url: "https://github.com/Instask/nitely/pull/22",
        baseBranch: "master",
        headBranch: "nitely/run-1",
        headSha: "abc123",
        headRepository: { owner: "Instask", repository: "nitely" },
        isCrossRepository: false,
      },
      title: "Nitely: rework",
    });

    expect(gitCalls).toEqual([
      {
        cwd: "/repo/.nitely/runs/run-1/worktree",
        args: ["add", "."],
      },
      {
        cwd: "/repo/.nitely/runs/run-1/worktree",
        args: ["status", "--short"],
      },
      {
        cwd: "/repo/.nitely/runs/run-1/worktree",
        args: ["commit", "-m", "Nitely: rework"],
      },
      {
        cwd: "/repo/.nitely/runs/run-1/worktree",
        args: ["push", "origin", "HEAD:nitely/run-1"],
      },
      {
        cwd: "/repo/.nitely/runs/run-1/worktree",
        args: ["rev-parse", "HEAD"],
      },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://api.github.com/repos/Instask/nitely/pulls/22",
    );
    expect(requests[0]?.init?.method).toBe("PATCH");
    expect(requests[0]?.init?.headers).toMatchObject({
      Authorization: "Bearer nitely-token",
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      title: "Nitely: rework",
    });
    expect(result).toMatchObject({
      url: "https://github.com/Instask/nitely/pull/22",
      number: 22,
      previousHeadSha: "abc123",
      updatedHeadSha: "def456",
    });
  });

  it("checks out pull request targets on the head branch", async () => {
    const gitCalls: Array<{ cwd: string; args: string[] }> = [];
    const provider = new GitHubScmProvider({
      env: { NITELY_GITHUB_TOKEN: "nitely-token" },
      git: async (cwd, args) => {
        gitCalls.push({ cwd, args });
        if (args[0] === "worktree" && args[1] === "list") {
          return "";
        }
        return "";
      },
      fetch: async () => new Response("{}", { status: 200 }),
    });

    await provider.checkoutChangeRequest?.({
      repoPath: "/repo",
      worktreePath: "/repo/.nitely/runs/run-1/worktree",
      remoteName: "origin",
      target: {
        provider: "github",
        owner: "Instask",
        repository: "nitely",
        number: 22,
        url: "https://github.com/Instask/nitely/pull/22",
        baseBranch: "master",
        headBranch: "nitely/run-1",
        headSha: "abc123",
        headRepository: { owner: "Instask", repository: "nitely" },
        isCrossRepository: false,
      },
    });

    expect(gitCalls).toEqual([
      {
        cwd: "/repo",
        args: ["fetch", "origin", "nitely/run-1"],
      },
      {
        cwd: "/repo",
        args: ["worktree", "list", "--porcelain"],
      },
      {
        cwd: "/repo",
        args: [
          "worktree",
          "add",
          "--force",
          "-B",
          "nitely/run-1",
          "/repo/.nitely/runs/run-1/worktree",
          "FETCH_HEAD",
        ],
      },
    ]);
  });

  it("removes a clean previous Nitely worktree before checking out the same pull request branch", async () => {
    const gitCalls: Array<{ cwd: string; args: string[] }> = [];
    const provider = new GitHubScmProvider({
      env: { NITELY_GITHUB_TOKEN: "nitely-token" },
      git: async (cwd, args) => {
        gitCalls.push({ cwd, args });
        if (args[0] === "worktree" && args[1] === "list") {
          return [
            "worktree /repo",
            "branch refs/heads/master",
            "",
            "worktree /repo/.nitely/runs/old-run/worktree",
            "branch refs/heads/nitely/run-1",
            "",
          ].join("\n");
        }
        if (args[0] === "status") {
          return "";
        }
        return "";
      },
      fetch: async () => new Response("{}", { status: 200 }),
    });

    await provider.checkoutChangeRequest?.({
      repoPath: "/repo",
      worktreePath: "/repo/.nitely/runs/new-run/worktree",
      remoteName: "origin",
      target: {
        provider: "github",
        owner: "Instask",
        repository: "nitely",
        number: 22,
        url: "https://github.com/Instask/nitely/pull/22",
        baseBranch: "master",
        headBranch: "nitely/run-1",
        headSha: "abc123",
        headRepository: { owner: "Instask", repository: "nitely" },
        isCrossRepository: false,
      },
    });

    expect(gitCalls).toContainEqual({
      cwd: "/repo/.nitely/runs/old-run/worktree",
      args: ["status", "--short"],
    });
    expect(gitCalls).toContainEqual({
      cwd: "/repo",
      args: [
        "worktree",
        "remove",
        "--force",
        "/repo/.nitely/runs/old-run/worktree",
      ],
    });
    expect(gitCalls.at(-1)).toEqual({
      cwd: "/repo",
      args: [
        "worktree",
        "add",
        "--force",
        "-B",
        "nitely/run-1",
        "/repo/.nitely/runs/new-run/worktree",
        "FETCH_HEAD",
      ],
    });
  });

  it("rejects cross-repository targets during direct checkout and update calls", async () => {
    const gitCalls: Array<{ cwd: string; args: string[] }> = [];
    const provider = new GitHubScmProvider({
      env: { NITELY_GITHUB_TOKEN: "nitely-token" },
      git: async (cwd, args) => {
        gitCalls.push({ cwd, args });
        return "";
      },
      fetch: async () => new Response("{}", { status: 200 }),
    });
    const target = {
      provider: "github" as const,
      owner: "Instask",
      repository: "nitely",
      number: 22,
      url: "https://github.com/Instask/nitely/pull/22",
      baseBranch: "master",
      headBranch: "contributor-branch",
      headSha: "abc123",
      headRepository: { owner: "Contributor", repository: "nitely" },
      isCrossRepository: true,
    };

    await expect(
      provider.checkoutChangeRequest?.({
        repoPath: "/repo",
        worktreePath: "/repo/.nitely/runs/run-1/worktree",
        remoteName: "origin",
        target,
      }),
    ).rejects.toThrow(/cross-repository pull requests are not supported/);
    await expect(
      provider.updateChangeRequest?.({
        repoPath: "/repo",
        worktreePath: "/repo/.nitely/runs/run-1/worktree",
        remoteName: "origin",
        target,
        title: "Nitely: rework",
      }),
    ).rejects.toThrow(/cross-repository pull requests are not supported/);
    expect(gitCalls).toEqual([]);
  });
});

describe("GitHubCliScmProvider", () => {
  it("passes evidence through --body-file when a body path is available", async () => {
    const gitCalls: Array<{ cwd: string; args: string[] }> = [];
    const ghCalls: Array<{ file: string; args: string[]; cwd: string }> = [];
    const provider = new GitHubCliScmProvider({
      git: async (cwd, args) => {
        gitCalls.push({ cwd, args });
        if (args[0] === "remote") {
          return "git@github.com:Instask/nitely.git\n";
        }
        return "";
      },
      execFile: async (file, args, options) => {
        ghCalls.push({ file, args, cwd: options.cwd });
        if (args[0] === "pr" && args[1] === "list") {
          return { stdout: "[]" };
        }
        return { stdout: "https://github.com/Instask/nitely/pull/24\n" };
      },
    });

    const result = await provider.publishChange({
      repoPath: "/repo",
      worktreePath: "/repo/.nitely/worktree",
      remoteName: "origin",
      baseBranch: "master",
      headBranch: "nitely/run-1",
      title: "Nitely: test",
      body: "Evidence body",
      bodyPath: "/repo/.nitely/runs/run-1/evidence.md",
    });

    expect(gitCalls).toEqual([
      {
        cwd: "/repo/.nitely/worktree",
        args: ["remote", "get-url", "origin"],
      },
      {
        cwd: "/repo/.nitely/worktree",
        args: ["push", "-u", "origin", "nitely/run-1"],
      },
    ]);
    expect(ghCalls).toEqual([
      {
        file: "gh",
        cwd: "/repo/.nitely/worktree",
        args: [
          "pr",
          "list",
          "--head",
          "nitely/run-1",
          "--base",
          "master",
          "--state",
          "open",
          "--json",
          "number,url,isDraft",
          "--limit",
          "1",
        ],
      },
      {
        file: "gh",
        cwd: "/repo/.nitely/worktree",
        args: [
          "pr",
          "create",
          "--draft",
          "--base",
          "master",
          "--title",
          "Nitely: test",
          "--body-file",
          "/repo/.nitely/runs/run-1/evidence.md",
        ],
      },
    ]);
    expect(result).toMatchObject({
      provider: "github",
      url: "https://github.com/Instask/nitely/pull/24",
      number: 24,
      owner: "Instask",
      repository: "nitely",
      baseBranch: "master",
      headBranch: "nitely/run-1",
      draft: true,
      outcome: "created",
    });
  });

  it("reuses an existing pull request through the GitHub CLI", async () => {
    const ghCalls: Array<{ file: string; args: string[]; cwd: string }> = [];
    const provider = new GitHubCliScmProvider({
      git: async (_cwd, args) => {
        if (args[0] === "remote") {
          return "git@github.com:Instask/nitely.git\n";
        }
        return "";
      },
      execFile: async (file, args, options) => {
        ghCalls.push({ file, args, cwd: options.cwd });
        return {
          stdout: JSON.stringify([
            {
              number: 158,
              url: "https://github.com/Instask/nitely/pull/158",
              isDraft: true,
            },
          ]),
        };
      },
    });

    const result = await provider.publishChange({
      repoPath: "/repo",
      worktreePath: "/repo/.nitely/worktree",
      remoteName: "origin",
      baseBranch: "master",
      headBranch: "nitely/run-1",
      title: "Nitely: retry",
      body: "Evidence body",
    });

    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]?.args.slice(0, 2)).toEqual(["pr", "list"]);
    expect(result).toEqual({
      provider: "github",
      url: "https://github.com/Instask/nitely/pull/158",
      number: 158,
      owner: "Instask",
      repository: "nitely",
      baseBranch: "master",
      headBranch: "nitely/run-1",
      draft: true,
      outcome: "reused",
    });
  });

  it("edits the pull request title after pushing updates to an existing pull request", async () => {
    const gitCalls: Array<{ cwd: string; args: string[] }> = [];
    const ghCalls: Array<{ file: string; args: string[]; cwd: string }> = [];
    const provider = new GitHubCliScmProvider({
      git: async (cwd, args) => {
        gitCalls.push({ cwd, args });
        if (args[0] === "status") {
          return "";
        }
        if (args[0] === "rev-parse") {
          return "def456\n";
        }
        return "";
      },
      execFile: async (file, args, options) => {
        ghCalls.push({ file, args, cwd: options.cwd });
        return { stdout: "" };
      },
    });

    const result = await provider.updateChangeRequest?.({
      repoPath: "/repo",
      worktreePath: "/repo/.nitely/runs/run-1/worktree",
      remoteName: "origin",
      target: {
        provider: "github",
        owner: "Instask",
        repository: "nitely",
        number: 22,
        url: "https://github.com/Instask/nitely/pull/22",
        baseBranch: "master",
        headBranch: "nitely/run-1",
        headSha: "abc123",
        headRepository: { owner: "Instask", repository: "nitely" },
        isCrossRepository: false,
      },
      title: "Nitely: rework",
    });

    expect(gitCalls).toEqual([
      {
        cwd: "/repo/.nitely/runs/run-1/worktree",
        args: ["add", "."],
      },
      {
        cwd: "/repo/.nitely/runs/run-1/worktree",
        args: ["status", "--short"],
      },
      {
        cwd: "/repo/.nitely/runs/run-1/worktree",
        args: ["push", "origin", "HEAD:nitely/run-1"],
      },
      {
        cwd: "/repo/.nitely/runs/run-1/worktree",
        args: ["rev-parse", "HEAD"],
      },
    ]);
    expect(ghCalls).toEqual([
      {
        file: "gh",
        cwd: "/repo/.nitely/runs/run-1/worktree",
        args: ["pr", "edit", "22", "--title", "Nitely: rework"],
      },
    ]);
    expect(result).toMatchObject({
      url: "https://github.com/Instask/nitely/pull/22",
      number: 22,
      previousHeadSha: "abc123",
      updatedHeadSha: "def456",
    });
  });
});
