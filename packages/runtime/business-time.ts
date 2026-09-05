import { addLocalCalendarDays } from "./local-time.ts";

export type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";
export interface BusinessCalendar {
  id: string;
  holidays: string[];
  weekend?: Weekday[];
}
const weekdays: Weekday[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
export { zonedLocalDateTimeToIso } from "./local-time.ts";
export const addCalendarDays = addLocalCalendarDays;

export function weekdayOf(value: string): Weekday {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) throw new Error(`Invalid calendar date '${value}'`);
  return weekdays[new Date(`${value}T00:00:00.000Z`).getUTCDay()]!;
}
export function isBusinessDay(value: string, calendar: BusinessCalendar): boolean {
  return !(calendar.weekend ?? ["saturday", "sunday"]).includes(weekdayOf(value)) && !calendar.holidays.includes(value);
}
export function shiftToBusinessDay(value: string, direction: "previous" | "next", calendar: BusinessCalendar): string {
  let candidate = value;
  for (let attempts = 0; attempts < 370; attempts += 1) {
    if (isBusinessDay(candidate, calendar)) return candidate;
    candidate = addCalendarDays(candidate, direction === "previous" ? -1 : 1);
  }
  throw new Error("Business calendar could not resolve a working day within one year");
}
