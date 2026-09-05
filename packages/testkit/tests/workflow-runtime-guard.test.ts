import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { buildCompanyOSArtifact } from "../../companyos-builder/build.ts";
import { CORE_CAPABILITY_CATALOG } from "../../capabilities/catalog.ts";
import { CapabilityEffectOutcomeUnknownError, type Connector } from "../../capabilities/contracts.ts";
import { validateWorkflowInstanceBindings } from "../../companyos-builder/instance-loader.ts";
import { CompanyOSRuntime, type ExecuteToolRequest } from "../../runtime/companyos-runtime.ts";
import { jsonDigest } from "../../runtime/canonical.ts";
import { guardWorkflowInvocation, workflowToolInput, workflowEffectKey, workflowExecutionStepId } from "../../runtime/workflow-engine/guard.ts";
import { resolveWorkflowValue, workflowItems } from "../../runtime/workflow-engine/references.ts";
import type { WorkflowInvocationContext } from "../../runtime/workflow-engine/context.ts";
import { InMemoryStateStore } from "../adapter/in-memory-state.ts";

const capabilities = ["directory.members.query", "records.query", "work-item.read", "work-item.batch-update", "communication.message.publish"];
const artifact = buildCompanyOSArtifact({
  workspaceRoot: resolve(import.meta.dirname, "../fixtures/lindenhof-studio"),
  instance: {
    version: 1, instanceId: "lindenhof-test", environment: "test", defaultAgentId: "sprint", agentBindings: [],
    bindings: capabilities.map((id) => ({ capability: id, contractVersion: CORE_CAPABILITY_CATALOG.find((c) => c.id === id)!.version, connector: "test/guard", connectorVersion: "1.0.0" })),
    workflowBindings: { directRecipients: ["jonas-owner", "lea-contributor"].map((memberId) => ({ bindingId: "sprint-direct", memberId, destinationBinding: `direct-${memberId}` })) },
  },
  coreVersion: "0.5.14", coreCommit: "1".repeat(40), workspaceCommit: "2".repeat(40), workbenchVersion: "0.1.0-experimental.15", builtAt: "2026-09-06T00:00:00.000Z",
});
const workflow = (id: string) => artifact.workflows!.find((w) => w.id === id)!;
const context = (stepId = "open-close-thread", workflowId = "friday-close"): WorkflowInvocationContext => ({
  mode: "engine", runId: "run-one", workflowId, stepId, artifactHash: artifact.artifactHash, manifestHash: workflow(workflowId).manifestHash,
  status: "running", subjectPrincipal: "slack:T10001:U10001", currentRoster: structuredClone(artifact.roster),
  steps: {}, decisions: {}, trigger: { id: "friday-close-reminder", instant: "2026-09-04T13:30:00.000Z", params: {} },
  instance: { sprint_id: "sprint-10", next_sprint_id: "sprint-11" },
});
const request = (ctx: WorkflowInvocationContext): ExecuteToolRequest => {
  const w = workflow(ctx.workflowId), step = w.steps.find((s) => s.id === ctx.stepId)!;
  return { runId: ctx.runId, stepId: workflowExecutionStepId(ctx.stepId, ctx.itemKey), agentId: w.agentId, grantId: step.tool!.grantId, subjectPrincipal: ctx.subjectPrincipal, input: workflowToolInput(artifact, w, step, ctx) };
};

/** No provider-side deduplication: only the actual Runtime and StateStore can suppress another call. */
function harness(initial = context(), state = new InMemoryStateStore()) {
  let assigned: WorkflowInvocationContext | undefined = initial;
  let receipt: "valid" | "no-thread" | "invalid" = "valid";
  const calls: Array<{ capability: string; input: unknown }> = [];
  const connector: Connector = {
    id: "test/guard", version: "1.0.0", capabilities,
    async invoke(capability, input) {
      calls.push({ capability, input: structuredClone(input) });
      if (capability === "communication.message.publish") {
        const output = receipt === "invalid" ? {} : {
          message_id: `message-${calls.length}`, destination_binding: (input as any).destination_binding,
          published_at: "2026-09-06T00:00:00.000Z", ...(receipt === "valid" ? { thread_reference: `slack:C10001:${calls.length}.000001` } : {}),
        };
        return { output, evidence: { receipt: calls.length } };
      }
      if (capability === "work-item.batch-update") return { output: { results: [{ applied: true }], complete: true }, evidence: { receipt: calls.length } };
      throw new Error(`Unexpected test Capability '${capability}'`);
    },
  };
  const runtime = () => new CompanyOSRuntime({ artifact, state, connectors: [connector], workflowContext: { read: async () => assigned } });
  return { state, calls, runtime, setContext(value: WorkflowInvocationContext | undefined) { assigned = value; }, setReceipt(value: typeof receipt) { receipt = value; } };
}

test("workflow Artifact requires a trusted reader and cannot use missing assignment to dispatch reserved effects", async () => {
  const ctx = context(), h = harness(ctx);
  const missing = new CompanyOSRuntime({ artifact, state: h.state, connectors: [] });
  await assert.rejects(missing.execute(request(ctx)), /trusted workflow context reader/);
  h.setContext(undefined);
  await assert.rejects(h.runtime().execute({ ...request(ctx), workflowContext: ctx } as ExecuteToolRequest), /reserved/);
  assert.equal(h.calls.length, 0);
});

test("model cannot select another run, step, subject, Tool, binding or message body", async () => {
  const ctx = context(), h = harness(ctx), valid = request(ctx);
  const forgeries = [
    { runId: "run-other" }, { stepId: "report" }, { subjectPrincipal: "slack:T10001:U10002" },
    { grantId: "oregano:work-items/batch-update", input: { resource_binding: "sprint-board", updates: [] } },
    { input: { ...(valid.input as object), destination_binding: "other-channel" } },
    { input: { ...(valid.input as object), content: "Unreviewed content" } },
  ];
  for (const forgery of forgeries) await assert.rejects(h.runtime().execute({ ...valid, ...forgery }), /trusted|subject|outside|differs/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.state.effects.size, 0);
});

test("terminal, mismatched and waiting conversation assignments fail closed", async () => {
  const ctx = context(), h = harness(ctx);
  for (const change of [{ status: "cancelled" }, { status: "failed" }, { artifactHash: "forged" }, { manifestHash: "forged" }, { mode: "conversation", status: "waiting" }]) {
    h.setContext({ ...ctx, ...change } as WorkflowInvocationContext);
    await assert.rejects(h.runtime().execute(request(ctx)), /eligible|pinned|allowlist/);
  }
  assert.equal(h.calls.length, 0);
});

test("tampered Artifact bytes cannot retain a previously accepted hash", () => {
  const changed = structuredClone(artifact);
  changed.workflows![0]!.steps[0]!.maxRisk = "R4";
  assert.throws(() => new CompanyOSRuntime({ artifact: changed, state: new InMemoryStateStore(), connectors: [] }), /pinned hash/);
});

test("restart recovers the root receipt; independent runs produce separate real effect claims", async () => {
  const ctx = context(), h = harness(ctx), firstRequest = request(ctx);
  assert.equal(Object.hasOwn(firstRequest.input as object, "thread_reference"), false);
  const first = await h.runtime().execute(firstRequest) as any;
  assert.equal(first.output.thread_reference, "slack:C10001:1.000001");
  assert.deepEqual(await h.runtime().execute(firstRequest), first);
  assert.equal(h.calls.length, 1);
  assert.equal(first.workflow.manifest_hash, ctx.manifestHash);
  assert.equal(h.state.runs.get(ctx.runId)!.workflow, "friday-close");
  assert.equal(h.state.runs.get(ctx.runId)!.workflowVersion, "5");
  const next = { ...ctx, runId: "run-two" };
  h.setContext(next);
  await h.runtime().execute(request(next));
  assert.equal(h.calls.length, 2);
  assert.equal(h.state.effects.size, 2);
});

test("concurrent deliveries do not rely on provider deduplication", async () => {
  const ctx = context(), h = harness(ctx);
  await Promise.all([h.runtime().execute(request(ctx)), h.runtime().execute(request(ctx))]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.state.effects.size, 1);
});

test("successful publication missing a required downstream thread stays succeeded and is never republished", async () => {
  const ctx = context(), h = harness(ctx); h.setReceipt("no-thread");
  await assert.rejects(h.runtime().execute(request(ctx)), /thread_reference/);
  const effect = await h.state.getEffect(workflowEffectKey(artifact, ctx));
  assert.equal(effect!.status, "succeeded");
  assert.equal((effect!.evidence as any).output.message_id, "message-1");
  await assert.rejects(h.runtime().execute(request(ctx)), /thread_reference/);
  assert.equal(h.calls.length, 1);
});

test("invalid provider effect receipt retains partial evidence as unknown and requires review", async () => {
  const ctx = context(), h = harness(ctx); h.setReceipt("invalid");
  await assert.rejects(h.runtime().execute(request(ctx)), CapabilityEffectOutcomeUnknownError);
  const effect = await h.state.getEffect(workflowEffectKey(artifact, ctx));
  assert.equal(effect!.status, "unknown");
  assert.ok((effect!.evidence as any).partial_evidence.capability_effects[0].provider_evidence);
  assert.equal((await h.runtime().execute(request(ctx)) as any).duplicate, true);
  assert.equal(h.calls.length, 1);
});

test("an audit append failure cannot turn an already completed publication into a retryable failure", async () => {
  class AuditFailureStore extends InMemoryStateStore {
    override async appendEvent(event: Parameters<InMemoryStateStore["appendEvent"]>[0]) {
      if (event.event === "tool.effect-succeeded") throw new Error("Audit unavailable");
      return super.appendEvent(event);
    }
  }
  const ctx = context(), h = harness(ctx, new AuditFailureStore());
  await assert.rejects(h.runtime().execute(request(ctx)), /Audit unavailable/);
  assert.equal((await h.state.getEffect(workflowEffectKey(artifact, ctx)))!.status, "succeeded");
  assert.ok((await h.runtime().execute(request(ctx)) as any).output.message_id);
  assert.equal(h.calls.length, 1);
});

test("changed frozen step inputs conflict with the same effect identity, while JSONB key reordering recovers", async () => {
  const ctx = context("report"); ctx.steps["open-close-thread"] = { thread_reference: "slack:C10001:1.000001" }; ctx.steps["close-view"] = { report_text: "Reviewed report" };
  const h = harness(ctx), first = request(ctx);
  const result = await h.runtime().execute(first);
  assert.deepEqual(await h.runtime().execute({ ...first, input: Object.fromEntries(Object.entries(first.input as object).reverse()) }), result);
  ctx.steps["close-view"] = { report_text: "Changed report" };
  h.setContext(ctx);
  await assert.rejects(h.runtime().execute(request(ctx)), /identity conflicts/);
  assert.equal(h.calls.length, 1);
});

test("foreach validates the whole collection before dispatch and resolves exact current recipients", async () => {
  const ctx = context("nudge-owners", "board-hygiene");
  const item = { participant_id: "jonas-owner", items_text: "Item A" };
  ctx.steps.triage = { nudges: [item, { participant_id: "lea-contributor", items_text: "Item B" }] };
  ctx.item = item; ctx.itemKey = item.participant_id;
  const h = harness(ctx);
  assert.equal((request(ctx).input as any).destination_binding, "direct-jonas-owner");
  const first = await h.runtime().execute(request(ctx));
  (ctx.steps.triage as any).nudges.reverse(); h.setContext(ctx);
  assert.deepEqual(await h.runtime().execute(request(ctx)), first);
  (ctx.steps.triage as any).nudges.push(item); h.setContext(ctx);
  await assert.rejects(h.runtime().execute(request(ctx)), /duplicate key/);
  (ctx.steps.triage as any).nudges.pop();
  ctx.currentRoster.find((member) => member.id === item.participant_id)!.status = "inactive"; h.setContext(ctx);
  await assert.rejects(h.runtime().execute(request(ctx)), /active human/);
  assert.equal(h.calls.length, 1);
});

const approvedContext = () => {
  const ctx = context("apply-rollover");
  const updates = [{ work_item_id: "10001", expected_version: "v1", changes: { sprint: "sprint-11" } }];
  ctx.steps["prepare-rollover"] = { updates, outcome: "some" };
  ctx.steps["approve-rollover"] = { bound: updates };
  ctx.decisions["approve-rollover"] = { stepId: "approve-rollover", status: "approved", boundDigest: jsonDigest(updates), approvingPrincipal: "slack:T10001:U10002", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  return ctx;
};

test("R3 dispatch uses the recorded exact human decision, not the model's claimed approver", async () => {
  const ctx = approvedContext(), h = harness(ctx), call = request(ctx);
  await h.runtime().requestApproval(call, { expiresAt: new Date(ctx.decisions["approve-rollover"]!.expiresAt) });
  await h.runtime().execute({ ...call, approvingPrincipal: "forged:model:approver" });
  assert.equal(h.calls.length, 1);
  assert.equal([...h.state.approvals.values()][0]!.subjectPrincipal, "slack:T10001:U10002");
  ctx.decisions["approve-rollover"]!.expiresAt = "2000-01-01T00:00:00.000Z"; h.setContext(ctx);
  assert.ok((await h.runtime().execute(call) as any).output.complete, "completed effect recovers after approval expiry");
  assert.equal(h.calls.length, 1);
});

test("pending, expired, stale-payload, wrong-role and inactive decisions never claim an R3 effect", async () => {
  const mutations: Array<(ctx: WorkflowInvocationContext) => void> = [
    (ctx) => { ctx.decisions = {}; },
    (ctx) => { ctx.decisions["approve-rollover"]!.status = "pending"; },
    (ctx) => { ctx.decisions["approve-rollover"]!.expiresAt = "2000-01-01T00:00:00.000Z"; },
    (ctx) => { ctx.decisions["approve-rollover"]!.boundDigest = jsonDigest([]); },
    (ctx) => { (ctx.steps["approve-rollover"] as any).bound = [{ work_item_id: "changed", expected_version: "v1", changes: {} }]; },
    (ctx) => { ctx.decisions["approve-rollover"]!.approvingPrincipal = "slack:T10001:U10001"; },
    (ctx) => { ctx.currentRoster.find((member) => member.id === "jonas-owner")!.status = "inactive"; },
  ];
  for (const mutate of mutations) {
    const ctx = approvedContext(); mutate(ctx); const h = harness(ctx);
    await assert.rejects(h.runtime().execute(request(ctx)), /decision|digest|authorized human/);
    assert.equal(h.calls.length, 0); assert.equal(h.state.effects.size, 0);
  }
});

test("references preserve typed provider data without evaluating it a second time", () => {
  const ctx = context(); ctx.steps.provider = { value: "$instance.next_sprint_id" };
  assert.equal(resolveWorkflowValue("$steps.provider.value", workflow(ctx.workflowId), ctx), "$instance.next_sprint_id");
  assert.throws(() => resolveWorkflowValue("$steps.provider.constructor", workflow(ctx.workflowId), ctx), /missing/);
  assert.notEqual(jsonDigest("1"), jsonDigest(1));
  assert.notEqual(workflowExecutionStepId("send", "1"), workflowExecutionStepId("send", 1));
  const step = workflow("board-hygiene").steps.find((step) => step.id === "nudge-owners")!;
  ctx.steps.triage = { nudges: [{ participant_id: "1" }, { participant_id: 1 }] };
  assert.equal(workflowItems(step, workflow("board-hygiene"), ctx).length, 2);
});

test("Instance recipient mappings reject missing IDs, ambiguity and shared destinations across people", () => {
  const entry = { bindingId: "direct", memberId: "one", destinationBinding: "person-one" };
  for (const entries of [[{ ...entry, memberId: undefined }], [entry, entry], [entry, { ...entry, memberId: "two" }]]) {
    assert.throws(() => validateWorkflowInstanceBindings({ directRecipients: entries } as any), /IDs|Duplicate|different members/);
  }
});


test("a malformed later foreach item blocks the first provider call", async () => {
  const ctx = context("nudge-owners", "board-hygiene");
  const first = { participant_id: "jonas-owner", items_text: "Item A" };
  ctx.steps.triage = { nudges: [first, { participant_id: "lea-contributor" }] };
  ctx.item = first; ctx.itemKey = first.participant_id;
  const h = harness(ctx);
  await assert.rejects(h.runtime().execute(request(ctx)), /items_text/);
  assert.equal(h.calls.length, 0);
});

test("a revoked dispatch claim stops before the provider", async () => {
  class RevokedStore extends InMemoryStateStore { override async markEffectDispatched() { return false; } }
  const ctx = context(), h = harness(ctx, new RevokedStore());
  await assert.rejects(h.runtime().execute(request(ctx)), /dispatch claim/);
  assert.equal(h.calls.length, 0);
});


test("guard rejects risk above the compiled step and a changed resource binding", async () => {
  const ctx = context();
  const tool = artifact.agents[0]!.tools.find((tool) => tool.contract.grantId === "oregano:communications/publish")!;
  await assert.rejects(guardWorkflowInvocation({ artifact, reader: { read: async () => ctx }, request: request(ctx), tool, risk: "R4" }), /risk exceeds/);
  const approved = approvedContext(), h = harness(approved), call = request(approved);
  await assert.rejects(h.runtime().execute({ ...call, input: { ...(call.input as object), resource_binding: "other-board" } }), /binding differs/);
  assert.equal(h.calls.length, 0);
});
