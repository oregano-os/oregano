import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCompoundingStateStore, runCompoundingCycle, type CompoundingPhase } from "../../knowledge/compounding.ts";
import type {
  KnowledgeModelExecutor,
  KnowledgeModelProfileBinding,
  KnowledgeModelProviderResult,
  KnowledgeModelRequest,
} from "../../knowledge/knowledge-model-execution.ts";
import {
  createProductiveKnowledgeCompoundingPhases,
  selectCompoundingClaimPairs,
  type ClaimGradingResultWrite,
  type ClaimGradingWorkItem,
  type ClaimPairProposalWrite,
  type CompoundingClaim,
  type KnowledgeCompoundingWorkStore,
  type WorkingSynthesisWrite,
} from "../../knowledge/productive-compounding.ts";
import { sha256 } from "../../runtime/canonical.ts";

const claims: CompoundingClaim[] = [
  { claimId: "claim:a", claimText: "The Cedar launch date is September 1", memoryClass: "fact", claimKind: "fact", status: "active", observedAt: "2026-08-01T00:00:00.000Z", accessPolicyId: "policy:company", subjectIds: ["page:cedar"] },
  { claimId: "claim:b", claimText: "The Cedar launch date is September 15", memoryClass: "fact", claimKind: "fact", status: "contested", observedAt: "2026-08-20T00:00:00.000Z", accessPolicyId: "policy:company", subjectIds: ["page:cedar"] },
  { claimId: "claim:private", claimText: "The Cedar launch date is private", memoryClass: "fact", claimKind: "fact", status: "active", observedAt: "2026-08-20T00:00:00.000Z", accessPolicyId: "policy:private", subjectIds: ["page:cedar"] },
  { claimId: "claim:other", claimText: "Revenue increased", memoryClass: "fact", claimKind: "fact", status: "active", observedAt: "2026-08-20T00:00:00.000Z", accessPolicyId: "policy:company", subjectIds: ["page:revenue"] },
];

class MemoryWorkStore implements KnowledgeCompoundingWorkStore {
  pairProposals: ClaimPairProposalWrite[] = [];
  syntheses: WorkingSynthesisWrite[] = [];
  grades: ClaimGradingResultWrite[] = [];
  gradingRequests: ClaimGradingWorkItem[] = [];
  deferred: Array<{ requestId: string; reason: string }> = [];

  async listClaims(input: { accessPolicyIds: string[]; limit: number }) {
    return claims.filter((claim) => input.accessPolicyIds.includes(claim.accessPolicyId)).slice(0, input.limit);
  }
  async putClaimPairProposal(proposal: ClaimPairProposalWrite) { this.pairProposals.push(structuredClone(proposal)); return "inserted" as const; }
  async putWorkingSynthesis(synthesis: WorkingSynthesisWrite) { this.syntheses.push(structuredClone(synthesis)); return "inserted" as const; }
  async listPendingGradingRequests(input: { accessPolicyIds: string[]; limit: number }) { return this.gradingRequests.filter((request) => input.accessPolicyIds.includes(request.accessPolicyId)).slice(0, input.limit); }
  async completeGradingRequest(result: ClaimGradingResultWrite) { this.grades.push(structuredClone(result)); return "inserted" as const; }
  async deferGradingRequest(requestId: string, reason: string) { this.deferred.push({ requestId, reason }); }
}

class FixtureExecutor implements KnowledgeModelExecutor {
  readonly calls: KnowledgeModelRequest[] = [];
  async execute(profile: KnowledgeModelProfileBinding, request: KnowledgeModelRequest): Promise<KnowledgeModelProviderResult> {
    this.calls.push(structuredClone(request));
    const pair = request.taskInput as Record<string, unknown>;
    let output: unknown;
    if (request.promptId === "knowledge.duplicate-classification") output = { leftIdentity: pair.leftIdentity, rightIdentity: pair.rightIdentity, classification: "uncertain", confidence: 0.6, rationale: "Dates differ and replacement intent is unclear." };
    else if (request.promptId === "knowledge.claim-relation") output = { relations: [{ sourceClaimId: "claim:b", targetClaimId: "claim:a", relation: "refines", confidence: 0.9, rationale: "The later date narrows the launch claim." }] };
    else if (request.promptId === "knowledge.conflict-judgment") output = { leftClaimId: pair.leftClaimId, rightClaimId: pair.rightClaimId, judgment: "conflict", severity: "medium", rationale: "The dates are incompatible in the same scope." };
    else if (request.promptId === "knowledge.working-synthesis") output = { title: "Cedar launch", body: "Working synthesis: the launch date is contested.", supportingClaimIds: ["claim:a"], contestedClaimIds: ["claim:b"], supersededClaimIds: [], gaps: ["No decision receipt was supplied."] };
    else if (request.promptId === "knowledge.claim-grading") output = { claimId: pair.claimId, grade: "correct", confidence: 0.95, rationale: "The outcome confirms the claim.", supportingEvidenceIds: ["outcome:launch"] };
    else throw new Error(`Unexpected prompt '${request.promptId}'.`);
    return { output, responseId: `response:${this.calls.length}`, responseModel: profile.model, inputTokens: 10, outputTokens: 10, costUsd: 0, latencyMs: 1, finishReason: "stop" };
  }
}

const profile = (promptId: string): KnowledgeModelProfileBinding => ({
  contractVersion: "1.0.0",
  profile: promptId === "knowledge.working-synthesis" ? "deep" : promptId === "knowledge.claim-grading" || promptId === "knowledge.claim-relation" ? "reasoning" : "utility",
  profileVersion: "test@1",
  route: "test",
  model: "test-model",
  maxOutputTokens: 10_000,
});

test("compounding candidate selection is deterministic, policy-contained, and subject-contained", () => {
  const first = selectCompoundingClaimPairs(claims, "duplicate");
  const second = selectCompoundingClaimPairs([...claims].reverse(), "duplicate");
  assert.deepEqual(first.map((pair) => pair.map((claim) => claim.claimId)), [["claim:a", "claim:b"]]);
  assert.deepEqual(second.map((pair) => pair.map((claim) => claim.claimId)), [["claim:a", "claim:b"]]);
});

test("productive compounding defaults to one portable work item per phase", () => {
  const phases = createProductiveKnowledgeCompoundingPhases({
    store: new MemoryWorkStore(),
    executor: new FixtureExecutor(),
    resolveProfile: profile,
    accessPolicyIds: ["policy:company"],
    authorizationContextDigest: sha256("authorization"),
    dataClass: "confidential",
  });
  assert.deepEqual(phases.map((phase) => phase.budget), [1, 1, 1, 1, 1]);
});

test("productive compounding writes review proposals and immutable working synthesis without canonical mutation methods", async () => {
  const store = new MemoryWorkStore();
  const executor = new FixtureExecutor();
  const phases = createProductiveKnowledgeCompoundingPhases({
    store,
    executor,
    resolveProfile: profile,
    accessPolicyIds: ["policy:company"],
    authorizationContextDigest: sha256("authorization"),
    dataClass: "confidential",
    phaseBudget: 10,
    now: () => "2026-08-27T12:00:00.000Z",
  });
  for (const phase of phases.filter((entry) => entry.name !== "grading")) await phase.execute({ budget: phase.budget });
  assert.deepEqual(store.pairProposals.map((proposal) => proposal.proposalKind).sort(), ["conflict", "duplicate", "relation"]);
  assert.equal(store.pairProposals.every((proposal) => proposal.accessPolicyId === "policy:company" && proposal.modelReceiptId.length === 64), true);
  assert.equal(store.syntheses.length, 1);
  assert.equal(store.syntheses[0]?.subjectIdentity, "page:cedar");
  assert.deepEqual(store.syntheses[0]?.contestedClaimIds, ["claim:b"]);
  assert.equal(Object.hasOwn(store as object, "putClaim"), false);
});

test("working synthesis retries one invalid overlapping classification with bounded feedback", async () => {
  const store = new MemoryWorkStore();
  const calls: KnowledgeModelRequest[] = [];
  const executor: KnowledgeModelExecutor = { execute: async (binding, request) => {
    calls.push(structuredClone(request));
    const invalid = calls.length === 1;
    return {
      output: {
        title: "Cedar launch",
        body: "Working synthesis: the launch date is contested.",
        supportingClaimIds: ["claim:a"],
        contestedClaimIds: invalid ? ["claim:a", "claim:b"] : ["claim:b"],
        supersededClaimIds: [],
        gaps: [],
      },
      responseId: `response:${calls.length}`,
      responseModel: binding.model,
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0,
      latencyMs: 1,
      finishReason: "stop",
    };
  } };
  const phase = createProductiveKnowledgeCompoundingPhases({
    store,
    executor,
    resolveProfile: profile,
    accessPolicyIds: ["policy:company"],
    authorizationContextDigest: sha256("authorization"),
    dataClass: "confidential",
    now: () => "2026-08-27T12:00:00.000Z",
  }).find((entry) => entry.name === "syntheses")!;
  await phase.execute({ budget: phase.budget });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.taskInput, { subjectIdentity: "page:cedar" });
  assert.deepEqual(calls[1]?.taskInput, {
    subjectIdentity: "page:cedar",
    validationFeedbackCode: "claim-partitions-must-be-disjoint-and-bounded",
  });
  assert.notEqual(calls[0]?.idempotencyKey, calls[1]?.idempotencyKey);
  assert.deepEqual(store.syntheses[0]?.supportingClaimIds, ["claim:a"]);
  assert.deepEqual(store.syntheses[0]?.contestedClaimIds, ["claim:b"]);
});

test("working synthesis canonicalizes only an exact supplied evidence identity alias", async () => {
  const store = new MemoryWorkStore();
  const calls: KnowledgeModelRequest[] = [];
  const executor: KnowledgeModelExecutor = { execute: async (binding, request) => {
    calls.push(structuredClone(request));
    return {
      output: {
        title: "Cedar launch",
        body: "Working synthesis: the launch date is contested.",
        supportingClaimIds: ["claim:claim:a"],
        contestedClaimIds: ["claim:claim:b"],
        supersededClaimIds: [],
        gaps: [],
      },
      responseId: "response:evidence-alias",
      responseModel: binding.model,
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0,
      latencyMs: 1,
      finishReason: "stop",
    };
  } };
  const phase = createProductiveKnowledgeCompoundingPhases({
    store,
    executor,
    resolveProfile: profile,
    accessPolicyIds: ["policy:company"],
    authorizationContextDigest: sha256("authorization"),
    dataClass: "confidential",
  }).find((entry) => entry.name === "syntheses")!;
  await phase.execute({ budget: phase.budget });
  assert.equal(calls.length, 1);
  assert.deepEqual(store.syntheses[0]?.supportingClaimIds, ["claim:a"]);
  assert.deepEqual(store.syntheses[0]?.contestedClaimIds, ["claim:b"]);
});

test("claim grading runs only for an explicit request and bounded independent evidence", async () => {
  const store = new MemoryWorkStore();
  const executor = new FixtureExecutor();
  const grading = createProductiveKnowledgeCompoundingPhases({
    store,
    executor,
    resolveProfile: profile,
    accessPolicyIds: ["policy:company"],
    authorizationContextDigest: sha256("authorization"),
    dataClass: "confidential",
    now: () => "2026-08-27T12:00:00.000Z",
  }).find((phase) => phase.name === "grading")!;
  const empty = await grading.execute({ budget: grading.budget });
  assert.equal(empty.processed, 0);
  assert.equal(executor.calls.length, 0);
  const content = "Cedar launched on September 1.";
  store.gradingRequests.push({ requestId: "grade:request", claim: claims[0]!, outcomeEvidenceIds: ["outcome:launch"], outcomeEvidence: [{ evidenceId: "outcome:launch", content, contentDigest: sha256(content), metadata: { observedAt: "2026-09-02T00:00:00.000Z" } }], accessPolicyId: "policy:company" });
  const completed = await grading.execute({ budget: grading.budget });
  assert.equal(completed.processed, 1);
  assert.equal(store.grades.length, 1);
  assert.equal(store.grades[0]?.outcome, "correct");
  assert.deepEqual(store.grades[0]?.supportingEvidenceIds, ["outcome:launch"]);
});

test("an incomplete compounding receipt advances its cursor while a completed receipt stays immutable", async () => {
  const state = new InMemoryCompoundingStateStore();
  const continuations: Array<string | undefined> = [];
  const phase: CompoundingPhase = { name: "consolidate", scope: "mixed", budget: 1, execute: async ({ continuation }) => {
    continuations.push(continuation);
    return continuation
      ? { processed: 1, complete: true, evidenceDigest: sha256("second") }
      : { processed: 1, complete: false, continuation: "1", evidenceDigest: sha256("first") };
  } };
  await runCompoundingCycle({ cycleId: "cycle:bounded", sourceIds: [], phases: [phase], state, owner: "worker:one" });
  const completed = await runCompoundingCycle({ cycleId: "cycle:bounded", sourceIds: [], phases: [phase], state, owner: "worker:two" });
  const replayed = await runCompoundingCycle({ cycleId: "cycle:bounded", sourceIds: [], phases: [phase], state, owner: "worker:three" });
  assert.deepEqual(continuations, [undefined, "1"]);
  assert.equal(completed[0]?.complete, true);
  assert.equal(replayed[0]?.receiptId, completed[0]?.receiptId);
});

test("the additive schema persists compounding state and proposals without destructive migration", () => {
  const schema = readFileSync(join(import.meta.dirname, "../../state-postgres/knowledge-schema.sql"), "utf8");
  const migration = readFileSync(join(import.meta.dirname, "../../state-postgres/knowledge-schema-phase-five.ts"), "utf8");
  for (const table of ["compounding_leases", "compounding_receipts", "claim_pair_proposals", "claim_grading_requests"]) {
    assert.match(schema, new RegExp(`create table if not exists companyos_knowledge\\.${table}`));
    assert.match(migration, new RegExp(`create table if not exists companyos_knowledge\\.${table}`));
  }
  assert.doesNotMatch(migration, /\b(?:drop|truncate|delete)\b/i);
});

test("the maintained Vercel adapters schedule reconcile, extraction, and compounding in order", () => {
  const expected = [
    { path: "/api/knowledge/sources/granola/reconcile", schedule: "0 */6 * * *" },
    { path: "/api/knowledge/sources/granola/extract", schedule: "15 */6 * * *" },
    { path: "/api/knowledge/compounding", schedule: "30 */6 * * *" },
  ];
  const root = JSON.parse(readFileSync(join(import.meta.dirname, "../../../vercel.json"), "utf8")) as { crons?: unknown };
  const runner = JSON.parse(readFileSync(join(import.meta.dirname, "../../runner-vercel/vercel.json"), "utf8")) as { crons?: unknown };
  assert.deepEqual(root.crons, expected);
  assert.deepEqual(runner.crons, expected);
});
