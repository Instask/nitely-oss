import { describe, expect, it } from "vitest";

import { serializeWebJson } from "../../src/web/json.js";

describe("serializeWebJson", () => {
  it("drops repoPath keys at any depth and keeps everything else", () => {
    const payload = {
      task: { id: "t-1", repoId: "app", repoPath: "/srv/app" },
      runs: [{ runId: "r-1", repoPath: "/srv/app", artifacts: [{ path: "out.md" }] }],
      repository: { id: "app", path: "/srv/app" },
    };

    expect(JSON.parse(serializeWebJson(payload))).toEqual({
      task: { id: "t-1", repoId: "app" },
      runs: [{ runId: "r-1", artifacts: [{ path: "out.md" }] }],
      repository: { id: "app", path: "/srv/app" },
    });
  });

  it("serializes scalars and arrays unchanged", () => {
    expect(serializeWebJson([1, "a", null])).toBe('[1,"a",null]');
    expect(serializeWebJson("x")).toBe('"x"');
  });
});
