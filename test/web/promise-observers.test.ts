import { describe, expect, it, vi } from "vitest";

import { observePromiseOnce } from "../../src/web/promise-observers.js";

describe("promise observer registry", () => {
  it("attaches only one observer for a pending key", async () => {
    const pendingKeys = new Set<string>();
    let resolveValue!: (value: number) => void;
    const pending = new Promise<number>((resolve) => {
      resolveValue = resolve;
    });
    const observer = vi.fn(async (_value: number) => {});

    expect(observePromiseOnce(pendingKeys, "notification", pending, observer))
      .toBe(true);
    expect(observePromiseOnce(pendingKeys, "notification", pending, observer))
      .toBe(false);
    expect(pendingKeys).toEqual(new Set(["notification"]));

    resolveValue(7);
    await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(pendingKeys.size).toBe(0));
  });
});
