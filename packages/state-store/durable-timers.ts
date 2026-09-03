import type { JsonValue } from "../capabilities/contracts.ts";

export interface DurableTimer {
  instanceId: string;
  timerId: string;
  timerKind: string;
  dueAt: string;
  idempotencyKey: string;
  payload: JsonValue;
}

export interface ClaimedDurableTimer extends DurableTimer {
  leaseOwner: string;
  leaseToken: string;
  leaseExpiresAt: string;
  attempts: number;
}

export interface DurableTimerStore {
  schedule(timer: DurableTimer): Promise<boolean>;
  claimDue(args: { instanceId: string; timerKind?: string; now: string; owner: string; leaseToken: string; leaseExpiresAt: string; limit: number }): Promise<ClaimedDurableTimer[]>;
  complete(args: { instanceId: string; timerId: string; leaseToken: string; evidence: JsonValue; completedAt: string }): Promise<boolean>;
  retry(args: { instanceId: string; timerId: string; leaseToken: string; dueAt: string; evidence: JsonValue }): Promise<boolean>;
  fail(args: { instanceId: string; timerId: string; leaseToken: string; evidence: JsonValue; failedAt: string }): Promise<boolean>;
  cancel(args: { instanceId: string; timerId: string; cancelledAt: string; evidence: JsonValue }): Promise<boolean>;
}
