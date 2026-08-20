import type {
  ApprovalRequestInput,
  ApprovalRequestRow,
  DecisionInput,
  EventInput,
  RunMeta,
  StateStore,
} from "../../state-store/interface.ts";

export class InMemoryStateStore implements StateStore {
  readonly runs = new Map<string, Record<string, unknown>>();
  readonly events: Array<Record<string, unknown>> = [];
  readonly requests: Array<ApprovalRequestRow & { maxSpend?: number; expiresAt?: Date }> = [];
  readonly approvals = new Map<string, DecisionInput & { consumed: boolean }>();
  readonly effects = new Map<string, Record<string, unknown>>();
  #sequence = 0;

  #id(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}_${this.#sequence}`;
  }

  async ensureRun(meta: RunMeta): Promise<void> {
    if (!this.runs.has(meta.runId)) this.runs.set(meta.runId, { ...meta, status: "running" });
  }
  async getRun(runId: string) { return this.runs.get(runId); }
  async appendEvent(event: EventInput): Promise<string> {
    const eventId = this.#id("event");
    this.events.push({ eventId, ...event });
    return eventId;
  }
  async listEvents(runId: string) { return this.events.filter((event) => event.runId === runId); }
  async createApprovalRequest(request: ApprovalRequestInput): Promise<string> {
    const requestId = this.#id("request");
    this.requests.push({ requestId, ...request, createdAt: new Date(this.#sequence) });
    return requestId;
  }
  async approvalRequestExists(runId: string, stepId: string, action: string, inputHash: string): Promise<boolean> {
    return this.requests.some((request) => request.runId === runId && request.stepId === stepId && request.action === action && request.inputHash === inputHash);
  }
  async getLatestApprovalRequest(runId: string, stepId: string, action: string): Promise<ApprovalRequestRow | undefined> {
    return [...this.requests].reverse().find((request) => request.runId === runId && request.stepId === stepId && request.action === action);
  }
  async recordDecision(decision: DecisionInput): Promise<string> {
    const approvalId = this.#id("approval");
    this.approvals.set(approvalId, { ...decision, consumed: false });
    return approvalId;
  }
  async consumeApprovalAndClaimEffect(args: { approvalId: string; idempotencyKey: string; runId: string; stepId: string; inputHash: string }): Promise<boolean> {
    const approval = this.approvals.get(args.approvalId);
    if (!approval || approval.consumed || approval.decision !== "approved" || this.effects.has(args.idempotencyKey)) return false;
    approval.consumed = true;
    this.effects.set(args.idempotencyKey, { ...args, status: "claimed" });
    return true;
  }
  async claimEffect(args: { idempotencyKey: string; runId: string; stepId: string; inputHash: string }): Promise<boolean> {
    if (this.effects.has(args.idempotencyKey)) return false;
    this.effects.set(args.idempotencyKey, { ...args, status: "claimed" });
    return true;
  }
  async markEffectDispatched(key: string): Promise<boolean> {
    const effect = this.effects.get(key);
    if (!effect || effect.status !== "claimed") return false;
    effect.status = "dispatched";
    return true;
  }
  async completeEffect(key: string, evidence: unknown): Promise<void> {
    const effect = this.effects.get(key);
    if (effect) Object.assign(effect, { status: "succeeded", evidence });
  }
  async markEffectFailed(key: string, evidence: unknown): Promise<void> {
    const effect = this.effects.get(key);
    if (effect) Object.assign(effect, { status: "failed", evidence });
  }
  async markEffectUnknown(key: string, evidence: unknown): Promise<void> {
    const effect = this.effects.get(key);
    if (effect) Object.assign(effect, { status: "unknown", evidence });
  }
  async getEffect(key: string) { return this.effects.get(key); }
}
