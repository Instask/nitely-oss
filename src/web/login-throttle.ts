import { securityAuditSubjectFingerprint } from "./security-audit.js";

export interface LoginAttemptLimiterOptions {
  maxFailures: number;
  windowMs: number;
  maxTrackedSubjects?: number;
  now?: () => number;
}

export type LoginAttemptCheck =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export class LoginAttemptLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly maxTrackedSubjects: number;
  private readonly now: () => number;

  constructor(private readonly options: LoginAttemptLimiterOptions) {
    if (!Number.isInteger(options.maxFailures) || options.maxFailures < 1) {
      throw new Error("login maxFailures must be a positive integer");
    }
    if (!Number.isInteger(options.windowMs) || options.windowMs < 1) {
      throw new Error("login windowMs must be a positive integer");
    }
    this.maxTrackedSubjects = options.maxTrackedSubjects ?? 10_000;
    if (!Number.isInteger(this.maxTrackedSubjects) || this.maxTrackedSubjects < 1) {
      throw new Error("login maxTrackedSubjects must be a positive integer");
    }
    this.now = options.now ?? Date.now;
  }

  private key(subject: string): string {
    return securityAuditSubjectFingerprint(subject);
  }

  private recentFailures(key: string, now: number): number[] {
    const earliest = now - this.options.windowMs;
    const recent = (this.failures.get(key) ?? []).filter(
      (timestamp) => timestamp > earliest,
    );
    if (recent.length === 0) {
      this.failures.delete(key);
    } else {
      this.failures.set(key, recent);
    }
    return recent;
  }

  check(subject: string): LoginAttemptCheck {
    const now = this.now();
    const recent = this.recentFailures(this.key(subject), now);
    if (recent.length < this.options.maxFailures) return { allowed: true };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((recent[0] + this.options.windowMs - now) / 1_000),
      ),
    };
  }

  recordFailure(subject: string): void {
    const now = this.now();
    const key = this.key(subject);
    const recent = this.recentFailures(key, now);
    if (!this.failures.has(key) && this.failures.size >= this.maxTrackedSubjects) {
      const oldest = this.failures.keys().next().value as string | undefined;
      if (oldest) this.failures.delete(oldest);
    }
    this.failures.set(key, [...recent, now]);
  }

  clear(subject: string): void {
    this.failures.delete(this.key(subject));
  }

  trackedSubjectCount(): number {
    return this.failures.size;
  }
}
