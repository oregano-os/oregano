export type KnowledgePromptJsonSchema = Readonly<Record<string, unknown>>;

const string = (maximum: number, minimum = 1): KnowledgePromptJsonSchema => ({
  type: "string",
  minLength: minimum,
  maxLength: maximum,
});

const stringArray = (maximumItems: number, maximumLength = 256): KnowledgePromptJsonSchema => ({
  type: "array",
  maxItems: maximumItems,
  uniqueItems: true,
  items: string(maximumLength),
});

const object = (
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = Object.keys(properties),
): KnowledgePromptJsonSchema => ({ type: "object", additionalProperties: false, required, properties });

const locator = {
  anyOf: [
    object({ kind: { type: "string", const: "line" }, start: { type: "integer", minimum: 1 }, end: { type: "integer", minimum: 1 } }),
    object({ kind: { type: "string", const: "timestamp" }, startMs: { type: "number", minimum: 0 }, endMs: { type: "number", minimum: 0 } }),
  ],
} as const;

const participantRelations = {
  type: "array",
  maxItems: 100,
  items: object({
    relation: { type: "string", enum: ["speaker", "author", "subject", "approver", "owner", "beneficiary", "affected-party"] },
    principalId: string(256),
  }),
} as const;

export const KNOWLEDGE_PROMPT_INPUT_SCHEMAS = {
  "knowledge.triage.input@1": object({ sourceKind: string(64), contentCharacters: { type: "integer", minimum: 0, maximum: 20_000_000 } }),
  "knowledge.page-classification.input@1": object({ allowedTypeKeys: stringArray(100, 100) }),
  "knowledge.claim-extraction.input@1": object({ defaultOwnerPrincipalId: string(256), sourceKind: string(64), observedAt: { type: "string", format: "date-time" } }),
  "knowledge.timeline.input@1": object({ sourceKind: string(64) }),
  "knowledge.claim-relation.input@1": object({ claimIds: stringArray(200) }),
  "knowledge.identity-link.input@1": object({ pageIds: stringArray(200), entityIds: stringArray(200) }),
  "knowledge.inferred-link.input@1": object({ objectIds: stringArray(200), allowedRelationTypes: stringArray(100, 100) }),
  "knowledge.duplicate.input@1": object({ leftIdentity: string(256), rightIdentity: string(256) }),
  "knowledge.cited-synthesis.input@1": object({ query: string(4_000), contextReceiptId: string(256) }),
  "knowledge.working-synthesis.input@1": object({ subjectIdentity: string(256) }),
  "knowledge.conflict.input@1": object({ leftClaimId: string(256), rightClaimId: string(256) }),
  "knowledge.claim-grading.input@1": object({ claimId: string(256), outcomeEvidenceIds: stringArray(100) }),
  "knowledge.query-expansion.input@1": object({ query: string(4_000), maxVariants: { type: "integer", minimum: 1, maximum: 8 } }),
} as const satisfies Readonly<Record<string, KnowledgePromptJsonSchema>>;

const confidence = { type: "number", minimum: 0, maximum: 1 } as const;

export const KNOWLEDGE_CLAIM_EXTRACTION_OUTPUT_SCHEMA = {
  ...object({
    page: object({ title: string(500), summary: string(4_000, 0) }),
    facts: {
      type: "array",
      maxItems: 200,
      items: object({
        claimKind: { type: "string", enum: ["event", "preference", "commitment", "belief", "fact"] },
        claimText: string(10_000),
        ownerPrincipalId: string(256),
        evidenceId: string(256),
        locator: { $ref: "#/$defs/locator" },
        extractionConfidence: confidence,
        epistemicWeight: confidence,
        participantRelations: { $ref: "#/$defs/participantRelations" },
      }),
    },
    takes: {
      type: "array",
      maxItems: 200,
      items: object({
        claimKind: { type: "string", enum: ["fact", "take", "bet", "hunch"] },
        claimText: string(10_000),
        holder: object({
          holderId: string(256),
          holderType: { type: "string", enum: ["person", "team", "company", "world", "system", "unresolved"] },
          displayName: string(500),
        }),
        derivation: { type: "string", enum: ["source-literal", "model-derived"] },
        evidenceId: string(256),
        locator: { $ref: "#/$defs/locator" },
        extractionConfidence: confidence,
        epistemicWeight: confidence,
        participantRelations: { $ref: "#/$defs/participantRelations" },
      }),
    },
    timeline: {
      type: "array",
      maxItems: 200,
      items: object({ eventType: string(200), description: string(2_000), observedAt: { type: "string", format: "date-time" }, locator: { $ref: "#/$defs/locator" } }),
    },
  }),
  $defs: { locator, participantRelations },
} as const satisfies KnowledgePromptJsonSchema;

export const KNOWLEDGE_PROMPT_OUTPUT_SCHEMAS = {
  "knowledge.triage.output@2": object({
    tier: { type: "string", enum: ["low", "medium", "high"] },
    recommendedAction: { type: "string", enum: ["process", "defer", "retry"] },
    reasonCodes: stringArray(20, 100),
    rationale: string(1_000),
  }),
  "knowledge.page-classification.output@2": object({ typeKey: string(100), rationale: string(1_000) }),
  "knowledge.claim-extraction.output@2": KNOWLEDGE_CLAIM_EXTRACTION_OUTPUT_SCHEMA,
  "knowledge.timeline.output@2": object({
    events: { type: "array", maxItems: 200, items: object({ eventType: string(200), description: string(2_000), observedAt: { type: "string", format: "date-time" }, evidenceId: string(256), locator }) },
  }),
  "knowledge.claim-relation.output@2": object({
    relations: { type: "array", maxItems: 500, items: object({ sourceClaimId: string(256), targetClaimId: string(256), relation: { type: "string", enum: ["supports", "contradicts", "refines", "supersedes"] }, confidence, rationale: string(1_000) }) },
  }),
  "knowledge.identity-link.output@2": object({
    proposals: { type: "array", maxItems: 200, items: object({ pageId: string(256), entityId: string(256), judgment: { type: "string", enum: ["same", "different", "uncertain"] }, confidence, rationale: string(1_000) }) },
  }),
  "knowledge.inferred-link.output@2": object({
    proposals: { type: "array", maxItems: 500, items: object({ sourceId: string(256), targetId: string(256), relationType: string(100), confidence, rationale: string(1_000) }) },
  }),
  "knowledge.duplicate.output@2": object({
    leftIdentity: string(256),
    rightIdentity: string(256),
    classification: { type: "string", enum: ["distinct", "duplicate", "supersedes", "uncertain"] },
    confidence,
    rationale: string(2_000),
  }),
  "knowledge.answer-envelope@2": object({
    answer: string(30_000, 0),
    citations: { type: "array", maxItems: 200, items: object({ identity: string(256), contentDigest: { type: "string", pattern: "^[a-f0-9]{64}$" } }) },
    labels: { type: "array", uniqueItems: true, maxItems: 7, items: { type: "string", enum: ["evidence", "attributed", "synthesized", "contested", "superseded", "expired", "official"] } },
    gaps: { type: "array", maxItems: 100, items: string(1_000) },
    conflicts: { type: "array", maxItems: 100, items: string(1_000) },
    freshness: string(1_000),
  }),
  "knowledge.working-synthesis.output@2": object({
    title: string(500),
    body: string(30_000),
    supportingClaimIds: stringArray(500),
    contestedClaimIds: stringArray(500),
    supersededClaimIds: stringArray(500),
    gaps: { type: "array", maxItems: 100, items: string(1_000) },
  }),
  "knowledge.conflict.output@2": object({
    leftClaimId: string(256),
    rightClaimId: string(256),
    judgment: { type: "string", enum: ["conflict", "compatible", "uncertain"] },
    severity: { type: "string", enum: ["none", "low", "medium", "high"] },
    rationale: string(2_000),
  }),
  "knowledge.claim-grading.output@2": object({
    claimId: string(256),
    grade: { type: "string", enum: ["correct", "incorrect", "partial", "unresolvable"] },
    confidence,
    rationale: string(2_000),
    supportingEvidenceIds: stringArray(100),
  }),
  "knowledge.query-expansion.output@2": object({ terms: stringArray(8, 200) }),
} as const satisfies Readonly<Record<string, KnowledgePromptJsonSchema>>;

export type KnowledgePromptInputSchemaId = keyof typeof KNOWLEDGE_PROMPT_INPUT_SCHEMAS;
export type KnowledgePromptOutputSchemaId = keyof typeof KNOWLEDGE_PROMPT_OUTPUT_SCHEMAS;
