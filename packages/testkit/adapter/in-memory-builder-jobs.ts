import {
  TERMINAL_BUILDER_JOB_STATES,
  assertBuilderJobInput,
  assertBuilderJobTransition,
  builderJobFingerprint,
  newLeaseToken,
  type BuilderJob,
  type BuilderJobInput,
  type BuilderJobLease,
  type BuilderNotificationLease,
  type BuilderJobStore,
  type BuilderJobState,
} from "../../state-store/builder-jobs.ts";

interface StoredJob {
  job: BuilderJob;
  lease?: {
    workerId: string;
    leaseToken: string;
    leaseExpiresAt: string;
  };
  notificationLease?: {
    workerId: string;
    leaseToken: string;
    leaseExpiresAt: string;
  };
}

export class InMemoryBuilderJobStore implements BuilderJobStore {
  readonly #jobs = new Map<string, StoredJob>();
  readonly #requestIds = new Map<string, string>();

  async create(input: BuilderJobInput, now = new Date()): Promise<BuilderJob> {
    assertBuilderJobInput(input);
    const fingerprint = builderJobFingerprint(input);
    const existingId = this.#requestIds.get(input.requestId);
    if (existingId) {
      const existing = this.#jobs.get(existingId)!.job;
      if (existing.fingerprint !== fingerprint) {
        throw new Error("Builder request id was reused with different immutable input.");
      }
      return structuredClone(existing);
    }
    if (this.#jobs.has(input.jobId)) throw new Error(`Builder job id '${input.jobId}' already exists.`);
    const timestamp = now.toISOString();
    const job: BuilderJob = {
      ...structuredClone(input),
      fingerprint,
      state: "queued",
      attempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.#jobs.set(job.jobId, { job });
    this.#requestIds.set(job.requestId, job.jobId);
    return structuredClone(job);
  }

  async get(jobId: string): Promise<BuilderJob | undefined> {
    const stored = this.#jobs.get(jobId);
    return stored ? structuredClone(stored.job) : undefined;
  }

  async getByRequestId(requestId: string): Promise<BuilderJob | undefined> {
    const jobId = this.#requestIds.get(requestId);
    return jobId ? this.get(jobId) : undefined;
  }

  async claimNext(args: { workerId: string; leaseMs: number; now?: Date }): Promise<BuilderJobLease | undefined> {
    const now = args.now ?? new Date();
    assertLease(args.workerId, args.leaseMs);
    const candidates = [...this.#jobs.values()]
      .filter((stored) => {
        if (TERMINAL_BUILDER_JOB_STATES.includes(stored.job.state)) return false;
        if (!stored.lease) return true;
        return new Date(stored.lease.leaseExpiresAt).getTime() <= now.getTime();
      })
      .sort((a, b) => a.job.createdAt.localeCompare(b.job.createdAt));
    const stored = candidates[0];
    if (!stored) return undefined;
    const leaseToken = newLeaseToken();
    const leaseExpiresAt = new Date(now.getTime() + args.leaseMs).toISOString();
    stored.lease = { workerId: args.workerId, leaseToken, leaseExpiresAt };
    stored.job = {
      ...stored.job,
      attempts: stored.job.attempts + 1,
      updatedAt: now.toISOString(),
    };
    return { job: structuredClone(stored.job), workerId: args.workerId, leaseToken, leaseExpiresAt };
  }

  async renewLease(args: {
    jobId: string;
    workerId: string;
    leaseToken: string;
    leaseMs: number;
    now?: Date;
  }): Promise<BuilderJobLease> {
    const now = args.now ?? new Date();
    assertLease(args.workerId, args.leaseMs);
    const stored = this.requiredLease(args.jobId, args.workerId, args.leaseToken, now);
    const leaseExpiresAt = new Date(now.getTime() + args.leaseMs).toISOString();
    stored.lease = { workerId: args.workerId, leaseToken: args.leaseToken, leaseExpiresAt };
    return { job: structuredClone(stored.job), workerId: args.workerId, leaseToken: args.leaseToken, leaseExpiresAt };
  }

  async releaseLease(args: {
    jobId: string;
    workerId: string;
    leaseToken: string;
    now?: Date;
  }): Promise<void> {
    const now = args.now ?? new Date();
    const stored = this.requiredLease(args.jobId, args.workerId, args.leaseToken, now);
    stored.lease = undefined;
    stored.job = { ...stored.job, updatedAt: now.toISOString() };
  }

  async transition(args: {
    jobId: string;
    workerId: string;
    leaseToken: string;
    from: readonly BuilderJobState[];
    to: BuilderJobState;
    executionHandle?: unknown;
    evidence?: unknown;
    terminalReason?: string;
    now?: Date;
  }): Promise<BuilderJob> {
    const now = args.now ?? new Date();
    const stored = this.requiredLease(args.jobId, args.workerId, args.leaseToken, now);
    if (!args.from.includes(stored.job.state)) {
      throw new Error(`Builder job '${args.jobId}' is in state '${stored.job.state}', not an expected source state.`);
    }
    assertBuilderJobTransition(stored.job.state, args.to);
    stored.job = {
      ...stored.job,
      state: args.to,
      updatedAt: now.toISOString(),
      executionHandle: args.executionHandle ?? stored.job.executionHandle,
      evidence: args.evidence ?? stored.job.evidence,
      terminalReason: args.terminalReason ?? stored.job.terminalReason,
      ...(TERMINAL_BUILDER_JOB_STATES.includes(args.to) && !stored.job.notification
        ? {
            notification: {
              state: "pending" as const,
              attempts: 0,
              nextAttemptAt: now.toISOString(),
            },
          }
        : {}),
    };
    if (TERMINAL_BUILDER_JOB_STATES.includes(args.to)) stored.lease = undefined;
    return structuredClone(stored.job);
  }

  async requestCancellation(jobId: string, requestedAt = new Date()): Promise<BuilderJob> {
    const stored = this.#jobs.get(jobId);
    if (!stored) throw new Error(`Unknown Builder job '${jobId}'.`);
    if (TERMINAL_BUILDER_JOB_STATES.includes(stored.job.state)) return structuredClone(stored.job);
    stored.job = { ...stored.job, cancelRequestedAt: requestedAt.toISOString(), updatedAt: requestedAt.toISOString() };
    return structuredClone(stored.job);
  }

  async claimNextNotification(args: {
    workerId: string;
    leaseMs: number;
    now?: Date;
  }): Promise<BuilderNotificationLease | undefined> {
    const now = args.now ?? new Date();
    assertLease(args.workerId, args.leaseMs);
    const candidates = [...this.#jobs.values()]
      .filter((stored) => {
        const delivery = stored.job.notification;
        if (!delivery || delivery.state !== "pending") return false;
        if (new Date(delivery.nextAttemptAt).getTime() > now.getTime()) return false;
        if (!stored.notificationLease) return true;
        return new Date(stored.notificationLease.leaseExpiresAt).getTime() <= now.getTime();
      })
      .sort((a, b) => a.job.createdAt.localeCompare(b.job.createdAt));
    const stored = candidates[0];
    if (!stored) return undefined;
    const leaseToken = newLeaseToken();
    const leaseExpiresAt = new Date(now.getTime() + args.leaseMs).toISOString();
    stored.notificationLease = { workerId: args.workerId, leaseToken, leaseExpiresAt };
    stored.job = {
      ...stored.job,
      notification: {
        ...stored.job.notification!,
        attempts: stored.job.notification!.attempts + 1,
      },
    };
    return { job: structuredClone(stored.job), workerId: args.workerId, leaseToken, leaseExpiresAt };
  }

  async markNotificationDelivered(args: {
    jobId: string;
    workerId: string;
    leaseToken: string;
    now?: Date;
  }): Promise<BuilderJob> {
    const now = args.now ?? new Date();
    const stored = this.requiredNotificationLease(args.jobId, args.workerId, args.leaseToken, now);
    stored.notificationLease = undefined;
    stored.job = {
      ...stored.job,
      notification: {
        ...stored.job.notification!,
        state: "delivered",
        deliveredAt: now.toISOString(),
        nextAttemptAt: now.toISOString(),
        lastError: undefined,
      },
    };
    return structuredClone(stored.job);
  }

  async recordNotificationFailure(args: {
    jobId: string;
    workerId: string;
    leaseToken: string;
    error: string;
    retryAt: Date;
    now?: Date;
  }): Promise<BuilderJob> {
    const now = args.now ?? new Date();
    if (args.error === "" || args.error.length > 2_000) {
      throw new Error("Builder notification failure must be non-empty and bounded.");
    }
    if (args.retryAt.getTime() <= now.getTime()) {
      throw new Error("Builder notification retry must be scheduled in the future.");
    }
    const stored = this.requiredNotificationLease(args.jobId, args.workerId, args.leaseToken, now);
    stored.notificationLease = undefined;
    stored.job = {
      ...stored.job,
      notification: {
        ...stored.job.notification!,
        state: "pending",
        nextAttemptAt: args.retryAt.toISOString(),
        lastError: args.error,
      },
    };
    return structuredClone(stored.job);
  }

  private requiredLease(jobId: string, workerId: string, leaseToken: string, now: Date): StoredJob {
    const stored = this.#jobs.get(jobId);
    if (!stored) throw new Error(`Unknown Builder job '${jobId}'.`);
    if (
      !stored.lease
      || stored.lease.workerId !== workerId
      || stored.lease.leaseToken !== leaseToken
      || new Date(stored.lease.leaseExpiresAt).getTime() <= now.getTime()
    ) {
      throw new Error(`Builder job '${jobId}' lease is missing, stale, or owned by another worker.`);
    }
    return stored;
  }

  private requiredNotificationLease(
    jobId: string,
    workerId: string,
    leaseToken: string,
    now: Date,
  ): StoredJob {
    const stored = this.#jobs.get(jobId);
    if (!stored) throw new Error(`Unknown Builder job '${jobId}'.`);
    if (
      !stored.notificationLease
      || stored.notificationLease.workerId !== workerId
      || stored.notificationLease.leaseToken !== leaseToken
      || new Date(stored.notificationLease.leaseExpiresAt).getTime() <= now.getTime()
    ) {
      throw new Error(`Builder job '${jobId}' notification lease is missing, stale, or owned by another worker.`);
    }
    if (stored.job.notification?.state !== "pending") {
      throw new Error(`Builder job '${jobId}' notification is not pending.`);
    }
    return stored;
  }
}

function assertLease(workerId: string, leaseMs: number): void {
  if (!workerId || workerId.length > 256) throw new Error("Builder worker id is invalid.");
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 60 * 60 * 1_000) {
    throw new Error("Builder lease duration must be between one second and one hour.");
  }
}
