import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { createPostgresConversationAttentionStore } from "../../state-postgres/conversation-attention-store.ts";
import { createPostgresConversationWorkSource } from "../../state-postgres/conversation-work-source.ts";
import { createPostgresWorkflowExecutionStore } from "../../state-postgres/workflow-store.ts";
import { EMPTY_ATTENTION, conversationReceiptKey, conversationScopeKey, type ConversationReceipt } from "../../runtime/shared-conversation.ts";
import { workflowStateFixture, WORKFLOW_STATE_NOW as now } from "../workflow-state-fixture.ts";
import { workflowAssignmentKey } from "../../runtime/workflow-engine/state-validation.ts";
const enabled = process.env.RUN_DATABASE_TESTS === "1";

test("Postgres attention and receipts survive restart, isolate users, and have one concurrent winner", { skip: !enabled }, async () => {
  const store = createPostgresConversationAttentionStore();
  const scope = { instanceId: `test-${randomUUID()}`, principal: "human:alex", surface: "messenger", accountId: "example", channelId: "inbox" };
  const receipt: ConversationReceipt = { digest: "source", plan: { reply: "Assigned", routes: [] }, concerns: [], recordedAt: now };
  const results = await Promise.all(["event-a", "event-b"].map(event => store.commit(scope, 0, { ...EMPTY_ATTENTION(), revision: 1, focus: [event] }, event, receipt)));
  assert.equal(results.filter(Boolean).length, 1);
  const event = results[0] ? "event-a" : "event-b", restarted = createPostgresConversationAttentionStore();
  assert.deepEqual((await restarted.read(scope))?.focus, [event]); assert.deepEqual(await restarted.receipt(scope, event), receipt);
  assert.equal(await restarted.receipt({ ...scope, principal: "other" }, event), undefined);
  assert.equal(await restarted.commit(scope, 0, { ...EMPTY_ATTENTION(), revision: 1 }, "stale", receipt), false);
  assert.equal(await restarted.commit(scope, 1, { ...EMPTY_ATTENTION(), revision: 2 }, event, receipt), false);
  assert.equal((await restarted.read(scope))?.revision, 1);
  // Logical expiry must not depend on an unrelated physical KV cleanup job.
  const sql = neon(process.env.DATABASE_URL!);
  await sql`update companyos.chat_values set expires_at = now() - interval '1 second'
    where key in (${conversationReceiptKey(scope, event)}, ${conversationScopeKey(scope)})`;
  assert.equal(await restarted.read(scope), undefined);
  assert.equal(await restarted.receipt(scope, event), undefined);
  assert.equal(await restarted.commit(scope, 0, { ...EMPTY_ATTENTION(), revision: 1, focus: ["fresh"] }, event, receipt), true);
  assert.deepEqual((await restarted.read(scope))?.focus, ["fresh"]);
  assert.deepEqual(await restarted.receipt(scope, event), receipt);
});

test("Postgres work lookup uses original workflow records and excludes terminal work by default", { skip: !enabled }, async () => {
  const f = workflowStateFixture(), store = createPostgresWorkflowExecutionStore();
  await store.putArtifact(f.artifact); const run = await store.create(f);
  const address = { surface: "slack", accountId: "T10001", channelId: `C${randomUUID().replaceAll("-", "").slice(0, 12)}`, threadId: "10.000001" };
  const scope = { ...address, instanceId: run.instanceId, principal: "slack:T10001:U10002" };
  const conversation = { ...address, subjectPrincipal: scope.principal }, assignmentKey = workflowAssignmentKey(run.instanceId, conversation);
  const claimed = (await store.claim({ instanceId: run.instanceId, runId: run.runId, owner: "fixture", token: randomUUID(), now, expiresAt: "2030-01-04T12:05:00.000Z" }))!;
  await store.commit({ instanceId: run.instanceId, runId: run.runId, expectedRevision: run.revision, leaseToken: claimed.lease!.token, now,
    state: run.state, event: { name: "workflow.bound", stepId: run.state.cursor! }, assignments: [{ ...conversation, instanceId: run.instanceId,
      assignmentKey, runId: run.runId, stepId: run.state.cursor!, artifactHash: run.artifactHash, expiresAt: "2030-01-05T12:00:00.000Z" }] });
  const source = createPostgresConversationWorkSource(f.artifact);
  const page = await source.search(scope, { limit: 6, query: "period-1" });
  assert.equal(page.items.length, 1); assert.equal(page.items[0]!.id, `workflow:${assignmentKey}`);
  assert.equal((await source.current(scope, address))?.id, page.items[0]!.id);
  assert.equal(await source.read({ ...scope, channelId: "other" }, page.items[0]!.id), undefined);
  await assert.rejects(source.search({ ...scope, principal: "human:unknown" }, { limit: 6 }), /recipient/);
  await store.cancel({ instanceId: run.instanceId, runId: run.runId, principal: run.subjectPrincipal, now });
  assert.equal((await source.search(scope, { limit: 6 })).items.length, 0);
  assert.equal((await source.search(scope, { limit: 6, includeClosed: true })).items[0]?.status, "cancelled");
});
