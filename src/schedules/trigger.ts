import { assertTimezone, nextCronOccurrence } from "./cron.js";

export type ScheduleTrigger =
  | { type: "once"; at: string }
  | { type: "cron"; expression: string }
  | { type: "interval"; everyMs: number; anchorAt: string };

/**
 * The first firing strictly after `after`. Interval triggers are anchored so
 * a restart or a late scan never shifts the grid; a one-shot trigger has no
 * occurrence once its instant has passed.
 */
export function nextTriggerOccurrence(
  trigger: ScheduleTrigger,
  after: Date,
  timezone: string,
): Date | undefined {
  switch (trigger.type) {
    case "once": {
      const at = new Date(trigger.at);
      return at.getTime() > after.getTime() ? at : undefined;
    }
    case "interval": {
      const anchor = new Date(trigger.anchorAt).getTime();
      const elapsed = after.getTime() - anchor;
      const steps = elapsed < 0 ? 0 : Math.floor(elapsed / trigger.everyMs) + 1;
      return new Date(anchor + steps * trigger.everyMs);
    }
    case "cron":
      assertTimezone(timezone);
      return nextCronOccurrence(trigger.expression, after, timezone);
  }
}
