import assert from "node:assert/strict";
import { test } from "node:test";
import { createCurrentBriefView, currentBriefToRetrievalUnitV3 } from "../../knowledge/current-brief.ts";
import { KnowledgeRetrievalServiceV2 } from "../../knowledge/retrieval-v2.ts";
import {
  KNOWLEDGE_RETRIEVAL_PROJECTION_V3_CONTRACT_VERSION,
  createKnowledgeRetrievalProjectionV3,
  createKnowledgeRetrievalUnitV3,
  retrievalRecordV2ToUnitV3,
  retrievalUnitV3ToRecordV2,
  type KnowledgeAuthorityLayer,
  type KnowledgeRetrievalUnitKind,
  type KnowledgeRetrievalUnitState,
  type KnowledgeRetrievalUnitV3,
} from "../../knowledge/retrieval-unit.ts";
import { sha256 } from "../../runtime/canonical.ts";

const observedAt = "2026-08-30T10:00:00.000Z";

const unit = (input: {
  unitId: string;
  parentId?: string;
  title?: string;
  text: string;
  policy?: string;
  kind?: KnowledgeRetrievalUnitKind;
  authorityLayer?: KnowledgeAuthorityLayer;
  state?: KnowledgeRetrievalUnitState;
}): KnowledgeRetrievalUnitV3 => createKnowledgeRetrievalUnitV3({
  unitId: input.unitId,
  parentId: input.parentId ?? input.unitId,
  kind: input.kind ?? "page-fragment",
  authorityLayer: input.authorityLayer ?? "evidence",
  state: input.state ?? "active",
  title: input.title ?? input.unitId,
  aliases: [input.unitId, input.title ?? input.unitId, input.unitId],
  text: input.text,
  contentDigest: sha256(input.text),
  accessPolicyId: input.policy ?? "policy:company",
  sourceIds: ["source:granola"],
  observedAt,
  graphNeighbors: [],
});

test("Retrieval V3 projection is deterministic, ordered, and retry-idempotent", () => {
  const first = unit({ unitId: "page:z", text: "Zeta evidence." });
  const second = unit({ unitId: "page:a", text: "Alpha evidence." });
  const left = createKnowledgeRetrievalProjectionV3({
    units: [first, second, first],
    sourceSnapshotIds: ["brain:42", "handbook:17", "brain:42"],
    createdAt: observedAt,
  });
  const right = createKnowledgeRetrievalProjectionV3({
    units: [second, first],
    sourceSnapshotIds: ["handbook:17", "brain:42"],
    createdAt: "2026-08-30T11:00:00.000Z",
  });
  assert.equal(left.contractVersion, KNOWLEDGE_RETRIEVAL_PROJECTION_V3_CONTRACT_VERSION);
  assert.equal(left.projectionHash, right.projectionHash, "projection content identity must not depend on input order or creation time");
  assert.deepEqual(left.units.map((entry) => entry.unitId), ["page:a", "page:z"]);
  assert.deepEqual(left.sourceSnapshotIds, ["brain:42", "handbook:17"]);
});

test("Retrieval V3 fails closed on identity reuse, invalid content, and authority widening", () => {
  const original = unit({ unitId: "page:one", text: "Original evidence." });
  const changed = unit({ unitId: "page:one", text: "Changed evidence." });
  assert.throws(() => createKnowledgeRetrievalProjectionV3({ units: [original, changed], sourceSnapshotIds: ["brain:1"], createdAt: observedAt }), /reused with different content or policy/i);
  assert.throws(() => createKnowledgeRetrievalUnitV3({ ...original, contentDigest: sha256("forged") }), /digest does not match/i);
  assert.throws(() => createKnowledgeRetrievalUnitV3({ ...original, authorityLayer: "official" }), /Only Handbook/i);
  assert.throws(() => createKnowledgeRetrievalUnitV3({ ...original, kind: "working-synthesis", authorityLayer: "attributed" }), /must remain synthesized/i);
  assert.throws(() => createKnowledgeRetrievalUnitV3({ ...original, kind: "source-object", authorityLayer: "attributed" }), /must remain evidence/i);
});

test("Current Brief is a versioned synthesized view and maps to non-official retrieval", () => {
  const content = "# Current Strategy\n\nEnterprise DACH is the strongest current direction.";
  const brief = createCurrentBriefView({
    synthesisId: "synthesis-1",
    currentVersionId: "synthesis-version-2",
    synthesisVersionId: "synthesis-version-2",
    versionNumber: 2,
    subjectType: "strategy",
    subjectId: "company",
    content,
    contentDigest: sha256(content),
    supportingClaimIds: ["claim-board", "claim-board"],
    contestedClaimIds: ["claim-sales"],
    supersededClaimIds: ["claim-consumer"],
    gaps: ["US timing is not approved"],
    accessPolicyId: "policy:board",
    synthesizedAt: observedAt,
  });
  assert.equal(brief.title, "Current Strategy");
  assert.equal(brief.authorityLayer, "synthesized");
  assert.equal(brief.freshnessStatus, "current");
  assert.deepEqual(brief.supportingClaimIds, ["claim-board"]);
  const retrieval = currentBriefToRetrievalUnitV3(brief);
  assert.equal(retrieval.kind, "working-synthesis");
  assert.equal(retrieval.authorityLayer, "synthesized");
  assert.equal(retrieval.accessPolicyId, "policy:board");
  assert.deepEqual(retrieval.graphNeighbors, ["claim:claim-board", "claim:claim-consumer", "claim:claim-sales"]);
  const v2 = retrievalUnitV3ToRecordV2(retrieval);
  assert.equal(v2.kind, "synthesis");
  assert.equal(v2.label, "synthesized");
  assert.notEqual(v2.label, "official");
  assert.equal(v2.accessPolicyId, "policy:board");
  assert.throws(() => currentBriefToRetrievalUnitV3({ ...brief, authorityLayer: "official" } as unknown as typeof brief), /contract is invalid/i);
});

test("Current Brief becomes potentially stale without rewriting its immutable content", () => {
  const content = "# Account State\n\nThe renewal is expected in Q4.";
  const common = {
    synthesisId: "synthesis-2",
    currentVersionId: "version-1",
    synthesisVersionId: "version-1",
    versionNumber: 1,
    subjectType: "company",
    subjectId: "acme",
    content,
    contentDigest: sha256(content),
    supportingClaimIds: ["claim-renewal"],
    contestedClaimIds: [],
    supersededClaimIds: [],
    gaps: [],
    accessPolicyId: "policy:account-team",
    synthesizedAt: observedAt,
  } as const;
  const changed = createCurrentBriefView({ ...common, latestRelevantChangeAt: "2026-08-30T10:01:00.000Z" });
  assert.equal(changed.freshnessStatus, "potentially-stale");
  assert.deepEqual(changed.staleReasons, ["new-relevant-evidence"]);
  assert.equal(changed.content, content);
  assert.equal(changed.contentDigest, sha256(content));
  const aged = createCurrentBriefView({ ...common, maximumAgeMs: 1_000, now: "2026-08-30T10:00:02.000Z" });
  assert.deepEqual(aged.staleReasons, ["age-bound-exceeded"]);
  assert.throws(() => createCurrentBriefView({ ...common, currentVersionId: "version-2" }), /current immutable/i);
  assert.throws(() => createCurrentBriefView({ ...common, contestedClaimIds: ["claim-renewal"] }), /mutually exclusive/i);
});

test("Retrieval Unit mapping preserves labels, locators, and authorization before semantic search", async () => {
  const officialText = "Official launch readiness policy.";
  const official = createKnowledgeRetrievalUnitV3({
    unitId: "handbook:launch#readiness",
    parentId: "handbook:launch",
    kind: "handbook-fragment",
    authorityLayer: "official",
    state: "active",
    title: "Launch readiness",
    text: officialText,
    contentDigest: sha256(officialText),
    accessPolicyId: "policy:company",
    sourceIds: ["handbook:commit:abc"],
    observedAt,
    evidenceLocator: { kind: "line", start: 10, end: 12 },
  });
  const contested = unit({ unitId: "claim:budget", parentId: "page:meeting", kind: "claim", authorityLayer: "attributed", state: "contested", text: "The launch budget is disputed.", policy: "policy:board" });
  const records = [official, contested].map(retrievalUnitV3ToRecordV2);
  assert.equal(records[0]?.label, "official");
  assert.equal(records[1]?.label, "contested");
  const service = new KnowledgeRetrievalServiceV2({
    records,
    authorization: { canRead: async ({ policyId }) => policyId === "policy:company" },
    semantic: async (_query, authorized) => {
      assert.deepEqual(authorized.map((entry) => entry.identity), ["handbook:launch#readiness"]);
      return new Map([["handbook:launch#readiness", 0.95]]);
    },
  });
  const result = await service.search({ query: "launch readiness", limit: 10 });
  assert.deepEqual(result.hits.map((entry) => entry.identity), ["handbook:launch#readiness"]);
  assert.equal(result.hits[0]?.label, "official");
});

test("Retrieval V2 compatibility drops blank aliases and names derived Brain provenance", () => {
  const unit = retrievalRecordV2ToUnitV3({
    identity: "synthesis:strategy",
    kind: "synthesis",
    title: "Current strategy",
    aliases: ["", "  ", "strategy", `oversized-${"x".repeat(1_001)}`, "invalid\u0000alias"],
    text: "The current working synthesis remains attributed Brain material.",
    contentDigest: sha256("The current working synthesis remains attributed Brain material."),
    accessPolicyId: "policy:company",
    label: "synthesized",
    observedAt,
    sourceIds: [],
    confidence: 0.7,
    authority: 0.5,
    freshness: 1,
    expectedValue: 0.7,
    graphNeighbors: [],
  });
  assert.deepEqual(unit.aliases, ["strategy"]);
  assert.deepEqual(unit.sourceIds, ["brain:working-synthesis"]);
  assert.equal(unit.authorityLayer, "synthesized");
});
