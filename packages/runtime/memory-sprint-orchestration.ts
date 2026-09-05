import type {
  ClaimedSprintIntent,
  SprintCommitResult,
  SprintOrchestrationKey,
  SprintOrchestrationStore,
  StoredSprintEvent,
  StoredSprintIntent,
  StoredSprintState,
} from "../state-store/sprint-orchestration.ts";
import type { SprintIntent } from "../domains/sprint/contracts.ts";

type IntentRow = SprintOrchestrationKey & {
  intent: SprintIntent;
  createdByEventId: string;
  state: "pending" | "leased" | "succeeded" | "failed" | "cancelled";
  availableAt: string;
  attempts: number;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  evidence?: unknown;
  completedAt?: string;
  updatedAt: string;
};

const key = ({ instanceId, definitionId }: SprintOrchestrationKey): string => `${instanceId}\0${definitionId}`;
const eventKey = (value: SprintOrchestrationKey, eventId: string): string => `${key(value)}\0${eventId}`;
const intentKey = (value: SprintOrchestrationKey, intentId: string): string => `${key(value)}\0${intentId}`;

export class InMemorySprintOrchestrationStore implements SprintOrchestrationStore {
  readonly states = new Map<string, StoredSprintState>();
  readonly events = new Map<string, StoredSprintEvent>();
  readonly intents = new Map<string, IntentRow>();

  async getState(value: SprintOrchestrationKey): Promise<StoredSprintState | undefined> {
    const row = this.states.get(key(value));
    return row ? structuredClone(row) : undefined;
  }

  async getEvent(value: SprintOrchestrationKey, eventId: string): Promise<StoredSprintEvent | undefined> {
    const row = this.events.get(eventKey(value, eventId));
    return row ? structuredClone(row) : undefined;
  }

  async listEvents(value: SprintOrchestrationKey): Promise<StoredSprintEvent[]> {
    return [...this.events.values()]
      .filter((row) => row.instanceId === value.instanceId && row.definitionId === value.definitionId)
      .sort((left, right) => left.stateVersion - right.stateVersion)
      .map((row) => structuredClone(row));
  }

  async listIntents(value: SprintOrchestrationKey): Promise<StoredSprintIntent[]> {
    return [...this.intents.values()]
      .filter((row) => row.instanceId === value.instanceId && row.definitionId === value.definitionId)
      .sort((left, right) => left.availableAt.localeCompare(right.availableAt)
        || left.intent.intent_id.localeCompare(right.intent.intent_id))
      .map((row) => ({
        instanceId: row.instanceId,
        definitionId: row.definitionId,
        intent: structuredClone(row.intent),
        state: row.state,
        createdByEventId: row.createdByEventId,
        availableAt: row.availableAt,
        attempts: row.attempts,
        ...(row.evidence === undefined ? {} : { evidence: structuredClone(row.evidence) }),
        ...(row.completedAt ? { completedAt: row.completedAt } : {}),
        updatedAt: row.updatedAt,
      }));
  }

  async commitEvent(args: SprintOrchestrationKey & {
    expectedStateVersion: number;
    event: StoredSprintEvent["event"];
    decision: StoredSprintEvent["decision"];
    committedAt: string;
  }): Promise<SprintCommitResult> {
    const existingEvent = this.events.get(eventKey(args, args.event.event_id));
    if (existingEvent) return { status: "duplicate", outcome: structuredClone(existingEvent) };
    const existingState = this.states.get(key(args));
    if ((existingState?.stateVersion ?? 0) !== args.expectedStateVersion) return { status: "conflict" };
    for (const intent of args.decision.intents) {
      const existingIntent = this.intents.get(intentKey(args, intent.intent_id));
      if (existingIntent && JSON.stringify(existingIntent.intent) !== JSON.stringify(intent)) {
        throw new Error(`Sprint intent '${intent.intent_id}' conflicts with its existing identity`);
      }
    }
    const stateVersion = args.expectedStateVersion + 1;
    const outcome: StoredSprintEvent = {
      instanceId: args.instanceId,
      definitionId: args.definitionId,
      event: structuredClone(args.event),
      stateVersion,
      decision: structuredClone(args.decision),
      committedAt: args.committedAt,
    };
    this.states.set(key(args), {
      instanceId: args.instanceId,
      definitionId: args.definitionId,
      stateVersion,
      state: structuredClone(args.decision.state),
      updatedAt: args.committedAt,
    });
    this.events.set(eventKey(args, args.event.event_id), outcome);
    for (const intent of args.decision.intents) {
      const rowKey = intentKey(args, intent.intent_id);
      if (!this.intents.has(rowKey)) this.intents.set(rowKey, {
        instanceId: args.instanceId,
        definitionId: args.definitionId,
        intent: structuredClone(intent),
        createdByEventId: args.event.event_id,
        state: "pending",
        availableAt: "due_at" in intent ? intent.due_at : args.committedAt,
        attempts: 0,
        updatedAt: args.committedAt,
      });
    }
    return { status: "applied", outcome: structuredClone(outcome) };
  }

  async claimIntents(args: SprintOrchestrationKey & {
    now: string;
    owner: string;
    leaseToken: string;
    leaseExpiresAt: string;
    limit: number;
  }): Promise<ClaimedSprintIntent[]> {
    const due = [...this.intents.values()]
      .filter((row) => row.instanceId === args.instanceId && row.definitionId === args.definitionId
        && row.availableAt <= args.now
        && (row.state === "pending" || (row.state === "leased" && (row.leaseExpiresAt ?? "") <= args.now)))
      .sort((left, right) => left.availableAt.localeCompare(right.availableAt)
        || left.intent.intent_id.localeCompare(right.intent.intent_id))
      .slice(0, args.limit);
    return due.map((row) => {
      row.state = "leased";
      row.leaseOwner = args.owner;
      row.leaseToken = args.leaseToken;
      row.leaseExpiresAt = args.leaseExpiresAt;
      row.attempts += 1;
      return {
        instanceId: row.instanceId,
        definitionId: row.definitionId,
        intent: structuredClone(row.intent),
        leaseOwner: args.owner,
        leaseToken: args.leaseToken,
        leaseExpiresAt: args.leaseExpiresAt,
        attempts: row.attempts,
      };
    });
  }

  async completeIntent(args: SprintOrchestrationKey & { intentId: string; leaseToken: string; evidence: unknown; completedAt: string }): Promise<boolean> {
    return this.transition(args, "succeeded", args.completedAt);
  }

  async retryIntent(args: SprintOrchestrationKey & { intentId: string; leaseToken: string; availableAt: string; evidence: unknown; retriedAt: string }): Promise<boolean> {
    const row = this.intents.get(intentKey(args, args.intentId));
    if (!row || row.state !== "leased" || row.leaseToken !== args.leaseToken) return false;
    row.state = "pending";
    row.availableAt = args.availableAt;
    row.evidence = structuredClone(args.evidence);
    row.updatedAt = args.retriedAt;
    delete row.completedAt;
    delete row.leaseOwner;
    delete row.leaseToken;
    delete row.leaseExpiresAt;
    return true;
  }

  async failIntent(args: SprintOrchestrationKey & { intentId: string; leaseToken: string; evidence: unknown; failedAt: string }): Promise<boolean> {
    return this.transition(args, "failed", args.failedAt);
  }

  async cancelIntent(args: SprintOrchestrationKey & { intentId: string; evidence: unknown; cancelledAt: string }): Promise<boolean> {
    const row = this.intents.get(intentKey(args, args.intentId));
    if (!row || ["succeeded", "failed", "cancelled"].includes(row.state)) return false;
    row.state = "cancelled";
    row.evidence = structuredClone(args.evidence);
    row.completedAt = args.cancelledAt;
    row.updatedAt = args.cancelledAt;
    return true;
  }

  private transition(
    args: SprintOrchestrationKey & { intentId: string; leaseToken: string; evidence: unknown },
    state: "succeeded" | "failed",
    completedAt: string,
  ): boolean {
    const row = this.intents.get(intentKey(args, args.intentId));
    if (!row || row.state !== "leased" || row.leaseToken !== args.leaseToken) return false;
    row.state = state;
    row.evidence = structuredClone(args.evidence);
    row.completedAt = completedAt;
    row.updatedAt = completedAt;
    return true;
  }
}
