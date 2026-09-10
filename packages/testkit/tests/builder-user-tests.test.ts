import assert from "node:assert/strict";
import { test } from "node:test";
import { builderFunctionalFixture } from "../builder-functional-fixture.ts";
import { prepareBuilderTestSession, builderTestResultDigest, type BuilderTestSession } from "../../runtime/builder/functional-tests.ts";
import { createBuilderFunctionalTestIntegration, type BuilderTestControl } from "../../runtime/builder/test-integration.ts";
import { builderSelectionKey, builderConversationKey, builderDecisionKey, rememberBuilderRequest, selectBuilderRequest, type BuilderRequestReference } from "../../runtime/builder/experience.ts";
import { builderResultPresentation } from "../../runtime/builder/presentation.ts";
import { discardBuilder } from "../../runtime/builder/discard.ts";
import { parseBuilderTurnIntent, assertBuilderDevelopmentIntent } from "../../runtime/builder/turn-intent.ts";
import { readBuilderImages } from "../../runtime/builder/attachments.ts";
import { discardGitHubProposal, type GitHubReleaseClient } from "../../connectors/github-release.ts";
import type { BuilderJob } from "../../state-store/builder-jobs.ts";

function control() {
  const values = new Map<string, unknown>(), locks = new Set<string>();
  const state: BuilderTestControl<string> = {
    get: async <T>(key: string) => structuredClone(values.get(key) ?? null) as T | null,
    set: async (key, value) => { values.set(key, structuredClone(value)); },
    delete: async key => { values.delete(key); },
    setIfNotExists: async (key, value) => { if (values.has(key)) return false; values.set(key, structuredClone(value)); return true; },
    acquireLock: async key => { if (locks.has(key)) return null; locks.add(key); return key; },
    releaseLock: async key => { locks.delete(key); },
  };
  return { state, values };
}

test("selection is per company/user, new requests win immediately, and late older completion cannot steal it", async () => {
  const { state } = control();
  const job = (id: string, createdAt: string, actor = "alice", instanceId = "example") => ({ jobId: id, objective: id, sourceConversationKey: id, createdAt, requesterPrincipal: actor, instanceId, state: "published" }) as BuilderJob;
  const older = job("old", "2026-09-09T09:00:00Z"), newer = job("new", "2026-09-09T10:00:00Z");
  await rememberBuilderRequest(state, older); await rememberBuilderRequest(state, newer); await rememberBuilderRequest(state, older);
  assert.equal((await state.get<BuilderRequestReference>(builderSelectionKey("example", "alice")))?.jobId, "new");
  await rememberBuilderRequest(state, job("bob-test", "2026-09-09T11:00:00Z", "bob"));
  await rememberBuilderRequest(state, job("other-company", "2026-09-09T12:00:00Z", "alice", "another"));
  assert.equal((await state.get<BuilderRequestReference>(builderSelectionKey("example", "alice")))?.jobId, "new");
  await selectBuilderRequest(state, "example", "alice", older);
  assert.equal((await state.get<BuilderRequestReference>(builderSelectionKey("example", "alice")))?.jobId, "old");
  await assert.rejects(selectBuilderRequest(state, "example", "bob", older));
  await assert.rejects(selectBuilderRequest(state, "another", "alice", older));
});

test("Core routes independent users and fresh threads through a non-Slack test surface without activation clicks", async () => {
  const f = builderFunctionalFixture(), { state } = control();
  try {
    const jobs = new Map<string, BuilderJob>(), calls: { job: string; history: number; prompt: string }[] = [], posts: { conversation: string; content: unknown }[] = [];
    const resource = { id: "test-conversation", capability: "communication.message.publish", match: { destination_binding: "test-room" } };
    async function build(id: string, actor: string, hour: string) {
      const job = structuredClone(f.job) as any;
      Object.assign(job, { jobId: id, requesterPrincipal: actor, sourceConversationKey: `chat:build-${id}`, createdAt: `2026-09-09T${hour}:00:00Z` });
      job.evidence.proposal.jobId = id;
      job.brief.brief.test = { strategy: "test-resources", targetBindings: [resource.id], execution: { kind: "agent", agentId: "test-reader", prompt: "What can you do?", interaction: "interactive" } };
      jobs.set(id, job);
      const session = prepareBuilderTestSession({ job, coreCommit: f.session.coreCommit, resources: [resource], execution: job.brief.brief.test.execution });
      await f.store.create(session);
      await f.tests.begin(session.id, f.candidate.artifactHash, `room/test/${id}`);
      await f.tests.recordResult(session.id, { artifactHash: f.candidate.artifactHash, candidateCommit: session.candidateCommit, executionDigest: session.scopeDigest, completedAt: new Date().toISOString(), summary: "Initial reply", evidence: {} });
      await state.set(builderConversationKey(`room/test/${id}`), session.id);
      await rememberBuilderRequest(state, job);
      return { job, session };
    }
    const alice = await build("alice-first", "alice", "09"), bob = await build("bob-first", "bob", "10");
    const thread = (id: string) => ({ id, subscribe: async () => {}, post: async (content: unknown) => { posts.push({ conversation: id, content }); return { id: String(posts.length), threadId: id, metadata: { dateSent: new Date() } }; } });
    const integration = createBuilderFunctionalTestIntegration({ artifact: { ...f.previous, builder: { ...f.previous.builder!, testResources: [resource] } }, tests: f.tests, state,
      chat: { thread, channel: thread, onAction() {} }, authenticatedPrincipal: (actor: string) => actor, getJob: async id => jobs.get(id),
      transport: { destination: () => ({ channel: "room/test", url: "https://chat.example/test", label: "Test" }), contains: (_binding, conversation) => conversation.startsWith("room/test/"),
        isRoot: (conversation, message) => conversation.endsWith(`/${message}`), qualify: async () => {}, permalink: async () => "https://chat.example/test" },
      compile: async () => f.candidate, assertSupported() {},
      execute: async (_artifact, session) => { calls.push({ job: session.jobId, history: session.conversation!.turns.length, prompt: session.conversation!.pending!.prompt });
        return { artifactHash: f.candidate.artifactHash, candidateCommit: session.candidateCommit, executionDigest: session.scopeDigest, completedAt: new Date().toISOString(), summary: "Candidate reply", evidence: {} }; },
      ready: { deliver: async () => {} }, fallback: { deliver: async () => {} },
    });
    const receive = (actor: string, root: string, messageId = root) => integration.receive({ conversation: `room/test/${root}`, author: actor, messageId, text: "Explain your role", occurredAt: new Date().toISOString() });
    await Promise.all([receive("alice", "a-new"), receive("bob", "b-new")]);
    assert.deepEqual(calls.map(call => [call.job, call.history]).sort(), [[alice.job.jobId, 0], [bob.job.jobId, 0]].sort());
    await receive("alice", "a-new"); assert.equal(calls.length, 2, "replaying the root does not spend again");
    await receive("bob", "a-new", "foreign"); assert.equal(calls.length, 2, "other users cannot enter a private candidate conversation");
    const next = await build("alice-second", "alice", "11");
    await receive("alice", "a-new", "followup"); assert.equal(calls.at(-1)?.job, alice.job.jobId); assert.equal(calls.at(-1)?.history, 1);
    await receive("alice", "a-later"); assert.equal(calls.at(-1)?.job, next.job.jobId); assert.equal(calls.at(-1)?.history, 0);
    const pending = { ...next.job, jobId: "alice-pending", state: "queued", createdAt: "2026-09-09T12:00:00Z" } as BuilderJob;
    jobs.set(pending.jobId, pending); await rememberBuilderRequest(state, pending);
    const before = calls.length; await receive("alice", "waiting"); assert.equal(calls.length, before);
    assert.match(JSON.stringify(posts.at(-1)), /still being prepared/);
    assert.equal(await state.get(builderConversationKey("room/test/waiting")), null, "a preparing candidate cannot bind an older version");
  } finally { f.cleanup(); }
});

test("discard retains history, blocks publication during uncertain closure, and retries the same proposal", async () => {
  const f = builderFunctionalFixture(), { state } = control();
  try {
    await f.store.create(f.session); await f.tests.begin(f.session.id, f.candidate.artifactHash, "test:thread");
    const reviewed = await f.tests.recordResult(f.session.id, { artifactHash: f.candidate.artifactHash, candidateCommit: f.session.candidateCommit, executionDigest: f.session.scopeDigest, completedAt: new Date().toISOString(), summary: "Actual answer", evidence: {} });
    let closed = false, calls = 0;
    const discard = () => discardBuilder({ job: f.job, actor: f.session.requester, state, tests: f.tests, closeProposal: async () => { calls++; if (!closed) throw new Error("Uncertain provider outcome"); return { state: "closed" }; } });
    await assert.rejects(discard());
    assert.equal((await state.get<{ kind: string }>(builderDecisionKey(f.job.jobId)))?.kind, "discarding");
    assert.notEqual((await f.store.get(f.session.id))?.stage, "discarded");
    closed = true; await discard(); await discard(); assert.equal(calls, 2);
    const retained = await f.store.get(f.session.id);
    assert.equal(retained?.stage, "discarded"); assert.equal(retained?.result?.summary, "Actual answer");
    await assert.rejects(f.tests.accept(f.session.id, { principal: f.session.requester, actionId: "old", resultDigest: builderTestResultDigest(reviewed), acceptedAt: new Date().toISOString() }));
    assert.equal(builderResultPresentation(f.job, { session: retained }).actions.length, 0);
  } finally { f.cleanup(); }
});

test("trusted GitHub discard refuses merged or changed candidates and confirms closure before success", async () => {
  const input = { repositoryId: "example/workspace", number: 42, candidateCommit: "a".repeat(40), baseCommit: "b".repeat(40) };
  let pull = { state: "open", merged: false, head: { sha: input.candidateCommit, repo: { full_name: input.repositoryId } }, base: { repo: { full_name: input.repositoryId } } }, mutations = 0;
  const client = { async request(method: string) { if (method === "PATCH") { mutations++; pull.state = "closed"; } return structuredClone(pull); } } as unknown as GitHubReleaseClient;
  pull.merged = true; await assert.rejects(discardGitHubProposal(client, input));
  pull.merged = false; pull.head.sha = "c".repeat(40); await assert.rejects(discardGitHubProposal(client, input));
  assert.equal(mutations, 0); pull.head.sha = input.candidateCommit;
  assert.equal((await discardGitHubProposal(client, input)).state, "closed");
  await discardGitHubProposal(client, input); assert.equal(mutations, 1);
});

test("questions and stale or invented development permissions fail closed", () => {
  const text = "Is this screenshot correct?";
  const question = parseBuilderTurnIntent({ kind: "question" }, "now", text);
  assert.throws(() => assertBuilderDevelopmentIntent(question, "now"));
  assert.throws(() => assertBuilderDevelopmentIntent(parseBuilderTurnIntent({ kind: "new-build", requestQuote: "Build it" }, "now", text), "now"));
  assert.throws(() => assertBuilderDevelopmentIntent({ kind: "new-build", messageId: "previous", requestQuote: "Build it" }, "now"));
  assert.throws(() => assertBuilderDevelopmentIntent(parseBuilderTurnIntent(null, "now", text), "now"));
  assert.doesNotThrow(() => assertBuilderDevelopmentIntent(parseBuilderTurnIntent({ kind: "new-build", requestQuote: "Build a report" }, "now", "Build a report"), "now"));
});

test("images use the authorized adapter reader, do not fetch arbitrary URLs, and disclose unreadable attachments", async () => {
  let reads = 0;
  const result = await readBuilderImages([
    { type: "image", mimeType: "image/png", fetchData: async () => { reads++; return new Uint8Array([1, 2, 3]); } },
    { type: "image", mimeType: "image/png", url: "https://untrusted.example/image" } as any,
    { type: "image", mimeType: "image/png", size: 10_000_000, fetchData: async () => { throw new Error("must not fetch oversized files"); } },
  ]);
  assert.equal(reads, 1); assert.equal(result.images.length, 1); assert.equal(result.notices.length, 2);
  assert.match(result.notices[0], /could not read/);
});
