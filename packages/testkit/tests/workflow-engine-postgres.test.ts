import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createPostgresWorkflowExecutionStore } from "../../state-postgres/workflow-store.ts";
import { createPostgresStateStore } from "../../state-postgres/store.ts";
import { createPostgresDurableTimerStore } from "../../state-postgres/durable-timer-store.ts";
import { engineFixture, ENGINE_OPERATOR, ENGINE_OWNER } from "../workflow-engine-fixture.ts";
import { workflowDecisionId } from "../../runtime/workflow-engine/decision-notice.ts";

const enabled = process.env.RUN_DATABASE_TESTS === "1";
if (process.env.COMPANYOS_REQUIRE_DATABASE_TESTS === "1" && (!enabled || !process.env.DATABASE_URL)) throw new Error("Required database configuration is missing.");
const fixture = () => engineFixture({ store: createPostgresWorkflowExecutionStore(), control: createPostgresStateStore(), timerStore: createPostgresDurableTimerStore() });

test("Postgres actual Engine runs Friday from entry through persisted waits, decision and atomic approval/effect", { skip: !enabled }, async () => {
  const h = fixture(), requestId = randomUUID();
  const args = { workflowId: "friday-close", principal: ENGINE_OPERATOR, requestId, fields: { sprint_id: "test-one", next_sprint_id: "test-two" } };
  let run = await h.engine().openOperator(args);
  assert.equal((await h.engine().openOperator({ ...args, fields: { next_sprint_id: "test-two", sprint_id: "test-one" } })).runId, run.runId);
  await assert.rejects(h.engine().openOperator({ ...args, fields: { ...args.fields, sprint_id: "changed" } }), /conflict/);
  run = (await h.engine().advance(run.runId))!; assert.equal(run.state.cursor, "await-chase", JSON.stringify(run.state));
  h.now = "2030-01-04T15:20:00.000Z"; await h.engine().timers(); run = (await h.engine().advance(run.runId))!;
  assert.equal(run.state.cursor, "await-report", JSON.stringify(run.state));
  h.now = "2030-01-04T16:00:00.000Z"; await h.engine().timers(); run = (await h.engine().advance(run.runId))!;
  assert.equal(run.state.cursor, "approve-rollover", JSON.stringify(run.state)); assert.equal(run.state.status, "waiting");
  const decision = run.state.decisions["approve-rollover"]!;
  const response = { principal: ENGINE_OWNER, conversation: h.conversation("direct-jonas-owner", decision.deliveries["jonas-owner"]!), eventId: randomUUID(), requestId: workflowDecisionId(run.runId, decision.stepId, decision.boundDigest), decision: "approved" as const };
  const attempts = await Promise.allSettled([h.engine().decide(response), h.engine().decide(response)]);
  assert.ok(attempts.some((attempt) => attempt.status === "fulfilled"));
  run = (await h.engine().advance(run.runId))!; assert.equal(run.state.status, "done", JSON.stringify(run.state));
  assert.deepEqual(await h.engine().decide(response), run);
  assert.equal(h.calls.filter((call) => call.capability === "work-item.batch-update").length, 1);
  assert.equal((await h.control.listEvents(run.runId)).filter((event) => event.event === "workflow.decision-approved").length, 1);
  const persisted = await createPostgresWorkflowExecutionStore().read(run.instanceId, run.runId);
  assert.deepEqual(persisted, JSON.parse(JSON.stringify(run)));
});

test("Postgres engine crash after successful publication recovers by lease expiry without provider deduplication", { skip: !enabled }, async () => {
  const h = fixture(); const run = await h.engine().openOperator({ workflowId: "monday-handoff", requestId: randomUUID(), principal: ENGINE_OPERATOR, fields: { period_start: "2030-01-07", period_end: "2030-01-11" } });
  const original = h.store.commit.bind(h.store); let crashed = false;
  h.store.commit = async (args) => {
    if (!crashed && args.event.name === "workflow.step-completed" && args.event.stepId === "post-handoff") { crashed = true; return undefined; }
    return original(args);
  };
  await h.engine().advance(run.runId); assert.ok(crashed);
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 1);
  h.now = "2030-01-04T14:36:00.000Z";
  const done = (await h.engine().advance(run.runId))!;
  assert.equal(done.state.status, "done", JSON.stringify(done.state));
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 1);
});

test("Postgres actual Engine cancellation wins before provider dispatch", { skip: !enabled }, async () => {
  const h = fixture(), run = await h.engine().openOperator({ workflowId: "monday-handoff", requestId: randomUUID(), principal: ENGINE_OPERATOR, fields: { period_start: "2030-01-07", period_end: "2030-01-11" } });
  const original = h.control.claimEffect.bind(h.control);
  h.control.claimEffect = async (...args) => { const claim = await original(...args); await h.engine().cancel(run.runId, ENGINE_OPERATOR); return claim; };
  const stopped = (await h.engine().advance(run.runId))!;
  assert.equal(stopped.state.status, "cancelled");
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 0);
});

test("Postgres keyed messages and business-day timers survive reconstructed workers without repeating recipients", { skip: !enabled }, async () => {
  const h = fixture(); h.now = "2030-01-08T09:00:00.000Z";
  h.items.push({ record_id: "item-2", values: { ...h.items[0]!.values, work_item_id: "item-2", assignee_ids: ["tim-contributor"] } });
  let run = await h.engine().openOperator({ workflowId: "board-hygiene", requestId: randomUUID(), principal: ENGINE_OPERATOR, fields: {} });
  for (let i = 0; i < 20; i++) {
    run = (await h.engine().step(run.runId))!; assert.equal(run.state.blocked, undefined, JSON.stringify(run.state));
    if (Object.keys(run.state.steps["nudge-owners"]?.items ?? {}).length === 1) break;
  }
  assert.equal(Object.keys(run.state.steps["nudge-owners"]!.items!).length, 1);
  run = (await h.engine().advance(run.runId))!; assert.equal(run.state.cursor, "grace", JSON.stringify(run.state));
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 2);
  h.now = run.state.wait!.dueAt;
  const [old] = await h.timers.claimDue({ timerKind: "workflow", now: h.now, owner: "test-expired", leaseToken: randomUUID(), leaseExpiresAt: "2030-01-10T09:01:00.000Z" });
  assert.ok(old); h.now = "2030-01-10T09:02:00.000Z"; assert.equal(await h.engine().wake(old), false);
  await h.engine().timers(); run = (await h.engine().advance(run.runId))!; assert.equal(run.state.cursor, "approve-move", JSON.stringify(run.state));
  await h.engine().cancel(run.runId, ENGINE_OPERATOR); h.now = "2030-01-20T09:00:00.000Z"; await h.engine().timers();
  assert.equal((await h.store.read(run.instanceId, run.runId))!.state.status, "cancelled");
  assert.equal(h.calls.filter((call) => call.capability === "work-item.batch-update").length, 0);
});
