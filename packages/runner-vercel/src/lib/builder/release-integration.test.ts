import assert from "node:assert/strict";
import { test } from "node:test";
import type { Author, Chat, StateAdapter } from "chat";
import type { BuilderJob } from "../../../../state-store/builder-jobs.ts";
import type { ReleaseCandidate } from "../../../../runtime/release/contracts.ts";
import type { ReleaseRun } from "../../../../state-store/release-runs.ts";
import { sha256 } from "../../../../runtime/canonical.ts";
import { createBuilderReleaseIntegration, releaseStatusCard } from "./release-integration.ts";

const candidate: ReleaseCandidate = { version: 1, id: "change", instanceId: "acme", repositoryId: "acme/workspace", targetBranch: "main", baseCommit: "a".repeat(40), candidateCommit: "b".repeat(40), candidateTree: "c".repeat(40), coreCommit: "d".repeat(40), configurationDigest: "1".repeat(64), policyDigest: "2".repeat(64), diffDigest: "3".repeat(64), checksDigest: "4".repeat(64), previousArtifactHash: "5".repeat(64), requester: "slack:T1:U1", sourceConversation: "slack:C1:thread", requiredChecks: ["companyos"], changeClass: "behavior" };
const job = { state: "published", instanceId: candidate.instanceId, repositoryId: candidate.repositoryId, baseCommit: candidate.baseCommit, requesterPrincipal: candidate.requester, sourceConversationKey: candidate.sourceConversation, brief: { brief: { deploymentIntent: "after-acceptance", proposedBehavior: "The report starts with a short summary.", acceptanceCriteria: ["Summary precedes tickets"] } }, evidence: { proposal: { proposalCommit: candidate.candidateCommit } } } as unknown as BuilderJob;
function fixture(prepared: ReleaseCandidate | Error = candidate) {
  const values = new Map<string, unknown>(); const messages: unknown[] = []; const accepted: unknown[] = []; const handlers = new Map<string, (event: any) => Promise<void>>();
  let fallbacks = 0;
  const thread = { id: candidate.sourceConversation, async post(card: unknown) { messages.push(card); }, adapter: { async editMessage(_thread: string, _id: string, card: unknown) { messages.push(card); } } };
  const run: ReleaseRun = { id: "release", candidate, candidateDigest: sha256(candidate), acceptedBy: candidate.requester, acceptedAt: new Date().toISOString(), stage: "approved", revision: 0, updatedAt: new Date().toISOString() };
  const integration = createBuilderReleaseIntegration({
    chat: { thread: () => thread, onAction: (id: string, callback: (event: any) => Promise<void>) => { handlers.set(id, callback); } } as unknown as Pick<Chat, "thread" | "onAction">,
    state: { async set(key: string, value: unknown) { values.set(key, value); }, async get(key: string) { return values.get(key) ?? null; } } as Pick<StateAdapter, "get" | "set">,
    coordinator: { async accept(value, actor, digest) { accepted.push({ value, actor, digest }); return run; }, async rollback() { return run; } },
    authenticatedPrincipal: (author: Author) => author.userId === "U1" ? candidate.requester : undefined,
    async prepareCandidate() { if (prepared instanceof Error) throw prepared; return prepared; }, fallback: { async deliver() { fallbacks++; } },
  });
  const click = async (threadId = thread.id, userId = "U1") => {
    const key = [...values.keys()][0];
    await handlers.get("companyos.builder.release")!({ thread: { ...thread, id: threadId }, threadId, value: key.slice("builder-release-candidate:".length), user: { userId }, adapter: thread.adapter, messageId: "card" });
  };
  return { integration, handlers, values, thread, click, messages, accepted, run, fallbacks: () => fallbacks };
}

test("qualified Chat release binding accepts one exact published result under the authenticated actor", async () => {
  const f = fixture(); f.integration.registerHandlers(); await f.integration.notifier.deliver(job);
  assert.match(JSON.stringify(f.messages), /Accept and make live/);
  await f.click();
  assert.deepEqual(f.accepted, [{ value: candidate, actor: candidate.requester, digest: sha256(candidate) }]);
  assert.doesNotMatch(JSON.stringify(f.messages), /This exact change is live/);
  await f.integration.notify({ ...f.run, stage: "live" });
  assert.match(JSON.stringify(f.messages), /This exact change is live/);
});

test("a live action cannot cross conversations or use an unknown chat identity", async () => {
  const f = fixture(); f.integration.registerHandlers(); await f.integration.notifier.deliver(job);
  await f.click("slack:C2:thread"); await f.click(candidate.sourceConversation, "unknown");
  assert.equal(f.accepted.length, 0);
});

test("prepare-only results use the draft path and mismatched provider candidates cannot create live actions", async () => {
  const f = fixture();
  await f.integration.notifier.deliver({ ...job, brief: undefined });
  assert.equal(f.fallbacks(), 1); assert.equal(f.messages.length, 0);
  const g = fixture({ ...candidate, candidateCommit: "f".repeat(40) });
  await assert.rejects(g.integration.notifier.deliver(job), /published Builder result/);
  assert.equal(g.messages.length, 0);
  assert.match(JSON.stringify(releaseStatusCard({ ...f.run, stage: "failed" })), /production may already have changed/);
});


test("pending hosted checks deliver the proposal and an authenticated read-only retry without leaking provider errors", async () => {
  const f = fixture(new Error("private-provider-token")); f.integration.registerHandlers();
  await f.integration.notifier.deliver(job);
  assert.equal(f.fallbacks(), 1);
  assert.match(JSON.stringify(f.messages), /Check readiness/);
  assert.doesNotMatch(JSON.stringify(f.messages), /private-provider-token|Accept and make live/);
  const token = [...f.values.keys()][0]!.slice("builder-release-readiness:".length);
  const event = { thread: f.thread, value: token, user: { userId: "U1" } };
  await f.handlers.get("companyos.builder.release.refresh")!({ ...event, thread: { ...f.thread, id: "another-conversation" } });
  assert.equal(f.fallbacks(), 1);
  await f.handlers.get("companyos.builder.release.refresh")!(event);
  assert.equal(f.fallbacks(), 2); assert.equal(f.accepted.length, 0);
});
