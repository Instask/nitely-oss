import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  GitHubAppInstallationTokenProvider,
  createGitHubAppStatusPublisher,
  githubAppStatusPublisherFromEnv,
} from "../../src/github-webhooks/checks.js";
import type { GitHubWebhookStatusUpdate } from "../../src/github-webhooks/intake.js";

const now = new Date("2026-07-23T10:00:00.000Z");

const privateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

interface LoggedRequest {
  url: string;
  method: string;
  authorization?: string;
  body?: unknown;
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(
  handler: (request: LoggedRequest) => Response,
): { fetch: typeof fetch; requests: LoggedRequest[] } {
  const requests: LoggedRequest[] = [];
  return {
    requests,
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" && init.body.trim()
        ? JSON.parse(init.body)
        : undefined;
      const request: LoggedRequest = {
        url: String(url),
        method: init?.method ?? "GET",
        authorization: headers.get("authorization") ?? undefined,
        ...(body === undefined ? {} : { body }),
      };
      requests.push(request);
      return handler(request);
    },
  };
}

function jwtPayload(authorization: string | undefined): Record<string, unknown> {
  if (!authorization?.startsWith("Bearer ")) {
    throw new Error("missing bearer authorization");
  }
  const [, payload] = authorization.slice("Bearer ".length).split(".");
  if (!payload) throw new Error("missing JWT payload");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

const taskCreatedUpdate: GitHubWebhookStatusUpdate = {
  state: "task-created",
  deliveryId: "delivery-1",
  installationId: 123,
  repositoryId: 101,
  repositoryFullName: "acme/widgets",
  issueNumber: 7,
  sourceUrl: "https://github.com/acme/widgets/issues/7",
  taskId: "task-1",
  taskPath: "/tasks/task-1",
};

const reworkCreatedUpdate: GitHubWebhookStatusUpdate = {
  state: "rework-request-created",
  deliveryId: "delivery-2",
  installationId: 123,
  repositoryId: 101,
  repositoryFullName: "acme/widgets",
  pullRequestNumber: 9,
  headSha: "abc1234def5678abc1234def5678abc1234def56",
  sourceUrl: "https://github.com/acme/widgets/pull/9#discussion_r100",
  taskId: "task-pr-9",
  reworkRequestId: "tcr_123",
  reworkRequestPath: "/tasks/task-pr-9/rework-requests/tcr_123",
};

describe("GitHub App webhook status publisher", () => {
  it("requests a repository-scoped installation token and publishes a bounded issue comment", async () => {
    const { fetch, requests } = fakeFetch((request) => {
      if (request.url.endsWith("/app/installations/123/access_tokens")) {
        return response(201, {
          token: "installation-token",
          expires_at: "2026-07-23T11:00:00.000Z",
        });
      }
      if (request.url.endsWith("/repos/acme/widgets/issues/7/comments")) {
        return response(201, { id: 701 });
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    });
    const publisher = createGitHubAppStatusPublisher({
      appId: "12345",
      privateKey,
      apiBaseUrl: "https://api.github.test",
      detailsUrlBase: "https://nitely.example",
      now: () => now,
      fetch,
    });

    await expect(publisher(taskCreatedUpdate)).resolves.toEqual({
      provider: "github",
      commentId: 701,
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "https://api.github.test/app/installations/123/access_tokens",
      body: {
        repository_ids: [101],
        permissions: {
          checks: "write",
          issues: "write",
          pull_requests: "write",
        },
      },
    });
    expect(jwtPayload(requests[0]!.authorization)).toMatchObject({
      iss: "12345",
      iat: 1784800740,
      exp: 1784801280,
    });
    expect(requests[1]).toMatchObject({
      method: "POST",
      url: "https://api.github.test/repos/acme/widgets/issues/7/comments",
      authorization: "Bearer installation-token",
    });
    expect(JSON.stringify(requests[1]!.body)).toContain(
      "Nitely webhook status: created draft task task-1",
    );
    expect(JSON.stringify(requests[1]!.body)).toContain(
      "https://nitely.example/tasks/task-1",
    );
    expect(JSON.stringify(requests[1]!.body)).not.toContain(
      "Persist the import cursor",
    );
  });

  it("creates then updates one PR check run and one bounded PR comment", async () => {
    const { fetch, requests } = fakeFetch((request) => {
      if (request.url.endsWith("/app/installations/123/access_tokens")) {
        return response(201, {
          token: "installation-token",
          expires_at: "2026-07-23T11:00:00.000Z",
        });
      }
      if (request.url.endsWith("/repos/acme/widgets/issues/9/comments")) {
        return response(201, { id: 901 });
      }
      if (request.url.endsWith("/repos/acme/widgets/check-runs")) {
        return response(201, { id: 801 });
      }
      if (request.url.endsWith("/repos/acme/widgets/issues/comments/901")) {
        return response(200, { id: 901 });
      }
      if (request.url.endsWith("/repos/acme/widgets/check-runs/801")) {
        return response(200, { id: 801 });
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    });
    const publisher = createGitHubAppStatusPublisher({
      appId: "12345",
      privateKey,
      apiBaseUrl: "https://api.github.test",
      detailsUrlBase: "https://nitely.example",
      checkName: "Nitely webhook",
      now: () => now,
      fetch,
    });

    const first = await publisher(reworkCreatedUpdate);
    if (!first) throw new Error("expected publication metadata");
    const second = await publisher(reworkCreatedUpdate, first);

    expect(first).toEqual({
      provider: "github",
      commentId: 901,
      checkRunId: 801,
    });
    expect(second).toEqual(first);
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "POST https://api.github.test/app/installations/123/access_tokens",
      "POST https://api.github.test/repos/acme/widgets/issues/9/comments",
      "POST https://api.github.test/repos/acme/widgets/check-runs",
      "PATCH https://api.github.test/repos/acme/widgets/issues/comments/901",
      "PATCH https://api.github.test/repos/acme/widgets/check-runs/801",
    ]);
    expect(requests[2]!.body).toMatchObject({
      name: "Nitely webhook",
      head_sha: "abc1234def5678abc1234def5678abc1234def56",
      external_id: "github-webhook:delivery-2",
      status: "completed",
      conclusion: "success",
      output: {
        title: "Nitely webhook accepted",
      },
    });
    expect(JSON.stringify(requests[1]!.body)).not.toContain(
      "regression test",
    );
  });

  it("refreshes an installation token and retries once after GitHub returns 401", async () => {
    let tokenRequests = 0;
    const { fetch, requests } = fakeFetch((request) => {
      if (request.url.endsWith("/app/installations/123/access_tokens")) {
        tokenRequests += 1;
        return response(201, {
          token: `installation-token-${tokenRequests}`,
          expires_at: "2026-07-23T11:00:00.000Z",
        });
      }
      if (
        request.url.endsWith("/repos/acme/widgets/issues/9/comments") &&
        request.authorization === "Bearer installation-token-1"
      ) {
        return response(401, { message: "Bad credentials" });
      }
      if (
        request.url.endsWith("/repos/acme/widgets/issues/9/comments") &&
        request.authorization === "Bearer installation-token-2"
      ) {
        return response(201, { id: 901 });
      }
      if (request.url.endsWith("/repos/acme/widgets/check-runs")) {
        return response(201, { id: 801 });
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    });
    const publisher = createGitHubAppStatusPublisher({
      appId: "12345",
      privateKey,
      apiBaseUrl: "https://api.github.test",
      now: () => now,
      fetch,
    });

    await expect(publisher(reworkCreatedUpdate)).resolves.toMatchObject({
      provider: "github",
      commentId: 901,
      checkRunId: 801,
    });

    expect(requests.map((request) => request.authorization)).toEqual([
      expect.stringMatching(/^Bearer /),
      "Bearer installation-token-1",
      expect.stringMatching(/^Bearer /),
      "Bearer installation-token-2",
      "Bearer installation-token-2",
    ]);
  });

  it("refreshes installation tokens before their expiry window", async () => {
    let tokenRequests = 0;
    const { fetch } = fakeFetch((request) => {
      if (!request.url.endsWith("/app/installations/123/access_tokens")) {
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      }
      tokenRequests += 1;
      return response(201, {
        token: `installation-token-${tokenRequests}`,
        expires_at: tokenRequests === 1
          ? "2026-07-23T10:02:00.000Z"
          : "2026-07-23T11:00:00.000Z",
      });
    });
    const provider = new GitHubAppInstallationTokenProvider({
      appId: "12345",
      privateKey,
      apiBaseUrl: "https://api.github.test",
      now: () => now,
      fetch,
    });

    await expect(
      provider.token({ installationId: 123, repositoryId: 101 }),
    ).resolves.toBe("installation-token-1");
    await expect(
      provider.token({ installationId: 123, repositoryId: 101 }),
    ).resolves.toBe("installation-token-2");
  });

  it("parses fail-closed GitHub App status publisher environment configuration", () => {
    expect(githubAppStatusPublisherFromEnv({})).toBeUndefined();
    expect(() =>
      githubAppStatusPublisherFromEnv({
        NITELY_GITHUB_APP_ID: "12345",
      }),
    ).toThrow("GitHub App status publisher configuration is incomplete");
    expect(() =>
      githubAppStatusPublisherFromEnv({
        NITELY_GITHUB_APP_ID: "12345",
        NITELY_GITHUB_APP_PRIVATE_KEY: privateKey,
        NITELY_GITHUB_APP_PRIVATE_KEY_BASE64:
          Buffer.from(privateKey, "utf8").toString("base64"),
      }),
    ).toThrow("private key is ambiguous");
    expect(
      githubAppStatusPublisherFromEnv({
        NITELY_GITHUB_APP_ID: "12345",
        NITELY_GITHUB_APP_PRIVATE_KEY_BASE64:
          Buffer.from(privateKey, "utf8").toString("base64"),
      }),
    ).toEqual(expect.any(Function));
  });
});
