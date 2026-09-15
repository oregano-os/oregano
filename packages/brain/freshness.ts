import { randomUUID } from "node:crypto";
import { sha256 } from "../runtime/canonical.ts";
import type { DurableTimerService } from "../runtime/durable-timers.ts";
import type { BrainScope } from "./contracts.ts";
import { BrainError } from "./contracts.ts";
import type { syncBrain } from "./sync.ts";

/** Brain consumes the existing durable scheduler; it owns no clock, queue or source content. */
export class BrainFreshness {
  readonly options: { scope: BrainScope; bindingDigest: string; configurationDigest: string; intervalSeconds: number;
    timers: DurableTimerService; sync: () => ReturnType<typeof syncBrain>; now?: () => Date };
  constructor(options: BrainFreshness["options"]) {
    if (options.timers.instanceId !== options.scope.instance_id || !Number.isSafeInteger(options.intervalSeconds)
      || options.intervalSeconds < 300 || options.intervalSeconds > 86400) throw new BrainError("invalid_binding", "Brain freshness needs its own Instance and a bounded explicit interval.");
    this.options = options;
  }
  #identity() { return { scope: { ...this.options.scope }, binding_digest: this.options.bindingDigest, configuration_digest: this.options.configurationDigest }; }
  #now() { return this.options.now?.() ?? new Date(); }
  async #schedule(timer: Parameters<DurableTimerService["schedule"]>[0]): Promise<boolean> {
    const { timers } = this.options;
    const exists = async () => {
      const row = await timers.get(timer.timerId);
      if (!row) return false;
      if (row.timerKind !== timer.timerKind || row.idempotencyKey !== timer.idempotencyKey || sha256(row.payload) !== sha256(timer.payload)) {
        throw new BrainError("timer_conflict", "Brain timer identity conflicts with retained scheduling state.");
      }
      return true;
    };
    if (await exists()) return false;
    try { return await timers.schedule(timer); }
    catch (error) { if (await exists()) return false; throw error; }
  }
  async notify(deliveryId: string): Promise<boolean> {
    if (!deliveryId || deliveryId.length > 256) throw new BrainError("invalid_notification", "A bounded verified delivery identity is required.");
    const identity = this.#identity(), id = `brain-push:${sha256({ ...identity, deliveryId })}`;
    return this.#schedule({ timerId: id, timerKind: "brain-sync", idempotencyKey: id, dueAt: "1970-01-01T00:00:00.000Z",
      payload: { ...identity, trigger: "push", delivery_digest: sha256(deliveryId) } });
  }
  async tick() {
    const { timers, intervalSeconds } = this.options, identity = this.#identity(), now = this.#now(), interval = intervalSeconds * 1000;
    // Persist the current bucket only. Missed wake-ups do not create an unbounded backlog.
    const bucket = Math.floor(now.getTime() / interval), id = `brain-reconcile:${sha256({ ...identity, bucket })}`;
    await this.#schedule({ timerId: id, timerKind: "brain-sync", idempotencyKey: id, dueAt: new Date(bucket * interval).toISOString(), payload: { ...identity, trigger: "periodic" } });
    const claimed = await timers.claimDue({ timerKind: "brain-sync", now: now.toISOString(), owner: "brain-reconcile", leaseToken: randomUUID(),
      leaseExpiresAt: new Date(now.getTime() + 300_000).toISOString(), limit: 25 });
    if (!claimed.length) return { status: "idle", processed: 0 };
    const selected = [];
    for (const timer of claimed) {
      const payload = timer.payload as Record<string, unknown>;
      if (!payload || !payload.scope || sha256(payload.scope) !== sha256(identity.scope) || payload.binding_digest !== identity.binding_digest || payload.configuration_digest !== identity.configuration_digest) {
        await timers.complete(timer, { status: "obsolete_binding" }, this.#now().toISOString());
      } else selected.push(timer);
    }
    if (!selected.length) return { status: "obsolete_binding", processed: claimed.length };
    try {
      const synced = await this.options.sync();
      if (synced.status === "invalid") throw new BrainError("invalid_corpus", "Brain synchronization found invalid pages.");
      const evidence = { status: synced.status, indexed_revision: { ...synced.indexed_revision } };
      for (const timer of selected) if (!await timers.complete(timer, evidence, this.#now().toISOString())) throw new BrainError("timer_lease_lost", "Brain timer completion lost its lease.");
      return { status: synced.status, processed: claimed.length, indexed_revision: synced.indexed_revision };
    } catch (error) {
      const evidence = { status: "failed", error_code: error instanceof BrainError ? error.code : "sync_unavailable" };
      const due = new Date(this.#now().getTime() + Math.min(3600, 30 * 2 ** Math.min(Math.max(...selected.map(timer => timer.attempts)), 7)) * 1000).toISOString();
      for (const timer of selected) if (!await timers.retry(timer, due, evidence)) throw new BrainError("timer_lease_lost", "Brain retry lost its lease.");
      return { status: "retry_scheduled", processed: claimed.length, error_code: evidence.error_code, retry_at: due };
    }
  }
}
