import type { SprintDomainDeclaration, Weekday } from "./contracts.ts";
import { addCalendarDays, weekdayOf, isBusinessDay, shiftToBusinessDay, zonedLocalDateTimeToIso, type BusinessCalendar } from "../../runtime/business-time.ts";
export { addCalendarDays, weekdayOf, isBusinessDay, shiftToBusinessDay, zonedLocalDateTimeToIso, type BusinessCalendar } from "../../runtime/business-time.ts";

export interface SprintCloseSchedule {
  local_date: string;
  reminder_at: string;
  complete_by: string;
  chase_at: string;
  report_at: string;
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
