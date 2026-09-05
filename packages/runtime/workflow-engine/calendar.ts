import type { JsonValue } from "../../capabilities/contracts.ts";
import type { WorkflowSchedule } from "../../companyos-builder/workflow-types.ts";
import { addCalendarDays, weekdayOf } from "../business-time.ts";
import { canonicalJson } from "../canonical.ts";
import { localDateAt, zonedLocalDateTimeToIso } from "../local-time.ts";

export interface WorkflowOccurrence {
  triggerId: string;
  nominalDate: string;
  localDate: string;
  instant: string;
  params: Record<string, JsonValue>;
}

function assertInstant(value: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("Workflow calendar requires an exact UTC ISO instant");
}

export function workflowBusinessDay(date: string, schedule: WorkflowSchedule): boolean {
  const year = date.slice(0, 4);
  if (!Object.hasOwn(schedule.holiday_calendar.years, year) && schedule.holiday_calendar.missing_year_policy === "block") throw new Error(`Workflow calendar has no reviewed holidays for ${year}`);
  return schedule.business_days.includes(weekdayOf(date)) && !(schedule.holiday_calendar.years[year] ?? []).includes(date);
}

function shift(date: string, direction: -1 | 1, schedule: WorkflowSchedule): string {
  let candidate = date;
  for (let count = 0; count < 370; count++) {
    if (workflowBusinessDay(candidate, schedule)) return candidate;
    candidate = addCalendarDays(candidate, direction);
  }
  throw new Error("Workflow calendar cannot resolve a business day within one year");
}

/** Enumerate nominal dates; activation is checked by the dispatcher, not changed by evaluation. */
export function workflowOccurrences(schedule: WorkflowSchedule, args: { fromDate: string; toDate: string; triggerId?: string }): WorkflowOccurrence[] {
  weekdayOf(args.fromDate); weekdayOf(args.toDate);
  const span = (Date.parse(`${args.toDate}T00:00:00Z`) - Date.parse(`${args.fromDate}T00:00:00Z`)) / 86_400_000;
  if (span < 0 || span > 370) throw new Error("Workflow occurrence window must be at most 371 dates");
  if (args.triggerId && !schedule.triggers.some((trigger) => trigger.id === args.triggerId)) throw new Error("Workflow schedule trigger is absent");
  const found = new Map<string, WorkflowOccurrence>();
  for (let date = args.fromDate; date <= args.toDate; date = addCalendarDays(date, 1)) {
    for (const trigger of schedule.triggers) {
      if ((args.triggerId && trigger.id !== args.triggerId) || !trigger.weekdays.includes(weekdayOf(date))) continue;
      let effective = date;
      if (!workflowBusinessDay(effective, schedule)) {
        if (!trigger.holiday_shift || trigger.holiday_shift === "none") continue;
        effective = shift(date, trigger.holiday_shift === "previous-business-day" ? -1 : 1, schedule);
      }
      const occurrence = { triggerId: trigger.id, nominalDate: date, localDate: effective, instant: zonedLocalDateTimeToIso(effective, trigger.at, schedule.timezone), params: structuredClone(trigger.params ?? {}) };
      const key = canonicalJson([trigger.id, occurrence.instant]);
      const prior = found.get(key);
      if (prior && canonicalJson(prior.params) !== canonicalJson(occurrence.params)) throw new Error("Colliding workflow triggers disagree on frozen parameters");
      if (!prior) found.set(key, occurrence);
    }
  }
  return [...found.values()].sort((a, b) => a.instant.localeCompare(b.instant) || a.triggerId.localeCompare(b.triggerId));
}

/** Waits follow the run's last logical instant, so late processing does not skip to another week. */
export function workflowNextTrigger(schedule: WorkflowSchedule, triggerId: string, after: string): WorkflowOccurrence {
  assertInstant(after);
  const date = localDateAt(after, schedule.timezone);
  // Search in nominal-date order but account for both holiday shift directions.
  // Missing calendar years stop the search instead of manufacturing an occurrence.
  const candidates: WorkflowOccurrence[] = [];
  for (let distance = 0; distance <= 370; distance++) {
    const forward = addCalendarDays(date, distance);
    const at = workflowOccurrences(schedule, { fromDate: forward, toDate: forward, triggerId });
    candidates.push(...at.filter((occurrence) => occurrence.instant >= after));
    if (candidates.length) {
      // A subsequent nominal date can shift backwards onto an earlier business
      // day, but cannot cross a reviewed business day. Scan through the next
      // business day before accepting the earliest candidate.
      const earliestDate = candidates.reduce((earliest, occurrence) => occurrence.localDate < earliest ? occurrence.localDate : earliest, candidates[0]!.localDate);
      if (forward > earliestDate && workflowBusinessDay(forward, schedule)) break;
    }
  }
  // A nominal date before 'after' can shift forward, but only across the
  // immediately preceding non-business interval.
  for (let distance = 1; schedule.triggers.some((trigger) => trigger.id === triggerId && trigger.holiday_shift === "next-business-day") && distance <= 370; distance++) {
    const prior = addCalendarDays(date, -distance);
    if (workflowBusinessDay(prior, schedule)) break;
    candidates.push(...workflowOccurrences(schedule, { fromDate: prior, toDate: prior, triggerId }).filter((occurrence) => occurrence.instant >= after));
  }
  const next = candidates.sort((a, b) => a.instant.localeCompare(b.instant))[0];
  if (!next) throw new Error("Workflow wait has no eligible trigger within one year");
  return next;
}

const localMinute = (instant: string, timezone: string): string => {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
  return `${parts.find((part) => part.type === "hour")!.value}:${parts.find((part) => part.type === "minute")!.value}`;
};

export function workflowBusinessDeadline(schedule: WorkflowSchedule, start: string, businessDays: number): string {
  assertInstant(start);
  if (!Number.isInteger(businessDays) || businessDays < 1 || businessDays > 366) throw new Error("Business-day duration must be an integer from 1 to 366");
  let date = localDateAt(start, schedule.timezone), remaining = businessDays;
  workflowBusinessDay(date, schedule); // Validate the starting year's coverage as well.
  for (let count = 0; remaining > 0 && count < 3700; count++) {
    date = addCalendarDays(date, 1);
    if (workflowBusinessDay(date, schedule)) remaining--;
  }
  if (remaining) throw new Error("Business-day duration exceeds the calendar search bound");
  const base = zonedLocalDateTimeToIso(date, localMinute(start, schedule.timezone), schedule.timezone);
  return new Date(Date.parse(base) + ((Date.parse(start) % 60_000) + 60_000) % 60_000).toISOString();
}

/** Opening inclusive, closing exclusive. Returns the same instant while delivery is allowed. */
export function workflowDeliveryInstant(schedule: WorkflowSchedule, now: string): string {
  assertInstant(now);
  let date = localDateAt(now, schedule.timezone);
  const { opens_at: opens, closes_at: closes } = schedule.delivery_window;
  if (opens >= closes) throw new Error("Workflow delivery window must open before it closes");
  if (workflowBusinessDay(date, schedule)) {
    const open = zonedLocalDateTimeToIso(date, opens, schedule.timezone), close = zonedLocalDateTimeToIso(date, closes, schedule.timezone);
    if (now >= open && now < close) return now;
    if (now < open) return open;
    date = addCalendarDays(date, 1);
  }
  return zonedLocalDateTimeToIso(shift(date, 1, schedule), opens, schedule.timezone);
}
