import type { BuilderJob, BuilderJobStore } from "../../state-store/builder-jobs.ts";

export interface BuilderTerminalNotifier {
  deliver(job: BuilderJob): Promise<void>;
}

export interface BuilderNotificationAdvanceResult {
  readonly state: "idle" | "delivered" | "retry_scheduled";
  readonly jobId?: string;
  readonly attempts?: number;
  readonly retryAt?: string;
  readonly error?: string;
}

export async function deliverNextBuilderNotification(args: {
  jobs: BuilderJobStore;
  notifier: BuilderTerminalNotifier;
  workerId: string;
  leaseMs?: number;
  now?: () => Date;
}): Promise<BuilderNotificationAdvanceResult> {
  const now = args.now ?? (() => new Date());
  const lease = await args.jobs.claimNextNotification({
    workerId: args.workerId,
    leaseMs: args.leaseMs ?? 60_000,
    now: now(),
  });
  if (!lease) return { state: "idle" };
  const attempts = lease.job.notification?.attempts ?? 1;
  try {
    await args.notifier.deliver(lease.job);
    await args.jobs.markNotificationDelivered({
      jobId: lease.job.jobId,
      workerId: lease.workerId,
      leaseToken: lease.leaseToken,
      now: now(),
    });
    return { state: "delivered", jobId: lease.job.jobId, attempts };
  } catch (error) {
    const reason = boundedError(error);
    const failedAt = now();
    const retryAt = new Date(failedAt.getTime() + retryDelayMs(attempts));
    await args.jobs.recordNotificationFailure({
      jobId: lease.job.jobId,
      workerId: lease.workerId,
      leaseToken: lease.leaseToken,
      error: reason,
      retryAt,
      now: failedAt,
    });
    return {
      state: "retry_scheduled",
      jobId: lease.job.jobId,
      attempts,
      retryAt: retryAt.toISOString(),
      error: reason,
    };
  }
}

function retryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 6));
  return Math.min(60 * 60_000, 60_000 * 2 ** exponent);
}

function boundedError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  const redacted = value
    .replace(/\b(basic|bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/\bxox[a-z0-9-]*[.-][A-Za-z0-9._-]+\b/gi, "[redacted-chat-token]")
    .replace(/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}\b/g, "[redacted-model-token]")
    .replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----/g, "[redacted-private-key]");
  return (redacted.trim() || "Builder terminal notification failed.").slice(0, 2_000);
}
