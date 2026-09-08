import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { neon } from "@neondatabase/serverless";
import {
  createBrainClaim,
  createBrainPageVersion,
  createClaimResolutionProposal,
  type BrainPageTypeDefinition,
  type BrainPageVersionInput,
  type ClaimEvidence,
} from "../../knowledge/brain-contracts.ts";
import type { BrainStore } from "../../knowledge/brain-store.ts";
import { InMemoryBrainStore } from "../../knowledge/in-memory-brain-store.ts";
import { PostgresBrainStore } from "../../state-postgres/brain-store.ts";

const pageInput = (overrides: Partial<BrainPageVersionInput> = {}): BrainPageVersionInput => ({
  pageTypeKey: "meeting",
  sourceId: "source:meeting-provider",
  sourcePageKey: "meeting:launch",
  verificationStatus: "verified",
  accessPolicyId: "policy:launch-team",
  lifecycleStatus: "active",
  pageCreatedAt: "2026-08-26T09:00:00Z",
  version: 1,
  title: "Launch meeting",
  summary: "Launch readiness review.",
  body: "The launch team reviewed readiness and open risks.",
  metadata: { participants: ["person:peter"] },
  observedAt: "2026-08-26T09:00:00Z",
  versionCreatedAt: "2026-08-26T09:01:00Z",
  sourceObjectId: "provider-meeting:launch",
  sourceObjectVersion: "v1",
  ...overrides,
});

const evidence = (overrides: Partial<ClaimEvidence> = {}): ClaimEvidence => ({
  evidenceId: "evidence:launch:42",
  sourceId: "source:meeting-provider",
  providerObjectId: "provider-meeting:launch",
  providerVersion: "v1",
  contentDigest: "c".repeat(64),
  observedAt: "2026-08-26T09:00:00Z",
  locator: { kind: "timestamp", startMs: 42_000, endMs: 45_000 },
  ...overrides,
});

const activeTake = () => createBrainClaim({
  memoryClass: "take",
  claimKind: "bet",
  claimText: "The launch will happen before September.",
  primaryHolder: { holderId: "person:peter", holderType: "person", displayName: "Peter" },
  derivation: "source-literal",
  observedAt: "2026-08-26T09:00:00Z",
  evidence: [evidence()],
  extractionConfidence: 0.95,
  epistemicWeight: 0.8,
  accessPolicyId: "policy:launch-team",
  createdBy: "agent:oregano",
});

const exerciseStore = async (store: BrainStore) => {
  const first = createBrainPageVersion(pageInput());
  assert.equal(await store.putPageVersion(first), "inserted");
  assert.equal(await store.putPageVersion(structuredClone(first)), "unchanged");

  const second = createBrainPageVersion(pageInput({
    version: 2,
    body: "The launch team closed the readiness risks.",
    summary: "Launch readiness confirmed.",
    observedAt: "2026-08-27T09:00:00Z",
    versionCreatedAt: "2026-08-27T09:01:00Z",
    sourceObjectVersion: "v2",
  }));
  assert.equal(await store.putPageVersion(second), "inserted");
  assert.equal((await store.getPage(first.page.pageId))?.version.pageVersionId, second.version.pageVersionId);
  assert.equal((await store.getPage(first.page.pageId, first.version.pageVersionId))?.version.body, first.version.body);
  assert.deepEqual((await store.listPageVersions(first.page.pageId)).map((entry) => entry.version), [1, 2]);

  const claim = activeTake();
  assert.equal(await store.putClaim(claim), "inserted");
  assert.equal(await store.putClaim(structuredClone(claim)), "unchanged");
  assert.deepEqual(await store.getClaim(claim.claimId), claim);
  assert.deepEqual(await store.getHolder(claim.primaryHolder!.holderId), claim.primaryHolder);

  const proposal = createClaimResolutionProposal({
    claim,
    outcome: "correct",
    outcomeEvidence: [evidence({
      evidenceId: "evidence:calendar:launch",
      sourceId: "source:calendar",
      providerObjectId: "calendar:launch",
      providerVersion: "v1",
      observedAt: "2026-08-30T18:00:00Z",
    })],
    proposedBy: "model:grader",
    proposedAt: "2026-08-30T18:05:00Z",
    judgeReceiptId: "receipt:grader:launch",
  });
  assert.equal(await store.putResolutionProposal(proposal), "inserted");
  assert.equal(await store.putResolutionProposal(structuredClone(proposal)), "unchanged");
  assert.deepEqual(await store.getResolutionProposal(proposal.proposalId), proposal);
};

test("the in-memory BrainStore preserves immutable Page history and Claim evidence", async () => {
  await exerciseStore(new InMemoryBrainStore());
});

test("BrainStore Page writes reject gaps, identity drift, and deterministic-ID tampering", async () => {
  const store = new InMemoryBrainStore();
  const first = createBrainPageVersion(pageInput());
  await store.putPageVersion(first);

  const gap = createBrainPageVersion(pageInput({
    version: 3,
    body: "A non-contiguous version.",
    observedAt: "2026-08-28T09:00:00Z",
    versionCreatedAt: "2026-08-28T09:01:00Z",
    sourceObjectVersion: "v3",
  }));
  await assert.rejects(() => store.putPageVersion(gap), /expected version 2/);

  const policyDrift = createBrainPageVersion(pageInput({
    version: 2,
    accessPolicyId: "policy:everyone",
    observedAt: "2026-08-27T09:00:00Z",
    versionCreatedAt: "2026-08-27T09:01:00Z",
    sourceObjectVersion: "v2",
  }));
  await assert.rejects(() => store.putPageVersion(policyDrift), /different immutable identity/);

  const tampered = structuredClone(first);
  tampered.version.body = "Changed without recomputing the digest and identity.";
  await assert.rejects(() => store.putPageVersion(tampered), /integrity validation/);
});

test("BrainStore duplicate writes are idempotent under concurrent delivery", async () => {
  const store = new InMemoryBrainStore();
  const record = createBrainPageVersion(pageInput());
  const results = await Promise.all([store.putPageVersion(structuredClone(record)), store.putPageVersion(structuredClone(record))]);
  assert.deepEqual(results.sort(), ["inserted", "unchanged"]);
  assert.equal((await store.listPageVersions(record.page.pageId)).length, 1);
});

test("BrainStore preserves Fact scope and keeps model-derived Takes proposed", async () => {
  const store = new InMemoryBrainStore();
  const fact = createBrainClaim({
    memoryClass: "fact",
    claimKind: "preference",
    claimText: "Use the concise launch-report format.",
    ownerPrincipalId: "principal:peter",
    scope: { kind: "session", sessionId: "session:launch" },
    observedAt: "2026-08-26T09:00:00Z",
    evidence: [evidence()],
    extractionConfidence: 0.9,
    epistemicWeight: 0.75,
    accessPolicyId: "policy:launch-team",
    createdBy: "agent:oregano",
  });
  await store.putClaim(fact);
  assert.deepEqual((await store.getClaim(fact.claimId))?.scope, fact.scope);

  const modelTake = createBrainClaim({
    memoryClass: "take",
    claimKind: "hunch",
    claimText: "Annual billing may improve retention.",
    primaryHolder: { holderId: "system:extraction", holderType: "system", displayName: "CompanyOS extraction" },
    derivation: "model-derived",
    observedAt: "2026-08-26T09:00:00Z",
    evidence: [evidence({ evidenceId: "evidence:billing:1" })],
    extractionConfidence: 1,
    epistemicWeight: 0.95,
    accessPolicyId: "policy:deal-team",
    createdBy: "model:extractor",
    modelProvenance: { model: "fixture-model", promptVersion: "1", extractionRunId: "run:billing" },
  });
  await store.putClaim(modelTake);
  assert.equal((await store.getClaim(modelTake.claimId))?.status, "proposed");
});

test("the Postgres BrainStore uses the existing database and serializable write transactions", () => {
  const source = readFileSync(join(import.meta.dirname, "../../state-postgres/brain-store.ts"), "utf8");
  assert.match(source, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(source, /BRAIN_DATABASE_URL|KNOWLEDGE_DATABASE_URL/);
  assert.ok(source.match(/isolationLevel: "Serializable"/g)?.length && source.match(/isolationLevel: "Serializable"/g)!.length >= 3);
});

test("production reads and compounding exclude model artifacts without a successful extraction receipt", () => {
  const brain = readFileSync(join(process.cwd(), "packages/state-postgres/brain-store.ts"), "utf8");
  const retrieval = readFileSync(join(process.cwd(), "packages/state-postgres/brain-retrieval-store.ts"), "utf8");
  const compounding = readFileSync(join(process.cwd(), "packages/state-postgres/knowledge-compounding-store.ts"), "utf8");
  for (const source of [brain, retrieval, compounding]) {
    assert.match(source, /extraction_runs/);
    assert.match(source, /status = 'succeeded'/);
  }
});

test("BrainStore rejects registry, Holder, Claim, and proposal identity conflicts", async () => {
  const store = new InMemoryBrainStore();
  const extension: BrainPageTypeDefinition = {
    key: "customer-interview",
    taxonomyVersion: "workspace:1.0.0",
    displayLabel: "Customer interview",
    aliases: ["user-interview"],
    parentKey: "conversation",
    extractionProfile: "transcript",
    origin: "extension",
    status: "active",
  };
  assert.equal(await store.registerPageType(extension), "inserted");
  assert.equal(await store.registerPageType(structuredClone(extension)), "unchanged");
  await assert.rejects(() => store.registerPageType({ ...extension, displayLabel: "Different" }), /different content|Duplicate/);
  assert.equal((await store.getPageType("user-interview"))?.key, extension.key);

  const claim = activeTake();
  await store.putClaim(claim);
  const tamperedClaim = structuredClone(claim);
  tamperedClaim.status = "resolved";
  await assert.rejects(() => store.putClaim(tamperedClaim), /integrity validation/);

  const holderConflict = createBrainClaim({
    memoryClass: "take",
    claimKind: "take",
    claimText: "A second attributable statement.",
    primaryHolder: { ...claim.primaryHolder!, displayName: "Different person" },
    derivation: "source-literal",
    observedAt: "2026-08-26T10:00:00Z",
    evidence: [evidence({ evidenceId: "evidence:launch:84" })],
    extractionConfidence: 0.9,
    epistemicWeight: 0.75,
    accessPolicyId: "policy:launch-team",
    createdBy: "agent:oregano",
  });
  await assert.rejects(() => store.putClaim(holderConflict), /Holder.*different content/);

  const unknownProposal = createClaimResolutionProposal({
    claim,
    outcome: "partial",
    outcomeEvidence: [evidence({
      evidenceId: "evidence:result:1",
      sourceId: "source:results",
      providerObjectId: "result:1",
      observedAt: "2026-08-30T18:00:00Z",
    })],
    proposedBy: "model:grader",
    proposedAt: "2026-08-30T18:05:00Z",
    judgeReceiptId: "receipt:grader:result",
  });
  const emptyStore = new InMemoryBrainStore();
  await assert.rejects(() => emptyStore.putResolutionProposal(unknownProposal), /Unknown Brain Claim/);
});

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("PostgresBrainStore round-trips the provider-neutral persistence contract", { skip: !runDatabaseTests }, async () => {
  const suffix = randomUUID();
  const store = new PostgresBrainStore();
  const input = pageInput({
    sourceId: `source:test:${suffix}`,
    sourcePageKey: `page:${suffix}`,
    sourceObjectId: `object:${suffix}`,
  });
  const page = createBrainPageVersion(input);
  assert.equal(await store.putPageVersion(page), "inserted");
  assert.equal(await store.putPageVersion(structuredClone(page)), "unchanged");
  assert.deepEqual(await store.getPage(page.page.pageId), page);

  const claim = createBrainClaim({
    memoryClass: "fact",
    claimKind: "commitment",
    claimText: `Persistence qualification ${suffix}`,
    ownerPrincipalId: `principal:test:${suffix}`,
    scope: { kind: "session", sessionId: `session:test:${suffix}` },
    observedAt: "2026-08-26T09:00:00Z",
    evidence: [evidence({
      evidenceId: `evidence:${suffix}`,
      sourceId: input.sourceId,
      providerObjectId: input.sourceObjectId,
    })],
    extractionConfidence: 0.9,
    epistemicWeight: 0.75,
    accessPolicyId: input.accessPolicyId,
    createdBy: "test:postgres-brain-store",
  });
  assert.equal(await store.putClaim(claim), "inserted");
  assert.deepEqual(await store.getClaim(claim.claimId), claim);
  const sql = neon(process.env.DATABASE_URL!);
  assert.equal((await sql`select model_provenance is null as absent from companyos_knowledge.claims where claim_id = ${claim.claimId}`)[0].absent, true);
  // Previous versions stored JSON null instead of SQL NULL. Those source
  // facts must remain readable without pretending they have model provenance.
  await sql`update companyos_knowledge.claims set model_provenance = 'null'::jsonb where claim_id = ${claim.claimId}`;
  assert.deepEqual(await store.getClaim(claim.claimId), claim);
  assert.equal(await store.putClaim(claim), "unchanged");

  const take = createBrainClaim({
    memoryClass: "take",
    claimKind: "take",
    claimText: `Persistence opinion ${suffix}`,
    primaryHolder: {
      holderId: `holder:test:${suffix}`,
      holderType: "person",
      displayName: "Postgres qualification holder",
    },
    derivation: "source-literal",
    observedAt: "2026-08-26T09:01:00Z",
    evidence: [evidence({
      evidenceId: `evidence:take:${suffix}`,
      sourceId: input.sourceId,
      providerObjectId: input.sourceObjectId,
    })],
    extractionConfidence: 0.8,
    epistemicWeight: 0.6,
    accessPolicyId: input.accessPolicyId,
    createdBy: "test:postgres-brain-store",
  });
  assert.equal(await store.putClaim(take), "inserted");
  assert.deepEqual(await store.getClaim(take.claimId), take);
});
