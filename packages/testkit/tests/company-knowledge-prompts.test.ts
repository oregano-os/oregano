import assert from "node:assert/strict";
import { test } from "node:test";
import { executeKnowledgeModel, type KnowledgeModelProfileBinding } from "../../knowledge/knowledge-model-execution.ts";
import {
  CORE_KNOWLEDGE_PROMPT_FIXTURES,
  asPromptRequestMetadata,
  evaluateKnowledgePromptSignals,
  knowledgePromptOutputSignals,
} from "../../knowledge/prompt-evaluation.ts";
import { KnowledgePromptRegistry, renderKnowledgePromptUserMessage } from "../../knowledge/prompt-registry.ts";
import { sha256 } from "../../runtime/canonical.ts";

test("every generative Knowledge task has exact versioned schemas and a task-specific prompt", () => {
  const registry = new KnowledgePromptRegistry();
  const definitions = registry.list();
  assert.equal(definitions.length, 13);
  assert.ok(!definitions.some((definition) => definition.promptId === "knowledge.rerank"));
  assert.equal(new Set(definitions.map((definition) => definition.inputSchemaId)).size, definitions.length);
  assert.equal(new Set(definitions.map((definition) => definition.outputSchemaId)).size, definitions.length);
  for (const definition of definitions) {
    const expectedVersion = definition.promptId === "knowledge.claim-extraction"
      ? "6"
      : definition.promptId === "knowledge.working-synthesis" ? "3" : "2";
    assert.equal(definition.version, expectedVersion);
    assert.ok(definition.userInstruction.length >= 150);
    assert.equal((definition.outputSchema as { additionalProperties?: unknown }).additionalProperties, false);
  }
  const extraction = registry.resolveCurrent("knowledge.claim-extraction");
  const facts = (extraction.outputSchema.properties as { facts: { items: { properties: Record<string, unknown> } } }).facts;
  assert.deepEqual(facts.items.properties.epistemicWeight, { type: "number", minimum: 0, maximum: 1, multipleOf: 0.05 });
});

test("the dispatcher fails closed for prompt or schema substitution before execution", () => {
  const registry = new KnowledgePromptRegistry();
  const definition = registry.resolveCurrent("knowledge.cited-synthesis");
  const fixture = CORE_KNOWLEDGE_PROMPT_FIXTURES.find((entry) => entry.promptId === definition.promptId)!;
  const request = asPromptRequestMetadata(fixture, definition);
  assert.equal(registry.resolveExecution(request).contentHash, definition.contentHash);
  assert.throws(() => registry.resolveExecution({ ...request, outputSchemaId: "knowledge.triage.output@2" }), /metadata does not match/i);
  assert.throws(() => registry.resolveExecution({ ...request, taskInput: { ...request.taskInput, unexpected: true } }), /not declared/i);
});

test("execution rejects substituted schema metadata before invoking the provider", async () => {
  const definition = new KnowledgePromptRegistry().resolveCurrent("knowledge.triage");
  const profile: KnowledgeModelProfileBinding = { contractVersion: "1.0.0", profile: "utility", profileVersion: "test", route: "test", model: "test/utility", maxOutputTokens: 100 };
  let providerCalled = false;
  await assert.rejects(() => executeKnowledgeModel({
    profile, requiredProfile: "utility", completedAt: "2026-08-27T10:00:00.000Z",
    executor: { execute: async () => { providerCalled = true; throw new Error("provider must not run"); } },
    request: {
      task: definition.task, promptId: definition.promptId, promptVersion: definition.version,
      promptContentHash: definition.contentHash, inputSchemaId: definition.inputSchemaId,
      outputSchemaId: "knowledge.answer-envelope@2", systemInstruction: definition.systemInstruction,
      taskInput: { sourceKind: "meeting", contentCharacters: 10 }, evidenceBlocks: [],
      authorizationContextDigest: sha256("auth"), dataClass: "business", idempotencyKey: "fixture",
    },
  }), /metadata does not match/i);
  assert.equal(providerCalled, false);
});

test("rendered task prompts carry structured input and quote evidence as untrusted JSON", () => {
  const registry = new KnowledgePromptRegistry();
  const definition = registry.resolveCurrent("knowledge.cited-synthesis");
  const fixture = CORE_KNOWLEDGE_PROMPT_FIXTURES.find((entry) => entry.promptId === definition.promptId)!;
  const rendered = renderKnowledgePromptUserMessage(definition, fixture);
  assert.match(rendered, /What is the official launch rule\?/);
  assert.match(rendered, /UNTRUSTED EVIDENCE BLOCKS/);
  assert.match(rendered, /1: \{\\"label\\":\\"official/);
  assert.doesNotMatch(rendered, /<evidence/i);
});

test("prompt fixtures expose deterministic precision, recall, and F1 quality gates", () => {
  const registry = new KnowledgePromptRegistry();
  assert.equal(CORE_KNOWLEDGE_PROMPT_FIXTURES.length, 13);
  assert.equal(new Set(CORE_KNOWLEDGE_PROMPT_FIXTURES.map((fixture) => fixture.promptId)).size, registry.list().length);
  for (const fixture of CORE_KNOWLEDGE_PROMPT_FIXTURES) {
    const definition = registry.resolveCurrent(fixture.promptId);
    assert.equal(definition.fixtureSetId, fixture.fixtureSetId);
    registry.resolveExecution(asPromptRequestMetadata(fixture, definition));
    const actualSignals = knowledgePromptOutputSignals(fixture.promptId, fixture.referenceOutput, fixture.taskInput);
    const perfect = evaluateKnowledgePromptSignals(fixture.expectedSignals, actualSignals);
    assert.equal(perfect.precision, 1);
    assert.equal(perfect.recall, 1);
    assert.equal(perfect.f1, 1);
    assert.ok(perfect.f1 >= fixture.minimumF1);
  }
  const degraded = evaluateKnowledgePromptSignals(["expected:a", "expected:b"], ["expected:a", "unexpected:c"]);
  assert.deepEqual(degraded, { truePositives: 1, falsePositives: 1, falseNegatives: 1, precision: 0.5, recall: 0.5, f1: 0.5 });
});
