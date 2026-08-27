import type { KnowledgeAccessSubject, KnowledgeProvider } from "./contracts.ts";

export interface RetrievalRegressionCase {
  id: string;
  query: string;
  expectedPaths: string[];
  mode?: "lexical" | "hybrid";
  limit?: number;
}

export interface RetrievalRegressionLedger {
  version: 1;
  subject?: KnowledgeAccessSubject;
  cases: RetrievalRegressionCase[];
}

export async function runRetrievalRegression(provider: KnowledgeProvider, ledger: RetrievalRegressionLedger) {
  const cases = [];
  for (const entry of [...ledger.cases].sort((a, b) => a.id.localeCompare(b.id))) {
    const result = await provider.search({ query: entry.query, mode: entry.mode ?? "hybrid", limit: entry.limit ?? 5, subject: ledger.subject });
    const actualPaths = [...new Set(result.hits.map((hit) => hit.citation.path))];
    const matched = entry.expectedPaths.filter((path) => actualPaths.includes(path));
    cases.push({
      id: entry.id,
      query: entry.query,
      requestedMode: entry.mode ?? "hybrid",
      actualMode: result.mode,
      expectedPaths: [...entry.expectedPaths].sort(),
      actualPaths,
      matchedPaths: matched.sort(),
      recall: entry.expectedPaths.length === 0 ? 1 : matched.length / entry.expectedPaths.length,
      degradations: result.degradations,
    });
  }
  return {
    version: 1 as const,
    sampleSize: cases.length,
    meanRecall: cases.length === 0 ? 1 : cases.reduce((sum, entry) => sum + entry.recall, 0) / cases.length,
    passed: cases.every((entry) => entry.recall === 1),
    cases,
  };
}
