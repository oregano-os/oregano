import type {
  BrainClaim,
  BrainPage,
  BrainPageTypeDefinition,
  BrainPageVersion,
  ClaimResolutionProposal,
  EntityIdentity,
  EntityIdentityDecision,
  EntityIdentityMembership,
  EntityIdentityProposal,
  EpistemicHolder,
} from "./brain-contracts.ts";

export type BrainWriteResult = "inserted" | "unchanged";

export interface BrainPageRecord {
  page: BrainPage;
  version: BrainPageVersion;
}

export interface BrainClaimRelation {
  claimId: string;
  relationType: "speaker" | "author" | "subject" | "approver" | "owner" | "beneficiary" | "affected-party";
  entityType: "principal";
  entityId: string;
  evidence: Record<string, unknown>;
}

export interface BrainTimelineEvent {
  eventId: string;
  eventType: string;
  subjectType: "page";
  subjectId: string;
  pageVersionId: string;
  sourceId: string;
  observedAt: string;
  provenanceClass: "source" | "deterministic-rule" | "inferred" | "human-decision";
  evidence: Record<string, unknown>;
  accessPolicyId: string;
  lifecycleStatus: "active" | "superseded" | "deleted";
}

export interface BrainStore {
  registerPageType(definition: BrainPageTypeDefinition): Promise<BrainWriteResult>;
  getPageType(keyOrAlias: string): Promise<BrainPageTypeDefinition | undefined>;
  putPageVersion(record: BrainPageRecord): Promise<BrainWriteResult>;
  getPage(pageId: string, pageVersionId?: string): Promise<BrainPageRecord | undefined>;
  listPageVersions(pageId: string): Promise<BrainPageVersion[]>;
  putEntityIdentity(entity: EntityIdentity): Promise<BrainWriteResult>;
  getEntityIdentity(entityId: string): Promise<EntityIdentity | undefined>;
  putEntityMembership(membership: EntityIdentityMembership): Promise<BrainWriteResult>;
  getEntityMembershipForPage(pageId: string): Promise<EntityIdentityMembership | undefined>;
  listEntityMemberships(entityId: string): Promise<EntityIdentityMembership[]>;
  putEntityIdentityProposal(proposal: EntityIdentityProposal): Promise<BrainWriteResult>;
  getEntityIdentityProposal(proposalId: string): Promise<EntityIdentityProposal | undefined>;
  decideEntityIdentityProposal(decision: EntityIdentityDecision): Promise<BrainWriteResult>;
  getEntityIdentityDecision(proposalId: string): Promise<EntityIdentityDecision | undefined>;
  getHolder(holderId: string): Promise<EpistemicHolder | undefined>;
  putClaim(claim: BrainClaim): Promise<BrainWriteResult>;
  getClaim(claimId: string): Promise<BrainClaim | undefined>;
  putClaimRelation(relation: BrainClaimRelation): Promise<BrainWriteResult>;
  listClaimRelations(claimId: string): Promise<BrainClaimRelation[]>;
  putTimelineEvent(event: BrainTimelineEvent): Promise<BrainWriteResult>;
  listTimelineEvents(subjectId: string): Promise<BrainTimelineEvent[]>;
  putResolutionProposal(proposal: ClaimResolutionProposal): Promise<BrainWriteResult>;
  getResolutionProposal(proposalId: string): Promise<ClaimResolutionProposal | undefined>;
}
