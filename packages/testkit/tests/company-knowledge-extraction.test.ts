import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryBrainStore } from "../../knowledge/in-memory-brain-store.ts";
import {
  InMemoryKnowledgeExtractionRunStore,
  chunkKnowledgeEvidenceText,
  classifyPageTypeDeterministically,
  extractRawEvidenceToBrain,
  linkDeterministicProviderIdentity,
} from "../../knowledge/extraction-pipeline.ts";
import {
  KNOWLEDGE_MODEL_EXECUTION_CONTRACT_VERSION,
  executeKnowledgeModel,
  type KnowledgeModelExecutor,
  type KnowledgeModelProfileBinding,
} from "../../knowledge/knowledge-model-execution.ts";
import { CORE_KNOWLEDGE_PROMPTS, KnowledgePromptRegistry } from "../../knowledge/prompt-registry.ts";
import { sha256 } from "../../runtime/canonical.ts";
import { SOURCE_CONNECTOR_V2_CONTRACT_VERSION } from "../../knowledge/source-contracts-v2.ts";
import type { SourceRawEvidenceV2 } from "../../knowledge/source-pipeline-store.ts";

const now = "2026-08-26T12:00:00.000Z";
const profile = (name: "utility" | "reasoning"): KnowledgeModelProfileBinding => ({
  contractVersion: KNOWLEDGE_MODEL_EXECUTION_CONTRACT_VERSION,
  profile: name,
  profileVersion: "1",
  route: "qualified-test-adapter",
  model: `test/${name}`,
  secretRefs: ["secret:MODEL_API_KEY"],
  allowedDataClasses: ["restricted"],
  maxInputTokens: 10_000,
  maxOutputTokens: 2_000,
  maxCostUsd: 1,
  state: "active",
  qualification: { qualifiedAt: now, receiptId: `qualification:${name}`, adapterDigest: sha256(`adapter:${name}`) },
});

const text = "Alice: We will launch Project Cedar on September 1.\nBob: I think the launch will increase retention.\n";
const evidence: SourceRawEvidenceV2 = {
  envelope: {
    contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
    sourceId: "meetings",
    providerTenantId: "workspace-1",
    providerObjectId: "meeting-1",
    providerVersion: "revision-1",
    eventId: sha256("event-1"),
    observedAt: now,
    locator: "meeting:meeting-1",
    mediaType: "text/plain",
    size: Buffer.byteLength(text),
    contentDigest: sha256(text),
    accessPolicyId: "policy:company-knowledge",
    deletionState: "present",
  },
  content: { inlineText: text },
  access: {
    contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
    sourceId: "meetings", providerObjectId: "meeting-1", providerAccessVersion: "acl-1", observedAt: now,
    entries: [], evidenceDigest: sha256("access"),
  },
  sanityCodes: [], modelReady: true, payloadState: "active", retentionUntil: "9999-12-31T23:59:59.999Z", recordedAt: now,
};

const output = {
  page: { title: "Project Cedar launch discussion", summary: "A launch commitment and an attributed prediction." },
  facts: [
    {
      claimKind: "commitment", claimText: "Project Cedar will launch on September 1.", ownerPrincipalId: "human:alice",
      evidenceId: "evidence:source", locator: { kind: "line", start: 1, end: 1 }, extractionConfidence: 0.95, epistemicWeight: 0.8,
      participantRelations: [{ relation: "speaker", principalId: "human:alice" }, { relation: "owner", principalId: "human:project-lead" }],
    },
  ],
  takes: [
    {
      claimKind: "bet", claimText: "The launch will increase retention.",
      holder: { holderId: "people/bob", holderType: "person", displayName: "people/bob" }, derivation: "source-literal",
      evidenceId: "evidence:source", locator: { kind: "line", start: 2, end: 2 }, extractionConfidence: 0.9, epistemicWeight: 0.7,
      participantRelations: [{ relation: "speaker", principalId: "human:bob" }],
    },
    {
      claimKind: "hunch", claimText: "Retention impact may depend on onboarding quality.",
      holder: { holderId: "brain", holderType: "system", displayName: "brain" }, derivation: "model-derived",
      evidenceId: "evidence:source", locator: { kind: "line", start: 2, end: 2 }, extractionConfidence: 0.55, epistemicWeight: 0.5,
      participantRelations: [],
    },
  ],
  timeline: [{ eventType: "planned-launch", description: "Project Cedar launch", observedAt: now, locator: { kind: "line", start: 1, end: 1 } }],
};

test("evidence chunking preserves exact text and global line offsets", () => {
  const text = "line one\nline two is longer\nline three\nline four";
  const chunks = chunkKnowledgeEvidenceText(text, 20);
  assert.equal(chunks.map((chunk) => chunk.content).join("\n"), text);
  assert.deepEqual(chunks.map((chunk) => chunk.lineOffset), [0, 1, 2]);
});

test("Core Prompt Registry pins every initial model boundary and keeps evidence untrusted", () => {
  const registry = new KnowledgePromptRegistry();
  assert.equal(registry.list().length, 13);
  assert.deepEqual(registry.list().map((entry) => entry.promptId), [...CORE_KNOWLEDGE_PROMPTS].map((entry) => entry.promptId).sort());
  for (const entry of registry.list()) {
    assert.match(entry.contentHash, /^[a-f0-9]{64}$/);
    assert.match(entry.systemInstruction, /untrusted quoted data/i);
    assert.match(entry.inputSchemaId, entry.promptId === "knowledge.claim-extraction" ? /@2$/ : /@1$/);
    assert.match(entry.outputSchemaId, entry.promptId === "knowledge.claim-extraction" ? /@4$/ : /@2$/);
    assert.ok(entry.userInstruction.length > 100);
  }
  assert.throws(() => registry.resolveCurrent("knowledge.rerank"), /Unknown Knowledge prompt/);
});

test("deterministic Page classification and provider identity linking make no model call", async () => {
  assert.deepEqual(classifyPageTypeDeterministically({ locator: "provider://objects/1", sourceKind: "meeting" }), { typeKey: "meeting", basis: "source-kind" });
  assert.deepEqual(classifyPageTypeDeterministically({ declaredType: "project", locator: "anything" }), { typeKey: "project", basis: "declared-key" });
  const store = new InMemoryBrainStore();
  const page = (await extractRawEvidenceToBrain({
    evidence, sourceKind: "meeting", ownerPrincipalId: "human:alice", brainStore: store, runStore: new InMemoryKnowledgeExtractionRunStore(),
    modelExecutor: { execute: async () => ({ output, responseId: "response-1", responseModel: "test/reasoning", inputTokens: 100, outputTokens: 50, costUsd: 0.01, latencyMs: 10, finishReason: "stop" }) },
    profiles: { utility: profile("utility"), reasoning: profile("reasoning") }, authorizationContextDigest: sha256("auth"), dataClass: "restricted", now,
  })).page;
  const linked = await linkDeterministicProviderIdentity({ store, page, entityKind: "project", providerStableKey: "provider:project:cedar", displayName: "Project Cedar", receiptId: "receipt:provider-identity", createdAt: now });
  assert.equal(linked.membership.proofBasis, "provider-identifier");
});

test("structured extraction is idempotent, evidence-bound, and keeps inferred gradeable Takes proposed", async () => {
  let calls = 0;
  const executor: KnowledgeModelExecutor = { execute: async (_profile, request) => {
    calls += 1;
    assert.equal(request.evidenceBlocks.length, 1);
    assert.deepEqual(request.taskInput, { defaultOwnerPrincipalId: "human:alice", sourceKind: "meeting", observedAt: now, evidenceLineCount: 3 });
    return { output, responseId: "response-1", responseModel: "test/reasoning", inputTokens: 100, outputTokens: 50, costUsd: 0.01, latencyMs: 10, finishReason: "stop" };
  } };
  const brainStore = new InMemoryBrainStore();
  const runStore = new InMemoryKnowledgeExtractionRunStore();
  const input = { evidence, sourceKind: "meeting", ownerPrincipalId: "human:alice", brainStore, runStore, modelExecutor: executor, profiles: { utility: profile("utility"), reasoning: profile("reasoning") }, authorizationContextDigest: sha256("auth"), dataClass: "restricted" as const, now };
  const first = await extractRawEvidenceToBrain(input);
  const retry = await extractRawEvidenceToBrain(input);
  assert.equal(calls, 1, "source-kind classification must use the deterministic path and retry must reuse the run");
  assert.equal(first.page.pageTypeKey, "meeting");
  assert.equal(first.pageVersion.pageVersionId, retry.pageVersion.pageVersionId);
  assert.equal(first.claims.length, 3);
  assert.equal(first.claims[0].status, "active");
  assert.equal(first.claims[1].status, "active");
  assert.equal(first.claims[2].status, "proposed");
  assert.equal(first.claims[1].primaryHolder?.holderId, "people/bob");
  assert.ok(first.participantRelations.some((entry) => entry.relation === "owner" && entry.principalId === "human:project-lead"));
  assert.notEqual(first.claims[0].ownerPrincipalId, first.participantRelations.find((entry) => entry.relation === "owner")?.principalId);
  assert.equal((await brainStore.listClaimRelations(first.claims[0].claimId)).length, 2);
  const timeline = await brainStore.listTimelineEvents(first.page.pageId);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].evidence.description, "Project Cedar launch");
  assert.equal(timeline[0].pageVersionId, first.pageVersion.pageVersionId);
});

test("large evidence executes bounded chunks and restores global line locators", async () => {
  const longText = Array.from({ length: 6_000 }, (_, index) => `transcript line ${index + 1}`).join("\n");
  const longEvidence = {
    ...evidence,
    envelope: { ...evidence.envelope, size: Buffer.byteLength(longText), contentDigest: sha256(longText) },
    content: { inlineText: longText },
  };
  let calls = 0;
  const result = await extractRawEvidenceToBrain({
    evidence: longEvidence, sourceKind: "meeting", ownerPrincipalId: "human:alice",
    brainStore: new InMemoryBrainStore(), runStore: new InMemoryKnowledgeExtractionRunStore(),
    modelExecutor: { execute: async () => ({ output, responseId: `response-${++calls}`, responseModel: "test/reasoning", inputTokens: 100, outputTokens: 50, costUsd: 0.01, latencyMs: 10, finishReason: "stop" }) },
    profiles: { utility: profile("utility"), reasoning: profile("reasoning") }, authorizationContextDigest: sha256("auth"), dataClass: "restricted", now,
  });
  assert.ok(calls > 1);
  assert.equal(result.modelReceipts.length, calls);
  const firstClaimInSecondChunk = result.claims[output.facts.length + output.takes.length]!;
  assert.equal(firstClaimInSecondChunk.evidence[0]?.locator.kind, "line");
  assert.ok(firstClaimInSecondChunk.evidence[0]?.locator.kind === "line" && firstClaimInSecondChunk.evidence[0].locator.start > 2);
});

test("revoked model profiles fail closed and returned locators cannot escape the authorized evidence", async () => {
  const prompt = new KnowledgePromptRegistry().resolveCurrent("knowledge.triage");
  const request = { task: prompt.task, promptId: prompt.promptId, promptVersion: prompt.version, promptContentHash: prompt.contentHash, inputSchemaId: prompt.inputSchemaId, outputSchemaId: prompt.outputSchemaId, systemInstruction: prompt.systemInstruction, taskInput: { sourceKind: "meeting", contentCharacters: text.length }, evidenceBlocks: [], authorizationContextDigest: sha256("auth"), dataClass: "restricted" as const, idempotencyKey: "test" };
  const compatible = await executeKnowledgeModel({
    executor: { execute: async () => ({ output: {}, responseId: "r", responseModel: "test", inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1, finishReason: "stop" }) },
    profile: { ...profile("utility"), state: "qualified" }, requiredProfile: "utility", completedAt: now, request,
  });
  assert.equal(compatible.receipt.outcome, "succeeded", "legacy qualification metadata is readable but no longer an activation gate");
  await assert.rejects(() => executeKnowledgeModel({
    executor: { execute: async () => ({ output: {}, responseId: "r", responseModel: "test", inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1, finishReason: "stop" }) },
    profile: { ...profile("utility"), state: "revoked" }, requiredProfile: "utility", completedAt: now, request,
  }), /revoked/i);

  const invalid = structuredClone(output);
  invalid.facts[0].locator = { kind: "line", start: 1, end: 999 };
  let invalidCalls = 0;
  await assert.rejects(() => extractRawEvidenceToBrain({
    evidence, sourceKind: "meeting", ownerPrincipalId: "human:alice", brainStore: new InMemoryBrainStore(), runStore: new InMemoryKnowledgeExtractionRunStore(),
    modelExecutor: { execute: async () => ({ output: invalid, responseId: `response-invalid-${++invalidCalls}`, responseModel: "test/reasoning", inputTokens: 10, outputTokens: 10, costUsd: 0, latencyMs: 1, finishReason: "stop" }) },
    profiles: { utility: profile("utility"), reasoning: profile("reasoning") }, authorizationContextDigest: sha256("auth"), dataClass: "restricted", now,
  }), /outside the authorized bounded input/i);
  assert.equal(invalidCalls, 2);
});
