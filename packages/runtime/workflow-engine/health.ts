import type { CompanyOSArtifact } from "../../companyos-builder/types.ts";
import type { WorkflowExecutionStore } from "../../state-store/workflow-engine.ts";
import { localDateAt } from "../local-time.ts";
import { workflowOccurrences } from "./calendar.ts";
import type { WorkflowWorkerConfiguration } from "./workers.ts";

/** Operator monitoring reads durable state even when generation or workers fail. */
export async function inspectWorkflowHealth(args: {
  artifact: CompanyOSArtifact; store: WorkflowExecutionStore; configuration: WorkflowWorkerConfiguration;
  workflowId: string; now: string; graceMinutes: number;
}) {
  const { artifact, store, configuration, workflowId, now, graceMinutes } = args;
  if (!Number.isInteger(graceMinutes) || graceMinutes < 5 || graceMinutes > 1440 || !Number.isFinite(Date.parse(now))) throw new Error("Invalid health check bounds");
  const workflow = artifact.workflows?.find(workflow => workflow.id === workflowId);
  if (!workflow || workflow.trigger.kind !== "schedule") throw new Error("Health requires a declared scheduled workflow");
  const trigger = workflow.trigger;
  const schedule = workflow.schedules.find(value => value.path === trigger.schedulePath)?.declaration;
  if (!schedule) throw new Error("Health requires the compiled calendar");
  if (schedule.activation !== "active" || !configuration.enabledWorkflowIds.includes(workflowId)
    || !configuration.autoOpenWorkflowIds.includes(workflowId)) return { ok: true, status: "disabled", workflowId, issues: [] as string[] };
  const from = new Date(Math.max(Date.parse(configuration.activatedAt), Date.parse(now) - 30 * 86_400_000)).toISOString();
  if (from >= now) return { ok: true, status: "not-due", workflowId, issues: [] as string[] };
  const expected = workflowOccurrences(schedule, { fromDate: localDateAt(from, schedule.timezone), toDate: localDateAt(now, schedule.timezone), triggerId: workflow.trigger.id })
    .filter(value => value.instant > from && Date.parse(value.instant) + graceMinutes * 60_000 <= Date.parse(now));
  const runs = await store.history({ instanceId: artifact.instance.id, workflowIds: [workflowId], from, to: now, limit: 101 });
  const issues: string[] = [];
  if (runs.length > 100) issues.push("history-truncated");
  const blocked = runs.filter(run => run.state.blocked && !["done", "cancelled"].includes(run.state.status));
  if (blocked.length) issues.push("blocked-run");
  const latest = expected.at(-1);
  const succeeded = (instant: string) => runs.some(run => run.trigger.instant === instant && run.state.status === "done");
  if (latest && !succeeded(latest.instant)) issues.push("successful-review-overdue");
  if (expected.length >= 2 && expected.slice(-2).every(value => !succeeded(value.instant))) issues.push("repeated-unsuccessful-occurrences");
  return { ok: issues.length === 0, status: issues.length ? "needs-attention" : "healthy", workflowId, issues,
    checkedAt: now, graceMinutes, expectedLatest: latest?.instant ?? null,
    lastSuccess: runs.find(run => run.state.status === "done")?.trigger.instant ?? null,
    blockedRunIds: blocked.map(run => run.runId), runCount: runs.length };
}
