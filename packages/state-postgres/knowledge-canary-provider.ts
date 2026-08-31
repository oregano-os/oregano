import type {
  KnowledgeAccessSubject,
  KnowledgeDocument,
  KnowledgeProvider,
  KnowledgeProviderHealth,
  KnowledgeSearchResult,
} from "../knowledge/contracts.ts";
import { LocalHashEmbeddingAdapter } from "../knowledge/embedding.ts";
import { createKnowledgeLiveShadowObservation } from "../knowledge/productization.ts";
import { KnowledgeRetrievalServiceV3 } from "../knowledge/retrieval-v3.ts";
import type { KnowledgeRetrievalUnitV3 } from "../knowledge/retrieval-unit.ts";
import { PostgresKnowledgeAccessAuditor, enrichPostgresKnowledgeSubject } from "./knowledge-access-store.ts";
import { PostgresKnowledgeProductizationStore } from "./knowledge-productization-store.ts";
import { PostgresKnowledgeRetrievalV3Store } from "./knowledge-retrieval-v3-store.ts";

export const COMPANYOS_KNOWLEDGE_RETRIEVAL_MODE_ENV = "COMPANYOS_KNOWLEDGE_RETRIEVAL_MODE" as const;
export const COMPANYOS_KNOWLEDGE_V3_PROJECTION_HASH_ENV = "COMPANYOS_KNOWLEDGE_V3_PROJECTION_HASH" as const;
export const COMPANYOS_KNOWLEDGE_V3_AGENT_IDS_ENV = "COMPANYOS_KNOWLEDGE_V3_AGENT_IDS" as const;

export type KnowledgeRetrievalRuntimeMode = "v2" | "v3-shadow" | "v3-canary";

export interface KnowledgeRetrievalRuntimeSelection {
  requestedMode: KnowledgeRetrievalRuntimeMode;
  effectiveMode: KnowledgeRetrievalRuntimeMode;
  selectedAgentId: string;
  allowedAgentIds: string[];
  projectionHash?: string;
  fallbackReason?: "invalid-mode" | "missing-projection" | "invalid-agent-allowlist" | "agent-not-allowlisted";
}

const agentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export function resolveKnowledgeRetrievalRuntimeSelection(input: {
  environment: Record<string, string | undefined>;
  selectedAgentId: string;
}): KnowledgeRetrievalRuntimeSelection {
  const selectedAgentId = input.selectedAgentId.trim();
  const rawMode = input.environment[COMPANYOS_KNOWLEDGE_RETRIEVAL_MODE_ENV]?.trim() ?? "v2";
  const validMode = new Set<KnowledgeRetrievalRuntimeMode>(["v2", "v3-shadow", "v3-canary"]);
  const requestedMode = validMode.has(rawMode as KnowledgeRetrievalRuntimeMode) ? rawMode as KnowledgeRetrievalRuntimeMode : "v2";
  const rawAgentIds = input.environment[COMPANYOS_KNOWLEDGE_V3_AGENT_IDS_ENV]?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  const allowedAgentIds = [...new Set(rawAgentIds)].sort();
  const projectionHash = input.environment[COMPANYOS_KNOWLEDGE_V3_PROJECTION_HASH_ENV]?.trim();
  const base = { requestedMode, selectedAgentId, allowedAgentIds };
  if (!validMode.has(rawMode as KnowledgeRetrievalRuntimeMode)) return { ...base, effectiveMode: "v2", fallbackReason: "invalid-mode" };
  if (requestedMode === "v2") return { ...base, effectiveMode: "v2" };
  if (!projectionHash || !/^[a-f0-9]{64}$/.test(projectionHash)) return { ...base, effectiveMode: "v2", fallbackReason: "missing-projection" };
  if (allowedAgentIds.length === 0 || allowedAgentIds.length > 50 || allowedAgentIds.some((value) => !agentIdPattern.test(value))) {
    return { ...base, effectiveMode: "v2", fallbackReason: "invalid-agent-allowlist" };
  }
  if (!allowedAgentIds.includes(selectedAgentId)) return { ...base, effectiveMode: "v2", projectionHash, fallbackReason: "agent-not-allowlisted" };
  return { ...base, effectiveMode: requestedMode, projectionHash };
}

const documentStatus = (unit: KnowledgeRetrievalUnitV3): KnowledgeDocument["status"] =>
  unit.state === "contested" ? "contested" : ["superseded", "expired"].includes(unit.state) ? "stale" : "current";

const documentType = (unit: KnowledgeRetrievalUnitV3): KnowledgeDocument["type"] => {
  if (unit.kind === "handbook-fragment") return "playbook";
  if (unit.kind === "page-fragment") return "concept";
  return "note";
};

const lineRange = (unit: Pick<KnowledgeRetrievalUnitV3, "evidenceLocator">): { startLine: number; endLine: number } =>
  unit.evidenceLocator?.kind === "line"
    ? { startLine: unit.evidenceLocator.start, endLine: unit.evidenceLocator.end }
    : { startLine: 1, endLine: 1 };

export function createPostgresKnowledgeProviderV3(input: {
  baseline: KnowledgeProvider;
  projectionHash: string;
  allowVerifiedProjection: boolean;
}): KnowledgeProvider {
  const store = new PostgresKnowledgeRetrievalV3Store({
    readProjectionHash: input.projectionHash,
    allowVerifiedReadProjection: input.allowVerifiedProjection,
  });
  const service = new KnowledgeRetrievalServiceV3({
    store,
    auditor: new PostgresKnowledgeAccessAuditor(),
    resolveSubject: enrichPostgresKnowledgeSubject,
    embeddingAdapter: new LocalHashEmbeddingAdapter(),
    embeddingPolicy: { mode: "local", allowExternalDataEgress: false },
  });

  return {
    stage: (bundle) => input.baseline.stage(bundle),
    verify: (snapshotHash) => input.baseline.verify(snapshotHash),
    activate: (snapshotHash) => input.baseline.activate(snapshotHash),
    activeSnapshot: () => input.baseline.activeSnapshot(),

    async search(request): Promise<KnowledgeSearchResult> {
      const result = await service.search(request);
      return {
        query: request.query.trim(),
        snapshotHash: result.projectionHash,
        hits: result.hits.map((hit) => {
          const lines = hit.evidenceLocator?.kind === "line"
            ? { startLine: hit.evidenceLocator.start, endLine: hit.evidenceLocator.end }
            : { startLine: 1, endLine: 1 };
          return {
            score: hit.score,
            ...(hit.ranks.lexical ? { lexicalRank: hit.ranks.lexical } : {}),
            ...(hit.ranks.semantic ? { semanticRank: hit.ranks.semantic } : {}),
            excerpt: hit.excerpt,
            signals: [
              ...(hit.state === "contested" ? ["contested" as const] : []),
              ...(["superseded", "expired"].includes(hit.state) ? ["stale" as const] : []),
            ],
            citation: {
              snapshotHash: result.projectionHash!,
              path: hit.unitId,
              fragmentId: hit.unitId,
              heading: hit.title,
              ...lines,
              digest: hit.contentDigest,
            },
          };
        }),
        gaps: result.gaps.includes("no-active-retrieval-projection") ? ["no-active-snapshot"] : result.hits.length === 0 ? ["no-results"] : [],
        mode: result.mode,
        degradations: [...new Set(result.degradations.map((value): KnowledgeSearchResult["degradations"][number] =>
          value === "embedding-disabled" ? "embedding-disabled" : "embedding-unavailable"))],
      };
    },

    async get(request) {
      const unit = await service.get({ unitId: request.path, subject: request.subject });
      if (!unit) return undefined;
      const lines = lineRange(unit);
      const document: KnowledgeDocument = {
        path: unit.unitId,
        type: documentType(unit),
        description: `${unit.authorityLayer} ${unit.kind} from ${unit.sourceIds.join(", ")}.`,
        status: documentStatus(unit),
        title: unit.title,
        body: unit.text,
        digest: unit.contentDigest,
        accessPolicyId: unit.accessPolicyId,
        links: [...unit.graphNeighbors],
        fragments: [{
          fragmentId: unit.unitId,
          path: unit.unitId,
          heading: unit.title,
          ...lines,
          body: unit.text,
          digest: unit.contentDigest,
          accessPolicyId: unit.accessPolicyId,
        }],
      };
      return { snapshotHash: input.projectionHash, document };
    },

    async traverse(request) {
      const direction = request.direction ?? "both";
      const maxDepth = Math.max(0, Math.min(request.maxDepth ?? 2, 5));
      const maxNodes = Math.max(1, Math.min(request.maxNodes ?? 50, 100));
      const start = await service.get({ unitId: request.path, subject: request.subject });
      if (!start) return { snapshotHash: input.projectionHash, startPath: request.path, direction, paths: [], truncated: false, gaps: ["unknown-start-path"] };
      const queue: Array<{ unit: KnowledgeRetrievalUnitV3; depth: number; via?: string }> = [{ unit: start, depth: 0 }];
      const seen = new Set([start.unitId]);
      let truncated = false;
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const current = queue[cursor]!;
        if (current.depth >= maxDepth) continue;
        for (const neighborId of current.unit.graphNeighbors) {
          if (seen.has(neighborId)) continue;
          if (queue.length >= maxNodes) { truncated = true; break; }
          const neighbor = await service.get({ unitId: neighborId, subject: request.subject });
          if (!neighbor) continue;
          seen.add(neighborId);
          queue.push({ unit: neighbor, depth: current.depth + 1, via: current.unit.unitId });
        }
        if (truncated) break;
      }
      return {
        snapshotHash: input.projectionHash,
        startPath: request.path,
        direction,
        paths: queue.map((entry) => ({ path: entry.unit.unitId, depth: entry.depth, ...(entry.via ? { via: entry.via } : {}) })),
        truncated,
        gaps: [],
      };
    },

    async health(): Promise<KnowledgeProviderHealth> {
      const projection = await store.activeProjection();
      return {
        ok: Boolean(projection),
        activeSnapshotHash: projection?.projectionHash ?? null,
        lexical: true,
        vectorIndex: Boolean(projection?.embeddingProfile),
        embeddingAdapter: projection?.embeddingProfile ? `${projection.embeddingProfile.adapterId}@${projection.embeddingProfile.adapterVersion}` : null,
        ...(!projection ? { degradation: "retrieval-v3-projection-unavailable" } : !projection.embeddingProfile ? { degradation: "embedding-disabled" } : {}),
      };
    },
  };
}

const authorizationContext = (subject?: KnowledgeAccessSubject) => ({
  principalId: subject?.principalId ?? "unresolved",
  principalType: subject?.principalType ?? "unresolved",
  status: subject?.status ?? "unresolved",
  groupIds: [...(subject?.groupIds ?? [])].sort(),
});

export function createPostgresKnowledgeCanaryProvider(input: {
  baseline: KnowledgeProvider;
  selection: KnowledgeRetrievalRuntimeSelection;
  now?: () => string;
  evidenceStore?: Pick<PostgresKnowledgeProductizationStore, "recordQualification">;
  candidate?: KnowledgeProvider;
}): KnowledgeProvider {
  if (input.selection.effectiveMode === "v2" || !input.selection.projectionHash) return input.baseline;
  const candidate = input.candidate ?? createPostgresKnowledgeProviderV3({
    baseline: input.baseline,
    projectionHash: input.selection.projectionHash,
    allowVerifiedProjection: input.selection.effectiveMode === "v3-shadow",
  });
  if (input.selection.effectiveMode === "v3-canary") {
    return {
      ...candidate,
      async search(request): Promise<KnowledgeSearchResult> {
        try {
          const result = await candidate.search(request);
          if (!result.snapshotHash) throw new Error("Retrieval V3 canary projection is unavailable.");
          return result;
        } catch {
          const fallback = await input.baseline.search(request);
          const degradations: KnowledgeSearchResult["degradations"] = [...new Set([...fallback.degradations, "retrieval-v3-canary-fallback" as const])];
          return { ...fallback, degradations };
        }
      },
      async get(request) {
        try { return await candidate.get(request) ?? await input.baseline.get(request); }
        catch { return input.baseline.get(request); }
      },
      async traverse(request) {
        try { return await candidate.traverse(request); }
        catch { return input.baseline.traverse(request); }
      },
    };
  }

  const evidenceStore = input.evidenceStore ?? new PostgresKnowledgeProductizationStore();
  return {
    ...input.baseline,
    async search(request) {
      const [baselineResult, candidateAttempt] = await Promise.all([
        input.baseline.search(request),
        candidate.search(request).then((value) => ({ value })).catch((error: unknown) => ({ error })),
      ]);
      const candidateResult = "value" in candidateAttempt ? candidateAttempt.value : undefined;
      const receipt = createKnowledgeLiveShadowObservation({
        query: request.query,
        authorizationContext: authorizationContext(request.subject),
        baselineSnapshotHash: baselineResult.snapshotHash,
        candidateProjectionHash: candidateResult?.snapshotHash ?? input.selection.projectionHash ?? null,
        baselineContentDigests: baselineResult.hits.map((hit) => hit.citation.digest),
        candidateContentDigests: candidateResult?.hits.map((hit) => hit.citation.digest) ?? [],
        ...("error" in candidateAttempt ? { candidateFailure: candidateAttempt.error } : {}),
        observedAt: input.now?.() ?? new Date().toISOString(),
      });
      await evidenceStore.recordQualification(receipt).catch(() => undefined);
      return baselineResult;
    },
  };
}
