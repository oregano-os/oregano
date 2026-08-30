import { neon } from "@neondatabase/serverless";
import type { CurrentBriefStore, CurrentBriefVersionInput } from "../knowledge/current-brief.ts";
import type { EmbeddingAdapter, EmbeddingPolicy, KnowledgeAccessPolicy, KnowledgeBundle } from "../knowledge/contracts.ts";
import { authorizeEmbeddingAdapter, LocalHashEmbeddingAdapter } from "../knowledge/embedding.ts";
import type { OpenLoopCandidate, OpenLoopStore } from "../knowledge/knowledge-experiences.ts";
import {
  createKnowledgeRetrievalProjectionV3,
  createKnowledgeRetrievalUnitV3,
  buildKnowledgeRetrievalProjectionV3,
  type KnowledgeRetrievalEvidenceLocator,
  type KnowledgeRetrievalProjectionV3,
  type KnowledgeRetrievalUnitV3,
} from "../knowledge/retrieval-unit.ts";
import type {
  KnowledgeRetrievalCandidateStoreV3,
  KnowledgeRetrievalCandidateV3,
  KnowledgeRetrievalProjectionMetadataV3,
} from "../knowledge/retrieval-v3.ts";
import { sha256 } from "../runtime/canonical.ts";
import { ensureCompanyKnowledgeSchema } from "./knowledge-migrate.ts";
import { postgresTimestampToIso } from "./postgres-values.ts";
import { PostgresBrainKnowledgeProjectionStore } from "./brain-retrieval-store.ts";

type Row = Record<string, unknown>;

const connection = () => {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is not set — Retrieval V3 uses the existing Company Instance database.");
  return neon(value);
};

const vectorLiteral = (vector: readonly number[]): string => `[${vector.map((value) => Number.isFinite(value) ? value.toFixed(10) : "0").join(",")}]`;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];
const optionalIso = (value: unknown): string | undefined => value === null || value === undefined ? undefined : postgresTimestampToIso(value);

const mapPolicyRows = (policyRows: Row[], entryRows: Row[]): KnowledgeAccessPolicy[] => policyRows.map((row): KnowledgeAccessPolicy => ({
  policyId: String(row.policy_id),
  policyVersion: Number(row.policy_version),
  visibility: row.visibility as KnowledgeAccessPolicy["visibility"],
  ...(row.parent_policy_id ? { parentPolicyId: String(row.parent_policy_id) } : {}),
  sourceRoot: Boolean(row.source_root),
  status: row.status as KnowledgeAccessPolicy["status"],
  entries: entryRows.filter((entry) => entry.policy_id === row.policy_id).map((entry) => ({
    subjectKind: entry.subject_kind as "principal" | "group",
    subjectId: String(entry.subject_id),
    permission: entry.permission as "read" | "review" | "write" | "promote" | "admin",
    effect: entry.effect as "allow" | "deny",
  })),
}));

const mapUnit = (row: Row): KnowledgeRetrievalUnitV3 => createKnowledgeRetrievalUnitV3({
  unitId: String(row.unit_id),
  parentId: String(row.parent_id),
  kind: row.unit_kind as KnowledgeRetrievalUnitV3["kind"],
  authorityLayer: row.authority_layer as KnowledgeRetrievalUnitV3["authorityLayer"],
  state: row.lifecycle_state as KnowledgeRetrievalUnitV3["state"],
  title: String(row.title),
  aliases: strings(row.aliases),
  text: String(row.body),
  contentDigest: String(row.content_digest),
  accessPolicyId: String(row.access_policy_id),
  sourceIds: strings(row.source_ids),
  observedAt: postgresTimestampToIso(row.observed_at),
  ...(optionalIso(row.valid_from) ? { validFrom: optionalIso(row.valid_from) } : {}),
  ...(optionalIso(row.valid_until) ? { validUntil: optionalIso(row.valid_until) } : {}),
  ...(row.evidence_locator ? { evidenceLocator: row.evidence_locator as KnowledgeRetrievalEvidenceLocator } : {}),
  graphNeighbors: strings(row.graph_neighbors),
  signals: row.ranking_signals as KnowledgeRetrievalUnitV3["signals"],
});

const mapProjection = (row: Row): KnowledgeRetrievalProjectionMetadataV3 => ({
  projectionHash: String(row.projection_hash),
  sourceSnapshotIds: strings(row.source_snapshot_ids),
  unitCount: Number(row.unit_count),
  status: row.status as KnowledgeRetrievalProjectionMetadataV3["status"],
  ...(row.embedding_profile ? { embeddingProfile: row.embedding_profile as KnowledgeRetrievalProjectionMetadataV3["embeddingProfile"] } : {}),
  createdAt: postgresTimestampToIso(row.created_at),
  ...(row.verified_at ? { verifiedAt: postgresTimestampToIso(row.verified_at) } : {}),
  ...(row.activated_at ? { activatedAt: postgresTimestampToIso(row.activated_at) } : {}),
});

export class PostgresKnowledgeRetrievalV3Store implements KnowledgeRetrievalCandidateStoreV3, CurrentBriefStore, OpenLoopStore {
  readonly #readProjectionHash?: string;
  readonly #allowVerifiedReadProjection: boolean;

  constructor(options: { readProjectionHash?: string; allowVerifiedReadProjection?: boolean } = {}) {
    if (options.readProjectionHash && !/^[a-f0-9]{64}$/.test(options.readProjectionHash)) throw new Error("Retrieval V3 read projection hash is invalid.");
    if (options.allowVerifiedReadProjection && !options.readProjectionHash) throw new Error("Retrieval V3 verified shadow reads require one exact projection hash.");
    this.#readProjectionHash = options.readProjectionHash;
    this.#allowVerifiedReadProjection = options.allowVerifiedReadProjection ?? false;
  }

  async policies(): Promise<KnowledgeAccessPolicy[]> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const [policyRows, entryRows] = await Promise.all([
      sql`select policy_id, policy_version, visibility, parent_policy_id, source_root, status from companyos_knowledge.acl_policies order by policy_id`,
      sql`select policy_id, subject_kind, subject_id, permission, effect from companyos_knowledge.acl_entries order by policy_id, subject_kind, subject_id, permission, effect`,
    ]);
    return mapPolicyRows(policyRows as Row[], entryRows as Row[]);
  }

  async activeProjection(): Promise<KnowledgeRetrievalProjectionMetadataV3 | undefined> {
    await ensureCompanyKnowledgeSchema();
    const rows = this.#readProjectionHash
      ? await connection()`select * from companyos_knowledge.retrieval_projection_runs
          where projection_hash = ${this.#readProjectionHash}
            and (${this.#allowVerifiedReadProjection} or status = 'active')
            and status in ('verified','active') limit 1`
      : await connection()`select * from companyos_knowledge.retrieval_projection_runs where status = 'active' limit 1`;
    return rows[0] ? mapProjection(rows[0] as Row) : undefined;
  }

  async projection(projectionHash: string): Promise<KnowledgeRetrievalProjectionMetadataV3 | undefined> {
    if (!/^[a-f0-9]{64}$/.test(projectionHash)) throw new Error("Retrieval V3 projection hash is invalid.");
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select * from companyos_knowledge.retrieval_projection_runs where projection_hash = ${projectionHash} limit 1`;
    return rows[0] ? mapProjection(rows[0] as Row) : undefined;
  }

  async qualificationUnits(projectionHash: string): Promise<KnowledgeRetrievalUnitV3[]> {
    if (!/^[a-f0-9]{64}$/.test(projectionHash)) throw new Error("Retrieval V3 projection hash is invalid.");
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select * from companyos_knowledge.retrieval_units
      where projection_hash = ${projectionHash} order by unit_id`;
    return (rows as Row[]).map(mapUnit);
  }

  async stageProjection(input: { projection: KnowledgeRetrievalProjectionV3; embeddingAdapter?: EmbeddingAdapter; embeddingPolicy?: EmbeddingPolicy }): Promise<KnowledgeRetrievalProjectionMetadataV3> {
    const projection = createKnowledgeRetrievalProjectionV3(input.projection);
    if (projection.projectionHash !== input.projection.projectionHash) throw new Error("Retrieval V3 projection failed deterministic integrity validation.");
    const features = await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const runRows = await sql`insert into companyos_knowledge.retrieval_projection_runs
        (projection_hash, contract_version, source_snapshot_ids, unit_count, status, created_at)
      values (${projection.projectionHash}, ${projection.contractVersion}, ${JSON.stringify(projection.sourceSnapshotIds)}, ${projection.units.length}, 'staged', ${projection.createdAt})
      on conflict (projection_hash) do update set
        projection_hash = excluded.projection_hash,
        status = case when companyos_knowledge.retrieval_projection_runs.status in ('verified','active')
          then companyos_knowledge.retrieval_projection_runs.status else 'staged' end,
        failure_digest = case when companyos_knowledge.retrieval_projection_runs.status in ('verified','active')
          then companyos_knowledge.retrieval_projection_runs.failure_digest else null end
      where companyos_knowledge.retrieval_projection_runs.contract_version = excluded.contract_version
        and companyos_knowledge.retrieval_projection_runs.source_snapshot_ids = excluded.source_snapshot_ids
        and companyos_knowledge.retrieval_projection_runs.unit_count = excluded.unit_count
      returning *`;
    if (!runRows[0]) throw new Error("Retrieval V3 projection identity conflicts with existing projection evidence.");
    try {
      for (let offset = 0; offset < projection.units.length; offset += 250) {
        const batch = projection.units.slice(offset, offset + 250);
        await sql.transaction((transaction) => batch.map((unit) => transaction`insert into companyos_knowledge.retrieval_units
            (projection_hash, unit_id, parent_id, unit_kind, authority_layer, lifecycle_state, title, aliases, body,
              content_digest, access_policy_id, source_ids, observed_at, valid_from, valid_until, evidence_locator,
              graph_neighbors, ranking_signals)
          values (${projection.projectionHash}, ${unit.unitId}, ${unit.parentId}, ${unit.kind}, ${unit.authorityLayer}, ${unit.state},
            ${unit.title}, ${JSON.stringify(unit.aliases)}, ${unit.text}, ${unit.contentDigest}, ${unit.accessPolicyId},
            ${JSON.stringify(unit.sourceIds)}, ${unit.observedAt}, ${unit.validFrom ?? null}, ${unit.validUntil ?? null},
            ${unit.evidenceLocator ? JSON.stringify(unit.evidenceLocator) : null}, ${JSON.stringify(unit.graphNeighbors)},
            ${JSON.stringify(unit.signals)})
          on conflict (projection_hash, unit_id) do nothing`), { isolationLevel: "Serializable" });
      }
      const embedding = authorizeEmbeddingAdapter(input.embeddingAdapter, input.embeddingPolicy ?? { mode: "disabled", allowExternalDataEgress: false });
      if (features.vector && embedding && projection.units.length > 0) {
        let embeddedUnitCount = 0;
        for (let offset = 0; offset < projection.units.length; offset += 64) {
          const batch = projection.units.slice(offset, offset + 64);
          const vectors = await embedding.embed(batch.map((unit) => `${unit.title}\n${unit.text}`));
          if (vectors.length !== batch.length || vectors.some((vector) => vector.length !== embedding.dimensions || vector.some((value) => !Number.isFinite(value)))) throw new Error("Retrieval V3 embedding adapter returned an invalid batch.");
          await sql.transaction((transaction) => batch.map((unit, index) => transaction`insert into companyos_knowledge.retrieval_unit_embeddings
              (projection_hash, unit_id, adapter_id, adapter_version, dimensions, content_digest, embedding)
            values (${projection.projectionHash}, ${unit.unitId}, ${embedding.id}, ${embedding.version}, ${embedding.dimensions},
              ${unit.contentDigest}, ${vectorLiteral(vectors[index]!)}::vector)
            on conflict (projection_hash, unit_id, adapter_id, adapter_version) do nothing`), { isolationLevel: "Serializable" });
          embeddedUnitCount += batch.length;
        }
        await sql`update companyos_knowledge.retrieval_projection_runs set embedding_profile = ${JSON.stringify({ adapterId: embedding.id, adapterVersion: embedding.version, dimensions: embedding.dimensions, embeddedUnitCount })}
          where projection_hash = ${projection.projectionHash}`;
      }
    } catch (error) {
      await sql`update companyos_knowledge.retrieval_projection_runs set status = 'failed', failure_digest = ${sha256(error instanceof Error ? error.message : "unknown-retrieval-projection-failure")}
        where projection_hash = ${projection.projectionHash} and status = 'staged'`;
      throw error;
    }
    const rows = await sql`select * from companyos_knowledge.retrieval_projection_runs where projection_hash = ${projection.projectionHash} limit 1`;
    return mapProjection(rows[0] as Row);
  }

  async verifyProjection(projectionHash: string): Promise<KnowledgeRetrievalProjectionMetadataV3> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const runs = await sql`select * from companyos_knowledge.retrieval_projection_runs where projection_hash = ${projectionHash} and status <> 'failed' limit 1`;
    if (!runs[0]) throw new Error(`Retrieval V3 projection '${projectionHash}' is missing or failed.`);
    const unitRows = await sql`select * from companyos_knowledge.retrieval_units where projection_hash = ${projectionHash} order by unit_id`;
    const rebuilt = createKnowledgeRetrievalProjectionV3({ units: (unitRows as Row[]).map(mapUnit), sourceSnapshotIds: strings(runs[0].source_snapshot_ids), createdAt: postgresTimestampToIso(runs[0].created_at) });
    if (rebuilt.projectionHash !== projectionHash || rebuilt.units.length !== Number(runs[0].unit_count)) throw new Error(`Retrieval V3 projection '${projectionHash}' failed content and count verification.`);
    const rows = await sql`update companyos_knowledge.retrieval_projection_runs set status = case when status = 'active' then 'active' else 'verified' end,
        verified_at = coalesce(verified_at, now()) where projection_hash = ${projectionHash} returning *`;
    return mapProjection(rows[0] as Row);
  }

  async activateProjection(projectionHash: string): Promise<KnowledgeRetrievalProjectionMetadataV3> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const results = await sql.transaction((transaction) => [
      transaction`update companyos_knowledge.retrieval_projection_runs set status = 'retired'
        where status = 'active' and projection_hash <> ${projectionHash}
          and exists (select 1 from companyos_knowledge.retrieval_projection_runs where projection_hash = ${projectionHash} and verified_at is not null)`,
      transaction`update companyos_knowledge.retrieval_projection_runs set status = 'active', activated_at = now()
        where projection_hash = ${projectionHash} and verified_at is not null returning *`,
    ], { isolationLevel: "Serializable" });
    if (!results[1]?.[0]) throw new Error(`Retrieval V3 projection '${projectionHash}' must be verified before activation.`);
    return mapProjection(results[1][0] as Row);
  }

  async activateQualifiedProjection(projectionHash: string, activationReceiptId: string): Promise<KnowledgeRetrievalProjectionMetadataV3> {
    if (!/^[a-f0-9]{64}$/.test(projectionHash) || !/^[a-f0-9]{64}$/.test(activationReceiptId)) {
      throw new Error("Retrieval V3 qualified activation identities are invalid.");
    }
    await ensureCompanyKnowledgeSchema();
    const receipts = await connection()`select receipt_id from companyos_knowledge.knowledge_productization_receipts
      where receipt_id = ${activationReceiptId}
        and receipt_kind = 'activation-qualification'
        and status = 'qualified-for-explicit-activation'
        and receipt->'evidence'->>'retrievalProjectionReceiptId' = ${projectionHash}
      limit 1`;
    if (!receipts[0]) throw new Error("Retrieval V3 activation requires an exact persisted activation-qualification receipt.");
    return this.activateProjection(projectionHash);
  }

  async lexicalCandidates(input: { projectionHash: string; query: string; authorizedPolicyIds: string[]; limit: number }): Promise<KnowledgeRetrievalCandidateV3[]> {
    if (input.authorizedPolicyIds.length === 0) return [];
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select *,
        (lower(title) = lower(${input.query}) or exists (
          select 1 from jsonb_array_elements_text(aliases) alias_value where lower(alias_value) = lower(${input.query})
        )) as exact_match,
        ts_rank_cd(search_vector, websearch_to_tsquery('simple', ${input.query})) as lexical_score
      from companyos_knowledge.retrieval_units
      where projection_hash = ${input.projectionHash}
        and access_policy_id in (select jsonb_array_elements_text(${JSON.stringify(input.authorizedPolicyIds)}::jsonb))
        and ((lower(title) = lower(${input.query}) or exists (
          select 1 from jsonb_array_elements_text(aliases) alias_value where lower(alias_value) = lower(${input.query})
        ))
          or search_vector @@ websearch_to_tsquery('simple', ${input.query}))
      order by exact_match desc, lexical_score desc, unit_id limit ${Math.max(1, Math.min(input.limit, 500))}`;
    const exactRows = (rows as Row[]).filter((row) => Boolean(row.exact_match));
    const lexicalRows = (rows as Row[]).filter((row) => Number(row.lexical_score) > 0);
    const exactRank = new Map(exactRows.map((row, index) => [String(row.unit_id), index + 1]));
    const lexicalRank = new Map(lexicalRows.sort((left, right) => Number(right.lexical_score) - Number(left.lexical_score) || String(left.unit_id).localeCompare(String(right.unit_id))).map((row, index) => [String(row.unit_id), index + 1]));
    return (rows as Row[]).map((row) => ({ unit: mapUnit(row), ...(exactRank.has(String(row.unit_id)) ? { exactRank: exactRank.get(String(row.unit_id)) } : {}), ...(lexicalRank.has(String(row.unit_id)) ? { lexicalRank: lexicalRank.get(String(row.unit_id)) } : {}) }));
  }

  async semanticCandidates(input: { projectionHash: string; vector: number[]; adapterId: string; adapterVersion: string; dimensions: number; authorizedPolicyIds: string[]; limit: number }): Promise<KnowledgeRetrievalCandidateV3[]> {
    if (input.authorizedPolicyIds.length === 0) return [];
    if (input.dimensions !== 256 || input.vector.length !== 256) throw new Error("Retrieval V3 Postgres semantic search requires the qualified 256-dimension profile.");
    await ensureCompanyKnowledgeSchema();
    const literal = vectorLiteral(input.vector);
    const rows = await connection()`select u.*, (e.embedding <=> ${literal}::vector) as distance
      from companyos_knowledge.retrieval_unit_embeddings e
      join companyos_knowledge.retrieval_units u on u.projection_hash = e.projection_hash and u.unit_id = e.unit_id
      where e.projection_hash = ${input.projectionHash} and e.adapter_id = ${input.adapterId} and e.adapter_version = ${input.adapterVersion}
        and e.dimensions = ${input.dimensions}
        and u.access_policy_id in (select jsonb_array_elements_text(${JSON.stringify(input.authorizedPolicyIds)}::jsonb))
      order by distance, u.unit_id limit ${Math.max(1, Math.min(input.limit, 500))}`;
    return (rows as Row[]).map((row, index) => ({ unit: mapUnit(row), semanticRank: index + 1 }));
  }

  async getUnitsByIds(input: { projectionHash: string; unitIds: string[]; authorizedPolicyIds: string[] }): Promise<KnowledgeRetrievalUnitV3[]> {
    if (input.unitIds.length === 0 || input.authorizedPolicyIds.length === 0) return [];
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select * from companyos_knowledge.retrieval_units
      where projection_hash = ${input.projectionHash}
        and unit_id in (select jsonb_array_elements_text(${JSON.stringify([...new Set(input.unitIds)].slice(0, 500))}::jsonb))
        and access_policy_id in (select jsonb_array_elements_text(${JSON.stringify(input.authorizedPolicyIds)}::jsonb))
      order by unit_id`;
    return (rows as Row[]).map(mapUnit);
  }

  async loadCurrent(input: { subjectType: string; subjectId: string; authorizedPolicyIds: string[] }): Promise<(CurrentBriefVersionInput & { latestRelevantChangeAt?: string }) | undefined> {
    if (input.authorizedPolicyIds.length === 0) return undefined;
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select s.synthesis_id, s.current_version_id, s.subject_type, s.subject_id,
        v.synthesis_version_id, v.version_number, v.content, v.content_digest, v.supporting_claim_ids,
        v.contested_claim_ids, v.superseded_claim_ids, v.gaps, v.access_policy_id, v.synthesized_at,
        (select max(claim.observed_at)
          from companyos_knowledge.claims claim
          join companyos_knowledge.claim_evidence evidence on evidence.claim_id = claim.claim_id
          join companyos_knowledge.pages page on page.page_id = evidence.page_id
            and page.current_version_id = evidence.page_version_id
          where s.subject_type = 'page' and evidence.page_id = s.subject_id
            and claim.access_policy_id = v.access_policy_id) as latest_relevant_change_at
      from companyos_knowledge.syntheses s
      join companyos_knowledge.synthesis_versions v on v.synthesis_version_id = s.current_version_id
      where s.subject_type = ${input.subjectType} and s.subject_id = ${input.subjectId} and s.lifecycle_status = 'active'
        and s.access_policy_id in (select jsonb_array_elements_text(${JSON.stringify(input.authorizedPolicyIds)}::jsonb))
        and v.access_policy_id in (select jsonb_array_elements_text(${JSON.stringify(input.authorizedPolicyIds)}::jsonb))
      limit 1`;
    const row = rows[0] as Row | undefined;
    if (!row) return undefined;
    return {
      synthesisId: String(row.synthesis_id),
      currentVersionId: String(row.current_version_id),
      synthesisVersionId: String(row.synthesis_version_id),
      versionNumber: Number(row.version_number),
      subjectType: String(row.subject_type),
      subjectId: String(row.subject_id),
      content: String(row.content),
      contentDigest: String(row.content_digest),
      supportingClaimIds: strings(row.supporting_claim_ids),
      contestedClaimIds: strings(row.contested_claim_ids),
      supersededClaimIds: strings(row.superseded_claim_ids),
      gaps: strings(row.gaps),
      accessPolicyId: String(row.access_policy_id),
      synthesizedAt: postgresTimestampToIso(row.synthesized_at),
      ...(row.latest_relevant_change_at ? { latestRelevantChangeAt: postgresTimestampToIso(row.latest_relevant_change_at) } : {}),
    };
  }

  async loadOpenLoops(input: { authorizedPolicyIds: string[]; limit: number }): Promise<OpenLoopCandidate[]> {
    if (input.authorizedPolicyIds.length === 0) return [];
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select c.claim_id, c.claim_text, c.status, c.source_basis, c.observed_at,
        c.access_policy_id, owner.entity_id as owner_principal_id, unit.unit_id, unit.content_digest
      from companyos_knowledge.claims c
      join companyos_knowledge.retrieval_projection_runs projection on projection.status = 'active'
      join companyos_knowledge.retrieval_units unit on unit.projection_hash = projection.projection_hash
        and unit.unit_id = ('claim:' || c.claim_id) and unit.access_policy_id = c.access_policy_id
      left join lateral (
        select relation.entity_id from companyos_knowledge.claim_relations relation
        where relation.claim_id = c.claim_id and relation.relation_type = 'owner'
        order by relation.entity_id limit 1
      ) owner on true
      where c.claim_kind = 'commitment' and c.status in ('proposed','active','contested')
        and c.access_policy_id in (select jsonb_array_elements_text(${JSON.stringify(input.authorizedPolicyIds)}::jsonb))
        and unit.access_policy_id in (select jsonb_array_elements_text(${JSON.stringify(input.authorizedPolicyIds)}::jsonb))
      order by c.observed_at desc, c.claim_id limit ${Math.max(1, Math.min(input.limit, 500))}`;
    return (rows as Row[]).map((row): OpenLoopCandidate => ({
      claimId: String(row.claim_id),
      loopKind: "commitment",
      text: String(row.claim_text),
      state: row.status === "contested" ? "blocked" : "open",
      ...(row.owner_principal_id ? { ownerPrincipalId: String(row.owner_principal_id) } : {}),
      observedAt: postgresTimestampToIso(row.observed_at),
      authorityLayer: row.source_basis === "model-derived" ? "synthesized" : ["source-literal", "principal-memory", "holder-accepted"].includes(String(row.source_basis)) ? "attributed" : "evidence",
      evidence: [{ unitId: String(row.unit_id), contentDigest: String(row.content_digest) }],
      accessPolicyId: String(row.access_policy_id),
    }));
  }
}

export async function rebuildPostgresKnowledgeRetrievalProjectionV3(input: {
  createdAt?: string;
  embeddingAdapter?: EmbeddingAdapter;
  embeddingPolicy?: EmbeddingPolicy;
  activate?: boolean;
} = {}): Promise<KnowledgeRetrievalProjectionMetadataV3> {
  await ensureCompanyKnowledgeSchema();
  const sql = connection();
  const handbookRows = await sql`select bundle from companyos_knowledge.snapshots where status = 'active' limit 1`;
  const brain = await new PostgresBrainKnowledgeProjectionStore({ now: () => input.createdAt ?? new Date().toISOString() }).load();
  const projection = buildKnowledgeRetrievalProjectionV3({
    ...(handbookRows[0]?.bundle ? { handbook: handbookRows[0].bundle as unknown as KnowledgeBundle } : {}),
    brainProjectionHash: brain.projectionHash,
    brainRecords: brain.records,
    brainCitations: brain.citations,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
  const store = new PostgresKnowledgeRetrievalV3Store();
  const embeddingAdapter = input.embeddingAdapter ?? new LocalHashEmbeddingAdapter();
  const embeddingPolicy = input.embeddingPolicy ?? { mode: "local" as const, allowExternalDataEgress: false };
  await store.stageProjection({ projection, embeddingAdapter, embeddingPolicy });
  const verified = await store.verifyProjection(projection.projectionHash);
  return input.activate ? store.activateProjection(verified.projectionHash) : verified;
}
