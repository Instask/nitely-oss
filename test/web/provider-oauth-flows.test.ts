import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ProviderOAuthFlowError,
  ProviderOAuthFlowRegistry,
} from "../../src/web/provider-oauth-flows.js";

describe("ProviderOAuthFlowRegistry", () => {
  it("issues an unguessable single-use state bound to the user and provider", () => {
    const registry = new ProviderOAuthFlowRegistry({
      now: () => new Date("2026-09-19T10:00:00Z"),
    });
    const flow = registry.start({ userId: "usr_1", providerId: "github" });
    expect(flow.state).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(flow.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(flow.codeChallenge).toBe(
      createHash("sha256").update(flow.codeVerifier).digest("base64url"),
    );
    const consumed = registry.consume(flow.state, { userId: "usr_1", providerId: "github" });
    expect(consumed.codeVerifier).toBe(flow.codeVerifier);
    expect(() =>
      registry.consume(flow.state, { userId: "usr_1", providerId: "github" }),
    ).toThrow(ProviderOAuthFlowError);
  });

  it("rejects a state presented by a different user", () => {
    const registry = new ProviderOAuthFlowRegistry({
      now: () => new Date("2026-09-19T10:00:00Z"),
    });
    const flow = registry.start({ userId: "usr_1", providerId: "github" });
    const error = (() => {
      try {
        registry.consume(flow.state, { userId: "usr_2", providerId: "github" });
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ProviderOAuthFlowError);
    expect((error as ProviderOAuthFlowError).code).toBe("user_mismatch");
    // A failed presentation burns the state.
    expect(() =>
      registry.consume(flow.state, { userId: "usr_1", providerId: "github" }),
    ).toThrow(/unknown_state/);
  });

  it("rejects a state presented for another provider", () => {
    const registry = new ProviderOAuthFlowRegistry({
      now: () => new Date("2026-09-19T10:00:00Z"),
    });
    const flow = registry.start({ userId: "usr_1", providerId: "github" });
    expect(() =>
      registry.consume(flow.state, { userId: "usr_1", providerId: "google-drive" }),
    ).toThrow(/provider_mismatch/);
  });

  it("expires a state after its TTL", () => {
    let now = new Date("2026-09-19T10:00:00Z");
    const registry = new ProviderOAuthFlowRegistry({ now: () => now, ttlMs: 60_000 });
    const flow = registry.start({ userId: "usr_1", providerId: "github" });
    now = new Date("2026-09-19T10:02:00Z");
    expect(() =>
      registry.consume(flow.state, { userId: "usr_1", providerId: "github" }),
    ).toThrow(/expired_state/);
  });

  it("carries the connection being reconnected through the flow", () => {
    const registry = new ProviderOAuthFlowRegistry({
      now: () => new Date("2026-09-19T10:00:00Z"),
    });
    const flow = registry.start({
      userId: "usr_1",
      providerId: "github",
      connectionId: "conn_abc",
    });
    expect(
      registry.consume(flow.state, { userId: "usr_1", providerId: "github" }).connectionId,
    ).toBe("conn_abc");
  });

  it("bounds the number of pending flows so a flood cannot grow memory without limit", () => {
    const registry = new ProviderOAuthFlowRegistry({
      now: () => new Date("2026-09-19T10:00:00Z"),
      maxPending: 3,
    });
    const first = registry.start({ userId: "usr_1", providerId: "github" });
    registry.start({ userId: "usr_1", providerId: "github" });
    registry.start({ userId: "usr_1", providerId: "github" });
    registry.start({ userId: "usr_1", providerId: "github" });
    expect(() =>
      registry.consume(first.state, { userId: "usr_1", providerId: "github" }),
    ).toThrow(/unknown_state/);
  });
});
