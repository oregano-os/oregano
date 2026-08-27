import { canonicalJson, sha256 } from "../runtime/canonical.ts";
import {
  CORE_BRAIN_PAGE_TAXONOMY,
  createBrainClaim,
  createBrainPageVersion,
  createEntityIdentity,
  createEntityIdentityMembership,
  type BrainClaim,
  type BrainPage,
  type BrainPageTypeDefinition,
  type BrainPageVersion,
  type ClaimEvidenceLocator,
  type EntityIdentity,
  type EntityIdentityMembership,
  type EpistemicHolder,
  type FactClaimKind,
  type TakeClaimKind,
} from "./brain-contracts.ts";
import type { BrainClaimRelation, BrainStore, BrainTimelineEvent } from "./brain-store.ts";
import {
  executeKnowledgeModel,
  type KnowledgeModelExecutionReceipt,
  type KnowledgeModelExecutor,
  type KnowledgeModelProfileBinding,
} from "./knowledge-model-execution.ts";
import { KnowledgePromptRegistry } from "./prompt-registry.ts";
import type { SourceRawEvidenceV2 } from "./source-pipeline-store.ts";

export interface KnowledgeExtractionRun {
  runId: string;
  runKey: string;
  inputDigest: string;
  promptVersions: string[];
  schemaVersion: string;
  modelProfileIdentity: string;
  status: "running" | "succeeded" | "failed" | "deferred";
  result?: KnowledgeExtractionResult;
  receiptIds: string[];
  failureClass?: "refusal" | "truncated" | "parse-failure" | "provider-failure" | "budget-deferral" | "validation-failure";
}

export interface KnowledgeExtractionRunStore {
  getByRunKey(runKey: string): Promise<KnowledgeExtractionRun | undefined>;
  put(run: KnowledgeExtractionRun): Promise<"inserted" | "unchanged">;
}

export interface KnowledgeExtractionResult {
  runId: string;
  page: BrainPage;
  pageVersion: BrainPageVersion;
  claims: BrainClaim[];
  participantRelations: Array<{ claimId: string; relation: "speaker" | "author" | "subject" | "approver" | "owner" | "beneficiary" | "affected-party"; principalId: string }>;
  timeline: Array<{ eventType: string; description: string; observedAt: string; locator: ClaimEvidenceLocator }>;
  modelReceipts: KnowledgeModelExecutionReceipt[];
}

export class InMemoryKnowledgeExtractionRunStore implements KnowledgeExtractionRunStore {
  readonly runs = new Map<string, KnowledgeExtractionRun>();
  async getByRunKey(runKey: string): Promise<KnowledgeExtractionRun | undefined> { const value = this.runs.get(runKey); return value ? structuredClone(value) : undefined; }
  async put(run: KnowledgeExtractionRun): Promise<"inserted" | "unchanged"> {
    const existing = this.runs.get(run.runKey);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(run)) throw new Error(`Extraction run '${run.runKey}' was reused with different state.`);
      return "unchanged";
    }
    this.runs.set(run.runKey, structuredClone(run));
    return "inserted";
  }
}

export function knowledgeExtractionRunIdentity(input: {
  evidence: SourceRawEvidenceV2;
  reasoningProfile: KnowledgeModelProfileBinding;
  authorizationContextDigest: string;
  promptRegistry?: KnowledgePromptRegistry;
}) {
  const extractionPrompt = (input.promptRegistry ?? new KnowledgePromptRegistry()).resolveCurrent("knowledge.claim-extraction");
  const modelIdentity = `${input.reasoningProfile.profile}@${input.reasoningProfile.profileVersion}:${input.reasoningProfile.route}:${input.reasoningProfile.model}`;
  const inputDigest = sha256({ envelope: input.evidence.envelope, contentDigest: input.evidence.envelope.contentDigest, authorizationContextDigest: input.authorizationContextDigest });
  const runKey = sha256({ inputDigest, prompt: extractionPrompt.contentHash, schema: extractionPrompt.outputSchemaId, modelIdentity });
  return { extractionPrompt, modelIdentity, inputDigest, runKey, runId: sha256({ runKey, attemptClass: "canonical" }) };
}

const pathTypeRules: Array<[RegExp, string]> = [
  [/(?:^|\/)(?:people|persons)(?:\/|$)/i, "person"],
  [/(?:^|\/)(?:companies|organizations)(?:\/|$)/i, "company"],
  [/(?:^|\/)(?:meetings|transcripts)(?:\/|$)/i, "meeting"],
  [/(?:^|\/)(?:projects)(?:\/|$)/i, "project"],
  [/(?:^|\/)(?:deals)(?:\/|$)/i, "deal"],
  [/(?:^|\/)(?:emails)(?:\/|$)/i, "email"],
  [/(?:^|\/)(?:diary|journals)(?:\/|$)/i, "diary"],
];

export function classifyPageTypeDeterministically(input: {
  declaredType?: string;
  locator: string;
  sourceKind?: string;
  registry?: readonly BrainPageTypeDefinition[];
}): { typeKey?: string; basis: "declared-key" | "declared-alias" | "path-rule" | "source-kind" | "unresolved" } {
  const registry = input.registry ?? CORE_BRAIN_PAGE_TAXONOMY;
  const declared = input.declaredType?.trim().toLocaleLowerCase("en");
  if (declared) {
    const exact = registry.find((entry) => entry.status === "active" && entry.key === declared);
    if (exact) return { typeKey: exact.key, basis: "declared-key" };
    const alias = registry.find((entry) => entry.status === "active" && entry.aliases.includes(declared));
    if (alias) return { typeKey: alias.key, basis: "declared-alias" };
  }
  for (const [pattern, typeKey] of pathTypeRules) if (pattern.test(input.locator) && registry.some((entry) => entry.key === typeKey && entry.status === "active")) return { typeKey, basis: "path-rule" };
  const sourceMapping: Record<string, string> = { meeting: "meeting", email: "email", messaging: "slack", session: "conversation" };
  const mapped = input.sourceKind ? sourceMapping[input.sourceKind] : undefined;
  if (mapped && registry.some((entry) => entry.key === mapped && entry.status === "active")) return { typeKey: mapped, basis: "source-kind" };
  return { basis: "unresolved" };
}

export async function linkDeterministicProviderIdentity(input: {
  store: BrainStore;
  page: BrainPage;
  entityKind: "person" | "organization" | "project" | "deal" | "concept" | "other";
  providerStableKey: string;
  displayName: string;
  receiptId: string;
  createdAt: string;
}): Promise<{ entity: EntityIdentity; membership: EntityIdentityMembership }> {
  const entity = createEntityIdentity({ entityKind: input.entityKind, stableKey: input.providerStableKey, displayName: input.displayName, creationBasis: "provider-identifier", creationReceiptId: input.receiptId, createdAt: input.createdAt });
  await input.store.putEntityIdentity(entity);
  const membership = createEntityIdentityMembership({ entity, page: input.page, proofBasis: "provider-identifier", proofReceiptId: input.receiptId, createdAt: input.createdAt });
  await input.store.putEntityMembership(membership);
  return { entity, membership };
}

interface ModelClaimOutput {
  memoryClass: "fact" | "take";
  claimKind: FactClaimKind | TakeClaimKind;
  claimText: string;
  ownerPrincipalId?: string;
  holder?: EpistemicHolder;
  derivation?: "source-literal" | "model-derived";
  evidenceId: string;
  locator: ClaimEvidenceLocator;
  extractionConfidence: number;
  epistemicWeight: number;
  participantRelations?: Array<{ relation: KnowledgeExtractionResult["participantRelations"][number]["relation"]; principalId: string }>;
}

interface ModelExtractionOutput {
  page: { title: string; summary?: string };
  claims: ModelClaimOutput[];
  timeline?: KnowledgeExtractionResult["timeline"];
}

const CANONICAL_HOLDER_PATTERN = /^(world|brain|people\/[a-z0-9._-]+|companies\/[a-z0-9._-]+)$/;

const canonicalHolder = (value: Record<string, unknown>): EpistemicHolder => {
  const holderId = typeof value.holderId === "string" ? value.holderId.trim() : "";
  const holderType = value.holderType;
  if (!CANONICAL_HOLDER_PATTERN.test(holderId)) throw new Error("Extracted Take Holder is not canonical.");
  const expectedType = holderId === "world" ? "world" : holderId === "brain" ? "system" : holderId.startsWith("people/") ? "person" : "company";
  if (holderType !== expectedType) throw new Error("Extracted Take Holder type does not match its canonical identity.");
  return { holderId, holderType: expectedType, displayName: holderId };
};

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
};

const validateLocator = (value: unknown, text: string): ClaimEvidenceLocator => {
  const locator = object(value, "Model evidence locator");
  const lines = text.split("\n");
  if (locator.kind === "line" && Number.isInteger(locator.start) && Number.isInteger(locator.end) && Number(locator.start) >= 1 && Number(locator.end) >= Number(locator.start) && Number(locator.end) <= lines.length) return { kind: "line", start: Number(locator.start), end: Number(locator.end) };
  if (locator.kind === "timestamp" && typeof locator.startMs === "number" && typeof locator.endMs === "number" && locator.startMs >= 0 && locator.endMs >= locator.startMs) return { kind: "timestamp", startMs: locator.startMs, endMs: locator.endMs };
  throw new Error("Model evidence locator is outside the authorized bounded input.");
};

const validateExtractionOutput = (value: unknown, text: string, evidenceId: string): ModelExtractionOutput => {
  const root = object(value, "Extraction output");
  const page = object(root.page, "Extraction output.page");
  if (typeof page.title !== "string" || !page.title.trim() || page.title.length > 500) throw new Error("Extraction output Page title is invalid.");
  if (page.summary !== undefined && (typeof page.summary !== "string" || page.summary.length > 4_000)) throw new Error("Extraction output Page summary is invalid.");
  if (!Array.isArray(root.facts) || root.facts.length > 200 || !Array.isArray(root.takes) || root.takes.length > 200) throw new Error("Extraction output Facts and Takes must be bounded arrays.");
  const validateClaim = (raw: unknown, memoryClass: "fact" | "take", index: number): ModelClaimOutput => {
    const claim = object(raw, `Extraction output.${memoryClass === "fact" ? "facts" : "takes"}[${index}]`);
    if (typeof claim.claimText !== "string" || !claim.claimText.trim() || claim.claimText.length > 10_000) throw new Error("Extraction output Claim identity is invalid.");
    if (claim.evidenceId !== evidenceId) throw new Error("Model Claim cited evidence outside its authorized context.");
    if (typeof claim.extractionConfidence !== "number" || claim.extractionConfidence < 0 || claim.extractionConfidence > 1) throw new Error("Model Claim confidence is invalid.");
    if (typeof claim.epistemicWeight !== "number" || claim.epistemicWeight < 0 || claim.epistemicWeight > 1) throw new Error("Model Claim epistemic weight is invalid.");
    const participantRelations = claim.participantRelations === undefined ? undefined : (Array.isArray(claim.participantRelations) ? claim.participantRelations.map((rawRelation) => {
      const relation = object(rawRelation, "Claim participant relation");
      if (!['speaker', 'author', 'subject', 'approver', 'owner', 'beneficiary', 'affected-party'].includes(String(relation.relation)) || typeof relation.principalId !== "string" || !relation.principalId.trim()) throw new Error("Claim participant relation is invalid.");
      return { relation: relation.relation as KnowledgeExtractionResult["participantRelations"][number]["relation"], principalId: relation.principalId };
    }) : (() => { throw new Error("Claim participant relations must be an array."); })());
    if (memoryClass === "fact" && (typeof claim.ownerPrincipalId !== "string" || !claim.ownerPrincipalId.trim())) throw new Error("Extracted Fact requires its principal owner.");
    if (memoryClass === "take") {
      const holder = object(claim.holder, "Extracted Take Holder");
      const normalizedHolder = canonicalHolder(holder);
      if (!['source-literal', 'model-derived'].includes(String(claim.derivation))) throw new Error("Extracted Take derivation is invalid.");
      if (claim.derivation === "model-derived" && normalizedHolder.holderId !== "brain") throw new Error("A model-derived Take requires the brain Holder.");
      claim.holder = normalizedHolder;
    }
    return { ...(claim as unknown as ModelClaimOutput), memoryClass, locator: validateLocator(claim.locator, text), participantRelations };
  };
  const claims = [
    ...root.facts.map((raw, index) => validateClaim(raw, "fact", index)),
    ...root.takes.map((raw, index) => validateClaim(raw, "take", index)),
  ];
  const timeline = root.timeline === undefined ? [] : (Array.isArray(root.timeline) ? root.timeline.map((rawEvent) => {
    const event = object(rawEvent, "Timeline event");
    if (typeof event.eventType !== "string" || typeof event.description !== "string" || typeof event.observedAt !== "string" || Number.isNaN(Date.parse(event.observedAt))) throw new Error("Timeline event is invalid.");
    return { eventType: event.eventType, description: event.description, observedAt: new Date(event.observedAt).toISOString(), locator: validateLocator(event.locator, text) };
  }) : (() => { throw new Error("Timeline must be an array."); })());
  return { page: { title: page.title.trim(), ...(typeof page.summary === "string" && page.summary.trim() ? { summary: page.summary.trim() } : {}) }, claims, timeline };
};

export async function extractRawEvidenceToBrain(input: {
  evidence: SourceRawEvidenceV2;
  sourceKind: string;
  declaredPageType?: string;
  ownerPrincipalId: string;
  brainStore: BrainStore;
  runStore: KnowledgeExtractionRunStore;
  modelExecutor: KnowledgeModelExecutor;
  profiles: { utility: KnowledgeModelProfileBinding; reasoning: KnowledgeModelProfileBinding };
  promptRegistry?: KnowledgePromptRegistry;
  authorizationContextDigest: string;
  dataClass: "business" | "confidential" | "restricted" | "personal";
  now?: string;
}): Promise<KnowledgeExtractionResult> {
  if (!input.evidence.modelReady || input.evidence.payloadState !== "active" || input.evidence.envelope.deletionState !== "present") throw new Error("Raw Evidence is not authorized and ready for extraction.");
  const text = input.evidence.content && "inlineText" in input.evidence.content ? input.evidence.content.inlineText : undefined;
  if (!text) throw new Error("This extraction path requires authorized inline Raw Evidence.");
  const prompts = input.promptRegistry ?? new KnowledgePromptRegistry();
  const { extractionPrompt, modelIdentity, inputDigest, runKey, runId } = knowledgeExtractionRunIdentity({
    evidence: input.evidence,
    reasoningProfile: input.profiles.reasoning,
    authorizationContextDigest: input.authorizationContextDigest,
    promptRegistry: prompts,
  });
  const existing = await input.runStore.getByRunKey(runKey);
  if (existing?.status === "succeeded" && existing.result) return existing.result;
  const now = new Date(input.now ?? new Date().toISOString()).toISOString();
  const modelReceipts: KnowledgeModelExecutionReceipt[] = [];
  let type = classifyPageTypeDeterministically({ declaredType: input.declaredPageType, locator: input.evidence.envelope.locator, sourceKind: input.sourceKind });
  if (!type.typeKey) {
    const definition = prompts.resolveCurrent("knowledge.page-classification");
    const executed = await executeKnowledgeModel({ executor: input.modelExecutor, profile: input.profiles.utility, requiredProfile: definition.profile, completedAt: now, request: {
      task: definition.task, promptId: definition.promptId, promptVersion: definition.version, promptContentHash: definition.contentHash,
      inputSchemaId: definition.inputSchemaId, outputSchemaId: definition.outputSchemaId, systemInstruction: definition.systemInstruction,
      taskInput: { allowedTypeKeys: CORE_BRAIN_PAGE_TAXONOMY.filter((entry) => entry.status === "active").map((entry) => entry.key) },
      evidenceBlocks: [{ evidenceId: "evidence:source", content: text, contentDigest: sha256(text) }], authorizationContextDigest: input.authorizationContextDigest,
      dataClass: input.dataClass, idempotencyKey: `${runKey}:classification`,
    } });
    modelReceipts.push(executed.receipt);
    if (executed.receipt.outcome !== "succeeded") throw new Error(`Page classification model ${executed.receipt.outcome}.`);
    const output = object(executed.output, "Page classification output");
    if (typeof output.typeKey !== "string" || !CORE_BRAIN_PAGE_TAXONOMY.some((entry) => entry.key === output.typeKey)) throw new Error("Page classification returned an undeclared Page type.");
    type = { typeKey: output.typeKey, basis: "unresolved" };
  }
  const executed = await executeKnowledgeModel({ executor: input.modelExecutor, profile: input.profiles.reasoning, requiredProfile: extractionPrompt.profile, completedAt: now, request: {
    task: extractionPrompt.task, promptId: extractionPrompt.promptId, promptVersion: extractionPrompt.version, promptContentHash: extractionPrompt.contentHash,
    inputSchemaId: extractionPrompt.inputSchemaId, outputSchemaId: extractionPrompt.outputSchemaId, systemInstruction: extractionPrompt.systemInstruction,
    taskInput: { defaultOwnerPrincipalId: input.ownerPrincipalId, sourceKind: input.sourceKind, observedAt: input.evidence.envelope.observedAt },
    evidenceBlocks: [{ evidenceId: "evidence:source", content: text, contentDigest: sha256(text) }], authorizationContextDigest: input.authorizationContextDigest,
    dataClass: input.dataClass, idempotencyKey: runKey,
  } });
  modelReceipts.push(executed.receipt);
  if (executed.receipt.outcome !== "succeeded") throw new Error(`Claim extraction model ${executed.receipt.outcome}.`);
  const output = validateExtractionOutput(executed.output, text, "evidence:source");
  const provenance = { model: input.profiles.reasoning.model, promptVersion: `${extractionPrompt.promptId}@${extractionPrompt.version}`, extractionRunId: runId };
  const existingPageId = sha256({ sourceId: input.evidence.envelope.sourceId, sourcePageKey: input.evidence.envelope.providerObjectId });
  const currentPage = await input.brainStore.getPage(existingPageId);
  const record = createBrainPageVersion({
    pageTypeKey: type.typeKey!, sourceId: input.evidence.envelope.sourceId, sourcePageKey: input.evidence.envelope.providerObjectId,
    verificationStatus: ["person", "company"].includes(type.typeKey!) ? "unverified" : "verified",
    accessPolicyId: input.evidence.envelope.accessPolicyId, pageCreatedAt: currentPage?.page.createdAt ?? input.evidence.envelope.observedAt,
    version: currentPage ? currentPage.version.version + 1 : 1, title: output.page.title, summary: output.page.summary, body: text,
    metadata: { sourceLocator: input.evidence.envelope.locator, classificationBasis: type.basis }, observedAt: input.evidence.envelope.observedAt,
    versionCreatedAt: now, sourceObjectId: input.evidence.envelope.providerObjectId, sourceObjectVersion: input.evidence.envelope.providerVersion,
    modelProvenance: provenance,
  });
  const claims: BrainClaim[] = [];
  const participantRelations: KnowledgeExtractionResult["participantRelations"] = [];
  const storedRelations: BrainClaimRelation[] = [];
  for (const candidate of output.claims) {
    const evidence = [{ evidenceId: sha256({ runId, evidenceId: candidate.evidenceId, locator: candidate.locator, claimText: candidate.claimText }), sourceId: input.evidence.envelope.sourceId, providerObjectId: input.evidence.envelope.providerObjectId, providerVersion: input.evidence.envelope.providerVersion, contentDigest: input.evidence.envelope.contentDigest, observedAt: input.evidence.envelope.observedAt, locator: candidate.locator, pageId: record.page.pageId, pageVersionId: record.version.pageVersionId }];
    let primaryHolder = candidate.holder;
    if (primaryHolder) {
      const existingHolder = await input.brainStore.getHolder(primaryHolder.holderId);
      if (existingHolder && existingHolder.holderType !== primaryHolder.holderType) throw new Error("Canonical Holder conflicts with an existing Holder type.");
      primaryHolder = existingHolder ?? primaryHolder;
    }
    const claim = candidate.memoryClass === "fact" ? createBrainClaim({ memoryClass: "fact", claimKind: candidate.claimKind as FactClaimKind, claimText: candidate.claimText, ownerPrincipalId: candidate.ownerPrincipalId ?? input.ownerPrincipalId, scope: { kind: "principal" }, evidence, observedAt: input.evidence.envelope.observedAt, extractionConfidence: candidate.extractionConfidence, epistemicWeight: candidate.epistemicWeight, accessPolicyId: record.page.accessPolicyId, createdBy: `model:${runId}`, modelProvenance: provenance })
      : createBrainClaim({ memoryClass: "take", claimKind: candidate.claimKind as TakeClaimKind, claimText: candidate.claimText, primaryHolder: primaryHolder!, derivation: candidate.derivation!, evidence, observedAt: input.evidence.envelope.observedAt, extractionConfidence: candidate.extractionConfidence, epistemicWeight: candidate.epistemicWeight, accessPolicyId: record.page.accessPolicyId, createdBy: `model:${runId}`, modelProvenance: provenance });
    claims.push(claim);
    for (const relation of candidate.participantRelations ?? []) {
      const outputRelation = { claimId: claim.claimId, ...relation };
      participantRelations.push(outputRelation);
      const storedRelation: BrainClaimRelation = {
        claimId: claim.claimId,
        relationType: relation.relation,
        entityType: "principal",
        entityId: relation.principalId,
        evidence: { extractionRunId: runId, pageVersionId: record.version.pageVersionId },
      };
      storedRelations.push(storedRelation);
    }
  }
  const timelineEvents: BrainTimelineEvent[] = [];
  for (const [index, event] of (output.timeline ?? []).entries()) {
    const storedEvent: BrainTimelineEvent = {
      eventId: sha256({ runId, pageVersionId: record.version.pageVersionId, index, event }),
      eventType: event.eventType,
      subjectType: "page",
      subjectId: record.page.pageId,
      pageVersionId: record.version.pageVersionId,
      sourceId: record.page.sourceId,
      observedAt: event.observedAt,
      provenanceClass: "inferred",
      evidence: { description: event.description, locator: event.locator, extractionRunId: runId },
      accessPolicyId: record.page.accessPolicyId,
      lifecycleStatus: "active",
    };
    timelineEvents.push(storedEvent);
  }
  const result: KnowledgeExtractionResult = { runId, page: record.page, pageVersion: record.version, claims, participantRelations, timeline: output.timeline ?? [], modelReceipts };
  await input.brainStore.putPageVersion(record);
  for (const claim of claims) await input.brainStore.putClaim(claim);
  for (const relation of storedRelations) await input.brainStore.putClaimRelation(relation);
  for (const event of timelineEvents) await input.brainStore.putTimelineEvent(event);
  await input.runStore.put({ runId, runKey, inputDigest, promptVersions: modelReceipts.map((entry) => `${entry.promptId}@${entry.promptVersion}`), schemaVersion: extractionPrompt.outputSchemaId, modelProfileIdentity: modelIdentity, status: "succeeded", result, receiptIds: modelReceipts.map((entry) => entry.receiptId) });
  return result;
}
