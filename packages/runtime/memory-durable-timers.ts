import type { JsonValue } from "../capabilities/contracts.ts";
import type { ClaimedDurableTimer, DurableTimer, DurableTimerStore } from "../state-store/durable-timers.ts";

type TimerRow = DurableTimer & {
  state: "scheduled" | "leased" | "completed" | "failed" | "cancelled";
  attempts: number;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  evidence?: JsonValue;
};

const key = (instanceId: string, timerId: string): string => `${instanceId}\0${timerId}`;

export class InMemoryDurableTimerStore implements DurableTimerStore {
  readonly rows = new Map<string, TimerRow>();

  async schedule(timer: DurableTimer): Promise<boolean> {
    const timerKey = key(timer.instanceId, timer.timerId);
    const existing = this.rows.get(timerKey);
    if (existing) {
      if (existing.idempotencyKey !== timer.idempotencyKey || JSON.stringify(existing.payload) !== JSON.stringify(timer.payload) || existing.dueAt !== timer.dueAt) {
        throw new Error(`Durable timer '${timer.timerId}' conflicts with its existing identity`);
      }
      return false;
    }
    this.rows.set(timerKey, { ...structuredClone(timer), state: "scheduled", attempts: 0 });
    return true;
  }

  async claimDue(args: { instanceId: string; now: string; owner: string; leaseToken: string; leaseExpiresAt: string; limit: number }): Promise<ClaimedDurableTimer[]> {
    const due = [...this.rows.values()]
      .filter((row) => row.instanceId === args.instanceId && (row.state === "scheduled" || (row.state === "leased" && (row.leaseExpiresAt ?? "") <= args.now)) && row.dueAt <= args.now)
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.timerId.localeCompare(b.timerId))
      .slice(0, args.limit);
    return due.map((row) => {
      row.state = "leased";
      row.leaseOwner = args.owner;
      row.leaseToken = args.leaseToken;
      row.leaseExpiresAt = args.leaseExpiresAt;
      row.attempts += 1;
      return { ...structuredClone(row), leaseOwner: args.owner, leaseToken: args.leaseToken, leaseExpiresAt: args.leaseExpiresAt };
    });
  }

  async complete(args: { instanceId: string; timerId: string; leaseToken: string; evidence: JsonValue }): Promise<boolean> {
    return this.transition(args, "completed");
  }

  async retry(args: { instanceId: string; timerId: string; leaseToken: string; dueAt: string; evidence: JsonValue }): Promise<boolean> {
    const row = this.rows.get(key(args.instanceId, args.timerId));
    if (!row || row.state !== "leased" || row.leaseToken !== args.leaseToken) return false;
    row.state = "scheduled";
    row.dueAt = args.dueAt;
    row.evidence = structuredClone(args.evidence);
    delete row.leaseOwner; delete row.leaseToken; delete row.leaseExpiresAt;
    return true;
  }

  async fail(args: { instanceId: string; timerId: string; leaseToken: string; evidence: JsonValue }): Promise<boolean> {
    return this.transition(args, "failed");
  }

  async cancel(args: { instanceId: string; timerId: string; evidence: JsonValue }): Promise<boolean> {
    const row = this.rows.get(key(args.instanceId, args.timerId));
    if (!row || ["completed", "failed", "cancelled"].includes(row.state)) return false;
    row.state = "cancelled";
    row.evidence = structuredClone(args.evidence);
    return true;
  }

  private transition(args: { instanceId: string; timerId: string; leaseToken: string; evidence: JsonValue }, state: "completed" | "failed"): boolean {
    const row = this.rows.get(key(args.instanceId, args.timerId));
    if (!row || row.state !== "leased" || row.leaseToken !== args.leaseToken) return false;
    row.state = state;
    row.evidence = structuredClone(args.evidence);
    return true;
  }
}
