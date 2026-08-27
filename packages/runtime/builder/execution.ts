export type BuilderExecutionState =
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface BuilderExecutionRequest {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly source: {
    readonly repository: string;
    readonly baseCommit: string;
  };
  readonly codingAgent: {
    readonly profileId: string;
    readonly implementation: string;
    readonly version: string;
  };
  readonly limits: {
    readonly timeoutMs: number;
  };
  readonly networkPolicyId: string;
}

export interface BuilderExecutionHandle {
  readonly jobId: string;
  readonly executionId: string;
  readonly adapter: {
    readonly id: string;
    readonly version: string;
  };
}

export interface BuilderExecutionStatus {
  readonly state: BuilderExecutionState;
  readonly observedAt: string;
  readonly detail?: string;
}

export interface BuilderExecutionResult {
  readonly state: Extract<BuilderExecutionState, "succeeded" | "failed" | "cancelled" | "timed_out">;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

/**
 * Private Company Instance boundary for the location where one Builder job
 * runs. Provider SDK types must never appear in this contract.
 */
export interface BuilderExecutionAdapter {
  readonly id: string;
  readonly version: string;
  start(request: BuilderExecutionRequest): Promise<BuilderExecutionHandle>;
  status(handle: BuilderExecutionHandle): Promise<BuilderExecutionStatus>;
  cancel(handle: BuilderExecutionHandle): Promise<void>;
  collect(handle: BuilderExecutionHandle): Promise<BuilderExecutionResult>;
  dispose(handle: BuilderExecutionHandle): Promise<void>;
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const FULL_GIT_SHA = /^[0-9a-f]{40}$/;

export function assertBuilderExecutionRequest(request: BuilderExecutionRequest): void {
  if (request.schemaVersion !== 1) throw new Error("Unsupported Builder execution request schema.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.jobId)) {
    throw new Error("Builder job id must be a bounded stable identifier.");
  }
  if (request.source.repository.trim() === "") throw new Error("Builder execution requires a repository reference.");
  if (!FULL_GIT_SHA.test(request.source.baseCommit)) throw new Error("Builder execution requires an exact 40-character base commit.");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(request.codingAgent.profileId)) {
    throw new Error("Builder coding-agent profile id is invalid.");
  }
  if (!EXACT_VERSION.test(request.codingAgent.version)) {
    throw new Error("Builder coding-agent versions must be exact semantic versions.");
  }
  if (!Number.isSafeInteger(request.limits.timeoutMs) || request.limits.timeoutMs < 1_000) {
    throw new Error("Builder execution timeout must be a positive integer of at least 1000ms.");
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(request.networkPolicyId)) {
    throw new Error("Builder execution requires a named network policy.");
  }
}

export function assertBuilderExecutionHandle(
  adapter: Pick<BuilderExecutionAdapter, "id" | "version">,
  handle: BuilderExecutionHandle,
): void {
  if (handle.adapter.id !== adapter.id || handle.adapter.version !== adapter.version) {
    throw new Error("Builder execution handle belongs to a different adapter implementation.");
  }
}
