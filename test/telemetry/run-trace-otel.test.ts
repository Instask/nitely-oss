import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace";
import { afterEach, describe, expect, it } from "vitest";

import { normalizeRuntimeUsageForPersistence } from "../../src/eval/usage.js";
import type { StoredRunEvent } from "../../src/events/types.js";
import { redactUnknown } from "../../src/context/redaction.js";
import { createPiJsonCapture, readPiJsonStream } from "../../src/run/execution/pi-json.js";
import {
  buildRunTraceSpans,
  exportRunTrace,
  otlpTraceConfigFromEnv,
  parseOtlpHeaders,
  spanIdFor,
  toReadableSpans,
  traceIdForRun,
} from "../../src/telemetry/run-trace-otel.js";

const fixturePath = join(process.cwd(), "test/fixtures/pi-json/openrouter-two-calls.jsonl");
const runId = "2026-10-12T090000000Z-abc123";
const SECRET = "sk-or-v1-seededsecretvalue0123456789abcdef";

async function runtimeUsage(options: { captureContent?: boolean; secretInOutput?: boolean } = {}) {
  let stream = await readFile(fixturePath, "utf8");
  if (options.secretInOutput) {
    stream = stream.replace("Reading the tests first.", `Reading the tests first. OPENROUTER_API_KEY=${SECRET}`);
  }
  let clock = Date.parse("2026-10-12T09:00:02.000Z");
  const capture = createPiJsonCapture({
    now: () => (clock += 100),
    ...(options.captureContent ? { captureContent: true } : {}),
  });
  capture.write(stream);
  const outcome = readPiJsonStream(capture.text(), {
    provider: "openrouter",
    model: "qwen/qwen3-coder-next",
    observedAt: new Date("2026-10-12T09:00:05.000Z"),
    ...(options.captureContent ? { captureContent: true } : {}),
  });
  // What run-flow persists: the usage record, and the call log beside it.
  return {
    usage: redactUnknown(normalizeRuntimeUsageForPersistence(outcome.usage), [SECRET]),
    calls: redactUnknown({ calls: outcome.usage?.callLog }, [SECRET]),
  };
}

function runEvents(
  recorded: { usage: unknown; calls: unknown },
  terminal: "run.completed" | "run.blocked" = "run.completed",
): StoredRunEvent[] {
  let sequence = 0;
  const event = (
    createdAt: string,
    type: StoredRunEvent["type"],
    payload: unknown,
    stage?: { stageId: string; attempt?: number },
  ): StoredRunEvent => ({
    sequence: ++sequence,
    runId,
    type,
    payload,
    createdAt,
    ...(stage?.stageId ? { stageId: stage.stageId } : {}),
    ...(stage?.attempt !== undefined ? { attempt: stage.attempt } : {}),
  });
  const implement = { stageId: "implement", attempt: 1 };
  return [
    event("2026-10-12T09:00:00.000Z", "run.created", {
      flowName: "implement-spec",
      flowDocumentSha256: "f".repeat(64),
      workItemId: "task-1",
      repoId: "repo-1",
      repoName: "acme/app",
    }),
    event("2026-10-12T09:00:01.000Z", "stage.started", {}, implement),
    event("2026-10-12T09:00:01.500Z", "stage.runtime.selected", {
      runtime: "openrouter",
      model: "qwen/qwen3-coder-next",
      requestedEffort: "high",
      nativeEffort: "high",
      effortStatus: "applied",
    }, implement),
    event("2026-10-12T09:00:05.000Z", "stage.runtime.usage", recorded.usage, implement),
    event("2026-10-12T09:00:05.000Z", "stage.runtime.calls", recorded.calls, implement),
    terminal === "run.completed"
      ? event("2026-10-12T09:00:06.000Z", "stage.completed", {}, implement)
      : event("2026-10-12T09:00:06.000Z", "stage.blocked", {
        reason: "provider-auth",
        stageId: "implement",
        message: "OpenRouter returned 401",
      }, implement),
    event("2026-10-12T09:00:07.000Z", terminal, {}),
  ];
}

describe("otlpTraceConfigFromEnv", () => {
  it("is off without an endpoint and reads the standard variables with one", () => {
    expect(otlpTraceConfigFromEnv({})).toBeUndefined();
    expect(otlpTraceConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_TRACES_EXPORTER: "none" }))
      .toBeUndefined();
    expect(otlpTraceConfigFromEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/",
      OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=abc%3D,Langsmith-Project=nitely",
      OTEL_SERVICE_NAME: "nitely-prod",
    })).toMatchObject({
      url: "http://collector:4318/v1/traces",
      headers: { "x-api-key": "abc=", "Langsmith-Project": "nitely" },
      serviceName: "nitely-prod",
      captureContent: false,
    });
    expect(otlpTraceConfigFromEnv({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://lf.example/api/public/otel/v1/traces" })?.url)
      .toBe("https://lf.example/api/public/otel/v1/traces");
    expect(parseOtlpHeaders("bad,=x,k=v")).toEqual({ k: "v" });
  });
});

describe("buildRunTraceSpans", () => {
  it("builds run → stage → attempt → model call and tool spans with the run's metadata", async () => {
    const trace = buildRunTraceSpans(runEvents(await runtimeUsage()));
    expect(trace?.spans.map((span) => [span.kind, span.name, span.parentKey ?? null])).toEqual([
      ["run", "run implement-spec", null],
      ["stage", "stage implement", "run"],
      ["attempt", "attempt implement#1", "stage:implement"],
      ["llm", "chat qwen/qwen3-coder-next", "attempt:implement:1"],
      ["tool", "execute_tool bash", "attempt:implement:1"],
      ["llm", "chat qwen/qwen3-coder-next-20260901", "attempt:implement:1"],
    ]);
    const [run, , attempt, firstCall, tool] = trace?.spans ?? [];
    expect(run?.attributes).toMatchObject({
      "nitely.run.id": runId,
      "nitely.work_item.id": "task-1",
      "nitely.repo.id": "repo-1",
      "nitely.flow.name": "implement-spec",
      "nitely.flow.sha256": "f".repeat(64),
      "nitely.outcome": "completed",
    });
    expect(run?.status).toBe("ok");
    expect(attempt?.attributes).toMatchObject({
      "nitely.stage.id": "implement",
      "nitely.attempt": 1,
      "nitely.runtime": "openrouter",
      "gen_ai.request.model": "qwen/qwen3-coder-next",
      "nitely.effort.requested": "high",
      "nitely.outcome": "completed",
    });
    expect(firstCall?.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openrouter",
      "gen_ai.usage.input_tokens": 4_800,
      "gen_ai.usage.output_tokens": 40,
      "nitely.call.tool_call_names": ["bash"],
    });
    expect(tool?.attributes).toMatchObject({ "gen_ai.tool.name": "bash", "gen_ai.tool.call.id": "call_1" });
    // Children stay inside their parent.
    for (const span of trace?.spans ?? []) {
      expect(Date.parse(span.endTime)).toBeGreaterThanOrEqual(Date.parse(span.startTime));
    }
    expect(Date.parse(firstCall?.startTime as string)).toBeGreaterThanOrEqual(Date.parse(attempt?.startTime as string));
    expect(Date.parse(tool?.endTime as string)).toBeLessThanOrEqual(Date.parse(attempt?.endTime as string));
  });

  it("matches the stage usage totals of the same attempt", async () => {
    const recorded = await runtimeUsage();
    const usage = recorded.usage as {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      cost: { usd: number };
    };
    const trace = buildRunTraceSpans(runEvents(recorded));
    const attempt = trace?.spans.find((span) => span.kind === "attempt");
    const calls = trace?.spans.filter((span) => span.kind === "llm") ?? [];
    const sum = (name: string) => calls.reduce((total, span) => total + (span.attributes[name] as number), 0);

    expect(attempt?.attributes["gen_ai.usage.input_tokens"]).toBe(usage.inputTokens);
    expect(attempt?.attributes["gen_ai.usage.output_tokens"]).toBe(usage.outputTokens);
    expect(attempt?.attributes["gen_ai.usage.cache_read.input_tokens"]).toBe(usage.cachedInputTokens);
    expect(attempt?.attributes["nitely.usage.cost_usd"]).toBe(usage.cost.usd);
    expect(sum("gen_ai.usage.input_tokens")).toBe(usage.inputTokens);
    expect(sum("gen_ai.usage.output_tokens")).toBe(usage.outputTokens);
    expect(sum("gen_ai.usage.cache_read.input_tokens")).toBe(usage.cachedInputTokens);
    expect(sum("gen_ai.usage.cost")).toBeCloseTo(usage.cost.usd, 12);
  });

  it("marks a blocked attempt and run as errors with the blocker", async () => {
    const trace = buildRunTraceSpans(runEvents(await runtimeUsage(), "run.blocked"));
    const attempt = trace?.spans.find((span) => span.kind === "attempt");
    expect(attempt).toMatchObject({ status: "error", statusMessage: "OpenRouter returned 401" });
    expect(attempt?.attributes).toMatchObject({ "nitely.outcome": "blocked", "nitely.blocked.reason": "provider-auth" });
    expect(trace?.spans[0]?.attributes["nitely.outcome"]).toBe("blocked");
  });

  it("exports no content by default, even when the call log holds some", async () => {
    const trace = buildRunTraceSpans(runEvents(await runtimeUsage({ captureContent: true })));
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain("Reading the tests first.");
    expect(serialized).not.toContain("ls test");
    expect(serialized).not.toContain("gen_ai.completion");
  });

  it("exports content only on opt-in, and redacts a seeded secret", async () => {
    const recorded = await runtimeUsage({ captureContent: true, secretInOutput: true });
    // Redacted once when persisted; content capture must not undo that.
    expect(JSON.stringify(recorded)).not.toContain(SECRET);
    const unredacted = runEvents(await runtimeUsage({ captureContent: true }));
    // A call log persisted before redaction learned this pattern: export redacts again.
    const callsEvent = unredacted.find((event) => event.type === "stage.runtime.calls");
    const calls = (callsEvent?.payload as { calls: Array<Record<string, unknown>> }).calls;
    (calls[0] as Record<string, unknown>).output = `token=${SECRET}`;

    for (const events of [runEvents(recorded), unredacted]) {
      const trace = buildRunTraceSpans(events, { captureContent: true });
      const firstCall = trace?.spans.find((span) => span.kind === "llm");
      expect(firstCall?.attributes["gen_ai.completion.0.content"]).toBeTypeOf("string");
      expect(firstCall?.attributes["gen_ai.completion.0.tool_calls.0.arguments"]).toBe(JSON.stringify({ command: "ls test" }));
      expect(JSON.stringify(trace)).not.toContain(SECRET);
    }
  });

  it("drops call spans over the cap and says how many", async () => {
    const trace = buildRunTraceSpans(runEvents(await runtimeUsage()), { maxSpans: 4 });
    expect(trace?.spans.map((span) => span.kind)).toEqual(["run", "stage", "attempt", "llm"]);
    expect(trace?.droppedSpans).toBe(2);
    expect(trace?.spans[0]?.attributes["nitely.trace.dropped_spans"]).toBe(2);
  });
});

describe("toReadableSpans", () => {
  it("derives stable trace and span ids from the run", async () => {
    const trace = buildRunTraceSpans(runEvents(await runtimeUsage()));
    const spans = toReadableSpans(trace!, "nitely");
    const again = toReadableSpans(buildRunTraceSpans(runEvents(await runtimeUsage()))!, "nitely");
    expect(spans.map((span) => span.spanContext().spanId)).toEqual(again.map((span) => span.spanContext().spanId));
    expect(new Set(spans.map((span) => span.spanContext().traceId))).toEqual(new Set([traceIdForRun(runId)]));
    expect(spans[1]?.parentSpanContext?.spanId).toBe(spanIdFor(runId, "run"));
    expect(spans[0]?.parentSpanContext).toBeUndefined();
    expect(spans[0]?.resource.attributes["service.name"]).toBe("nitely");
  });
});

describe("exportRunTrace", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolvePromise) => server?.close(() => resolvePromise()));
    server = undefined;
  });

  it("creates no exporter and reads no events without an endpoint", async () => {
    let created = 0;
    let listed = 0;
    const result = await exportRunTrace({
      runId,
      env: {},
      listEvents: () => {
        listed += 1;
        return [];
      },
      createExporter: () => {
        created += 1;
        throw new Error("unexpected");
      },
    });
    expect(result).toEqual({ status: "disabled" });
    expect(created).toBe(0);
    expect(listed).toBe(0);
  });

  it("sends the trace over OTLP/protobuf with the configured headers", async () => {
    const requests: Array<{ url?: string; headers: IncomingMessage["headers"]; body: Buffer }> = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({ url: request.url, headers: request.headers, body: Buffer.concat(chunks) });
        response.writeHead(200, { "content-type": "application/x-protobuf" });
        response.end();
      });
    });
    await new Promise<void>((resolvePromise) => server?.listen(0, "127.0.0.1", () => resolvePromise()));
    const { port } = server.address() as AddressInfo;
    const events = runEvents(await runtimeUsage());

    const result = await exportRunTrace({
      runId,
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
        OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=test-key",
      },
      listEvents: () => events,
      log: () => undefined,
    });

    expect(result).toEqual({ status: "exported", spans: 6, droppedSpans: 0 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/v1/traces");
    expect(requests[0]?.headers["content-type"]).toBe("application/x-protobuf");
    expect(requests[0]?.headers["x-api-key"]).toBe("test-key");
    const body = requests[0]?.body.toString("latin1") ?? "";
    for (const text of [runId, "run implement-spec", "execute_tool bash", "gen_ai.usage.input_tokens"]) {
      expect(body).toContain(text);
    }
  });

  it("gives up on a collector that never answers within the export timeout", async () => {
    server = createServer(() => {
      // Accept the request and never respond.
    });
    await new Promise<void>((resolvePromise) => server?.listen(0, "127.0.0.1", () => resolvePromise()));
    const { port } = server.address() as AddressInfo;
    const events = runEvents(await runtimeUsage());
    const logged: string[] = [];

    const started = Date.now();
    const result = await exportRunTrace({
      runId,
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`, NITELY_OTEL_EXPORT_TIMEOUT_MS: "300" },
      listEvents: () => events,
      log: (message) => logged.push(message),
    });

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toMatchObject({ status: "failed", spans: 6 });
    expect(logged.join("\n")).toContain(`Nitely trace export failed for ${runId}`);
    server.closeAllConnections();
  });

  it("does not throw when the exporter or the event read fails", async () => {
    const failing: SpanExporter = {
      export: (_spans: ReadableSpan[], done) => done({ code: 1, error: new Error("collector refused") }),
      shutdown: async () => undefined,
    };
    const events = runEvents(await runtimeUsage());
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9" };
    await expect(exportRunTrace({ runId, env, listEvents: () => events, createExporter: () => failing, log: () => undefined }))
      .resolves.toMatchObject({ status: "failed", error: "collector refused" });
    await expect(exportRunTrace({
      runId,
      env,
      listEvents: () => {
        throw new Error("database is locked");
      },
      log: () => undefined,
    })).resolves.toMatchObject({ status: "failed", error: "database is locked" });
  });
});
