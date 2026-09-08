import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { engineFixture, ENGINE_OPERATOR, ENGINE_OWNER } from "../workflow-engine-fixture.ts";
import { parseWorkflowOperatorRequest } from "../../runner-vercel/src/lib/workflow-http.ts";

const opening = (variant: number, requestId = randomUUID()) => {
  const action = parseWorkflowOperatorRequest({ action: "open", workflowId: "weekday-digest", requestId, fields: {}, triggerVariant: variant });
  assert.equal(action.action, "open");
  if (action.action !== "open") throw new Error("Expected an opening");
  return { ...action, principal: ENGINE_OPERATOR };
};

test("hosted manual openings select either declared branch through the actual engine", async () => {
  for (const variant of [0, 1]) {
    const h = engineFixture();
    const opened = await h.engine().openOperator(opening(variant));
    assert.equal(opened.trigger.instant, h.now, "selection never uses the scheduled occurrence as a clock override");
    assert.deepEqual(opened.trigger.params, { readiness: variant === 1 });
    const result = await h.engine().advance(opened.runId);
    assert.ok(result);
    assert.equal(result.state.status, "done", JSON.stringify(result.state));
    assert.equal(Boolean(result.state.steps["planning-candidates"]), variant === 1);
    assert.equal(h.calls.filter((call) => call.capability === "communication.message.publish").length, 1);
    assert.equal(h.calls.some((call) => call.capability === "work-item.batch-update"), false);
  }
});

test("selected parameters retain idempotent opening identity across reconstruction and clock changes", async () => {
  const h = engineFixture(), request = opening(1);
  const first = await h.engine().openOperator(request);
  h.now = "2030-01-07T09:00:00.000Z";
  assert.deepEqual(await h.engine().openOperator(request), first);
  await assert.rejects(h.engine().openOperator({ ...request, triggerVariant: 0 }), /conflicts with changed input/);
  assert.equal((await h.store.list({ instanceId: h.artifact.instance.id, limit: 20 })).length, 1);
  assert.equal(h.calls.length, 0);
});

test("manual trigger selection preserves weekend delivery waits and actual opening time", async () => {
  const h = engineFixture(); h.now = "2030-01-06T10:00:00.000Z";
  const opened = await h.engine().openOperator(opening(1));
  const result = await h.engine().advance(opened.runId);
  assert.ok(result);
  assert.equal(opened.trigger.instant, h.now);
  assert.equal(result.state.status, "waiting");
  assert.equal(result.state.wait?.dueAt, "2030-01-07T07:00:00.000Z");
  assert.equal(h.calls.some((call) => call.capability === "communication.message.publish"), false);
  assert.deepEqual(result.trigger.params, { readiness: true });
});

test("invalid variants and unauthorized operators cannot create a run or provider effect", async () => {
  const h = engineFixture(), request = opening(1);
  for (const triggerVariant of [-1, 0.5, 2, 1000, NaN, "1", null]) {
    await assert.rejects(h.engine().openOperator({ ...request, triggerVariant } as any), /trigger variant/);
  }
  await assert.rejects(h.engine().openOperator({ ...request, principal: ENGINE_OWNER }), /authorized human operator/);
  await assert.rejects(h.engine().openOperator({ ...request, params: { readiness: true } }), /conflicting/);
  await assert.rejects(h.engine().openOperator({ ...request, workflowId: "monday-handoff" }), /variant is absent/);
  assert.equal((await h.store.list({ instanceId: h.artifact.instance.id, limit: 20 })).length, 0);
  assert.equal(h.calls.length, 0);
});

test("the strict hosted selector cannot carry parameters, clocks, principals or a scheduled override", () => {
  const base = { action: "open", workflowId: "weekday-digest", requestId: "request", fields: {} };
  for (const triggerVariant of [-1, 0.1, 1000, NaN, "1", null, {}, []]) {
    assert.throws(() => parseWorkflowOperatorRequest({ ...base, triggerVariant }), /trigger variant/);
  }
  for (const extra of [{ params: { readiness: true } }, { instant: "2030-01-09T16:30:00.000Z" }, { principal: ENGINE_OWNER }]) {
    assert.throws(() => parseWorkflowOperatorRequest({ ...base, triggerVariant: 1, ...extra }), /Unsupported/);
  }
  assert.throws(() => parseWorkflowOperatorRequest({ action: "schedule", workflowId: "weekday-digest", fields: {}, instant: "2030-01-09T16:30:00.000Z", triggerVariant: 1 }), /Unsupported/);
  assert.deepEqual(parseWorkflowOperatorRequest(base), base);
});
