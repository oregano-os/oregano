import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { engineArtifact, engineFixture, ENGINE_OPERATOR, ENGINE_OWNER } from "../workflow-engine-fixture.ts";
import { workflowDecisionId } from "../../runtime/workflow-engine/decision-notice.ts";
import { sha256 } from "../../runtime/canonical.ts";
import type { WorkflowRun } from "../../state-store/workflow-engine.ts";

const fields = { sprint_id: "period-1", next_sprint_id: "period-2", period_start: "2030-01-07", period_end: "2030-01-11" };
const open = (h: ReturnType<typeof engineFixture>, workflowId = "friday-close", requestId = randomUUID()) => h.engine().openOperator({ workflowId, requestId, principal: ENGINE_OPERATOR, fields: Object.fromEntries(Object.entries(fields).filter(([key]) => h.artifact.workflows!.find((w) => w.id === workflowId)!.instance.fields.includes(key))), params: { readiness: false } });
const advance = async (h: ReturnType<typeof engineFixture>, run: WorkflowRun) => {
  const result = (await h.engine().advance(run.runId))!;
  assert.equal(result.state.blocked, undefined, JSON.stringify(result.state));
  return result;
};
const atDecision = async (h: ReturnType<typeof engineFixture>) => {
  let run = await advance(h, await open(h));
  assert.equal(run.state.cursor, "await-chase");
  h.now = "2030-01-04T15:20:00.000Z"; await h.engine().timers(); run = await advance(h, run);
  assert.equal(run.state.cursor, "await-report");
  h.now = "2030-01-04T16:00:00.000Z"; await h.engine().timers(); run = await advance(h, run);
  assert.equal(run.state.cursor, "approve-rollover");
  return run;
};
const response = (h: ReturnType<typeof engineFixture>, run: WorkflowRun) => {
  const decision = run.state.decisions[run.state.cursor!]!;
  return { principal: ENGINE_OWNER, conversation: h.conversation("direct-jonas-owner", decision.deliveries["jonas-owner"]!), eventId: randomUUID(),
    requestId: workflowDecisionId(run.runId, decision.stepId, decision.boundDigest), decision: "approved" as const };
};

test("actual Engine runs frozen Company Tools, waits, report and a bound synthetic human approval before one batch", async () => {
  const h = engineFixture();
  let run = await atDecision(h);
  assert.equal(run.state.decisions["approve-rollover"]!.expiresAt, "2030-01-08T16:00:00.000Z");
  assert.equal(h.calls.filter((c) => c.capability === "work-item.batch-update").length, 0);
  const messages = h.calls.filter((c) => c.capability === "communication.message.publish");
  assert.equal(Object.hasOwn(messages[0]!.input, "thread_reference"), false);
  for (const message of messages.slice(1, 4)) assert.equal(message.input.thread_reference, (run.state.steps["open-close-thread"]!.output as any).thread_reference);
  assert.match(messages.at(-1)!.input.content, /Complete bound payload/);
  assert.match(messages.at(-1)!.input.content, /item-1/);
  const decision = response(h, run);
  run = await h.engine().decide(decision);
  assert.deepEqual(await h.engine().decide(decision), run);
  run = await advance(h, run);
  assert.equal(run.state.status, "done");
  assert.deepEqual(await h.engine().decide(decision), run);
  assert.equal(await h.store.assignment({ instanceId: run.instanceId, conversation: decision.conversation, now: h.now }), undefined);
  const writes = h.calls.filter((c) => c.capability === "work-item.batch-update");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]!.input.updates, run.state.decisions["approve-rollover"]!.bound);
  const count = h.calls.length; await h.engine().advance(run.runId); assert.equal(h.calls.length, count);
  const events = await h.control.listEvents(run.runId);
  assert.ok(events.some((event) => event.event === "approval.requested"));
  assert.ok(events.some((event) => event.event === "workflow.decision-approved"));
});

test("opening redelivery preserves logical time and detects changed values despite key order", async () => {
  const h = engineFixture(), requestId = randomUUID();
  const first = await open(h, "monday-handoff", requestId);
  h.now = "2030-01-07T10:00:00.000Z";
  assert.equal((await open(h, "monday-handoff", requestId)).runId, first.runId);
  await assert.rejects(h.engine().openOperator({ workflowId: "monday-handoff", requestId, principal: ENGINE_OPERATOR, fields: { sprint_id: "other", period_start: fields.period_start, period_end: fields.period_end }, params: { readiness: false } }), /conflict/);
  const second = await open(h, "monday-handoff"); assert.notEqual(second.runId, first.runId);
  await advance(h, first); await advance(h, second);
  assert.equal(h.calls.filter((c) => c.capability === "communication.message.publish").length, 2);
});

test("restart between provider success and step commit recovers the stored effect without a second send", async () => {
  const h = engineFixture(); let run = await open(h, "monday-handoff");
  const original = h.store.commit.bind(h.store); let crashed = false;
  h.store.commit = async (args) => {
    if (!crashed && args.event.name === "workflow.step-completed" && args.event.stepId === "post-handoff") { crashed = true; throw new Error("Injected process failure after provider success"); }
    return original(args);
  };
  run = (await h.engine().advance(run.runId))!;
  assert.ok(crashed); assert.ok(run.state.blocked);
  assert.equal(h.calls.filter((c) => c.capability === "communication.message.publish").length, 1);
  await h.engine().resume(run.runId, ENGINE_OPERATOR);
  run = await advance(h, run); assert.equal(run.state.status, "done");
  assert.equal(h.calls.filter((c) => c.capability === "communication.message.publish").length, 1);
});

test("missing required publication proof blocks and preserves its successful effect across operator resume", async () => {
  const h = engineFixture(); h.missingThread = true;
  let run = (await h.engine().advance((await open(h)).runId))!;
  assert.ok(run.state.blocked); assert.equal(run.state.cursor, "open-close-thread");
  await h.engine().resume(run.runId, ENGINE_OPERATOR);
  run = (await h.engine().advance(run.runId))!; assert.ok(run.state.blocked);
  assert.equal(h.calls.filter((c) => c.capability === "communication.message.publish").length, 1);
});

test("rejected, wrong-member and stale human replies release their lease and cannot mutate the bound set", async () => {
  const h = engineFixture(), run = await atDecision(h), decision = response(h, run);
  await assert.rejects(h.engine().decide({ ...decision, requestId: "wrong" }), /stale/);
  assert.equal((await h.store.read(run.instanceId, run.runId))!.lease, undefined);
  await assert.rejects(h.engine().decide({ ...decision, principal: ENGINE_OPERATOR }), /assignment/);
  const rejected = await h.engine().decide({ ...decision, decision: "rejected" });
  assert.equal(rejected.state.status, "done");
  assert.equal(h.calls.filter((c) => c.capability === "work-item.batch-update").length, 0);
});

test("unresolved decisions time out after business days without fabricating approval", async () => {
  const h = engineFixture(), run = await atDecision(h);
  h.now = "2030-01-08T16:00:00.000Z"; await h.engine().timers();
  const ended = (await h.store.read(run.instanceId, run.runId))!;
  assert.equal(ended.state.status, "done"); assert.equal(ended.state.decisions["approve-rollover"]!.status, "timed-out");
  assert.equal(h.calls.filter((c) => c.capability === "work-item.batch-update").length, 0);
});

test("provider unknown batch outcome blocks permanently until explicit reconciliation; repeated execution never repeats the write", async () => {
  const h = engineFixture(); let run = await atDecision(h); await h.engine().decide(response(h, run)); h.unknownBatch = true;
  run = (await h.engine().advance(run.runId))!; assert.ok(run.state.blocked);
  await assert.rejects(h.engine().resume(run.runId, ENGINE_OPERATOR), /reconciliation/);
  assert.equal((await h.store.read(run.instanceId, run.runId))!.lease, undefined);
  await h.engine().advance(run.runId);
  assert.equal(h.calls.filter((c) => c.capability === "work-item.batch-update").length, 1);
});

test("historical execution retains its original Artifact after a new deployment", async () => {
  const h = engineFixture(), run = await open(h, "monday-handoff"), updated = structuredClone(h.artifact);
  updated.provenance.builtAt = "2030-01-05T00:00:00.000Z";
  // A separately valid Artifact includes a different Instance description, not altered historical bytes.
  updated.instance.environment = "preview";
  const { artifactHash: _, ...content } = updated; updated.artifactHash = sha256({ ...content, provenance: { ...content.provenance, builtAt: undefined } });
  const done = (await h.engine(updated).advance(run.runId))!;
  assert.equal(done.state.status, "done", JSON.stringify(done.state)); assert.equal(done.artifactHash, h.artifact.artifactHash);
});

test("weekday digest resolves the prior calendar occurrence and skips readiness from the frozen trigger parameter", async () => {
  const h = engineFixture(); h.now = "2030-01-07T16:30:00.000Z";
  const run = await advance(h, await open(h, "weekday-digest"));
  assert.equal(run.trigger.previous_instant, "2030-01-04T16:30:00.000Z");
  assert.equal(run.state.status, "done");
  const reads = h.calls.filter((c) => c.capability === "records.query");
  assert.equal(reads[0]!.input.filters.changed_since, run.trigger.previous_instant);
  assert.equal(reads.some((c) => c.input.filters?.group === "planned"), false);
});

test("keyed owner messages persist partial progress across worker reconstruction and each owner receives one send", async () => {
  const h = engineFixture(); h.now = "2030-01-08T09:00:00.000Z";
  h.items.push({ record_id: "item-2", values: { ...h.items[0]!.values, work_item_id: "item-2", assignee_ids: ["tim-contributor"] } });
  let run = await open(h, "board-hygiene");
  for (let i = 0; i < 20; i++) {
    run = (await h.engine().step(run.runId))!;
    assert.equal(run.state.blocked, undefined);
    if (Object.keys(run.state.steps["nudge-owners"]?.items ?? {}).length === 1) break;
  }
  assert.equal(Object.keys(run.state.steps["nudge-owners"]!.items!).length, 1);
  run = await advance(h, run);
  assert.equal(run.state.cursor, "grace");
  assert.equal(run.state.wait!.dueAt, "2030-01-10T09:00:00.000Z");
  const messages = h.calls.filter((c) => c.capability === "communication.message.publish");
  assert.deepEqual(messages.map((c) => c.input.destination_binding).sort(), ["direct-lea-contributor", "direct-tim-contributor"]);
  h.now = "2030-01-10T09:00:00.000Z"; await h.engine().timers(); run = await advance(h, run);
  assert.equal(run.state.cursor, "approve-move"); await h.engine().decide(response(h, run));
  run = await advance(h, run); assert.equal(run.state.status, "done");
  assert.equal(h.calls.filter((c) => c.capability === "work-item.batch-update").length, 1);
});

test("readiness covers all planning candidates, sends bounded questions and gates the exact label batch", async () => {
  const h = engineFixture(); h.now = "2030-01-09T16:30:00.000Z";
  h.planning.push({ record_id: "candidate-1", values: { work_item_id: "candidate-1", provider_version: "v2", status: "Ready for Sprint", assignee_ids: ["lea-contributor"], fields: {} } });
  const opened = await h.engine().openOperator({ workflowId: "weekday-digest", requestId: randomUUID(), principal: ENGINE_OPERATOR, fields: {}, params: { readiness: true } });
  let run = await advance(h, opened); assert.equal(run.state.cursor, "approve-labels");
  const planning = h.calls.find((c) => c.input.filters?.group === "planned")!;
  assert.equal(planning.input.filters.changed_since, undefined);
  assert.deepEqual((run.state.steps["readiness-view"]!.output as any).summary, { candidate_count: 1, ready_count: 0, missing_count: 1 });
  await h.engine().decide(response(h, run)); run = await advance(h, run); assert.equal(run.state.status, "done");
  assert.deepEqual(h.calls.find((c) => c.capability === "work-item.batch-update")!.input.updates, [{ work_item_id: "candidate-1", expected_version: "v2", changes: { status: "Planned" } }]);
});

test("actual cancellation between effect claim and dispatch prevents the provider call", async () => {
  const h = engineFixture(), run = await open(h, "monday-handoff");
  const claim = h.control.claimEffect.bind(h.control); let cancelled = false;
  h.control.claimEffect = async (...args) => {
    const result = await claim(...args);
    if (!cancelled) { cancelled = true; await h.engine().cancel(run.runId, ENGINE_OPERATOR); }
    return result;
  };
  const stopped = (await h.engine().advance(run.runId))!;
  assert.equal(stopped.state.status, "cancelled");
  assert.equal(h.calls.filter((c) => c.capability === "communication.message.publish").length, 0);
});

test("an expired timer worker cannot wake the run and reconstructed timers recover the persisted wait", async () => {
  const h = engineFixture(); let run = await advance(h, await open(h));
  h.now = run.state.wait!.dueAt;
  const [old] = await h.timers.claimDue({ timerKind: "workflow", now: h.now, owner: "old-worker", leaseToken: randomUUID(), leaseExpiresAt: "2030-01-04T15:21:00.000Z" });
  assert.ok(old);
  h.now = "2030-01-04T15:22:00.000Z";
  assert.equal(await h.engine().wake(old), false);
  assert.equal((await h.store.read(run.instanceId, run.runId))!.state.cursor, "await-chase");
  await h.engine().timers(); run = await advance(h, run); assert.equal(run.state.cursor, "await-report");
});

test("delivery windows create durable waits and a second missed window does not reuse an old timer identity", async () => {
  const h = engineFixture(); h.now = "2030-01-04T19:00:00.000Z";
  let run = await advance(h, await open(h, "monday-handoff")); assert.equal(run.state.wait!.kind, "delivery");
  const first = run.state.wait!.timerId;
  h.now = "2030-01-07T19:00:00.000Z"; await h.engine().timers(); run = await advance(h, run);
  assert.notEqual(run.state.wait!.timerId, first); assert.equal(h.calls.filter((c) => c.capability === "communication.message.publish").length, 0);
  h.now = "2030-01-08T07:00:00.000Z"; await h.engine().timers(); run = await advance(h, run); assert.equal(run.state.status, "done");
});

test("scheduled openings use declared keys, refuse inactive calendars and retain variant parameters", async (t) => {
  const blocked = engineFixture();
  await assert.rejects(blocked.engine().openScheduled({ workflowId: "weekday-digest", principal: ENGINE_OPERATOR, fields: {}, instant: "2030-01-09T16:30:00.000Z" }), /activation/);
  const root = mkdtempSync(join(tmpdir(), "workflow-engine-schedule-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(resolve(import.meta.dirname, "./lindenhof-studio"), root, { recursive: true });
  const path = join(root, "schedules/sprint-rhythm.yaml"); writeFileSync(path, readFileSync(path, "utf8").replace("activation: blocked", "activation: active"));
  const h = engineFixture({ artifact: engineArtifact(undefined, root) }); h.now = "2030-01-09T16:30:00.000Z";
  const args = { workflowId: "weekday-digest", principal: ENGINE_OPERATOR, fields: {}, instant: h.now };
  const first = await h.engine().openScheduled(args), duplicate = await h.engine().openScheduled(args);
  assert.equal(first.runId, duplicate.runId); assert.equal(first.trigger.params.readiness, true);
  const next = await h.engine().openScheduled({ ...args, instant: "2030-01-10T16:30:00.000Z" });
  assert.notEqual(next.runId, first.runId); assert.equal(next.trigger.params.readiness, false);
  await assert.rejects(h.engine().openScheduled({ ...args, instant: "2030-01-09T16:31:00.000Z" }), /exact declared/);
  await assert.rejects(h.engine().openScheduled({ ...args, workflowId: "friday-close", instant: "2030-01-11T14:30:00.000Z" }), /key field/);
});

test("every keyed recipient is checked before any send and a corrected transient read can resume", async () => {
  const h = engineFixture(); h.now = "2030-01-08T09:00:00.000Z";
  h.items.push({ record_id: "item-2", values: { ...h.items[0]!.values, work_item_id: "item-2", assignee_ids: ["unknown-member"] } });
  const run = (await h.engine().advance((await open(h, "board-hygiene")).runId))!;
  assert.ok(run.state.blocked); assert.equal(h.calls.filter((c) => c.capability === "communication.message.publish").length, 0);
  const second = engineFixture(); second.failQuery = true;
  let failed = (await second.engine().advance((await open(second, "monday-handoff")).runId))!;
  assert.ok(failed.state.blocked); second.failQuery = false;
  await second.engine().resume(failed.runId, ENGINE_OPERATOR); failed = await advance(second, failed); assert.equal(failed.state.status, "done");
});

test("current human eligibility is checked again after notice delivery and before effect execution", async () => {
  const h = engineFixture(), run = await atDecision(h), reply = response(h, run);
  h.roster.find((m) => m.id === "jonas-owner")!.status = "inactive";
  await assert.rejects(h.engine().decide(reply), /authorized role/);
  assert.equal((await h.store.read(run.instanceId, run.runId))!.lease, undefined);
  h.roster.find((m) => m.id === "jonas-owner")!.status = "active";
  await h.engine().decide(reply); h.roster.find((m) => m.id === "jonas-owner")!.mayApprove = [];
  const blocked = (await h.engine().advance(run.runId))!; assert.ok(blocked.state.blocked);
  assert.equal(h.calls.filter((c) => c.capability === "work-item.batch-update").length, 0);
});
