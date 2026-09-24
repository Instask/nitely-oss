/**
 * Five-field cron (minute hour day-of-month month day-of-week) evaluated in
 * an explicit IANA timezone. Wall-clock semantics follow classic cron: a time
 * that does not exist on a spring-forward day is skipped, a time that occurs
 * twice on a fall-back day fires at its first instant only, and when both
 * day fields are restricted a day matches if either does.
 */

export interface CronExpression {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
}

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
];

function parseField(raw: string, spec: FieldSpec): { values: number[]; restricted: boolean } {
  const values = new Set<number>();
  let restricted = false;
  for (const part of raw.split(",")) {
    const [rangeText, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`invalid cron ${spec.name} step: ${part}`);
    }
    let low: number;
    let high: number;
    if (rangeText === "*") {
      low = spec.min;
      high = spec.max;
      if (stepText !== undefined) restricted = true;
    } else {
      restricted = true;
      const bounds = rangeText.split("-");
      if (bounds.length > 2 || !/^\d+(-\d+)?$/.test(rangeText)) {
        throw new Error(`invalid cron ${spec.name}: ${part}`);
      }
      low = Number(bounds[0]);
      high = bounds.length === 2 ? Number(bounds[1]) : stepText !== undefined ? spec.max : low;
      if (low < spec.min || high > spec.max || low > high) {
        throw new Error(`invalid cron ${spec.name}: ${part} is outside ${spec.min}-${spec.max}`);
      }
    }
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return { values: [...values].sort((a, b) => a - b), restricted };
}

export function parseCronExpression(expression: string): CronExpression {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("cron expression must have five fields: minute hour day-of-month month day-of-week");
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = fields.map((raw, index) =>
    parseField(raw, FIELDS[index]),
  );
  return {
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: daysOfMonth.values,
    months: months.values,
    // Both 0 and 7 mean Sunday.
    daysOfWeek: [...new Set(daysOfWeek.values.map((day) => (day === 7 ? 0 : day)))].sort(
      (a, b) => a - b,
    ),
    dayOfMonthRestricted: daysOfMonth.restricted,
    dayOfWeekRestricted: daysOfWeek.restricted,
  };
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timezone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    throw new Error(`unknown timezone: ${timezone}`);
  }
  formatters.set(timezone, formatter);
  return formatter;
}

export function assertTimezone(timezone: string): void {
  formatterFor(timezone);
}

export function wallClockIn(timezone: string, instant: Date): WallClock {
  const parts = formatterFor(timezone).formatToParts(instant);
  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour") % 24,
    minute: read("minute"),
  };
}

function wallClockKey(clock: WallClock): number {
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute);
}

/**
 * The instant(s) at which `timezone` shows this wall-clock time, earliest
 * first. Empty for a time inside a spring-forward gap; two entries for a
 * repeated fall-back hour.
 */
export function instantsForWallClock(timezone: string, clock: WallClock): Date[] {
  const target = wallClockKey(clock);
  const found = new Set<number>();
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = wallClockKey(wallClockIn(timezone, new Date(guess))) - guess;
    const candidate = target - offset;
    if (wallClockKey(wallClockIn(timezone, new Date(candidate))) === target) found.add(candidate);
    if (candidate === guess) break;
    guess = candidate;
  }
  // The other side of a transition: probe an hour either way from the first hit.
  for (const base of [...found]) {
    for (const delta of [-3_600_000, 3_600_000]) {
      const candidate = base + delta;
      if (wallClockKey(wallClockIn(timezone, new Date(candidate))) === target) found.add(candidate);
    }
  }
  return [...found].sort((a, b) => a - b).map((ms) => new Date(ms));
}

const MAX_SEARCH_DAYS = 366;

export function nextCronOccurrence(
  expression: string | CronExpression,
  after: Date,
  timezone: string,
): Date | undefined {
  const cron = typeof expression === "string" ? parseCronExpression(expression) : expression;
  assertTimezone(timezone);
  const startMs = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const startClock = wallClockIn(timezone, new Date(startMs));
  const firstDay = Date.UTC(startClock.year, startClock.month - 1, startClock.day);
  for (let dayIndex = 0; dayIndex <= MAX_SEARCH_DAYS; dayIndex += 1) {
    const date = new Date(firstDay + dayIndex * 86_400_000);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (!cron.months.includes(month)) continue;
    const domMatches = cron.daysOfMonth.includes(day);
    const dowMatches = cron.daysOfWeek.includes(date.getUTCDay());
    const dayMatches = cron.dayOfMonthRestricted && cron.dayOfWeekRestricted
      ? domMatches || dowMatches
      : cron.dayOfMonthRestricted
        ? domMatches
        : cron.dayOfWeekRestricted
          ? dowMatches
          : true;
    if (!dayMatches) continue;
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        const [instant] = instantsForWallClock(timezone, { year, month, day, hour, minute });
        if (instant && instant.getTime() >= startMs) return instant;
      }
    }
  }
  return undefined;
}
