import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { engineFixture, ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";

const open = async (h: ReturnType<typeof engineFixture>) => {
  const run = await h.engine().openOperator({ workflowId: "friday-close", requestId: randomUUID(), principal: ENGINE_OPERATOR,
    fields: { sprint_id: "test-one", next_sprint_id: "test-two" } });
  const waiting = (await h.engine().advance(run.runId))!;
  assert.equal(waiting.state.blocked, undefined); assert.equal(waiting.state.cursor, "await-chase"); return waiting;
};
const wake = async (h: ReturnType<typeof engineFixture>, runId: string, now: string) => {
  h.now = now; await h.engine().timers();
  const run = (await h.engine().advance(runId))!;
  assert.equal(run.state.blocked, undefined, JSON.stringify(run.state)); return run;
};
const reply = (id: string, participantId: string, taskIds: string[], acceptedAt = "2030-01-04T15:00:00.000Z") => ({ record_id: id,
  values: { participant_id: participantId, content_participant_id: participantId, task_ids: taskIds, accepted_at: acceptedAt, well_formed: true } });

test("current completed work cannot roll over from stale opening status or provider versions", async () => {
  const h = engineFixture(), run = await open(h);
  h.items[0]!.values.status = "Done"; h.items[0]!.values.provider_version = "v2";
  h.submissions.push(reply("owner", "jonas-owner", []), reply("contributor", "lea-contributor", ["item-1"]), reply("other", "tim-contributor", []));
  await wake(h, run.runId, "2030-01-04T15:20:00.000Z");
  const completed = await wake(h, run.runId, "2030-01-04T16:00:00.000Z");
  assert.equal(completed.state.status, "done", "a newly closed item must not produce a stale rollover approval");
  assert.deepEqual((completed.state.steps["close-view"]!.output as any).open_work_items, []);
  assert.deepEqual(completed.state.decisions, {});
  assert.equal(completed.state.steps.chase, undefined, "complete timely replies skip the chase");
  const messages = h.calls.filter((call) => call.capability === "communication.message.publish");
  assert.equal(messages.length, 3, "one root, one report and one retro");
  assert.equal(h.calls.filter((call) => call.capability === "work-item.batch-update").length, 0);
  const events = (await h.control.listEvents(run.runId)).filter((event) => event.event === "workflow.step-completed");
  const ids = events.map((event) => event.step_id ?? event.stepId);
  assert.ok(ids.indexOf("report") < ids.indexOf("retro"));
});

test("participants stay frozen while current work facts and late-processed timely replies reach the report", async () => {
  const h = engineFixture(), run = await open(h);
  const snapshot = structuredClone(run.state.steps["snapshot-participants"]!.output);
  h.roster.find((member) => member.id === "tim-contributor")!.status = "inactive";
  h.items[0]!.values.provider_version = "v3";
  h.items.push({ record_id: "item-2", values: { ...h.items[0]!.values, work_item_id: "item-2", provider_version: "v4" } });
  await wake(h, run.runId, "2030-01-04T15:20:00.000Z");
  // Processing is late; the provider-accepted instants remain the cutoff facts.
  h.submissions.push(reply("timely", "lea-contributor", ["item-1", "item-2"], "2030-01-04T15:59:59.999999Z"),
    reply("after-cutoff", "lea-contributor", [], "2030-01-04T16:00:00.000001Z"));
  const reported = await wake(h, run.runId, "2030-01-04T16:05:00.000Z");
  assert.deepEqual(reported.state.steps["snapshot-participants"]!.output, snapshot);
  const close = reported.state.steps["close-view"]!.output as any;
  assert.deepEqual(close.states, { "jonas-owner": "missing", "lea-contributor": "complete", "tim-contributor": "missing" });
  assert.equal(close.cutoff, "2030-01-04T16:00:00.000Z");
  assert.deepEqual(reported.state.decisions["approve-rollover"]!.bound, [
    { work_item_id: "item-1", expected_version: "v3", changes: { sprint: "test-two" } },
    { work_item_id: "item-2", expected_version: "v4", changes: { sprint: "test-two" } },
  ]);
  assert.equal(h.calls.filter((call) => call.capability === "directory.members.query").length, 1);
  const workReads = h.calls.filter((call) => call.capability === "records.query" && call.input.projection_id === "sprint-work-items");
  assert.ok(workReads.some((call) => call.input.require_synced_through === "2030-01-04T16:00:00.000Z"));
});
