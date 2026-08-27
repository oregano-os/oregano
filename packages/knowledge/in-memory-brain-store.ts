import { canonicalJson } from "../runtime/canonical.ts";
import {
  CORE_BRAIN_PAGE_TAXONOMY,
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
  type ClaimResolutionProposal,
  type EntityIdentity,
  type EntityIdentityDecision,
  type EntityIdentityMembership,
  type EntityIdentityProposal,
  type EpistemicHolder,
} from "./brain-contracts.ts";
import type {
  BrainClaimRelation,
  BrainPageRecord,
  BrainStore,
  BrainTimelineEvent,
  BrainWriteResult,
} from "./brain-store.ts";

const clone = <T>(value: T): T => structuredClone(value);
const equal = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

const immutablePageIdentity = (page: BrainPage) => ({
  pageId: page.pageId,
  pageTypeKey: page.pageTypeKey,
  sourceId: page.sourceId,
  sourcePageKey: page.sourcePageKey,
  verificationStatus: page.verificationStatus,
  accessPolicyId: page.accessPolicyId,
  lifecycleStatus: page.lifecycleStatus,
  createdAt: page.createdAt,
});

export class InMemoryBrainStore implements BrainStore {
  readonly pageTypes = new Map<string, BrainPageTypeDefinition>();
  readonly pageTypeAliases = new Map<string, string>();
  readonly pages = new Map<string, BrainPage>();
  readonly pageVersions = new Map<string, BrainPageVersion>();
  readonly entities = new Map<string, EntityIdentity>();
  readonly entityMemberships = new Map<string, EntityIdentityMembership>();
  readonly entityMembershipsByPage = new Map<string, string>();
  readonly entityProposals = new Map<string, EntityIdentityProposal>();
  readonly entityDecisionsByProposal = new Map<string, EntityIdentityDecision>();
  readonly holders = new Map<string, EpistemicHolder>();
  readonly claims = new Map<string, BrainClaim>();
  readonly claimRelations = new Map<string, BrainClaimRelation>();
  readonly timelineEvents = new Map<string, BrainTimelineEvent>();
  readonly resolutionProposals = new Map<string, ClaimResolutionProposal>();

  constructor() {
    for (const definition of CORE_BRAIN_PAGE_TAXONOMY) this.#insertPageType(definition);
  }

  async registerPageType(definition: BrainPageTypeDefinition): Promise<BrainWriteResult> {
    const existing = this.pageTypes.get(definition.key);
    if (existing) {
      if (!equal(existing, definition)) throw new Error(`Brain Page type '${definition.key}' already exists with different content.`);
      return "unchanged";
    }
    assertBrainPageTypeRegistry([...this.pageTypes.values(), definition]);
    this.#insertPageType(definition);
    return "inserted";
  }

  async getPageType(keyOrAlias: string): Promise<BrainPageTypeDefinition | undefined> {
    const normalized = keyOrAlias.trim().toLocaleLowerCase("en");
    const key = this.pageTypes.has(normalized) ? normalized : this.pageTypeAliases.get(normalized);
    const definition = key ? this.pageTypes.get(key) : undefined;
    return definition ? clone(definition) : undefined;
  }

  async putPageVersion(record: BrainPageRecord): Promise<BrainWriteResult> {
    assertBrainPageVersionIntegrity(record.page, record.version);
    const pageType = this.pageTypes.get(record.page.pageTypeKey);
    if (!pageType || pageType.status !== "active") throw new Error(`Unknown or inactive Brain Page type '${record.page.pageTypeKey}'.`);
    const existingPage = this.pages.get(record.page.pageId);
    if (existingPage && !equal(immutablePageIdentity(existingPage), immutablePageIdentity(record.page))) {
      throw new Error(`Brain Page '${record.page.pageId}' already exists with a different immutable identity.`);
    }
    const existingVersion = this.pageVersions.get(record.version.pageVersionId);
    if (existingVersion) {
      if (!equal(existingVersion, record.version)) throw new Error(`Brain Page version '${record.version.pageVersionId}' already exists with different content.`);
      return "unchanged";
    }
    const versions = [...this.pageVersions.values()].filter((entry) => entry.pageId === record.page.pageId);
    if (versions.some((entry) => entry.version === record.version.version)) {
      throw new Error(`Brain Page '${record.page.pageId}' already has version ${record.version.version}.`);
    }
    const expectedVersion = versions.length === 0 ? 1 : Math.max(...versions.map((entry) => entry.version)) + 1;
    if (record.version.version !== expectedVersion) {
      throw new Error(`Brain Page '${record.page.pageId}' expected version ${expectedVersion}, received ${record.version.version}.`);
    }
    this.pageVersions.set(record.version.pageVersionId, clone(record.version));
    this.pages.set(record.page.pageId, clone(record.page));
    return "inserted";
  }

  async getPage(pageId: string, pageVersionId?: string): Promise<BrainPageRecord | undefined> {
    const page = this.pages.get(pageId);
    if (!page) return undefined;
    const version = this.pageVersions.get(pageVersionId ?? page.currentVersionId);
    if (!version || version.pageId !== pageId) return undefined;
    return { page: clone(page), version: clone(version) };
  }

  async listPageVersions(pageId: string): Promise<BrainPageVersion[]> {
    return [...this.pageVersions.values()]
      .filter((entry) => entry.pageId === pageId)
      .sort((left, right) => left.version - right.version || left.pageVersionId.localeCompare(right.pageVersionId))
      .map(clone);
  }

  async putEntityIdentity(entity: EntityIdentity): Promise<BrainWriteResult> {
    assertEntityIdentityIntegrity(entity);
    const stableKeyConflict = [...this.entities.values()].find((entry) => entry.entityKind === entity.entityKind && entry.stableKey === entity.stableKey);
    if (stableKeyConflict && stableKeyConflict.entityId !== entity.entityId) {
      throw new Error(`Entity stable key '${entity.stableKey}' already belongs to a different identity.`);
    }
    const existing = this.entities.get(entity.entityId);
    if (existing) {
      if (!equal(existing, entity)) throw new Error(`Entity identity '${entity.entityId}' already exists with different content.`);
      return "unchanged";
    }
    this.entities.set(entity.entityId, clone(entity));
    return "inserted";
  }

  async getEntityIdentity(entityId: string): Promise<EntityIdentity | undefined> {
    const entity = this.entities.get(entityId);
    return entity ? clone(entity) : undefined;
  }

  async putEntityMembership(membership: EntityIdentityMembership): Promise<BrainWriteResult> {
    if (membership.proofBasis === "review-decision") {
      throw new Error("Review-proven Entity memberships must be applied through an attributable Entity proposal decision.");
    }
    return this.#putEntityMembership(membership, false);
  }

  async getEntityMembershipForPage(pageId: string): Promise<EntityIdentityMembership | undefined> {
    const membershipId = this.entityMembershipsByPage.get(pageId);
    const membership = membershipId ? this.entityMemberships.get(membershipId) : undefined;
    return membership ? clone(membership) : undefined;
  }

  async listEntityMemberships(entityId: string): Promise<EntityIdentityMembership[]> {
    return [...this.entityMemberships.values()]
      .filter((entry) => entry.entityId === entityId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.membershipId.localeCompare(right.membershipId))
      .map((entry) => clone(entry));
  }

  async putEntityIdentityProposal(proposal: EntityIdentityProposal): Promise<BrainWriteResult> {
    const page = this.pages.get(proposal.candidatePageId);
    if (!page) throw new Error(`Unknown Entity proposal candidate Page '${proposal.candidatePageId}'.`);
    const entity = this.entities.get(proposal.targetEntityId);
    if (!entity) throw new Error(`Unknown Entity proposal target '${proposal.targetEntityId}'.`);
    assertEntityIdentityProposalIntegrity(proposal, page, entity);
    const existing = this.entityProposals.get(proposal.proposalId);
    if (existing) {
      if (!equal(existing, proposal)) throw new Error(`Entity identity proposal '${proposal.proposalId}' already exists with different content.`);
      return "unchanged";
    }
    const activeMembershipId = this.entityMembershipsByPage.get(page.pageId);
    if (activeMembershipId) throw new Error(`Page '${page.pageId}' already has an Entity membership.`);
    this.entityProposals.set(proposal.proposalId, clone(proposal));
    return "inserted";
  }

  async getEntityIdentityProposal(proposalId: string): Promise<EntityIdentityProposal | undefined> {
    const proposal = this.entityProposals.get(proposalId);
    return proposal ? clone(proposal) : undefined;
  }

  async decideEntityIdentityProposal(decision: EntityIdentityDecision): Promise<BrainWriteResult> {
    const proposal = this.entityProposals.get(decision.proposalId);
    if (!proposal) throw new Error(`Unknown Entity identity proposal '${decision.proposalId}'.`);
    const page = this.pages.get(proposal.candidatePageId)!;
    const entity = this.entities.get(proposal.targetEntityId)!;
    assertEntityIdentityDecisionIntegrity({ decision, proposal, candidatePage: page, targetEntity: entity });
    const existing = this.entityDecisionsByProposal.get(proposal.proposalId);
    if (existing) {
      if (!equal(existing, decision)) throw new Error(`Entity identity proposal '${proposal.proposalId}' already has a different decision.`);
      return "unchanged";
    }
    if (decision.decision === "accepted") this.#putEntityMembership(decision.membership!, true);
    this.entityDecisionsByProposal.set(proposal.proposalId, clone(decision));
    return "inserted";
  }

  async getEntityIdentityDecision(proposalId: string): Promise<EntityIdentityDecision | undefined> {
    const decision = this.entityDecisionsByProposal.get(proposalId);
    return decision ? clone(decision) : undefined;
  }

  async getHolder(holderId: string): Promise<EpistemicHolder | undefined> {
    const holder = this.holders.get(holderId);
    return holder ? clone(holder) : undefined;
  }

  async putClaim(claim: BrainClaim): Promise<BrainWriteResult> {
    assertBrainClaimIntegrity(claim);
    const existing = this.claims.get(claim.claimId);
    if (existing) {
      if (!equal(existing, claim)) throw new Error(`Brain Claim '${claim.claimId}' already exists with different content.`);
      return "unchanged";
    }
    if (claim.memoryClass === "take") {
      const holder = claim.primaryHolder!;
      const existingHolder = this.holders.get(holder.holderId);
      if (existingHolder && !equal(existingHolder, holder)) throw new Error(`Epistemic Holder '${holder.holderId}' already exists with different content.`);
      this.holders.set(holder.holderId, clone(holder));
    }
    this.claims.set(claim.claimId, clone(claim));
    return "inserted";
  }

  async getClaim(claimId: string): Promise<BrainClaim | undefined> {
    const claim = this.claims.get(claimId);
    return claim ? clone(claim) : undefined;
  }

  async putClaimRelation(relation: BrainClaimRelation): Promise<BrainWriteResult> {
    if (!this.claims.has(relation.claimId)) throw new Error(`Unknown Brain Claim '${relation.claimId}'.`);
    if (!relation.entityId.trim()) throw new Error("Brain Claim relation requires a non-empty Entity identity.");
    const key = `${relation.claimId}\0${relation.relationType}\0${relation.entityType}\0${relation.entityId}`;
    const existing = this.claimRelations.get(key);
    if (existing) {
      if (!equal(existing, relation)) throw new Error(`Brain Claim relation '${key}' already exists with different evidence.`);
      return "unchanged";
    }
    this.claimRelations.set(key, clone(relation));
    return "inserted";
  }

  async listClaimRelations(claimId: string): Promise<BrainClaimRelation[]> {
    return [...this.claimRelations.values()]
      .filter((entry) => entry.claimId === claimId)
      .sort((left, right) => left.relationType.localeCompare(right.relationType) || left.entityId.localeCompare(right.entityId))
      .map(clone);
  }

  async putTimelineEvent(event: BrainTimelineEvent): Promise<BrainWriteResult> {
    if (!this.pages.has(event.subjectId)) throw new Error(`Unknown Timeline Page '${event.subjectId}'.`);
    const version = this.pageVersions.get(event.pageVersionId);
    if (!version || version.pageId !== event.subjectId) throw new Error(`Timeline event '${event.eventId}' references an unavailable Page version.`);
    const existing = this.timelineEvents.get(event.eventId);
    if (existing) {
      if (!equal(existing, event)) throw new Error(`Timeline event '${event.eventId}' already exists with different content.`);
      return "unchanged";
    }
    this.timelineEvents.set(event.eventId, clone(event));
    return "inserted";
  }

  async listTimelineEvents(subjectId: string): Promise<BrainTimelineEvent[]> {
    return [...this.timelineEvents.values()]
      .filter((entry) => entry.subjectId === subjectId)
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.eventId.localeCompare(right.eventId))
      .map(clone);
  }

  async putResolutionProposal(proposal: ClaimResolutionProposal): Promise<BrainWriteResult> {
    const claim = this.claims.get(proposal.claimId);
    if (!claim) throw new Error(`Unknown Brain Claim '${proposal.claimId}'.`);
    assertClaimResolutionProposalIntegrity(proposal, claim);
    const existing = this.resolutionProposals.get(proposal.proposalId);
    if (existing) {
      if (!equal(existing, proposal)) throw new Error(`Claim resolution proposal '${proposal.proposalId}' already exists with different content.`);
      return "unchanged";
    }
    this.resolutionProposals.set(proposal.proposalId, clone(proposal));
    return "inserted";
  }

  async getResolutionProposal(proposalId: string): Promise<ClaimResolutionProposal | undefined> {
    const proposal = this.resolutionProposals.get(proposalId);
    return proposal ? clone(proposal) : undefined;
  }

  #insertPageType(definition: BrainPageTypeDefinition): void {
    this.pageTypes.set(definition.key, clone(definition));
    for (const alias of definition.aliases) this.pageTypeAliases.set(alias, definition.key);
  }

  #putEntityMembership(membership: EntityIdentityMembership, allowReviewed: boolean): BrainWriteResult {
    if (membership.proofBasis === "review-decision" && !allowReviewed) {
      throw new Error("Review-proven Entity memberships require an Entity proposal decision.");
    }
    const entity = this.entities.get(membership.entityId);
    if (!entity) throw new Error(`Unknown Entity identity '${membership.entityId}'.`);
    const page = this.pages.get(membership.pageId);
    if (!page) throw new Error(`Unknown Entity membership Page '${membership.pageId}'.`);
    assertEntityIdentityMembershipIntegrity(membership, entity, page);
    const pageMembershipId = this.entityMembershipsByPage.get(membership.pageId);
    if (pageMembershipId) {
      const pageMembership = this.entityMemberships.get(pageMembershipId)!;
      if (!equal(pageMembership, membership)) throw new Error(`Page '${membership.pageId}' already belongs to a different Entity identity.`);
      return "unchanged";
    }
    const existing = this.entityMemberships.get(membership.membershipId);
    if (existing && !equal(existing, membership)) throw new Error(`Entity membership '${membership.membershipId}' already exists with different content.`);
    this.entityMemberships.set(membership.membershipId, clone(membership));
    this.entityMembershipsByPage.set(membership.pageId, membership.membershipId);
    return existing ? "unchanged" : "inserted";
  }
}
