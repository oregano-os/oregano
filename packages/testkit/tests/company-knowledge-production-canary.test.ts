import assert from "node:assert/strict";
import { test } from "node:test";
import type { KnowledgeProvider, KnowledgeSearchResult } from "../../knowledge/contracts.ts";
import type { KnowledgeLiveShadowObservationReceipt } from "../../knowledge/productization.ts";
import { sha256 } from "../../runtime/canonical.ts";
import {
  COMPANYOS_KNOWLEDGE_RETRIEVAL_MODE_ENV,
  COMPANYOS_KNOWLEDGE_V3_AGENT_IDS_ENV,
  COMPANYOS_KNOWLEDGE_V3_PROJECTION_HASH_ENV,
  createPostgresKnowledgeCanaryProvider,
  resolveKnowledgeRetrievalRuntimeSelection,
} from "../../state-postgres/knowledge-canary-provider.ts";

const now = "2026-08-30T12:00:00.000Z";
const projectionHash = sha256("projection");
const baselineDigest = sha256("baseline result");
const candidateDigest = sha256("candidate result");

const result = (snapshotHash: string, digest: string, excerpt: string): KnowledgeSearchResult => ({
  query: "company strategy",
  snapshotHash,
  hits: [{
    score: 1,
    excerpt,
    signals: [],
    citation: { snapshotHash, path: `unit:${digest.slice(0, 8)}`, fragmentId: `fragment:${digest.slice(0, 8)}`, heading: "Strategy", startLine: 1, endLine: 1, digest },
  }],
  gaps: [],
  mode: "lexical",
  degradations: [],
});

const provider = (search: KnowledgeProvider["search"]): KnowledgeProvider => ({
  stage: async () => { throw new Error("not used"); },
  verify: async () => { throw new Error("not used"); },
  activate: async () => { throw new Error("not used"); },
  activeSnapshot: async () => undefined,
  search,
  get: async () => undefined,
  traverse: async ({ path, direction }) => ({ snapshotHash: null, startPath: path, direction: direction ?? "both", paths: [], truncated: false, gaps: ["no-active-snapshot"] }),
  health: async () => ({ ok: true, activeSnapshotHash: null, lexical: true, vectorIndex: false, embeddingAdapter: null }),
});

test("Retrieval runtime selection defaults and fails closed to V2", () => {
  const defaulted = resolveKnowledgeRetrievalRuntimeSelection({ environment: {}, selectedAgentId: "oregano" });
  assert.equal(defaulted.effectiveMode, "v2");
  const missingProjection = resolveKnowledgeRetrievalRuntimeSelection({
    environment: { [COMPANYOS_KNOWLEDGE_RETRIEVAL_MODE_ENV]: "v3-canary", [COMPANYOS_KNOWLEDGE_V3_AGENT_IDS_ENV]: "oregano" },
    selectedAgentId: "oregano",
  });
  assert.equal(missingProjection.effectiveMode, "v2");
  assert.equal(missingProjection.fallbackReason, "missing-projection");
  const notAllowed = resolveKnowledgeRetrievalRuntimeSelection({
    environment: {
      [COMPANYOS_KNOWLEDGE_RETRIEVAL_MODE_ENV]: "v3-canary",
      [COMPANYOS_KNOWLEDGE_V3_AGENT_IDS_ENV]: "another-agent",
      [COMPANYOS_KNOWLEDGE_V3_PROJECTION_HASH_ENV]: projectionHash,
    },
    selectedAgentId: "oregano",
  });
  assert.equal(notAllowed.effectiveMode, "v2");
  assert.equal(notAllowed.fallbackReason, "agent-not-allowlisted");
});

test("Shadow mode executes V3, persists payload-free evidence, and returns the exact V2 result", async () => {
  const baselineResult = result(sha256("baseline"), baselineDigest, "The current strategy is enterprise DACH.");
  const candidateResult = result(projectionHash, candidateDigest, "A different candidate excerpt must never be served in shadow mode.");
  const baseline = provider(async () => structuredClone(baselineResult));
  const candidate = provider(async () => structuredClone(candidateResult));
  const observations: KnowledgeLiveShadowObservationReceipt[] = [];
  const selection = resolveKnowledgeRetrievalRuntimeSelection({
    environment: {
      [COMPANYOS_KNOWLEDGE_RETRIEVAL_MODE_ENV]: "v3-shadow",
      [COMPANYOS_KNOWLEDGE_V3_AGENT_IDS_ENV]: "oregano",
      [COMPANYOS_KNOWLEDGE_V3_PROJECTION_HASH_ENV]: projectionHash,
    },
    selectedAgentId: "oregano",
  });
  const shadow = createPostgresKnowledgeCanaryProvider({
    baseline,
    candidate,
    selection,
    now: () => now,
    evidenceStore: {
      recordQualification: async (receipt: unknown) => {
        if (receipt && typeof receipt === "object" && "mode" in receipt) observations.push(receipt as KnowledgeLiveShadowObservationReceipt);
        return "inserted" as const;
      },
    },
  });
  const served = await shadow.search({ query: "company strategy", subject: { principalId: "person:peter", principalType: "human", status: "active", groupIds: ["company:active"] } });
  assert.deepEqual(served, baselineResult);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.mode, "v2-served-v3-shadowed");
  assert.equal(observations[0]?.comparison.candidateFailed, false);
  assert.doesNotMatch(JSON.stringify(observations[0]), /company strategy|enterprise DACH|different candidate excerpt/i);
});

test("Canary mode automatically serves V2 when the candidate fails", async () => {
  const baselineResult = result(sha256("baseline"), baselineDigest, "Available V2 answer.");
  const baseline = provider(async () => structuredClone(baselineResult));
  const candidate = provider(async () => { throw new Error("candidate unavailable"); });
  const selection = resolveKnowledgeRetrievalRuntimeSelection({
    environment: {
      [COMPANYOS_KNOWLEDGE_RETRIEVAL_MODE_ENV]: "v3-canary",
      [COMPANYOS_KNOWLEDGE_V3_AGENT_IDS_ENV]: "oregano",
      [COMPANYOS_KNOWLEDGE_V3_PROJECTION_HASH_ENV]: projectionHash,
    },
    selectedAgentId: "oregano",
  });
  const canary = createPostgresKnowledgeCanaryProvider({ baseline, candidate, selection });
  const served = await canary.search({ query: "company strategy" });
  assert.equal(served.snapshotHash, baselineResult.snapshotHash);
  assert.ok(served.degradations.includes("retrieval-v3-canary-fallback"));
});
