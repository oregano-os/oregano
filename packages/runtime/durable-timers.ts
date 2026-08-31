import type { JsonValue } from "../capabilities/contracts.ts";
import type { ClaimedDurableTimer, DurableTimer, DurableTimerStore } from "../state-store/durable-timers.ts";

/** Scheduler facade: it persists timers and claims due work; it never sleeps in-process. */
export class DurableTimerService {
  readonly store: DurableTimerStore;
  readonly instanceId: string;

  constructor(args: { store: DurableTimerStore; instanceId: string }) {
    this.store = args.store;
    this.instanceId = args.instanceId;
  }

  async schedule(timer: Omit<DurableTimer, "instanceId">): Promise<boolean> {
    return this.store.schedule({ ...timer, instanceId: this.instanceId });
  }

  async claimDue(args: { now: string; owner: string; leaseToken: string; leaseExpiresAt: string; limit?: number }): Promise<ClaimedDurableTimer[]> {
    return this.store.claimDue({ ...args, instanceId: this.instanceId, limit: Math.min(Math.max(args.limit ?? 50, 1), 200) });
  }

  async complete(timer: ClaimedDurableTimer, evidence: JsonValue, completedAt: string): Promise<boolean> {
    return this.store.complete({ instanceId: this.instanceId, timerId: timer.timerId, leaseToken: timer.leaseToken, evidence, completedAt });
  }
}
