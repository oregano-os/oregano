import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import type { JsonValue } from "../../capabilities/contracts.ts";
import { engineFixture, ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";
import { closeParityFixture, openParityClose, wakeParity, approveParity, fixtureReply } from "./workflow-parity-cases.ts";

test("close cohort excludes approved absence while rollover retains every open committed item", async () => {
  const h = closeParityFixture(); let run = await openParityClose(h);
  assert.equal(run.state.cursor, "await-chase");
  run = await wakeParity(h, run.runId, "2030-01-04T15:20:00.000Z");
  assert.deepEqual((run.state.steps["classify-at-chase"]!.output as any).states, { "jonas-owner": "needs-reformat", "lea-contributor": "missing" });
  run = await wakeParity(h, run.runId, "2030-01-04T16:00:00.000Z");
  assert.equal(run.state.blocked, undefined);
  assert.deepEqual((run.state.steps["close-view"]!.output as any).states, { "jonas-owner": "needs-reformat", "lea-contributor": "complete" });
  const cohort = (run.state.steps["snapshot-participants"]!.output as any).rows;
  assert.equal(cohort.find((row: any) => row.values.participant_id === "tim-contributor").values.included, false);
  assert.deepEqual((run.state.steps["close-view"]!.output as any).open_work_items, [
    { work_item_id: "item-a", provider_version: "v1" }, { work_item_id: "item-c", provider_version: "v1" },
  ]);
  const messages = h.calls.filter((call) => call.capability === "communication.message.publish");
  assert.equal(messages.length, 5);
  assert.equal(messages[0]!.input.destination_binding, "studio-sprints");
  assert.equal(Object.hasOwn(messages[0]!.input, "thread_reference"), false);
  const root = (run.state.steps["open-close-thread"]!.output as any).thread_reference;
  assert.deepEqual(messages.slice(1, 4).map((message) => message.input.thread_reference), [root, root, root]);
  const completions = (await h.control.listEvents(run.runId)).filter((event) => event.event === "workflow.step-completed").map((event) => event.step_id ?? event.stepId);
  assert.ok(completions.indexOf("report") < completions.indexOf("retro"));
  assert.ok(completions.indexOf("retro") < completions.indexOf("prepare-rollover"));
  assert.equal(h.calls.filter((call) => call.capability === "work-item.batch-update").length, 0);
  assert.deepEqual(run.state.decisions["approve-rollover"]!.bound, [
    { work_item_id: "item-a", expected_version: "v1", changes: { sprint: "test-two" } },
    { work_item_id: "item-c", expected_version: "v1", changes: { sprint: "test-two" } },
  ]);
  run = await approveParity(h, run);
  assert.equal(run.state.status, "done");
  const writes = h.calls.filter((call) => call.capability === "work-item.batch-update");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]!.input.updates, run.state.decisions["approve-rollover"]!.bound);
  const count = h.calls.length;
  await h.engine().advance(run.runId); await h.engine().timers();
  assert.equal(h.calls.length, count);
});

test("late workers preserve both logical close deadlines and cannot use a future reply for the chase", async () => {
  const h = closeParityFixture(); let run = await openParityClose(h);
  run = await wakeParity(h, run.runId, "2030-01-04T16:05:00.000Z");
  assert.equal(run.state.cursor, "await-report");
  assert.equal((run.state.steps["classify-at-chase"]!.output as any).cutoff, "2030-01-04T15:20:00.000Z");
  assert.equal((run.state.steps["classify-at-chase"]!.output as any).states["lea-contributor"], "missing");
  h.submissions.push(fixtureReply("late-correction", "jonas-owner", ["item-b"], "2030-01-04T16:00:00.000001Z"));
  run = await wakeParity(h, run.runId, h.now);
  assert.equal(run.state.cursor, "approve-rollover");
  assert.equal((run.state.steps["close-view"]!.output as any).cutoff, "2030-01-04T16:00:00.000Z");
  assert.equal((run.state.steps["close-view"]!.output as any).states["jonas-owner"], "needs-reformat");
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 5);
});

test("empty commitments still require replies and finish without a rollover decision or batch", async () => {
  const h = closeParityFixture(); h.items.length = 0; h.submissions.length = 0;
  let run = await openParityClose(h);
  run = await wakeParity(h, run.runId, "2030-01-04T15:20:00.000Z");
  assert.deepEqual((run.state.steps["classify-at-chase"]!.output as any).states, { "jonas-owner": "missing", "lea-contributor": "missing" });
  h.submissions.push(fixtureReply("empty", "lea-contributor", [], "2030-01-04T16:00:00.000Z"));
  run = await wakeParity(h, run.runId, "2030-01-04T16:00:00.000Z");
  assert.equal(run.state.status, "done");
  assert.deepEqual((run.state.steps["close-view"]!.output as any).states, { "jonas-owner": "missing", "lea-contributor": "complete" });
  assert.deepEqual(run.state.decisions, {});
  assert.equal(h.calls.filter((call) => call.capability === "work-item.batch-update").length, 0);
});

test("Monday reads the current board without a prior close and publishes shared and unmatched assignments once", async () => {
  const h = engineFixture(); h.now = "2030-01-07T09:00:00.000Z";
  h.items[0]!.values.assignee_ids = ["lea-contributor", "tim-contributor"];
  h.items.push({ record_id: "unmatched", values: { ...h.items[0]!.values, work_item_id: "unmatched", assignee_ids: ["outside-cohort"] } });
  const opened = await h.engine().openOperator({ workflowId: "monday-handoff", requestId: randomUUID(), principal: ENGINE_OPERATOR,
    fields: { period_start: "2030-01-07", period_end: "2030-01-11" } });
  const run = (await h.engine().advance(opened.runId))!;
  assert.equal(run.state.status, "done", JSON.stringify(run.state));
  const view = run.state.steps["handoff-view"]!.output as any;
  assert.deepEqual(view.groups.map((group: any) => [group.participant_id, group.work_items.map((item: any) => [item.work_item_id, item.shared])]), [
    ["jonas-owner", []], ["lea-contributor", [["item-1", true]]], ["tim-contributor", [["item-1", true]]],
  ]);
  assert.equal(view.unique_work_item_count, 2);
  assert.equal(view.unassigned_count, 1);
  assert.deepEqual(view.unassigned_work_items.map((item: any) => item.work_item_id), ["unmatched"]);
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 1);
  const workRead = h.calls.find((call) => call.capability === "records.query" && call.input.projection_id === "sprint-work-items")!;
  assert.deepEqual(workRead.input.filters, { group: "in_sprint" });
  assert.equal(h.calls.some((call) => call.input.projection_id === "sprint-close-submissions"), false);
});

test("Wednesday groups one focused question per owner and binds all readiness changes after the digest", async () => {
  const h = engineFixture(); h.now = "2030-01-09T16:30:00.000Z";
  const candidates: Array<Record<string, JsonValue>> = [
    { work_item_id: "item-d", provider_version: "v1", status: "Planned", assignee_ids: ["lea-contributor"], fields: {} },
    { work_item_id: "item-e", provider_version: "v1", status: "Planned", assignee_ids: ["jonas-owner"], fields: { outcome: "One", definition_of_done: "Checked", planned_effort: 0 } },
    { work_item_id: "item-f", provider_version: "v2", status: "Ready for Sprint", assignee_ids: ["lea-contributor"], fields: {} },
  ];
  h.planning.push(...candidates.map((value) => ({ record_id: String(value.work_item_id), values: value })));
  const opened = await h.engine().openOperator({ workflowId: "weekday-digest", requestId: randomUUID(), principal: ENGINE_OPERATOR, fields: {}, params: { readiness: true } });
  let run = (await h.engine().advance(opened.runId))!;
  assert.equal(run.state.cursor, "approve-labels", JSON.stringify(run.state));
  const view = run.state.steps["readiness-view"]!.output as any;
  assert.deepEqual(view.summary, { candidate_count: 3, ready_count: 1, missing_count: 2 });
  assert.deepEqual(view.questions.map(({ participant_id, work_item_id, missing_fields }: any) => ({ participant_id, work_item_id, missing_fields })), [
    { participant_id: "lea-contributor", work_item_id: "item-d", missing_fields: ["definition_of_done", "outcome", "planned_effort"] },
  ]);
  assert.deepEqual(view.updates, [
    { work_item_id: "item-e", expected_version: "v1", changes: { status: "Ready for Sprint" } },
    { work_item_id: "item-f", expected_version: "v2", changes: { status: "Planned" } },
  ]);
  assert.deepEqual(h.calls.filter((call) => call.capability === "communication.message.publish").map((call) => call.input.destination_binding), ["studio-sprints", "direct-lea-contributor", "direct-jonas-owner"]);
  assert.equal(h.calls.filter((call) => call.capability === "work-item.batch-update").length, 0);
  const planning = h.calls.find((call) => call.input.filters?.group === "planned")!;
  assert.equal(planning.input.filters.changed_since, undefined);
  run = await approveParity(h, run);
  assert.equal(run.state.status, "done");
  const writes = h.calls.filter((call) => call.capability === "work-item.batch-update");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]!.input.updates, view.updates);
});
