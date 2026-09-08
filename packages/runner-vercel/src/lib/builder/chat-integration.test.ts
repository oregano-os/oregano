import assert from "node:assert/strict";
import { test } from "node:test";
import type { StateAdapter, Thread } from "chat";
import type { ToolSet } from "ai";
import type { CompanyOSArtifact, CompiledAgent } from "../../../../companyos-builder/types.ts";
import { InMemoryBuilderJobStore } from "../../../../testkit/adapter/in-memory-builder-jobs.ts";
import type { BuilderBrief } from "../../../../runtime/builder/brief.ts";
import { createBuilderChatIntegration } from "./chat-integration.ts";

const input: BuilderBrief = {
  version: 1, objective: "Shorten the weekly report", targetPaths: ["workflows/report.md"], newPaths: [],
  currentBehavior: "The weekly report has ten paragraphs", proposedBehavior: "The same report has three paragraphs",
  contextRefs: ["workflows/report.md"], acceptanceCriteria: ["Three paragraphs preserving decisions"], constraints: [],
  decisions: { workflow: { disposition: "change", detail: "Summarize the same input" }, approvals: { disposition: "preserve", detail: "Owner approves" }, access: { disposition: "preserve", detail: "Existing team access" } },
  test: { strategy: "simulate", scenarios: ["Synthetic report"], targetBindings: [] }, deploymentIntent: "after-acceptance", openQuestions: [],
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
  const state = { async set(key: string, value: unknown) { values.set(key, value); }, async get(key: string) { return values.get(key) ?? null; } } as unknown as StateAdapter;
  const integration = createBuilderChatIntegration({ artifact: boundArtifact, state, rosterMember: () => undefined, principal: () => "unused", createJobs: () => jobs });
  const tools = (requester = "slack:T1:U1", threadId = "slack:C1:thread") => integration.proposalTools({ agent, requester, messageId: "M1", thread: { id: threadId, async post(card: unknown) { cards.push(card); return { id: "card" }; } } as unknown as Thread });
  return { tools, jobs, cards, integration };
}

test("actual Builder chat reads the process, blocks unresolved work and starts a resolved request without another click", async () => {
  const f = fixture(); const tools = f.tools();
  assert.deepEqual((await call(tools, "builder_list_context", { query: "report" }) as { files: string[] }).files, ["workflows/report.md"]);
  await assert.rejects(call(tools, "builder_propose_change", input), /Read the current/);
  await call(tools, "builder_read_context", { path: "workflows/report.md" });
  await assert.rejects(call(tools, "builder_propose_change", { ...input, openQuestions: ["Who approves the new exception?"] }), /Clarification required/);
  assert.equal(f.cards.length, 0);
  const result = await call(tools, "builder_propose_change", input) as { jobId: string; codingJobStarted: boolean };
  assert.equal(result.codingJobStarted, true);
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
