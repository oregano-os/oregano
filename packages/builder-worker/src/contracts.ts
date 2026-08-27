import type { BuilderAcpProfileId } from "../../runtime/builder/profiles.ts";

export const BUILDER_WORKER_PROGRESS_PATH = "/vercel/sandbox/builder-progress.json";

export interface BuilderWorkerRequest {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly requestId: string;
  readonly profileId: BuilderAcpProfileId;
  readonly workspacePath: string;
  readonly prompt: string;
  readonly timeoutMs: number;
}

interface BuilderWorkerResultBase {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly requestId: string;
  readonly profileId: BuilderAcpProfileId;
}

export type BuilderWorkerResult = BuilderWorkerResultBase & ({
  readonly state: "succeeded";
  readonly evidence: unknown;
} | {
  readonly state: "failed";
  readonly failure: {
    readonly category: "acp-process-exit" | "acp-run-failed";
  };
});

export interface BuilderWorkerProgress {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly requestId: string;
  readonly profileId: BuilderAcpProfileId;
  readonly phase: "prompt_started" | "usage_observed";
  readonly sessionId: string;
  readonly processId: number;
  readonly model?: string;
  readonly context?: {
    readonly used: number;
    readonly size: number;
  };
  readonly cost?: {
    readonly status: "reported";
    readonly amount: number;
    readonly currency: string;
    readonly source: "acp-usage-update";
    readonly estimated: true;
  };
  readonly observedAt: string;
}

export function parseBuilderWorkerRequest(value: unknown): BuilderWorkerRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Builder worker request must be an object.");
  }
  const data = value as Record<string, unknown>;
  if (data.schemaVersion !== 1) throw new Error("Builder worker request schemaVersion must be 1.");
  const jobId = requiredIdentifier(data.jobId, "jobId");
  const requestId = requiredIdentifier(data.requestId, "requestId");
  const profileId = requiredProfile(data.profileId);
  if (typeof data.workspacePath !== "string" || !data.workspacePath.startsWith("/")) {
    throw new Error("Builder worker workspacePath must be absolute.");
  }
  if (typeof data.prompt !== "string" || data.prompt.trim() === "") {
    throw new Error("Builder worker prompt must be non-empty.");
  }
  if (!Number.isSafeInteger(data.timeoutMs) || (data.timeoutMs as number) < 1_000) {
    throw new Error("Builder worker timeoutMs must be an integer of at least 1000.");
  }
  return {
    schemaVersion: 1,
    jobId,
    requestId,
    profileId,
    workspacePath: data.workspacePath,
    prompt: data.prompt,
    timeoutMs: data.timeoutMs as number,
  };
}

export function parseBuilderWorkerResult(value: unknown): BuilderWorkerResult {
  const data = workerRecord(value, "result");
  if (data.schemaVersion !== 1) throw new Error("Builder worker result schemaVersion must be 1.");
  const jobId = requiredIdentifier(data.jobId, "jobId");
  const requestId = requiredIdentifier(data.requestId, "requestId");
  const profileId = requiredProfile(data.profileId);
  if (data.state === "succeeded") {
    if (data.evidence === undefined) throw new Error("Successful Builder worker result evidence is required.");
    return { schemaVersion: 1, jobId, requestId, profileId, state: "succeeded", evidence: data.evidence };
  }
  if (data.state === "failed") {
    const failure = workerRecord(data.failure, "result failure");
    if (failure.category !== "acp-process-exit" && failure.category !== "acp-run-failed") {
      throw new Error("Builder worker result failure category is invalid.");
    }
    return {
      schemaVersion: 1,
      jobId,
      requestId,
      profileId,
      state: "failed",
      failure: { category: failure.category },
    };
  }
  throw new Error("Builder worker result state is invalid.");
}

export function parseBuilderWorkerProgress(value: unknown): BuilderWorkerProgress {
  const data = workerRecord(value, "progress");
  if (data.schemaVersion !== 1) throw new Error("Builder worker progress schemaVersion must be 1.");
  const jobId = requiredIdentifier(data.jobId, "jobId");
  const requestId = requiredIdentifier(data.requestId, "requestId");
  const profileId = requiredProfile(data.profileId);
  if (data.phase !== "prompt_started" && data.phase !== "usage_observed") {
    throw new Error("Builder worker progress phase is invalid.");
  }
  const sessionId = requiredIdentifier(data.sessionId, "sessionId");
  if (!Number.isSafeInteger(data.processId) || (data.processId as number) <= 0) {
    throw new Error("Builder worker progress processId is invalid.");
  }
  if (data.model !== undefined && (typeof data.model !== "string" || data.model.trim() === "")) {
    throw new Error("Builder worker progress model is invalid.");
  }
  const context = parseContext(data.context, data.phase);
  const cost = parseCost(data.cost);
  if (typeof data.observedAt !== "string" || !Number.isFinite(Date.parse(data.observedAt))) {
    throw new Error("Builder worker progress observedAt is invalid.");
  }
  return {
    schemaVersion: 1,
    jobId,
    requestId,
    profileId,
    phase: data.phase,
    sessionId,
    processId: data.processId as number,
    ...(data.model ? { model: data.model as string } : {}),
    ...(context ? { context } : {}),
    ...(cost ? { cost } : {}),
    observedAt: data.observedAt,
  };
}

function workerRecord(value: unknown, kind: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Builder worker ${kind} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredProfile(value: unknown): BuilderAcpProfileId {
  if (value !== "claude-code" && value !== "codex") {
    throw new Error("Builder worker profileId must be 'claude-code' or 'codex'.");
  }
  return value;
}

function parseContext(
  value: unknown,
  phase: BuilderWorkerProgress["phase"],
): BuilderWorkerProgress["context"] {
  if (phase === "prompt_started") {
    if (value !== undefined) throw new Error("Prompt-started worker progress cannot contain context usage.");
    return undefined;
  }
  const context = workerRecord(value, "progress context");
  if (!Number.isSafeInteger(context.used) || (context.used as number) < 0) {
    throw new Error("Builder worker progress context used tokens are invalid.");
  }
  if (!Number.isSafeInteger(context.size) || (context.size as number) <= 0) {
    throw new Error("Builder worker progress context size is invalid.");
  }
  return { used: context.used as number, size: context.size as number };
}

function parseCost(value: unknown): BuilderWorkerProgress["cost"] {
  if (value === undefined) return undefined;
  const cost = workerRecord(value, "progress cost");
  if (cost.status !== "reported") {
    throw new Error("Builder worker progress cost status is invalid.");
  }
  if (typeof cost.amount !== "number" || !Number.isFinite(cost.amount) || cost.amount < 0) {
    throw new Error("Builder worker progress cost amount is invalid.");
  }
  if (typeof cost.currency !== "string" || !/^[A-Z]{3}$/.test(cost.currency)) {
    throw new Error("Builder worker progress cost currency is invalid.");
  }
  if (cost.source !== "acp-usage-update" || cost.estimated !== true) {
    throw new Error("Builder worker progress cost attribution is invalid.");
  }
  return {
    status: "reported",
    amount: cost.amount,
    currency: cost.currency,
    source: "acp-usage-update",
    estimated: true,
  };
}

function requiredIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`Builder worker ${field} is invalid.`);
  }
  return value;
}
