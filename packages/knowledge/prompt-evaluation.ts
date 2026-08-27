import type { KnowledgePromptRequestMetadata } from "./prompt-registry.ts";

export interface KnowledgePromptEvaluationFixture {
  fixtureId: string;
  fixtureSetId: string;
  promptId: string;
  taskInput: Readonly<Record<string, unknown>>;
  evidenceBlocks: ReadonlyArray<{ evidenceId: string; content: string }>;
  referenceOutput: unknown;
  expectedSignals: readonly string[];
  minimumF1: number;
}

export interface KnowledgePromptQualityMetrics {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
}

const normalizedSignal = (value: string): string => value.trim().toLocaleLowerCase("en").replace(/\s+/g, " ");

export function evaluateKnowledgePromptSignals(
  expectedSignals: readonly string[],
  actualSignals: readonly string[],
): KnowledgePromptQualityMetrics {
  const expected = new Set(expectedSignals.map(normalizedSignal));
  const actual = new Set(actualSignals.map(normalizedSignal));
  const truePositives = [...actual].filter((signal) => expected.has(signal)).length;
  const falsePositives = actual.size - truePositives;
  const falseNegatives = expected.size - truePositives;
  const precision = actual.size === 0 ? (expected.size === 0 ? 1 : 0) : truePositives / actual.size;
  const recall = expected.size === 0 ? 1 : truePositives / expected.size;
  const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
  return { truePositives, falsePositives, falseNegatives, precision, recall, f1 };
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : [];
const values = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
const locatorSignal = (value: unknown): string => {
  const locator = record(value);
  if (locator.kind === "line") return `line:${String(locator.start)}-${String(locator.end)}`;
  if (locator.kind === "timestamp") return `timestamp:${String(locator.startMs)}-${String(locator.endMs)}`;
  return "locator:invalid";
};

export function knowledgePromptOutputSignals(promptId: string, output: unknown, taskInput: Readonly<Record<string, unknown>> = {}): string[] {
  const root = record(output);
  if (promptId === "knowledge.triage") return [`tier:${String(root.tier)}`, `action:${String(root.recommendedAction)}`];
  if (promptId === "knowledge.page-classification") return [`type:${String(root.typeKey)}`];
  if (promptId === "knowledge.claim-extraction") return [
    ...records(root.facts).map((fact) => `fact:${String(fact.claimKind)}:${String(fact.ownerPrincipalId)}:${locatorSignal(fact.locator)}`),
    ...records(root.takes).map((take) => `take:${String(take.claimKind)}:${String(record(take.holder).holderId)}:${String(take.derivation)}:${locatorSignal(take.locator)}`),
  ];
  if (promptId === "knowledge.duplicate-classification") return [`classification:${String(root.classification)}`];
  if (promptId === "knowledge.timeline-extraction") return records(root.events).map((event) => `event:${String(event.evidenceId)}:${locatorSignal(event.locator)}`);
  if (promptId === "knowledge.claim-relation") return records(root.relations).map((relation) => `relation:${String(relation.sourceClaimId)}:${String(relation.targetClaimId)}:${String(relation.relation)}`);
  if (promptId === "knowledge.identity-link") return records(root.proposals).map((proposal) => `identity:${String(proposal.pageId)}:${String(proposal.entityId)}:${String(proposal.judgment)}`);
  if (promptId === "knowledge.inferred-link") return records(root.proposals).map((proposal) => `link:${String(proposal.sourceId)}:${String(proposal.targetId)}:${String(proposal.relationType)}`);
  if (promptId === "knowledge.conflict-judgment") return [`judgment:${String(root.judgment)}`, `severity:${String(root.severity)}`];
  if (promptId === "knowledge.working-synthesis") return [
    ...values(root.supportingClaimIds).map((identity) => `supporting:${identity}`),
    ...values(root.contestedClaimIds).map((identity) => `contested:${identity}`),
    ...values(root.supersededClaimIds).map((identity) => `superseded:${identity}`),
  ];
  if (promptId === "knowledge.cited-synthesis") return [
    ...records(root.citations).filter((citation) => typeof citation.identity === "string").map((citation) => `citation:${String(citation.identity)}`),
    ...values(root.labels).map((label) => `label:${label}`),
  ];
  if (promptId === "knowledge.query-expansion") {
    const terms = values(root.terms);
    const query = typeof taskInput.query === "string" ? normalizedSignal(taskInput.query) : "";
    const maximum = Number(taskInput.maxVariants);
    return [
      ...(terms.length > 0 ? ["terms:nonempty"] : []),
      ...(Number.isInteger(maximum) && terms.length <= maximum ? ["terms:bounded"] : []),
      ...(query && terms.every((term) => normalizedSignal(term) !== query) ? ["terms:no-original-repeat"] : []),
    ];
  }
  if (promptId === "knowledge.claim-grading") return [`grade:${String(root.claimId)}:${String(root.grade)}`];
  throw new Error(`Prompt fixture signal extraction is not implemented for '${promptId}'.`);
}

export const CORE_KNOWLEDGE_PROMPT_FIXTURES: readonly KnowledgePromptEvaluationFixture[] = [
  {
    fixtureId: "triage-clear-short@1", fixtureSetId: "knowledge.triage.fixtures@1", promptId: "knowledge.triage",
    taskInput: { sourceKind: "meeting", contentCharacters: 77 },
    evidenceBlocks: [{ evidenceId: "evidence:triage", content: "Alice committed to send the signed launch plan by Friday." }],
    referenceOutput: { tier: "low", recommendedAction: "process", reasonCodes: ["clear-structure"], rationale: "Short and explicit." },
    expectedSignals: ["tier:low", "action:process"], minimumF1: 0.8,
  },
  {
    fixtureId: "fact-take-boundary@1", fixtureSetId: "knowledge.claim-extraction.fixtures@1", promptId: "knowledge.claim-extraction",
    taskInput: { defaultOwnerPrincipalId: "human:alice", sourceKind: "meeting", observedAt: "2026-08-27T10:00:00.000Z", evidenceLineCount: 2 },
    evidenceBlocks: [{ evidenceId: "evidence:source", content: "Alice (principal ID human:alice): I will publish the plan Friday.\nBob (Holder ID people/bob): I predict adoption will increase." }],
    referenceOutput: { facts: [{ claimKind: "commitment", ownerPrincipalId: "human:alice", locator: { kind: "line", start: 1, end: 1 } }], takes: [{ claimKind: "bet", holder: { holderId: "people/bob" }, derivation: "source-literal", locator: { kind: "line", start: 2, end: 2 } }] },
    expectedSignals: ["fact:commitment:human:alice:line:1-1", "take:bet:people/bob:source-literal:line:2-2"], minimumF1: 0.8,
  },
  {
    fixtureId: "page-classification-meeting@1", fixtureSetId: "knowledge.page-classification.fixtures@1", promptId: "knowledge.page-classification",
    taskInput: { allowedTypeKeys: ["meeting", "project", "note"] }, evidenceBlocks: [{ evidenceId: "evidence:page", content: "Meeting transcript with Alice and Bob." }],
    referenceOutput: { typeKey: "meeting" }, expectedSignals: ["type:meeting"], minimumF1: 0.8,
  },
  {
    fixtureId: "timeline-explicit-date@1", fixtureSetId: "knowledge.timeline-extraction.fixtures@1", promptId: "knowledge.timeline-extraction",
    taskInput: { sourceKind: "meeting" }, evidenceBlocks: [{ evidenceId: "evidence:timeline", content: "The launch is scheduled for 2026-09-01." }],
    referenceOutput: { events: [{ eventType: "planned-launch", evidenceId: "evidence:timeline", locator: { kind: "line", start: 1, end: 1 } }] },
    expectedSignals: ["event:evidence:timeline:line:1-1"], minimumF1: 0.8,
  },
  {
    fixtureId: "claim-relation-support@1", fixtureSetId: "knowledge.claim-relation.fixtures@1", promptId: "knowledge.claim-relation",
    taskInput: { claimIds: ["claim:plan", "claim:approval"] }, evidenceBlocks: [{ evidenceId: "claim:plan", content: "The launch requires approval." }, { evidenceId: "claim:approval", content: "The launch received approval." }],
    referenceOutput: { relations: [{ sourceClaimId: "claim:approval", targetClaimId: "claim:plan", relation: "supports" }] },
    expectedSignals: ["relation:claim:approval:claim:plan:supports"], minimumF1: 0.8,
  },
  {
    fixtureId: "identity-provider-proof@1", fixtureSetId: "knowledge.identity-link.fixtures@1", promptId: "knowledge.identity-link",
    taskInput: { pageIds: ["page:alice"], entityIds: ["entity:alice"] }, evidenceBlocks: [{ evidenceId: "identity:evidence", content: "Both objects carry provider user ID U123." }],
    referenceOutput: { proposals: [{ pageId: "page:alice", entityId: "entity:alice", judgment: "same" }] },
    expectedSignals: ["identity:page:alice:entity:alice:same"], minimumF1: 0.8,
  },
  {
    fixtureId: "inferred-link-material@1", fixtureSetId: "knowledge.inferred-link.fixtures@1", promptId: "knowledge.inferred-link",
    taskInput: { objectIds: ["person:alice", "project:cedar"], allowedRelationTypes: ["leads"] }, evidenceBlocks: [{ evidenceId: "evidence:link", content: "Alice leads Project Cedar." }],
    referenceOutput: { proposals: [{ sourceId: "person:alice", targetId: "project:cedar", relationType: "leads" }] },
    expectedSignals: ["link:person:alice:project:cedar:leads"], minimumF1: 0.8,
  },
  {
    fixtureId: "duplicate-scope-difference@1", fixtureSetId: "knowledge.duplicate-classification.fixtures@1", promptId: "knowledge.duplicate-classification",
    taskInput: { leftIdentity: "claim:left", rightIdentity: "claim:right" },
    evidenceBlocks: [{ evidenceId: "claim:left", content: "EU launch is September 1." }, { evidenceId: "claim:right", content: "US launch is September 1." }],
    referenceOutput: { classification: "distinct" }, expectedSignals: ["classification:distinct"], minimumF1: 0.8,
  },
  {
    fixtureId: "conflict-temporal-change@1", fixtureSetId: "knowledge.conflict-judgment.fixtures@1", promptId: "knowledge.conflict-judgment",
    taskInput: { leftClaimId: "claim:old", rightClaimId: "claim:new" },
    evidenceBlocks: [{ evidenceId: "claim:old", content: "On August 1 the launch was planned for September 1." }, { evidenceId: "claim:new", content: "On August 20 the launch moved to September 15." }],
    referenceOutput: { judgment: "compatible", severity: "none" }, expectedSignals: ["judgment:compatible", "severity:none"], minimumF1: 0.8,
  },
  {
    fixtureId: "working-synthesis-contested@1", fixtureSetId: "knowledge.working-synthesis.fixtures@1", promptId: "knowledge.working-synthesis",
    taskInput: { subjectIdentity: "project:cedar" },
    evidenceBlocks: [{ evidenceId: "claim:supported", content: "Launch checklist is complete." }, { evidenceId: "claim:contested", content: "One reviewer disputes readiness." }],
    referenceOutput: { supportingClaimIds: ["claim:supported"], contestedClaimIds: ["claim:contested"], supersededClaimIds: [] },
    expectedSignals: ["supporting:claim:supported", "contested:claim:contested"], minimumF1: 0.8,
  },
  {
    fixtureId: "cited-synthesis-authority@1", fixtureSetId: "knowledge.cited-synthesis.fixtures@1", promptId: "knowledge.cited-synthesis",
    taskInput: { query: "What is the official launch rule?", contextReceiptId: "context:fixture" },
    evidenceBlocks: [{ evidenceId: "handbook:launch", content: "{\"label\":\"official\",\"contentDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"excerpt\":\"Two approvals are required.\"}" }],
    referenceOutput: { citations: [{ identity: "handbook:launch" }], labels: ["official"] },
    expectedSignals: ["citation:handbook:launch", "label:official"], minimumF1: 0.8,
  },
  {
    fixtureId: "query-expansion-bounded@1", fixtureSetId: "knowledge.query-expansion.fixtures@1", promptId: "knowledge.query-expansion",
    taskInput: { query: "Cedar launch date", maxVariants: 2 }, evidenceBlocks: [],
    referenceOutput: { terms: ["Project Cedar release date"] }, expectedSignals: ["terms:nonempty", "terms:bounded", "terms:no-original-repeat"], minimumF1: 0.8,
  },
  {
    fixtureId: "claim-grading-supported@1", fixtureSetId: "knowledge.claim-grading.fixtures@1", promptId: "knowledge.claim-grading",
    taskInput: { claimId: "claim:launch", outcomeEvidenceIds: ["outcome:launch"] }, evidenceBlocks: [{ evidenceId: "claim:launch", content: "Claim: The launch will occur on 2026-09-01." }, { evidenceId: "outcome:launch", content: "Outcome: The launch occurred on 2026-09-01." }],
    referenceOutput: { claimId: "claim:launch", grade: "correct" }, expectedSignals: ["grade:claim:launch:correct"], minimumF1: 0.8,
  },
] as const;

export const asPromptRequestMetadata = (
  fixture: KnowledgePromptEvaluationFixture,
  definition: {
    task: string;
    promptId: string;
    version: string;
    contentHash: string;
    inputSchemaId: string;
    outputSchemaId: string;
    systemInstruction: string;
  },
): KnowledgePromptRequestMetadata => ({
  task: definition.task,
  promptId: definition.promptId,
  promptVersion: definition.version,
  promptContentHash: definition.contentHash,
  inputSchemaId: definition.inputSchemaId,
  outputSchemaId: definition.outputSchemaId,
  systemInstruction: definition.systemInstruction,
  taskInput: fixture.taskInput,
  evidenceBlocks: fixture.evidenceBlocks,
});
