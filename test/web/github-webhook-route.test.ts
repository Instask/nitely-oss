import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getGitHubWebhookDelivery,
  type GitHubWebhookConfiguration,
} from "../../src/github-webhooks/intake.js";
import { startWebServer, type WebServer } from "../../src/web/server.js";
import { listTasks } from "../../src/web/tasks.js";

const servers: WebServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function createRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "nitely-github-webhook-route-"));
  await mkdir(join(repoPath, "flows"), { recursive: true });
  await writeFile(
    join(repoPath, "flows/implement-spec-bootstrap.json"),
    JSON.stringify({
      apiVersion: "nitely.dev/v1alpha1",
      kind: "Flow",
      metadata: { name: "implement-spec-bootstrap" },
      spec: {
        stages: [
          {
            id: "implement",
            type: "agent",
            runtime: "mock",
            prompt: "Implement.",
            inputs: ["spec", "tech-design"],
            outputs: ["implementation"],
          },
        ],
      },
    }),
    "utf8",
  );
  return repoPath;
}

function delivery(updatedAt = "2026-07-16T03:59:30.000Z") {
  const body = Buffer.from(
    JSON.stringify({
      action: "labeled",
      installation: { id: 123 },
      repository: {
        id: 101,
        full_name: "acme/widgets",
        html_url: "https://github.com/acme/widgets",
      },
      sender: { id: 501, login: "alice" },
      label: { name: "nitely" },
      issue: {
        number: 7,
        html_url: "https://github.com/acme/widgets/issues/7",
        title: "Make imports resumable",
        body: "Persist the import cursor and resume after a restart.",
        state: "open",
        updated_at: updatedAt,
        user: { login: "reporter" },
        assignees: [],
        labels: [{ name: "nitely" }],
      },
    }),
    "utf8",
  );
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-github-delivery": "route-delivery-1",
      "x-github-event": "issues",
      "x-hub-signature-256": `sha256=${createHmac(
        "sha256",
        "route-secret",
      )
        .update(body)
        .digest("hex")}`,
    },
  };
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for webhook processing");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("GitHub webhook Web route", () => {
  it("returns 202 before asynchronous task processing and status publication finish", async () => {
    const repoPath = await createRepo();
    let callbackStartedResolve!: () => void;
    let releaseCallback!: () => void;
    const callbackStarted = new Promise<void>((resolve) => {
      callbackStartedResolve = resolve;
    });
    const blockedCallback = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    const githubWebhook: GitHubWebhookConfiguration = {
      secret: "route-secret",
      repositories: [{ fullName: "acme/widgets", repositoryId: "home" }],
      allowedActors: ["alice"],
      allowedInstallationIds: [123],
      triggerLabels: ["nitely"],
      flowPath: "flows/implement-spec-bootstrap.json",
      maxDeliveryAgeMs: 5 * 60_000,
      now: () => new Date("2026-07-16T04:00:00.000Z"),
      statusPublisher: async () => {
        callbackStartedResolve();
        await blockedCallback;
      },
    };
    const server = await startWebServer({
      repoPath,
      host: "127.0.0.1",
      port: 0,
      githubWebhook,
      repositories: [{ id: "home", name: "home", path: repoPath }],
    });
    servers.push(server);
    const request = delivery();

    const response = await Promise.race([
      fetch(`${server.url}/api/github/webhooks`, {
        method: "POST",
        headers: request.headers,
        body: request.body,
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("webhook response waited for callback")),
          2_000,
        ),
      ),
    ]);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
      deliveryId: "route-delivery-1",
      state: "queued",
    });
    await callbackStarted;
    await expect(listTasks(repoPath)).resolves.toHaveLength(1);
    await expect(
      getGitHubWebhookDelivery(repoPath, "route-delivery-1"),
    ).resolves.toMatchObject({ state: "processing" });

    releaseCallback();
    await waitFor(async () =>
      (await getGitHubWebhookDelivery(repoPath, "route-delivery-1")).state ===
      "completed",
    );
  });

  it("maps signature failures to a 401 JSON response", async () => {
    const repoPath = await createRepo();
    const server = await startWebServer({
      repoPath,
      host: "127.0.0.1",
      port: 0,
      githubWebhook: {
        secret: "route-secret",
        repositories: [{ fullName: "acme/widgets", repositoryId: "home" }],
        allowedActors: ["alice"],
        flowPath: "flows/implement-spec-bootstrap.json",
        now: () => new Date("2026-07-16T04:00:00.000Z"),
      },
      repositories: [{ id: "home", name: "home", path: repoPath }],
    });
    servers.push(server);
    const request = delivery();

    const response = await fetch(`${server.url}/api/github/webhooks`, {
      method: "POST",
      headers: {
        ...request.headers,
        "x-hub-signature-256": "sha256=".padEnd(71, "0"),
      },
      body: request.body,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_signature" },
    });
  });

  it("authenticates a signed webhook even when GitHub sends an Authorization header", async () => {
    const repoPath = await createRepo();
    const server = await startWebServer({
      repoPath,
      host: "127.0.0.1",
      port: 0,
      githubWebhook: {
        secret: "route-secret",
        repositories: [{ fullName: "acme/widgets", repositoryId: "home" }],
        allowedActors: ["alice"],
        flowPath: "flows/implement-spec-bootstrap.json",
        now: () => new Date("2026-07-16T04:00:00.000Z"),
      },
      repositories: [{ id: "home", name: "home", path: repoPath }],
    });
    servers.push(server);
    const request = delivery();

    const response = await fetch(`${server.url}/api/github/webhooks`, {
      method: "POST",
      headers: {
        ...request.headers,
        authorization: "Bearer github-controlled-routing-token",
      },
      body: request.body,
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ accepted: true });
  });

  it("maps an oversized webhook body to a 413 JSON response", async () => {
    const repoPath = await createRepo();
    const server = await startWebServer({
      repoPath,
      host: "127.0.0.1",
      port: 0,
      githubWebhook: {
        secret: "route-secret",
        repositories: [{ fullName: "acme/widgets", repositoryId: "home" }],
        allowedActors: ["alice"],
        flowPath: "flows/implement-spec-bootstrap.json",
        now: () => new Date("2026-07-16T04:00:00.000Z"),
      },
      repositories: [{ id: "home", name: "home", path: repoPath }],
    });
    servers.push(server);
    const request = delivery();

    const response = await fetch(`${server.url}/api/github/webhooks`, {
      method: "POST",
      headers: request.headers,
      body: Buffer.alloc(1024 * 1024 + 1, "x"),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "payload_too_large" },
    });
  });

  it("enables the route from complete environment configuration", async () => {
    const repoPath = await createRepo();
    const server = await startWebServer({
      repoPath,
      host: "127.0.0.1",
      port: 0,
      githubWebhookEnv: {
        NITELY_GITHUB_WEBHOOK_SECRET: "route-secret",
        NITELY_GITHUB_WEBHOOK_REPOSITORIES: "acme/widgets=home",
        NITELY_GITHUB_WEBHOOK_ACTORS: "alice",
        NITELY_GITHUB_WEBHOOK_INSTALLATIONS: "123",
        NITELY_GITHUB_WEBHOOK_LABELS: "nitely",
        NITELY_GITHUB_WEBHOOK_FLOW: "flows/implement-spec-bootstrap.json",
      },
      repositories: [{ id: "home", name: "home", path: repoPath }],
    });
    servers.push(server);
    const request = delivery(new Date().toISOString());

    const response = await fetch(`${server.url}/api/github/webhooks`, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ accepted: true });
  });

  it("keeps the endpoint unavailable without explicit configuration", async () => {
    const repoPath = await createRepo();
    const server = await startWebServer({
      repoPath,
      host: "127.0.0.1",
      port: 0,
      githubWebhookEnv: {},
      repositories: [{ id: "home", name: "home", path: repoPath }],
    });
    servers.push(server);
    const request = delivery();

    const response = await fetch(`${server.url}/api/github/webhooks`, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    });

    expect(response.status).toBe(404);
  });
});
