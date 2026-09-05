import { canonicalJson } from "./canonical.ts";
import type { JsonValue } from "../capabilities/contracts.ts";
import type { ClaimedDurableTimer, DurableTimer, DurableTimerStore, StoredDurableTimer } from "../state-store/durable-timers.ts";

type TimerRow = DurableTimer & {
  state: "scheduled" | "leased" | "completed" | "failed" | "cancelled";
  attempts: number;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  evidence?: JsonValue;
  completedAt?: string;
};

const key = (instanceId: string, timerId: string): string => `${instanceId}\0${timerId}`;

export class InMemoryDurableTimerStore implements DurableTimerStore {
  readonly rows = new Map<string, TimerRow>();

  async schedule(timer: DurableTimer): Promise<boolean> {
    const timerKey = key(timer.instanceId, timer.timerId);
    const existing = this.rows.get(timerKey);
    if (existing) {
      if (existing.timerKind !== timer.timerKind || existing.idempotencyKey !== timer.idempotencyKey || canonicalJson(existing.payload) !== canonicalJson(timer.payload) || existing.dueAt !== timer.dueAt) {
        throw new Error(`Durable timer '${timer.timerId}' conflicts with its existing identity`);
      }
      return false;
    }
    this.rows.set(timerKey, { ...structuredClone(timer), state: "scheduled", attempts: 0 });
    return true;
  }

  async list(args: { instanceId: string; timerKind?: string }): Promise<StoredDurableTimer[]> {
    return [...this.rows.values()]
      .filter((row) => row.instanceId === args.instanceId && (!args.timerKind || row.timerKind === args.timerKind))
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt) || left.timerId.localeCompare(right.timerId))
      .map((row) => ({
        instanceId: row.instanceId,
        timerId: row.timerId,
        timerKind: row.timerKind,
        dueAt: row.dueAt,
        idempotencyKey: row.idempotencyKey,
        payload: structuredClone(row.payload),
        state: row.state,
        attempts: row.attempts,
        ...(row.evidence === undefined ? {} : { evidence: structuredClone(row.evidence) }),
        ...(row.completedAt ? { completedAt: row.completedAt } : {}),
      }));
  }

  async claimDue(args: { instanceId: string; timerKind?: string; now: string; owner: string; leaseToken: string; leaseExpiresAt: string; limit: number }): Promise<ClaimedDurableTimer[]> {
    const due = [...this.rows.values()]
      .filter((row) => row.instanceId === args.instanceId && (!args.timerKind || row.timerKind === args.timerKind) && (row.state === "scheduled" || (row.state === "leased" && (row.leaseExpiresAt ?? "") <= args.now)) && row.dueAt <= args.now)
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

  async complete(args: { instanceId: string; timerId: string; leaseToken: string; evidence: JsonValue; completedAt: string }): Promise<boolean> {
    return this.transition(args, "completed", args.completedAt);
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

  async fail(args: { instanceId: string; timerId: string; leaseToken: string; evidence: JsonValue; failedAt: string }): Promise<boolean> {
    return this.transition(args, "failed", args.failedAt);
  }

  async cancel(args: { instanceId: string; timerId: string; evidence: JsonValue; cancelledAt: string }): Promise<boolean> {
    const row = this.rows.get(key(args.instanceId, args.timerId));
    if (!row || ["completed", "failed", "cancelled"].includes(row.state)) return false;
    row.state = "cancelled";
    row.evidence = structuredClone(args.evidence);
    row.completedAt = args.cancelledAt;
    return true;
  }

  private transition(args: { instanceId: string; timerId: string; leaseToken: string; evidence: JsonValue }, state: "completed" | "failed", completedAt: string): boolean {
    const row = this.rows.get(key(args.instanceId, args.timerId));
    if (!row || row.state !== "leased" || row.leaseToken !== args.leaseToken) return false;
    row.state = state;
    row.evidence = structuredClone(args.evidence);
    row.completedAt = completedAt;
    return true;
  }
}
