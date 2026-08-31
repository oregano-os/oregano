import { sha256 } from "../runtime/canonical.ts";
import { KnowledgeAuthorizer } from "./access-control.ts";
import type { EmbeddingAdapter, EmbeddingPolicy, KnowledgeAccessAuditor, KnowledgeAccessPolicy, KnowledgeAccessSubject } from "./contracts.ts";
import { authorizeEmbeddingAdapter } from "./embedding.ts";
import { normalizeSearchText } from "./search.ts";
import type { KnowledgeAuthorityLayer, KnowledgeRetrievalUnitState, KnowledgeRetrievalUnitV3 } from "./retrieval-unit.ts";

export const KNOWLEDGE_RETRIEVAL_V3_CONTRACT_VERSION = "3.0.0-alpha.2" as const;

export interface KnowledgeRetrievalProjectionMetadataV3 {
  projectionHash: string;
  sourceSnapshotIds: string[];
  unitCount: number;
  status: "staged" | "verified" | "active" | "retired";
  embeddingProfile?: { adapterId: string; adapterVersion: string; dimensions: number; embeddedUnitCount: number };
  createdAt: string;
  verifiedAt?: string;
  activatedAt?: string;
}

export interface KnowledgeRetrievalCandidateV3 {
  unit: KnowledgeRetrievalUnitV3;
  exactRank?: number;
  lexicalRank?: number;
  semanticRank?: number;
}

export interface KnowledgeRetrievalCandidateStoreV3 {
  activeProjection(): Promise<KnowledgeRetrievalProjectionMetadataV3 | undefined>;
  policies(): Promise<KnowledgeAccessPolicy[]>;
  lexicalCandidates(input: { projectionHash: string; query: string; authorizedPolicyIds: string[]; limit: number }): Promise<KnowledgeRetrievalCandidateV3[]>;
  semanticCandidates?(input: { projectionHash: string; vector: number[]; adapterId: string; adapterVersion: string; dimensions: number; authorizedPolicyIds: string[]; limit: number }): Promise<KnowledgeRetrievalCandidateV3[]>;
  getUnitsByIds(input: { projectionHash: string; unitIds: string[]; authorizedPolicyIds: string[] }): Promise<KnowledgeRetrievalUnitV3[]>;
}

export interface KnowledgeRetrievalHitV3 {
  unitId: string;
  parentId: string;
  kind: KnowledgeRetrievalUnitV3["kind"];
  authorityLayer: KnowledgeAuthorityLayer;
  state: KnowledgeRetrievalUnitState;
  title: string;
  excerpt: string;
  contentDigest: string;
  accessPolicyId: string;
  sourceIds: string[];
  evidenceLocator?: KnowledgeRetrievalUnitV3["evidenceLocator"];
  score: number;
  ranks: { exact?: number; lexical?: number; semantic?: number; graph?: number };
  explanation: string[];
}

export interface KnowledgeRetrievalResultV3 {
  contractVersion: typeof KNOWLEDGE_RETRIEVAL_V3_CONTRACT_VERSION;
  projectionHash: string | null;
  authorizationPolicySetDigest: string;
  mode: "lexical" | "hybrid";
  hits: KnowledgeRetrievalHitV3[];
  gaps: string[];
  degradations: string[];
}

export interface KnowledgeContextReceiptV3 {
  receiptId: string;
  contractVersion: typeof KNOWLEDGE_RETRIEVAL_V3_CONTRACT_VERSION;
  projectionHash: string;
  queryDigest: string;
  authorizationContextDigest: string;
  authorizedPolicySetDigest: string;
  unitIds: string[];
  contentDigests: string[];
  degradations: string[];
  budget: { maximumUnits: number; maximumCharacters: number };
  createdAt: string;
}

export interface KnowledgeContextPackV3 {
  hits: KnowledgeRetrievalHitV3[];
  receipt: KnowledgeContextReceiptV3;
}

export interface KnowledgeAnswerEnvelopeV3 {
  contractVersion: typeof KNOWLEDGE_RETRIEVAL_V3_CONTRACT_VERSION;
  status: "answered" | "extractive-fallback" | "unavailable";
  answer: string;
  claims: Array<{ text: string; citationUnitIds: string[] }>;
  citations: Array<{ unitId: string; contentDigest: string }>;
  authorityLayers: KnowledgeAuthorityLayer[];
  conflicts: string[];
  gaps: string[];
  uncertainty: string[];
  degradations: string[];
  freshness: "current" | "mixed" | "stale" | "unknown";
  contextReceiptId: string;
  modelReceiptId?: string;
}

const rrf = (rank: number): number => 1 / (60 + rank);
const fixed = (value: number): number => Number(value.toFixed(8));
const stateWeight: Record<KnowledgeRetrievalUnitState, number> = { active: 1, proposed: 0.5, contested: 0.8, resolved: 0.75, superseded: 0.35, expired: 0.25 };

const excerpt = (text: string, tokens: string[], maximum = 500): string => {
  const normalized = text.replace(/\s+/g, " ").trim();
  const lower = normalized.toLocaleLowerCase("en");
  const positions = tokens.map((token) => lower.indexOf(token)).filter((position) => position >= 0);
  const start = positions.length > 0 ? Math.max(0, Math.min(...positions) - 100) : 0;
  return normalized.slice(start, start + maximum);
};

export class KnowledgeRetrievalServiceV3 {
  readonly #store: KnowledgeRetrievalCandidateStoreV3;
  readonly #auditor?: KnowledgeAccessAuditor;
  readonly #resolveSubject?: (subject?: KnowledgeAccessSubject) => Promise<KnowledgeAccessSubject | undefined>;
  readonly #embedding?: EmbeddingAdapter;

  constructor(input: {
    store: KnowledgeRetrievalCandidateStoreV3;
    auditor?: KnowledgeAccessAuditor;
    resolveSubject?: (subject?: KnowledgeAccessSubject) => Promise<KnowledgeAccessSubject | undefined>;
    embeddingAdapter?: EmbeddingAdapter;
    embeddingPolicy?: EmbeddingPolicy;
  }) {
    this.#store = input.store;
    this.#auditor = input.auditor;
    this.#resolveSubject = input.resolveSubject;
    this.#embedding = authorizeEmbeddingAdapter(input.embeddingAdapter, input.embeddingPolicy ?? { mode: "disabled", allowExternalDataEgress: false });
  }

  async #authorization(subject?: KnowledgeAccessSubject): Promise<{ subject?: KnowledgeAccessSubject; policyIds: string[]; digest: string }> {
    const resolved = this.#resolveSubject ? await this.#resolveSubject(subject) : subject;
    const policies = await this.#store.policies();
    const authorizer = new KnowledgeAuthorizer(policies, this.#auditor);
    const policyIds: string[] = [];
    for (const policy of [...policies].sort((left, right) => left.policyId.localeCompare(right.policyId))) {
      if (await authorizer.authorize({ subject: resolved, permission: "read", policyIds: [policy.policyId], objectType: "policy", objectId: policy.policyId })) policyIds.push(policy.policyId);
    }
    return { subject: resolved, policyIds, digest: sha256({ principalId: resolved?.principalId ?? "unresolved", groupIds: [...(resolved?.groupIds ?? [])].sort(), policyIds }) };
  }

  async search(input: { query: string; subject?: KnowledgeAccessSubject; limit?: number; mode?: "lexical" | "hybrid"; graphLimit?: number }): Promise<KnowledgeRetrievalResultV3> {
    const query = input.query.trim();
    if (!query || query.length > 4_000 || /[\0-\x08\x0b\x0c\x0e-\x1f]/.test(query)) throw new Error("Knowledge Retrieval V3 query is invalid.");
    const projection = await this.#store.activeProjection();
    if (!projection) return { contractVersion: KNOWLEDGE_RETRIEVAL_V3_CONTRACT_VERSION, projectionHash: null, authorizationPolicySetDigest: sha256({ status: "no-active-projection" }), mode: "lexical", hits: [], gaps: ["no-active-retrieval-projection"], degradations: [] };
    const authorization = await this.#authorization(input.subject);
    if (authorization.policyIds.length === 0) return { contractVersion: KNOWLEDGE_RETRIEVAL_V3_CONTRACT_VERSION, projectionHash: projection.projectionHash, authorizationPolicySetDigest: authorization.digest, mode: "lexical", hits: [], gaps: ["no-authorized-results"], degradations: [] };
    const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
    const candidateLimit = Math.min(Math.max(limit * 8, 40), 400);
    const lexical = await this.#store.lexicalCandidates({ projectionHash: projection.projectionHash, query, authorizedPolicyIds: authorization.policyIds, limit: candidateLimit });
    const requestedMode = input.mode ?? "hybrid";
    const degradations: string[] = [];
    let semantic: KnowledgeRetrievalCandidateV3[] = [];
    let mode: KnowledgeRetrievalResultV3["mode"] = "lexical";
    if (requestedMode === "hybrid") {
      if (!this.#embedding) degradations.push("embedding-disabled");
      else if (!projection.embeddingProfile || !this.#store.semanticCandidates) degradations.push("embedding-unavailable");
      else if (projection.embeddingProfile.adapterId !== this.#embedding.id || projection.embeddingProfile.adapterVersion !== this.#embedding.version || projection.embeddingProfile.dimensions !== this.#embedding.dimensions) {
        degradations.push("embedding-profile-mismatch");
      } else {
        try {
          const vector = (await this.#embedding.embed([query]))[0];
          if (!vector || vector.length !== this.#embedding.dimensions || vector.some((value) => !Number.isFinite(value))) throw new Error("Embedding adapter returned an invalid query vector.");
          semantic = await this.#store.semanticCandidates({ projectionHash: projection.projectionHash, vector, adapterId: this.#embedding.id, adapterVersion: this.#embedding.version, dimensions: this.#embedding.dimensions, authorizedPolicyIds: authorization.policyIds, limit: candidateLimit });
          if (semantic.length === 0) degradations.push("embedding-unavailable");
          else mode = "hybrid";
        } catch {
          degradations.push("embedding-failed");
        }
      }
    }
    const byId = new Map<string, { unit: KnowledgeRetrievalUnitV3; ranks: KnowledgeRetrievalHitV3["ranks"]; score: number }>();
    const add = (candidate: KnowledgeRetrievalCandidateV3, kind: "exact" | "lexical" | "semantic", fallbackRank: number) => {
      const rank = candidate[`${kind}Rank`] ?? fallbackRank;
      const current = byId.get(candidate.unit.unitId) ?? { unit: candidate.unit, ranks: {}, score: 0 };
      current.ranks[kind] = rank;
      current.score += rrf(rank);
      byId.set(candidate.unit.unitId, current);
    };
    lexical.forEach((candidate, index) => {
      if (candidate.exactRank) add(candidate, "exact", index + 1);
      if (candidate.lexicalRank) add(candidate, "lexical", index + 1);
    });
    semantic.forEach((candidate, index) => add(candidate, "semantic", index + 1));
    const graphLimit = Math.max(0, Math.min(input.graphLimit ?? 8, 30));
    const seeds = [...byId.values()].sort((left, right) => right.score - left.score || left.unit.unitId.localeCompare(right.unit.unitId)).slice(0, graphLimit);
    const graphIds = [...new Set(seeds.flatMap((entry) => entry.unit.graphNeighbors))].filter((identity) => !byId.has(identity)).slice(0, 200);
    if (graphIds.length > 0) {
      const graphUnits = await this.#store.getUnitsByIds({ projectionHash: projection.projectionHash, unitIds: graphIds, authorizedPolicyIds: authorization.policyIds });
      const seedRank = new Map(seeds.map((entry, index) => [entry.unit.unitId, index + 1]));
      for (const unit of graphUnits) {
        const connected = seeds.filter((seed) => seed.unit.graphNeighbors.includes(unit.unitId)).sort((left, right) => (seedRank.get(left.unit.unitId) ?? 999) - (seedRank.get(right.unit.unitId) ?? 999))[0];
        if (!connected) continue;
        const rank = seedRank.get(connected.unit.unitId)!;
        byId.set(unit.unitId, { unit, ranks: { graph: rank }, score: rrf(rank) * 0.25 });
      }
    }
    const queryTokens = normalizeSearchText(query).slice(0, 64);
    const ranked = [...byId.values()].map((entry): KnowledgeRetrievalHitV3 => {
      const signals = entry.unit.signals;
      const quality = (signals.confidence * 0.03 + signals.authority * 0.04 + signals.freshness * 0.02 + signals.expectedValue * 0.02) * stateWeight[entry.unit.state];
      return {
        unitId: entry.unit.unitId,
        parentId: entry.unit.parentId,
        kind: entry.unit.kind,
        authorityLayer: entry.unit.authorityLayer,
        state: entry.unit.state,
        title: entry.unit.title,
        excerpt: excerpt(entry.unit.text, queryTokens),
        contentDigest: entry.unit.contentDigest,
        accessPolicyId: entry.unit.accessPolicyId,
        sourceIds: [...entry.unit.sourceIds],
        ...(entry.unit.evidenceLocator ? { evidenceLocator: structuredClone(entry.unit.evidenceLocator) } : {}),
        score: fixed(entry.score + quality),
        ranks: entry.ranks,
        explanation: [`rrf:${fixed(entry.score)}`, `confidence:${signals.confidence.toFixed(3)}`, `authority:${signals.authority.toFixed(3)}`, `freshness:${signals.freshness.toFixed(3)}`, `state:${entry.unit.state}`],
      };
    }).sort((left, right) => right.score - left.score || left.unitId.localeCompare(right.unitId));
    const hits: KnowledgeRetrievalHitV3[] = [];
    const parents = new Set<string>();
    const sourceCounts = new Map<string, number>();
    for (const hit of ranked) {
      if (parents.has(hit.parentId)) continue;
      const source = hit.sourceIds[0] ?? "unknown";
      if ((sourceCounts.get(source) ?? 0) >= 2 && hits.length >= 3) continue;
      parents.add(hit.parentId);
      sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
      hits.push(hit);
      if (hits.length >= limit) break;
    }
    return { contractVersion: KNOWLEDGE_RETRIEVAL_V3_CONTRACT_VERSION, projectionHash: projection.projectionHash, authorizationPolicySetDigest: authorization.digest, mode, hits, gaps: hits.length === 0 ? ["no-results"] : [], degradations: [...new Set(degradations)] };
  }

  async get(input: { unitId: string; subject?: KnowledgeAccessSubject }): Promise<KnowledgeRetrievalUnitV3 | undefined> {
    const unitId = input.unitId.trim();
    if (!unitId) throw new Error("Knowledge Retrieval V3 unit identity is required.");
    const projection = await this.#store.activeProjection();
    if (!projection) return undefined;
    const authorization = await this.#authorization(input.subject);
    if (authorization.policyIds.length === 0) return undefined;
    const unit = (await this.#store.getUnitsByIds({ projectionHash: projection.projectionHash, unitIds: [unitId], authorizedPolicyIds: authorization.policyIds }))[0];
    if (!unit || unit.graphNeighbors.length === 0) return unit;
    const authorizedNeighbors = await this.#store.getUnitsByIds({ projectionHash: projection.projectionHash, unitIds: unit.graphNeighbors, authorizedPolicyIds: authorization.policyIds });
    const allowed = new Set(authorizedNeighbors.map((neighbor) => neighbor.unitId));
    return { ...unit, graphNeighbors: unit.graphNeighbors.filter((identity) => allowed.has(identity)) };
  }

  async contextPack(input: { query: string; subject?: KnowledgeAccessSubject; authorizationContextDigest: string; maximumUnits?: number; maximumCharacters?: number; mode?: "lexical" | "hybrid"; createdAt?: string }): Promise<KnowledgeContextPackV3 | undefined> {
    const maximumUnits = Math.max(1, Math.min(input.maximumUnits ?? 8, 50));
    const maximumCharacters = Math.max(100, Math.min(input.maximumCharacters ?? 12_000, 200_000));
    const searched = await this.search({ query: input.query, subject: input.subject, limit: maximumUnits, mode: input.mode });
    if (!searched.projectionHash) return undefined;
    const hits: KnowledgeRetrievalHitV3[] = [];
    let characters = 0;
    for (const hit of searched.hits) {
      if (characters + hit.excerpt.length > maximumCharacters) continue;
      hits.push(hit);
      characters += hit.excerpt.length;
    }
    const withoutId = {
      contractVersion: KNOWLEDGE_RETRIEVAL_V3_CONTRACT_VERSION,
      projectionHash: searched.projectionHash,
      queryDigest: sha256(input.query.trim()),
      authorizationContextDigest: input.authorizationContextDigest,
      authorizedPolicySetDigest: searched.authorizationPolicySetDigest,
      unitIds: hits.map((hit) => hit.unitId),
      contentDigests: hits.map((hit) => hit.contentDigest),
      degradations: searched.degradations,
      budget: { maximumUnits, maximumCharacters },
      createdAt: new Date(input.createdAt ?? new Date().toISOString()).toISOString(),
    };
    return { hits, receipt: { receiptId: sha256(withoutId), ...withoutId } };
  }
}

export function validateKnowledgeAnswerEnvelopeV3(input: { envelope: KnowledgeAnswerEnvelopeV3; context: KnowledgeContextPackV3 }): KnowledgeAnswerEnvelopeV3 {
  const envelope = structuredClone(input.envelope);
  if (envelope.contractVersion !== KNOWLEDGE_RETRIEVAL_V3_CONTRACT_VERSION || envelope.contextReceiptId !== input.context.receipt.receiptId) throw new Error("Knowledge Answer Envelope V3 does not match its context receipt.");
  const allowed = new Map(input.context.hits.map((hit) => [hit.unitId, hit.contentDigest]));
  for (const citation of envelope.citations) if (allowed.get(citation.unitId) !== citation.contentDigest) throw new Error(`Knowledge answer citation '${citation.unitId}' is outside the exact authorized context.`);
  const cited = new Set(envelope.citations.map((citation) => citation.unitId));
  for (const claim of envelope.claims) {
    if (!claim.text.trim() || claim.citationUnitIds.length === 0 || claim.citationUnitIds.some((identity) => !cited.has(identity))) throw new Error("Every substantive Knowledge answer claim requires citations from the exact envelope context.");
  }
  if (input.context.hits.length === 0 && (envelope.status !== "unavailable" || envelope.answer.trim() || envelope.claims.length > 0)) throw new Error("Empty Knowledge context cannot produce a substantive answer.");
  if (envelope.status === "answered" && (!envelope.answer.trim() || envelope.claims.length === 0 || envelope.citations.length === 0)) throw new Error("A substantive Knowledge answer requires text, claims, and citations.");
  if (envelope.status === "unavailable" && (envelope.answer.trim() || envelope.claims.length > 0)) throw new Error("Unavailable Knowledge answer must not contain substantive content.");
  return envelope;
}

export function createExtractiveKnowledgeAnswerV3(input: { context: KnowledgeContextPackV3; gaps?: string[] }): KnowledgeAnswerEnvelopeV3 {
  if (input.context.hits.length === 0) return validateKnowledgeAnswerEnvelopeV3({ context: input.context, envelope: {
    contractVersion: KNOWLEDGE_RETRIEVAL_V3_CONTRACT_VERSION, status: "unavailable", answer: "", claims: [], citations: [], authorityLayers: [], conflicts: [], gaps: input.gaps ?? ["no-authorized-evidence"], uncertainty: [], degradations: input.context.receipt.degradations, freshness: "unknown", contextReceiptId: input.context.receipt.receiptId,
  } });
  const claims = input.context.hits.map((hit) => ({ text: hit.excerpt, citationUnitIds: [hit.unitId] }));
  return validateKnowledgeAnswerEnvelopeV3({ context: input.context, envelope: {
    contractVersion: KNOWLEDGE_RETRIEVAL_V3_CONTRACT_VERSION, status: "extractive-fallback", answer: claims.map((claim) => claim.text).join("\n\n"), claims,
    citations: input.context.hits.map((hit) => ({ unitId: hit.unitId, contentDigest: hit.contentDigest })), authorityLayers: [...new Set(input.context.hits.map((hit) => hit.authorityLayer))], conflicts: input.context.hits.filter((hit) => hit.state === "contested").map((hit) => hit.unitId), gaps: input.gaps ?? [], uncertainty: [], degradations: input.context.receipt.degradations, freshness: input.context.hits.some((hit) => ["expired", "superseded"].includes(hit.state)) ? "stale" : "mixed", contextReceiptId: input.context.receipt.receiptId,
  } });
}

export class InMemoryKnowledgeRetrievalCandidateStoreV3 implements KnowledgeRetrievalCandidateStoreV3 {
  readonly #projection: KnowledgeRetrievalProjectionMetadataV3;
  readonly #units: KnowledgeRetrievalUnitV3[];
  readonly #policies: KnowledgeAccessPolicy[];

  constructor(input: { projection: KnowledgeRetrievalProjectionMetadataV3; units: readonly KnowledgeRetrievalUnitV3[]; policies: readonly KnowledgeAccessPolicy[] }) {
    this.#projection = structuredClone(input.projection);
    this.#units = structuredClone([...input.units]);
    this.#policies = structuredClone([...input.policies]);
  }

  async activeProjection(): Promise<KnowledgeRetrievalProjectionMetadataV3 | undefined> { return this.#projection.status === "active" ? structuredClone(this.#projection) : undefined; }
  async policies(): Promise<KnowledgeAccessPolicy[]> { return structuredClone(this.#policies); }

  async lexicalCandidates(input: { projectionHash: string; query: string; authorizedPolicyIds: string[]; limit: number }): Promise<KnowledgeRetrievalCandidateV3[]> {
    if (input.projectionHash !== this.#projection.projectionHash) return [];
    const query = input.query.toLocaleLowerCase("en");
    const tokens = normalizeSearchText(query);
    const authorized = this.#units.filter((unit) => input.authorizedPolicyIds.includes(unit.accessPolicyId));
    const exact = authorized.filter((unit) => [unit.title, ...unit.aliases].some((value) => value.toLocaleLowerCase("en") === query)).sort((left, right) => left.unitId.localeCompare(right.unitId));
    const lexical = authorized.map((unit) => ({ unit, score: tokens.reduce((sum, token) => sum + normalizeSearchText(`${unit.title} ${unit.text}`).filter((value) => value === token).length, 0) })).filter((entry) => entry.score > 0).sort((left, right) => right.score - left.score || left.unit.unitId.localeCompare(right.unit.unitId));
    const byId = new Map<string, KnowledgeRetrievalCandidateV3>();
    exact.forEach((unit, index) => byId.set(unit.unitId, { unit: structuredClone(unit), exactRank: index + 1 }));
    lexical.forEach((entry, index) => byId.set(entry.unit.unitId, { ...(byId.get(entry.unit.unitId) ?? { unit: structuredClone(entry.unit) }), lexicalRank: index + 1 }));
    return [...byId.values()].slice(0, input.limit);
  }

  async getUnitsByIds(input: { projectionHash: string; unitIds: string[]; authorizedPolicyIds: string[] }): Promise<KnowledgeRetrievalUnitV3[]> {
    if (input.projectionHash !== this.#projection.projectionHash) return [];
    return this.#units.filter((unit) => input.unitIds.includes(unit.unitId) && input.authorizedPolicyIds.includes(unit.accessPolicyId)).map((unit) => structuredClone(unit));
  }
}
