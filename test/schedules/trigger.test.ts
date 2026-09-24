import { describe, expect, it } from "vitest";

import { nextCronOccurrence, parseCronExpression } from "../../src/schedules/cron.js";
import { nextTriggerOccurrence } from "../../src/schedules/trigger.js";

const at = (iso: string) => new Date(iso);

describe("cron expressions", () => {
  it("parses the five standard fields with steps, ranges and lists", () => {
    const parsed = parseCronExpression("*/15 9-17 1,15 * 1-5");
    expect(parsed.minutes).toEqual([0, 15, 30, 45]);
    expect(parsed.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(parsed.daysOfMonth).toEqual([1, 15]);
    expect(parsed.months).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(parsed.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it("rejects malformed expressions with a clear reason", () => {
    expect(() => parseCronExpression("0 9 * *")).toThrow(/five fields/);
    expect(() => parseCronExpression("60 9 * * *")).toThrow(/minute/);
    expect(() => parseCronExpression("0 25 * * *")).toThrow(/hour/);
    expect(() => parseCronExpression("0 9 * * 8")).toThrow(/day of week/);
    expect(() => parseCronExpression("0 9 * * mon")).toThrow(/day of week/);
  });

  it("finds the next Monday 09:00 in the schedule's timezone", () => {
    const next = nextCronOccurrence("0 9 * * 1", at("2026-09-19T00:00:00Z"), "Asia/Singapore");
    // 2026-09-21 is a Monday; 09:00 SGT is 01:00 UTC.
    expect(next?.toISOString()).toBe("2026-09-21T01:00:00.000Z");
  });

  it("is strictly after the reference instant", () => {
    const exact = at("2026-09-21T01:00:00Z");
    const next = nextCronOccurrence("0 9 * * 1", exact, "Asia/Singapore");
    expect(next?.toISOString()).toBe("2026-09-28T01:00:00.000Z");
  });

  it("keeps wall-clock time across a DST transition", () => {
    // New York leaves DST on 2026-11-01. 09:00 local is 13:00Z before and 14:00Z after.
    const before = nextCronOccurrence("0 9 * * *", at("2026-10-30T20:00:00Z"), "America/New_York");
    expect(before?.toISOString()).toBe("2026-10-31T13:00:00.000Z");
    const after = nextCronOccurrence("0 9 * * *", at("2026-11-01T20:00:00Z"), "America/New_York");
    expect(after?.toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });

  it("skips a wall-clock time that does not exist on the spring-forward day", () => {
    // 2026-03-08 02:30 does not exist in New York; the next 02:30 is on the 9th (06:30Z, EDT).
    const next = nextCronOccurrence("30 2 * * *", at("2026-03-08T00:00:00Z"), "America/New_York");
    expect(next?.toISOString()).toBe("2026-03-09T06:30:00.000Z");
  });

  it("fires a repeated fall-back wall-clock time once, at its first instant", () => {
    // 2026-11-01 01:30 happens twice in New York (05:30Z EDT and 06:30Z EST).
    const first = nextCronOccurrence("30 1 * * *", at("2026-11-01T00:00:00Z"), "America/New_York");
    expect(first?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    const following = nextCronOccurrence("30 1 * * *", first!, "America/New_York");
    expect(following?.toISOString()).toBe("2026-11-02T06:30:00.000Z");
  });

  it("returns undefined when nothing matches within a year", () => {
    expect(nextCronOccurrence("0 0 31 2 *", at("2026-01-01T00:00:00Z"), "UTC")).toBeUndefined();
  });

  it("rejects an unknown timezone", () => {
    expect(() => nextCronOccurrence("0 9 * * *", at("2026-01-01T00:00:00Z"), "Mars/Olympus")).toThrow(/timezone/);
  });
});

describe("trigger occurrences", () => {
  it("a one-shot trigger fires once at its instant and never again", () => {
    const trigger = { type: "once" as const, at: "2026-10-01T09:00:00Z" };
    expect(nextTriggerOccurrence(trigger, at("2026-09-19T00:00:00Z"), "UTC")?.toISOString()).toBe(
      "2026-10-01T09:00:00.000Z",
    );
    expect(nextTriggerOccurrence(trigger, at("2026-10-01T09:00:00Z"), "UTC")).toBeUndefined();
  });

  it("an interval trigger is anchored so restarts do not drift it", () => {
    const trigger = { type: "interval" as const, everyMs: 6 * 60 * 60 * 1000, anchorAt: "2026-09-19T00:00:00Z" };
    expect(nextTriggerOccurrence(trigger, at("2026-09-19T07:10:00Z"), "UTC")?.toISOString()).toBe(
      "2026-09-19T12:00:00.000Z",
    );
    expect(nextTriggerOccurrence(trigger, at("2026-09-19T12:00:00Z"), "UTC")?.toISOString()).toBe(
      "2026-09-19T18:00:00.000Z",
    );
  });

  it("a cron trigger delegates to the cron evaluator in the schedule timezone", () => {
    const trigger = { type: "cron" as const, expression: "0 9 * * 1" };
    expect(nextTriggerOccurrence(trigger, at("2026-09-19T00:00:00Z"), "Asia/Singapore")?.toISOString()).toBe(
      "2026-09-21T01:00:00.000Z",
    );
  });
});
