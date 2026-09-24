import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

type FetchFunction = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface NitelyMcpServerInput {
  serverUrl: string;
  apiToken: string;
  fetch?: FetchFunction;
  rateLimit?: { maxCalls: number; windowMs: number };
}

class NitelyApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "NitelyApiError";
  }
}

class ToolCallRateLimiter {
  private calls: number[] = [];

  constructor(
    private readonly maxCalls: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(maxCalls) || maxCalls <= 0) {
      throw new Error("MCP rate limit maxCalls must be a positive integer");
    }
    if (!Number.isInteger(windowMs) || windowMs <= 0) {
      throw new Error("MCP rate limit windowMs must be a positive integer");
    }
  }

  take(): void {
    const current = this.now();
    const earliest = current - this.windowMs;
    this.calls = this.calls.filter((timestamp) => timestamp > earliest);
    if (this.calls.length >= this.maxCalls) {
      throw new NitelyApiError(
        "rate_limited",
        "Nitely MCP tool call rate limit exceeded",
      );
    }
    this.calls.push(current);
  }
}

function normalizeServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid Nitely server URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Nitely server URL must use http or https");
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("Nitely server URL must not contain a path, query, or fragment");
  }
  return url.origin;
}

function objectPayload(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function redactSecret(value: unknown, secret: string): unknown {
  if (typeof value === "string") {
    return value.split(secret).join("[REDACTED]");
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecret(item, secret));
  }
  const object = objectPayload(value);
  return object
    ? Object.fromEntries(
        Object.entries(object).map(([key, item]) => [
          key.split(secret).join("[REDACTED]"),
          redactSecret(item, secret),
        ]),
      )
    : value;
}

function apiErrorFromPayload(
  status: number,
  payload: unknown,
): NitelyApiError {
  const root = objectPayload(payload);
  const error = objectPayload(root?.error);
  const code =
    typeof error?.code === "string" && error.code
      ? error.code
      : "api_error";
  const message =
    typeof error?.message === "string" && error.message
      ? error.message
      : `Nitely API request failed (HTTP ${status})`;
  return new NitelyApiError(code, message, status);
}

class NitelyApiClient {
  private readonly serverUrl: string;
  private readonly fetchImpl: FetchFunction;

  constructor(
    serverUrl: string,
    private readonly apiToken: string,
    fetchImpl?: FetchFunction,
  ) {
    this.serverUrl = normalizeServerUrl(serverUrl);
    if (!apiToken) throw new Error("Nitely API token is required");
    this.fetchImpl = fetchImpl ?? fetch;
  }

  async request(
    path: string,
    init: { method?: "GET" | "POST"; body?: Record<string, unknown> } = {},
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.serverUrl}${path}`, {
        method: init.method ?? "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.apiToken}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      throw new NitelyApiError(
        "api_unavailable",
        "Nitely API request failed: server unavailable",
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new NitelyApiError(
        "invalid_api_response",
        `Nitely API returned invalid JSON (HTTP ${response.status})`,
        response.status,
      );
    }
    payload = redactSecret(payload, this.apiToken);
    if (!response.ok) throw apiErrorFromPayload(response.status, payload);
    const object = objectPayload(payload);
    if (!object) {
      throw new NitelyApiError(
        "invalid_api_response",
        "Nitely API returned a non-object JSON response",
        response.status,
      );
    }
    return object;
  }
}

function successResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function errorResult(error: unknown): CallToolResult {
  const safe =
    error instanceof NitelyApiError
      ? {
          code: error.code,
          message: error.message,
          ...(error.httpStatus !== undefined
            ? { httpStatus: error.httpStatus }
            : {}),
        }
      : {
          code: "mcp_internal_error",
          message: "Nitely MCP tool call failed",
        };
  const payload = { error: safe };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const externalWriteAnnotations = {
  ...writeAnnotations,
  openWorldHint: true,
} as const;

const approvalAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const runAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const idSchema = z.string().trim().min(1);
const emptySchema = z.object({}).strict();
const previewSessionIdSchema = z.string().trim().regex(/^pvs_[a-f0-9]{16}$/);
const previewViewportSchema = z
  .object({
    preset: z.string().trim().min(1).optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    deviceScaleFactor: z.number().positive().optional(),
    isMobile: z.boolean().optional(),
  })
  .strict()
  .optional();
const visualComparisonImageSchema = z
  .object({
    artifactId: z.string().trim().min(1).optional(),
    artifactProducer: z.string().trim().min(1).optional(),
    path: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1).optional(),
    sourceUri: z.string().trim().min(1).optional(),
    mediaType: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((value) => value.artifactId || value.path, {
    message: "artifactId or path is required",
  });
const visualComparisonThresholdSchema = {
  pixelmatchThreshold: z.number().min(0).max(1).optional(),
  includeAntiAliased: z.boolean().optional(),
  allowedChangedPixelCount: z.number().int().nonnegative().optional(),
  allowedChangedPixelRatio: z.number().min(0).max(1).optional(),
  overlayOpacity: z.number().min(0).max(1).optional(),
} as const;

export function createNitelyMcpServer(input: NitelyMcpServerInput): McpServer {
  const api = new NitelyApiClient(input.serverUrl, input.apiToken, input.fetch);
  const rateLimit = input.rateLimit ?? { maxCalls: 120, windowMs: 60_000 };
  const limiter = new ToolCallRateLimiter(
    rateLimit.maxCalls,
    rateLimit.windowMs,
  );
  const server = new McpServer({ name: "nitely", version: "0.1.0" });
  const execute = async (
    call: () => Promise<Record<string, unknown>>,
  ): Promise<CallToolResult> => {
    try {
      limiter.take();
      return successResult(await call());
    } catch (error) {
      return errorResult(error);
    }
  };

  server.registerTool(
    "list_tasks",
    {
      title: "List Nitely tasks",
      description: "List visible Nitely tasks. Requires tasks:read.",
      inputSchema: emptySchema,
      annotations: readOnlyAnnotations,
    },
    async () => await execute(() => api.request("/api/tasks")),
  );
  server.registerTool(
    "list_flows",
    {
      title: "List Nitely flows",
      description:
        "List the flows this instance exposes, with id, source, and runnable state. Pass an id as flowPath when creating a task. Requires tasks:read.",
      inputSchema: emptySchema,
      annotations: readOnlyAnnotations,
    },
    async () => await execute(() => api.request("/api/flows")),
  );
  server.registerTool(
    "get_task",
    {
      title: "Get a Nitely task",
      description: "Get task planning, run, and artifact details. Requires tasks:read.",
      inputSchema: z.object({ taskId: idSchema }).strict(),
      annotations: readOnlyAnnotations,
    },
    async ({ taskId }) =>
      await execute(() => api.request(`/api/tasks/${encodeURIComponent(taskId)}`)),
  );
  server.registerTool(
    "create_task",
    {
      title: "Create a Nitely task",
      description: "Create a task from supplied spec and technical design. Requires tasks:write.",
      inputSchema: z
        .object({
          title: z.string().trim().min(1),
          spec: z.string().min(1),
          techDesign: z.string().min(1),
          planningStatus: z.enum(["draft", "ready"]).optional(),
          repoId: z.string().trim().min(1).optional(),
          issueUrl: z.string().trim().min(1).optional(),
          flowPath: z.string().trim().min(1).optional(),
          templateId: z.string().trim().min(1).optional(),
        })
        .strict(),
      annotations: writeAnnotations,
    },
    async (arguments_) =>
      await execute(() =>
        api.request("/api/tasks", { method: "POST", body: arguments_ }),
      ),
  );
  server.registerTool(
    "draft_spec",
    {
      title: "Draft a Nitely spec",
      description: "Create a draft planning task from a prompt, conversation, text, GitHub issue, Jira ticket, or external document. Requires tasks:write.",
      inputSchema: z
        .object({
          sourceType: z.enum([
            "prompt",
            "text",
            "github-issue",
            "jira-ticket",
            "external-document",
          ]),
          prompt: z.string().min(1).optional(),
          text: z.string().min(1).optional(),
          issue: z.string().min(1).optional(),
          documentUrl: z.string().url().optional(),
          documentVersion: z.string().trim().min(1).optional(),
          documentExternalId: z.string().trim().min(1).optional(),
          conversation: z
            .array(
              z
                .object({
                  role: z.enum(["operator", "agent"]),
                  text: z.string().trim().min(1),
                  at: z.string().trim().min(1).optional(),
                })
                .strict(),
            )
            .min(1)
            .optional(),
          title: z.string().trim().min(1).optional(),
          guidance: z.string().trim().min(1).optional(),
          flowPath: z.string().trim().min(1).optional(),
          templateId: z.string().trim().min(1).optional(),
          repoId: z.string().trim().min(1).optional(),
          syncStatus: z.boolean().optional(),
          publicBaseUrl: z.string().url().optional(),
        })
        .strict()
        .superRefine((value, context) => {
          const required =
            value.sourceType === "prompt"
              ? "prompt"
              : value.sourceType === "text" ||
                  value.sourceType === "external-document"
                ? "text"
                : "issue";
          const promptFromConversation =
            value.sourceType === "prompt" && value.conversation !== undefined;
          if (!value[required] && !promptFromConversation) {
            context.addIssue({
              code: "custom",
              path: [required],
              message: `${required} is required for sourceType ${value.sourceType}`,
            });
          }
          if (value.sourceType === "external-document" && !value.documentUrl) {
            context.addIssue({
              code: "custom",
              path: ["documentUrl"],
              message: "documentUrl is required for sourceType external-document",
            });
          }
          for (const field of [
            "documentUrl",
            "documentVersion",
            "documentExternalId",
          ] as const) {
            if (value[field] && value.sourceType !== "external-document") {
              context.addIssue({
                code: "custom",
                path: [field],
                message: `${field} is only supported for external-document intake`,
              });
            }
          }
          if (
            value.conversation &&
            value.sourceType !== "prompt" &&
            value.sourceType !== "text"
          ) {
            context.addIssue({
              code: "custom",
              path: ["conversation"],
              message: "conversation is only supported for prompt or text intake",
            });
          }
          if (value.syncStatus !== undefined && value.sourceType !== "jira-ticket") {
            context.addIssue({
              code: "custom",
              path: ["syncStatus"],
              message: "syncStatus is only supported for jira-ticket intake",
            });
          }
          if (value.publicBaseUrl && value.sourceType !== "jira-ticket") {
            context.addIssue({
              code: "custom",
              path: ["publicBaseUrl"],
              message: "publicBaseUrl is only supported for jira-ticket intake",
            });
          }
          if (value.syncStatus && !value.publicBaseUrl) {
            context.addIssue({
              code: "custom",
              path: ["publicBaseUrl"],
              message: "publicBaseUrl is required when Jira status sync is enabled",
            });
          }
        }),
      annotations: externalWriteAnnotations,
    },
    async (arguments_) =>
      await execute(() =>
        api.request("/api/draft-specs", { method: "POST", body: arguments_ }),
      ),
  );
  server.registerTool(
    "approve_spec",
    {
      title: "Approve a Nitely spec",
      description: "Approve the current task spec after human review. Requires spec:approve.",
      inputSchema: z.object({ taskId: idSchema }).strict(),
      annotations: approvalAnnotations,
    },
    async ({ taskId }) =>
      await execute(() =>
        api.request(`/api/tasks/${encodeURIComponent(taskId)}/approve-spec`, {
          method: "POST",
          body: {},
        }),
      ),
  );
  server.registerTool(
    "draft_tech_design",
    {
      title: "Draft a Nitely technical design",
      description:
        "Generate a repository-grounded draft technical design from the approved spec. Requires tasks:write.",
      inputSchema: z.object({ taskId: idSchema }).strict(),
      annotations: writeAnnotations,
    },
    async ({ taskId }) =>
      await execute(() =>
        api.request(
          `/api/tasks/${encodeURIComponent(taskId)}/draft-tech-design`,
          { method: "POST", body: {} },
        ),
      ),
  );
  server.registerTool(
    "approve_tech_design",
    {
      title: "Approve a Nitely technical design",
      description: "Approve the current technical design after human review. Requires spec:approve.",
      inputSchema: z.object({ taskId: idSchema }).strict(),
      annotations: approvalAnnotations,
    },
    async ({ taskId }) =>
      await execute(() =>
        api.request(
          `/api/tasks/${encodeURIComponent(taskId)}/approve-tech-design`,
          { method: "POST", body: {} },
        ),
      ),
  );
  server.registerTool(
    "start_run",
    {
      title: "Start a Nitely run",
      description: "Start an approved task run. Requires runs:start and may launch coding/publish stages.",
      inputSchema: z
        .object({
          taskId: idSchema,
          override: z.boolean().optional(),
          reason: z.string().trim().min(1).optional(),
          taskScope: z
            .object({
              inputId: z.string().trim().min(1),
              expression: z.string().trim().min(1),
            })
            .strict()
            .optional(),
        })
        .strict(),
      annotations: runAnnotations,
    },
    async ({ taskId, override, reason, taskScope }) =>
      await execute(() =>
        api.request(
          `/api/tasks/${encodeURIComponent(taskId)}/runs${
            override ? "?override=true" : ""
          }`,
          {
            method: "POST",
            body: {
              ...(reason ? { reason } : {}),
              ...(taskScope ? { taskScope } : {}),
            },
          },
        ),
      ),
  );
  server.registerTool(
    "list_runs",
    {
      title: "List Nitely runs",
      description: "List visible Nitely runs and status summaries. Requires runs:read.",
      inputSchema: emptySchema,
      annotations: readOnlyAnnotations,
    },
    async () => await execute(() => api.request("/api/runs")),
  );
  server.registerTool(
    "get_run",
    {
      title: "Get a Nitely run",
      description: "Get run status, stage progress, and evidence metadata. Requires runs:read.",
      inputSchema: z.object({ runId: idSchema }).strict(),
      annotations: readOnlyAnnotations,
    },
    async ({ runId }) =>
      await execute(() => api.request(`/api/runs/${encodeURIComponent(runId)}`)),
  );
  server.registerTool(
    "preview_start",
    {
      title: "Start a Nitely preview session",
      description: "Start a scoped Web preview session. Requires preview:control.",
      inputSchema: z
        .object({
          repoId: z.string().trim().min(1).optional(),
          commandId: idSchema,
          workItemId: idSchema.optional(),
          runId: idSchema.optional(),
          targetUrl: z.string().trim().min(1).optional(),
          route: z.string().trim().min(1).optional(),
          viewport: previewViewportSchema,
        })
        .strict(),
      annotations: runAnnotations,
    },
    async (arguments_) =>
      await execute(() =>
        api.request("/api/preview-sessions", {
          method: "POST",
          body: arguments_,
        }),
      ),
  );
  server.registerTool(
    "preview_stop",
    {
      title: "Stop a Nitely preview session",
      description: "Stop a scoped Web preview session. Requires preview:control.",
      inputSchema: z.object({ sessionId: previewSessionIdSchema }).strict(),
      annotations: writeAnnotations,
    },
    async ({ sessionId }) =>
      await execute(() =>
        api.request(
          `/api/preview-sessions/${encodeURIComponent(sessionId)}/stop`,
          { method: "POST", body: {} },
        ),
      ),
  );
  server.registerTool(
    "preview_navigate",
    {
      title: "Navigate a Nitely preview session",
      description: "Navigate within the session origin and allowed routes. Requires preview:control.",
      inputSchema: z
        .object({
          sessionId: previewSessionIdSchema,
          url: z.string().trim().min(1),
        })
        .strict(),
      annotations: writeAnnotations,
    },
    async ({ sessionId, url }) =>
      await execute(() =>
        api.request(
          `/api/preview-sessions/${encodeURIComponent(sessionId)}/navigate`,
          { method: "POST", body: { url } },
        ),
      ),
  );
  server.registerTool(
    "preview_reload",
    {
      title: "Reload a Nitely preview session",
      description: "Reload the current preview page. Requires preview:control.",
      inputSchema: z.object({ sessionId: previewSessionIdSchema }).strict(),
      annotations: writeAnnotations,
    },
    async ({ sessionId }) =>
      await execute(() =>
        api.request(
          `/api/preview-sessions/${encodeURIComponent(sessionId)}/reload`,
          { method: "POST", body: {} },
        ),
      ),
  );
  server.registerTool(
    "preview_capture_screenshot",
    {
      title: "Capture a Nitely preview screenshot",
      description: "Capture a screenshot and return bounded artifact metadata, not image bytes. Requires preview:control.",
      inputSchema: z
        .object({
          sessionId: previewSessionIdSchema,
          fullPage: z.boolean().optional(),
        })
        .strict(),
      annotations: writeAnnotations,
    },
    async ({ sessionId, fullPage }) =>
      await execute(() =>
        api.request(
          `/api/preview-sessions/${encodeURIComponent(sessionId)}/screenshot`,
          { method: "POST", body: { fullPage: fullPage === true } },
        ),
      ),
  );
  server.registerTool(
    "preview_get_diagnostics",
    {
      title: "Get Nitely preview diagnostics",
      description: "Read console, page error, failed request, and server tails. Requires preview:read.",
      inputSchema: z.object({ sessionId: previewSessionIdSchema }).strict(),
      annotations: readOnlyAnnotations,
    },
    async ({ sessionId }) =>
      await execute(() =>
        api.request(
          `/api/preview-sessions/${encodeURIComponent(sessionId)}/diagnostics`,
        ),
      ),
  );
  server.registerTool(
    "preview_get_view_hierarchy",
    {
      title: "Get Nitely preview view hierarchy",
      description: "Read the provider view hierarchy for agent inspection. Requires preview:read.",
      inputSchema: z.object({ sessionId: previewSessionIdSchema }).strict(),
      annotations: readOnlyAnnotations,
    },
    async ({ sessionId }) =>
      await execute(() =>
        api.request(
          `/api/preview-sessions/${encodeURIComponent(sessionId)}/hierarchy`,
        ),
      ),
  );
  server.registerTool(
    "preview_click",
    {
      title: "Click in a Nitely preview session",
      description: "Click an element selected by the provider selector syntax. Requires preview:control.",
      inputSchema: z
        .object({
          sessionId: previewSessionIdSchema,
          selector: z.string().trim().min(1),
        })
        .strict(),
      annotations: writeAnnotations,
    },
    async ({ sessionId, selector }) =>
      await execute(() =>
        api.request(
          `/api/preview-sessions/${encodeURIComponent(sessionId)}/click`,
          { method: "POST", body: { selector } },
        ),
      ),
  );
  server.registerTool(
    "preview_type",
    {
      title: "Type in a Nitely preview session",
      description: "Type text into an element selected by the provider selector syntax. Requires preview:control.",
      inputSchema: z
        .object({
          sessionId: previewSessionIdSchema,
          selector: z.string().trim().min(1),
          text: z.string(),
        })
        .strict(),
      annotations: writeAnnotations,
    },
    async ({ sessionId, selector, text }) =>
      await execute(() =>
        api.request(
          `/api/preview-sessions/${encodeURIComponent(sessionId)}/type`,
          { method: "POST", body: { selector, text } },
        ),
      ),
  );
  server.registerTool(
    "preview_scroll",
    {
      title: "Scroll a Nitely preview session",
      description: "Scroll the current preview page. Requires preview:control.",
      inputSchema: z
        .object({
          sessionId: previewSessionIdSchema,
          deltaX: z.number().optional(),
          deltaY: z.number().optional(),
        })
        .strict(),
      annotations: writeAnnotations,
    },
    async ({ sessionId, deltaX, deltaY }) =>
      await execute(() =>
        api.request(
          `/api/preview-sessions/${encodeURIComponent(sessionId)}/scroll`,
          {
            method: "POST",
            body: {
              ...(deltaX !== undefined ? { deltaX } : {}),
              ...(deltaY !== undefined ? { deltaY } : {}),
            },
          },
        ),
      ),
  );
  server.registerTool(
    "preview_compare_with_reference",
    {
      title: "Compare a preview screenshot with a reference image",
      description: "Create typed visual comparison evidence. Returns comparison JSON and artifact metadata, not image bytes. Requires preview:compare.",
      inputSchema: z
        .object({
          sessionId: previewSessionIdSchema,
          runId: idSchema.optional(),
          workItemId: idSchema.optional(),
          comparisonId: idSchema.optional(),
          reference: visualComparisonImageSchema,
          implementation: visualComparisonImageSchema.optional(),
          screenshotId: idSchema.optional(),
          note: z.string().trim().min(1).optional(),
          route: z.string().trim().min(1).optional(),
          revision: z.string().trim().min(1).optional(),
          ...visualComparisonThresholdSchema,
        })
        .strict()
        .refine((value) => Boolean(value.screenshotId) !== Boolean(value.implementation), {
          message: "provide exactly one of screenshotId or implementation",
        }),
      annotations: writeAnnotations,
    },
    async ({ sessionId, ...body }) =>
      await execute(() =>
        api.request(
          `/api/preview-sessions/${encodeURIComponent(sessionId)}/compare-reference`,
          { method: "POST", body },
        ),
      ),
  );
  return server;
}

export async function startNitelyMcpStdioServer(
  input: NitelyMcpServerInput,
): Promise<McpServer> {
  const server = createNitelyMcpServer(input);
  await server.connect(new StdioServerTransport());
  return server;
}
