import type { CapabilityCallContext, CapabilityResult, Connector } from "../capabilities/contracts.ts";
import type { KnowledgeProvider } from "../knowledge/contracts.ts";

export class KnowledgeProviderConnector implements Connector {
  readonly id = "oregano/knowledge-postgres";
  readonly version = "3.0.0";
  readonly capabilities = ["knowledge.search", "knowledge.get", "knowledge.traverse"] as const;

  readonly provider: KnowledgeProvider;

  constructor(provider: KnowledgeProvider) {
    this.provider = provider;
  }

  async invoke(capability: string, input: unknown, context: CapabilityCallContext): Promise<CapabilityResult> {
    if (capability === "knowledge.search") {
      const request = input as { query: string; limit?: number };
      const result = await this.provider.search({ ...request, subject: context.subject });
      const output = {
        query: result.query,
        snapshot_hash: result.snapshotHash,
        hits: result.hits.map((hit) => ({
          score: hit.score,
          excerpt: hit.excerpt,
          signals: hit.signals,
          ...(hit.lexicalRank ? { lexical_rank: hit.lexicalRank } : {}),
          ...(hit.semanticRank ? { semantic_rank: hit.semanticRank } : {}),
          citation: {
            snapshot_hash: hit.citation.snapshotHash,
            path: hit.citation.path,
            fragment_id: hit.citation.fragmentId,
            heading: hit.citation.heading,
            start_line: hit.citation.startLine,
            end_line: hit.citation.endLine,
            digest: hit.citation.digest,
          },
        })),
        gaps: result.gaps,
        mode: result.mode,
        degradations: result.degradations,
      };
      return { output, evidence: { snapshot_hash: result.snapshotHash, result_count: result.hits.length } };
    }
    if (capability === "knowledge.get") {
      const request = input as { path: string };
      const result = await this.provider.get({ ...request, subject: context.subject });
      return result
        ? { output: { found: true, snapshot_hash: result.snapshotHash, document: result.document }, evidence: { snapshot_hash: result.snapshotHash, path: request.path, found: true } }
        : { output: { found: false }, evidence: { snapshot_hash: null, path: request.path, found: false } };
    }
    if (capability === "knowledge.traverse") {
      const request = input as { path: string; direction?: "outbound" | "inbound" | "both"; max_depth?: number; max_nodes?: number };
      const result = await this.provider.traverse({ path: request.path, direction: request.direction, maxDepth: request.max_depth, maxNodes: request.max_nodes, subject: context.subject });
      const output = {
        snapshot_hash: result.snapshotHash,
        start_path: result.startPath,
        direction: result.direction,
        paths: result.paths,
        truncated: result.truncated,
        gaps: result.gaps,
      };
      return { output, evidence: { snapshot_hash: result.snapshotHash, start_path: result.startPath, node_count: result.paths.length, truncated: result.truncated } };
    }
    throw new Error(`Knowledge Provider does not implement '${capability}'.`);
  }
}
