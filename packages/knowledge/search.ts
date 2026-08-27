import type { KnowledgeBundle, KnowledgeSearchHit, KnowledgeSearchResult } from "./contracts.ts";

export const normalizeSearchText = (value: string): string[] => value
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLocaleLowerCase("en")
  .match(/[\p{L}\p{N}]{2,}/gu) ?? [];

const count = (haystack: string[], needle: string) => haystack.reduce((sum, token) => sum + Number(token === needle), 0);

export interface RankedKnowledgeFragment {
  hit: KnowledgeSearchHit;
  path: string;
  fragmentId: string;
}

export const signalsForDocument = (document: KnowledgeBundle["documents"][number]): KnowledgeSearchHit["signals"] => [
  ...(document.status === "contested" ? ["contested" as const] : []),
  ...(document.status === "stale" || (document.validUntil !== undefined && Date.parse(document.validUntil) < Date.now()) ? ["stale" as const] : []),
];

export function rankLexicalKnowledge(bundle: KnowledgeBundle, query: string): RankedKnowledgeFragment[] {
  const terms = [...new Set(normalizeSearchText(query))];
  if (!query.trim() || terms.length === 0) return [];
  const hits: RankedKnowledgeFragment[] = [];
  for (const document of bundle.documents) {
    const titleTokens = normalizeSearchText(`${document.title} ${document.description}`);
    for (const fragment of document.fragments) {
      const bodyTokens = normalizeSearchText(fragment.body);
      const score = terms.reduce((sum, term) => sum + (count(titleTokens, term) * 4) + count(bodyTokens, term), 0);
      if (score === 0) continue;
      hits.push({
        path: document.path,
        fragmentId: fragment.fragmentId,
        hit: {
          score,
          excerpt: fragment.body.trim().slice(0, 1_200),
          signals: signalsForDocument(document),
          citation: {
            snapshotHash: bundle.bundleHash,
            path: document.path,
            fragmentId: fragment.fragmentId,
            heading: fragment.heading,
            startLine: fragment.startLine,
            endLine: fragment.endLine,
            digest: fragment.digest,
          },
        },
      });
    }
  }
  return hits.sort((a, b) => b.hit.score - a.hit.score || a.path.localeCompare(b.path) || a.hit.citation.startLine - b.hit.citation.startLine);
}

export function poolBestPerDocument(ranked: RankedKnowledgeFragment[], limit: number): KnowledgeSearchHit[] {
  const seen = new Set<string>();
  const output: KnowledgeSearchHit[] = [];
  for (const entry of ranked) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    output.push(entry.hit);
    if (output.length >= limit) break;
  }
  return output;
}

export function searchKnowledgeBundle(bundle: KnowledgeBundle, input: { query: string; limit?: number }): KnowledgeSearchResult {
  const query = input.query.trim();
  const limit = Math.max(1, Math.min(input.limit ?? 5, 20));
  const ranked = rankLexicalKnowledge(bundle, query).map((entry, index) => ({ ...entry, hit: { ...entry.hit, lexicalRank: index + 1 } }));
  const bounded = poolBestPerDocument(ranked, limit);
  return { query, snapshotHash: bundle.bundleHash, hits: bounded, gaps: bounded.length === 0 ? ["no-results"] : [], mode: "lexical", degradations: [] };
}
