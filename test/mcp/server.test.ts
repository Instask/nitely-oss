import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  createNitelyMcpServer,
  type NitelyMcpServerInput,
} from "../../src/mcp/server.js";
import {
  apiTokenAuditPath,
  createApiToken,
} from "../../src/web/api-tokens.js";
import { startWebServer } from "../../src/web/server.js";
import { createTokenOwner } from "../helpers/token-owner.js";

async function connectClient(input: NitelyMcpServerInput) {
  const server = createNitelyMcpServer(input);
  const client = new Client({ name: "nitely-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Nitely MCP server", () => {
  it("lists the first-slice tools and maps every call onto the existing JSON API", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const connected = await connectClient({
      serverUrl: "http://127.0.0.1:4173/",
      apiToken: "nitely_api_test_secret",
      fetch: async (input, init) => {
        requests.push({ url: String(input), init });
        return jsonResponse({ request: requests.length });
      },
    });

    try {
      const tools = await connected.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "list_tasks",
        "list_flows",
        "get_task",
        "create_task",
        "draft_spec",
        "approve_spec",
        "draft_tech_design",
        "approve_tech_design",
        "start_run",
        "list_runs",
        "get_run",
        "preview_start",
        "preview_stop",
        "preview_navigate",
        "preview_reload",
        "preview_capture_screenshot",
        "preview_get_diagnostics",
        "preview_get_view_hierarchy",
        "preview_click",
        "preview_type",
        "preview_scroll",
        "preview_compare_with_reference",
      ]);
      expect(tools.tools.find((tool) => tool.name === "list_tasks")?.annotations)
        .toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tools.tools.find((tool) => tool.name === "list_flows")?.annotations)
        .toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tools.tools.find((tool) => tool.name === "start_run")?.annotations)
        .toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(tools.tools.find((tool) => tool.name === "draft_spec")?.inputSchema)
        .toMatchObject({
          properties: {
            sourceType: {
              enum: expect.arrayContaining([
                "github-issue",
                "jira-ticket",
                "external-document",
                "prompt",
              ]),
            },
            issue: expect.objectContaining({ type: "string" }),
            documentUrl: expect.objectContaining({ type: "string" }),
            conversation: expect.objectContaining({ type: "array" }),
            syncStatus: expect.objectContaining({ type: "boolean" }),
            publicBaseUrl: expect.objectContaining({ type: "string" }),
          },
        });

      const results = [];
      results.push(await connected.client.callTool({ name: "list_tasks", arguments: {} }));
      results.push(await connected.client.callTool({ name: "list_flows", arguments: {} }));
      results.push(await connected.client.callTool({
        name: "get_task",
        arguments: { taskId: "task / 1" },
      }));
      results.push(await connected.client.callTool({
        name: "create_task",
        arguments: {
          title: "MCP task",
          spec: "Spec body",
          techDesign: "Design body",
          planningStatus: "draft",
          issueUrl: "https://github.com/Instask/nitely/issues/396",
          repoId: "nitely",
        },
      }));
      results.push(await connected.client.callTool({
        name: "draft_spec",
        arguments: {
          sourceType: "prompt",
          title: "Prompt task",
          prompt: "Build the feature",
          guidance: "Keep it local-first",
        },
      }));
      results.push(await connected.client.callTool({
        name: "approve_spec",
        arguments: { taskId: "task-1" },
      }));
      results.push(await connected.client.callTool({
        name: "draft_tech_design",
        arguments: { taskId: "task-1" },
      }));
      results.push(await connected.client.callTool({
        name: "approve_tech_design",
        arguments: { taskId: "task-1" },
      }));
      results.push(await connected.client.callTool({
        name: "start_run",
        arguments: {
          taskId: "task-1",
          override: true,
          reason: "Reviewed by operator",
          taskScope: { inputId: "spec", expression: "FR-001" },
        },
      }));
      results.push(await connected.client.callTool({ name: "list_runs", arguments: {} }));
      results.push(await connected.client.callTool({
        name: "get_run",
        arguments: { runId: "run / 1" },
      }));
      results.push(await connected.client.callTool({
        name: "preview_start",
        arguments: {
          repoId: "home",
          commandId: "web",
          runId: "run-1",
          route: "/app",
          viewport: { preset: "mobile" },
        },
      }));
      results.push(await connected.client.callTool({
        name: "preview_stop",
        arguments: { sessionId: "pvs_1111111111111111" },
      }));
      results.push(await connected.client.callTool({
        name: "preview_navigate",
        arguments: {
          sessionId: "pvs_1111111111111111",
          url: "/app/settings",
        },
      }));
      results.push(await connected.client.callTool({
        name: "preview_reload",
        arguments: { sessionId: "pvs_1111111111111111" },
      }));
      results.push(await connected.client.callTool({
        name: "preview_capture_screenshot",
        arguments: {
          sessionId: "pvs_1111111111111111",
          fullPage: true,
        },
      }));
      results.push(await connected.client.callTool({
        name: "preview_get_diagnostics",
        arguments: { sessionId: "pvs_1111111111111111" },
      }));
      results.push(await connected.client.callTool({
        name: "preview_get_view_hierarchy",
        arguments: { sessionId: "pvs_1111111111111111" },
      }));
      results.push(await connected.client.callTool({
        name: "preview_click",
        arguments: {
          sessionId: "pvs_1111111111111111",
          selector: "#launch",
        },
      }));
      results.push(await connected.client.callTool({
        name: "preview_type",
        arguments: {
          sessionId: "pvs_1111111111111111",
          selector: "#name",
          text: "Nitely",
        },
      }));
      results.push(await connected.client.callTool({
        name: "preview_scroll",
        arguments: {
          sessionId: "pvs_1111111111111111",
          deltaY: 240,
        },
      }));
      results.push(await connected.client.callTool({
        name: "preview_compare_with_reference",
        arguments: {
          sessionId: "pvs_1111111111111111",
          runId: "run-1",
          comparisonId: "visual-main",
          reference: { artifactId: "approved-reference", artifactProducer: "fixtures" },
          screenshotId: "preview-screenshot-123",
          pixelmatchThreshold: 0.1,
          allowedChangedPixelRatio: 0,
        },
      }));

      for (const [index, result] of results.entries()) {
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({ request: index + 1 });
        expect(result.content).toEqual([
          { type: "text", text: JSON.stringify({ request: index + 1 }, null, 2) },
        ]);
      }
      expect(requests.map(({ url, init }) => ({
        url,
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      }))).toEqual([
        {
          url: "http://127.0.0.1:4173/api/tasks",
          method: "GET",
          authorization: "Bearer nitely_api_test_secret",
        },
        {
          url: "http://127.0.0.1:4173/api/flows",
          method: "GET",
          authorization: "Bearer nitely_api_test_secret",
        },
        {
          url: "http://127.0.0.1:4173/api/tasks/task%20%2F%201",
          method: "GET",
          authorization: "Bearer nitely_api_test_secret",
        },
        {
          url: "http://127.0.0.1:4173/api/tasks",
          method: "POST",
          authorization: "Bearer nitely_api_test_secret",
          body: {
            title: "MCP task",
            spec: "Spec body",
            techDesign: "Design body",
            planningStatus: "draft",
            issueUrl: "https://github.com/Instask/nitely/issues/396",
            repoId: "nitely",
          },
        },
        {
          url: "http://127.0.0.1:4173/api/draft-specs",
          method: "POST",
          authorization: "Bearer nitely_api_test_secret",
          body: {
            sourceType: "prompt",
            title: "Prompt task",
            prompt: "Build the feature",
            guidance: "Keep it local-first",
          },
        },
        {
          url: "http://127.0.0.1:4173/api/tasks/task-1/approve-spec",
          method: "POST",
          authorization: "Bearer nitely_api_test_secret",
          body: {},
        },
        {
          url: "http://127.0.0.1:4173/api/tasks/task-1/draft-tech-design",
          method: "POST",
          authorization: "Bearer nitely_api_test_secret",
          body: {},
        },
        {
          url: "http://127.0.0.1:4173/api/tasks/task-1/approve-tech-design",
          method: "POST",
          authorization: "Bearer nitely_api_test_secret",
          body: {},
        },
        {
          url: "http://127.0.0.1:4173/api/tasks/task-1/runs?override=true",
          method: "POST",
          authorization: "Bearer nitely_api_test_secret",
          body: {
            reason: "Reviewed by operator",
            taskScope: { inputId: "spec", expression: "FR-001" },
          },
        },
        {
          url: "http://127.0.0.1:4173/api/runs",
          method: "GET",
          authorization: "Bearer nitely_api_test_secret",
        },
        {
          url: "http://127.0.0.1:4173/api/runs/run%20%2F%201",
          method: "GET",
          authorization: "Bearer nitely_api_test_secret",
        },
        {
          url: "http://127.0.0.1:4173/api/preview-sessions",
          method: "POST",
          authorization: "Bearer nitely_api_test_secret",
          body: {
            repoId: "home",
            commandId: "web",
            runId: "run-1",
            route: "/app",
            viewport: { preset: "mobile" },
          },
        },
        {
          url: "http://127.0.0.1:4173/api/preview-sessions/pvs_1111111111111111/stop",
          method: "POST",
          authorization: "Bearer nitely_api_test_secret",
          body: {},
        },
        {
          url: "http://127.0.0.1:4173/api/preview-sessions/pvs_1111111111111111/navigate",
          method: "POST",
          authorization: "Bearer nitely_api_test_secret",
          body: { url: "/app/settings" },
        },
        {
          url: "http://127.0.0.1:4173/api/preview-sessions/pvs_1111111111111111/reload",
          method: "POST",
          authorization: "Bearer nitely_api_test_secret",
          body: {},
        },
        {
          url: "http://127.0.0.1:4173/api/preview-sessions/pvs_1111111111111111/screenshot",
          method: "POST",
          authorization: "Bearer nitely_api_test_secret",
          body: { fullPage: true },
        },
        {
          url: "http://127.0.0.1:4173/api/preview-sessions/pvs_1111111111111111/diagnostics",
          method: "GET",
          authorization: "Bearer nitely_api_test_secret",
        },
        {
          url: "http://127.0.0.1:4173/api/preview-sessions/pvs_1111111111111111/hierarchy",
          method: "GET",
          authorization: "Bearer nitely_api_test_secret",
        },
        {
          url: "http://127.0.0.1:4173/api/preview-sessions/pvs_1111111111111111/click",
          method: "POST",
          authorization: "Bearer nitely_api_test_secret",
          body: { selector: "#launch" },
        },
        {
          url: "http://127.0.0.1:4173/api/preview-sessions/pvs_1111111111111111/type",
          method: "POST",
          authorization: "Bearer nitely_api_test_secret",
          body: { selector: "#name", text: "Nitely" },
        },
        {
          url: "http://127.0.0.1:4173/api/preview-sessions/pvs_1111111111111111/scroll",
          method: "POST",
          authorization: "Bearer nitely_api_test_secret",
          body: { deltaY: 240 },
        },
        {
          url: "http://127.0.0.1:4173/api/preview-sessions/pvs_1111111111111111/compare-reference",
          method: "POST",
          authorization: "Bearer nitely_api_test_secret",
          body: {
            runId: "run-1",
            comparisonId: "visual-main",
            reference: {
              artifactId: "approved-reference",
              artifactProducer: "fixtures",
            },
            screenshotId: "preview-screenshot-123",
            pixelmatchThreshold: 0.1,
            allowedChangedPixelRatio: 0,
          },
        },
      ]);
    } finally {
      await connected.close();
    }
  });

  it("drafts specs from github-issue, external-document, and conversation-only prompt intake", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const connected = await connectClient({
      serverUrl: "http://127.0.0.1:4173/",
      apiToken: "nitely_api_test_secret",
      fetch: async (input, init) => {
        requests.push({ url: String(input), init });
        return jsonResponse({ request: requests.length });
      },
    });

    try {
      const results = [];
      results.push(await connected.client.callTool({
        name: "draft_spec",
        arguments: {
          sourceType: "github-issue",
          issue: "https://github.com/Instask/nitely/issues/578",
          title: "Planning intake",
        },
      }));
      results.push(await connected.client.callTool({
        name: "draft_spec",
        arguments: {
          sourceType: "external-document",
          documentUrl: "https://example.feishu.cn/docx/ABC123",
          text: "Every release publishes a draft PR.",
          documentVersion: "rev-42",
        },
      }));
      results.push(await connected.client.callTool({
        name: "draft_spec",
        arguments: {
          sourceType: "prompt",
          conversation: [
            { role: "operator", text: "Import repositories from a pasted URL." },
            { role: "agent", text: "Which providers?" },
            { role: "operator", text: "GitHub only." },
          ],
        },
      }));

      for (const [index, result] of results.entries()) {
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({ request: index + 1 });
      }
      expect(requests.map(({ url, init }) => ({
        url,
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      }))).toEqual([
        {
          url: "http://127.0.0.1:4173/api/draft-specs",
          method: "POST",
          authorization: "Bearer nitely_api_test_secret",
          body: {
            sourceType: "github-issue",
            issue: "https://github.com/Instask/nitely/issues/578",
            title: "Planning intake",
          },
        },
        {
          url: "http://127.0.0.1:4173/api/draft-specs",
          method: "POST",
          authorization: "Bearer nitely_api_test_secret",
          body: {
            sourceType: "external-document",
            documentUrl: "https://example.feishu.cn/docx/ABC123",
            text: "Every release publishes a draft PR.",
            documentVersion: "rev-42",
          },
        },
        {
          url: "http://127.0.0.1:4173/api/draft-specs",
          method: "POST",
          authorization: "Bearer nitely_api_test_secret",
          body: {
            sourceType: "prompt",
            conversation: [
              { role: "operator", text: "Import repositories from a pasted URL." },
              { role: "agent", text: "Which providers?" },
              { role: "operator", text: "GitHub only." },
            ],
          },
        },
      ]);
    } finally {
      await connected.close();
    }
  });

  it("returns stable API errors as tool errors without echoing credentials", async () => {
    const connected = await connectClient({
      serverUrl: "http://server.test",
      apiToken: "never-echo-this-token",
      fetch: async () => jsonResponse(
        {
          error: {
            code: "capability_denied",
            message: "API token capability denied: runs:start is required (never-echo-this-token)",
          },
        },
        403,
      ),
    });
    try {
      const result = await connected.client.callTool({
        name: "start_run",
        arguments: { taskId: "task-1" },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: {
          code: "capability_denied",
          message: "API token capability denied: runs:start is required ([REDACTED])",
          httpStatus: 403,
        },
      });
      expect(JSON.stringify(result)).not.toContain("never-echo-this-token");
    } finally {
      await connected.close();
    }
  });

  it("rate-limits accidental local tool loops before another API request", async () => {
    let requests = 0;
    const connected = await connectClient({
      serverUrl: "http://server.test",
      apiToken: "token",
      fetch: async () => {
        requests += 1;
        return jsonResponse({ tasks: [] });
      },
      rateLimit: { maxCalls: 1, windowMs: 60_000 },
    });
    try {
      const first = await connected.client.callTool({ name: "list_tasks", arguments: {} });
      const second = await connected.client.callTool({ name: "list_tasks", arguments: {} });
      expect(first.isError).not.toBe(true);
      expect(second.isError).toBe(true);
      expect(second.structuredContent).toEqual({
        error: {
          code: "rate_limited",
          message: "Nitely MCP tool call rate limit exceeded",
        },
      });
      expect(requests).toBe(1);
    } finally {
      await connected.close();
    }
  });

  it("creates, approves, starts, and polls through SDK calls against a real Web server", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-mcp-integration-"));
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
    const token = await createApiToken(repoPath, {
      name: "MCP integration",
      capabilities: [
        "tasks:read",
        "tasks:write",
        "runs:read",
        "runs:start",
        "spec:approve",
      ],
      ownerUserId: (await createTokenOwner(repoPath)).id,
      allowHighImpact: true,
    });
    const web = await startWebServer({
      repoPath,
      host: "127.0.0.1",
      port: 0,
      runFlow: async (_input, dependencies) => {
        const runId = dependencies?.createRunId?.() ?? "run-mcp-integration";
        return {
          runId,
          branchName: `nitely/${runId}`,
          worktreePath: join(repoPath, ".nitely", "worktrees", runId),
        };
      },
      repositories: [{ id: "home", name: "home", path: repoPath }],
    });
    const connected = await connectClient({
      serverUrl: web.url,
      apiToken: token.token,
    });
    try {
      const created = await connected.client.callTool({
        name: "create_task",
        arguments: {
          title: "Created through MCP",
          spec: "Spec body",
          techDesign: "Design body",
          planningStatus: "draft",
        },
      });
      expect(created.isError).not.toBe(true);
      expect(created.structuredContent).toMatchObject({
        task: {
          title: "Created through MCP",
          status: "draft",
          specStatus: "draft",
          techDesignStatus: "draft",
        },
      });
      const taskId = (
        created.structuredContent as { task: { id: string } }
      ).task.id;

      const approvedSpec = await connected.client.callTool({
        name: "approve_spec",
        arguments: { taskId },
      });
      expect(approvedSpec.isError).not.toBe(true);
      expect(approvedSpec.structuredContent).toMatchObject({
        task: { specStatus: "approved", techDesignStatus: "draft" },
      });

      const approvedDesign = await connected.client.callTool({
        name: "approve_tech_design",
        arguments: { taskId },
      });
      expect(approvedDesign.isError).not.toBe(true);
      expect(approvedDesign.structuredContent).toMatchObject({
        task: { status: "ready", techDesignStatus: "approved" },
      });

      const started = await connected.client.callTool({
        name: "start_run",
        arguments: {
          taskId,
          override: true,
          reason: "MCP acceptance test",
        },
      });
      expect(started.isError).not.toBe(true);
      expect(started.structuredContent).toMatchObject({
        run: { runId: expect.any(String) },
      });
      const runId = (
        started.structuredContent as { run: { runId: string } }
      ).run.runId;

      let polled = await connected.client.callTool({
        name: "get_run",
        arguments: { runId },
      });
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (
          (polled.structuredContent as { run?: { status?: string } })?.run
            ?.status === "completed"
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        polled = await connected.client.callTool({
          name: "get_run",
          arguments: { runId },
        });
      }
      expect(polled.isError).not.toBe(true);
      expect(polled.structuredContent).toMatchObject({
        run: { runId, status: "completed" },
      });

      const listed = await connected.client.callTool({
        name: "list_tasks",
        arguments: {},
      });
      expect(listed.structuredContent).toMatchObject({
        tasks: [expect.objectContaining({ title: "Created through MCP" })],
      });
    } finally {
      await connected.close();
      await web.close();
    }
  });

  it("serves clean MCP frames over the CLI stdio command", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "nitely-mcp-stdio-"));
    const token = await createApiToken(repoPath, {
      name: "stdio integration",
      capabilities: ["tasks:read"],
      ownerUserId: (await createTokenOwner(repoPath)).id,
    });
    const web = await startWebServer({
      repoPath,
      host: "127.0.0.1",
      port: 0,
      repositories: [{ id: "home", name: "home", path: repoPath }],
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        join(process.cwd(), "src/index.ts"),
        "mcp",
        "serve",
        "--server",
        web.url,
      ],
      env: { NITELY_API_TOKEN: token.token },
      cwd: process.cwd(),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const client = new Client({ name: "stdio-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("list_tasks");
      const result = await client.callTool({
        name: "list_tasks",
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ tasks: [] });

      const denied = await client.callTool({
        name: "start_run",
        arguments: { taskId: "missing-task" },
      });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toEqual({
        error: {
          code: "capability_denied",
          message: "API token capability denied: runs:start is required",
          httpStatus: 403,
        },
      });
      let audit = "";
      for (let attempt = 0; attempt < 50; attempt += 1) {
        audit = await readFile(apiTokenAuditPath(repoPath), "utf8");
        if (audit.includes('"reasonCode":"capability_denied"')) break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
      expect(audit).toContain('"action":"runs.start"');
      expect(audit).toContain('"decision":"deny"');
      expect(audit).toContain('"reasonCode":"capability_denied"');
      expect(audit).not.toContain(token.token);
      expect(stderr).toBe("");
    } finally {
      await client.close();
      await web.close();
    }
  });
});
