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
  KnowledgeMaintenanceBudgetExceededError,
  selectCompoundingClaimPairs,
  type ClaimGradingResultWrite,
  type ClaimGradingWorkItem,
  type ClaimPairProposalWrite,
  type CachedKnowledgeModelTaskResult,
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
  readonly claimSet: CompoundingClaim[];
  constructor(claimSet: CompoundingClaim[] = claims) { this.claimSet = claimSet; }
  pairProposals: ClaimPairProposalWrite[] = [];
  syntheses: WorkingSynthesisWrite[] = [];
  grades: ClaimGradingResultWrite[] = [];
  gradingRequests: ClaimGradingWorkItem[] = [];
  deferred: Array<{ requestId: string; reason: string }> = [];
  listLimits: number[] = [];
  cachedResults = new Map<string, CachedKnowledgeModelTaskResult>();
  reservations = new Map<string, { cycleId: string; estimatedCostUsd: number; status: "reserved" | "succeeded" | "failed"; costUsd?: number; reservedAt: string }>();

  async getFrontierDigest(input: { accessPolicyIds: string[] }) {
    return sha256(this.claimSet.filter((claim) => input.accessPolicyIds.includes(claim.accessPolicyId)).map(({ claimId, status }) => ({ claimId, status })));
  }

  async listClaims(input: { accessPolicyIds: string[]; limit: number }) {
    this.listLimits.push(input.limit);
    return this.claimSet.filter((claim) => input.accessPolicyIds.includes(claim.accessPolicyId)).slice(0, input.limit);
  }
  async putClaimPairProposal(proposal: ClaimPairProposalWrite) {
    if (this.pairProposals.some((entry) => entry.proposalId === proposal.proposalId)) return "unchanged" as const;
    this.pairProposals.push(structuredClone(proposal)); return "inserted" as const;
  }
  async putWorkingSynthesis(synthesis: WorkingSynthesisWrite) { this.syntheses.push(structuredClone(synthesis)); return "inserted" as const; }
  async listPendingGradingRequests(input: { accessPolicyIds: string[]; limit: number }) { return this.gradingRequests.filter((request) => input.accessPolicyIds.includes(request.accessPolicyId)).slice(0, input.limit); }
  async completeGradingRequest(result: ClaimGradingResultWrite) { this.grades.push(structuredClone(result)); return "inserted" as const; }
  async deferGradingRequest(requestId: string, reason: string) { this.deferred.push({ requestId, reason }); }
  async getCachedModelTaskResult(input: { cacheKey: string; accessPolicyIds: string[] }) {
    const result = this.cachedResults.get(input.cacheKey);
    return result && input.accessPolicyIds.includes(result.accessPolicyId) ? structuredClone(result) : undefined;
  }
  async reserveModelSpend(input: { reservationId: string; cycleId: string; estimatedCostUsd: number; cycleBudgetUsd: number; dailyBudgetUsd: number; reservedAt: string }) {
    if (this.reservations.has(input.reservationId)) return "existing" as const;
    const cycle = [...this.reservations.values()].filter((entry) => entry.cycleId === input.cycleId).reduce((sum, entry) => sum + (entry.costUsd ?? entry.estimatedCostUsd), 0);
    const daily = [...this.reservations.values()].reduce((sum, entry) => sum + (entry.costUsd ?? entry.estimatedCostUsd), 0);
    if (cycle + input.estimatedCostUsd > input.cycleBudgetUsd || daily + input.estimatedCostUsd > input.dailyBudgetUsd) return "denied" as const;
    this.reservations.set(input.reservationId, { cycleId: input.cycleId, estimatedCostUsd: input.estimatedCostUsd, status: "reserved", reservedAt: input.reservedAt });
    return "reserved" as const;
  }
  async commitModelTaskResult(input: { reservationId: string; result: CachedKnowledgeModelTaskResult }) {
    const existing = this.cachedResults.has(input.result.cacheKey);
    this.cachedResults.set(input.result.cacheKey, structuredClone(input.result));
    const reservation = this.reservations.get(input.reservationId);
    if (reservation) this.reservations.set(input.reservationId, { ...reservation, status: "succeeded", costUsd: input.result.executionReceipt.costUsd });
    return existing ? "unchanged" as const : "inserted" as const;
  }
  async failModelSpend(input: { reservationId: string }) {
    const reservation = this.reservations.get(input.reservationId);
    if (reservation) this.reservations.set(input.reservationId, { ...reservation, status: "failed", costUsd: reservation.estimatedCostUsd });
  }
  async getModelSpend(input: { cycleId: string }) {
    const entries = [...this.reservations.values()].filter((entry) => entry.status === "succeeded");
    return {
      cycleCostUsd: entries.filter((entry) => entry.cycleId === input.cycleId).reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0),
      periodCostUsd: entries.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0),
    };
  }
}

class FixtureExecutor implements KnowledgeModelExecutor {
  readonly calls: KnowledgeModelRequest[] = [];
  readonly bindings: KnowledgeModelProfileBinding[] = [];
  async execute(profile: KnowledgeModelProfileBinding, request: KnowledgeModelRequest): Promise<KnowledgeModelProviderResult> {
    this.bindings.push(structuredClone(profile));
    this.calls.push(structuredClone(request));
    const pair = request.taskInput as Record<string, unknown>;
    let output: unknown;
    if (request.promptId === "knowledge.triage") output = { tier: "low", recommendedAction: "process", reasonCodes: ["bounded-candidate"], rationale: "The bounded evidence can be processed." };
    else if (request.promptId === "knowledge.duplicate-classification") output = { leftIdentity: pair.leftIdentity, rightIdentity: pair.rightIdentity, classification: "uncertain", confidence: 0.6, rationale: "Dates differ and replacement intent is unclear." };
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
  const unrelated = { ...claims[0]!, claimId: "claim:unrelated", claimText: "Hiring policy requires two approvals" };
  assert.deepEqual(selectCompoundingClaimPairs([...claims, unrelated], "relation").map((pair) => pair.map((claim) => claim.claimId)), [["claim:a", "claim:b"]]);
  assert.deepEqual(selectCompoundingClaimPairs([...claims, unrelated], "conflict").map((pair) => pair.map((claim) => claim.claimId)), [["claim:a", "claim:b"]]);
});

test("exact normalized duplicates create a deterministic proposal without a model call", async () => {
  const exactClaims = [
    claims[0]!,
    { ...claims[0]!, claimId: "claim:exact", claimText: "The cedar launch date is September 1." },
  ];
  const store = new MemoryWorkStore(exactClaims);
  const executor = new FixtureExecutor();
  const phase = createProductiveKnowledgeCompoundingPhases({
    store,
    executor,
    resolveProfile: profile,
    accessPolicyIds: ["policy:company"],
    authorizationContextDigest: sha256("authorization"),
    dataClass: "confidential",
  }).find((entry) => entry.name === "consolidate")!;
  await phase.execute({ budget: phase.budget });
  assert.equal(executor.calls.length, 0);
  assert.equal(store.pairProposals.length, 1);
  assert.equal(store.pairProposals[0]?.judgment, "duplicate");
  assert.equal(store.pairProposals[0]?.details.method, "deterministic-exact-normalized-text");
});

test("unchanged model judgments are reused across cycles and model changes invalidate reuse", async () => {
  const store = new MemoryWorkStore();
  const executor = new FixtureExecutor();
  const runDuplicate = async (cycleId: string, resolver = profile) => {
    const phase = createProductiveKnowledgeCompoundingPhases({
      store,
      executor,
      resolveProfile: resolver,
      accessPolicyIds: ["policy:company"],
      authorizationContextDigest: sha256("authorization"),
      dataClass: "confidential",
      cycleId,
    }).find((entry) => entry.name === "consolidate")!;
    await phase.execute({ budget: phase.budget });
  };
  await runDuplicate("cycle:one");
  await runDuplicate("cycle:two");
  assert.equal(executor.calls.length, 1);
  assert.equal(store.cachedResults.size, 1);
  assert.equal(store.pairProposals.length, 1);
  await runDuplicate("cycle:three", (promptId) => ({ ...profile(promptId), model: "test-model-v2" }));
  assert.equal(executor.calls.length, 2);
  assert.equal(store.cachedResults.size, 2);
});

test("cache hits bypass spend reservation while an uncached call fails closed at the budget", async () => {
  const store = new MemoryWorkStore();
  const executor = new FixtureExecutor();
  const anthropicProfile = (promptId: string): KnowledgeModelProfileBinding => ({
    ...profile(promptId),
    route: "anthropic-direct",
    model: "anthropic/claude-haiku-4-5-20251001",
  });
  const phase = (cycleId: string, cycleBudgetUsd?: number) => createProductiveKnowledgeCompoundingPhases({
    store,
    executor,
    resolveProfile: anthropicProfile,
    accessPolicyIds: ["policy:company"],
    authorizationContextDigest: sha256("authorization"),
    dataClass: "confidential",
    cycleId,
    ...(cycleBudgetUsd === undefined ? {} : { cycleBudgetUsd, dailyBudgetUsd: cycleBudgetUsd }),
  }).find((entry) => entry.name === "consolidate")!;
  await phase("cycle:paid").execute({ budget: 1 });
  await phase("cycle:cached", 0.000001).execute({ budget: 1 });
  assert.equal(executor.calls.length, 1);
  const changedClaims = [claims[0]!, { ...claims[1]!, claimText: "The Cedar launch date may be September 15" }];
  const changedStore = new MemoryWorkStore(changedClaims);
  const blocked = createProductiveKnowledgeCompoundingPhases({
    store: changedStore,
    executor,
    resolveProfile: anthropicProfile,
    accessPolicyIds: ["policy:company"],
    authorizationContextDigest: sha256("authorization"),
    dataClass: "confidential",
    cycleId: "cycle:blocked",
    cycleBudgetUsd: 0.000001,
    dailyBudgetUsd: 0.000001,
  }).find((entry) => entry.name === "consolidate")!;
  await assert.rejects(() => blocked.execute({ budget: 1 }), KnowledgeMaintenanceBudgetExceededError);
  assert.equal(executor.calls.length, 1);
});

test("maintenance caps provider output reservations by task profile", async () => {
  const executor = new FixtureExecutor();
  const phases = createProductiveKnowledgeCompoundingPhases({
    store: new MemoryWorkStore(),
    executor,
    resolveProfile: profile,
    accessPolicyIds: ["policy:company"],
    authorizationContextDigest: sha256("authorization"),
    dataClass: "confidential",
  });
  for (const phase of phases.filter((entry) => entry.name !== "grading")) {
    await phase.execute({ budget: phase.budget });
  }
  const limits = Object.fromEntries(executor.calls.map((request, index) => [
    request.promptId,
    executor.bindings[index]?.maxOutputTokens,
  ]));
  assert.equal(limits["knowledge.triage"], 2_000);
  assert.equal(limits["knowledge.duplicate-classification"], 2_000);
  assert.equal(limits["knowledge.claim-relation"], 4_000);
  assert.equal(limits["knowledge.conflict-judgment"], 2_000);
  assert.equal(limits["knowledge.working-synthesis"], 8_000);
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

test("a larger runtime budget keeps deep synthesis at one bounded subject", () => {
  const phases = createProductiveKnowledgeCompoundingPhases({
    store: new MemoryWorkStore(), executor: new FixtureExecutor(), resolveProfile: profile,
    accessPolicyIds: ["policy:company"], authorizationContextDigest: sha256("authorization"),
    dataClass: "confidential", phaseBudget: 5,
  });
  assert.deepEqual(phases.map((phase) => phase.budget), [5, 5, 5, 1, 5]);
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
  assert.equal(store.listLimits.every((limit) => limit === 2_000), true);
});

test("working synthesis retries one invalid overlapping classification with bounded feedback", async () => {
  const store = new MemoryWorkStore();
  const calls: KnowledgeModelRequest[] = [];
  let synthesisCalls = 0;
  const executor: KnowledgeModelExecutor = { execute: async (binding, request) => {
    calls.push(structuredClone(request));
    if (request.promptId === "knowledge.triage") return {
      output: { tier: "low", recommendedAction: "process", reasonCodes: ["bounded-candidate"], rationale: "Process." },
      responseId: "response:triage", responseModel: binding.model, inputTokens: 10, outputTokens: 10,
      costUsd: 0, latencyMs: 1, finishReason: "stop",
    };
    synthesisCalls += 1;
    const invalid = synthesisCalls === 1;
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
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1]?.taskInput, { subjectIdentity: "page:cedar", chunkIndex: 1, chunkCount: 1 });
  assert.deepEqual(calls[2]?.taskInput, {
    subjectIdentity: "page:cedar",
    chunkIndex: 1,
    chunkCount: 1,
    validationFeedbackCode: "claim-partitions-must-be-disjoint-and-bounded",
  });
  assert.notEqual(calls[1]?.idempotencyKey, calls[2]?.idempotencyKey);
  assert.deepEqual(store.syntheses[0]?.supportingClaimIds, ["claim:a"]);
  assert.deepEqual(store.syntheses[0]?.contestedClaimIds, ["claim:b"]);
});

test("working synthesis resumes deterministic Claim chunks and merges cached component receipts", async () => {
  const chunkedClaims = Array.from({ length: 41 }, (_, index): CompoundingClaim => ({
    claimId: `claim:chunk:${String(index).padStart(2, "0")}`,
    claimText: `Chunked working knowledge statement ${index}`,
    memoryClass: "fact",
    claimKind: "fact",
    status: "active",
    observedAt: "2026-08-27T00:00:00.000Z",
    accessPolicyId: "policy:company",
    subjectIds: ["page:chunked"],
  }));
  const store = new MemoryWorkStore(chunkedClaims);
  const calls: KnowledgeModelRequest[] = [];
  const executor: KnowledgeModelExecutor = { execute: async (binding, request) => {
    calls.push(structuredClone(request));
    if (request.promptId === "knowledge.triage") return {
      output: { tier: "low", recommendedAction: "process", reasonCodes: ["bounded-candidate"], rationale: "Process." },
      responseId: `response:${calls.length}`, responseModel: binding.model,
      inputTokens: 10, outputTokens: 10, costUsd: 0, latencyMs: 1, finishReason: "stop",
    };
    const claimIds = request.evidenceBlocks.map((block) => String((JSON.parse(block.content) as { claimId: string }).claimId));
    return {
      output: {
        title: "Chunked working synthesis",
        body: `Working synthesis segment ${String(request.taskInput.chunkIndex)}.`,
        supportingClaimIds: claimIds,
        contestedClaimIds: [],
        supersededClaimIds: [],
        gaps: [],
      },
      responseId: `response:${calls.length}`, responseModel: binding.model,
      inputTokens: 10, outputTokens: 10, costUsd: 0, latencyMs: 1, finishReason: "stop",
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
  const first = await phase.execute({ budget: phase.budget });
  assert.equal(first.complete, false);
  assert.equal(first.continuation, "1");
  assert.equal(store.syntheses.length, 0);
  const second = await phase.execute({ budget: phase.budget, continuation: first.continuation });
  assert.equal(second.complete, true);
  assert.equal(second.total, 2);
  assert.equal(calls.length, 4);
  assert.equal(store.syntheses.length, 1);
  assert.equal(store.syntheses[0]?.supportingClaimIds.length, 41);
  assert.equal(store.syntheses[0]?.componentModelReceipts?.length, 2);
  assert.match(store.syntheses[0]?.body ?? "", /Evidence segment 2 of 2/);
});

test("working synthesis canonicalizes only an exact supplied evidence identity alias", async () => {
  const store = new MemoryWorkStore();
  const calls: KnowledgeModelRequest[] = [];
  const executor: KnowledgeModelExecutor = { execute: async (binding, request) => {
    calls.push(structuredClone(request));
    if (request.promptId === "knowledge.triage") return {
      output: { tier: "low", recommendedAction: "process", reasonCodes: ["bounded-candidate"], rationale: "Process." },
      responseId: "response:triage", responseModel: binding.model, inputTokens: 10, outputTokens: 10,
      costUsd: 0, latencyMs: 1, finishReason: "stop",
    };
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
  assert.equal(calls.length, 2);
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
      ? { processed: 1, total: 2, complete: true, evidenceDigest: sha256("second") }
      : { processed: 1, total: 2, complete: false, continuation: "1", evidenceDigest: sha256("first") };
  } };
  await runCompoundingCycle({ cycleId: "cycle:bounded", sourceIds: [], phases: [phase], state, owner: "worker:one" });
  const completed = await runCompoundingCycle({ cycleId: "cycle:bounded", sourceIds: [], phases: [phase], state, owner: "worker:two" });
  const replayed = await runCompoundingCycle({ cycleId: "cycle:bounded", sourceIds: [], phases: [phase], state, owner: "worker:three" });
  assert.deepEqual(continuations, [undefined, "1"]);
  assert.equal(completed[0]?.complete, true);
  assert.equal(completed[0]?.total, 2);
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
  const maintenanceMigration = readFileSync(join(import.meta.dirname, "../../state-postgres/knowledge-schema-phase-six.ts"), "utf8");
  for (const table of ["model_task_results", "model_spend_reservations", "model_execution_ledger"]) {
    assert.match(schema, new RegExp(`create table if not exists companyos_knowledge\\.${table}`));
    assert.match(maintenanceMigration, new RegExp(`create table if not exists companyos_knowledge\\.${table}`));
  }
  assert.doesNotMatch(maintenanceMigration, /\b(?:drop|truncate|delete)\b/i);
  const store = readFileSync(join(import.meta.dirname, "../../state-postgres/knowledge-compounding-store.ts"), "utf8");
  assert.match(store, /pg_advisory_xact_lock/);
  assert.match(store, /10 \* 60_000/);
  assert.match(store, /stale-model-execution-reservation/);
  assert.match(store, /status in \('reserved', 'failed'\)/);
  assert.match(store, /coalesce\(charged_cost_usd, estimated_cost_usd\) \+ \$\{reservation\.estimatedCostUsd\}/);
  assert.match(store, /when failure_digest is null then \$\{receipt\.costUsd\} else estimated_cost_usd/);
  assert.match(store, /with eligible_reservation as/);
});

test("the maintained Vercel adapters preserve Knowledge order and add the fail-closed Builder worker", () => {
  const expected = [
    { path: "/api/knowledge/sources/granola/reconcile", schedule: "0 */6 * * *" },
    { path: "/api/knowledge/sources/granola/extract", schedule: "15 */6 * * *" },
    { path: "/api/knowledge/compounding", schedule: "0 2-5 * * *" },
    { path: "/api/builder/worker", schedule: "* * * * *" },
    { path: "/api/records/reconcile", schedule: "*/15 * * * *" },
    { path: "/api/sprint/timers", schedule: "* * * * *" },
    { path: "/api/sprint/intents", schedule: "* * * * *" },
  ];
  const root = JSON.parse(readFileSync(join(import.meta.dirname, "../../../vercel.json"), "utf8")) as { crons?: unknown };
  const runner = JSON.parse(readFileSync(join(import.meta.dirname, "../../runner-vercel/vercel.json"), "utf8")) as { crons?: unknown };
  assert.deepEqual(root.crons, expected);
  assert.deepEqual(runner.crons, expected);
});

test("Postgres reads only successful model artifacts attached to the current Page version", () => {
  const retrieval = readFileSync(join(import.meta.dirname, "../../state-postgres/brain-retrieval-store.ts"), "utf8");
  const compounding = readFileSync(join(import.meta.dirname, "../../state-postgres/knowledge-compounding-store.ts"), "utf8");
  const exact = readFileSync(join(import.meta.dirname, "../../state-postgres/brain-store.ts"), "utf8");
  assert.match(retrieval, /evidence_page\.current_version_id = e\.page_version_id/);
  assert.match(retrieval, /t\.page_version_id = p\.current_version_id/);
  assert.match(retrieval, /jsonb_array_elements_text/);
  assert.match(compounding, /current_page\.current_version_id = current_evidence\.page_version_id/g);
  assert.match(exact, /current_page\.current_version_id = current_evidence\.page_version_id/);
});
