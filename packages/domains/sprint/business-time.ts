import type { SprintDomainDeclaration, Weekday } from "./contracts.ts";
import { addLocalCalendarDays, zonedLocalDateTimeToIso } from "../../runtime/local-time.ts";

export { zonedLocalDateTimeToIso } from "../../runtime/local-time.ts";

export interface BusinessCalendar {
  id: string;
  holidays: string[];
  weekend?: Weekday[];
}

export interface SprintCloseSchedule {
  local_date: string;
  reminder_at: string;
  complete_by: string;
  chase_at: string;
  report_at: string;
}

const weekdays: Weekday[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const assertDate = (value: string): void => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid calendar date '${value}'`);
  }
};

export function addCalendarDays(value: string, days: number): string {
  return addLocalCalendarDays(value, days);
}

export function weekdayOf(value: string): Weekday {
  assertDate(value);
  return weekdays[new Date(`${value}T00:00:00.000Z`).getUTCDay()];
}

export function isBusinessDay(value: string, calendar: BusinessCalendar): boolean {
  const weekend = calendar.weekend ?? ["saturday", "sunday"];
  return !weekend.includes(weekdayOf(value)) && !calendar.holidays.includes(value);
}

export function shiftToBusinessDay(value: string, direction: "previous" | "next", calendar: BusinessCalendar): string {
  let candidate = value;
  const step = direction === "previous" ? -1 : 1;
  for (let attempts = 0; attempts < 370; attempts += 1) {
    if (isBusinessDay(candidate, calendar)) return candidate;
    candidate = addCalendarDays(candidate, step);
  }
  throw new Error("Business calendar could not resolve a working day within one year");
}

const weekdayOnOrBefore = (periodEnd: string, target: Weekday): string => {
  let candidate = periodEnd;
  for (let days = 0; days < 7; days += 1) {
    if (weekdayOf(candidate) === target) return candidate;
    candidate = addCalendarDays(candidate, -1);
  }
  throw new Error(`Could not resolve weekday '${target}'`);
};

export function sprintCloseSchedule(args: {
  policy: SprintDomainDeclaration;
  periodEnd: string;
  calendar: BusinessCalendar;
}): SprintCloseSchedule {
  const { policy, periodEnd, calendar } = args;
  if (calendar.id !== policy.calendar.business_calendar_ref) throw new Error(`Business calendar '${calendar.id}' does not match Sprint policy reference '${policy.calendar.business_calendar_ref}'`);
  let localDate = weekdayOnOrBefore(periodEnd, policy.close.weekday);
  if (!isBusinessDay(localDate, calendar)) {
    if (policy.calendar.holiday_shift === "previous-business-day") localDate = shiftToBusinessDay(localDate, "previous", calendar);
    if (policy.calendar.holiday_shift === "next-business-day") localDate = shiftToBusinessDay(localDate, "next", calendar);
  }
  return {
    local_date: localDate,
    reminder_at: zonedLocalDateTimeToIso(localDate, policy.close.reminder_time, policy.calendar.timezone),
    complete_by: zonedLocalDateTimeToIso(localDate, policy.close.complete_by, policy.calendar.timezone),
    chase_at: zonedLocalDateTimeToIso(localDate, policy.close.chase_time ?? policy.close.complete_by, policy.calendar.timezone),
    report_at: zonedLocalDateTimeToIso(localDate, policy.close.report_at, policy.calendar.timezone),
  };
}
