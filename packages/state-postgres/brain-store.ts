import { neon } from "@neondatabase/serverless";
import {
  assertBrainClaimIntegrity,
  assertBrainPageTypeRegistry,
  assertBrainPageVersionIntegrity,
  assertClaimResolutionProposalIntegrity,
  assertEntityIdentityDecisionIntegrity,
  assertEntityIdentityIntegrity,
  assertEntityIdentityMembershipIntegrity,
  assertEntityIdentityProposalIntegrity,
  type BrainClaim,
  type BrainPage,
  type BrainPageTypeDefinition,
  type BrainPageVersion,
  type ClaimEvidence,
  type ClaimResolutionProposal,
  type EntityIdentity,
  type EntityIdentityDecision,
  type EntityIdentityMembership,
  type EntityIdentityProposal,
  type EpistemicHolder,
} from "../knowledge/brain-contracts.ts";
import type {
  BrainClaimRelation,
  BrainPageRecord,
  BrainStore,
  BrainTimelineEvent,
  BrainWriteResult,
} from "../knowledge/brain-store.ts";
import { ensureCompanyKnowledgeSchema } from "./knowledge-migrate.ts";

const connection = () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — Company Brain uses the existing Company Instance Neon database.");
  return neon(url);
};

const json = <T>(value: unknown): T => value as T;
const optionalString = (value: unknown): string | undefined => value === null || value === undefined ? undefined : String(value);

const mapPageType = (row: Record<string, unknown>, aliases: string[]): BrainPageTypeDefinition => ({
  key: String(row.type_key),
  taxonomyVersion: String(row.taxonomy_version),
  displayLabel: String(row.display_label),
  aliases,
  parentKey: optionalString(row.parent_key),
  extractionProfile: String(row.extraction_profile),
  origin: row.origin as BrainPageTypeDefinition["origin"],
  status: row.lifecycle_status as BrainPageTypeDefinition["status"],
});

const mapPage = (row: Record<string, unknown>): BrainPage => ({
  pageId: String(row.page_id),
  pageTypeKey: String(row.page_type_key),
  sourceId: String(row.source_id),
  sourcePageKey: String(row.source_page_key),
  currentVersionId: String(row.current_version_id),
  verificationStatus: row.verification_status as BrainPage["verificationStatus"],
  accessPolicyId: String(row.page_access_policy_id ?? row.access_policy_id),
  lifecycleStatus: row.lifecycle_status as BrainPage["lifecycleStatus"],
  createdAt: new Date(String(row.page_created_at ?? row.created_at)).toISOString(),
});

const mapPageVersion = (row: Record<string, unknown>): BrainPageVersion => ({
  pageVersionId: String(row.page_version_id),
  pageId: String(row.page_id),
  version: Number(row.version_number),
  title: String(row.title),
  summary: optionalString(row.summary),
  body: String(row.body),
  metadata: json<Record<string, unknown>>(row.metadata),
  contentDigest: String(row.content_digest),
  observedAt: new Date(String(row.observed_at)).toISOString(),
  createdAt: new Date(String(row.version_created_at ?? row.created_at)).toISOString(),
  sourceObjectId: String(row.source_object_id),
  sourceObjectVersion: String(row.source_object_version),
  accessPolicyId: String(row.version_access_policy_id ?? row.access_policy_id),
  modelProvenance: row.model_provenance ? json<BrainPageVersion["modelProvenance"]>(row.model_provenance) : undefined,
});

const mapEvidence = (row: Record<string, unknown>): ClaimEvidence => ({
  evidenceId: String(row.evidence_id),
  sourceId: String(row.source_id),
  providerObjectId: String(row.provider_object_id),
  providerVersion: String(row.provider_version),
  contentDigest: String(row.content_digest),
  observedAt: new Date(String(row.observed_at)).toISOString(),
  locator: json<ClaimEvidence["locator"]>(row.locator),
  pageId: optionalString(row.page_id),
  pageVersionId: optionalString(row.page_version_id),
});

const mapEntity = (row: Record<string, unknown>): EntityIdentity => ({
  entityId: String(row.entity_id),
  entityKind: row.entity_kind as EntityIdentity["entityKind"],
  stableKey: String(row.stable_key),
  displayName: String(row.display_name),
  creationBasis: row.creation_basis as EntityIdentity["creationBasis"],
  creationReceiptId: String(row.creation_receipt_id),
  lifecycleStatus: row.lifecycle_status as EntityIdentity["lifecycleStatus"],
  createdAt: new Date(String(row.created_at)).toISOString(),
});

const mapEntityMembership = (row: Record<string, unknown>): EntityIdentityMembership => ({
  membershipId: String(row.membership_id),
  entityId: String(row.entity_id),
  pageId: String(row.page_id),
  proofBasis: row.proof_basis as EntityIdentityMembership["proofBasis"],
  proofReceiptId: String(row.proof_receipt_id),
  pageAccessPolicyId: String(row.page_access_policy_id),
  status: row.status as EntityIdentityMembership["status"],
  createdAt: new Date(String(row.created_at)).toISOString(),
});

const mapEntityProposal = (row: Record<string, unknown>): EntityIdentityProposal => ({
  proposalId: String(row.proposal_id),
  candidatePageId: String(row.candidate_page_id),
  targetEntityId: String(row.target_entity_id),
  method: row.method as EntityIdentityProposal["method"],
  score: row.score === null || row.score === undefined ? undefined : Number(row.score),
  rationale: String(row.rationale),
  evidenceReceiptIds: json<string[]>(row.evidence_receipt_ids),
  candidateAccessPolicyId: String(row.candidate_access_policy_id),
  createdBy: String(row.created_by),
  createdAt: new Date(String(row.created_at)).toISOString(),
  modelProvenance: row.model_provenance ? json<EntityIdentityProposal["modelProvenance"]>(row.model_provenance) : undefined,
  status: "proposed",
});

export class PostgresBrainStore implements BrainStore {
  async registerPageType(definition: BrainPageTypeDefinition): Promise<BrainWriteResult> {
    await ensureCompanyKnowledgeSchema();
    const definitions = await this.#listPageTypes();
    assertBrainPageTypeRegistry([...definitions.filter((entry) => entry.key !== definition.key), definition]);
    const sql = connection();
    const results = await sql.transaction((tx) => [
      tx`insert into companyos_knowledge.page_type_registry (
          type_key, taxonomy_version, display_label, parent_key, extraction_profile, origin, lifecycle_status, definition)
        values (${definition.key}, ${definition.taxonomyVersion}, ${definition.displayLabel}, ${definition.parentKey ?? null},
          ${definition.extractionProfile}, ${definition.origin}, ${definition.status}, ${JSON.stringify(definition)})
        on conflict (type_key) do update set type_key = excluded.type_key
        where companyos_knowledge.page_type_registry.taxonomy_version = excluded.taxonomy_version
          and companyos_knowledge.page_type_registry.display_label = excluded.display_label
          and companyos_knowledge.page_type_registry.parent_key is not distinct from excluded.parent_key
          and companyos_knowledge.page_type_registry.extraction_profile = excluded.extraction_profile
          and companyos_knowledge.page_type_registry.origin = excluded.origin
          and companyos_knowledge.page_type_registry.lifecycle_status = excluded.lifecycle_status
        returning (xmax = 0) as inserted`,
      ...definition.aliases.map((alias) => tx`insert into companyos_knowledge.page_type_aliases (alias, type_key, mapping_evidence)
        values (${alias}, ${definition.key}, ${JSON.stringify({ taxonomy_version: definition.taxonomyVersion, origin: definition.origin })})
        on conflict (alias) do update set alias = excluded.alias
        where companyos_knowledge.page_type_aliases.type_key = excluded.type_key
          and companyos_knowledge.page_type_aliases.mapping_evidence = excluded.mapping_evidence
        returning alias`),
    ], { isolationLevel: "Serializable" });
    if (results.some((rows) => rows.length === 0)) throw new Error(`Brain Page type '${definition.key}' conflicts with an existing registry entry or alias.`);
    return results[0][0]?.inserted === true ? "inserted" : "unchanged";
  }

  async getPageType(keyOrAlias: string): Promise<BrainPageTypeDefinition | undefined> {
    await ensureCompanyKnowledgeSchema();
    const normalized = keyOrAlias.trim().toLocaleLowerCase("en");
    const sql = connection();
    const rows = await sql`select distinct r.* from companyos_knowledge.page_type_registry r
      left join companyos_knowledge.page_type_aliases a on a.type_key = r.type_key
      where r.type_key = ${normalized} or a.alias = ${normalized} limit 1`;
    if (!rows[0]) return undefined;
    const aliases = await sql`select alias from companyos_knowledge.page_type_aliases
      where type_key = ${String(rows[0].type_key)} order by alias`;
    return mapPageType(rows[0] as Record<string, unknown>, aliases.map((entry) => String(entry.alias)));
  }

  async putPageVersion(record: BrainPageRecord): Promise<BrainWriteResult> {
    await ensureCompanyKnowledgeSchema();
    assertBrainPageVersionIntegrity(record.page, record.version);
    const sql = connection();
    const page = record.page;
    const version = record.version;
    const results = await sql.transaction((tx) => [
      tx`insert into companyos_knowledge.pages (
          page_id, page_type_key, source_id, source_page_key, current_version_id,
          verification_status, access_policy_id, lifecycle_status, created_at)
        values (${page.pageId}, ${page.pageTypeKey}, ${page.sourceId}, ${page.sourcePageKey}, ${page.currentVersionId},
          ${page.verificationStatus}, ${page.accessPolicyId}, ${page.lifecycleStatus}, ${page.createdAt})
        on conflict (page_id) do update set page_id = excluded.page_id
        where companyos_knowledge.pages.page_type_key = excluded.page_type_key
          and companyos_knowledge.pages.source_id = excluded.source_id
          and companyos_knowledge.pages.source_page_key = excluded.source_page_key
          and companyos_knowledge.pages.verification_status = excluded.verification_status
          and companyos_knowledge.pages.access_policy_id = excluded.access_policy_id
          and companyos_knowledge.pages.lifecycle_status = excluded.lifecycle_status
          and companyos_knowledge.pages.created_at = excluded.created_at
        returning page_id`,
      tx`insert into companyos_knowledge.page_versions (
          page_version_id, page_id, version_number, title, summary, body, metadata, content_digest,
          observed_at, created_at, source_object_id, source_object_version, access_policy_id, model_provenance)
        select ${version.pageVersionId}, ${version.pageId}, ${version.version}, ${version.title}, ${version.summary ?? null},
          ${version.body}, ${JSON.stringify(version.metadata)}, ${version.contentDigest}, ${version.observedAt}, ${version.createdAt},
          ${version.sourceObjectId}, ${version.sourceObjectVersion}, ${version.accessPolicyId}, ${JSON.stringify(version.modelProvenance ?? null)}
        where exists (
          select 1 from companyos_knowledge.pages where page_id = ${page.pageId}
            and page_type_key = ${page.pageTypeKey} and source_id = ${page.sourceId}
            and source_page_key = ${page.sourcePageKey} and verification_status = ${page.verificationStatus}
            and access_policy_id = ${page.accessPolicyId} and lifecycle_status = ${page.lifecycleStatus}
            and created_at = ${page.createdAt}
        ) and (
          exists (select 1 from companyos_knowledge.page_versions where page_version_id = ${version.pageVersionId})
          or ${version.version} = coalesce((select max(version_number) + 1 from companyos_knowledge.page_versions where page_id = ${page.pageId}), 1)
        )
        on conflict (page_version_id) do update set page_version_id = excluded.page_version_id
        where companyos_knowledge.page_versions.page_id = excluded.page_id
          and companyos_knowledge.page_versions.version_number = excluded.version_number
          and companyos_knowledge.page_versions.title = excluded.title
          and companyos_knowledge.page_versions.summary is not distinct from excluded.summary
          and companyos_knowledge.page_versions.body = excluded.body
          and companyos_knowledge.page_versions.metadata = excluded.metadata
          and companyos_knowledge.page_versions.content_digest = excluded.content_digest
          and companyos_knowledge.page_versions.observed_at = excluded.observed_at
          and companyos_knowledge.page_versions.created_at = excluded.created_at
          and companyos_knowledge.page_versions.source_object_id = excluded.source_object_id
          and companyos_knowledge.page_versions.source_object_version = excluded.source_object_version
          and companyos_knowledge.page_versions.access_policy_id = excluded.access_policy_id
          and companyos_knowledge.page_versions.model_provenance is not distinct from excluded.model_provenance
        returning (xmax = 0) as inserted`,
      tx`update companyos_knowledge.pages p set current_version_id = ${version.pageVersionId}
        where p.page_id = ${page.pageId}
          and exists (select 1 from companyos_knowledge.page_versions v
            where v.page_id = p.page_id and v.page_version_id = ${version.pageVersionId})
          and (select version_number from companyos_knowledge.page_versions where page_version_id = p.current_version_id)
            <= ${version.version}
        returning page_id`,
    ], { isolationLevel: "Serializable" });
    if (results[0].length === 0) throw new Error(`Brain Page '${page.pageId}' conflicts with an existing immutable identity.`);
    if (results[1].length === 0) throw new Error(`Brain Page version '${version.pageVersionId}' conflicts or is not the next version.`);
    return results[1][0]?.inserted === true ? "inserted" : "unchanged";
  }

  async getPage(pageId: string, pageVersionId?: string): Promise<BrainPageRecord | undefined> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select p.page_id, p.page_type_key, p.source_id, p.source_page_key, p.current_version_id,
        p.verification_status, p.access_policy_id as page_access_policy_id, p.lifecycle_status, p.created_at as page_created_at,
        v.page_version_id, v.version_number, v.title, v.summary, v.body, v.metadata, v.content_digest, v.observed_at,
        v.created_at as version_created_at, v.source_object_id, v.source_object_version,
        v.access_policy_id as version_access_policy_id, v.model_provenance
      from companyos_knowledge.pages p join companyos_knowledge.page_versions v
        on v.page_id = p.page_id and (
          v.page_version_id = ${pageVersionId ?? null}::text
          or (${pageVersionId ?? null}::text is null and v.page_version_id = p.current_version_id)
        )
      where p.page_id = ${pageId} limit 1`;
    if (!rows[0]) return undefined;
    const row = rows[0] as Record<string, unknown>;
    return { page: mapPage(row), version: mapPageVersion(row) };
  }

  async listPageVersions(pageId: string): Promise<BrainPageVersion[]> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select page_version_id, page_id, version_number, title, summary, body, metadata,
        content_digest, observed_at, created_at as version_created_at, source_object_id, source_object_version,
        access_policy_id as version_access_policy_id, model_provenance
      from companyos_knowledge.page_versions where page_id = ${pageId}
      order by version_number, page_version_id`;
    return rows.map((row) => mapPageVersion(row as Record<string, unknown>));
  }

  async putEntityIdentity(entity: EntityIdentity): Promise<BrainWriteResult> {
    await ensureCompanyKnowledgeSchema();
    assertEntityIdentityIntegrity(entity);
    const rows = await connection()`insert into companyos_knowledge.entity_identities (
        entity_id, entity_kind, stable_key, display_name, creation_basis, creation_receipt_id, lifecycle_status, created_at)
      values (${entity.entityId}, ${entity.entityKind}, ${entity.stableKey}, ${entity.displayName}, ${entity.creationBasis},
        ${entity.creationReceiptId}, ${entity.lifecycleStatus}, ${entity.createdAt})
      on conflict (entity_id) do update set entity_id = excluded.entity_id
      where companyos_knowledge.entity_identities.entity_kind = excluded.entity_kind
        and companyos_knowledge.entity_identities.stable_key = excluded.stable_key
        and companyos_knowledge.entity_identities.display_name = excluded.display_name
        and companyos_knowledge.entity_identities.creation_basis = excluded.creation_basis
        and companyos_knowledge.entity_identities.creation_receipt_id = excluded.creation_receipt_id
        and companyos_knowledge.entity_identities.lifecycle_status = excluded.lifecycle_status
        and companyos_knowledge.entity_identities.created_at = excluded.created_at
      returning (xmax = 0) as inserted`;
    if (rows.length === 0) throw new Error(`Entity identity '${entity.entityId}' conflicts with existing content.`);
    return rows[0].inserted === true ? "inserted" : "unchanged";
  }

  async getEntityIdentity(entityId: string): Promise<EntityIdentity | undefined> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select * from companyos_knowledge.entity_identities where entity_id = ${entityId} limit 1`;
    return rows[0] ? mapEntity(rows[0] as Record<string, unknown>) : undefined;
  }

  async putEntityMembership(membership: EntityIdentityMembership): Promise<BrainWriteResult> {
    if (membership.proofBasis === "review-decision") {
      throw new Error("Review-proven Entity memberships must be applied through an attributable Entity proposal decision.");
    }
    await ensureCompanyKnowledgeSchema();
    const context = await this.#entityMembershipContext(membership);
    assertEntityIdentityMembershipIntegrity(membership, context.entity, context.page);
    return this.#insertEntityMembership(membership, false);
  }

  async getEntityMembershipForPage(pageId: string): Promise<EntityIdentityMembership | undefined> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select * from companyos_knowledge.entity_identity_members where page_id = ${pageId} limit 1`;
    return rows[0] ? mapEntityMembership(rows[0] as Record<string, unknown>) : undefined;
  }

  async listEntityMemberships(entityId: string): Promise<EntityIdentityMembership[]> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select * from companyos_knowledge.entity_identity_members
      where entity_id = ${entityId} order by created_at, membership_id`;
    return rows.map((row) => mapEntityMembership(row as Record<string, unknown>));
  }

  async putEntityIdentityProposal(proposal: EntityIdentityProposal): Promise<BrainWriteResult> {
    await ensureCompanyKnowledgeSchema();
    const pageRecord = await this.getPage(proposal.candidatePageId);
    if (!pageRecord) throw new Error(`Unknown Entity proposal candidate Page '${proposal.candidatePageId}'.`);
    const entity = await this.getEntityIdentity(proposal.targetEntityId);
    if (!entity) throw new Error(`Unknown Entity proposal target '${proposal.targetEntityId}'.`);
    assertEntityIdentityProposalIntegrity(proposal, pageRecord.page, entity);
    const rows = await connection()`insert into companyos_knowledge.entity_identity_proposals (
        proposal_id, candidate_page_id, target_entity_id, method, score, rationale, evidence_receipt_ids,
        candidate_access_policy_id, created_by, created_at, model_provenance, status)
      select ${proposal.proposalId}, ${proposal.candidatePageId}, ${proposal.targetEntityId}, ${proposal.method},
        ${proposal.score ?? null}, ${proposal.rationale}, ${JSON.stringify(proposal.evidenceReceiptIds)},
        ${proposal.candidateAccessPolicyId}, ${proposal.createdBy}, ${proposal.createdAt},
        ${JSON.stringify(proposal.modelProvenance ?? null)}, 'proposed'
      where not exists (select 1 from companyos_knowledge.entity_identity_members where page_id = ${proposal.candidatePageId})
        or exists (select 1 from companyos_knowledge.entity_identity_proposals where proposal_id = ${proposal.proposalId})
      on conflict (proposal_id) do update set proposal_id = excluded.proposal_id
      where companyos_knowledge.entity_identity_proposals.candidate_page_id = excluded.candidate_page_id
        and companyos_knowledge.entity_identity_proposals.target_entity_id = excluded.target_entity_id
        and companyos_knowledge.entity_identity_proposals.method = excluded.method
        and companyos_knowledge.entity_identity_proposals.score is not distinct from excluded.score
        and companyos_knowledge.entity_identity_proposals.rationale = excluded.rationale
        and companyos_knowledge.entity_identity_proposals.evidence_receipt_ids = excluded.evidence_receipt_ids
        and companyos_knowledge.entity_identity_proposals.candidate_access_policy_id = excluded.candidate_access_policy_id
        and companyos_knowledge.entity_identity_proposals.created_by = excluded.created_by
        and companyos_knowledge.entity_identity_proposals.created_at = excluded.created_at
        and companyos_knowledge.entity_identity_proposals.model_provenance is not distinct from excluded.model_provenance
      returning (xmax = 0) as inserted`;
    if (rows.length === 0) throw new Error(`Entity identity proposal '${proposal.proposalId}' conflicts or the Page already has a membership.`);
    return rows[0].inserted === true ? "inserted" : "unchanged";
  }

  async getEntityIdentityProposal(proposalId: string): Promise<EntityIdentityProposal | undefined> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select * from companyos_knowledge.entity_identity_proposals where proposal_id = ${proposalId} limit 1`;
    return rows[0] ? mapEntityProposal(rows[0] as Record<string, unknown>) : undefined;
  }

  async decideEntityIdentityProposal(decision: EntityIdentityDecision): Promise<BrainWriteResult> {
    await ensureCompanyKnowledgeSchema();
    const proposal = await this.getEntityIdentityProposal(decision.proposalId);
    if (!proposal) throw new Error(`Unknown Entity identity proposal '${decision.proposalId}'.`);
    const pageRecord = await this.getPage(proposal.candidatePageId);
    const entity = await this.getEntityIdentity(proposal.targetEntityId);
    if (!pageRecord || !entity) throw new Error(`Entity identity proposal '${proposal.proposalId}' has unavailable Page or Entity evidence.`);
    assertEntityIdentityDecisionIntegrity({ decision, proposal, candidatePage: pageRecord.page, targetEntity: entity });
    const sql = connection();
    const decisionJson = JSON.stringify(decision);
    const membershipQuery = decision.membership
      ? sql`insert into companyos_knowledge.entity_identity_members (
          membership_id, entity_id, page_id, proof_basis, proof_receipt_id, page_access_policy_id, status, created_at)
        select ${decision.membership.membershipId}, ${decision.membership.entityId}, ${decision.membership.pageId},
          ${decision.membership.proofBasis}, ${decision.membership.proofReceiptId}, ${decision.membership.pageAccessPolicyId},
          ${decision.membership.status}, ${decision.membership.createdAt}
        where exists (select 1 from companyos_knowledge.entity_identity_proposals
          where proposal_id = ${proposal.proposalId} and (
            status = 'proposed' or (status = 'accepted' and decision_id = ${decision.decisionId} and decision = ${decisionJson}::jsonb)))
        on conflict (membership_id) do update set membership_id = excluded.membership_id
        where companyos_knowledge.entity_identity_members.entity_id = excluded.entity_id
          and companyos_knowledge.entity_identity_members.page_id = excluded.page_id
          and companyos_knowledge.entity_identity_members.proof_basis = excluded.proof_basis
          and companyos_knowledge.entity_identity_members.proof_receipt_id = excluded.proof_receipt_id
          and companyos_knowledge.entity_identity_members.page_access_policy_id = excluded.page_access_policy_id
          and companyos_knowledge.entity_identity_members.status = excluded.status
          and companyos_knowledge.entity_identity_members.created_at = excluded.created_at
        returning membership_id`
      : sql`select proposal_id from companyos_knowledge.entity_identity_proposals
        where proposal_id = ${proposal.proposalId} and (
          status = 'proposed' or (status = 'rejected' and decision_id = ${decision.decisionId} and decision = ${decisionJson}::jsonb))`;
    const results = await sql.transaction([
      sql`select status, decision_id, decision from companyos_knowledge.entity_identity_proposals
        where proposal_id = ${proposal.proposalId} for update`,
      membershipQuery,
      sql`update companyos_knowledge.entity_identity_proposals
        set status = ${decision.decision}, decision_id = ${decision.decisionId}, decision = ${decisionJson}, decided_at = ${decision.decidedAt}
        where proposal_id = ${proposal.proposalId} and (
          status = 'proposed' or (status = ${decision.decision} and decision_id = ${decision.decisionId} and decision = ${decisionJson}::jsonb))
        returning proposal_id`,
    ], { isolationLevel: "Serializable" });
    if (results[0].length === 0 || results[1].length === 0 || results[2].length === 0) {
      throw new Error(`Entity identity proposal '${proposal.proposalId}' already has a different decision or membership.`);
    }
    return results[0][0]?.status === "proposed" ? "inserted" : "unchanged";
  }

  async getEntityIdentityDecision(proposalId: string): Promise<EntityIdentityDecision | undefined> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select decision from companyos_knowledge.entity_identity_proposals
      where proposal_id = ${proposalId} and decision is not null limit 1`;
    return rows[0] ? json<EntityIdentityDecision>(rows[0].decision) : undefined;
  }

  async getHolder(holderId: string): Promise<EpistemicHolder | undefined> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select holder_id, holder_type, display_name from companyos_knowledge.holders
      where holder_id = ${holderId} limit 1`;
    return rows[0] ? {
      holderId: String(rows[0].holder_id),
      holderType: rows[0].holder_type as EpistemicHolder["holderType"],
      displayName: String(rows[0].display_name),
    } : undefined;
  }

  async putClaim(claim: BrainClaim): Promise<BrainWriteResult> {
    await ensureCompanyKnowledgeSchema();
    assertBrainClaimIntegrity(claim);
    const sql = connection();
    const holder = claim.memoryClass === "take" ? claim.primaryHolder! : undefined;
    const holderQuery = holder
      ? sql`insert into companyos_knowledge.holders (holder_id, holder_type, display_name, identity_evidence)
          values (${holder.holderId}, ${holder.holderType}, ${holder.displayName}, ${JSON.stringify({ source: "claim", claim_id: claim.claimId })})
          on conflict (holder_id) do update set holder_id = excluded.holder_id
          where companyos_knowledge.holders.holder_type = excluded.holder_type
            and companyos_knowledge.holders.display_name = excluded.display_name
          returning holder_id`
      : sql`select 1 as ok`;
    const results = await sql.transaction([
      holderQuery,
      sql`insert into companyos_knowledge.claims (
          claim_id, memory_class, claim_kind, claim_text, owner_principal_id, fact_scope, primary_holder_id,
          source_basis, status, observed_at, valid_from, valid_until, extraction_confidence, epistemic_weight,
          access_policy_id, created_by, model_provenance, unresolved_evidence_reason,
          consolidation_receipt_id, activation_receipt_id)
        select ${claim.claimId}, ${claim.memoryClass}, ${claim.claimKind}, ${claim.claimText}, ${claim.ownerPrincipalId ?? null},
          ${claim.scope ? JSON.stringify(claim.scope) : null}, ${holder?.holderId ?? null}, ${claim.derivation}, ${claim.status},
          ${claim.observedAt}, ${claim.validFrom ?? null}, ${claim.validUntil ?? null}, ${claim.extractionConfidence},
          ${claim.epistemicWeight}, ${claim.accessPolicyId}, ${claim.createdBy}, ${JSON.stringify(claim.modelProvenance ?? null)},
          ${claim.unresolvedEvidenceReason ?? null}, ${claim.consolidationReceiptId ?? null}, ${claim.activationReceiptId ?? null}
        where ${claim.memoryClass === "fact"} or exists (
          select 1 from companyos_knowledge.holders where holder_id = ${holder?.holderId ?? null}
            and holder_type = ${holder?.holderType ?? null} and display_name = ${holder?.displayName ?? null})
        on conflict (claim_id) do update set claim_id = excluded.claim_id
        where companyos_knowledge.claims.memory_class = excluded.memory_class
          and companyos_knowledge.claims.claim_kind = excluded.claim_kind
          and companyos_knowledge.claims.claim_text = excluded.claim_text
          and companyos_knowledge.claims.owner_principal_id is not distinct from excluded.owner_principal_id
          and companyos_knowledge.claims.fact_scope is not distinct from excluded.fact_scope
          and companyos_knowledge.claims.primary_holder_id is not distinct from excluded.primary_holder_id
          and companyos_knowledge.claims.source_basis = excluded.source_basis
          and companyos_knowledge.claims.status = excluded.status
          and companyos_knowledge.claims.observed_at = excluded.observed_at
          and companyos_knowledge.claims.valid_from is not distinct from excluded.valid_from
          and companyos_knowledge.claims.valid_until is not distinct from excluded.valid_until
          and companyos_knowledge.claims.extraction_confidence = excluded.extraction_confidence
          and companyos_knowledge.claims.epistemic_weight = excluded.epistemic_weight
          and companyos_knowledge.claims.access_policy_id = excluded.access_policy_id
          and companyos_knowledge.claims.created_by = excluded.created_by
          and companyos_knowledge.claims.model_provenance is not distinct from excluded.model_provenance
          and companyos_knowledge.claims.unresolved_evidence_reason is not distinct from excluded.unresolved_evidence_reason
          and companyos_knowledge.claims.consolidation_receipt_id is not distinct from excluded.consolidation_receipt_id
          and companyos_knowledge.claims.activation_receipt_id is not distinct from excluded.activation_receipt_id
        returning (xmax = 0) as inserted`,
      ...claim.evidence.map((entry) => sql`insert into companyos_knowledge.claim_evidence (
          claim_id, evidence_id, source_id, provider_object_id, provider_version, page_id, page_version_id,
          content_digest, observed_at, locator)
        select ${claim.claimId}, ${entry.evidenceId}, ${entry.sourceId}, ${entry.providerObjectId}, ${entry.providerVersion},
          ${entry.pageId ?? null}, ${entry.pageVersionId ?? null}, ${entry.contentDigest}, ${entry.observedAt}, ${JSON.stringify(entry.locator)}
        where exists (select 1 from companyos_knowledge.claims where claim_id = ${claim.claimId})
        on conflict (claim_id, evidence_id) do update set evidence_id = excluded.evidence_id
        where companyos_knowledge.claim_evidence.source_id = excluded.source_id
          and companyos_knowledge.claim_evidence.provider_object_id = excluded.provider_object_id
          and companyos_knowledge.claim_evidence.provider_version = excluded.provider_version
          and companyos_knowledge.claim_evidence.page_id is not distinct from excluded.page_id
          and companyos_knowledge.claim_evidence.page_version_id is not distinct from excluded.page_version_id
          and companyos_knowledge.claim_evidence.content_digest = excluded.content_digest
          and companyos_knowledge.claim_evidence.observed_at = excluded.observed_at
          and companyos_knowledge.claim_evidence.locator = excluded.locator
        returning evidence_id`),
    ], { isolationLevel: "Serializable" });
    if (results[0].length === 0) throw new Error(`Epistemic Holder '${holder?.holderId}' conflicts with an existing identity.`);
    if (results[1].length === 0 || results.slice(2).some((rows) => rows.length === 0)) {
      throw new Error(`Brain Claim '${claim.claimId}' conflicts with existing Claim or evidence content.`);
    }
    return results[1][0]?.inserted === true ? "inserted" : "unchanged";
  }

  async getClaim(claimId: string): Promise<BrainClaim | undefined> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const rows = await sql`select c.*, h.holder_type, h.display_name from companyos_knowledge.claims c
      left join companyos_knowledge.holders h on h.holder_id = c.primary_holder_id
      where c.claim_id = ${claimId} limit 1`;
    if (!rows[0]) return undefined;
    const row = rows[0];
    const evidenceRows = await sql`select * from companyos_knowledge.claim_evidence
      where claim_id = ${claimId} order by evidence_id`;
    const evidence = evidenceRows.map((entry) => mapEvidence(entry as Record<string, unknown>));
    const common = {
      claimId: String(row.claim_id),
      memoryClass: row.memory_class as BrainClaim["memoryClass"],
      claimKind: row.claim_kind as BrainClaim["claimKind"],
      claimText: String(row.claim_text),
      status: row.status as BrainClaim["status"],
      derivation: row.source_basis as BrainClaim["derivation"],
      evidence,
      unresolvedEvidenceReason: optionalString(row.unresolved_evidence_reason),
      observedAt: new Date(String(row.observed_at)).toISOString(),
      validFrom: row.valid_from ? new Date(String(row.valid_from)).toISOString() : undefined,
      validUntil: row.valid_until ? new Date(String(row.valid_until)).toISOString() : undefined,
      extractionConfidence: Number(row.extraction_confidence),
      epistemicWeight: Number(row.epistemic_weight),
      accessPolicyId: String(row.access_policy_id),
      createdBy: String(row.created_by),
      modelProvenance: row.model_provenance ? json<BrainClaim["modelProvenance"]>(row.model_provenance) : undefined,
    };
    return row.memory_class === "fact" ? {
      ...common,
      ownerPrincipalId: String(row.owner_principal_id),
      scope: json<NonNullable<BrainClaim["scope"]>>(row.fact_scope),
    } : {
      ...common,
      primaryHolder: {
        holderId: String(row.primary_holder_id),
        holderType: row.holder_type as EpistemicHolder["holderType"],
        displayName: String(row.display_name),
      },
      consolidationReceiptId: optionalString(row.consolidation_receipt_id),
      activationReceiptId: optionalString(row.activation_receipt_id),
    };
  }

  async putClaimRelation(relation: BrainClaimRelation): Promise<BrainWriteResult> {
    await ensureCompanyKnowledgeSchema();
    if (!relation.entityId.trim()) throw new Error("Brain Claim relation requires a non-empty Entity identity.");
    const rows = await connection()`insert into companyos_knowledge.claim_relations (
        claim_id, relation_type, entity_type, entity_id, evidence)
      select ${relation.claimId}, ${relation.relationType}, ${relation.entityType}, ${relation.entityId}, ${JSON.stringify(relation.evidence)}
      where exists (select 1 from companyos_knowledge.claims where claim_id = ${relation.claimId})
      on conflict (claim_id, relation_type, entity_type, entity_id) do update set claim_id = excluded.claim_id
      where companyos_knowledge.claim_relations.evidence = excluded.evidence
      returning (xmax = 0) as inserted`;
    if (rows.length === 0) throw new Error(`Brain Claim relation for '${relation.claimId}' conflicts or references an unknown Claim.`);
    return rows[0]?.inserted === true ? "inserted" : "unchanged";
  }

  async listClaimRelations(claimId: string): Promise<BrainClaimRelation[]> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select claim_id, relation_type, entity_type, entity_id, evidence
      from companyos_knowledge.claim_relations where claim_id = ${claimId}
      order by relation_type, entity_type, entity_id`;
    return rows.map((row) => ({
      claimId: String(row.claim_id),
      relationType: row.relation_type as BrainClaimRelation["relationType"],
      entityType: row.entity_type as "principal",
      entityId: String(row.entity_id),
      evidence: json<Record<string, unknown>>(row.evidence),
    }));
  }

  async putTimelineEvent(event: BrainTimelineEvent): Promise<BrainWriteResult> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`insert into companyos_knowledge.timeline_events (
        event_id, event_type, subject_type, subject_id, page_version_id, source_id, observed_at,
        provenance_class, evidence, access_policy_id, lifecycle_status)
      select ${event.eventId}, ${event.eventType}, ${event.subjectType}, ${event.subjectId}, ${event.pageVersionId},
        ${event.sourceId}, ${event.observedAt}, ${event.provenanceClass}, ${JSON.stringify(event.evidence)},
        ${event.accessPolicyId}, ${event.lifecycleStatus}
      where exists (select 1 from companyos_knowledge.page_versions
        where page_version_id = ${event.pageVersionId} and page_id = ${event.subjectId})
      on conflict (event_id) do update set event_id = excluded.event_id
      where companyos_knowledge.timeline_events.event_type = excluded.event_type
        and companyos_knowledge.timeline_events.subject_type = excluded.subject_type
        and companyos_knowledge.timeline_events.subject_id = excluded.subject_id
        and companyos_knowledge.timeline_events.page_version_id = excluded.page_version_id
        and companyos_knowledge.timeline_events.source_id is not distinct from excluded.source_id
        and companyos_knowledge.timeline_events.observed_at = excluded.observed_at
        and companyos_knowledge.timeline_events.provenance_class = excluded.provenance_class
        and companyos_knowledge.timeline_events.evidence = excluded.evidence
        and companyos_knowledge.timeline_events.access_policy_id = excluded.access_policy_id
        and companyos_knowledge.timeline_events.lifecycle_status = excluded.lifecycle_status
      returning (xmax = 0) as inserted`;
    if (rows.length === 0) throw new Error(`Timeline event '${event.eventId}' conflicts or references an unavailable Page version.`);
    return rows[0]?.inserted === true ? "inserted" : "unchanged";
  }

  async listTimelineEvents(subjectId: string): Promise<BrainTimelineEvent[]> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select event_id, event_type, subject_type, subject_id, page_version_id,
        source_id, observed_at, provenance_class, evidence, access_policy_id, lifecycle_status
      from companyos_knowledge.timeline_events where subject_id = ${subjectId}
      order by observed_at, event_id`;
    return rows.map((row) => ({
      eventId: String(row.event_id),
      eventType: String(row.event_type),
      subjectType: row.subject_type as "page",
      subjectId: String(row.subject_id),
      pageVersionId: String(row.page_version_id),
      sourceId: String(row.source_id),
      observedAt: new Date(String(row.observed_at)).toISOString(),
      provenanceClass: row.provenance_class as BrainTimelineEvent["provenanceClass"],
      evidence: json<Record<string, unknown>>(row.evidence),
      accessPolicyId: String(row.access_policy_id),
      lifecycleStatus: row.lifecycle_status as BrainTimelineEvent["lifecycleStatus"],
    }));
  }

  async putResolutionProposal(proposal: ClaimResolutionProposal): Promise<BrainWriteResult> {
    await ensureCompanyKnowledgeSchema();
    const claim = await this.getClaim(proposal.claimId);
    if (!claim) throw new Error(`Unknown Brain Claim '${proposal.claimId}'.`);
    assertClaimResolutionProposalIntegrity(proposal, claim);
    const rows = await connection()`insert into companyos_knowledge.claim_resolution_proposals (
        proposal_id, claim_id, outcome, outcome_evidence, judge_receipt_id, proposed_by, proposed_at, status)
      values (${proposal.proposalId}, ${proposal.claimId}, ${proposal.outcome}, ${JSON.stringify(proposal.outcomeEvidence)},
        ${proposal.judgeReceiptId}, ${proposal.proposedBy}, ${proposal.proposedAt}, 'proposed')
      on conflict (proposal_id) do update set proposal_id = excluded.proposal_id
      where companyos_knowledge.claim_resolution_proposals.claim_id = excluded.claim_id
        and companyos_knowledge.claim_resolution_proposals.outcome = excluded.outcome
        and companyos_knowledge.claim_resolution_proposals.outcome_evidence = excluded.outcome_evidence
        and companyos_knowledge.claim_resolution_proposals.judge_receipt_id = excluded.judge_receipt_id
        and companyos_knowledge.claim_resolution_proposals.proposed_by = excluded.proposed_by
        and companyos_knowledge.claim_resolution_proposals.proposed_at = excluded.proposed_at
        and companyos_knowledge.claim_resolution_proposals.status = 'proposed'
      returning (xmax = 0) as inserted`;
    if (rows.length === 0) throw new Error(`Claim resolution proposal '${proposal.proposalId}' conflicts with existing content.`);
    return rows[0].inserted === true ? "inserted" : "unchanged";
  }

  async getResolutionProposal(proposalId: string): Promise<ClaimResolutionProposal | undefined> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select * from companyos_knowledge.claim_resolution_proposals
      where proposal_id = ${proposalId} limit 1`;
    if (!rows[0]) return undefined;
    return {
      proposalId: String(rows[0].proposal_id),
      claimId: String(rows[0].claim_id),
      outcome: rows[0].outcome as ClaimResolutionProposal["outcome"],
      outcomeEvidence: json<ClaimResolutionProposal["outcomeEvidence"]>(rows[0].outcome_evidence),
      judgeReceiptId: String(rows[0].judge_receipt_id),
      proposedBy: String(rows[0].proposed_by),
      proposedAt: new Date(String(rows[0].proposed_at)).toISOString(),
      status: "proposed",
      autoApplicable: false,
    };
  }

  async #listPageTypes(): Promise<BrainPageTypeDefinition[]> {
    const sql = connection();
    const rows = await sql`select * from companyos_knowledge.page_type_registry order by type_key`;
    const aliases = await sql`select alias, type_key from companyos_knowledge.page_type_aliases order by alias`;
    return rows.map((row) => mapPageType(
      row as Record<string, unknown>,
      aliases.filter((entry) => entry.type_key === row.type_key).map((entry) => String(entry.alias)),
    ));
  }

  async #entityMembershipContext(membership: EntityIdentityMembership): Promise<{ entity: EntityIdentity; page: BrainPage }> {
    const entity = await this.getEntityIdentity(membership.entityId);
    if (!entity) throw new Error(`Unknown Entity identity '${membership.entityId}'.`);
    const pageRecord = await this.getPage(membership.pageId);
    if (!pageRecord) throw new Error(`Unknown Entity membership Page '${membership.pageId}'.`);
    return { entity, page: pageRecord.page };
  }

  async #insertEntityMembership(membership: EntityIdentityMembership, allowReviewed: boolean): Promise<BrainWriteResult> {
    if (membership.proofBasis === "review-decision" && !allowReviewed) {
      throw new Error("Review-proven Entity memberships require an Entity proposal decision.");
    }
    const rows = await connection()`insert into companyos_knowledge.entity_identity_members (
        membership_id, entity_id, page_id, proof_basis, proof_receipt_id, page_access_policy_id, status, created_at)
      values (${membership.membershipId}, ${membership.entityId}, ${membership.pageId}, ${membership.proofBasis},
        ${membership.proofReceiptId}, ${membership.pageAccessPolicyId}, ${membership.status}, ${membership.createdAt})
      on conflict (membership_id) do update set membership_id = excluded.membership_id
      where companyos_knowledge.entity_identity_members.entity_id = excluded.entity_id
        and companyos_knowledge.entity_identity_members.page_id = excluded.page_id
        and companyos_knowledge.entity_identity_members.proof_basis = excluded.proof_basis
        and companyos_knowledge.entity_identity_members.proof_receipt_id = excluded.proof_receipt_id
        and companyos_knowledge.entity_identity_members.page_access_policy_id = excluded.page_access_policy_id
        and companyos_knowledge.entity_identity_members.status = excluded.status
        and companyos_knowledge.entity_identity_members.created_at = excluded.created_at
      returning (xmax = 0) as inserted`;
    if (rows.length === 0) throw new Error(`Entity membership '${membership.membershipId}' conflicts with existing content.`);
    return rows[0].inserted === true ? "inserted" : "unchanged";
  }
}
