import { sha256 } from "../runtime/canonical.ts";
import { KnowledgeAuthorizer } from "./access-control.ts";
import type {
  KnowledgeAccessAuditor,
  KnowledgeAccessPolicy,
  KnowledgeAccessSubject,
  KnowledgeCitation,
  KnowledgeDocument,
  KnowledgeProvider,
  KnowledgeSearchHit,
  KnowledgeSearchResult,
} from "./contracts.ts";
import {
  KnowledgeRetrievalServiceV2,
  type KnowledgeDeltaV2,
  type KnowledgeRetrievalRecordV2,
} from "./retrieval-v2.ts";

export interface BrainKnowledgeProjection {
  projectionHash: string;
  policies: KnowledgeAccessPolicy[];
  records: KnowledgeRetrievalRecordV2[];
  citations: Record<string, Omit<KnowledgeCitation, "snapshotHash">>;
  edges: Array<{ from: string; to: string }>;
  deltas: KnowledgeDeltaV2[];
}

export interface BrainKnowledgeProjectionStore {
  load(): Promise<BrainKnowledgeProjection>;
  enrichSubject?(subject?: KnowledgeAccessSubject): Promise<KnowledgeAccessSubject | undefined>;
}

const rrf = (rank: number): number => 1 / (60 + rank);
const statusFor = (record: KnowledgeRetrievalRecordV2): KnowledgeDocument["status"] =>
  record.label === "contested" ? "contested" : ["expired", "superseded"].includes(record.label) ? "stale" : "current";

const resultHash = (base: string | null, projection: BrainKnowledgeProjection): string | null => {
  if (projection.records.length === 0) return base;
  if (!base) return projection.projectionHash;
  return sha256({ handbookSnapshotHash: base, companyKnowledgeProjectionHash: projection.projectionHash });
};

export function createUnifiedKnowledgeProvider(input: {
  handbook: KnowledgeProvider;
  brain: BrainKnowledgeProjectionStore;
  accessAuditor?: KnowledgeAccessAuditor;
}): KnowledgeProvider {
  const load = async (subject?: KnowledgeAccessSubject) => {
    const projection = await input.brain.load();
    const enriched = input.brain.enrichSubject ? await input.brain.enrichSubject(subject) : subject;
    const authorizer = new KnowledgeAuthorizer(projection.policies, input.accessAuditor);
    const service = new KnowledgeRetrievalServiceV2({
      records: projection.records,
      deltas: projection.deltas,
      authorization: {
        canRead: async ({ policyId, objectId }) => authorizer.authorize({
          subject: enriched,
          permission: "read",
          policyIds: [policyId],
          objectType: "document",
          objectId,
        }),
      },
    });
    return { projection, enriched, service };
  };

  const citationFor = (projection: BrainKnowledgeProjection, identity: string): KnowledgeCitation | undefined => {
    const citation = projection.citations[identity];
    return citation ? { snapshotHash: projection.projectionHash, ...citation } : undefined;
  };

  return {
    stage: (bundle) => input.handbook.stage(bundle),
    verify: (snapshotHash) => input.handbook.verify(snapshotHash),
    activate: (snapshotHash) => input.handbook.activate(snapshotHash),
    activeSnapshot: () => input.handbook.activeSnapshot(),

    async search(request): Promise<KnowledgeSearchResult> {
      const [baseAttempt, loaded] = await Promise.all([
        input.handbook.search(request).then((value) => ({ value })).catch(() => ({ value: undefined })),
        load(request.subject),
      ]);
      const base: KnowledgeSearchResult = baseAttempt.value ?? {
        query: request.query.trim(),
        snapshotHash: null,
        hits: [],
        gaps: ["no-active-snapshot"],
        mode: "lexical",
        degradations: ["handbook-unavailable"],
      };
      const brain = await loaded.service.search({ query: request.query, limit: request.limit });
      const ranked = new Map<string, KnowledgeSearchHit>();
      base.hits.forEach((hit, index) => ranked.set(`handbook:${hit.citation.path}`, { ...hit, score: rrf(index + 1) }));
      brain.hits.forEach((hit, index) => {
        const citation = citationFor(loaded.projection, hit.identity);
        if (!citation) return;
        ranked.set(`brain:${hit.identity}`, {
          score: rrf(index + 1),
          ...(hit.ranks.lexical ? { lexicalRank: hit.ranks.lexical } : {}),
          ...(hit.ranks.semantic ? { semanticRank: hit.ranks.semantic } : {}),
          excerpt: hit.excerpt,
          signals: [
            ...(hit.label === "contested" ? ["contested" as const] : []),
            ...(["expired", "superseded"].includes(hit.label) ? ["stale" as const] : []),
          ],
          citation,
        });
      });
      const limit = Math.max(1, Math.min(request.limit ?? 5, 20));
      const hits = [...ranked.values()]
        .sort((left, right) => right.score - left.score || left.citation.path.localeCompare(right.citation.path))
        .slice(0, limit);
      const snapshotHash = resultHash(base.snapshotHash, loaded.projection);
      const degradations = [...new Set([
        ...base.degradations,
        ...(request.mode === "hybrid" && loaded.projection.records.length > 0 ? ["embedding-disabled" as const] : []),
      ])];
      return {
        query: request.query.trim(),
        snapshotHash,
        hits,
        gaps: hits.length === 0 ? (snapshotHash ? ["no-results"] : ["no-active-snapshot"]) : [],
        mode: base.mode === "hybrid" ? "hybrid" : "lexical",
        degradations,
      };
    },

    async get(request) {
      const loaded = await load(request.subject);
      const identity = Object.entries(loaded.projection.citations).find(([, citation]) => citation.path === request.path)?.[0];
      if (!identity) return input.handbook.get(request).catch(() => undefined);
      const record = await loaded.service.get({ identity, subject: loaded.enriched });
      if (!record) return undefined;
      const citation = citationFor(loaded.projection, identity)!;
      const links = record.graphNeighbors
        .map((neighbor) => loaded.projection.citations[neighbor]?.path)
        .filter((path): path is string => Boolean(path));
      const document: KnowledgeDocument = {
        path: citation.path,
        type: "note",
        description: `${record.label} Company Knowledge from ${record.sourceIds.join(", ") || "an internal source"}.`,
        status: statusFor(record),
        title: record.title,
        body: record.text,
        digest: record.contentDigest,
        accessPolicyId: record.accessPolicyId,
        links: [...new Set(links)].sort(),
        fragments: [{
          fragmentId: citation.fragmentId,
          path: citation.path,
          heading: citation.heading,
          startLine: citation.startLine,
          endLine: citation.endLine,
          body: record.text,
          digest: citation.digest,
          accessPolicyId: record.accessPolicyId,
        }],
      };
      return { snapshotHash: loaded.projection.projectionHash, document };
    },

    async traverse(request) {
      const loaded = await load(request.subject);
      const identity = Object.entries(loaded.projection.citations).find(([, citation]) => citation.path === request.path)?.[0];
      if (!identity) return input.handbook.traverse(request).catch(() => ({
        snapshotHash: null,
        startPath: request.path,
        direction: request.direction ?? "both",
        paths: [],
        truncated: false,
        gaps: ["no-active-snapshot"],
      }));
      const maxDepth = Math.max(0, Math.min(request.maxDepth ?? 2, 5));
      const maxNodes = Math.max(1, Math.min(request.maxNodes ?? 50, 100));
      const authorized = await loaded.service.traverse({ identity, subject: loaded.enriched, maxDepth: 5, maxNodes: 200 });
      const allowed = new Set(authorized.map((entry) => entry.identity));
      if (!allowed.has(identity)) return { snapshotHash: loaded.projection.projectionHash, startPath: request.path, direction: request.direction ?? "both", paths: [], truncated: false, gaps: ["unknown-start-path"] };
      const direction = request.direction ?? "both";
      const adjacency = new Map<string, Set<string>>();
      const add = (from: string, to: string) => {
        const values = adjacency.get(from) ?? new Set<string>();
        values.add(to);
        adjacency.set(from, values);
      };
      for (const edge of loaded.projection.edges) {
        if (direction !== "inbound") add(edge.from, edge.to);
        if (direction !== "outbound") add(edge.to, edge.from);
      }
      const queue: Array<{ identity: string; depth: number; via?: string }> = [{ identity, depth: 0 }];
      const seen = new Set([identity]);
      let truncated = false;
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const current = queue[cursor]!;
        if (current.depth >= maxDepth) continue;
        for (const neighbor of [...(adjacency.get(current.identity) ?? [])].sort()) {
          if (!allowed.has(neighbor) || seen.has(neighbor)) continue;
          if (queue.length >= maxNodes) { truncated = true; break; }
          seen.add(neighbor);
          queue.push({ identity: neighbor, depth: current.depth + 1, via: current.identity });
        }
        if (truncated) break;
      }
      return {
        snapshotHash: loaded.projection.projectionHash,
        startPath: request.path,
        direction,
        paths: queue.map((entry) => ({
          path: loaded.projection.citations[entry.identity]?.path ?? entry.identity,
          depth: entry.depth,
          ...(entry.via ? { via: loaded.projection.citations[entry.via]?.path ?? entry.via } : {}),
        })),
        truncated,
        gaps: [],
      };
    },

    async health() {
      const [base, projection] = await Promise.all([input.handbook.health(), input.brain.load()]);
      if (projection.records.length === 0) return base;
      return {
        ok: true,
        activeSnapshotHash: resultHash(base.activeSnapshotHash, projection),
        lexical: true,
        vectorIndex: base.vectorIndex,
        embeddingAdapter: base.embeddingAdapter,
        ...(!base.vectorIndex ? { degradation: base.degradation ?? "embedding-disabled" } : {}),
      };
    },
  };
}
