import { createHash, randomBytes } from "node:crypto";

import type { ProviderId } from "../providers/types.js";

export type ProviderOAuthFlowErrorCode =
  | "unknown_state"
  | "expired_state"
  | "user_mismatch"
  | "provider_mismatch";

export class ProviderOAuthFlowError extends Error {
  constructor(public readonly code: ProviderOAuthFlowErrorCode) {
    super(code);
    this.name = "ProviderOAuthFlowError";
  }
}

export interface StartProviderOAuthFlowInput {
  userId: string;
  providerId: ProviderId;
  /** Set when the flow reconnects an existing connection in place. */
  connectionId?: string;
}

export interface PendingProviderOAuthFlow {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  userId: string;
  providerId: ProviderId;
  connectionId?: string;
  createdAt: number;
}

export interface ProviderOAuthFlowRegistryOptions {
  now?: () => Date;
  /** How long a started flow may wait for its callback. */
  ttlMs?: number;
  /** Oldest pending flows are dropped past this many. */
  maxPending?: number;
}

/**
 * The CSRF boundary of the connect flow. A callback is accepted only with a
 * state this registry issued, presented once, before it expired, by the same
 * signed-in user, for the same provider. Any mismatch burns the state so it
 * cannot be retried against another check.
 */
export class ProviderOAuthFlowRegistry {
  private readonly pending = new Map<string, PendingProviderOAuthFlow>();
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly maxPending: number;

  constructor(options: ProviderOAuthFlowRegistryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.maxPending = options.maxPending ?? 1000;
  }

  start(input: StartProviderOAuthFlowInput): PendingProviderOAuthFlow {
    this.evictExpired();
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(48).toString("base64url");
    const flow: PendingProviderOAuthFlow = {
      state,
      codeVerifier,
      codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
      userId: input.userId,
      providerId: input.providerId,
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      createdAt: this.now().getTime(),
    };
    this.pending.set(state, flow);
    while (this.pending.size > this.maxPending) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    return flow;
  }

  consume(
    state: string,
    presented: { userId: string; providerId: ProviderId },
  ): PendingProviderOAuthFlow {
    const flow = this.pending.get(state);
    if (!flow) throw new ProviderOAuthFlowError("unknown_state");
    this.pending.delete(state);
    if (this.now().getTime() - flow.createdAt > this.ttlMs) {
      throw new ProviderOAuthFlowError("expired_state");
    }
    if (flow.userId !== presented.userId) {
      throw new ProviderOAuthFlowError("user_mismatch");
    }
    if (flow.providerId !== presented.providerId) {
      throw new ProviderOAuthFlowError("provider_mismatch");
    }
    return flow;
  }

  private evictExpired(): void {
    const cutoff = this.now().getTime() - this.ttlMs;
    for (const [state, flow] of this.pending) {
      if (flow.createdAt < cutoff) this.pending.delete(state);
    }
  }
}
