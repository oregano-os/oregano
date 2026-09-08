import { randomUUID } from "node:crypto";
import type { JsonValue } from "../../capabilities/contracts.ts";
import type { CompanyOSArtifact } from "../../companyos-builder/types.ts";
import type { WorkflowExecutionStore } from "../../state-store/workflow-engine.ts";
import type { ClaimedDurableTimer } from "../../state-store/durable-timers.ts";
import { DurableTimerService } from "../durable-timers.ts";
import { sha256 } from "../canonical.ts";

export interface WorkflowRecordSyncConfiguration {
  intervalMinutes: number;
  targets: Array<{ artifactHash: string; sourceIds: string[] }>;
}

export function parseWorkflowRecordSyncConfiguration(value: unknown): WorkflowRecordSyncConfiguration | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("recordSync must be an object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["intervalMinutes", "targets"].includes(key)) || !Number.isInteger(input.intervalMinutes)
    || Number(input.intervalMinutes) < 1 || Number(input.intervalMinutes) > 1440) throw new Error("recordSync requires an explicit polling interval between one minute and one day");
  if (!Array.isArray(input.targets) || !input.targets.length || input.targets.length > 100) throw new Error("recordSync requires bounded exact Artifact/source targets");
  const pairs = new Set<string>(), hashes = new Set<string>();
  const targets = input.targets.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("recordSync target must be an object");
    const target = raw as Record<string, unknown>;
    if (Object.keys(target).some((key) => !["artifactHash", "sourceIds"].includes(key)) || typeof target.artifactHash !== "string"
      || !/^[a-f0-9]{64}$/.test(target.artifactHash) || hashes.has(target.artifactHash)) throw new Error("recordSync requires unique exact Artifact hashes");
    hashes.add(target.artifactHash);
    if (!Array.isArray(target.sourceIds) || !target.sourceIds.length || target.sourceIds.some((id) => typeof id !== "string" || !/^[a-z][a-z0-9-]{1,62}$/.test(id))) throw new Error("recordSync requires explicit source identifiers");
    const sourceIds = target.sourceIds as string[];
    for (const id of sourceIds) {
      const pair = `${target.artifactHash}:${id}`;
      if (pairs.has(pair) || pairs.size >= 100) throw new Error("recordSync source pairs must be unique and bounded to 100");
      pairs.add(pair);
    }
    return { artifactHash: target.artifactHash, sourceIds: [...sourceIds] };
  });
  return { intervalMinutes: Number(input.intervalMinutes), targets };
}

export interface WorkflowRecordWorkerResult {
  ok: boolean;
  enabled: boolean;
  claimed: boolean;
  synchronized: number;
  skipped: number;
  continued: boolean;
  errors: Array<{ artifactHash: string; sourceId: string; errorDigest: string }>;
}

interface WorkflowRecordWorkerOptions {
  artifact: CompanyOSArtifact; store: WorkflowExecutionStore; timers: DurableTimerService;
  enabledWorkflowIds: readonly string[]; recordSync?: WorkflowRecordSyncConfiguration;
  synchronizeSource(artifact: CompanyOSArtifact, sourceId: string, jobId: string): Promise<JsonValue>;
  clock?: () => string;
}
/** Poll retained generations through the existing Records service, never through a business workflow executor. */
export class WorkflowRecordWorkers {
  readonly #args: WorkflowRecordWorkerOptions;
  constructor(args: WorkflowRecordWorkerOptions) {
    if (args.artifact.instance.id !== args.timers.instanceId) throw new Error("Records worker timer Instance differs from its Artifact");
    this.#args = { ...args, enabledWorkflowIds: [...args.enabledWorkflowIds], recordSync: parseWorkflowRecordSyncConfiguration(args.recordSync) };
  }
  #now(): string { return this.#args.clock?.() ?? new Date().toISOString(); }

  async run(): Promise<WorkflowRecordWorkerResult> {
    const { artifact, store, timers, enabledWorkflowIds, recordSync, synchronizeSource } = this.#args;
    const result: WorkflowRecordWorkerResult = { ok: true, enabled: !!recordSync && enabledWorkflowIds.length > 0, claimed: false, synchronized: 0, skipped: 0, continued: false, errors: [] };
    if (!result.enabled || !recordSync) return result;
    const now = this.#now(), interval = recordSync.intervalMinutes * 60_000;
    const dueAt = new Date(Math.floor(Date.parse(now) / interval) * interval).toISOString();
    const targets = recordSync.targets.flatMap((target) => target.sourceIds.map((sourceId) => ({ artifactHash: target.artifactHash, sourceId })));
    const configDigest = sha256({ artifact: artifact.artifactHash, recordSync, enabledWorkflowIds });
    const timerKind = "workflow-host-records", timerId = sha256({ instanceId: artifact.instance.id, timerKind, dueAt, configDigest });
    await timers.schedule({ timerId, timerKind, dueAt, idempotencyKey: timerId, payload: { config_digest: configDigest, index: 0 } });
    let job: ClaimedDurableTimer | undefined;
    // Coalesce obsolete unopened polls; retain an already-started continuation
    // even when it spans more than one interval. Work never accumulates an
    // unbounded queue of redundant content reads after a slow provider.
    const claimDeadline = Date.now() + 30_000;
    for (let claims = 0; claims < 100 && Date.now() < claimDeadline; claims++) {
      [job] = await timers.claimDue({ timerKind, now, owner: "workflow-records", leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.parse(now) + 300_000).toISOString(), limit: 1 });
      if (!job) return result;
      const payload = job.payload as Record<string, JsonValue>;
      if (payload.config_digest === configDigest && (job.dueAt >= dueAt || payload.index !== 0)) break;
      if (!await timers.complete(job, { outcome: "configuration-or-poll-superseded" }, this.#now())) throw new Error("Records worker lost its completion lease");
      result.skipped++; job = undefined;
    }
    if (!job) return result;
    result.claimed = true;
    try {
      const payload = job.payload as Record<string, JsonValue>;
      if (!Number.isInteger(payload.index) || Number(payload.index) < 0 || Number(payload.index) >= targets.length) throw new Error("Records worker cursor is invalid");
      let index = Number(payload.index), attempted = 0;
      const deadline = Date.now() + 150_000;
      const evidence: JsonValue[] = [];
      while (index < targets.length && attempted < 3 && Date.now() < deadline) {
        const target = targets[index]!;
        try {
          const current = target.artifactHash === artifact.artifactHash;
          if (!current && !await store.hasActiveArtifact({ instanceId: artifact.instance.id, artifactHash: target.artifactHash, workflowIds: enabledWorkflowIds })) {
            result.skipped++; index++; continue;
          }
          const pinned = current ? artifact : await store.getArtifact(target.artifactHash);
          if (!pinned || pinned.artifactHash !== target.artifactHash || pinned.instance.id !== artifact.instance.id
            || pinned.instance.environment !== artifact.instance.environment) throw new Error("Qualified historical Records Artifact is unavailable or belongs to another Instance");
          attempted++;
          evidence.push({ artifact_hash: target.artifactHash, source_id: target.sourceId,
            receipt: await synchronizeSource(pinned, target.sourceId, sha256({ dueAt: job.dueAt, configDigest, target })) });
          result.synchronized++;
        } catch (error) {
          result.errors.push({ ...target, errorDigest: sha256(error instanceof Error ? error.message : String(error)) });
        }
        index++;
      }
      if (index < targets.length) {
        const nextId = sha256({ parent: job.timerId, index });
        await timers.schedule({ timerId: nextId, timerKind, dueAt: job.dueAt, idempotencyKey: nextId, payload: { config_digest: configDigest, index } });
        result.continued = true;
      }
      result.ok = result.errors.length === 0;
      if (!await timers.complete(job, { outcome: "poll-completed", next_index: index, evidence, errors: result.errors }, this.#now())) throw new Error("Records worker lost its completion lease");
    } catch (error) {
      const errorDigest = sha256(error instanceof Error ? error.message : String(error));
      await timers.retry(job, job.dueAt, { outcome: "worker-error", error_digest: errorDigest });
      result.ok = false; result.errors.push({ artifactHash: artifact.artifactHash, sourceId: "worker", errorDigest });
    }
    return result;
  }
}
