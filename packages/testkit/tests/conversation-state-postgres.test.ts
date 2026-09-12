import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { createPostgresConversationAttentionStore } from "../../state-postgres/conversation-attention-store.ts";
import { createPostgresConversationWorkSource } from "../../state-postgres/conversation-work-source.ts";
import { createPostgresWorkflowExecutionStore } from "../../state-postgres/workflow-store.ts";
import { EMPTY_ATTENTION, conversationReceiptKey, conversationScopeKey, type ConversationReceipt } from "../../runtime/shared-conversation.ts";
import { workflowStateFixture, WORKFLOW_STATE_NOW as now } from "../workflow-state-fixture.ts";
import { workflowAssignmentKey, workflowPublicationKey } from "../../runtime/workflow-engine/state-validation.ts";
import { PublishedConversationContextReader } from "../../runtime/published-conversation-context.ts";
import { sha256 } from "../../runtime/canonical.ts";
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

test("coordinator lookup omits expired publication text while retaining authorized archived work metadata", { skip: !enabled }, async () => {
  const f = workflowStateFixture(), store = createPostgresWorkflowExecutionStore();
  await store.putArtifact(f.artifact); const run = await store.create(f);
  const conversation = { surface: "slack", accountId: "T10001", channelId: `C${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    threadId: "10.000001", subjectPrincipal: "slack:T10001:U10002" };
  const scope = { ...conversation, instanceId: run.instanceId, principal: conversation.subjectPrincipal };
  const content = "Retained private publication text", format = "plain-text" as const;
  const publication = { messageId: "10.000002", content, format, publishedAt: now, sequence: 1, contentDigest: sha256({ content, format }) };
  const assignment = { ...conversation, instanceId: run.instanceId, assignmentKey: workflowAssignmentKey(run.instanceId, conversation),
    runId: run.runId, stepId: "open-close-thread", artifactHash: run.artifactHash, expiresAt: "2030-01-05T12:00:00.000Z" };
  const published = { ...assignment, assignmentKey: workflowPublicationKey(run.instanceId, conversation, publication.messageId), publication };
  const claimed = (await store.claim({ instanceId: run.instanceId, runId: run.runId, owner: "fixture", token: randomUUID(), now, expiresAt: "2030-01-04T12:05:00.000Z" }))!;
  await store.commit({ instanceId: run.instanceId, runId: run.runId, expectedRevision: run.revision, leaseToken: claimed.lease!.token, now,
    state: run.state, event: { name: "workflow.publication", stepId: published.stepId }, assignments: [assignment, published] });
  const source = createPostgresConversationWorkSource(f.artifact);
  assert.equal((await source.current(scope, conversation))?.summary, content);
  assert.equal((await source.read(scope, `workflow:${published.assignmentKey}`))?.summary, content);
  const expired = new Date(Date.now() - 1000).toISOString(), sql = neon(process.env.DATABASE_URL!);
  await sql`update companyos.workflow_thread_assignments set expires_at = ${expired}, assignment_json = ${JSON.stringify({ ...published, expiresAt: expired })}
    where instance_id = ${run.instanceId} and assignment_key = ${published.assignmentKey}`;
  const reader = new PublishedConversationContextReader({ artifact: f.artifact, store, enabledWorkflowIds: [run.workflowId],
    roster: async () => f.artifact.roster, clock: () => new Date().toISOString() });
  assert.equal(await reader.read(conversation, scope.principal), undefined);
  const current = await source.current(scope, conversation), direct = await source.read(scope, `workflow:${published.assignmentKey}`);
  assert.ok(current && direct);
  assert.equal(JSON.stringify([current, direct]).includes(content), false);
  assert.equal((direct.context as { assignment: { publication?: unknown } }).assignment.publication, undefined);
  await store.cancel({ instanceId: run.instanceId, runId: run.runId, principal: run.subjectPrincipal, now });
  const archived = await source.search(scope, { limit: 6, includeClosed: true });
  assert.equal(archived.items[0]?.status, "cancelled");
  assert.equal(archived.items[0]?.id, `workflow:${assignment.assignmentKey}`);
  assert.equal(JSON.stringify(archived).includes(content), false);
});
