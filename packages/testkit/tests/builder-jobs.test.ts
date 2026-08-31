import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createBuilderJobId, type BuilderJobInput } from "../../state-store/builder-jobs.ts";
import { InMemoryBuilderJobStore } from "../adapter/in-memory-builder-jobs.ts";

const input = (requestId = "request-1"): BuilderJobInput => ({
  schemaVersion: 1,
  jobId: createBuilderJobId(requestId),
  requestId,
  instanceId: "fixture",
  requesterPrincipal: "slack:T1:U1",
  agentId: "builder",
  sourceConversationKey: "slack:C1:thread-1",
  objective: "Update the Company Workspace handbook.",
  repositoryId: "fixture/workspace",
  baseCommit: "a".repeat(40),
  sourceBindingId: "workspace-source",
  proposalPublisherBindingId: "workspace-publisher",
  execution: { adapterId: "testkit-memory", profile: "isolated-v1", timeoutMs: 60_000 },
  codingAgent: {
    protocol: "acp-v1",
    profileId: "codex",
    implementation: "@agentclientprotocol/codex-acp",
    version: "1.6.2",
  },
});

test("Builder job creation is idempotent and immutable by request id", async () => {
  const store = new InMemoryBuilderJobStore();
  const first = await store.create(input(), new Date("2026-08-26T10:00:00Z"));
  const second = await store.create(input(), new Date("2026-08-26T11:00:00Z"));
  assert.deepEqual(second, first);
  await assert.rejects(
    store.create({ ...input(), objective: "Different objective" }),
    /reused with different immutable input/,
  );
});

test("Builder job input rejects an unsafe immutable proposal target branch", async () => {
  const store = new InMemoryBuilderJobStore();
  await assert.rejects(
    store.create({ ...input(), targetBranchName: "../main" }),
    /targetBranchName is invalid/,
  );
});

test("Builder leases reject concurrent and stale workers and can be recovered", async () => {
  const store = new InMemoryBuilderJobStore();
  await store.create(input(), new Date("2026-08-26T10:00:00Z"));
  const first = await store.claimNext({
    workerId: "worker-a",
    leaseMs: 10_000,
    now: new Date("2026-08-26T10:00:01Z"),
  });
  assert.ok(first);
  assert.equal(await store.claimNext({
    workerId: "worker-b",
    leaseMs: 10_000,
    now: new Date("2026-08-26T10:00:02Z"),
  }), undefined);
  await assert.rejects(
    store.transition({
      jobId: first.job.jobId,
      workerId: "worker-b",
      leaseToken: first.leaseToken,
      from: ["queued"],
      to: "preparing_source",
      now: new Date("2026-08-26T10:00:03Z"),
    }),
    /owned by another worker/,
  );
  const recovered = await store.claimNext({
    workerId: "worker-b",
    leaseMs: 10_000,
    now: new Date("2026-08-26T10:00:12Z"),
  });
  assert.ok(recovered);
  assert.equal(recovered.job.attempts, 2);
});

test("Builder state transitions and cancellation are guarded", async () => {
  const store = new InMemoryBuilderJobStore();
  const created = await store.create(input());
  const lease = await store.claimNext({ workerId: "worker-a", leaseMs: 60_000 });
  assert.ok(lease);
  await store.transition({
    jobId: created.jobId,
    workerId: "worker-a",
    leaseToken: lease.leaseToken,
    from: ["queued"],
    to: "preparing_source",
  });
  await assert.rejects(
    store.transition({
      jobId: created.jobId,
      workerId: "worker-a",
      leaseToken: lease.leaseToken,
      from: ["preparing_source"],
      to: "published",
    }),
    /Invalid Builder job transition/,
  );
  const requested = await store.requestCancellation(created.jobId);
  assert.ok(requested.cancelRequestedAt);
  const cancelled = await store.transition({
    jobId: created.jobId,
    workerId: "worker-a",
    leaseToken: lease.leaseToken,
    from: ["preparing_source"],
    to: "cancelled",
    terminalReason: "requested-by-human",
  });
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.terminalReason, "requested-by-human");
});

test("Builder control tables are additive and mirrored by the standalone schema", () => {
  const migration = readFileSync(new URL("../../state-postgres/migrate.ts", import.meta.url), "utf8");
  const schema = readFileSync(new URL("../../state-postgres/schema.sql", import.meta.url), "utf8");
  for (const table of ["builder_jobs", "repository_installations"]) {
    const expression = new RegExp(`create table if not exists companyos\\.${table}`);
    assert.match(migration, expression);
    assert.match(schema, expression);
  }
  for (const column of [
    "notification_state",
    "notification_next_attempt_at",
    "notification_lease_token",
    "notification_last_error",
  ]) {
    assert.match(migration, new RegExp(column));
    assert.match(schema, new RegExp(column));
  }
  assert.match(migration, /add column if not exists notification_state/);
  assert.match(schema, /builder_notifications_claim_idx/);
  assert.doesNotMatch(
    `${migration}\n${schema}`,
    /\b(?:drop|truncate)\b/i,
  );
});
