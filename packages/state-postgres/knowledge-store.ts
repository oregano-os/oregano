import { neon } from "@neondatabase/serverless";
import type {
  KnowledgeBundle,
  KnowledgeDocument,
  KnowledgeGetResult,
  KnowledgeProvider,
  KnowledgeSearchResult,
  KnowledgeSnapshot,
  ReviewCandidate,
  ReviewDecision,
  EmbeddingAdapter,
  EmbeddingPolicy,
  KnowledgeSearchHit,
  KnowledgeAccessSubject,
  KnowledgeAccessPolicy,
} from "../knowledge/contracts.ts";
import { ensureCompanyKnowledgeSchema } from "./knowledge-migrate.ts";
import { postgresTimestampToIso } from "./postgres-values.ts";
import { assertKnowledgeBundleIntegrity } from "../knowledge/okf.ts";
import { authorizeEmbeddingAdapter, LocalHashEmbeddingAdapter } from "../knowledge/embedding.ts";
import { traverseKnowledgeGraph } from "../knowledge/graph.ts";
import { COMPANY_KNOWLEDGE_POLICY, filterAuthorizedKnowledgeBundle, KnowledgeAuthorizer, QUARANTINE_POLICY } from "../knowledge/access-control.ts";
import { PostgresKnowledgeAccessAuditor, enrichPostgresKnowledgeSubject } from "./knowledge-access-store.ts";
import { sha256 } from "../runtime/canonical.ts";

const connection = () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — Company Knowledge uses the existing Company Instance Neon database.");
  return neon(url);
};

const mapSnapshot = (row: Record<string, unknown>): KnowledgeSnapshot => ({
  snapshotHash: String(row.snapshot_hash),
  status: row.status as KnowledgeSnapshot["status"],
  bundle: row.bundle as unknown as KnowledgeBundle,
  stagedAt: postgresTimestampToIso(row.staged_at),
  verifiedAt: row.verified_at ? postgresTimestampToIso(row.verified_at) : undefined,
  activatedAt: row.activated_at ? postgresTimestampToIso(row.activated_at) : undefined,
});

const vectorLiteral = (vector: readonly number[]) => `[${vector.map((value) => Number.isFinite(value) ? value.toFixed(10) : "0").join(",")}]`;

type KnowledgeActivationSql = ReturnType<typeof connection>;

export async function activateVerifiedKnowledgeSnapshot(
  sql: KnowledgeActivationSql,
  snapshotHash: string,
): Promise<Record<string, unknown> | undefined> {
  const results = await sql.transaction((transaction) => [
    transaction`update companyos_knowledge.snapshots set status = 'retired'
      where status = 'active' and snapshot_hash <> ${snapshotHash}
        and exists (
          select 1 from companyos_knowledge.snapshots
          where snapshot_hash = ${snapshotHash} and verified_at is not null
        )
      returning snapshot_hash`,
    transaction`update companyos_knowledge.snapshots set status = 'active', activated_at = now()
      where snapshot_hash = ${snapshotHash} and verified_at is not null
      returning *`,
  ], { isolationLevel: "Serializable" });
  return results[1]?.[0];
}

export function createPostgresKnowledgeProvider(options: { embeddingAdapter?: EmbeddingAdapter; embeddingPolicy?: EmbeddingPolicy } = {}): KnowledgeProvider {
  const policy = options.embeddingPolicy ?? { mode: "local", allowExternalDataEgress: false };
  const embedding = authorizeEmbeddingAdapter(options.embeddingAdapter ?? new LocalHashEmbeddingAdapter(), policy);
  return {
    async stage(bundle: KnowledgeBundle): Promise<KnowledgeSnapshot> {
      assertKnowledgeBundleIntegrity(bundle);
      const features = await ensureCompanyKnowledgeSchema();
      const sql = connection();
      for (const accessPolicy of bundle.accessPolicies) {
        await sql`insert into companyos_knowledge.acl_policies
          (policy_id, policy_version, visibility, parent_policy_id, source_root, status, definition, created_by)
          values (${accessPolicy.policyId}, ${accessPolicy.policyVersion}, ${accessPolicy.visibility},
            ${accessPolicy.parentPolicyId ?? null}, ${accessPolicy.sourceRoot}, ${accessPolicy.status},
            ${JSON.stringify({ entries: accessPolicy.entries })}, 'system:knowledge-bundle')
          on conflict (policy_id) do nothing`;
        const storedPolicies = await sql`select policy_version, visibility, parent_policy_id, source_root, status
          from companyos_knowledge.acl_policies where policy_id = ${accessPolicy.policyId} limit 1`;
        const storedPolicy = storedPolicies[0];
        if (!storedPolicy || Number(storedPolicy.policy_version) !== accessPolicy.policyVersion || storedPolicy.visibility !== accessPolicy.visibility ||
          (storedPolicy.parent_policy_id === null ? undefined : String(storedPolicy.parent_policy_id)) !== accessPolicy.parentPolicyId ||
          Boolean(storedPolicy.source_root) !== accessPolicy.sourceRoot || storedPolicy.status !== accessPolicy.status) {
          throw new Error(`Knowledge access policy '${accessPolicy.policyId}' conflicts with its immutable stored identity.`);
        }
        for (const entry of accessPolicy.entries) {
          await sql`insert into companyos_knowledge.acl_entries
            (entry_id, policy_id, subject_kind, subject_id, permission, effect, evidence)
            values (${`acl:${sha256({ policyId: accessPolicy.policyId, ...entry })}`}, ${accessPolicy.policyId},
              ${entry.subjectKind}, ${entry.subjectId}, ${entry.permission}, ${entry.effect},
              ${JSON.stringify({ source: "knowledge-bundle", policy_version: accessPolicy.policyVersion })})
            on conflict (entry_id) do nothing`;
        }
      }
      await sql`insert into companyos_knowledge.snapshots (
        snapshot_hash, status, workspace_commit, okf_version, policy_hash,
        document_count, fragment_count, bundle)
        values (${bundle.bundleHash}, 'staged', ${bundle.workspaceCommit}, ${bundle.okfVersion},
          ${bundle.policyHash}, ${bundle.documentCount}, ${bundle.fragmentCount}, ${JSON.stringify(bundle)})
        on conflict (snapshot_hash) do nothing`;
      for (const document of bundle.documents) {
        await sql`insert into companyos_knowledge.documents (
          snapshot_hash, path, type, description, title, knowledge_status, valid_until, digest, document, access_policy_id)
          values (${bundle.bundleHash}, ${document.path}, ${document.type}, ${document.description},
            ${document.title}, ${document.status}, ${document.validUntil ?? null}, ${document.digest}, ${JSON.stringify(document)}, ${document.accessPolicyId})
          on conflict (snapshot_hash, path) do nothing`;
        for (const fragment of document.fragments) {
          await sql`insert into companyos_knowledge.fragments (
            snapshot_hash, fragment_id, path, heading, start_line, end_line, digest, body, access_policy_id)
            values (${bundle.bundleHash}, ${fragment.fragmentId}, ${document.path}, ${fragment.heading},
              ${fragment.startLine}, ${fragment.endLine}, ${fragment.digest}, ${fragment.body}, ${fragment.accessPolicyId})
            on conflict (snapshot_hash, fragment_id) do nothing`;
        }
      }
      for (const edge of bundle.edges) {
        await sql`insert into companyos_knowledge.graph_edges (snapshot_hash, from_path, to_path)
          values (${bundle.bundleHash}, ${edge.from}, ${edge.to}) on conflict do nothing`;
      }
      if (features.vector && embedding) {
        try {
          const fragments = bundle.documents.flatMap((document) => document.fragments.map((fragment) => ({ document, fragment })));
          const vectors = await embedding.embed(fragments.map(({ document, fragment }) => `${document.title}\n${document.description}\n${fragment.body}`));
          if (vectors.length !== fragments.length || vectors.some((vector) => vector.length !== embedding.dimensions)) throw new Error("Embedding adapter returned an invalid vector batch.");
          for (let index = 0; index < fragments.length; index += 1) {
            const item = fragments[index];
            const literal = vectorLiteral(vectors[index]);
            await sql`insert into companyos_knowledge.fragment_embeddings (
                snapshot_hash, fragment_id, adapter_id, adapter_version, embedding)
              values (${bundle.bundleHash}, ${item.fragment.fragmentId}, ${embedding.id}, ${embedding.version}, ${literal}::vector)
              on conflict (snapshot_hash, fragment_id, adapter_id, adapter_version) do nothing`;
          }
          await sql`insert into companyos_knowledge.index_runs (snapshot_hash, status, evidence, completed_at)
            values (${bundle.bundleHash}, 'verified', ${JSON.stringify({ component: "embedding", adapter_id: embedding.id, vectors: fragments.length })}, now())`;
        } catch (error) {
          await sql`insert into companyos_knowledge.index_runs (snapshot_hash, status, evidence, completed_at)
            values (${bundle.bundleHash}, 'failed', ${JSON.stringify({ component: "embedding", lexical_available: true, reason: error instanceof Error ? error.message : "Unknown embedding failure." })}, now())`;
        }
      }
      const rows = await sql`select * from companyos_knowledge.snapshots where snapshot_hash = ${bundle.bundleHash}`;
      return mapSnapshot(rows[0] as Record<string, unknown>);
    },

    async verify(snapshotHash: string): Promise<KnowledgeSnapshot> {
      await ensureCompanyKnowledgeSchema();
      const sql = connection();
      const rows = await sql`with counts as (
          select s.snapshot_hash, s.document_count, s.fragment_count,
            (select count(*) from companyos_knowledge.documents d where d.snapshot_hash = s.snapshot_hash) as actual_documents,
            (select count(*) from companyos_knowledge.fragments f where f.snapshot_hash = s.snapshot_hash) as actual_fragments
          from companyos_knowledge.snapshots s where s.snapshot_hash = ${snapshotHash}
        ), verified as (
          update companyos_knowledge.snapshots s set
            status = case when s.status = 'active' then 'active' else 'verified' end,
            verified_at = coalesce(s.verified_at, now())
          from counts c where s.snapshot_hash = c.snapshot_hash
            and c.document_count = c.actual_documents and c.fragment_count = c.actual_fragments
          returning s.*
        ) select * from verified`;
      if (!rows[0]) throw new Error(`Knowledge snapshot '${snapshotHash}' is missing or failed count verification.`);
      await sql`insert into companyos_knowledge.index_runs (snapshot_hash, status, evidence, completed_at)
        values (${snapshotHash}, 'verified', ${JSON.stringify({ count_check: true })}, now())`;
      return mapSnapshot(rows[0] as Record<string, unknown>);
    },

    async activate(snapshotHash: string): Promise<KnowledgeSnapshot> {
      await ensureCompanyKnowledgeSchema();
      const sql = connection();
      const row = await activateVerifiedKnowledgeSnapshot(sql, snapshotHash);
      if (!row) throw new Error(`Knowledge snapshot '${snapshotHash}' must exist and be verified before activation.`);
      return mapSnapshot(row);
    },

    async activeSnapshot(): Promise<KnowledgeSnapshot | undefined> {
      await ensureCompanyKnowledgeSchema();
      const rows = await connection()`select * from companyos_knowledge.snapshots where status = 'active' limit 1`;
      return rows[0] ? mapSnapshot(rows[0] as Record<string, unknown>) : undefined;
    },

    async search(input: { query: string; limit?: number; mode?: "lexical" | "hybrid"; subject?: KnowledgeAccessSubject }): Promise<KnowledgeSearchResult> {
      const features = await ensureCompanyKnowledgeSchema();
      const query = input.query.trim();
      const limit = Math.max(1, Math.min(input.limit ?? 5, 20));
      const requestedMode = input.mode ?? "hybrid";
      const sql = connection();
      const active = await sql`select snapshot_hash, bundle from companyos_knowledge.snapshots where status = 'active' limit 1`;
      if (!active[0]) return { query, snapshotHash: null, hits: [], gaps: ["no-active-snapshot"], mode: "lexical", degradations: [] };
      const snapshotHash = String(active[0].snapshot_hash);
      const bundle = active[0].bundle as unknown as KnowledgeBundle;
      const subject = await enrichPostgresKnowledgeSubject(input.subject);
      const authorizedBundle = await filterAuthorizedKnowledgeBundle(bundle, subject, new KnowledgeAuthorizer(bundle.accessPolicies, new PostgresKnowledgeAccessAuditor()));
      const authorizedPolicyIds = [...new Set(authorizedBundle.documents.map((document) => document.accessPolicyId))];
      if (!query) return { query, snapshotHash, hits: [], gaps: ["no-results"], mode: requestedMode === "hybrid" && features.vector && embedding ? "hybrid" : "lexical", degradations: [] };
      if (authorizedPolicyIds.length === 0) return { query, snapshotHash, hits: [], gaps: ["no-results"], mode: "lexical", degradations: requestedMode === "hybrid" && !embedding ? ["embedding-disabled"] : [] };
      const candidateLimit = Math.min(limit * 8, 160);
      const rows = await sql`select f.fragment_id, f.path, f.heading, f.start_line, f.end_line, f.digest, f.body,
          d.knowledge_status, d.valid_until,
          ts_rank_cd(f.search_vector, websearch_to_tsquery('simple', ${query})) as score
        from companyos_knowledge.fragments f
        join companyos_knowledge.documents d on d.snapshot_hash = f.snapshot_hash and d.path = f.path
        where f.snapshot_hash = ${snapshotHash}
          and f.access_policy_id in (select jsonb_array_elements_text(${JSON.stringify(authorizedPolicyIds)}::jsonb))
          and f.search_vector @@ websearch_to_tsquery('simple', ${query})
        order by score desc, f.path, f.start_line limit ${candidateLimit}`;
      const makeHit = (row: Record<string, unknown>, score: number): KnowledgeSearchHit => ({
        score,
        excerpt: String(row.body).trim().slice(0, 1_200),
        signals: [
          ...(row.knowledge_status === "contested" ? ["contested" as const] : []),
          ...(row.knowledge_status === "stale" || (row.valid_until !== null && Date.parse(String(row.valid_until)) < Date.now()) ? ["stale" as const] : []),
        ],
        citation: { snapshotHash, path: String(row.path), fragmentId: String(row.fragment_id), heading: String(row.heading), startLine: Number(row.start_line), endLine: Number(row.end_line), digest: String(row.digest) },
      });
      const lexical = rows.map((row, index) => ({ row: row as Record<string, unknown>, hit: { ...makeHit(row as Record<string, unknown>, Number(row.score)), lexicalRank: index + 1 } }));
      let fused: Array<{ row: Record<string, unknown>; hit: KnowledgeSearchHit }> = lexical;
      let mode: KnowledgeSearchResult["mode"] = "lexical";
      const degradations: KnowledgeSearchResult["degradations"] = [];
      if (requestedMode === "hybrid") {
        if (!embedding) degradations.push("embedding-disabled");
        else if (!features.vector) degradations.push("vector-index-unavailable");
        else {
          try {
            const queryVector = (await embedding.embed([query]))[0];
            const literal = vectorLiteral(queryVector);
            const semanticRows = await sql`select f.fragment_id, f.path, f.heading, f.start_line, f.end_line, f.digest, f.body,
                d.knowledge_status, d.valid_until, (e.embedding <=> ${literal}::vector) as distance
              from companyos_knowledge.fragment_embeddings e
              join companyos_knowledge.fragments f on f.snapshot_hash = e.snapshot_hash and f.fragment_id = e.fragment_id
              join companyos_knowledge.documents d on d.snapshot_hash = f.snapshot_hash and d.path = f.path
              where e.snapshot_hash = ${snapshotHash} and e.adapter_id = ${embedding.id} and e.adapter_version = ${embedding.version}
                and f.access_policy_id in (select jsonb_array_elements_text(${JSON.stringify(authorizedPolicyIds)}::jsonb))
              order by distance, f.path, f.start_line limit ${candidateLimit}`;
            if (semanticRows.length === 0) {
              degradations.push("embedding-unavailable");
              throw new Error("Active snapshot has no compatible embeddings.");
            }
            const byId = new Map<string, { row: Record<string, unknown>; hit: KnowledgeSearchHit }>();
            lexical.forEach((entry, index) => byId.set(String(entry.row.fragment_id), { row: entry.row, hit: { ...entry.hit, score: 1 / (60 + index + 1) } }));
            semanticRows.forEach((row, index) => {
              const id = String(row.fragment_id);
              const existing = byId.get(id);
              const semanticScore = 1 / (60 + index + 1);
              if (existing) { existing.hit.semanticRank = index + 1; existing.hit.score += semanticScore; }
              else byId.set(id, { row: row as Record<string, unknown>, hit: { ...makeHit(row as Record<string, unknown>, semanticScore), semanticRank: index + 1 } });
            });
            fused = [...byId.values()].sort((a, b) => b.hit.score - a.hit.score || String(a.row.path).localeCompare(String(b.row.path)) || Number(a.row.start_line) - Number(b.row.start_line));
            mode = "hybrid";
          } catch {
            if (!degradations.includes("embedding-unavailable")) degradations.push("embedding-unavailable");
          }
        }
      }
      const seen = new Set<string>();
      const hits: KnowledgeSearchHit[] = [];
      for (const entry of fused) {
        const path = String(entry.row.path);
        if (seen.has(path)) continue;
        seen.add(path);
        hits.push(entry.hit);
        if (hits.length >= limit) break;
      }
      return { query, snapshotHash, hits, gaps: hits.length === 0 ? ["no-results"] : [], mode, degradations };
    },

    async get(input: { path: string; subject?: KnowledgeAccessSubject }): Promise<KnowledgeGetResult | undefined> {
      await ensureCompanyKnowledgeSchema();
      const sql = connection();
      const policyRows = await sql`select s.snapshot_hash, s.bundle, d.access_policy_id
        from companyos_knowledge.snapshots s
        join companyos_knowledge.documents d on d.snapshot_hash = s.snapshot_hash
        where s.status = 'active' and d.path = ${input.path} limit 1`;
      if (!policyRows[0]) return undefined;
      const bundle = policyRows[0].bundle as unknown as KnowledgeBundle;
      const subject = await enrichPostgresKnowledgeSubject(input.subject);
      const permit = await new KnowledgeAuthorizer(bundle.accessPolicies, new PostgresKnowledgeAccessAuditor()).authorize({
        subject, permission: "read", policyIds: [String(policyRows[0].access_policy_id)], objectType: "document", objectId: input.path,
      });
      if (!permit) return undefined;
      const rows = await sql`select document from companyos_knowledge.documents
        where snapshot_hash = ${String(policyRows[0].snapshot_hash)} and path = ${input.path} limit 1`;
      return rows[0] ? { snapshotHash: String(policyRows[0].snapshot_hash), document: rows[0].document as unknown as KnowledgeDocument } : undefined;
    },

    async traverse(input) {
      const active = await this.activeSnapshot();
      if (!active) return { snapshotHash: null, startPath: input.path, direction: input.direction ?? "both", paths: [], truncated: false, gaps: ["no-active-snapshot" as const] };
      const subject = await enrichPostgresKnowledgeSubject(input.subject);
      const authorized = await filterAuthorizedKnowledgeBundle(active.bundle, subject, new KnowledgeAuthorizer(active.bundle.accessPolicies, new PostgresKnowledgeAccessAuditor()));
      return traverseKnowledgeGraph(authorized, input);
    },

    async health() {
      const features = await ensureCompanyKnowledgeSchema();
      const active = await this.activeSnapshot();
      let vectorIndex = false;
      if (active && features.vector && embedding) {
        const rows = await connection()`select
            (select count(*) from companyos_knowledge.fragments where snapshot_hash = ${active.snapshotHash}) as fragments,
            (select count(*) from companyos_knowledge.fragment_embeddings where snapshot_hash = ${active.snapshotHash}
              and adapter_id = ${embedding.id} and adapter_version = ${embedding.version}) as embeddings`;
        vectorIndex = Number(rows[0]?.fragments ?? 0) === Number(rows[0]?.embeddings ?? -1);
      }
      const degradation = !embedding ? "embedding-disabled" : !features.vector ? "vector-index-unavailable" : !vectorIndex ? "embedding-unavailable" : undefined;
      return { ok: Boolean(active), activeSnapshotHash: active?.snapshotHash ?? null, lexical: true as const, vectorIndex, embeddingAdapter: embedding?.id ?? null, ...(degradation ? { degradation } : {}) };
    },
  };
}

export async function persistKnowledgeReviewCandidates(candidates: ReviewCandidate[]): Promise<number> {
  await ensureCompanyKnowledgeSchema();
  const sql = connection();
  let inserted = 0;
  for (const candidate of candidates.slice(0, 3)) {
    const rows = await sql`insert into companyos_knowledge.review_candidates (
        candidate_id, source_path, source_digest, route, status, candidate, access_policy_id)
      values (${candidate.candidateId}, ${candidate.sourcePath}, ${candidate.sourceDigest},
        ${candidate.route}, ${candidate.status}, ${JSON.stringify(candidate)}, ${candidate.accessPolicyId})
      on conflict (candidate_id) do nothing returning candidate_id`;
    inserted += rows.length;
  }
  return inserted;
}

export async function listPersistedKnowledgeReviewCandidateIds(): Promise<string[]> {
  await ensureCompanyKnowledgeSchema();
  const rows = await connection()`select candidate_id from companyos_knowledge.review_candidates order by created_at, candidate_id`;
  return rows.map((row) => String(row.candidate_id));
}

export async function getPostgresKnowledgeReviewCandidate(candidateId: string, subject?: KnowledgeAccessSubject): Promise<ReviewCandidate | undefined> {
  await ensureCompanyKnowledgeSchema();
  const sql = connection();
  const policyRows = await sql`select access_policy_id from companyos_knowledge.review_candidates where candidate_id = ${candidateId} limit 1`;
  if (!policyRows[0]) return undefined;
  const enriched = await enrichPostgresKnowledgeSubject(subject);
  const permit = await new KnowledgeAuthorizer([COMPANY_KNOWLEDGE_POLICY, QUARANTINE_POLICY], new PostgresKnowledgeAccessAuditor()).authorize({
    subject: enriched, permission: "review", policyIds: [String(policyRows[0].access_policy_id)], objectType: "review-candidate", objectId: candidateId,
  });
  if (!permit) return undefined;
  const rows = await sql`select status, candidate from companyos_knowledge.review_candidates where candidate_id = ${candidateId} limit 1`;
  return rows[0] ? { ...(rows[0].candidate as unknown as ReviewCandidate), status: rows[0].status as ReviewCandidate["status"] } : undefined;
}

export async function decidePostgresKnowledgeReview(input: ReviewDecision, subject?: KnowledgeAccessSubject): Promise<ReviewCandidate> {
  await ensureCompanyKnowledgeSchema();
  if (!input.decidedBy.trim()) throw new Error("A Knowledge review decision requires an attributable human principal.");
  if (subject?.principalId !== input.decidedBy || subject.principalType !== "human") throw new Error("Knowledge review identity does not match the deciding human principal.");
  if (!await getPostgresKnowledgeReviewCandidate(input.candidateId, subject)) throw new Error(`Knowledge review candidate '${input.candidateId}' is missing or unauthorized.`);
  const rows = await connection()`update companyos_knowledge.review_candidates
    set status = ${input.decision}, decision = ${JSON.stringify(input)}, decided_at = ${input.decidedAt}
    where candidate_id = ${input.candidateId} and status = 'pending'
    returning candidate`;
  if (!rows[0]) throw new Error(`Knowledge review candidate '${input.candidateId}' is missing or no longer pending.`);
  return { ...(rows[0].candidate as unknown as ReviewCandidate), status: input.decision };
}

export async function rebuildPostgresKnowledgeDerived(args: {
  snapshotHash: string;
  embeddingAdapter?: EmbeddingAdapter;
  embeddingPolicy?: EmbeddingPolicy;
}): Promise<{ snapshotHash: string; graphEdges: number; embeddings: number; vectorIndex: boolean }> {
  const features = await ensureCompanyKnowledgeSchema();
  const sql = connection();
  const rows = await sql`select bundle from companyos_knowledge.snapshots where snapshot_hash = ${args.snapshotHash} limit 1`;
  if (!rows[0]) throw new Error(`Unknown Knowledge snapshot '${args.snapshotHash}'.`);
  const bundle = rows[0].bundle as unknown as KnowledgeBundle;
  assertKnowledgeBundleIntegrity(bundle);
  await sql`delete from companyos_knowledge.graph_edges where snapshot_hash = ${args.snapshotHash}`;
  for (const edge of bundle.edges) await sql`insert into companyos_knowledge.graph_edges (snapshot_hash, from_path, to_path)
    values (${args.snapshotHash}, ${edge.from}, ${edge.to}) on conflict do nothing`;
  let embeddings = 0;
  if (features.vector) {
    await sql`delete from companyos_knowledge.fragment_embeddings where snapshot_hash = ${args.snapshotHash}`;
    const policy = args.embeddingPolicy ?? { mode: "local", allowExternalDataEgress: false };
    const adapter = authorizeEmbeddingAdapter(args.embeddingAdapter ?? new LocalHashEmbeddingAdapter(), policy);
    if (adapter) {
      const fragments = bundle.documents.flatMap((document) => document.fragments.map((fragment) => ({ document, fragment })));
      const vectors = await adapter.embed(fragments.map(({ document, fragment }) => `${document.title}\n${document.description}\n${fragment.body}`));
      for (let index = 0; index < fragments.length; index += 1) {
        const literal = vectorLiteral(vectors[index]);
        await sql`insert into companyos_knowledge.fragment_embeddings (snapshot_hash, fragment_id, adapter_id, adapter_version, embedding)
          values (${args.snapshotHash}, ${fragments[index].fragment.fragmentId}, ${adapter.id}, ${adapter.version}, ${literal}::vector)`;
        embeddings += 1;
      }
    }
  }
  const evidence = { graph_edges: bundle.edges.length, embeddings, vector_index: features.vector, rebuild: true };
  await sql`insert into companyos_knowledge.index_runs (snapshot_hash, status, evidence, completed_at)
    values (${args.snapshotHash}, 'verified', ${JSON.stringify(evidence)}, now())`;
  return { snapshotHash: args.snapshotHash, graphEdges: bundle.edges.length, embeddings, vectorIndex: features.vector };
}
