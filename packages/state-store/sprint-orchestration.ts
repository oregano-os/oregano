import type { SprintDecision, SprintEvent, SprintIntent, SprintState } from "../domains/sprint/contracts.ts";

export interface SprintOrchestrationKey {
  instanceId: string;
  definitionId: string;
}

export interface StoredSprintState extends SprintOrchestrationKey {
  stateVersion: number;
  state: SprintState;
  updatedAt: string;
}

export interface StoredSprintEvent extends SprintOrchestrationKey {
  event: SprintEvent;
  stateVersion: number;
  decision: SprintDecision;
  committedAt: string;
}

export interface StoredSprintIntent extends SprintOrchestrationKey {
  intent: SprintIntent;
  state: "pending" | "leased" | "succeeded" | "failed" | "cancelled";
  createdByEventId: string;
  availableAt: string;
  attempts: number;
  evidence?: unknown;
  completedAt?: string;
  updatedAt: string;
}

export type SprintCommitResult =
  | { status: "applied"; outcome: StoredSprintEvent }
  | { status: "duplicate"; outcome: StoredSprintEvent }
  | { status: "conflict" };

export interface ClaimedSprintIntent extends SprintOrchestrationKey {
  intent: SprintIntent;
  leaseOwner: string;
  leaseToken: string;
  leaseExpiresAt: string;
  attempts: number;
}

/**
 * Durable, provider-neutral Sprint coordination state.
 *
 * commitEvent must atomically persist the event, resulting state, decision
 * evidence, and every new intent. It may apply only when stateVersion still
 * equals expectedStateVersion. Duplicate event ids return their immutable
 * original outcome; concurrent different events return conflict.
 */
export interface SprintOrchestrationStore {
  getState(key: SprintOrchestrationKey): Promise<StoredSprintState | undefined>;
  getEvent(key: SprintOrchestrationKey, eventId: string): Promise<StoredSprintEvent | undefined>;
  listEvents(key: SprintOrchestrationKey): Promise<StoredSprintEvent[]>;
  listIntents(key: SprintOrchestrationKey): Promise<StoredSprintIntent[]>;
  commitEvent(args: SprintOrchestrationKey & {
    expectedStateVersion: number;
    event: SprintEvent;
    decision: SprintDecision;
    committedAt: string;
  }): Promise<SprintCommitResult>;

  claimIntents(args: SprintOrchestrationKey & {
    now: string;
    owner: string;
    leaseToken: string;
    leaseExpiresAt: string;
    limit: number;
  }): Promise<ClaimedSprintIntent[]>;
  completeIntent(args: SprintOrchestrationKey & {
    intentId: string;
    leaseToken: string;
    evidence: unknown;
    completedAt: string;
  }): Promise<boolean>;
  retryIntent(args: SprintOrchestrationKey & {
    intentId: string;
    leaseToken: string;
    availableAt: string;
    evidence: unknown;
    retriedAt: string;
  }): Promise<boolean>;
  failIntent(args: SprintOrchestrationKey & {
    intentId: string;
    leaseToken: string;
    evidence: unknown;
    failedAt: string;
  }): Promise<boolean>;
  cancelIntent(args: SprintOrchestrationKey & {
    intentId: string;
    evidence: unknown;
    cancelledAt: string;
  }): Promise<boolean>;
}
