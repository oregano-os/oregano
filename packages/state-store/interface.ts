// state-store — generic StateStore interface (Spec §5 operations).
// Runner-neutral: knows no Postgres or model runtime. Implementations live in
// state-postgres/. Oregano Core exclusively owns authorization, approval
// consumption, and effect claims; transports only present interaction surfaces,
// buttons, they never decide validity.

export interface RunMeta {
  runId: string;
  workflow: string;
  workflowVersion: string; // Compiled workflow version, or exact Core SHA for a standalone Tool invocation.
  companyCommit?: string; // COMPANY repo git SHA (§10a provenance pair)
  companySnapshotHash: string;
  agentDefinitionHash: string;
  agentAdapter: string;
  adapterVersion?: string;
  agentDeployment?: string; // e.g. Vercel deployment id
}

export interface EventInput {
  runId: string;
  stepId: string;
  actor: string; // agent | human:<role>
  subjectPrincipal?: string; // canonical surface-qualified principal
  event: string;
  status?: "succeeded" | "failed" | "effect-unknown";
  causedByEventId?: string;
  toolVersion?: string;
  idempotencyKey?: string;
  evidence?: unknown;
  payload?: unknown;
}

export interface ApprovalRequestInput {
  runId: string;
  stepId: string;
  action: string; // exactly ONE action per request
  inputHash: string;
  maxSpend?: number; // R4 budget approvals carry the limit
  /** Defaults to the finite Core approval TTL when the caller has no workflow deadline. */
  expiresAt?: Date;
}

export interface ApprovalRequestRow {
  requestId: string;
  runId: string;
  stepId: string;
  action: string;
  inputHash: string;
  createdAt: Date;
  /** Undefined only for retained historical requests; these cannot authorize effects. */
  expiresAt?: Date;
}

export interface DecisionInput {
  requestId: string;
  subjectPrincipal: string;
  role: string;
  decision: "approved" | "rejected";
}

/** Retrospective evidence only; reading it cannot consume or authorize an effect. */
export interface EffectApprovalReceipt {
  approvalId: string;
  requestId: string;
  runId: string;
  stepId: string;
  action: string;
  inputHash: string;
  subjectPrincipal: string;
  role: string;
  decision: "approved" | "rejected";
  consumed: boolean;
  expiresAt: string | null;
}

export function assertEventReadLimit(limit: number | undefined): void {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 10001)) throw new Error("Event read limit must be between 1 and 10001");
}

/** Trusted workflow lease checked atomically with the transition to provider dispatch. */
export interface WorkflowDispatchFence {
  instanceId: string;
  runId: string;
  stepId: string;
  leaseToken: string;
  now: string;
  /** Exact frozen control-notice page; never permits the stopped business effect. */
  review?: { digest: string; page: number; inputDigest: string; executionStepId: string };
}

export interface StateStore {
  ensureRun(meta: RunMeta): Promise<void>;
  getRun(runId: string): Promise<Record<string, unknown> | undefined>;
  appendEvent(e: EventInput): Promise<string>;
  listEvents(runId: string, limit?: number): Promise<Record<string, unknown>[]>;

  createApprovalRequest(r: ApprovalRequestInput): Promise<string>;
  /**
   * True when a request with this exact input_hash already exists for the
   * step. Used by the approval policy to stay idempotent: a Runner may
   * re-evaluate on resume, and re-registering the clicked (possibly
   * stale) hash would overwrite the "latest request" the changed-content
   * check compares against. Known limit: an A→B→back-to-A draft sequence
   * blocks once too often (extra re-approval, never a wrong send).
   */
  approvalRequestExists(
    runId: string,
    stepId: string,
    action: string,
    inputHash: string,
  ): Promise<boolean>;
  getLatestApprovalRequest(
    runId: string,
    stepId: string,
    action: string,
  ): Promise<ApprovalRequestRow | undefined>;
  recordDecision(d: DecisionInput): Promise<string>; // returns approval_id

  /**
   * TRANSACTION RULE (schema.sql, non-negotiable): consume the approval and
   * claim the effect atomically — one statement/transaction. Returns false
   * when the approval is already consumed OR the idempotency key is already
   * claimed (duplicate → suppress).
   */
  consumeApprovalAndClaimEffect(args: {
    approvalId: string;
    idempotencyKey: string;
    runId: string;
    stepId: string;
    inputHash: string;
  }): Promise<boolean>;

  /** Claim an idempotent effect that does not require a human approval. */
  claimEffect(args: {
    idempotencyKey: string;
    runId: string;
    stepId: string;
    inputHash: string;
  }): Promise<boolean>;

  markEffectDispatched(idempotencyKey: string, fence?: WorkflowDispatchFence): Promise<boolean>;
  completeEffect(idempotencyKey: string, evidence: unknown): Promise<void>;
  markEffectFailed(idempotencyKey: string, evidence: unknown): Promise<void>;
  markEffectUnknown(idempotencyKey: string, evidence: unknown): Promise<void>;
  getEffect(idempotencyKey: string): Promise<Record<string, unknown> | undefined>;
  getEffectApproval(idempotencyKey: string): Promise<EffectApprovalReceipt | undefined>;
}
