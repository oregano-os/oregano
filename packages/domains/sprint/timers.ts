import { recordDigest } from "../../records/identity.ts";
import type { DurableTimerService } from "../../runtime/durable-timers.ts";
import { sprintCloseSchedule, type BusinessCalendar } from "./business-time.ts";
import type { SprintDomainDeclaration } from "./contracts.ts";

export async function scheduleSprintCloseTimers(args: {
  timers: DurableTimerService;
  policy: SprintDomainDeclaration;
  calendar: BusinessCalendar;
  sprintId: string;
  periodEnd: string;
  nextSprintId?: string;
}): Promise<{ scheduled: number; existing: number }> {
  const schedule = sprintCloseSchedule({ policy: args.policy, periodEnd: args.periodEnd, calendar: args.calendar });
  const moments = [
    ["reminder", schedule.reminder_at],
    ["complete-by", schedule.complete_by],
    ["report", schedule.report_at],
  ] as const;
  let scheduled = 0;
  for (const [kind, dueAt] of moments) {
    const timerId = recordDigest(["sprint-close", args.sprintId, kind, dueAt]);
    const created = await args.timers.schedule({
      timerId,
      timerKind: "sprint.clock-reached",
      dueAt,
      idempotencyKey: timerId,
      payload: {
        sprint_id: args.sprintId,
        instant: dueAt,
        moment: kind,
        ...(args.nextSprintId ? { next_sprint_id: args.nextSprintId } : {}),
      },
    });
    if (created) scheduled += 1;
  }
  return { scheduled, existing: moments.length - scheduled };
}
