import { recordDigest } from "../../records/identity.ts";
import type { DurableTimerService } from "../../runtime/durable-timers.ts";
import { sprintCloseSchedule, type BusinessCalendar } from "./business-time.ts";
import { addCalendarDays, isBusinessDay, shiftToBusinessDay, weekdayOf, zonedLocalDateTimeToIso } from "./business-time.ts";
import type { SprintDomainDeclaration } from "./contracts.ts";

export async function scheduleSprintCloseTimers(args: {
  timers: DurableTimerService;
  policy: SprintDomainDeclaration;
  calendar: BusinessCalendar;
  sprintId: string;
  periodEnd: string;
  nextSprintId?: string;
  scheduleVersion?: string;
}): Promise<{ scheduled: number; existing: number }> {
  const schedule = sprintCloseSchedule({ policy: args.policy, periodEnd: args.periodEnd, calendar: args.calendar });
  const moments = [
    ["reminder", schedule.reminder_at],
    ["chase", schedule.chase_at],
    ["report", schedule.report_at],
  ] as const;
  let scheduled = 0;
  for (const [kind, dueAt] of moments) {
    const timerId = recordDigest(["sprint-close", args.scheduleVersion ?? "unversioned", args.sprintId, kind, dueAt]);
    const created = await args.timers.schedule({
      timerId,
      timerKind: `sprint.clock-reached:${args.policy.id}`,
      dueAt,
      idempotencyKey: timerId,
      payload: {
        sprint_id: args.sprintId,
        instant: dueAt,
        moment: kind,
        ...(args.scheduleVersion ? { schedule_version: args.scheduleVersion } : {}),
        ...(args.nextSprintId ? { next_sprint_id: args.nextSprintId } : {}),
      },
    });
    if (created) scheduled += 1;
  }
  return { scheduled, existing: moments.length - scheduled };
}

export interface SprintWeeklyTrigger {
  id: string;
  weekdays: SprintDomainDeclaration["close"]["weekday"][];
  at: string;
  holidayShift?: "previous-business-day" | "next-business-day" | "none";
}

/** Schedule only the weekly trigger ids explicitly selected by Workspace policy. */
export async function scheduleSprintWeekTimers(args: {
  timers: DurableTimerService;
  policy: SprintDomainDeclaration;
  calendar: BusinessCalendar;
  sprintId: string;
  periodStart: string;
  periodEnd: string;
  triggers: SprintWeeklyTrigger[];
  scheduleVersion?: string;
}): Promise<{ scheduled: number; existing: number }> {
  if (!args.policy.weekly) return { scheduled: 0, existing: 0 };
  const selectedIds = new Set([
    args.policy.weekly.monday_handoff_trigger,
    args.policy.weekly.weekday_digest_trigger,
  ].filter((id): id is string => Boolean(id)));
  const selected = args.triggers.filter((trigger) => selectedIds.has(trigger.id));
  if (selected.length !== selectedIds.size) throw new Error("Sprint weekly policy references an absent schedule trigger");
  const moments: Array<{ triggerId: string; dueAt: string }> = [];
  for (let localDate = args.periodStart; localDate <= args.periodEnd; localDate = addCalendarDays(localDate, 1)) {
    for (const trigger of selected) {
      if (!trigger.weekdays.includes(weekdayOf(localDate))) continue;
      let effectiveDate = localDate;
      if (!isBusinessDay(effectiveDate, args.calendar)) {
        const shift = trigger.holidayShift ?? "none";
        if (shift === "none") continue;
        effectiveDate = shiftToBusinessDay(effectiveDate, shift === "previous-business-day" ? "previous" : "next", args.calendar);
      }
      moments.push({
        triggerId: trigger.id,
        dueAt: zonedLocalDateTimeToIso(effectiveDate, trigger.at, args.policy.calendar.timezone),
      });
    }
  }
  let scheduled = 0;
  for (const moment of moments) {
    const timerId = recordDigest(["sprint-week", args.scheduleVersion ?? "unversioned", args.sprintId, moment.triggerId, moment.dueAt]);
    const created = await args.timers.schedule({
      timerId,
      timerKind: `sprint.clock-reached:${args.policy.id}`,
      dueAt: moment.dueAt,
      idempotencyKey: timerId,
      payload: {
        sprint_id: args.sprintId,
        instant: moment.dueAt,
        moment: "weekly",
        trigger_id: moment.triggerId,
        ...(args.scheduleVersion ? { schedule_version: args.scheduleVersion } : {}),
      },
    });
    if (created) scheduled += 1;
  }
  return { scheduled, existing: moments.length - scheduled };
}
