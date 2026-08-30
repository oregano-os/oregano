export const OKF_VERSION = "0.1" as const;
export const KNOWLEDGE_BUNDLE_SCHEMA_VERSION = 3 as const;
export const KNOWLEDGE_PROVIDER_CONTRACT_VERSION = "3.0.0" as const;
export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 256 as const;

export type OkfType = "concept" | "playbook" | "note";
export type KnowledgeVisibility = "public" | "company" | "team" | "restricted_group" | "individual" | "private";
export type KnowledgePermission = "read" | "review" | "write" | "promote" | "admin";

export interface KnowledgeAccessEntry {
  subjectKind: "principal" | "group";
  subjectId: string;
  permission: KnowledgePermission;
  effect: "allow" | "deny";
}

export interface KnowledgeAccessPolicy {
  policyId: string;
  policyVersion: number;
  visibility: KnowledgeVisibility;
  parentPolicyId?: string;
  sourceRoot: boolean;
  status: "active" | "quarantined" | "revoked";
  entries: KnowledgeAccessEntry[];
}

export interface KnowledgeAccessSubject {
  principalId: string;
  principalType: "human" | "agent" | "service";
  status: "active" | "inactive" | "unresolved" | "revoked";
  groupIds: string[];
}

export interface KnowledgeAccessDecision {
  decisionId: string;
  decidedAt: string;
  principalId: string;
  principalType: KnowledgeAccessSubject["principalType"];
  groupIds: string[];
  permission: KnowledgePermission;
  policyIds: string[];
  objectType: "document" | "graph" | "review-candidate" | "model-context" | "policy";
  objectIdHash: string;
  outcome: "permit" | "deny";
  reason: string;
}

export interface KnowledgeAccessAuditor {
  record(decision: KnowledgeAccessDecision): Promise<void> | void;
}

export interface KnowledgeDiagnostic {
  code: string;
  severity: "error" | "warning";
  message: string;
  path?: string;
}

export interface KnowledgeFragment {
  fragmentId: string;
  path: string;
  heading: string;
  startLine: number;
  endLine: number;
  body: string;
  digest: string;
  accessPolicyId: string;
}

export interface KnowledgeDocument {
  path: string;
  type: OkfType;
  description: string;
  status: "current" | "stale" | "contested";
  validUntil?: string;
  title: string;
  body: string;
  digest: string;
  accessPolicyId: string;
  links: string[];
  fragments: KnowledgeFragment[];
}

export interface KnowledgeGraphEdge {
  from: string;
  to: string;
}

export interface KnowledgeBundle {
  schemaVersion: typeof KNOWLEDGE_BUNDLE_SCHEMA_VERSION;
  okfVersion: typeof OKF_VERSION;
  workspaceCommit: string;
  policyHash: string;
  accessPolicies: KnowledgeAccessPolicy[];
  documents: KnowledgeDocument[];
  edges: KnowledgeGraphEdge[];
  orphanPaths: string[];
  graphHash: string;
  documentCount: number;
  fragmentCount: number;
  bundleHash: string;
}

export interface KnowledgeCitation {
  snapshotHash: string;
  path: string;
  fragmentId: string;
  heading: string;
  startLine: number;
  endLine: number;
  digest: string;
}

export interface KnowledgeSearchHit {
  score: number;
  lexicalRank?: number;
  semanticRank?: number;
  excerpt: string;
  signals: Array<"stale" | "contested">;
  citation: KnowledgeCitation;
}

export interface KnowledgeSearchResult {
  query: string;
  snapshotHash: string | null;
  hits: KnowledgeSearchHit[];
  gaps: Array<"no-active-snapshot" | "no-results">;
  mode: "lexical" | "hybrid";
  degradations: Array<"embedding-disabled" | "embedding-unavailable" | "vector-index-unavailable" | "handbook-unavailable" | "retrieval-v3-canary-fallback">;
}

export interface KnowledgeTraversalResult {
  snapshotHash: string | null;
  startPath: string;
  direction: "outbound" | "inbound" | "both";
  paths: Array<{ path: string; depth: number; via?: string }>;
  truncated: boolean;
  gaps: Array<"no-active-snapshot" | "unknown-start-path">;
}

export interface EmbeddingAdapter {
  readonly id: string;
  readonly version: string;
  readonly dimensions: typeof KNOWLEDGE_EMBEDDING_DIMENSIONS;
  readonly dataEgress: "none" | "external";
  embed(texts: readonly string[]): Promise<number[][]>;
}

export interface EmbeddingPolicy {
  mode: "disabled" | "local" | "external";
  allowExternalDataEgress: boolean;
  adapterId?: string;
}

export interface KnowledgeProviderHealth {
  ok: boolean;
  activeSnapshotHash: string | null;
  lexical: true;
  vectorIndex: boolean;
  embeddingAdapter: string | null;
  degradation?: string;
}

export interface KnowledgeGetResult {
  snapshotHash: string;
  document: KnowledgeDocument;
}

export type KnowledgeSnapshotStatus = "staged" | "verified" | "active" | "retired";

export interface KnowledgeSnapshot {
  snapshotHash: string;
  status: KnowledgeSnapshotStatus;
  bundle: KnowledgeBundle;
  stagedAt: string;
  verifiedAt?: string;
  activatedAt?: string;
}

export interface KnowledgeProvider {
  stage(bundle: KnowledgeBundle): Promise<KnowledgeSnapshot>;
  verify(snapshotHash: string): Promise<KnowledgeSnapshot>;
  activate(snapshotHash: string): Promise<KnowledgeSnapshot>;
  activeSnapshot(): Promise<KnowledgeSnapshot | undefined>;
  search(input: { query: string; limit?: number; mode?: "lexical" | "hybrid"; subject?: KnowledgeAccessSubject }): Promise<KnowledgeSearchResult>;
  get(input: { path: string; subject?: KnowledgeAccessSubject }): Promise<KnowledgeGetResult | undefined>;
  traverse(input: { path: string; direction?: "outbound" | "inbound" | "both"; maxDepth?: number; maxNodes?: number; subject?: KnowledgeAccessSubject }): Promise<KnowledgeTraversalResult>;
  health(): Promise<KnowledgeProviderHealth>;
}

export type ReviewRoute = "okf" | "playbook" | "learning";
export type ReviewStatus = "pending" | "accepted" | "rejected" | "superseded" | "quarantined";

export interface ReviewCandidate {
  candidateId: string;
  sourcePath: string;
  sourceDigest: string;
  title: string;
  route: ReviewRoute;
  status: ReviewStatus;
  reason: string;
  source: string;
  capturedAt: string;
  actor: string;
  personalData: boolean;
  accessPolicyId: string;
  duplicateOf?: string;
  sourceObject?: { sourceId: string; providerObjectId: string; providerVersion: string };
  runtimeObservationId?: string;
}

export interface ReviewDecision {
  candidateId: string;
  decision: "accepted" | "rejected" | "superseded";
  decidedBy: string;
  decidedAt: string;
  note?: string;
}

export interface KnowledgePromotionProposal {
  proposalId: string;
  candidateId: string;
  sourcePath: string;
  sourceDigest: string;
  route: ReviewRoute;
  operations: Array<
    | { operation: "create"; path: string; content: string }
    | { operation: "append-index"; path: "handbook/index.md"; content: string }
    | { operation: "archive"; from: string; to: string; content: string }
  >;
  warning: string;
}
