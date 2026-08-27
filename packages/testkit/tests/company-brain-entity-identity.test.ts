import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  createBrainPageVersion,
  createEntityIdentity,
  createEntityIdentityDecision,
  createEntityIdentityMembership,
  createEntityIdentityProposal,
  type BrainPageVersionInput,
} from "../../knowledge/brain-contracts.ts";
import type { BrainStore } from "../../knowledge/brain-store.ts";
import { InMemoryBrainStore } from "../../knowledge/in-memory-brain-store.ts";
import { PostgresBrainStore } from "../../state-postgres/brain-store.ts";

const pageInput = (source: string, key: string, overrides: Partial<BrainPageVersionInput> = {}): BrainPageVersionInput => ({
  pageTypeKey: "person",
  sourceId: source,
  sourcePageKey: key,
  verificationStatus: "verified",
  accessPolicyId: "policy:people",
  lifecycleStatus: "active",
  pageCreatedAt: "2026-08-26T09:00:00Z",
  version: 1,
  title: "Peter",
  body: "Provider-specific person record.",
  metadata: { provider_key: key },
  observedAt: "2026-08-26T09:00:00Z",
  versionCreatedAt: "2026-08-26T09:01:00Z",
  sourceObjectId: key,
  sourceObjectVersion: "v1",
  ...overrides,
});

const entity = () => createEntityIdentity({
  entityKind: "person",
  stableKey: "provider:google:user:123",
  displayName: "Peter",
  creationBasis: "provider-identifier",
  creationReceiptId: "receipt:google-user:123",
  createdAt: "2026-08-26T09:02:00Z",
});

const prepareTarget = async (store: BrainStore) => {
  const target = entity();
  const anchor = createBrainPageVersion(pageInput("source:google-directory", "google:user:123"));
  await store.putPageVersion(anchor);
  await store.putEntityIdentity(target);
  await store.putEntityMembership(createEntityIdentityMembership({
    entity: target,
    page: anchor.page,
    proofBasis: "provider-identifier",
    proofReceiptId: "receipt:google-user:123",
    createdAt: "2026-08-26T09:03:00Z",
  }));
  return { target, anchor };
};

test("deterministic identity proof links a Page without changing its source-specific history", async () => {
  const store = new InMemoryBrainStore();
  const { target, anchor } = await prepareTarget(store);
  const membership = await store.getEntityMembershipForPage(anchor.page.pageId);
  assert.equal(membership?.entityId, target.entityId);
  assert.equal(membership?.proofBasis, "provider-identifier");
  assert.equal(membership?.pageAccessPolicyId, anchor.page.accessPolicyId);
  assert.deepEqual(await store.listEntityMemberships(target.entityId), [membership]);
  assert.deepEqual(await store.getPage(anchor.page.pageId), anchor);
  assert.equal((await store.putEntityIdentity(structuredClone(target))), "unchanged");

  const renamed = createEntityIdentity({
    entityKind: target.entityKind,
    stableKey: target.stableKey,
    displayName: "Different content under the same stable identity",
    creationBasis: target.creationBasis,
    creationReceiptId: target.creationReceiptId,
    createdAt: target.createdAt,
  });
  await assert.rejects(() => store.putEntityIdentity(renamed), /different content/);
});

test("fuzzy identity remains a proposal until an attributable accept decision", async () => {
  const store = new InMemoryBrainStore();
  const { target } = await prepareTarget(store);
  const candidate = createBrainPageVersion(pageInput("source:crm", "contact:77", { accessPolicyId: "policy:sales-private" }));
  await store.putPageVersion(candidate);
  const proposal = createEntityIdentityProposal({
    candidatePage: candidate.page,
    targetEntity: target,
    method: "name-similarity",
    score: 0.91,
    rationale: "Normalized name and verified company email domain match.",
    evidenceReceiptIds: ["receipt:matcher:77"],
    createdBy: "rule:identity-candidate",
    createdAt: "2026-08-26T10:00:00Z",
  });
  assert.equal(await store.putEntityIdentityProposal(proposal), "inserted");
  assert.equal(await store.putEntityIdentityProposal(structuredClone(proposal)), "unchanged");
  assert.equal(await store.getEntityMembershipForPage(candidate.page.pageId), undefined);

  const decision = createEntityIdentityDecision({
    proposal,
    candidatePage: candidate.page,
    targetEntity: target,
    decision: "accepted",
    decidedBy: "principal:identity-steward",
    decidedAt: "2026-08-26T11:00:00Z",
    decisionReceiptId: "receipt:identity-decision:77",
  });
  assert.equal(await store.decideEntityIdentityProposal(decision), "inserted");
  assert.equal(await store.decideEntityIdentityProposal(structuredClone(decision)), "unchanged");
  assert.deepEqual(await store.getEntityIdentityDecision(proposal.proposalId), decision);
  const membership = await store.getEntityMembershipForPage(candidate.page.pageId);
  assert.equal(membership?.proofBasis, "review-decision");
  assert.equal(membership?.proofReceiptId, decision.decisionReceiptId);
  assert.equal(membership?.pageAccessPolicyId, "policy:sales-private");

  await assert.rejects(
    () => store.putEntityMembership(decision.membership!),
    /must be applied through an attributable Entity proposal decision/,
  );
});

test("rejection creates no membership and an incompatible second decision fails closed", async () => {
  const store = new InMemoryBrainStore();
  const { target } = await prepareTarget(store);
  const candidate = createBrainPageVersion(pageInput("source:slack", "user:ambiguous"));
  await store.putPageVersion(candidate);
  assert.throws(() => createEntityIdentityProposal({
    candidatePage: candidate.page,
    targetEntity: target,
    method: "model-judgment",
    score: 0.7,
    rationale: "Model-only candidate.",
    evidenceReceiptIds: ["receipt:model-candidate"],
    createdBy: "model:identity",
    createdAt: "2026-08-26T10:00:00Z",
  }), /requires model, prompt, and extraction-run provenance/);
  const proposal = createEntityIdentityProposal({
    candidatePage: candidate.page,
    targetEntity: target,
    method: "model-judgment",
    score: 0.7,
    rationale: "Model-only candidate requiring review.",
    evidenceReceiptIds: ["receipt:model-candidate"],
    createdBy: "model:identity",
    createdAt: "2026-08-26T10:00:00Z",
    modelProvenance: { model: "fixture-model", promptVersion: "1", extractionRunId: "run:identity:1" },
  });
  await store.putEntityIdentityProposal(proposal);
  const rejected = createEntityIdentityDecision({
    proposal,
    candidatePage: candidate.page,
    targetEntity: target,
    decision: "rejected",
    decidedBy: "principal:identity-steward",
    decidedAt: "2026-08-26T11:00:00Z",
    decisionReceiptId: "receipt:identity-reject:1",
  });
  await store.decideEntityIdentityProposal(rejected);
  assert.equal(await store.getEntityMembershipForPage(candidate.page.pageId), undefined);
  const conflicting = createEntityIdentityDecision({
    proposal,
    candidatePage: candidate.page,
    targetEntity: target,
    decision: "accepted",
    decidedBy: "principal:other-steward",
    decidedAt: "2026-08-26T12:00:00Z",
    decisionReceiptId: "receipt:identity-accept:2",
  });
  await assert.rejects(() => store.decideEntityIdentityProposal(conflicting), /already has a different decision/);
});

test("one source-specific Page cannot silently join two Entity identities", async () => {
  const store = new InMemoryBrainStore();
  const { anchor } = await prepareTarget(store);
  const other = createEntityIdentity({
    entityKind: "person",
    stableKey: "provider:crm:contact:999",
    displayName: "Another Peter",
    creationBasis: "administrator-mapping",
    creationReceiptId: "receipt:admin-map:999",
    createdAt: "2026-08-26T10:00:00Z",
  });
  await store.putEntityIdentity(other);
  const conflictingMembership = createEntityIdentityMembership({
    entity: other,
    page: anchor.page,
    proofBasis: "administrator-mapping",
    proofReceiptId: "receipt:admin-map:999",
    createdAt: "2026-08-26T10:01:00Z",
  });
  await assert.rejects(() => store.putEntityMembership(conflictingMembership), /already belongs to a different Entity/);
  assert.throws(() => createEntityIdentityMembership({
    entity: other,
    page: anchor.page,
    proofBasis: "model-judgment" as never,
    proofReceiptId: "receipt:model",
    createdAt: "2026-08-26T10:01:00Z",
  }), /Unsupported Entity membership proof/);
});

test("the additive schema separates Entity memberships from fuzzy proposals", () => {
  const schema = readFileSync(join(import.meta.dirname, "../../state-postgres/knowledge-schema.sql"), "utf8");
  const migration = readFileSync(join(import.meta.dirname, "../../state-postgres/knowledge-migrate.ts"), "utf8");
  for (const table of ["entity_identities", "entity_identity_members", "entity_identity_proposals"]) {
    const statement = `create table if not exists companyos_knowledge.${table}`;
    assert.equal(schema.includes(statement), true);
    assert.equal(migration.includes(statement), true);
  }
  const memberDefinition = schema.slice(schema.indexOf("create table if not exists companyos_knowledge.entity_identity_members"), schema.indexOf("create index if not exists knowledge_entity_members_entity_idx"));
  assert.doesNotMatch(memberDefinition, /name-similarity|embedding-similarity|model-judgment/);
  assert.match(schema, /unique \(page_id\)/);
});

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("PostgresBrainStore applies reviewed identity membership atomically", { skip: !runDatabaseTests }, async () => {
  const suffix = randomUUID();
  const store = new PostgresBrainStore();
  const target = createEntityIdentity({
    entityKind: "person",
    stableKey: `test:entity:${suffix}`,
    displayName: "Entity test",
    creationBasis: "provider-identifier",
    creationReceiptId: `receipt:${suffix}`,
    createdAt: "2026-08-26T09:00:00Z",
  });
  await store.putEntityIdentity(target);
  const candidate = createBrainPageVersion(pageInput(`source:test:${suffix}`, `page:${suffix}`));
  await store.putPageVersion(candidate);
  const proposal = createEntityIdentityProposal({
    candidatePage: candidate.page,
    targetEntity: target,
    method: "embedding-similarity",
    score: 0.88,
    rationale: "Database integration fixture.",
    evidenceReceiptIds: [`receipt:embedding:${suffix}`],
    createdBy: "test:entity-identity",
    createdAt: "2026-08-26T10:00:00Z",
  });
  await store.putEntityIdentityProposal(proposal);
  const decision = createEntityIdentityDecision({
    proposal,
    candidatePage: candidate.page,
    targetEntity: target,
    decision: "accepted",
    decidedBy: "principal:test-steward",
    decidedAt: "2026-08-26T11:00:00Z",
    decisionReceiptId: `receipt:decision:${suffix}`,
  });
  await store.decideEntityIdentityProposal(decision);
  assert.deepEqual(await store.getEntityMembershipForPage(candidate.page.pageId), decision.membership);
});
