import { describe, expect, it } from "vitest";

import {
  apiPreviewSessionRef,
  apiRunQuestionAnswerId,
  apiTaskDependencyId,
  apiWorkItemRunId,
  htmlTaskId,
} from "../../src/web/route-patterns.js";

describe("route patterns", () => {
  it("decodes Task and dependency ids at the HTTP seam", () => {
    expect(apiTaskDependencyId("/api/tasks/task%2F1/dependencies/upstream%2F2"))
      .toEqual({ taskId: "task/1", upstreamId: "upstream/2" });
  });

  it("distinguishes preview session actions from the session itself", () => {
    expect(apiPreviewSessionRef("/api/preview-sessions/session-1")).toEqual({
      sessionId: "session-1",
    });
    expect(apiPreviewSessionRef("/api/preview-sessions/session-1/diagnostics"))
      .toEqual({ sessionId: "session-1", action: "diagnostics" });
  });

  it("extracts Run question answers and Work item Runs", () => {
    expect(apiRunQuestionAnswerId("/api/runs/run-1/questions/q-1/answer"))
      .toEqual({ runId: "run-1", questionId: "q-1" });
    expect(apiWorkItemRunId("/api/work-items/wi-1/runs")).toBe("wi-1");
  });

  it("does not match a neighboring HTML route", () => {
    expect(htmlTaskId("/tasks/task-1")).toBe("task-1");
    expect(htmlTaskId("/tasks/task-1/runs")).toBeUndefined();
  });
});
