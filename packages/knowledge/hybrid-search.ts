import type { EmbeddingAdapter, KnowledgeBundle, KnowledgeSearchResult } from "./contracts.ts";
import { cosineSimilarity } from "./embedding.ts";
import { poolBestPerDocument, rankLexicalKnowledge, signalsForDocument, type RankedKnowledgeFragment } from "./search.ts";

const RRF_K = 60;

export async function searchHybridKnowledgeBundle(bundle: KnowledgeBundle, input: {
  query: string;
  limit?: number;
  mode?: "lexical" | "hybrid";
}, adapter?: EmbeddingAdapter): Promise<KnowledgeSearchResult> {
  const requested = input.mode ?? "hybrid";
  const query = input.query.trim();
  const limit = Math.max(1, Math.min(input.limit ?? 5, 20));
  const lexical = rankLexicalKnowledge(bundle, query);
  if (requested === "lexical") {
    const ranked = lexical.map((entry, index) => ({ ...entry, hit: { ...entry.hit, lexicalRank: index + 1 } }));
    const hits = poolBestPerDocument(ranked, limit);
    return { query, snapshotHash: bundle.bundleHash, hits, gaps: hits.length === 0 ? ["no-results"] : [], mode: "lexical", degradations: [] };
  }
  if (!adapter) {
    const ranked = lexical.map((entry, index) => ({ ...entry, hit: { ...entry.hit, lexicalRank: index + 1 } }));
    const hits = poolBestPerDocument(ranked, limit);
    return { query, snapshotHash: bundle.bundleHash, hits, gaps: hits.length === 0 ? ["no-results"] : [], mode: "lexical", degradations: ["embedding-disabled"] };
  }
  try {
    const fragments = bundle.documents.flatMap((document) => document.fragments.map((fragment) => ({ document, fragment })));
    const vectors = await adapter.embed([query, ...fragments.map(({ document, fragment }) => `${document.title}\n${document.description}\n${fragment.body}`)]);
    if (vectors.length !== fragments.length + 1 || vectors.some((vector) => vector.length !== adapter.dimensions)) throw new Error("Embedding adapter returned an invalid vector batch.");
    const queryVector = vectors[0];
    const semantic = fragments.map((entry, index) => ({ ...entry, similarity: cosineSimilarity(queryVector, vectors[index + 1]) }))
      .filter((entry) => entry.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity || a.document.path.localeCompare(b.document.path) || a.fragment.startLine - b.fragment.startLine);
    const byFragment = new Map<string, RankedKnowledgeFragment>();
    lexical.forEach((entry, index) => {
      byFragment.set(entry.fragmentId, { ...entry, hit: { ...entry.hit, lexicalRank: index + 1, score: 1 / (RRF_K + index + 1) } });
    });
    semantic.forEach((entry, index) => {
      const existing = byFragment.get(entry.fragment.fragmentId);
      const semanticScore = 1 / (RRF_K + index + 1);
      if (existing) {
        existing.hit.semanticRank = index + 1;
        existing.hit.score += semanticScore;
      } else {
        byFragment.set(entry.fragment.fragmentId, {
          path: entry.document.path,
          fragmentId: entry.fragment.fragmentId,
          hit: {
            score: semanticScore,
            semanticRank: index + 1,
            excerpt: entry.fragment.body.trim().slice(0, 1_200),
            signals: signalsForDocument(entry.document),
            citation: {
              snapshotHash: bundle.bundleHash,
              path: entry.document.path,
              fragmentId: entry.fragment.fragmentId,
              heading: entry.fragment.heading,
              startLine: entry.fragment.startLine,
              endLine: entry.fragment.endLine,
              digest: entry.fragment.digest,
            },
          },
        });
      }
    });
    const fused = [...byFragment.values()].sort((a, b) => b.hit.score - a.hit.score || a.path.localeCompare(b.path) || a.hit.citation.startLine - b.hit.citation.startLine);
    const hits = poolBestPerDocument(fused, limit);
    return { query, snapshotHash: bundle.bundleHash, hits, gaps: hits.length === 0 ? ["no-results"] : [], mode: "hybrid", degradations: [] };
  } catch {
    const ranked = lexical.map((entry, index) => ({ ...entry, hit: { ...entry.hit, lexicalRank: index + 1 } }));
    const hits = poolBestPerDocument(ranked, limit);
    return { query, snapshotHash: bundle.bundleHash, hits, gaps: hits.length === 0 ? ["no-results"] : [], mode: "lexical", degradations: ["embedding-unavailable"] };
  }
}
