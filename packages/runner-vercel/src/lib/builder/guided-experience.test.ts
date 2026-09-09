import assert from "node:assert/strict";
import { test } from "node:test";
import type { Author, Chat, StateAdapter } from "chat";
import { sha256 } from "../../../../runtime/canonical.ts";
import { builderFunctionalFixture } from "../../../../testkit/builder-functional-fixture.ts";
import { builderTestSessionId } from "../../../../runtime/builder/functional-tests.ts";
import type { ReleaseCandidate } from "../../../../runtime/release/contracts.ts";
import { createBuilderCardPresenter } from "./card-presenter.ts";
import { builderQueuedActionCard, builderProgressCard } from "./action-cards.ts";
import { builderFeedbackKey, createBuilderFunctionalTestIntegration } from "./functional-tests.ts";
import { createBuilderReleaseIntegration } from "./release-integration.ts";
import { builderAgentTestMessages } from "./functional-test-execution.ts";

function transport() {
  const values = new Map<string, unknown>(), handlers = new Map<string, (event: any) => Promise<void>>();
  const messages: { id: string; threadId: string; content: unknown }[] = [];
  const adapter = { async editMessage(threadId: string, id: string, content: unknown) {
    const found = messages.find((entry) => entry.id === id && entry.threadId === threadId);
    assert.ok(found, "edits must target the original card"); found.content = content;
  } };
  const thread = (id: string) => ({ id, adapter, async subscribe() {}, async post(content: unknown) {
    const message = { id: String(messages.length + 1), threadId: id, content, metadata: { dateSent: new Date() } };
    messages.push(message); return message;
  } });
  const chat = { thread, channel: () => ({ async post(content: unknown) { return thread("slack:C20002:2.0").post(content); } }),
    onAction: (name: string, handler: (event: any) => Promise<void>) => handlers.set(name, handler) } as unknown as Chat;
  const locks = new Set<string>();
  const state = { async get(key: string) { return structuredClone(values.get(key) ?? null); }, async set(key: string, value: unknown) { values.set(key, structuredClone(value)); },
    async delete(key: string) { values.delete(key); }, async setIfNotExists(key: string, value: unknown) { if (values.has(key)) return false; values.set(key, structuredClone(value)); return true; },
    async acquireLock(key: string) { if (locks.has(key)) return null; locks.add(key); return { threadId: key, token: "fixture", expiresAt: Date.now() + 120000 }; },
    async releaseLock(lock: { threadId: string }) { locks.delete(lock.threadId); } } as unknown as StateAdapter;
  return { values, handlers, messages, chat, state, thread, adapter };
}

test("one durable card advances without duplicate posts or late progress overwriting the result", async () => {
  const t = transport(), f = builderFunctionalFixture();
  try {
    const job = { ...f.job, objective: "Build a concise answer", codingAgent: { profileId: "claude-code" } } as typeof f.job;
    const show = createBuilderCardPresenter(t.chat, t.state);
    await show(job, builderQueuedActionCard(job), "queued");
    await show(job, builderQueuedActionCard(job), "queued");
    assert.equal(t.messages.length, 1);
    assert.match(JSON.stringify(t.messages), /when development starts/);
    await show(job, builderProgressCard(job, "coding"), "coding");
    assert.equal(t.messages.length, 1); assert.match(JSON.stringify(t.messages), /Claude Code is working/);
    const result = { type: "card", title: "Ready for review", children: [] } as const;
    await show(job, result as any, "result");
    await show(job, builderProgressCard(job, "checking"), "checking");
    assert.equal(t.messages.length, 1); assert.match(JSON.stringify(t.messages), /Ready for review/);
    assert.doesNotMatch(JSON.stringify(t.messages), /Checking your result/);
  } finally { f.cleanup(); }
});

test("requesting changes during an interactive test retains the next source message and closes candidate testing", async () => {
  const f = builderFunctionalFixture(), t = transport();
  try {
    await f.store.create({ ...f.session, execution: { kind: "agent", agentId: "test-reader", prompt: "What can you do?", interaction: "interactive" } });
    await f.tests.begin(f.session.id, f.candidate.artifactHash, "slack:C20002:2.0");
    await f.tests.recordResult(f.session.id, { artifactHash: f.candidate.artifactHash, candidateCommit: f.session.candidateCommit,
      executionDigest: f.session.scopeDigest, completedAt: new Date().toISOString(), summary: "A test answer", evidence: { synthetic: true } });
    const user = { userId: "U10001" } as Author;
    const integration = createBuilderFunctionalTestIntegration({ artifact: f.previous, chat: t.chat, state: t.state, tests: f.tests,
      authenticatedPrincipal: () => f.session.requester, getJob: async () => f.job, compile: async () => f.candidate,
      execute: async () => { throw new Error("Feedback must not start a test execution"); },
      ready: { async deliver() {} }, fallback: { async deliver() { assert.fail("unexpected fallback"); } },
    });
    integration.registerHandlers();
    const event = { thread: t.thread(f.session.sourceConversation), value: f.session.id, user };
    await t.handlers.get("companyos.builder.test.changes")!(event);
    await t.handlers.get("companyos.builder.test.changes")!(event);
    assert.equal((await f.store.get(f.session.id))?.stage, "feedback-pending");
    await assert.rejects(() => f.tests.finish(f.session.id, f.session.requester));
    await assert.rejects(() => f.tests.beginTurn(f.session.id, f.session.requester, "late-question", "Continue?"));
    assert.equal(await integration.receive({ conversation: f.session.sourceConversation, author: user, messageId: "feedback",
      text: "Add a concrete example to the second point.", occurredAt: new Date().toISOString() }), false);
    const revised = await f.store.get(f.session.id);
    assert.equal(revised?.stage, "changes-requested");
    assert.equal(revised?.feedback?.text, "Add a concrete example to the second point.");
    assert.deepEqual(t.values.get(builderFeedbackKey(f.session.sourceConversation, f.session.requester)), revised);
    await assert.rejects(() => f.tests.releaseEvidence(f.job, false), /no current/);
  } finally { f.cleanup(); }
});

test("interactive candidate chat, result card, restart and exact Go live acceptance form one complete loop", async () => {
  const f = builderFunctionalFixture(), t = transport();
  try {
    const job = { ...structuredClone(f.job), codingAgent: { profileId: "claude-code" } } as typeof f.job;
    (job.brief!.brief.test as any).execution = { kind: "agent", agentId: "test-reader", prompt: "What can you do?", interaction: "interactive" };
    const id = builderTestSessionId(job), actor = job.requesterPrincipal, accepted: ReleaseCandidate[] = [], histories: unknown[] = [];
    const artifact = { ...f.previous, builder: { ...f.previous.builder!, testResources: f.resources }, connectors: [{ id: "slack", connector: "oregano/slack-communication", connectorVersion: "0.1.0",
      configuration: { destinations: [{ id: "test-channel", kind: "channel", channel_id: "C20002", account_id: "T10001" }] } }] };
    const principal = (author: Author) => author.userId === "U10001" ? actor : "slack:T10001:OTHER";
    const present = createBuilderCardPresenter(t.chat, t.state);
    const release = createBuilderReleaseIntegration({ chat: t.chat, state: t.state, present, authenticatedPrincipal: principal,
      getTestSession: () => f.store.get(id), fallback: { async deliver() { assert.fail("no separate fallback card expected"); } },
      async prepareCandidate() {
        const evidence = await f.tests.releaseEvidence(job, false);
        return { version: 1, id: job.jobId, instanceId: job.instanceId, repositoryId: job.repositoryId, targetBranch: "main", baseCommit: job.baseCommit,
          candidateCommit: evidence.session.candidateCommit, candidateTree: "c".repeat(40), coreCommit: "d".repeat(40), configurationDigest: "1".repeat(64), policyDigest: "2".repeat(64),
          diffDigest: "3".repeat(64), checksDigest: "4".repeat(64), previousArtifactHash: "5".repeat(64), requester: actor, sourceConversation: job.sourceConversationKey,
          requiredChecks: ["companyos"], changeClass: "behavior", functionalTestDigest: evidence.digest } as ReleaseCandidate;
      },
      beforeAccept: async (candidate, who, actionId) => {
        const evidence = await f.tests.releaseEvidence(job, false);
        assert.equal(candidate.functionalTestDigest, evidence.digest);
        await f.tests.accept(id, { principal: who, actionId, resultDigest: evidence.digest, acceptedAt: new Date().toISOString() });
      },
      coordinator: { async accept(candidate, who) { accepted.push(candidate); return { id: "release", candidate, candidateDigest: sha256(candidate), acceptedBy: who,
        acceptedAt: new Date().toISOString(), stage: "approved", revision: 0, updatedAt: new Date().toISOString() }; }, async rollback() { throw new Error("unused"); } },
    });
    const integration = createBuilderFunctionalTestIntegration({ artifact, chat: t.chat, state: t.state, tests: f.tests, getJob: async () => job,
      authenticatedPrincipal: principal, compile: async () => f.candidate, present,
      execute: async (_artifact, session) => { const messages = builderAgentTestMessages(session); histories.push(messages);
        return { artifactHash: f.candidate.artifactHash, candidateCommit: f.candidate.provenance.workspaceCommit, executionDigest: session.scopeDigest,
          completedAt: new Date().toISOString(), summary: `Answer ${histories.length}`, evidence: { synthetic: true } }; },
      ready: release.notifier, fallback: { async deliver() { assert.fail("unexpected fallback"); } },
      transport: { async qualify() {}, async permalink() { return "https://example.slack.com/archives/C20002/p2000000"; } },
    });
    release.registerHandlers(); integration.registerHandlers();
    await integration.notifier.deliver(job);
    await integration.notifier.deliver(job);
    const sourceCards = () => t.messages.filter((message) => message.threadId === job.sourceConversationKey);
    assert.equal(histories.length, 1); assert.equal(sourceCards().length, 1);
    assert.match(JSON.stringify(sourceCards()), /Finish test/); assert.doesNotMatch(JSON.stringify(sourceCards()), /Go live/);
    const user = { userId: "U10001" } as Author;
    await integration.receive({ conversation: "slack:C20002:2.0", author: { userId: "other" } as Author, messageId: "foreign", text: "Private?", occurredAt: new Date().toISOString() });
    assert.equal(histories.length, 1);
    const message = { conversation: "slack:C20002:2.0", author: user, messageId: "follow-up", text: "Explain your second point", occurredAt: new Date().toISOString() };
    await integration.receive(message); await integration.receive(message);
    assert.equal(histories.length, 2); assert.deepEqual(histories[1], [{ role: "user", content: "What can you do?" }, { role: "assistant", content: "Answer 1" }, { role: "user", content: message.text }]);
    const event = (value: string) => ({ thread: t.thread(job.sourceConversationKey), threadId: job.sourceConversationKey, adapter: t.adapter, user, value, messageId: sourceCards()[0].id });
    await t.handlers.get("companyos.builder.test.finish")!(event(id));
    assert.equal(sourceCards().length, 1); assert.match(JSON.stringify(sourceCards()), /Request changes/); assert.match(JSON.stringify(sourceCards()), /Go live/);
    const oldToken = [...t.values.keys()].find((key) => key.startsWith("builder-release-candidate:"))!.slice("builder-release-candidate:".length);
    await t.handlers.get("companyos.builder.test.restart")!(event(id));
    await t.handlers.get("companyos.builder.release")!(event(oldToken));
    assert.equal(accepted.length, 0);
    await integration.receive({ ...message, messageId: "fresh-question", text: "Give me another example" });
    assert.deepEqual(histories[2], [{ role: "user", content: "Give me another example" }]);
    await t.handlers.get("companyos.builder.test.finish")!(event(id));
    const newToken = [...t.values.keys()].filter((key) => key.startsWith("builder-release-candidate:")).at(-1)!.slice("builder-release-candidate:".length);
    assert.notEqual(newToken, oldToken);
    await t.handlers.get("companyos.builder.release")!(event(newToken));
    assert.equal(accepted.length, 1); assert.equal((await f.store.get(id))?.stage, "accepted");
  } finally { f.cleanup(); }
});
