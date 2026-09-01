import type { SprintDomainDeclaration, Weekday } from "./contracts.ts";

export interface BusinessCalendar {
  id: string;
  holidays: string[];
  weekend?: Weekday[];
}

export interface SprintCloseSchedule {
  local_date: string;
  reminder_at: string;
  complete_by: string;
  report_at: string;
}

const weekdays: Weekday[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const assertDate = (value: string): void => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid calendar date '${value}'`);
  }
};

export function addCalendarDays(value: string, days: number): string {
  assertDate(value);
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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

const partsAt = (instant: number, timezone: string): Record<string, number> => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(instant));
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
};

/** Convert a Workspace-declared local time into a deterministic UTC instant. */
export function zonedLocalDateTimeToIso(date: string, time: string, timezone: string): string {
  assertDate(date);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`Invalid local time '${time}'`);
  new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let candidate = target;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const actual = partsAt(candidate, timezone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    candidate += target - represented;
  }
  const actual = partsAt(candidate, timezone);
  if (actual.year !== year || actual.month !== month || actual.day !== day || actual.hour !== hour || actual.minute !== minute) {
    throw new Error(`Local time '${date} ${time}' does not exist in timezone '${timezone}'`);
  }
  return new Date(candidate).toISOString();
}

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
    report_at: zonedLocalDateTimeToIso(localDate, policy.close.report_at, policy.calendar.timezone),
  };
}
