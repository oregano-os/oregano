import assert from "node:assert/strict";
import { test } from "node:test";
import { LanguageModelConnector } from "../../connectors/language-model.ts";
import { LanguageGenerationError, type LanguageGenerator } from "../../language/contracts.ts";
import { readLanguageAttempts } from "../../language/attempts.ts";
import { languageCostReport, type LanguagePrice } from "../../language/costs.ts";
import { InMemoryStateStore } from "../../runtime/memory-state.ts";
import type { CompanyOSArtifact } from "../../companyos-builder/types.ts";
import type { CapabilityCallContext } from "../../capabilities/contracts.ts";
import type { ModelExecutionSelection } from "../../runner/model-execution.ts";

const path = "agents/analyst/skills/review.md";
const artifact = { instance: { id: "synthetic-instance" }, artifactHash: "a".repeat(64), provenance: { workspaceCommit: "b".repeat(40) },
  agents: [{ id: "analyst", modelTask: "document.review", materials: { [path]: "Private instruction fixture" } }] } as unknown as CompanyOSArtifact;
const context: CapabilityCallContext = { instanceId: "synthetic-instance", runId: "run-1", stepId: "review", agentId: "analyst", toolId: "company:review",
  subject: { principalId: "test:actor", principalType: "human", status: "active", groupIds: [] } };
const selection = { route: "openai-compatible", model: "compatible/synthetic", profile: "reasoning", task: "document.review" } as ModelExecutionSelection;
const usage = { ...selection, responseId: "response-1", responseModel: "synthetic", inputTokens: 1000, outputTokens: 200, reasoningTokens: 50,
  cacheReadTokens: 100, cacheWriteTokens: 50, uncachedInputTokens: 850 };
const input = { prompt_path: path, data: { text: "Private source fixture" } };
const connector = (state: InMemoryStateStore, generate: LanguageGenerator) => new LanguageModelConnector({ artifact, prompts: [{ agent_id: "analyst", path }], state, generate });
const price: LanguagePrice = { route: selection.route, model: selection.model, currency: "USD", source: "https://example.invalid/prices/2030",
  valid_from: "2020-01-01T00:00:00Z", valid_until: null, input_per_million: 2, output_per_million: 8, cache_read_per_million: 0.2, cache_write_per_million: 2.5 };

test("every paid attempt records exact run, step, binding and model before provider dispatch", async () => {
  const state = new InMemoryStateStore(); let calls = 0;
  const result = await connector(state, async request => {
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0].event, "language.attempt-prepared");
    await request.beforeDispatch!(selection);
    assert.equal(state.events[1].event, "language.attempt-dispatched");
    assert.equal([...state.effects.values()][0].status, "dispatched"); calls++;
    return { text: "Private resulting draft", evidence: { model_execution: usage, finish_reason: "stop" } };
  }).invoke("language.generate", input, context);
  assert.equal(calls, 1);
  const attempts = await readLanguageAttempts(state, [context.runId, context.runId]);
  assert.equal(attempts.length, 1); assert.equal(attempts[0].status, "succeeded");
  assert.equal(attempts[0].run_id, context.runId); assert.equal(attempts[0].step_id, context.stepId);
  assert.equal(result.evidence.attempt_id, attempts[0].attempt_id);
  assert.equal(attempts[0].evidence.artifact_hash, artifact.artifactHash);
  assert.ok(!JSON.stringify(state.events).includes("Private"));
  assert.ok(!JSON.stringify([...state.effects.values()]).includes("Private"));
  const report = languageCostReport(attempts, [price]);
  assert.equal(report.complete, true); assert.equal(report.attempts[0].basis, "estimated");
  assert.equal(report.totals.USD.estimated, (850 * 2 + 200 * 8 + 100 * 0.2 + 50 * 2.5) / 1e6);
});

test("failed partial answers retain all usage and later attempts never replace their cost", async () => {
  const state = new InMemoryStateStore(); let calls = 0;
  const generation = connector(state, async request => {
    await request.beforeDispatch!(selection); calls++;
    if (calls === 1) throw new LanguageGenerationError("Private partial output is not logged", "incomplete", { model_execution: usage, finish_reason: "length" });
    return { text: "Corrected output", evidence: { model_execution: { ...usage, responseId: "response-2" } } };
  });
  await assert.rejects(generation.invoke("language.generate", input, context), /partial/);
  await generation.invoke("language.generate", input, context);
  const attempts = await readLanguageAttempts(state, [context.runId]);
  assert.deepEqual(attempts.map(x => x.status).sort(), ["failed", "succeeded"]);
  assert.equal(new Set(attempts.map(x => x.attempt_id)).size, 2);
  assert.ok(!JSON.stringify(state.events).includes("Private"));
  assert.equal(languageCostReport(attempts, [price]).totals.USD.estimated, 2 * (850 * 2 + 200 * 8 + 100 * 0.2 + 50 * 2.5) / 1e6);
});

test("provider uncertainty and interrupted workers stay unknown, never zero-cost or silently successful", async () => {
  const state = new InMemoryStateStore();
  await assert.rejects(connector(state, async request => {
    await request.beforeDispatch!(selection);
    throw new LanguageGenerationError("Provider unavailable", "provider-error", { model_execution: { ...selection, inputTokens: null, outputTokens: null } });
  }).invoke("language.generate", input, context));
  const attempts = await readLanguageAttempts(state, [context.runId]);
  assert.equal(attempts[0].status, "unknown");
  const report = languageCostReport(attempts, [price]);
  assert.equal(report.complete, false); assert.equal(report.unknown_attempts, 1); assert.equal(report.attempts[0].amount, null);
  const id = attempts[0].attempt_id;
  state.effects.set(id, { ...state.effects.get(id), status: "dispatched", evidence: null });
  state.events.splice(2);
  assert.equal((await readLanguageAttempts(state, [context.runId]))[0].status, "unknown");
});

test("durable-state failure and expired Workflow fences block paid dispatch", async () => {
  for (const fault of ["prepare", "dispatch-event", "fence"]) {
    const state = new InMemoryStateStore(); let calls = 0;
    const append = state.appendEvent.bind(state);
    state.appendEvent = async event => {
      if ((fault === "prepare" && event.event.endsWith("prepared")) || (fault === "dispatch-event" && event.event.endsWith("dispatched"))) throw new Error("State unavailable");
      return append(event);
    };
    const ctx = fault === "fence" ? { ...context, dispatchFence: { instanceId: context.instanceId, runId: context.runId, stepId: context.stepId, leaseToken: "expired", now: "2030-01-01T00:00:00Z" } } : context;
    await assert.rejects(connector(state, async request => { await request.beforeDispatch!(selection); calls++; return { text: "Output", evidence: {} }; }).invoke("language.generate", input, ctx));
    assert.equal(calls, 0);
  }
});

test("a lost completion event recovers its usage from the effect without another paid call", async () => {
  const state = new InMemoryStateStore(); let calls = 0; const append = state.appendEvent.bind(state);
  state.appendEvent = async event => { if (event.event.endsWith("finished")) throw new Error("Event unavailable"); return append(event); };
  await assert.rejects(connector(state, async request => { await request.beforeDispatch!(selection); calls++; return { text: "Output", evidence: { model_execution: usage } }; }).invoke("language.generate", input, context));
  const attempts = await readLanguageAttempts(state, [context.runId]);
  assert.equal(attempts[0].status, "succeeded"); assert.deepEqual(attempts[0].evidence.model_execution, usage); assert.equal(calls, 1);
  assert.equal(languageCostReport(attempts, [price]).complete, true);
});

test("invalid bounded output is charged and failed, while missing dispatch evidence cannot pass", async () => {
  for (const callback of [true, false]) {
    const state = new InMemoryStateStore();
    await assert.rejects(connector(state, async request => { if (callback) await request.beforeDispatch!(selection); return { text: "x".repeat(60001), evidence: { model_execution: usage } }; }).invoke("language.generate", input, context));
    assert.equal((await readLanguageAttempts(state, [context.runId]))[0].status, callback ? "failed" : "unknown");
  }
});

test("cost reports distinguish billed, dated estimates and missing usage without double-counting reasoning", async () => {
  const state = new InMemoryStateStore();
  const generation = connector(state, async request => { await request.beforeDispatch!(selection); return { text: "Output", evidence: { model_execution: usage } }; });
  for (let i = 0; i < 3; i++) await generation.invoke("language.generate", input, { ...context, stepId: `step-${i}` });
  const attempts = await readLanguageAttempts(state, [context.runId]);
  (attempts[2].evidence.model_execution as Record<string, unknown>).inputTokens = null;
  const billed = [{ attempt_id: attempts[0].attempt_id, amount: 0.125, currency: "USD", receipt_ref: "provider:bill:one" }];
  const report = languageCostReport(attempts, [price], billed);
  assert.equal(report.totals.USD.billed, 0.125); assert.ok(report.totals.USD.estimated > 0); assert.equal(report.unknown_attempts, 1);
  assert.equal(report.infrastructure, "not-attributed");
  assert.throws(() => languageCostReport([...attempts, attempts[0]], [price]), /double-count/);
  assert.throws(() => languageCostReport(attempts, [price], [...billed, ...billed]), /duplicate/);
  assert.throws(() => languageCostReport(attempts, [price, price]), /Ambiguous/);
  assert.equal(languageCostReport(attempts, [{ ...price, valid_until: "2021-01-01T00:00:00Z" }]).unknown_attempts, 3);
  (attempts[1].evidence.model_execution as Record<string, unknown>).cacheReadTokens = null;
  assert.equal(languageCostReport(attempts, [price], billed).unknown_attempts, 2);
});

test("report bounds fail visibly instead of dropping later attempts", async () => {
  const state = new InMemoryStateStore(); state.listEvents = async () => Array.from({ length: 10001 }, () => ({}));
  await assert.rejects(readLanguageAttempts(state, ["large-run"]), /read bound/);
});
