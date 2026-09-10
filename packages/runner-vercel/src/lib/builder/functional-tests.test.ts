import assert from "node:assert/strict";
import { test } from "node:test";
import type { Chat, StateAdapter } from "chat";
import { builderFunctionalFixture } from "../../../../testkit/builder-functional-fixture.ts";
import { InMemoryWorkflowExecutionStore } from "../../../../runtime/workflow-engine/memory-store.ts";
import { InMemoryDurableTimerStore } from "../../../../runtime/memory-durable-timers.ts";
import { executeBuilderFunctionalTest, assertBuilderTestSupported } from "./functional-test-execution.ts";
import { createBuilderFunctionalTestIntegration, createSlackBuilderTestSurface } from "./functional-tests.ts";

test("the connected executor runs the unmerged candidate through the real engine and preserves production", async () => {
  const f = builderFunctionalFixture();
  try {
    const workflowStore = new InMemoryWorkflowExecutionStore(), calls: unknown[] = [];
    await workflowStore.putArtifact(f.candidate);
    await f.store.create(f.session);
    const session = await f.tests.begin(f.session.id, f.candidate.artifactHash, "slack:C20002:2.0");
    const result = await executeBuilderFunctionalTest({ artifact: f.candidate, production: f.previous, session, store: f.store, chat: {} as Chat,
      workflowExecution: { store: workflowStore, control: workflowStore.control, timers: new InMemoryDurableTimerStore(), connectors: [{
        id: "test/engine", version: "1.0.0", capabilities: ["work-item.comment"], async invoke(_capability, input) {
          calls.push(input);
          return { output: { comment_id: "synthetic-comment", work_item_id: "42", provider_version: "v2", created_at: new Date().toISOString() },
            evidence: { provider: "synthetic", comment_id: "synthetic-comment" } };
        },
      }] },
    });
    assert.equal(result.candidateCommit, f.candidate.provenance.workspaceCommit);
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as { body: string }).body, "Summary first. Then the task list.");
    assert.match(JSON.stringify(f.previous.workflows?.find((workflow) => workflow.id === "builder-proof")), /Original report/);
    assert.doesNotMatch(JSON.stringify(f.previous.workflows?.find((workflow) => workflow.id === "builder-proof")), /Summary first/);
    await f.tests.recordResult(session.id, result);
    await assert.rejects(() => f.tests.releaseEvidence(f.job, true), /no current/);
  } finally { f.cleanup(); }
});

test("unsupported timed workflows are refused before any effect or claim of test completion", () => {
  const f = builderFunctionalFixture();
  try { assert.throws(() => assertBuilderTestSupported(f.candidate, { ...f.session, execution: { kind: "workflow", workflowId: "friday-close", fields: {} } }), /operator-opened/); }
  finally { f.cleanup(); }
});

test("the chat presents the completed candidate test before release and feedback disables the old live action", async () => {
  const f = builderFunctionalFixture();
  try {
    // Synthetic transport and model boundaries; the controller and retained lifecycle are real.
    (f.job as any).objective = "Shorten the report";
    const values = new Map<string, unknown>(), handlers = new Map<string, (event: any) => Promise<void>>(), order: string[] = [];
    let executions = 0;
    const thread = (id: string) => ({ id, async subscribe() {}, async post(content: unknown) {
      order.push(JSON.stringify(content)); return { id: "3.0", threadId: id, metadata: { dateSent: new Date() } };
    } });
    const chat = { thread, channel: () => ({ async post(content: unknown) { order.push(JSON.stringify(content)); return { id: "2.0", threadId: "slack:C20002:2.0" }; } }),
      onAction: (id: string, handler: (event: any) => Promise<void>) => { handlers.set(id, handler); } } as unknown as Chat;
    const state = { async get(key: string) { return structuredClone(values.get(key) ?? null); }, async set(key: string, value: unknown) { values.set(key, structuredClone(value)); },
      async delete(key: string) { values.delete(key); }, async setIfNotExists(key: string, value: unknown) { if (values.has(key)) return false; values.set(key, value); return true; },
      async acquireLock() { return { threadId: "lock", token: "token", expiresAt: Date.now() + 300000 }; }, async releaseLock() {} } as unknown as StateAdapter;
    const artifact = { ...f.previous, builder: { ...f.previous.builder!, testResources: f.resources }, connectors: [{ id: "slack", connector: "oregano/slack-communication", connectorVersion: "0.1.0",
      configuration: { destinations: [{ id: "test-channel", kind: "channel", channel_id: "C20002", account_id: "T10001" }] } }] };
    const integration = createBuilderFunctionalTestIntegration({ artifact, chat, state, tests: f.tests, getJob: async () => f.job,
      authenticatedPrincipal: (author) => author.userId === "U10001" ? f.session.requester : undefined,
      compile: async () => { order.push("compile-candidate"); return f.candidate; },
      execute: async (candidate, session) => { executions++; order.push("execute-candidate"); return { artifactHash: candidate.artifactHash, candidateCommit: candidate.provenance.workspaceCommit,
        executionDigest: session.scopeDigest, completedAt: new Date().toISOString(), summary: "Synthetic provider result", evidence: { synthetic: true } }; },
      ready: { async deliver(job) { if ((await f.store.get(f.session.id))?.stage === "reviewable") { await f.tests.releaseEvidence(job, false); order.push("offer-merge-and-live"); } } },
      fallback: { async deliver() { order.push("fallback"); } },
      transport: { async qualify() {}, async permalink() { return "https://example.slack.com/archives/C20002/p2000000"; } },
    });
    integration.registerHandlers();
    await integration.notifier.deliver(f.job);
    assert.ok(order.indexOf("execute-candidate") < order.indexOf("offer-merge-and-live"));
    await integration.notifier.deliver(f.job);
    assert.equal(executions, 1, "notification retries cannot re-run tests");
    await handlers.get("companyos.builder.test.changes")!({ thread: thread(f.session.sourceConversation), value: f.session.id, user: { userId: "U10001" } });
    await assert.rejects(() => f.tests.releaseEvidence(f.job, false), /no current/);
    await integration.receive({ conversation: f.session.sourceConversation, author: { userId: "U10001" } as any, messageId: "human-feedback", text: "Make the summary shorter.", occurredAt: new Date().toISOString() });
    assert.equal((await f.store.get(f.session.id))?.stage, "feedback-pending");
    assert.equal((await f.store.get(f.session.id))?.feedback, undefined, "Only an explicitly classified revision may consume feedback; receive never infers development.");
  } finally { f.cleanup(); }
});


test("an invalid test destination is refused during preparation without breaking ordinary channel routing", () => {
  const f = builderFunctionalFixture();
  try {
    const surface = createSlackBuilderTestSurface({ ...f.previous, connectors: [] }, {} as Chat);
    assert.equal(surface.contains("missing-test-channel", "slack:ORDINARY:1.0"), false);
    assert.throws(() => surface.destination("missing-test-channel"), /not a configured channel/);
  } finally { f.cleanup(); }
});
