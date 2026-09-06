import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { engineFixture, ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";

test("ordinary handoff renders participant and item labels as data before governed publication", async () => {
  const h = engineFixture();
  h.roster.find((member) => member.id === "lea-contributor")!.name = "<@U90009> *Lea* & Co";
  h.items[0]!.values.title = "<!channel> [Injected](https://example.test/other) <https://example.test|link>";
  const opened = await h.engine().openOperator({ workflowId: "monday-handoff", requestId: randomUUID(), principal: ENGINE_OPERATOR,
    fields: { period_start: "2030-01-07", period_end: "2030-01-11" } });
  const run = (await h.engine().advance(opened.runId))!;
  assert.equal(run.state.status, "done", JSON.stringify(run.state));
  const messages = h.calls.filter((call) => call.capability === "communication.message.publish");
  assert.equal(messages.length, 1);
  const content = messages[0]!.input.content as string;
  assert.ok(content.includes("&lt;@U90009&gt; \\*Lea\\* &amp; Co"));
  assert.ok(content.includes("&lt;!channel&gt; \\[Injected\\]\\(https://example.test/other\\) &lt;https://example.test|link&gt;"));
  assert.doesNotMatch(content, /<@U90009>|<!channel>|<https:\/\/example\.test\|link>/);
  assert.ok(content.includes("](https://example.test/items/1)"));
  await h.engine().advance(opened.runId);
  assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 1);
});
