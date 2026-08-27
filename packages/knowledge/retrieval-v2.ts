import { canonicalJson, sha256 } from "../runtime/canonical.ts";
import type { KnowledgeAccessSubject } from "./contracts.ts";
import { normalizeSearchText } from "./search.ts";
import { executeKnowledgeModel, type KnowledgeModelExecutionReceipt, type KnowledgeModelExecutor, type KnowledgeModelProfileBinding } from "./knowledge-model-execution.ts";
import { KnowledgePromptRegistry } from "./prompt-registry.ts";

export const KNOWLEDGE_RETRIEVAL_V2_CONTRACT_VERSION = "2.0.0" as const;
export type KnowledgeResultLabel = "evidence" | "attributed" | "synthesized" | "contested" | "superseded" | "expired" | "official";
export type KnowledgeCapability = "search" | "get" | "timeline" | "traverse" | "synthesize" | "context-pack" | "delta" | "explain";

export interface KnowledgeRetrievalRecordV2 {
  identity: string;
  kind: "page" | "claim" | "source-object" | "synthesis" | "handbook" | "timeline-event";
  pageId?: string;
  title: string;
  aliases: string[];
  text: string;
  contentDigest: string;
  accessPolicyId: string;
  label: KnowledgeResultLabel;
  observedAt: string;
  sourceIds: string[];
  confidence: number;
  authority: number;
  freshness: number;
  expectedValue: number;
  graphNeighbors: string[];
}

export interface KnowledgeRetrievalHitV2 {
  identity: string;
  kind: KnowledgeRetrievalRecordV2["kind"];
  pageId?: string;
  title: string;
  excerpt: string;
  label: KnowledgeResultLabel;
  score: number;
  ranks: { exact?: number; lexical?: number; semantic?: number; graph?: number; rerank?: number };
  explanation: string[];
  contentDigest: string;
  accessPolicyId: string;
}

export interface KnowledgeContextReceiptV2 {
  receiptId: string;
  queryDigest: string;
  authorizationContextDigest: string;
  identities: string[];
  contentDigests: string[];
  operationReceiptIds: string[];
  degradations: string[];
  budget: { maxRecords: number; maxCharacters: number };
  createdAt: string;
}

export interface KnowledgeContextPackV2 {
  records: KnowledgeRetrievalHitV2[];
  receipt: KnowledgeContextReceiptV2;
}

export interface KnowledgeAnswerEnvelopeV2 {
  contractVersion: typeof KNOWLEDGE_RETRIEVAL_V2_CONTRACT_VERSION;
  status: "answered" | "extractive-fallback" | "unavailable";
  answer: string;
  citations: Array<{ identity: string; contentDigest: string }>;
  labels: KnowledgeResultLabel[];
  gaps: string[];
  conflicts: string[];
  freshness: string;
  contextReceiptId: string;
  modelReceiptId?: string;
}

export interface KnowledgeDeltaV2 {
  sequence: number;
  identity: string;
  changeKind: "created" | "updated" | "deleted" | "access-changed";
  accessPolicyId: string;
  contentDigest: string;
  occurredAt: string;
}

export interface KnowledgeRetrievalAuthorization {
  canRead(input: { subject?: KnowledgeAccessSubject; policyId: string; objectId: string; capability: KnowledgeCapability }): Promise<boolean>;
}

export interface KnowledgeQueryExpansionResultV2 {
  terms: string[];
  receiptId: string;
}

export interface KnowledgeRerankResultV2 {
  scores: Map<string, number>;
  receiptId: string;
}

export interface KnowledgeExplanationV2 {
  identity: string;
  label: KnowledgeResultLabel;
  accessPolicyId: string;
  contentDigest: string;
  observedAt: string;
  sourceIds: string[];
  signals: { confidence: number; authority: number; freshness: number; expectedValue: number };
}

const rrf = (rank: number): number => 1 / (60 + rank);
const excerpt = (text: string, queryTokens: string[], maximum = 360): string => {
  const normalized = text.replace(/\s+/g, " ").trim();
  const lower = normalized.toLocaleLowerCase("en");
  const positions = queryTokens.map((token) => lower.indexOf(token)).filter((position) => position >= 0);
  const start = positions.length ? Math.max(0, Math.min(...positions) - 80) : 0;
  return normalized.slice(start, start + maximum);
};

export class KnowledgeRetrievalServiceV2 {
  readonly #records: KnowledgeRetrievalRecordV2[];
  readonly #authorization: KnowledgeRetrievalAuthorization;
  readonly #semantic?: (query: string, authorized: readonly KnowledgeRetrievalRecordV2[]) => Promise<Map<string, number>>;
  readonly #queryExpander?: (query: string) => Promise<KnowledgeQueryExpansionResultV2>;
  readonly #reranker?: (query: string, authorizedCandidates: readonly KnowledgeRetrievalRecordV2[]) => Promise<KnowledgeRerankResultV2>;
  readonly #deltas: KnowledgeDeltaV2[];

  constructor(input: {
    records: readonly KnowledgeRetrievalRecordV2[];
    authorization: KnowledgeRetrievalAuthorization;
    semantic?: (query: string, authorized: readonly KnowledgeRetrievalRecordV2[]) => Promise<Map<string, number>>;
    queryExpander?: (query: string) => Promise<KnowledgeQueryExpansionResultV2>;
    reranker?: (query: string, authorizedCandidates: readonly KnowledgeRetrievalRecordV2[]) => Promise<KnowledgeRerankResultV2>;
    deltas?: readonly KnowledgeDeltaV2[];
  }) {
    this.#records = [...input.records].map((record) => structuredClone(record));
    this.#authorization = input.authorization;
    this.#semantic = input.semantic;
    this.#queryExpander = input.queryExpander;
    this.#reranker = input.reranker;
    this.#deltas = [...(input.deltas ?? [])].map((delta) => structuredClone(delta)).sort((a, b) => a.sequence - b.sequence || a.identity.localeCompare(b.identity));
  }

  async #authorized(subject: KnowledgeAccessSubject | undefined, capability: KnowledgeCapability): Promise<KnowledgeRetrievalRecordV2[]> {
    const decisions = await Promise.all(this.#records.map(async (record) => ({
      record,
      permitted: await this.#authorization.canRead({
        subject,
        policyId: record.accessPolicyId,
        objectId: record.identity,
        capability,
      }),
    })));
    return decisions
      .filter((decision) => decision.permitted)
      .map((decision) => structuredClone(decision.record));
  }

  async #search(input: { query: string; subject?: KnowledgeAccessSubject; limit?: number; graphLimit?: number; costMode?: "fast" | "balanced" | "deep"; expandQuery?: boolean; rerank?: boolean }, capability: "search" | "context-pack"): Promise<{ hits: KnowledgeRetrievalHitV2[]; degradations: string[]; operationReceiptIds: string[] }> {
    const query = input.query.trim();
    if (!query) throw new Error("Knowledge search query is empty.");
    const costMode = input.costMode ?? "balanced";
    if (input.expandQuery && costMode !== "deep") throw new Error("Knowledge query expansion is available only in deep cost mode.");
    const authorized = await this.#authorized(input.subject, capability);
    const operationReceiptIds: string[] = [];
    const expansion = input.expandQuery && this.#queryExpander ? await this.#queryExpander(query) : undefined;
    if (expansion) {
      if (!expansion.receiptId.trim() || !Array.isArray(expansion.terms) || expansion.terms.length > 8 || expansion.terms.some((term) => typeof term !== "string" || !term.trim() || term.length > 200 || /[\0-\x08\x0b\x0c\x0e-\x1f]/.test(term))) throw new Error("Knowledge query expansion returned an invalid bounded result.");
      operationReceiptIds.push(expansion.receiptId);
    }
    const queryTokens = normalizeSearchText([query, ...(expansion?.terms ?? [])].join(" ")).slice(0, 64);
    const exact = authorized.filter((record) => [record.title, ...record.aliases].some((value) => value.toLocaleLowerCase("en") === query.toLocaleLowerCase("en"))).sort((a, b) => a.identity.localeCompare(b.identity));
    const lexical = authorized.map((record) => ({ record, score: queryTokens.reduce((sum, token) => sum + normalizeSearchText(`${record.title} ${record.text}`).filter((entry) => entry === token).length, 0) })).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.record.identity.localeCompare(b.record.identity));
    const semanticQuery = [query, ...(expansion?.terms ?? [])].join(" ");
    const semanticScores = this.#semantic ? await this.#semantic(semanticQuery, authorized) : new Map<string, number>();
    for (const identity of semanticScores.keys()) if (!authorized.some((record) => record.identity === identity)) throw new Error("Semantic adapter returned an unauthorized or unknown identity.");
    const semantic = authorized.filter((record) => (semanticScores.get(record.identity) ?? 0) > 0).sort((a, b) => (semanticScores.get(b.identity) ?? 0) - (semanticScores.get(a.identity) ?? 0) || a.identity.localeCompare(b.identity));
    const score = new Map<string, number>();
    const ranks = new Map<string, KnowledgeRetrievalHitV2["ranks"]>();
    const add = (records: KnowledgeRetrievalRecordV2[], kind: "exact" | "lexical" | "semantic") => records.forEach((record, index) => {
      score.set(record.identity, (score.get(record.identity) ?? 0) + rrf(index + 1));
      ranks.set(record.identity, { ...(ranks.get(record.identity) ?? {}), [kind]: index + 1 });
    });
    add(exact, "exact"); add(lexical.map((entry) => entry.record), "lexical"); add(semantic, "semantic");
    const candidateIds = new Set(score.keys());
    const graphLimit = Math.max(0, Math.min(input.graphLimit ?? 10, 50));
    const rankedSeeds = [...candidateIds].sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0) || a.localeCompare(b)).slice(0, graphLimit);
    for (const [seedRank, seed] of rankedSeeds.entries()) {
      const record = authorized.find((entry) => entry.identity === seed)!;
      for (const neighbor of record.graphNeighbors) {
        if (!authorized.some((entry) => entry.identity === neighbor)) continue;
        score.set(neighbor, (score.get(neighbor) ?? 0) + rrf(seedRank + 1) * 0.25);
        ranks.set(neighbor, { ...(ranks.get(neighbor) ?? {}), graph: seedRank + 1 });
      }
    }
    let hits = authorized.filter((record) => score.has(record.identity)).map((record): KnowledgeRetrievalHitV2 => {
      const components = ranks.get(record.identity)!;
      const base = score.get(record.identity)!;
      const quality = record.confidence * 0.03 + record.authority * 0.03 + record.freshness * 0.02 + record.expectedValue * 0.02;
      return { identity: record.identity, kind: record.kind, ...(record.pageId ? { pageId: record.pageId } : {}), title: record.title, excerpt: excerpt(record.text, queryTokens), label: record.label, score: Number((base + quality).toFixed(8)), ranks: components, explanation: [`rrf:${base.toFixed(8)}`, `confidence:${record.confidence.toFixed(3)}`, `authority:${record.authority.toFixed(3)}`, `freshness:${record.freshness.toFixed(3)}`, `expected-value:${record.expectedValue.toFixed(3)}`], contentDigest: record.contentDigest, accessPolicyId: record.accessPolicyId };
    }).sort((a, b) => b.score - a.score || a.identity.localeCompare(b.identity));
    if (input.rerank && this.#reranker && hits.length) {
      const bounded = hits.slice(0, 50);
      const identities = new Set(bounded.map((hit) => hit.identity));
      const result = await this.#reranker(query, bounded.map((hit) => authorized.find((record) => record.identity === hit.identity)!));
      if (!result.receiptId.trim()) throw new Error("Knowledge reranker did not return an execution receipt.");
      for (const [identity, value] of result.scores) if (!identities.has(identity) || !Number.isFinite(value) || value < 0 || value > 1) throw new Error("Knowledge reranker returned an unauthorized identity or invalid score.");
      operationReceiptIds.push(result.receiptId);
      const ranked = [...result.scores.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
      const rerankRanks = new Map(ranked.map(([identity], index) => [identity, index + 1]));
      hits = hits.map((hit) => {
        const rank = rerankRanks.get(hit.identity);
        if (!rank) return hit;
        const rerankScore = rrf(rank) * 0.5;
        return { ...hit, score: Number((hit.score + rerankScore).toFixed(8)), ranks: { ...hit.ranks, rerank: rank }, explanation: [...hit.explanation, `rerank:${rerankScore.toFixed(8)}`] };
      }).sort((a, b) => b.score - a.score || a.identity.localeCompare(b.identity));
    }
    const collapsed: KnowledgeRetrievalHitV2[] = [];
    const pages = new Set<string>();
    const sources = new Map<string, number>();
    for (const hit of hits) {
      const page = hit.pageId ?? hit.identity;
      if (pages.has(page)) continue;
      const record = authorized.find((entry) => entry.identity === hit.identity)!;
      const source = record.sourceIds[0] ?? "unknown";
      if ((sources.get(source) ?? 0) >= 2 && collapsed.length >= 3) continue;
      pages.add(page); sources.set(source, (sources.get(source) ?? 0) + 1); collapsed.push(hit);
      if (collapsed.length >= Math.max(1, Math.min(input.limit ?? 10, 50))) break;
    }
    const degradations = [...(this.#semantic ? [] : ["semantic-unavailable"]), ...(input.expandQuery && !this.#queryExpander ? ["query-expansion-unavailable"] : []), ...(input.rerank && !this.#reranker ? ["reranker-unavailable"] : [])];
    return { hits: collapsed, degradations, operationReceiptIds };
  }

  async search(input: { query: string; subject?: KnowledgeAccessSubject; limit?: number; graphLimit?: number; costMode?: "fast" | "balanced" | "deep"; expandQuery?: boolean; rerank?: boolean }): Promise<{ hits: KnowledgeRetrievalHitV2[]; degradations: string[]; operationReceiptIds: string[] }> {
    return this.#search(input, "search");
  }

  async get(input: { identity: string; subject?: KnowledgeAccessSubject }): Promise<KnowledgeRetrievalRecordV2 | undefined> {
    const record = this.#records.find((entry) => entry.identity === input.identity);
    if (!record || !await this.#authorization.canRead({ subject: input.subject, policyId: record.accessPolicyId, objectId: record.identity, capability: "get" })) return undefined;
    return structuredClone(record);
  }

  async traverse(input: { identity: string; subject?: KnowledgeAccessSubject; maxDepth?: number; maxNodes?: number }): Promise<Array<{ identity: string; depth: number; via?: string }>> {
    const authorized = await this.#authorized(input.subject, "traverse");
    if (!authorized.some((record) => record.identity === input.identity)) return [];
    const output: Array<{ identity: string; depth: number; via?: string }> = [{ identity: input.identity, depth: 0 }]; const seen = new Set([input.identity]);
    for (let cursor = 0; cursor < output.length && output.length < Math.min(input.maxNodes ?? 50, 200); cursor += 1) {
      const current = output[cursor]; if (current.depth >= Math.min(input.maxDepth ?? 2, 5)) continue;
      const record = authorized.find((entry) => entry.identity === current.identity)!;
      for (const neighbor of record.graphNeighbors.sort()) if (!seen.has(neighbor) && authorized.some((entry) => entry.identity === neighbor)) { seen.add(neighbor); output.push({ identity: neighbor, depth: current.depth + 1, via: current.identity }); }
    }
    return output;
  }

  async timeline(input: { identity: string; subject?: KnowledgeAccessSubject; from?: string; to?: string; limit?: number }): Promise<KnowledgeRetrievalRecordV2[]> {
    const authorized = await this.#authorized(input.subject, "timeline");
    const from = input.from ? Date.parse(input.from) : Number.NEGATIVE_INFINITY;
    const to = input.to ? Date.parse(input.to) : Number.POSITIVE_INFINITY;
    if (Number.isNaN(from) || Number.isNaN(to) || from > to) throw new Error("Knowledge timeline range is invalid.");
    return authorized
      .filter((record) => record.kind === "timeline-event" && (record.identity === input.identity || record.pageId === input.identity) && Date.parse(record.observedAt) >= from && Date.parse(record.observedAt) <= to)
      .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.identity.localeCompare(right.identity))
      .slice(0, Math.max(1, Math.min(input.limit ?? 100, 500)));
  }

  async explain(input: { identity: string; subject?: KnowledgeAccessSubject }): Promise<KnowledgeExplanationV2 | undefined> {
    const record = this.#records.find((entry) => entry.identity === input.identity);
    if (!record || !await this.#authorization.canRead({ subject: input.subject, policyId: record.accessPolicyId, objectId: record.identity, capability: "explain" })) return undefined;
    return { identity: record.identity, label: record.label, accessPolicyId: record.accessPolicyId, contentDigest: record.contentDigest, observedAt: record.observedAt, sourceIds: [...record.sourceIds], signals: { confidence: record.confidence, authority: record.authority, freshness: record.freshness, expectedValue: record.expectedValue } };
  }

  async contextPack(input: { query: string; subject?: KnowledgeAccessSubject; authorizationContextDigest: string; maxRecords?: number; maxCharacters?: number; costMode?: "fast" | "balanced" | "deep"; expandQuery?: boolean; rerank?: boolean; createdAt?: string }): Promise<KnowledgeContextPackV2> {
    const maxRecords = Math.max(1, Math.min(input.maxRecords ?? 8, 50)); const maxCharacters = Math.max(100, Math.min(input.maxCharacters ?? 12_000, 200_000));
    const searched = await this.#search({ query: input.query, subject: input.subject, limit: maxRecords, costMode: input.costMode, expandQuery: input.expandQuery, rerank: input.rerank }, "context-pack");
    const records: KnowledgeRetrievalHitV2[] = []; let used = 0;
    for (const hit of searched.hits) { if (used + hit.excerpt.length > maxCharacters) continue; records.push(hit); used += hit.excerpt.length; }
    const createdAt = new Date(input.createdAt ?? new Date().toISOString()).toISOString();
    const withoutId = { queryDigest: sha256(input.query.trim()), authorizationContextDigest: input.authorizationContextDigest, identities: records.map((entry) => entry.identity), contentDigests: records.map((entry) => entry.contentDigest), operationReceiptIds: [...searched.operationReceiptIds], degradations: [...searched.degradations], budget: { maxRecords, maxCharacters }, createdAt };
    return { records, receipt: { receiptId: sha256(withoutId), ...withoutId } };
  }

  async delta(input: { afterSequence?: number; subject?: KnowledgeAccessSubject; limit?: number }): Promise<{ changes: KnowledgeDeltaV2[]; nextSequence: number; atLeastOnce: true }> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500)); const output: KnowledgeDeltaV2[] = [];
    for (const delta of this.#deltas) {
      if (delta.sequence < (input.afterSequence ?? 0)) continue;
      if (!await this.#authorization.canRead({ subject: input.subject, policyId: delta.accessPolicyId, objectId: delta.identity, capability: "delta" })) continue;
      output.push(structuredClone(delta)); if (output.length >= limit) break;
    }
    return { changes: output, nextSequence: output.at(-1)?.sequence ?? input.afterSequence ?? 0, atLeastOnce: true };
  }
}

export function validateKnowledgeAnswerEnvelope(input: { envelope: KnowledgeAnswerEnvelopeV2; context: KnowledgeContextPackV2 }): KnowledgeAnswerEnvelopeV2 {
  const envelope = structuredClone(input.envelope);
  if (envelope.contractVersion !== KNOWLEDGE_RETRIEVAL_V2_CONTRACT_VERSION || envelope.contextReceiptId !== input.context.receipt.receiptId) throw new Error("Knowledge Answer Envelope does not match its context receipt.");
  const allowed = new Map(input.context.records.map((record) => [record.identity, record.contentDigest]));
  for (const citation of envelope.citations) if (allowed.get(citation.identity) !== citation.contentDigest) throw new Error(`Knowledge answer citation '${citation.identity}' is outside the exact authorized context.`);
  if (input.context.records.length === 0 && (envelope.status !== "unavailable" || envelope.answer.trim())) throw new Error("Empty Knowledge context cannot produce a substantive answer.");
  if (envelope.status === "answered" && (!envelope.answer.trim() || envelope.citations.length === 0)) throw new Error("A substantive Knowledge answer requires text and citations.");
  if (envelope.status === "unavailable" && envelope.answer.trim()) throw new Error("Unavailable Knowledge answer must not contain substantive text.");
  return envelope;
}

export function renderKnowledgeAnswer(envelope: KnowledgeAnswerEnvelopeV2): string {
  if (envelope.status === "unavailable") return `Knowledge unavailable${envelope.gaps.length ? `: ${envelope.gaps.join(", ")}` : "."}`;
  const citations = envelope.citations.map((entry) => `[${entry.identity}]`).join(" ");
  return `${envelope.answer.trim()}${citations ? `\n\nEvidence: ${citations}` : ""}`;
}

export async function synthesizeKnowledgeAnswer(input: {
  query: string;
  context: KnowledgeContextPackV2;
  executor: KnowledgeModelExecutor;
  profile: KnowledgeModelProfileBinding;
  authorizationContextDigest: string;
  dataClass: "business" | "confidential" | "restricted" | "personal";
  grant: boolean;
  now?: string;
}): Promise<{ envelope: KnowledgeAnswerEnvelopeV2; receipt?: KnowledgeModelExecutionReceipt }> {
  if (!input.grant) throw new Error("knowledge.synthesize requires an explicit grant.");
  const query = input.query.trim();
  if (!query) throw new Error("Knowledge synthesis query is empty.");
  if (input.context.records.length === 0) return { envelope: validateKnowledgeAnswerEnvelope({ context: input.context, envelope: { contractVersion: KNOWLEDGE_RETRIEVAL_V2_CONTRACT_VERSION, status: "unavailable", answer: "", citations: [], labels: [], gaps: ["no-authorized-evidence"], conflicts: [], freshness: "unknown", contextReceiptId: input.context.receipt.receiptId } }) };
  const prompt = new KnowledgePromptRegistry().resolveCurrent("knowledge.cited-synthesis");
  const evidenceBlocks = input.context.records.map((record) => {
    const content = canonicalJson({ title: record.title, excerpt: record.excerpt, label: record.label, contentDigest: record.contentDigest });
    return { evidenceId: record.identity, content, contentDigest: sha256(content) };
  });
  const executed = await executeKnowledgeModel({ executor: input.executor, profile: input.profile, requiredProfile: prompt.profile, completedAt: input.now, request: {
    task: prompt.task, promptId: prompt.promptId, promptVersion: prompt.version, promptContentHash: prompt.contentHash,
    inputSchemaId: prompt.inputSchemaId, outputSchemaId: prompt.outputSchemaId, systemInstruction: prompt.systemInstruction,
    taskInput: { query, contextReceiptId: input.context.receipt.receiptId }, evidenceBlocks,
    authorizationContextDigest: input.authorizationContextDigest, dataClass: input.dataClass,
    idempotencyKey: sha256({ query, contextReceiptId: input.context.receipt.receiptId }),
  } });
  if (executed.receipt.outcome !== "succeeded") {
    const fallback: KnowledgeAnswerEnvelopeV2 = { contractVersion: KNOWLEDGE_RETRIEVAL_V2_CONTRACT_VERSION, status: "extractive-fallback", answer: input.context.records.map((record) => record.excerpt).join("\n\n"), citations: input.context.records.map(({ identity, contentDigest }) => ({ identity, contentDigest })), labels: [...new Set(input.context.records.map((record) => record.label))], gaps: [`model-${executed.receipt.outcome}`], conflicts: [], freshness: "mixed", contextReceiptId: input.context.receipt.receiptId, modelReceiptId: executed.receipt.receiptId };
    return { envelope: validateKnowledgeAnswerEnvelope({ envelope: fallback, context: input.context }), receipt: executed.receipt };
  }
  const raw = executed.output as Partial<KnowledgeAnswerEnvelopeV2>;
  const envelope: KnowledgeAnswerEnvelopeV2 = { contractVersion: KNOWLEDGE_RETRIEVAL_V2_CONTRACT_VERSION, status: "answered", answer: String(raw.answer ?? ""), citations: Array.isArray(raw.citations) ? raw.citations : [], labels: Array.isArray(raw.labels) ? raw.labels : [], gaps: Array.isArray(raw.gaps) ? raw.gaps.map(String) : [], conflicts: Array.isArray(raw.conflicts) ? raw.conflicts.map(String) : [], freshness: typeof raw.freshness === "string" ? raw.freshness : "unknown", contextReceiptId: input.context.receipt.receiptId, modelReceiptId: executed.receipt.receiptId };
  return { envelope: validateKnowledgeAnswerEnvelope({ envelope, context: input.context }), receipt: executed.receipt };
}
