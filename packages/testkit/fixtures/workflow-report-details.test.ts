import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { engineFixture } from "../workflow-engine-fixture.ts";
import { fixtureCompanyTools } from "../company-tool-fixture.ts";
import { closeParityFixture, openParityClose, wakeParity } from "./workflow-parity-cases.ts";

const execute = fixtureCompanyTools(resolve(import.meta.dirname, "lindenhof-studio/agents/sprint/tools"));

test("ordinary close reports retain participant names and observed open-item titles and links without changing the decision payload", async () => {
  const h = closeParityFixture();
  let run = await openParityClose(h);
  run = await wakeParity(h, run.runId, "2030-01-04T15:20:00.000Z");
  run = await wakeParity(h, run.runId, "2030-01-04T16:00:00.000Z");
  assert.equal(run.state.cursor, "approve-rollover");
  assert.equal(run.state.blocked, undefined);
  const close = run.state.steps["close-view"]!.output as any;
  assert.deepEqual(close.states, { "jonas-owner": "needs-reformat", "lea-contributor": "complete" });
  assert.equal(close.report_text, "- Jonas Example: please correct the format or task list\n- Lea Example: complete");
  assert.deepEqual(close.open_work_items, [{ work_item_id: "item-a", provider_version: "v1" }, { work_item_id: "item-c", provider_version: "v1" }]);
  assert.equal(close.open_items_text, "- [Alpha](https://example.test/items/item-a)\n- [Gamma](https://example.test/items/item-c)");
  const messages = h.calls.filter((call) => call.capability === "communication.message.publish");
  const report = messages.find((call) => call.context.stepId === "report")!;
  assert.ok(report.input.content.includes(close.report_text));
  const retro = messages.find((call) => call.context.stepId === "retro")!;
  assert.ok(retro.input.content.includes(close.open_items_text));
  assert.doesNotMatch(retro.input.content, /\[Beta\]|https:\/\/example.test\/items\/item-b/);
  assert.equal(retro.input.thread_reference, report.input.thread_reference);
  const rows = (run.state.steps["work-items-at-report"]!.output as any).rows;
  assert.deepEqual(rows.map((row: any) => [row.record_id, row.values.title, row.values.url]), [
    ["item-a", "Alpha", "https://example.test/items/item-a"], ["item-b", "Beta", "https://example.test/items/item-b"], ["item-c", "Gamma", "https://example.test/items/item-c"],
  ]);
  assert.equal(rows.every((row: any) => row.projection_id === "sprint-work-items" && /^[a-f0-9]{64}$/.test(row.source_version_id)), true);
  assert.deepEqual(run.state.decisions["approve-rollover"]!.bound, [
    { work_item_id: "item-a", expected_version: "v1", changes: { sprint: "test-two" } },
    { work_item_id: "item-c", expected_version: "v1", changes: { sprint: "test-two" } },
  ]);
  const events = await h.control.listEvents(run.runId);
  assert.deepEqual(await h.engine().advance(run.runId), run);
  assert.deepEqual(await h.control.listEvents(run.runId), events);
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 5);
  assert.equal(h.calls.filter((call) => call.capability === "work-item.batch-update").length, 0);
});

test("ordinary retro rendering treats observed labels as data and never invents a link", async () => {
  const h = engineFixture();
  h.items[0]!.values.title = "<!channel> *Critical*";
  let run = await openParityClose(h);
  run = await wakeParity(h, run.runId, "2030-01-04T15:20:00.000Z");
  run = await wakeParity(h, run.runId, "2030-01-04T16:00:00.000Z");
  assert.equal(run.state.blocked, undefined);
  const retro = h.calls.find((call) => call.context.stepId === "retro")!;
  assert.ok(retro.input.content.includes("[&lt;!channel&gt; \\*Critical\\*](https://example.test/items/1)"));
  assert.doesNotMatch(retro.input.content, /<!channel>/);
  assert.deepEqual((run.state.steps["close-view"]!.output as any).open_work_items, [{ work_item_id: "item-1", provider_version: "v1" }]);
  await h.engine().advance(run.runId);
  assert.equal(h.calls.filter((call) => call.context.stepId === "retro").length, 1);
});

test("close presentation accepts missing display fields but rejects unsafe links and non-string titles", async () => {
  const item = { work_item_id: "card", provider_version: "v1", status: "Working", assignee_ids: [] };
  const input = { participants: [], submissions: [], work_items: [{ record_id: "card", values: item }],
    closed_statuses: ["Done"], cutoff: "2030-01-04T16:00:00Z", thread_reference: "test-thread" };
  assert.equal((await execute("close-classification", input)).open_items_text, "- card");
  const withTitle = { ...input, work_items: [{ record_id: "card", values: { ...item, title: "Observed title" } }] };
  assert.equal((await execute("close-classification", withTitle)).open_items_text, "- Observed title");
  for (const url of ["javascript:alert(1)", "http://example.test/card", "https://example.test/a)<!channel>", "https://example.test/a\nother"]) {
    await assert.rejects(execute("close-classification", { ...input, work_items: [{ record_id: "card", values: { ...item, url } }] }), /url|pattern/);
  }
  await assert.rejects(execute("close-classification", { ...input, work_items: [{ record_id: "card", values: { ...item, title: 42 } }] }), /title|string/);
});
