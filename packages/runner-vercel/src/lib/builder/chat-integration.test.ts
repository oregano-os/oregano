import assert from "node:assert/strict";
import { test } from "node:test";
import type { StateAdapter, Thread } from "chat";
import type { ToolSet } from "ai";
import type { CompanyOSArtifact, CompiledAgent } from "../../../../companyos-builder/types.ts";
import { InMemoryBuilderJobStore } from "../../../../testkit/adapter/in-memory-builder-jobs.ts";
import type { BuilderBrief } from "../../../../runtime/builder/brief.ts";
import { builderFunctionalFixture } from "../../../../testkit/builder-functional-fixture.ts";
import type { BuilderJobStore } from "../../../../state-store/builder-jobs.ts";
import { createBuilderChatIntegration } from "./chat-integration.ts";

const input: BuilderBrief = {
  version: 1, objective: "Shorten the weekly report", targetPaths: ["workflows/report.md"], newPaths: [],
  currentBehavior: "The weekly report has ten paragraphs", proposedBehavior: "The same report has three paragraphs",
  contextRefs: ["workflows/report.md"], acceptanceCriteria: ["Three paragraphs preserving decisions"], constraints: [],
  decisions: { workflow: { disposition: "change", detail: "Summarize the same input" }, approvals: { disposition: "preserve", detail: "Owner approves" }, access: { disposition: "preserve", detail: "Existing team access" } },
  test: { strategy: "auto", scenarios: ["Synthetic report"], targetBindings: [] }, deploymentIntent: "after-acceptance", openQuestions: [],
};
const agent = { id: "builder", materials: { "workflows/report.md": "The weekly report has ten paragraphs; owner approves." } } as unknown as CompiledAgent;
const artifact = {
  artifactHash: "a".repeat(64), instance: { id: "acme" }, provenance: { workspaceCommit: "b".repeat(40) },
  builder: { enabled: true, execution: { adapter: "testkit-memory", profile: "isolated-v1" }, codingAgent: { protocol: "acp-v1", profile: "claude-code" }, repository: { repositoryId: "acme/workspace", sourceBinding: "workspace", proposalPublisherBinding: "workspace" } },
} as CompanyOSArtifact;
const call = async (tools: ToolSet, name: string, value: unknown) => await (tools[name].execute as (value: unknown, context: unknown) => Promise<unknown>)(value, { toolCallId: "call", messages: [] });
function fixture(boundArtifact = artifact) {
  const values = new Map<string, unknown>();
  const cards: unknown[] = [];
  const jobs = new InMemoryBuilderJobStore();
  const state = { async set(key: string, value: unknown) { values.set(key, value); }, async get(key: string) { return values.get(key) ?? null; }, async acquireLock() { return { token: "lock" }; }, async releaseLock() {}, async setIfNotExists(key: string, value: unknown) { if (values.has(key)) return false; values.set(key, value); return true; } } as unknown as StateAdapter;
  const integration = createBuilderChatIntegration({ artifact: boundArtifact, state, rosterMember: () => undefined, principal: () => "unused", createJobs: () => jobs });
  const tools = (requester = "slack:T1:U1", threadId = "slack:C1:thread", messageId = "M1", kind: "new-build" | "revision" | "question" = "new-build") => integration.proposalTools({ agent, requester, messageId, intent: { kind, messageId, requestQuote: "Make the report shorter" }, thread: { id: threadId, async post(card: unknown) { cards.push(card); return { id: "card" }; } } as unknown as Thread });
  return { tools, jobs, cards, integration, values };
}

test("actual Builder chat reads the process, blocks unresolved work and starts a resolved request without another click", async () => {
  const f = fixture(); const tools = f.tools();
  assert.deepEqual((await call(tools, "builder_list_context", { query: "report" }) as { files: string[] }).files, ["workflows/report.md"]);
  await assert.rejects(call(tools, "builder_propose_change", input), /Read the current/);
  await call(tools, "builder_read_context", { path: "workflows/report.md" });
  await assert.rejects(call(tools, "builder_propose_change", { ...input, openQuestions: ["Who approves the new exception?"] }), /Clarification required/);
  assert.equal(f.cards.length, 0);
  const result = await call(tools, "builder_propose_change", input) as { jobId: string; codingJobSubmitted: boolean };
  assert.equal(result.codingJobSubmitted, true);
  const job = await f.jobs.get(result.jobId);
  assert.equal(job?.state, "queued"); assert.deepEqual(job?.brief?.brief, input);
  assert.doesNotMatch(JSON.stringify(f.cards), /companyos.builder.confirm/);
  assert.equal((await call(tools, "builder_propose_change", input) as { jobId: string }).jobId, result.jobId);
});

test("Builder read evidence cannot cross a requester, conversation or unavailable scope", async () => {
  const f = fixture();
  await call(f.tools(), "builder_read_context", { path: "workflows/report.md" });
  await assert.rejects(call(f.tools("slack:T1:U2"), "builder_propose_change", input), /Read the current/);
  await assert.rejects(call(f.tools("slack:T1:U1", "slack:C2:thread"), "builder_propose_change", input), /Read the current/);
  await assert.rejects(call(f.tools(), "builder_read_context", { path: "policies/private.md" }), /outside the Builder read scope/);
  await assert.rejects(call(f.tools(), "builder_read_context", { path: "../secret" }), /safe Workspace-relative/);
});

test("Builder can clarify before execution bindings are ready and does not pretend coding started", async () => {
  const f = fixture({ ...artifact, builder: undefined });
  await call(f.tools(), "builder_read_context", { path: "workflows/report.md" });
  assert.equal((await call(f.tools(), "builder_list_context", {}) as { codingConfigured: boolean }).codingConfigured, false);
  await assert.rejects(call(f.tools(), "builder_propose_change", input), /Instance repository and execution bindings/);
  assert.equal(f.cards.length, 0);
});

test("deferred test strategies cannot start a job merely because the brief schema recognizes them", async () => {
  const f = fixture(), tools = f.tools();
  await call(tools, "builder_read_context", { path: "workflows/report.md" });
  for (const strategy of ["simulate", "live-trial"]) await assert.rejects(call(tools, "builder_propose_change", { ...input, test: { ...input.test, strategy } }), /not available yet/);
  assert.equal(f.cards.length, 0);
});

test("questions cannot start development; another explicit request can start while the first is open", async () => {
  const f = fixture();
  const build = f.tools();
  await call(build, "builder_read_context", { path: "workflows/report.md" });
  const first = await call(build, "builder_propose_change", input) as { jobId: string };
  const question = f.tools(undefined, undefined, "M2", "question");
  assert.equal(question.builder_propose_change, undefined);
  assert.equal(question.builder_select_test, undefined);
  const existing = await call(question, "builder_read_test_result", {}) as { available: boolean; jobId: string; status: string };
  assert.equal(existing.available, true); assert.equal(existing.jobId, first.jobId); assert.equal(existing.status, "queued");
  assert.equal((await f.jobs.listForRequester("acme", "slack:T1:U1")).length, 1);
  const second = await call(f.tools(undefined, undefined, "M3"), "builder_propose_change", { ...input, objective: "Create another report" }) as { jobId: string };
  assert.notEqual(second.jobId, first.jobId);
  assert.equal((await f.jobs.get(first.jobId))?.state, "queued", "a new request does not cancel an older build");
  assert.equal((await f.jobs.listForRequester("acme", "slack:T1:U2")).length, 0);
  assert.equal((await f.jobs.listForRequester("other-company", "slack:T1:U1")).length, 0);
});

test("one current human message cannot create two builds by changing the generated brief", async () => {
  const f = fixture(), tools = f.tools();
  await call(tools, "builder_read_context", { path: "workflows/report.md" });
  const first = await call(tools, "builder_propose_change", input) as { jobId: string };
  const retry = await call(tools, "builder_propose_change", { ...input, proposedBehavior: "Different interpretation" }) as { jobId: string };
  assert.equal(retry.jobId, first.jobId);
  assert.deepEqual((await f.jobs.get(first.jobId))?.brief?.brief, input);
});

test("a revision with no existing target never enqueues a job", async () => {
  const f = fixture(), tools = f.tools(undefined, undefined, "M1", "revision");
  await call(tools, "builder_read_context", { path: "workflows/report.md" });
  await assert.rejects(call(tools, "builder_propose_change", input), /No existing build/);
  assert.equal((await f.jobs.listForRequester("acme", "slack:T1:U1")).length, 0);
});


test("a question can read an actual older test result without Request Changes or a new selection index", async () => {
  const f = builderFunctionalFixture();
  try {
    await f.store.create(f.session); await f.tests.begin(f.session.id, f.candidate.artifactHash, "test:conversation");
    await f.tests.recordResult(f.session.id, { artifactHash: f.candidate.artifactHash, candidateCommit: f.session.candidateCommit, executionDigest: f.session.scopeDigest,
      summary: "The actual candidate answer", completedAt: new Date().toISOString(), evidence: { internal: "must stay outside model context" } });
    const integration = createBuilderChatIntegration({ artifact: f.previous, state: { get: async () => null } as unknown as StateAdapter,
      rosterMember: () => undefined, principal: () => f.session.requester, createTests: () => f.tests,
      createJobs: () => ({ listForRequester: async () => [f.job] }) as unknown as BuilderJobStore });
    const tools = integration.proposalTools({ agent, requester: f.session.requester, thread: { id: f.session.sourceConversation } as Thread, messageId: "question", intent: { kind: "question", messageId: "question" } });
    const result = await call(tools, "builder_read_test_result", {});
    assert.match(JSON.stringify(result), /The actual candidate answer/);
    assert.doesNotMatch(JSON.stringify(result), /must stay outside model context/);
    assert.equal(tools.builder_propose_change, undefined);
  } finally { f.cleanup(); }
});
