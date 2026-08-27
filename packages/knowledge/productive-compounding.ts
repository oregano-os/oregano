import { canonicalJson, sha256 } from "../runtime/canonical.ts";
import type { CompoundingPhase } from "./compounding.ts";
import {
  executeKnowledgeModel,
  type KnowledgeModelExecutionReceipt,
  type KnowledgeModelExecutor,
  type KnowledgeModelProfileBinding,
} from "./knowledge-model-execution.ts";
import { KnowledgePromptRegistry } from "./prompt-registry.ts";

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

export interface KnowledgeCompoundingWorkStore {
  listClaims(input: { accessPolicyIds: string[]; limit: number }): Promise<CompoundingClaim[]>;
  putClaimPairProposal(proposal: ClaimPairProposalWrite): Promise<"inserted" | "unchanged">;
  putWorkingSynthesis(synthesis: WorkingSynthesisWrite): Promise<"inserted" | "unchanged">;
  listPendingGradingRequests(input: { accessPolicyIds: string[]; limit: number }): Promise<ClaimGradingWorkItem[]>;
  completeGradingRequest(result: ClaimGradingResultWrite): Promise<"inserted" | "unchanged">;
  deferGradingRequest(requestId: string, reason: string): Promise<void>;
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
}

type Pair = readonly [CompoundingClaim, CompoundingClaim];

const isoNow = (input: KnowledgeCompoundingRuntimeInput): string => input.now?.() ?? new Date().toISOString();

const words = (value: string): Set<string> => new Set(
  value.toLocaleLowerCase("en").match(/[\p{L}\p{N}]{3,}/gu) ?? [],
);

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
      if (mode === "duplicate" && lexicalOverlap(left.claimText, right.claimText) < 0.2) continue;
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
) {
  const prompt = new KnowledgePromptRegistry().resolveCurrent(promptId);
  const executed = await executeKnowledgeModel({
    executor: runtime.executor,
    profile: runtime.resolveProfile(promptId),
    requiredProfile: prompt.profile,
    completedAt: isoNow(runtime),
    request: {
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
    },
  });
  if (executed.receipt.outcome !== "succeeded") throw new Error(`Knowledge compounding task '${promptId}' did not succeed.`);
  return { ...executed, prompt };
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
    const ids = value.map(String);
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
    await runtime.store.listClaims({ accessPolicyIds: runtime.accessPolicyIds, limit: Math.min(Math.max(budget * 4, 20), 200) }),
    mode,
  );

function duplicatePhase(runtime: KnowledgeCompoundingRuntimeInput, budget: number): CompoundingPhase {
  return { name: "consolidate", scope: "mixed", budget, execute: async ({ continuation }) => {
    const pairs = await pairClaims(runtime, budget, "duplicate");
    const start = offset(continuation);
    const selected = pairs.slice(start, start + budget);
    const proposalIds: string[] = [];
    for (const [left, right] of selected) {
      const executed = await invoke(runtime, "knowledge.duplicate-classification", { leftIdentity: left.claimId, rightIdentity: right.claimId }, [claimEvidence(left), claimEvidence(right)], { leftClaimId: left.claimId, rightClaimId: right.claimId });
      const output = executed.output as Record<string, unknown>;
      if (output.leftIdentity !== left.claimId || output.rightIdentity !== right.claimId) throw new Error("Duplicate classification changed a supplied Claim identity.");
      const judgment = String(output.classification);
      if (!["distinct", "duplicate", "supersedes", "uncertain"].includes(judgment)) throw new Error("Duplicate classification returned an invalid judgment.");
      if (judgment === "distinct") continue;
      const base = {
        leftClaimId: left.claimId, rightClaimId: right.claimId, proposalKind: "duplicate" as const,
        judgment, confidence: confidence(output.confidence), rationale: String(output.rationale),
        details: { classification: judgment }, modelReceiptId: executed.receipt.receiptId,
        promptIdentity: promptIdentity(executed.prompt), accessPolicyId: left.accessPolicyId, createdAt: isoNow(runtime),
      };
      const proposal = { proposalId: sha256(base), ...base };
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
      const executed = await invoke(runtime, "knowledge.claim-relation", { claimIds: [...allowed] }, [claimEvidence(left), claimEvidence(right)], { leftClaimId: left.claimId, rightClaimId: right.claimId });
      const relations = (executed.output as { relations?: unknown[] }).relations ?? [];
      if (!Array.isArray(relations)) throw new Error("Claim relation output is invalid.");
      for (const raw of relations) {
        const relation = raw as Record<string, unknown>;
        const sourceClaimId = String(relation.sourceClaimId);
        const targetClaimId = String(relation.targetClaimId);
        const judgment = String(relation.relation);
        if (!allowed.has(sourceClaimId) || !allowed.has(targetClaimId) || sourceClaimId === targetClaimId || !["supports", "contradicts", "refines", "supersedes"].includes(judgment)) throw new Error("Claim relation escaped its bounded candidate pair.");
        const base = {
          leftClaimId: sourceClaimId, rightClaimId: targetClaimId, proposalKind: "relation" as const,
          judgment, confidence: confidence(relation.confidence), rationale: String(relation.rationale),
          details: { relation: judgment }, modelReceiptId: executed.receipt.receiptId,
          promptIdentity: promptIdentity(executed.prompt), accessPolicyId: left.accessPolicyId, createdAt: isoNow(runtime),
        };
        const proposal = { proposalId: sha256(base), ...base };
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
      const executed = await invoke(runtime, "knowledge.conflict-judgment", { leftClaimId: left.claimId, rightClaimId: right.claimId }, [claimEvidence(left), claimEvidence(right)], { leftClaimId: left.claimId, rightClaimId: right.claimId });
      const output = executed.output as Record<string, unknown>;
      if (output.leftClaimId !== left.claimId || output.rightClaimId !== right.claimId) throw new Error("Conflict judgment changed a supplied Claim identity.");
      const judgment = String(output.judgment);
      const severity = String(output.severity);
      if (!["conflict", "compatible", "uncertain"].includes(judgment) || !["none", "low", "medium", "high"].includes(severity)) throw new Error("Conflict judgment is invalid.");
      if (judgment === "compatible") continue;
      const base = {
        leftClaimId: left.claimId, rightClaimId: right.claimId, proposalKind: "conflict" as const,
        judgment, severity, confidence: judgment === "conflict" ? 1 : 0.5, rationale: String(output.rationale),
        details: { judgment, severity }, modelReceiptId: executed.receipt.receiptId,
        promptIdentity: promptIdentity(executed.prompt), accessPolicyId: left.accessPolicyId, createdAt: isoNow(runtime),
      };
      const proposal = { proposalId: sha256(base), ...base };
      await runtime.store.putClaimPairProposal(proposal);
      proposalIds.push(proposal.proposalId);
    }
    return phaseResult(selected.length, start + selected.length, pairs.length, { mode: "conflict", pairs: selected.map(([left, right]) => [left.claimId, right.claimId]), proposalIds });
  } };
}

function synthesisPhase(runtime: KnowledgeCompoundingRuntimeInput, budget: number): CompoundingPhase {
  return { name: "syntheses", scope: "global", budget, execute: async ({ continuation }) => {
    const claims = await runtime.store.listClaims({ accessPolicyIds: runtime.accessPolicyIds, limit: Math.min(Math.max(budget * 20, 100), 1_000) });
    const groups = new Map<string, CompoundingClaim[]>();
    for (const claim of claims) for (const subjectId of claim.subjectIds) {
      const key = `${claim.accessPolicyId}\0${subjectId}`;
      groups.set(key, [...(groups.get(key) ?? []), claim]);
    }
    const ordered = [...groups.entries()].filter(([, entries]) => entries.length > 1).sort(([a], [b]) => a.localeCompare(b));
    const start = offset(continuation);
    const selected = ordered.slice(start, start + budget);
    const synthesisIds: string[] = [];
    for (const [key, group] of selected) {
      const [accessPolicyId, subjectIdentity] = key.split("\0") as [string, string];
      const claimIds = new Set(group.map((claim) => claim.claimId));
      const evidence = group.map(claimEvidence);
      const identity = { subjectIdentity, claimIds: [...claimIds].sort() };
      let executed = await invoke(runtime, "knowledge.working-synthesis", { subjectIdentity }, evidence, identity);
      let output = executed.output as Record<string, unknown>;
      let classification: ReturnType<typeof validateWorkingSynthesisOutput>;
      try {
        classification = validateWorkingSynthesisOutput(output, claimIds);
      } catch (error) {
        if (!(error instanceof WorkingSynthesisValidationError)) throw error;
        executed = await invoke(runtime, "knowledge.working-synthesis", {
          subjectIdentity,
          validationFeedbackCode: "claim-partitions-must-be-disjoint-and-bounded",
        }, evidence, { ...identity, validationAttempt: 2 });
        output = executed.output as Record<string, unknown>;
        classification = validateWorkingSynthesisOutput(output, claimIds);
      }
      const synthesis: WorkingSynthesisWrite = {
        subjectIdentity,
        title: String(output.title),
        body: String(output.body),
        ...classification,
        gaps: Array.isArray(output.gaps) ? output.gaps.map(String) : [],
        accessPolicyId,
        modelReceipt: executed.receipt,
        synthesizedAt: isoNow(runtime),
      };
      await runtime.store.putWorkingSynthesis(synthesis);
      synthesisIds.push(sha256(synthesis));
    }
    return phaseResult(selected.length, start + selected.length, ordered.length, { subjects: selected.map(([key]) => key), synthesisIds });
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
      const executed = await invoke(runtime, "knowledge.claim-grading", { claimId: request.claim.claimId, outcomeEvidenceIds: request.outcomeEvidenceIds }, [claimEvidence(request.claim), ...request.outcomeEvidence.map(({ evidenceId, content, contentDigest }) => ({ evidenceId, content, contentDigest }))], { requestId: request.requestId, claimId: request.claim.claimId, evidenceIds: request.outcomeEvidenceIds });
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
  return [duplicatePhase(runtime, budget), relationPhase(runtime, budget), conflictPhase(runtime, budget), synthesisPhase(runtime, budget), gradingPhase(runtime, budget)];
}
