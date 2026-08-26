import type { BuilderAcpProfileId } from "../../runtime/builder/profiles.ts";

export interface BuilderWorkerRequest {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly requestId: string;
  readonly profileId: BuilderAcpProfileId;
  readonly workspacePath: string;
  readonly prompt: string;
  readonly timeoutMs: number;
}

export interface BuilderWorkerResult {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly requestId: string;
  readonly profileId: BuilderAcpProfileId;
  readonly evidence: unknown;
}

export function parseBuilderWorkerRequest(value: unknown): BuilderWorkerRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Builder worker request must be an object.");
  }
  const data = value as Record<string, unknown>;
  if (data.schemaVersion !== 1) throw new Error("Builder worker request schemaVersion must be 1.");
  const jobId = requiredIdentifier(data.jobId, "jobId");
  const requestId = requiredIdentifier(data.requestId, "requestId");
  if (data.profileId !== "claude-code" && data.profileId !== "codex") {
    throw new Error("Builder worker profileId must be 'claude-code' or 'codex'.");
  }
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
    profileId: data.profileId,
    workspacePath: data.workspacePath,
    prompt: data.prompt,
    timeoutMs: data.timeoutMs as number,
  };
}

function requiredIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`Builder worker ${field} is invalid.`);
  }
  return value;
}
