import { canonicalJson, sha256 } from "../runtime/canonical.ts";
import type { CompoundingPhase } from "./compounding.ts";
import {
  executeKnowledgeModel,
  type KnowledgeModelExecutionReceipt,
  type KnowledgeModelExecutor,
  type KnowledgeModelProfileBinding,
} from "./knowledge-model-execution.ts";
import { KnowledgePromptRegistry } from "./prompt-registry.ts";
import { estimateKnowledgeModelCost } from "./model-pricing.ts";

export interface CompoundingClaim {
  claimId: string;
  claimText: string;
  memoryClass: "fact" | "take";
  claimKind: string;
  status: string;
  observedAt: string;
  accessPolicyId: string;
  subjectIds: string[];
}

export interface CompoundingEvidenceBlock {
  evidenceId: string;
  content: string;
  contentDigest: string;
  metadata: Record<string, unknown>;
}

export interface ClaimGradingWorkItem {
  requestId: string;
  claim: CompoundingClaim;
  outcomeEvidenceIds: string[];
  outcomeEvidence: CompoundingEvidenceBlock[];
  accessPolicyId: string;
}

export interface ClaimPairProposalWrite {
  proposalId: string;
  leftClaimId: string;
  rightClaimId: string;
  proposalKind: "duplicate" | "relation" | "conflict";
  judgment: string;
  severity?: string;
  confidence: number;
  rationale: string;
  details: Record<string, unknown>;
  modelReceiptId: string;
  promptIdentity: string;
  accessPolicyId: string;
  createdAt: string;
}

export interface WorkingSynthesisWrite {
  subjectIdentity: string;
  title: string;
  body: string;
  supportingClaimIds: string[];
  contestedClaimIds: string[];
  supersededClaimIds: string[];
  gaps: string[];
  accessPolicyId: string;
  modelReceipt: KnowledgeModelExecutionReceipt;
  componentModelReceipts?: KnowledgeModelExecutionReceipt[];
  synthesizedAt: string;
}

export interface ClaimGradingResultWrite {
  requestId: string;
  claimId: string;
  outcome: "correct" | "incorrect" | "partial" | "unresolvable";
  confidence: number;
  rationale: string;
  supportingEvidenceIds: string[];
  outcomeEvidence: CompoundingEvidenceBlock[];
  modelReceipt: KnowledgeModelExecutionReceipt;
  proposedAt: string;
}

export interface CachedKnowledgeModelTaskResult {
  cacheKey: string;
  task: string;
  promptId: string;
  promptVersion: string;
  promptContentHash: string;
  inputDigest: string;
  authorizationContextDigest: string;
  dataClass: KnowledgeCompoundingRuntimeInput["dataClass"];
  route: string;
  model: string;
  profileVersion: string;
  accessPolicyId: string;
  output: unknown;
  executionReceipt: KnowledgeModelExecutionReceipt;
  createdAt: string;
}

export interface ModelSpendReservation {
  reservationId: string;
  cycleId: string;
  cacheKey: string;
  task: string;
  route: string;
  model: string;
  accessPolicyId: string;
  estimatedCostUsd: number;
  pricingVersion: string;
  cycleBudgetUsd: number;
  dailyBudgetUsd: number;
  reservedAt: string;
}

export interface KnowledgeCompoundingWorkStore {
  getFrontierDigest(input: { accessPolicyIds: string[] }): Promise<string>;
  listClaims(input: { accessPolicyIds: string[]; limit: number }): Promise<CompoundingClaim[]>;
  putClaimPairProposal(proposal: ClaimPairProposalWrite): Promise<"inserted" | "unchanged">;
  putWorkingSynthesis(synthesis: WorkingSynthesisWrite): Promise<"inserted" | "unchanged">;
  listPendingGradingRequests(input: { accessPolicyIds: string[]; limit: number }): Promise<ClaimGradingWorkItem[]>;
  completeGradingRequest(result: ClaimGradingResultWrite): Promise<"inserted" | "unchanged">;
  deferGradingRequest(requestId: string, reason: string): Promise<void>;
  getCachedModelTaskResult(input: { cacheKey: string; accessPolicyIds: string[]; usedAt: string }): Promise<CachedKnowledgeModelTaskResult | undefined>;
  reserveModelSpend(reservation: ModelSpendReservation): Promise<"reserved" | "existing" | "denied">;
  commitModelTaskResult(input: { reservationId: string; cycleId: string; result: CachedKnowledgeModelTaskResult }): Promise<"inserted" | "unchanged">;
  failModelSpend(input: { reservationId: string; failedAt: string; failureDigest: string }): Promise<void>;
  getModelSpend(input: { cycleId: string; since: string }): Promise<{ cycleCostUsd: number; periodCostUsd: number }>;
}

export interface KnowledgeCompoundingRuntimeInput {
  store: KnowledgeCompoundingWorkStore;
  executor: KnowledgeModelExecutor;
  resolveProfile(promptId: string): KnowledgeModelProfileBinding;
  accessPolicyIds: string[];
  authorizationContextDigest: string;
  dataClass: "business" | "confidential" | "restricted" | "personal";
  now?: () => string;
  phaseBudget?: number;
  cycleId?: string;
  cycleBudgetUsd?: number;
  dailyBudgetUsd?: number;
}

export const KNOWLEDGE_PRODUCTIVE_COMPOUNDING_CONTRACT_VERSION = "2.2.0" as const;
export const KNOWLEDGE_COMPOUNDING_CANDIDATE_RULE_VERSION = "2.0.0" as const;
export const KNOWLEDGE_WORKING_SYNTHESIS_CLAIM_CHUNK_SIZE = 40 as const;
export const KNOWLEDGE_PRODUCTIVE_COMPOUNDING_PROMPT_IDS = [
  "knowledge.triage",
  "knowledge.duplicate-classification",
  "knowledge.claim-relation",
  "knowledge.conflict-judgment",
  "knowledge.working-synthesis",
  "knowledge.claim-grading",
] as const;

type Pair = readonly [CompoundingClaim, CompoundingClaim];

const isoNow = (input: KnowledgeCompoundingRuntimeInput): string => input.now?.() ?? new Date().toISOString();

const words = (value: string): Set<string> => new Set(
  value.toLocaleLowerCase("en").match(/[\p{L}\p{N}]{3,}/gu) ?? [],
);

const normalizedClaimText = (value: string): string => (value.toLocaleLowerCase("en").match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");

const lexicalOverlap = (left: string, right: string): number => {
  const a = words(left);
  const b = words(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const term of a) if (b.has(term)) intersection += 1;
  return intersection / new Set([...a, ...b]).size;
};

const sharedSubject = (left: CompoundingClaim, right: CompoundingClaim): boolean => {
  const rightSubjects = new Set(right.subjectIds);
  return left.subjectIds.some((subject) => rightSubjects.has(subject));
};

export function selectCompoundingClaimPairs(
  claims: readonly CompoundingClaim[],
  mode: "duplicate" | "relation" | "conflict",
): Pair[] {
  const ordered = [...claims].sort((a, b) => a.claimId.localeCompare(b.claimId));
  const pairs: Pair[] = [];
  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
      const left = ordered[leftIndex];
      const right = ordered[rightIndex];
      if (!left || !right || left.accessPolicyId !== right.accessPolicyId || !sharedSubject(left, right)) continue;
      const overlap = lexicalOverlap(left.claimText, right.claimText);
      const exact = normalizedClaimText(left.claimText) === normalizedClaimText(right.claimText);
      if (mode === "duplicate" && !exact && overlap < 0.45) continue;
      if (mode === "relation" && (exact || overlap < 0.20)) continue;
      if (mode === "conflict" && (exact || left.claimKind !== right.claimKind || overlap < 0.15)) continue;
      pairs.push([left, right]);
    }
  }
  return pairs;
}

const claimEvidence = (claim: CompoundingClaim) => {
  const content = canonicalJson({
    claimId: claim.claimId,
    claimText: claim.claimText,
    memoryClass: claim.memoryClass,
    claimKind: claim.claimKind,
    status: claim.status,
    observedAt: claim.observedAt,
    subjectIds: claim.subjectIds,
  });
  return { evidenceId: `claim:${claim.claimId}`, content, contentDigest: sha256(content) };
};

const promptIdentity = (prompt: ReturnType<KnowledgePromptRegistry["resolveCurrent"]>): string =>
  `${prompt.promptId}@${prompt.version}#${prompt.contentHash}`;

async function invoke(
  runtime: KnowledgeCompoundingRuntimeInput,
  promptId: string,
  taskInput: Record<string, unknown>,
  evidenceBlocks: Array<{ evidenceId: string; content: string; contentDigest: string }>,
  identity: Record<string, unknown>,
  accessPolicyId: string,
) {
  const prompt = new KnowledgePromptRegistry().resolveCurrent(promptId);
  const profile = runtime.resolveProfile(promptId);
  const request = {
    task: prompt.task,
    promptId: prompt.promptId,
    promptVersion: prompt.version,
    promptContentHash: prompt.contentHash,
    inputSchemaId: prompt.inputSchemaId,
    outputSchemaId: prompt.outputSchemaId,
    systemInstruction: prompt.systemInstruction,
    taskInput,
    evidenceBlocks,
    authorizationContextDigest: runtime.authorizationContextDigest,
    dataClass: runtime.dataClass,
    idempotencyKey: sha256({ promptId, ...identity }),
  } as const;
  const cacheKey = sha256({
    contractVersion: KNOWLEDGE_PRODUCTIVE_COMPOUNDING_CONTRACT_VERSION,
    candidateRuleVersion: KNOWLEDGE_COMPOUNDING_CANDIDATE_RULE_VERSION,
    prompt: {
      promptId: prompt.promptId,
      promptVersion: prompt.version,
      promptContentHash: prompt.contentHash,
      inputSchemaId: prompt.inputSchemaId,
      outputSchemaId: prompt.outputSchemaId,
    },
    profile: {
      profile: profile.profile,
      profileVersion: profile.profileVersion,
      route: profile.route,
      model: profile.model,
      maxOutputTokens: profile.maxOutputTokens,
      timeoutMs: profile.timeoutMs,
      retries: profile.retries,
    },
    taskInput,
    evidence: evidenceBlocks.map(({ evidenceId, contentDigest }) => ({ evidenceId, contentDigest })),
    authorizationContextDigest: runtime.authorizationContextDigest,
    dataClass: runtime.dataClass,
    accessPolicyId,
  });
  const usedAt = isoNow(runtime);
  const cached = await runtime.store.getCachedModelTaskResult({ cacheKey, accessPolicyIds: runtime.accessPolicyIds, usedAt });
  if (cached) return { output: cached.output, receipt: cached.executionReceipt, prompt, cacheHit: true as const };

  const cycleId = runtime.cycleId ?? `manual:${runtime.authorizationContextDigest}`;
  const inputCharacters = canonicalJson({ taskInput, evidenceBlocks: evidenceBlocks.map(({ content }) => content) }).length;
  const outputReservation = prompt.profile === "deep" ? 8_000 : prompt.profile === "reasoning" ? 4_000 : 2_000;
  const estimated = estimateKnowledgeModelCost({
    route: profile.route,
    model: profile.model,
    inputCharacters,
    maximumOutputTokens: Math.min(profile.maxOutputTokens, outputReservation),
  });
  if ((runtime.cycleBudgetUsd !== undefined || runtime.dailyBudgetUsd !== undefined) && !estimated) {
    throw new Error(`Knowledge maintenance model '${profile.route}:${profile.model}' has no qualified price.`);
  }
  const reservationId = sha256({ cycleId, cacheKey });
  const reservation = await runtime.store.reserveModelSpend({
    reservationId,
    cycleId,
    cacheKey,
    task: prompt.task,
    route: profile.route,
    model: profile.model,
    accessPolicyId,
    estimatedCostUsd: estimated?.estimatedCostUsd ?? 0,
    pricingVersion: estimated?.pricingVersion ?? "unrated-unenforced",
    cycleBudgetUsd: runtime.cycleBudgetUsd ?? 1_000,
    dailyBudgetUsd: runtime.dailyBudgetUsd ?? 1_000,
    reservedAt: usedAt,
  });
  if (reservation === "denied") throw new KnowledgeMaintenanceBudgetExceededError();
  if (reservation === "existing") {
    const replay = await runtime.store.getCachedModelTaskResult({ cacheKey, accessPolicyIds: runtime.accessPolicyIds, usedAt });
    if (replay) return { output: replay.output, receipt: replay.executionReceipt, prompt, cacheHit: true as const };
    throw new Error("Knowledge maintenance spend reservation exists without a reusable result.");
  }
  try {
    const executionProfile = { ...profile, maxOutputTokens: Math.min(profile.maxOutputTokens, outputReservation) };
    const executed = await executeKnowledgeModel({
    executor: runtime.executor,
    profile: executionProfile,
    requiredProfile: prompt.profile,
    completedAt: usedAt,
    request,
  });
    if (executed.receipt.outcome !== "succeeded") throw new Error(`Knowledge compounding task '${promptId}' did not succeed.`);
    if ((runtime.cycleBudgetUsd !== undefined || runtime.dailyBudgetUsd !== undefined) && executed.receipt.costStatus !== "rated") {
      throw new Error(`Knowledge maintenance model '${profile.route}:${profile.model}' returned unrated spend.`);
    }
    const result: CachedKnowledgeModelTaskResult = {
      cacheKey,
      task: prompt.task,
      promptId: prompt.promptId,
      promptVersion: prompt.version,
      promptContentHash: prompt.contentHash,
      inputDigest: executed.receipt.inputDigest,
      authorizationContextDigest: runtime.authorizationContextDigest,
      dataClass: runtime.dataClass,
      route: profile.route,
      model: profile.model,
      profileVersion: profile.profileVersion,
      accessPolicyId,
      output: executed.output,
      executionReceipt: executed.receipt,
      createdAt: usedAt,
    };
    await runtime.store.commitModelTaskResult({ reservationId, cycleId, result });
    return { ...executed, prompt, cacheHit: false as const };
  } catch (error) {
    await runtime.store.failModelSpend({ reservationId, failedAt: isoNow(runtime), failureDigest: sha256(error instanceof Error ? error.message : String(error)) });
    throw error;
  }
}

export class KnowledgeMaintenanceBudgetExceededError extends Error {
  constructor() { super("Knowledge maintenance spend budget is exhausted."); }
}

const proposalWithStableIdentity = (
  runtime: KnowledgeCompoundingRuntimeInput,
  base: Omit<ClaimPairProposalWrite, "proposalId" | "createdAt">,
): ClaimPairProposalWrite => ({ proposalId: sha256(base), ...base, createdAt: isoNow(runtime) });

async function shouldProcessExpensiveWork(
  runtime: KnowledgeCompoundingRuntimeInput,
  accessPolicyId: string,
  evidenceBlocks: Array<{ evidenceId: string; content: string; contentDigest: string }>,
  identity: Record<string, unknown>,
): Promise<boolean> {
  const result = await invoke(runtime, "knowledge.triage", {
    sourceKind: "knowledge-maintenance",
    contentCharacters: evidenceBlocks.reduce((total, block) => total + block.content.length, 0),
  }, evidenceBlocks, { triageFor: identity }, accessPolicyId);
  const output = result.output as Record<string, unknown>;
  return output.recommendedAction === "process";
}

const confidence = (value: unknown): number => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new Error("Knowledge compounding returned invalid confidence.");
  return number;
};

const offset = (continuation?: string): number => {
  if (!continuation) return 0;
  const value = Number(continuation);
  if (!Number.isInteger(value) || value < 0) throw new Error("Knowledge compounding continuation is invalid.");
  return value;
};

const phaseResult = (processed: number, next: number, total: number, evidence: unknown) => ({
  processed,
  total,
  complete: next >= total,
  ...(next < total ? { continuation: String(next) } : {}),
  evidenceDigest: sha256(evidence),
});

class WorkingSynthesisValidationError extends Error {}

const validateWorkingSynthesisOutput = (
  output: Record<string, unknown>,
  claimIds: ReadonlySet<string>,
): Pick<WorkingSynthesisWrite, "supportingClaimIds" | "contestedClaimIds" | "supersededClaimIds"> => {
  const list = (name: string): string[] => {
    const value = output[name];
    if (!Array.isArray(value)) throw new WorkingSynthesisValidationError(`Working synthesis '${name}' is invalid.`);
    const ids = value.map(String).map((id) => {
      const fromEvidenceIdentity = id.startsWith("claim:") ? id.slice("claim:".length) : "";
      return fromEvidenceIdentity && claimIds.has(fromEvidenceIdentity) ? fromEvidenceIdentity : id;
    });
    if (ids.some((id) => !claimIds.has(id))) throw new WorkingSynthesisValidationError("Working synthesis cited a Claim outside its authorized subject set.");
    return [...new Set(ids)].sort();
  };
  const supportingClaimIds = list("supportingClaimIds");
  const contestedClaimIds = list("contestedClaimIds");
  const supersededClaimIds = list("supersededClaimIds");
  const classified = [...supportingClaimIds, ...contestedClaimIds, ...supersededClaimIds];
  if (new Set(classified).size !== classified.length) throw new WorkingSynthesisValidationError("Working synthesis classified the same Claim more than once.");
  return { supportingClaimIds, contestedClaimIds, supersededClaimIds };
};

const pairClaims = async (runtime: KnowledgeCompoundingRuntimeInput, budget: number, mode: "duplicate" | "relation" | "conflict") =>
  selectCompoundingClaimPairs(
    await runtime.store.listClaims({ accessPolicyIds: runtime.accessPolicyIds, limit: 2_000 }),
    mode,
  );

function duplicatePhase(runtime: KnowledgeCompoundingRuntimeInput, budget: number): CompoundingPhase {
  return { name: "consolidate", scope: "mixed", budget, execute: async ({ continuation }) => {
    const pairs = await pairClaims(runtime, budget, "duplicate");
    const start = offset(continuation);
    const selected = pairs.slice(start, start + budget);
    const proposalIds: string[] = [];
    for (const [left, right] of selected) {
      if (normalizedClaimText(left.claimText) === normalizedClaimText(right.claimText)) {
        const deterministicReceiptId = sha256({
          ruleVersion: KNOWLEDGE_COMPOUNDING_CANDIDATE_RULE_VERSION,
          rule: "exact-normalized-claim-duplicate",
          left: claimEvidence(left).contentDigest,
          right: claimEvidence(right).contentDigest,
        });
        const proposal = proposalWithStableIdentity(runtime, {
          leftClaimId: left.claimId,
          rightClaimId: right.claimId,
          proposalKind: "duplicate",
          judgment: "duplicate",
          confidence: 1,
          rationale: "The normalized Claim text is identical within the same subject and access policy.",
          details: { classification: "duplicate", method: "deterministic-exact-normalized-text", ruleVersion: KNOWLEDGE_COMPOUNDING_CANDIDATE_RULE_VERSION },
          modelReceiptId: deterministicReceiptId,
          promptIdentity: `deterministic.exact-duplicate@${KNOWLEDGE_COMPOUNDING_CANDIDATE_RULE_VERSION}`,
          accessPolicyId: left.accessPolicyId,
        });
        await runtime.store.putClaimPairProposal(proposal);
        proposalIds.push(proposal.proposalId);
        continue;
      }
      const executed = await invoke(runtime, "knowledge.duplicate-classification", { leftIdentity: left.claimId, rightIdentity: right.claimId }, [claimEvidence(left), claimEvidence(right)], { leftClaimId: left.claimId, rightClaimId: right.claimId }, left.accessPolicyId);
      const output = executed.output as Record<string, unknown>;
      if (output.leftIdentity !== left.claimId || output.rightIdentity !== right.claimId) throw new Error("Duplicate classification changed a supplied Claim identity.");
      const judgment = String(output.classification);
      if (!["distinct", "duplicate", "supersedes", "uncertain"].includes(judgment)) throw new Error("Duplicate classification returned an invalid judgment.");
      if (judgment === "distinct") continue;
      const proposal = proposalWithStableIdentity(runtime, {
        leftClaimId: left.claimId, rightClaimId: right.claimId, proposalKind: "duplicate" as const,
        judgment, confidence: confidence(output.confidence), rationale: String(output.rationale),
        details: { classification: judgment }, modelReceiptId: executed.receipt.receiptId,
        promptIdentity: promptIdentity(executed.prompt), accessPolicyId: left.accessPolicyId,
      });
      await runtime.store.putClaimPairProposal(proposal);
      proposalIds.push(proposal.proposalId);
    }
    return phaseResult(selected.length, start + selected.length, pairs.length, { mode: "duplicate", pairs: selected.map(([left, right]) => [left.claimId, right.claimId]), proposalIds });
  } };
}

function relationPhase(runtime: KnowledgeCompoundingRuntimeInput, budget: number): CompoundingPhase {
  return { name: "exact-links", scope: "mixed", budget, execute: async ({ continuation }) => {
    const pairs = await pairClaims(runtime, budget, "relation");
    const start = offset(continuation);
    const selected = pairs.slice(start, start + budget);
    const proposalIds: string[] = [];
    for (const [left, right] of selected) {
      const allowed = new Set([left.claimId, right.claimId]);
      const evidence = [claimEvidence(left), claimEvidence(right)];
      if (!await shouldProcessExpensiveWork(runtime, left.accessPolicyId, evidence, { task: "claim-relation", leftClaimId: left.claimId, rightClaimId: right.claimId })) continue;
      const executed = await invoke(runtime, "knowledge.claim-relation", { claimIds: [...allowed] }, evidence, { leftClaimId: left.claimId, rightClaimId: right.claimId }, left.accessPolicyId);
      const relations = (executed.output as { relations?: unknown[] }).relations ?? [];
      if (!Array.isArray(relations)) throw new Error("Claim relation output is invalid.");
      for (const raw of relations) {
        const relation = raw as Record<string, unknown>;
        const sourceClaimId = String(relation.sourceClaimId);
        const targetClaimId = String(relation.targetClaimId);
        const judgment = String(relation.relation);
        if (!allowed.has(sourceClaimId) || !allowed.has(targetClaimId) || sourceClaimId === targetClaimId || !["supports", "contradicts", "refines", "supersedes"].includes(judgment)) throw new Error("Claim relation escaped its bounded candidate pair.");
        const proposal = proposalWithStableIdentity(runtime, {
          leftClaimId: sourceClaimId, rightClaimId: targetClaimId, proposalKind: "relation" as const,
          judgment, confidence: confidence(relation.confidence), rationale: String(relation.rationale),
          details: { relation: judgment }, modelReceiptId: executed.receipt.receiptId,
          promptIdentity: promptIdentity(executed.prompt), accessPolicyId: left.accessPolicyId,
        });
        await runtime.store.putClaimPairProposal(proposal);
        proposalIds.push(proposal.proposalId);
      }
    }
    return phaseResult(selected.length, start + selected.length, pairs.length, { mode: "relation", pairs: selected.map(([left, right]) => [left.claimId, right.claimId]), proposalIds });
  } };
}

function conflictPhase(runtime: KnowledgeCompoundingRuntimeInput, budget: number): CompoundingPhase {
  return { name: "conflicts", scope: "global", budget, execute: async ({ continuation }) => {
    const pairs = await pairClaims(runtime, budget, "conflict");
    const start = offset(continuation);
    const selected = pairs.slice(start, start + budget);
    const proposalIds: string[] = [];
    for (const [left, right] of selected) {
      const executed = await invoke(runtime, "knowledge.conflict-judgment", { leftClaimId: left.claimId, rightClaimId: right.claimId }, [claimEvidence(left), claimEvidence(right)], { leftClaimId: left.claimId, rightClaimId: right.claimId }, left.accessPolicyId);
      const output = executed.output as Record<string, unknown>;
      if (output.leftClaimId !== left.claimId || output.rightClaimId !== right.claimId) throw new Error("Conflict judgment changed a supplied Claim identity.");
      const judgment = String(output.judgment);
      const severity = String(output.severity);
      if (!["conflict", "compatible", "uncertain"].includes(judgment) || !["none", "low", "medium", "high"].includes(severity)) throw new Error("Conflict judgment is invalid.");
      if (judgment === "compatible") continue;
      const proposal = proposalWithStableIdentity(runtime, {
        leftClaimId: left.claimId, rightClaimId: right.claimId, proposalKind: "conflict" as const,
        judgment, severity, confidence: judgment === "conflict" ? 1 : 0.5, rationale: String(output.rationale),
        details: { judgment, severity }, modelReceiptId: executed.receipt.receiptId,
        promptIdentity: promptIdentity(executed.prompt), accessPolicyId: left.accessPolicyId,
      });
      await runtime.store.putClaimPairProposal(proposal);
      proposalIds.push(proposal.proposalId);
    }
    return phaseResult(selected.length, start + selected.length, pairs.length, { mode: "conflict", pairs: selected.map(([left, right]) => [left.claimId, right.claimId]), proposalIds });
  } };
}

function synthesisPhase(runtime: KnowledgeCompoundingRuntimeInput, budget: number): CompoundingPhase {
  return { name: "syntheses", scope: "global", budget, execute: async ({ continuation }) => {
    const claims = await runtime.store.listClaims({ accessPolicyIds: runtime.accessPolicyIds, limit: 2_000 });
    const groups = new Map<string, CompoundingClaim[]>();
    for (const claim of claims) for (const subjectId of claim.subjectIds) {
      const key = `${claim.accessPolicyId}\0${subjectId}`;
      groups.set(key, [...(groups.get(key) ?? []), claim]);
    }
    const ordered = [...groups.entries()].filter(([, entries]) => entries.length > 1).sort(([a], [b]) => a.localeCompare(b));
    const work = ordered.flatMap(([key, entries]) => {
      const sorted = [...entries].sort((left, right) => left.claimId.localeCompare(right.claimId));
      const chunkCount = Math.ceil(sorted.length / KNOWLEDGE_WORKING_SYNTHESIS_CLAIM_CHUNK_SIZE);
      return Array.from({ length: chunkCount }, (_, chunkIndex) => ({
        key,
        group: sorted,
        chunkIndex,
        chunkCount,
        chunk: sorted.slice(
          chunkIndex * KNOWLEDGE_WORKING_SYNTHESIS_CLAIM_CHUNK_SIZE,
          (chunkIndex + 1) * KNOWLEDGE_WORKING_SYNTHESIS_CLAIM_CHUNK_SIZE,
        ),
      }));
    });
    const start = offset(continuation);
    const selected = work.slice(start, start + budget);
    const synthesisIds: string[] = [];
    for (const item of selected) {
      const { key, group, chunkIndex, chunkCount, chunk } = item;
      const [accessPolicyId, subjectIdentity] = key.split("\0") as [string, string];
      const executeChunk = async (claimsInChunk: CompoundingClaim[], index: number) => {
        const claimIds = new Set(claimsInChunk.map((claim) => claim.claimId));
        const evidence = claimsInChunk.map(claimEvidence);
        const identity = { subjectIdentity, chunkIndex: index + 1, chunkCount, claimIds: [...claimIds].sort() };
        if (!await shouldProcessExpensiveWork(runtime, accessPolicyId, evidence, { task: "working-synthesis", ...identity })) return undefined;
        const taskInput = { subjectIdentity, chunkIndex: index + 1, chunkCount };
        let executed = await invoke(runtime, "knowledge.working-synthesis", taskInput, evidence, identity, accessPolicyId);
        let output = executed.output as Record<string, unknown>;
        let classification: ReturnType<typeof validateWorkingSynthesisOutput>;
        try {
          classification = validateWorkingSynthesisOutput(output, claimIds);
        } catch (error) {
          if (!(error instanceof WorkingSynthesisValidationError)) throw error;
          executed = await invoke(runtime, "knowledge.working-synthesis", {
            ...taskInput,
            validationFeedbackCode: "claim-partitions-must-be-disjoint-and-bounded",
          }, evidence, { ...identity, validationAttempt: 2 }, accessPolicyId);
          output = executed.output as Record<string, unknown>;
          classification = validateWorkingSynthesisOutput(output, claimIds);
        }
        return { executed, output, classification };
      };
      const current = await executeChunk(chunk, chunkIndex);
      if (!current || chunkIndex + 1 < chunkCount) continue;

      // The final segment deterministically replays prior content-addressed
      // segment results from cache and merges them without another model call.
      const components = [] as NonNullable<Awaited<ReturnType<typeof executeChunk>>>[];
      for (let index = 0; index < chunkCount; index += 1) {
        const claimsInChunk = group.slice(
          index * KNOWLEDGE_WORKING_SYNTHESIS_CLAIM_CHUNK_SIZE,
          (index + 1) * KNOWLEDGE_WORKING_SYNTHESIS_CLAIM_CHUNK_SIZE,
        );
        const component = index === chunkIndex ? current : await executeChunk(claimsInChunk, index);
        if (component) components.push(component);
      }
      if (components.length !== chunkCount) continue;
      const classifications = components.map((component) => component.classification);
      const synthesis: WorkingSynthesisWrite = {
        subjectIdentity,
        title: String(components[0]!.output.title),
        body: components.length === 1
          ? String(components[0]!.output.body)
          : components.map((component, index) => `## Evidence segment ${index + 1} of ${components.length}\n\n${String(component.output.body)}`).join("\n\n"),
        supportingClaimIds: [...new Set(classifications.flatMap((entry) => entry.supportingClaimIds))].sort(),
        contestedClaimIds: [...new Set(classifications.flatMap((entry) => entry.contestedClaimIds))].sort(),
        supersededClaimIds: [...new Set(classifications.flatMap((entry) => entry.supersededClaimIds))].sort(),
        gaps: [...new Set(components.flatMap((component) => Array.isArray(component.output.gaps) ? component.output.gaps.map(String) : []))].sort(),
        accessPolicyId,
        modelReceipt: components.at(-1)!.executed.receipt,
        componentModelReceipts: components.map((component) => component.executed.receipt),
        synthesizedAt: isoNow(runtime),
      };
      await runtime.store.putWorkingSynthesis(synthesis);
      synthesisIds.push(sha256(synthesis));
    }
    return phaseResult(selected.length, start + selected.length, work.length, {
      chunks: selected.map((item) => ({ key: item.key, chunkIndex: item.chunkIndex + 1, chunkCount: item.chunkCount })),
      synthesisIds,
    });
  } };
}

function gradingPhase(runtime: KnowledgeCompoundingRuntimeInput, budget: number): CompoundingPhase {
  return { name: "grading", scope: "global", budget, execute: async ({ continuation }) => {
    const requests = await runtime.store.listPendingGradingRequests({ accessPolicyIds: runtime.accessPolicyIds, limit: 1_000 });
    const start = offset(continuation);
    const selected = requests.slice(start, start + budget);
    const receipts: string[] = [];
    for (const request of selected) {
      if (request.outcomeEvidence.length === 0) {
        await runtime.store.deferGradingRequest(request.requestId, "no-independent-postdating-outcome-evidence");
        continue;
      }
      const executed = await invoke(runtime, "knowledge.claim-grading", { claimId: request.claim.claimId, outcomeEvidenceIds: request.outcomeEvidenceIds }, [claimEvidence(request.claim), ...request.outcomeEvidence.map(({ evidenceId, content, contentDigest }) => ({ evidenceId, content, contentDigest }))], { requestId: request.requestId, claimId: request.claim.claimId, evidenceIds: request.outcomeEvidenceIds }, request.accessPolicyId);
      const output = executed.output as Record<string, unknown>;
      const outcome = String(output.grade) as ClaimGradingResultWrite["outcome"];
      const supportingEvidenceIds = Array.isArray(output.supportingEvidenceIds) ? output.supportingEvidenceIds.map(String) : [];
      if (output.claimId !== request.claim.claimId || !["correct", "incorrect", "partial", "unresolvable"].includes(outcome) || supportingEvidenceIds.some((id) => !request.outcomeEvidenceIds.includes(id))) throw new Error("Claim grading escaped its explicit request evidence.");
      await runtime.store.completeGradingRequest({ requestId: request.requestId, claimId: request.claim.claimId, outcome, confidence: confidence(output.confidence), rationale: String(output.rationale), supportingEvidenceIds, outcomeEvidence: request.outcomeEvidence, modelReceipt: executed.receipt, proposedAt: isoNow(runtime) });
      receipts.push(executed.receipt.receiptId);
    }
    return phaseResult(selected.length, start + selected.length, requests.length, { requestIds: selected.map((request) => request.requestId), receipts });
  } };
}

export function createProductiveKnowledgeCompoundingPhases(runtime: KnowledgeCompoundingRuntimeInput): readonly CompoundingPhase[] {
  if (runtime.accessPolicyIds.length === 0 || new Set(runtime.accessPolicyIds).size !== runtime.accessPolicyIds.length) throw new Error("Knowledge compounding requires unique authorized access policies.");
  if (!/^[a-f0-9]{64}$/.test(runtime.authorizationContextDigest)) throw new Error("Knowledge compounding requires an authorization context digest.");
  // One model-backed work item per phase keeps the portable default inside
  // common serverless invocation limits. Long-running hosts may opt into a
  // larger explicit budget without changing phase or receipt semantics.
  const budget = Math.max(1, Math.min(runtime.phaseBudget ?? 1, 50));
  return [duplicatePhase(runtime, budget), relationPhase(runtime, budget), conflictPhase(runtime, budget), synthesisPhase(runtime, Math.min(budget, 1)), gradingPhase(runtime, budget)];
}
