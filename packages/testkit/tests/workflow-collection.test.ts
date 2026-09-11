import assert from "node:assert/strict";
import { test } from "node:test";
import { engineFixture, ENGINE_OPERATOR, ENGINE_OWNER } from "../workflow-engine-fixture.ts";
import { collectionFixture } from "../workflow-collection-fixture.ts";
import { sha256 } from "../../runtime/canonical.ts";
import { subjectDecisionReply, workflowDecisionMemberAllowed } from "../../runtime/workflow-engine/decision-notice.ts";

async function waiting() {
  const h = collectionFixture();
  const run = await h.engine().openOperator({ workflowId: "monday-handoff", requestId: "collection", principal: ENGINE_OPERATOR,
    fields: { sprint_id: "p1", period_start: "2030-01-07", period_end: "2030-01-11" } });
  const active = (await h.engine().advance(run.runId))!;
  assert.equal(active.state.blocked, undefined); assert.equal(active.state.cursor, "facts");
  const conversation = h.conversation("direct-jonas-owner", active.state.steps.ask!.output!);
  return { h, run: active, conversation };
}
test("collection accepts only declared facts from its exact private active human", async () => {
  const { h, run, conversation } = await waiting();
  for (const output of [{ summary: "" }, { summary: "x", unauthorized: "y" }, { summary: "x".repeat(4001) }]) {
    await assert.rejects(h.engine().collect({ principal: ENGINE_OWNER, conversation, eventId: "invalid", output: output as Record<string, string> }), /declared/);
  }
  await assert.rejects(h.engine().collect({ principal: ENGINE_OPERATOR, conversation, eventId: "wrong-human", output: { summary: "x" } }), /assignment/);
  await assert.rejects(h.engine().collect({ principal: ENGINE_OWNER, conversation: { ...conversation, threadId: "other" }, eventId: "wrong-thread", output: { summary: "x" } }), /assignment/);
  const done = await h.engine().collect({ principal: ENGINE_OWNER, conversation, eventId: "actual-facts", output: { summary: "Agreed facts" } });
  assert.equal(done.state.status, "done"); assert.deepEqual(done.state.steps.facts!.output, { summary: "Agreed facts" });
  assert.deepEqual(done.state.decisions, {});
  await assert.rejects(h.engine().collect({ principal: ENGINE_OWNER, conversation, eventId: "actual-facts", output: { summary: "replacement" } }));
  assert.deepEqual((await h.store.read(run.instanceId, run.runId))!.state.steps.facts!.output, { summary: "Agreed facts" });
});
test("collection expiry cancels without an effect or fabricated output", async () => {
  const { h, run, conversation } = await waiting();
  h.now = "2030-01-08T16:00:00.000Z";
  await assert.rejects(h.engine().collect({ principal: ENGINE_OWNER, conversation, eventId: "late", output: { summary: "x" } }), /waiting/);
  await h.engine().timers();
  assert.equal((await h.store.read(run.instanceId, run.runId))!.state.status, "cancelled");
});
test("subject confirmation cannot confer R3 approval", () => {
  const h = collectionFixture(), workflow = h.artifact.workflows!.find((entry) => entry.id === "friday-close")!;
  const step = workflow.steps.find((entry) => entry.decision)!;
  step.decision!.role = "subject"; step.decision!.recipient = "jonas-owner";
  assert.equal(workflowDecisionMemberAllowed(h.roster.find((member) => member.id === "jonas-owner")!, workflow, step), false);
});

test("repeated intake parents open only one child for the same fields", async () => {
  const base = collectionFixture(), artifact = structuredClone(base.artifact);
  const child = artifact.workflows!.find((entry) => entry.id === "monday-handoff")!;
  child.trigger = { kind: "operator" };
  const parent = artifact.workflows!.find((entry) => entry.id === "weekday-digest")!;
  const step = structuredClone(child.steps[1]!);
  delete step.collect;
  step.id = "start-child"; step.kind = "start";
  step.start = { workflowId: child.id, fields: { sprint_id: "one", period_start: "2030-01-07", period_end: "2030-01-11" } };
  parent.steps = [step]; parent.entry = step.id; parent.trigger = { kind: "operator" }; parent.instance = { key: ["trigger_id", "run_date"], fields: ["trigger_id", "run_date"] };
  for (const w of [child, parent]) { const { manifestHash, ...manifest } = w; w.manifestHash = sha256(manifest); }
  const { artifactHash, ...content } = artifact; artifact.artifactHash = sha256({ ...content, provenance: { ...content.provenance, builtAt: undefined } });
  const h = engineFixture({ artifact });
  const ids = [];
  for (const requestId of ["tick-one", "tick-two"]) {
    const opened = await h.engine().openOperator({ workflowId: parent.id, requestId, fields: {}, principal: ENGINE_OPERATOR });
    const done = (await h.engine().advance(opened.runId))!;
    assert.equal(done.state.blocked, undefined); assert.equal(done.state.status, "done");
    ids.push((done.state.steps[step.id]!.output as any).run_id);
  }
  assert.equal(ids[0], ids[1]);
  assert.equal((await h.store.list({ instanceId: artifact.instance.id, limit: 20 })).filter((run) => run.workflowId === child.id).length, 1);
});

test("short subject responses require the decision role and exact configured-language answer", () => {
  assert.equal(subjectDecisionReply("yes", "subject"), "approved");
  assert.equal(subjectDecisionReply("ja", "subject", "de-DE"), "approved");
  for (const text of ["okay", "yes maybe", "yes", "approve"]) assert.equal(subjectDecisionReply(text, "reviewer"), undefined);
  assert.equal(subjectDecisionReply("okay", "subject"), undefined);
  assert.equal(subjectDecisionReply("ja", "subject", "en"), undefined);
});
