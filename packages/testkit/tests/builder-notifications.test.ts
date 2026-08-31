import assert from "node:assert/strict";
import test from "node:test";
import type { BuilderInstanceConfiguration } from "../../companyos-builder/types.ts";
import { deliverNextBuilderNotification } from "../../runtime/builder/notifications.ts";
import { builderJobInputForConfirmedProposal } from "../../runtime/builder/service.ts";
import type { BuilderJob } from "../../state-store/builder-jobs.ts";
import { InMemoryBuilderJobStore } from "../adapter/in-memory-builder-jobs.ts";

const configuration: BuilderInstanceConfiguration = {
  enabled: true,
  execution: { adapter: "testkit-memory", profile: "isolated-v1" },
  codingAgent: { protocol: "acp-v1", profile: "codex" },
  repository: {
    repositoryId: "fixture/workspace",
    sourceBinding: "workspace",
    proposalPublisherBinding: "workspace",
  },
};

async function failedJob(jobs: InMemoryBuilderJobStore, now: Date): Promise<BuilderJob> {
  const input = builderJobInputForConfirmedProposal(configuration, {
    requestId: `notification-${now.toISOString()}`,
    instanceId: "fixture",
    requesterPrincipal: "slack:T1:U1",
    sourceConversationKey: "slack:C1:thread",
    sourceMessageId: "message-1",
    objective: "Update company.md with the required Change Plan.",
    repositoryId: "fixture/workspace",
    baseCommit: "a".repeat(40),
  });
  await jobs.create(input, now);
  const lease = await jobs.claimNext({ workerId: "execution-worker", leaseMs: 60_000, now });
  assert.ok(lease);
  return await jobs.transition({
    jobId: lease.job.jobId,
    workerId: lease.workerId,
    leaseToken: lease.leaseToken,
    from: ["queued"],
    to: "failed",
    terminalReason: "fixture failure",
    now,
  });
}

test("terminal transition creates a separately leased pending notification", async () => {
  const jobs = new InMemoryBuilderJobStore();
  const now = new Date("2026-08-27T10:00:00.000Z");
  const job = await failedJob(jobs, now);

  assert.deepEqual(job.notification, {
    state: "pending",
    attempts: 0,
    nextAttemptAt: now.toISOString(),
  });
  assert.equal(await jobs.claimNext({ workerId: "execution-2", leaseMs: 60_000, now }), undefined);
  const notification = await jobs.claimNextNotification({ workerId: "notify-1", leaseMs: 60_000, now });
  assert.equal(notification?.job.jobId, job.jobId);
  assert.equal(notification?.job.notification?.attempts, 1);
  assert.equal(await jobs.claimNextNotification({ workerId: "notify-2", leaseMs: 60_000, now }), undefined);
  const recovered = await jobs.claimNextNotification({
    workerId: "notify-2",
    leaseMs: 60_000,
    now: new Date(now.getTime() + 60_001),
  });
  assert.equal(recovered?.job.jobId, job.jobId);
  assert.equal(recovered?.job.notification?.attempts, 2);
});

test("transient notification failure is retried and successful delivery is terminal", async () => {
  const jobs = new InMemoryBuilderJobStore();
  let clock = new Date("2026-08-27T11:00:00.000Z");
  const job = await failedJob(jobs, clock);
  let deliveries = 0;
  const notifier = {
    async deliver() {
      deliveries += 1;
      if (deliveries === 1) throw new Error("temporary Slack failure Bearer xoxb.secret-material");
    },
  };

  const first = await deliverNextBuilderNotification({
    jobs,
    notifier,
    workerId: "notify-1",
    now: () => clock,
  });
  assert.equal(first.state, "retry_scheduled");
  assert.equal(first.retryAt, new Date(clock.getTime() + 60_000).toISOString());
  assert.equal(
    (await jobs.get(job.jobId))?.notification?.lastError,
    "temporary Slack failure Bearer [redacted]",
  );
  assert.doesNotMatch(JSON.stringify(first), /secret-material/);

  clock = new Date(clock.getTime() + 59_999);
  assert.equal((await deliverNextBuilderNotification({
    jobs,
    notifier,
    workerId: "notify-2",
    now: () => clock,
  })).state, "idle");

  clock = new Date(clock.getTime() + 1);
  const delivered = await deliverNextBuilderNotification({
    jobs,
    notifier,
    workerId: "notify-3",
    now: () => clock,
  });
  assert.equal(delivered.state, "delivered");
  assert.equal((await jobs.get(job.jobId))?.notification?.state, "delivered");
  assert.equal((await jobs.get(job.jobId))?.notification?.attempts, 2);
  assert.equal((await deliverNextBuilderNotification({
    jobs,
    notifier,
    workerId: "notify-4",
    now: () => clock,
  })).state, "idle");
});
