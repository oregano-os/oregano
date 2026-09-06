import { randomUUID } from "node:crypto";
import type { CompanyOSArtifact } from "../../companyos-builder/types.ts";
import type { WorkflowExecutionStore } from "../../state-store/workflow-engine.ts";
import type { ClaimedDurableTimer } from "../../state-store/durable-timers.ts";
import { DurableTimerService } from "../durable-timers.ts";
import { sha256 } from "../canonical.ts";
import { WorkflowEngine } from "./engine.ts";
import { workflowNextTrigger } from "./calendar.ts";

export interface WorkflowWorkerConfiguration {
  enabledWorkflowIds: readonly string[];
  autoOpenWorkflowIds: readonly string[];
  schedulePrincipal: string;
  activatedAt: string;
  maxLatenessMinutes: number;
}
export type WorkflowWorkerKind = "timers" | "steps";
export interface WorkflowWorkerResult {
  ok: boolean;
  claimed: boolean;
  processed: number;
  opened: number;
  continued: boolean;
  errors: Array<{ reference: string; errorDigest: string }>;
}

/** Bounded hosted ticks with durable pagination; no in-process sleep or business period inference. */
export class WorkflowWorkers {
  readonly #args: { engine: WorkflowEngine; artifact: CompanyOSArtifact; store: WorkflowExecutionStore; timers: DurableTimerService; configuration: WorkflowWorkerConfiguration; clock?: () => string };
  constructor(args: { engine: WorkflowEngine; artifact: CompanyOSArtifact; store: WorkflowExecutionStore; timers: DurableTimerService; configuration: WorkflowWorkerConfiguration; clock?: () => string }) {
    if (args.artifact.instance.id !== args.timers.instanceId) throw new Error("Workflow worker timer Instance differs from its Artifact");
    this.#args = { ...args, configuration: structuredClone(args.configuration) };
  }
  #now(): string { return this.#args.clock?.() ?? new Date().toISOString(); }
  async #openDue(now: string, result: WorkflowWorkerResult): Promise<void> {
    const { configuration: config, artifact, engine, timers } = this.#args;
    const from = new Date(Math.max(Date.parse(config.activatedAt), Date.parse(now) - config.maxLatenessMinutes * 60_000)).toISOString();
    if (from > now || !config.autoOpenWorkflowIds.length) return;
    const dueAt = new Date(Math.floor(Date.parse(now) / 60_000) * 60_000).toISOString();
    const timerKind = "workflow-host-schedules", configDigest = sha256({ artifact: artifact.artifactHash, config });
    const rootId = sha256({ instanceId: artifact.instance.id, timerKind, dueAt, configDigest });
    // The scan window and cursor survive slow providers, restarts and pagination.
    await timers.schedule({ timerId: rootId, timerKind, dueAt, idempotencyKey: rootId,
      payload: { config_digest: configDigest, from: new Date(Math.max(Date.parse(config.activatedAt), Date.parse(dueAt) - config.maxLatenessMinutes * 60_000)).toISOString(), until: dueAt, index: 0,
        after: new Date(Math.max(Date.parse(config.activatedAt), Date.parse(dueAt) - config.maxLatenessMinutes * 60_000)).toISOString() } });
    const [job] = await timers.claimDue({ timerKind, now, owner: "workflow-schedules", leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.parse(now) + 300_000).toISOString(), limit: 1 });
    if (!job) return;
    try {
      const payload = job.payload as Record<string, any>;
      if (typeof payload.until === "string" && Date.parse(now) - Date.parse(payload.until) > config.maxLatenessMinutes * 60_000) {
        result.errors.push({ reference: job.timerId, errorDigest: sha256("Schedule scan exceeded its configured lateness window") });
        await timers.complete(job, { outcome: "lateness-window-expired" }, this.#now()); return;
      }
      if (payload.config_digest !== configDigest) { await timers.complete(job, { outcome: "configuration-superseded" }, this.#now()); return; }
      if (!Number.isInteger(payload.index) || payload.index < 0 || payload.index >= config.autoOpenWorkflowIds.length
        || typeof payload.after !== "string" || typeof payload.until !== "string" || typeof payload.from !== "string") throw new Error("Invalid schedule scan cursor");
      let index = payload.index, after = payload.after, count = 0;
      const deadline = Date.now() + 45_000;
      while (index < config.autoOpenWorkflowIds.length && count < 100 && Date.now() < deadline) {
        const id = config.autoOpenWorkflowIds[index]!, workflow = artifact.workflows?.find((workflow) => workflow.id === id);
        const schedule = workflow?.schedules.find((schedule) => workflow.trigger.kind === "schedule" && schedule.path === workflow.trigger.schedulePath)?.declaration;
        if (!config.enabledWorkflowIds.includes(id) || workflow?.trigger.kind !== "schedule" || !schedule || schedule.activation !== "active") { index++; after = payload.from; continue; }
        const occurrence = workflowNextTrigger(schedule, workflow.trigger.id, after);
        if (occurrence.instant > payload.until) { index++; after = payload.from; continue; }
        await engine.openScheduled({ workflowId: id, principal: config.schedulePrincipal, fields: {}, instant: occurrence.instant });
        result.opened++; count++; after = new Date(Date.parse(occurrence.instant) + 1).toISOString();
      }
      if (index < config.autoOpenWorkflowIds.length) {
        const next = { ...payload, index, after }, id = sha256({ parent: job.timerId, next });
        await timers.schedule({ timerId: id, timerKind, dueAt: job.dueAt, idempotencyKey: id, payload: next });
        result.continued = true;
      }
      if (!await timers.complete(job, { outcome: "scan-completed", index, after }, this.#now())) throw new Error("Schedule scan lost its lease");
    } catch (error) {
      const errorDigest = sha256(error instanceof Error ? error.message : String(error));
      await timers.retry(job, job.dueAt, { outcome: "schedule-error", error_digest: errorDigest });
      result.errors.push({ reference: job.timerId, errorDigest });
    }
  }
  async #continue(timer: ClaimedDurableTimer, afterRunId: string): Promise<void> {
    const timerId = sha256({ parent: timer.timerId, afterRunId });
    await this.#args.timers.schedule({ timerId, timerKind: timer.timerKind, dueAt: timer.dueAt, idempotencyKey: timerId, payload: { after_run_id: afterRunId } });
  }
  async run(kind: WorkflowWorkerKind): Promise<WorkflowWorkerResult> {
    const { engine, artifact, store, timers, configuration } = this.#args;
    const now = this.#now(), dueAt = new Date(Math.floor(Date.parse(now) / 60_000) * 60_000).toISOString();
    const timerKind = `workflow-host-${kind}`, timerId = sha256({ instanceId: artifact.instance.id, timerKind, dueAt });
    const result: WorkflowWorkerResult = { ok: true, claimed: false, processed: 0, opened: 0, continued: false, errors: [] };
    await timers.schedule({ timerId, timerKind, dueAt, idempotencyKey: timerId, payload: {} });
    const [job] = await timers.claimDue({ timerKind, now, owner: "workflow-host", leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.parse(now) + 300_000).toISOString(), limit: 1 });
    if (!job) return result;
    result.claimed = true;
    const deadline = Date.now() + 150_000;
    try {
      const payload = job.payload as Record<string, unknown>, after = payload.after_run_id;
      if (after !== undefined && typeof after !== "string") throw new Error("Workflow worker continuation is invalid");
      let continuation: string | undefined;
      if (kind === "timers") {
        await this.#openDue(now, result);
        const repaired = await engine.timers({ ...(after ? { repairAfterRunId: after } : {}) });
        result.processed = repaired.completed; continuation = repaired.repairAfterRunId;
        result.errors.push(...repaired.errors.map((error) => ({ reference: error.timerId, errorDigest: error.errorDigest })));
      } else {
        const runs = await store.list({ instanceId: artifact.instance.id, activeOnly: true, limit: 200, ...(after ? { afterRunId: after } : {}) });
        let last = after;
        for (const candidate of runs) {
          if (Date.now() >= deadline) { continuation = last; break; }
          last = candidate.runId;
          if (!configuration.enabledWorkflowIds.includes(candidate.workflowId)) continue;
          try {
            let run = candidate;
            const hasWork = () => run.state.status === "running" || (run.state.status === "waiting" && !!run.state.blocked
              && !run.state.reviewDelivery?.blocked && (!run.state.reviewDelivery || run.state.reviewDelivery.outputs.length < run.state.reviewDelivery.pages.length));
            for (let count = 0; count < 32 && Date.now() < deadline && hasWork(); count++) {
              const next = await engine.advance(run.runId, 1);
              if (!next || next.revision === run.revision) break;
              result.processed++; run = next;
            }
          } catch (error) { result.errors.push({ reference: candidate.runId, errorDigest: sha256(error instanceof Error ? error.message : String(error)) }); }
        }
        if (runs.length === 200 && !continuation) continuation = last;
      }
      if (continuation) { await this.#continue(job, continuation); result.continued = true; }
      result.ok = result.errors.length === 0;
      if (!await timers.complete(job, { processed: result.processed, opened: result.opened, continued: result.continued, errors: result.errors }, this.#now())) throw new Error("Workflow worker lost its completion lease");
    } catch (error) {
      const errorDigest = sha256(error instanceof Error ? error.message : String(error));
      await timers.retry(job, job.dueAt, { outcome: "worker-error", error_digest: errorDigest });
      result.ok = false; result.errors.push({ reference: job.timerId, errorDigest });
    }
    return result;
  }
}
