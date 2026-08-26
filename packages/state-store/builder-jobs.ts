import { createHash, randomUUID } from "node:crypto";

export type BuilderJobState =
  | "queued"
  | "preparing_source"
  | "executing"
  | "validating"
  | "publishing"
  | "published"
  | "failed"
  | "cancelled";

export interface BuilderJobInput {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly requestId: string;
  readonly instanceId: string;
  readonly requesterPrincipal: string;
  readonly agentId: "builder";
  readonly sourceConversationKey: string;
  readonly objective: string;
  readonly repositoryId: string;
  readonly baseCommit: string;
  readonly sourceBindingId: string;
  readonly proposalPublisherBindingId: string;
  readonly execution: {
    readonly adapterId: string;
    readonly profile: string;
    readonly timeoutMs: number;
  };
  readonly codingAgent: {
    readonly protocol: "acp-v1";
    readonly profileId: "claude-code" | "codex";
    readonly implementation: string;
    readonly version: string;
  };
}

export interface BuilderJob extends BuilderJobInput {
  readonly fingerprint: string;
  readonly state: BuilderJobState;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cancelRequestedAt?: string;
  readonly executionHandle?: unknown;
  readonly evidence?: unknown;
  readonly terminalReason?: string;
}

export interface BuilderJobLease {
  readonly job: BuilderJob;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
}

export interface BuilderJobStore {
  create(input: BuilderJobInput, now?: Date): Promise<BuilderJob>;
  get(jobId: string): Promise<BuilderJob | undefined>;
  getByRequestId(requestId: string): Promise<BuilderJob | undefined>;
  claimNext(args: { workerId: string; leaseMs: number; now?: Date }): Promise<BuilderJobLease | undefined>;
  renewLease(args: {
    jobId: string;
    workerId: string;
    leaseToken: string;
    leaseMs: number;
    now?: Date;
  }): Promise<BuilderJobLease>;
  releaseLease(args: {
    jobId: string;
    workerId: string;
    leaseToken: string;
    now?: Date;
  }): Promise<void>;
  transition(args: {
    jobId: string;
    workerId: string;
    leaseToken: string;
    from: readonly BuilderJobState[];
    to: BuilderJobState;
    executionHandle?: unknown;
    evidence?: unknown;
    terminalReason?: string;
    now?: Date;
  }): Promise<BuilderJob>;
  requestCancellation(jobId: string, requestedAt?: Date): Promise<BuilderJob>;
}

export const TERMINAL_BUILDER_JOB_STATES: readonly BuilderJobState[] = [
  "published",
  "failed",
  "cancelled",
];

export function assertBuilderJobInput(input: BuilderJobInput): void {
  if (input.schemaVersion !== 1) throw new Error("Builder job schemaVersion must be 1.");
  for (const [label, value] of [
    ["jobId", input.jobId],
    ["requestId", input.requestId],
    ["instanceId", input.instanceId],
    ["requesterPrincipal", input.requesterPrincipal],
    ["sourceConversationKey", input.sourceConversationKey],
    ["repositoryId", input.repositoryId],
    ["sourceBindingId", input.sourceBindingId],
    ["proposalPublisherBindingId", input.proposalPublisherBindingId],
    ["execution.adapterId", input.execution.adapterId],
    ["execution.profile", input.execution.profile],
  ] as const) {
    if (!value || value.length > 512) throw new Error(`Builder job ${label} is invalid.`);
  }
  if (input.agentId !== "builder") throw new Error("Builder job agentId must be 'builder'.");
  if (input.objective.trim() === "" || input.objective.length > 20_000) {
    throw new Error("Builder job objective must be non-empty and bounded.");
  }
  if (!/^[0-9a-f]{40}$/.test(input.baseCommit)) {
    throw new Error("Builder job baseCommit must be an exact lowercase 40-character Git commit.");
  }
  if (!Number.isSafeInteger(input.execution.timeoutMs) || input.execution.timeoutMs < 1_000) {
    throw new Error("Builder job execution timeout is invalid.");
  }
  if (input.codingAgent.protocol !== "acp-v1") throw new Error("Builder job coding protocol must be ACP v1.");
  if (input.codingAgent.profileId !== "claude-code" && input.codingAgent.profileId !== "codex") {
    throw new Error("Builder job coding profile is unsupported.");
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.codingAgent.version)) {
    throw new Error("Builder job coding implementation version must be exact.");
  }
}

export function builderJobFingerprint(input: BuilderJobInput): string {
  assertBuilderJobInput(input);
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export function createBuilderJobId(requestId: string): string {
  if (!requestId) throw new Error("Builder request id is required.");
  return `builder-${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}`;
}

export function newLeaseToken(): string {
  return randomUUID();
}

export function assertBuilderJobTransition(from: BuilderJobState, to: BuilderJobState): void {
  const allowed: Record<BuilderJobState, readonly BuilderJobState[]> = {
    queued: ["preparing_source", "cancelled", "failed"],
    preparing_source: ["executing", "cancelled", "failed"],
    executing: ["validating", "cancelled", "failed"],
    validating: ["publishing", "cancelled", "failed"],
    publishing: ["published", "failed"],
    published: [],
    failed: [],
    cancelled: [],
  };
  if (!allowed[from].includes(to)) throw new Error(`Invalid Builder job transition '${from}' -> '${to}'.`);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
