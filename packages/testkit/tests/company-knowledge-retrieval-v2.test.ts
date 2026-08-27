import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256 } from "../../runtime/canonical.ts";
import { classifyDuplicateCascade, computeRetrievalSalience, createProcessingTriage } from "../../knowledge/salience.ts";
import {
  KNOWLEDGE_RETRIEVAL_V2_CONTRACT_VERSION,
  KnowledgeRetrievalServiceV2,
  synthesizeKnowledgeAnswer,
  validateKnowledgeAnswerEnvelope,
  type KnowledgeRetrievalRecordV2,
} from "../../knowledge/retrieval-v2.ts";
import { KNOWLEDGE_MODEL_EXECUTION_CONTRACT_VERSION, type KnowledgeModelProfileBinding } from "../../knowledge/knowledge-model-execution.ts";
import { InMemoryCompoundingStateStore, runCompoundingCycle, type CompoundingPhase } from "../../knowledge/compounding.ts";

const now = "2026-08-26T12:00:00.000Z";
const record = (identity: string, title: string, text: string, policy: string, input: Partial<KnowledgeRetrievalRecordV2> = {}): KnowledgeRetrievalRecordV2 => ({
  identity, kind: "page", pageId: identity, title, aliases: [], text, contentDigest: sha256(text), accessPolicyId: policy,
  label: "evidence", observedAt: now, sourceIds: [identity.split(":")[0]], confidence: 0.8, authority: 0.5, freshness: 0.9, expectedValue: 0.7, graphNeighbors: [], ...input,
});

const records = [
  record("repo:launch", "Project Cedar Launch", "Project Cedar launches in September with an onboarding plan.", "policy:company", { graphNeighbors: ["meeting:retention"] }),
  record("meeting:retention", "Cedar retention discussion", "The team expects Cedar onboarding to improve retention.", "policy:meeting", { label: "attributed", graphNeighbors: ["repo:launch"] }),
  record("hr:salary", "Salary review", "Confidential salary and compensation details.", "policy:hr", { label: "evidence" }),
  record("handbook:policy", "Launch Policy", "Official launch readiness policy for all projects.", "policy:company", { kind: "handbook", label: "official", authority: 1 }),
];

test("processing triage, rank salience, duplicate proposals, retention, and authority stay separate", () => {
  const triage = createProcessingTriage({ inputDigest: sha256("input"), tier: "low", reasonCodes: ["routine"] });
  const failed = createProcessingTriage({ inputDigest: sha256("input-2"), failureClass: "provider-failure", retryAfter: "2026-08-26T13:00:00Z" });
  const salience = computeRetrievalSalience({ relevance: 0.9, authority: 0.5, freshness: 0.8, confidence: 0.7, duplication: 0.1, contradiction: 0.2, sensitivity: 0.8, expectedValue: 0.9 });
  assert.equal(triage.tier, "low");
  assert.equal(failed.status, "retryable");
  assert.ok(salience.score > 0 && salience.score < 1);
  assert.equal("retention" in triage, false);
  assert.equal("authority" in triage, false);
  assert.deepEqual(classifyDuplicateCascade({ leftIdentity: "a", rightIdentity: "b", leftDigest: sha256("same"), rightDigest: sha256("same") }), { outcome: "exact-duplicate", automatic: true, basis: "content-digest" });
  assert.equal(classifyDuplicateCascade({ leftIdentity: "a", rightIdentity: "b", leftDigest: sha256("a"), rightDigest: sha256("b"), semanticSimilarity: 0.95, modelOutcome: "duplicate" }).automatic, false);
  assert.equal(classifyDuplicateCascade({ leftIdentity: "a", rightIdentity: "b", leftDigest: sha256("a"), rightDigest: sha256("b"), semanticSimilarity: 0.8, modelFailure: "refusal" }).outcome, "retryable");
});

test("authorization filters before semantic ranking, graph augmentation, context, and delta", async () => {
  const authorizationCalls: string[] = [];
  const service = new KnowledgeRetrievalServiceV2({
    records,
    authorization: { canRead: async ({ policyId, objectId, capability }) => { authorizationCalls.push(`${capability}:${objectId}`); return policyId !== "policy:hr"; } },
    semantic: async (_query, authorized) => {
      assert.equal(authorized.some((entry) => entry.identity === "hr:salary"), false, "semantic adapter must receive authorized candidates only");
      return new Map(authorized.map((entry, index) => [entry.identity, 1 - index * 0.1]));
    },
    deltas: [
      { sequence: 1, identity: "repo:launch", changeKind: "created", accessPolicyId: "policy:company", contentDigest: sha256("one"), occurredAt: now },
      { sequence: 2, identity: "hr:salary", changeKind: "created", accessPolicyId: "policy:hr", contentDigest: sha256("two"), occurredAt: now },
      { sequence: 3, identity: "meeting:retention", changeKind: "updated", accessPolicyId: "policy:meeting", contentDigest: sha256("three"), occurredAt: now },
    ],
  });
  const result = await service.search({ query: "Cedar launch retention", limit: 10 });
  assert.equal(result.hits.some((hit) => hit.identity === "hr:salary"), false);
  assert.ok(result.hits.some((hit) => hit.ranks.semantic));
  assert.ok(result.hits.some((hit) => hit.ranks.graph));
  const context = await service.contextPack({ query: "Cedar launch retention", authorizationContextDigest: sha256("auth"), maxRecords: 3, maxCharacters: 1_000, createdAt: now });
  const retry = await service.contextPack({ query: "Cedar launch retention", authorizationContextDigest: sha256("auth"), maxRecords: 3, maxCharacters: 1_000, createdAt: now });
  assert.equal(context.receipt.receiptId, retry.receipt.receiptId);
  assert.equal(context.records.some((hit) => hit.identity === "hr:salary"), false);
  assert.ok(authorizationCalls.some((entry) => entry.startsWith("context-pack:")));
  const delta = await service.delta({ afterSequence: 1, limit: 10 });
  assert.deepEqual(delta.changes.map((entry) => entry.sequence), [1, 3], "keyset boundary is inclusive for at-least-once delivery and ACL filters first");
  assert.equal(delta.atLeastOnce, true);
  assert.ok(authorizationCalls.some((entry) => entry.startsWith("delta:")));
});

test("timeline and explanation use their own authorization capabilities", async () => {
  const calls: string[] = [];
  const timelineRecords = [
    ...records,
    record("event:cedar-created", "Cedar created", "Cedar was created.", "policy:company", { kind: "timeline-event", pageId: "repo:launch", observedAt: "2026-08-01T10:00:00.000Z" }),
    record("event:cedar-approved", "Cedar approved", "Cedar was approved.", "policy:company", { kind: "timeline-event", pageId: "repo:launch", observedAt: "2026-08-10T10:00:00.000Z" }),
  ];
  const service = new KnowledgeRetrievalServiceV2({ records: timelineRecords, authorization: { canRead: async ({ capability, policyId, objectId }) => { calls.push(`${capability}:${objectId}`); return policyId !== "policy:hr"; } } });
  const timeline = await service.timeline({ identity: "repo:launch", from: "2026-08-02T00:00:00Z" });
  assert.deepEqual(timeline.map((entry) => entry.identity), ["event:cedar-approved"]);
  const explanation = await service.explain({ identity: "repo:launch" });
  assert.equal(explanation?.identity, "repo:launch");
  assert.equal("text" in (explanation ?? {}), false);
  assert.equal(await service.explain({ identity: "hr:salary" }), undefined);
  assert.ok(calls.some((entry) => entry.startsWith("timeline:")));
  assert.ok(calls.some((entry) => entry.startsWith("explain:")));
});

test("deep query expansion and optional reranking are bounded, authorized, and receipt-bound", async () => {
  const service = new KnowledgeRetrievalServiceV2({
    records,
    authorization: { canRead: async ({ policyId }) => policyId !== "policy:hr" },
    semantic: async (_query, authorized) => new Map(authorized.map((entry, index) => [entry.identity, 1 - index * 0.1])),
    queryExpander: async () => ({ terms: ["onboarding", "readiness"], receiptId: "model-receipt:expand" }),
    reranker: async (_query, authorized) => {
      assert.equal(authorized.some((entry) => entry.identity === "hr:salary"), false);
      return { scores: new Map(authorized.map((entry, index) => [entry.identity, 1 - index * 0.1])), receiptId: "model-receipt:rerank" };
    },
  });
  await assert.rejects(() => service.search({ query: "Cedar", costMode: "balanced", expandQuery: true }), /deep cost mode/i);
  const searched = await service.search({ query: "Cedar", costMode: "deep", expandQuery: true, rerank: true });
  assert.deepEqual(searched.operationReceiptIds, ["model-receipt:expand", "model-receipt:rerank"]);
  assert.ok(searched.hits.some((hit) => hit.ranks.rerank));
  const context = await service.contextPack({ query: "Cedar", authorizationContextDigest: sha256("auth"), costMode: "deep", expandQuery: true, rerank: true, createdAt: now });
  assert.deepEqual(context.receipt.operationReceiptIds, ["model-receipt:expand", "model-receipt:rerank"]);
  assert.equal(context.receipt.degradations.length, 0);
});

test("Answer Envelope binds every citation to the exact context and empty context cannot answer", async () => {
  const service = new KnowledgeRetrievalServiceV2({ records, authorization: { canRead: async ({ policyId }) => policyId === "policy:company" } });
  const context = await service.contextPack({ query: "launch policy", authorizationContextDigest: sha256("auth"), createdAt: now });
  const cited = context.records[0];
  assert.ok(cited);
  const valid = validateKnowledgeAnswerEnvelope({ context, envelope: { contractVersion: KNOWLEDGE_RETRIEVAL_V2_CONTRACT_VERSION, status: "answered", answer: "The launch has an official readiness policy.", citations: [{ identity: cited.identity, contentDigest: cited.contentDigest }], labels: [cited.label], gaps: [], conflicts: [], freshness: "current", contextReceiptId: context.receipt.receiptId } });
  assert.equal(valid.status, "answered");
  assert.throws(() => validateKnowledgeAnswerEnvelope({ context, envelope: { ...valid, citations: [{ identity: "hr:salary", contentDigest: sha256("forged") }] } }), /outside the exact authorized context/i);

  const emptyService = new KnowledgeRetrievalServiceV2({ records: [], authorization: { canRead: async () => true } });
  const empty = await emptyService.contextPack({ query: "nothing", authorizationContextDigest: sha256("auth"), createdAt: now });
  assert.throws(() => validateKnowledgeAnswerEnvelope({ context: empty, envelope: { ...valid, contextReceiptId: empty.receipt.receiptId, citations: [] } }), /Empty Knowledge context/i);
});

test("explicit synthesis uses a qualified profile, validates membership, and falls back extractively on refusal", async () => {
  const service = new KnowledgeRetrievalServiceV2({ records, authorization: { canRead: async ({ policyId }) => policyId !== "policy:hr" } });
  const context = await service.contextPack({ query: "Cedar launch", authorizationContextDigest: sha256("auth"), createdAt: now });
  const profile: KnowledgeModelProfileBinding = { contractVersion: KNOWLEDGE_MODEL_EXECUTION_CONTRACT_VERSION, profile: "deep", profileVersion: "1", route: "test", model: "test/deep", secretRefs: ["secret:MODEL"], allowedDataClasses: ["restricted"], maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostUsd: 1, state: "active", qualification: { qualifiedAt: now, receiptId: "qualification:deep", adapterDigest: sha256("adapter") } };
  await assert.rejects(() => synthesizeKnowledgeAnswer({ query: "Cedar launch", context, executor: { execute: async () => { throw new Error("must not run"); } }, profile, authorizationContextDigest: sha256("auth"), dataClass: "restricted", grant: false, now }), /explicit grant/i);
  const refused = await synthesizeKnowledgeAnswer({ query: "Cedar launch", context, executor: { execute: async () => ({ output: {}, responseId: "refused", responseModel: "test/deep", inputTokens: 10, outputTokens: 0, costUsd: 0, latencyMs: 1, finishReason: "refusal" }) }, profile, authorizationContextDigest: sha256("auth"), dataClass: "restricted", grant: true, now });
  assert.equal(refused.envelope.status, "extractive-fallback");
  assert.equal(refused.envelope.citations.length, context.records.length);
});

test("compounding scopes source work per Source and mixed or global work once per Brain", async () => {
  const executions: string[] = [];
  const phase = (name: CompoundingPhase["name"], scope: CompoundingPhase["scope"]): CompoundingPhase => ({ name, scope, budget: 10, execute: async ({ sourceId }) => { executions.push(`${name}:${sourceId ?? scope}`); return { processed: 1, complete: true, evidenceDigest: sha256({ name, sourceId, scope }) }; } });
  const phases = [phase("triage", "source"), phase("consolidate", "mixed"), phase("syntheses", "global")];
  const state = new InMemoryCompoundingStateStore();
  const clock = () => now;
  const first = await runCompoundingCycle({ cycleId: "cycle-1", sourceIds: ["b", "a", "a"], phases, state, owner: "worker-1", now: clock });
  const retry = await runCompoundingCycle({ cycleId: "cycle-1", sourceIds: ["a", "b"], phases, state, owner: "worker-2", now: clock });
  assert.equal(first.length, 4);
  assert.equal(retry.length, 4);
  assert.deepEqual(executions, ["triage:a", "triage:b", "consolidate:mixed", "syntheses:global"]);
});
