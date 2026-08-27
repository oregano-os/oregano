import { neon } from "@neondatabase/serverless";
import type { KnowledgeAccessPolicy, KnowledgeAccessSubject } from "../knowledge/contracts.ts";
import type { BrainKnowledgeProjection, BrainKnowledgeProjectionStore } from "../knowledge/unified-provider.ts";
import type { KnowledgeDeltaV2, KnowledgeResultLabel, KnowledgeRetrievalRecordV2 } from "../knowledge/retrieval-v2.ts";
import { sha256 } from "../runtime/canonical.ts";
import { ensureCompanyKnowledgeSchema } from "./knowledge-migrate.ts";
import { postgresTimestampToIso } from "./postgres-values.ts";
import { enrichPostgresKnowledgeSubject } from "./knowledge-access-store.ts";
import { mapStoredSourceRawEvidence } from "./source-pipeline-store.ts";

type Row = Record<string, unknown>;

const connection = () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — Company Knowledge retrieval uses the existing Company Instance database.");
  return neon(url);
};

const iso = postgresTimestampToIso;
const optionalString = (value: unknown): string | undefined => value === null || value === undefined ? undefined : String(value);
const segment = (value: string): string => encodeURIComponent(value);
const lines = (value: string): number => Math.max(1, value.split("\n").length);
const freshness = (observedAt: string, now: string): number => {
  const ageDays = Math.max(0, (Date.parse(now) - Date.parse(observedAt)) / 86_400_000);
  return Number((1 / (1 + ageDays / 365)).toFixed(6));
};

const claimLabel = (row: Row): KnowledgeResultLabel => {
  if (["contested", "superseded", "expired"].includes(String(row.status))) return row.status as KnowledgeResultLabel;
  if (row.source_basis === "model-derived") return "synthesized";
  if (["source-literal", "principal-memory", "holder-accepted"].includes(String(row.source_basis))) return "attributed";
  return "evidence";
};

const identityFor = (kind: string, id: string): string | undefined => {
  if (["page", "claim", "synthesis", "timeline-event"].includes(kind)) return `${kind}:${id}`;
  return undefined;
};

export class PostgresBrainKnowledgeProjectionStore implements BrainKnowledgeProjectionStore {
  readonly #now: () => string;

  constructor(options: { now?: () => string } = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  enrichSubject(subject?: KnowledgeAccessSubject): Promise<KnowledgeAccessSubject | undefined> {
    return enrichPostgresKnowledgeSubject(subject);
  }

  async load(): Promise<BrainKnowledgeProjection> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const now = new Date(this.#now()).toISOString();
    const [policyRows, entryRows, pageRows, claimRows, rawRows, synthesisRows, timelineRows, edgeRows, changeRows] = await Promise.all([
      sql`select policy_id, policy_version, visibility, parent_policy_id, source_root, status
        from companyos_knowledge.acl_policies order by policy_id`,
      sql`select policy_id, subject_kind, subject_id, permission, effect
        from companyos_knowledge.acl_entries order by policy_id, subject_kind, subject_id, permission, effect`,
      sql`select p.page_id, p.page_type_key, p.source_id, p.access_policy_id, p.verification_status,
          v.page_version_id, v.title, v.summary, v.body, v.content_digest, v.observed_at
        from companyos_knowledge.pages p
        join companyos_knowledge.page_versions v on v.page_version_id = p.current_version_id
        join companyos_knowledge.sources s on s.source_id = p.source_id
        where p.lifecycle_status = 'active' and p.verification_status <> 'rejected'
          and s.status in ('registered','healthy','stale')
          and (v.model_provenance is null or exists (
            select 1 from companyos_knowledge.extraction_runs r
            where r.run_id = v.model_provenance->>'extractionRunId' and r.status = 'succeeded'))
        order by p.page_id`,
      sql`select c.claim_id, c.claim_kind, c.claim_text, c.owner_principal_id, c.primary_holder_id,
          c.source_basis, c.status, c.observed_at, c.valid_until, c.extraction_confidence,
          c.epistemic_weight, c.notability, c.access_policy_id, h.display_name as holder_name,
          e.evidence_id, e.source_id, e.provider_object_id, e.provider_version, e.page_id,
          e.page_version_id, e.content_digest as evidence_digest, e.locator
        from companyos_knowledge.claims c
        left join companyos_knowledge.holders h on h.holder_id = c.primary_holder_id
        join companyos_knowledge.claim_evidence e on e.claim_id = c.claim_id
        left join companyos_knowledge.pages evidence_page on evidence_page.page_id = e.page_id
        join companyos_knowledge.sources s on s.source_id = e.source_id
        where c.status not in ('forgotten','deleted') and s.status in ('registered','healthy','stale')
          and (c.model_provenance is null or (
            exists (select 1 from companyos_knowledge.extraction_runs r
              where r.run_id = c.model_provenance->>'extractionRunId' and r.status = 'succeeded')
            and evidence_page.current_version_id = e.page_version_id
            and evidence_page.lifecycle_status = 'active'))
        order by c.claim_id, e.evidence_id`,
      sql`select ov.*, i.deletion_state
        from companyos_knowledge.source_object_versions ov
        join companyos_knowledge.source_inventory i on i.source_id = ov.source_id
          and i.provider_object_id = ov.provider_object_id and i.current_version = ov.provider_version
        join companyos_knowledge.sources s on s.source_id = ov.source_id
        where i.deletion_state = 'present' and s.status in ('registered','healthy','stale')
          and not exists (
            select 1 from companyos_knowledge.pages p
            join companyos_knowledge.page_versions pv on pv.page_version_id = p.current_version_id
            where p.source_id = ov.source_id and pv.source_object_id = ov.provider_object_id
              and pv.source_object_version = ov.provider_version and p.lifecycle_status = 'active'
              and (pv.model_provenance is null or exists (
                select 1 from companyos_knowledge.extraction_runs r
                where r.run_id = pv.model_provenance->>'extractionRunId' and r.status = 'succeeded'))
          )
        order by ov.source_id, ov.provider_object_id, ov.provider_version`,
      sql`select s.synthesis_id, s.subject_type, s.subject_id, s.access_policy_id,
          v.synthesis_version_id, v.content, v.content_digest, v.supporting_claim_ids,
          v.contested_claim_ids, v.superseded_claim_ids, v.synthesized_at
        from companyos_knowledge.syntheses s
        join companyos_knowledge.synthesis_versions v on v.synthesis_version_id = s.current_version_id
        where s.lifecycle_status = 'active'
          and not exists (
            select 1 from jsonb_array_elements_text(
              v.supporting_claim_ids || v.contested_claim_ids || v.superseded_claim_ids
            ) cited(claim_id)
            where not exists (
              select 1 from companyos_knowledge.claims current_claim
              where current_claim.claim_id = cited.claim_id
                and (current_claim.model_provenance is null or (
                  exists (select 1 from companyos_knowledge.extraction_runs current_run
                    where current_run.run_id = current_claim.model_provenance->>'extractionRunId'
                      and current_run.status = 'succeeded')
                  and exists (select 1 from companyos_knowledge.claim_evidence current_evidence
                    join companyos_knowledge.pages current_page on current_page.page_id = current_evidence.page_id
                      and current_page.current_version_id = current_evidence.page_version_id
                    where current_evidence.claim_id = current_claim.claim_id
                      and current_page.lifecycle_status = 'active')))))
        order by s.synthesis_id`,
      sql`select t.event_id, t.event_type, t.subject_type, t.subject_id, t.page_version_id,
          t.claim_id, t.source_id, t.observed_at, t.provenance_class, t.evidence,
          t.access_policy_id
        from companyos_knowledge.timeline_events t
        join companyos_knowledge.pages p on p.page_id = t.subject_id and t.subject_type = 'page'
        join companyos_knowledge.sources s on s.source_id = p.source_id
        where t.lifecycle_status = 'active' and p.lifecycle_status = 'active'
          and s.status in ('registered','healthy','stale')
          and (not (t.evidence ? 'extractionRunId') or exists (
            select 1 from companyos_knowledge.extraction_runs r
            where r.run_id = t.evidence->>'extractionRunId' and r.status = 'succeeded'))
          and (not (t.evidence ? 'extractionRunId') or t.page_version_id = p.current_version_id)
        order by t.event_id`,
      sql`select from_type, from_id, to_type, to_id from companyos_knowledge.knowledge_edges
        where lifecycle_status = 'active' order by from_type, from_id, to_type, to_id`,
      sql`select sequence, source_id, object_kind, object_id, object_version, change_kind,
          access_policy_id, payload_digest, occurred_at
        from companyos_knowledge.knowledge_change_stream order by sequence`,
    ]);

    const entriesByPolicy = new Map<string, KnowledgeAccessPolicy["entries"]>();
    for (const row of entryRows) {
      const policyId = String(row.policy_id);
      const entries = entriesByPolicy.get(policyId) ?? [];
      entries.push({
        subjectKind: row.subject_kind as "principal" | "group",
        subjectId: String(row.subject_id),
        permission: row.permission as KnowledgeAccessPolicy["entries"][number]["permission"],
        effect: row.effect as "allow" | "deny",
      });
      entriesByPolicy.set(policyId, entries);
    }
    const policies: KnowledgeAccessPolicy[] = policyRows.map((row) => ({
      policyId: String(row.policy_id),
      policyVersion: Number(row.policy_version),
      visibility: row.visibility as KnowledgeAccessPolicy["visibility"],
      ...(row.parent_policy_id ? { parentPolicyId: String(row.parent_policy_id) } : {}),
      sourceRoot: row.source_root === true,
      status: row.status as KnowledgeAccessPolicy["status"],
      entries: entriesByPolicy.get(String(row.policy_id)) ?? [],
    }));

    const records: KnowledgeRetrievalRecordV2[] = [];
    const citations: BrainKnowledgeProjection["citations"] = {};
    const edges: BrainKnowledgeProjection["edges"] = [];

    const add = (record: KnowledgeRetrievalRecordV2, path: string, fragmentId: string, heading: string, endLine?: number) => {
      records.push(record);
      citations[record.identity] = { path, fragmentId, heading, startLine: 1, endLine: endLine ?? lines(record.text), digest: record.contentDigest };
    };

    for (const row of pageRows) {
      const pageId = String(row.page_id);
      const identity = `page:${pageId}`;
      const body = String(row.body);
      const observedAt = iso(row.observed_at);
      add({
        identity,
        kind: "page",
        pageId,
        title: String(row.title),
        aliases: [String(row.page_type_key), ...optionalString(row.summary) ? [String(row.summary)] : []],
        text: body,
        contentDigest: String(row.content_digest),
        accessPolicyId: String(row.access_policy_id),
        label: "evidence",
        observedAt,
        sourceIds: [String(row.source_id)],
        confidence: row.verification_status === "verified" ? 0.95 : 0.65,
        authority: 0.55,
        freshness: freshness(observedAt, now),
        expectedValue: 0.6,
        graphNeighbors: [],
      }, `company-knowledge/pages/${segment(pageId)}`, String(row.page_version_id), String(row.title));
    }

    const groupedClaims = new Map<string, Row[]>();
    for (const row of claimRows) {
      const values = groupedClaims.get(String(row.claim_id)) ?? [];
      values.push(row as Row);
      groupedClaims.set(String(row.claim_id), values);
    }
    for (const [claimId, evidenceRows] of groupedClaims) {
      const row = evidenceRows[0]!;
      const identity = `claim:${claimId}`;
      const observedAt = iso(row.observed_at);
      const evidenceDigest = sha256(evidenceRows.map((entry) => ({ evidenceId: entry.evidence_id, digest: entry.evidence_digest, locator: entry.locator })));
      add({
        identity,
        kind: "claim",
        ...(row.page_id ? { pageId: String(row.page_id) } : {}),
        title: `${String(row.claim_kind)} Claim`,
        aliases: [optionalString(row.holder_name), optionalString(row.owner_principal_id)].filter((value): value is string => Boolean(value)),
        text: String(row.claim_text),
        contentDigest: sha256({ claimId, text: row.claim_text, status: row.status, evidenceDigest }),
        accessPolicyId: String(row.access_policy_id),
        label: claimLabel(row),
        observedAt,
        sourceIds: [...new Set(evidenceRows.map((entry) => String(entry.source_id)))],
        confidence: Number(row.extraction_confidence),
        authority: Number(row.epistemic_weight),
        freshness: freshness(observedAt, now),
        expectedValue: Number(row.notability),
        graphNeighbors: [],
      }, `company-knowledge/claims/${segment(claimId)}`, String(row.evidence_id), "Claim", 1);
      for (const evidence of evidenceRows) if (evidence.page_id) edges.push({ from: identity, to: `page:${String(evidence.page_id)}` });
    }

    for (const row of rawRows) {
      const evidence = mapStoredSourceRawEvidence(row as Row);
      const text = evidence.content && "inlineText" in evidence.content ? evidence.content.inlineText : undefined;
      if (!text || !evidence.modelReady || evidence.payloadState !== "active") continue;
      const identity = `source-object:${evidence.envelope.sourceId}:${evidence.envelope.providerObjectId}:${evidence.envelope.providerVersion}`;
      const title = `Source evidence · ${evidence.envelope.locator}`;
      add({
        identity,
        kind: "source-object",
        title,
        aliases: [evidence.envelope.providerObjectId, evidence.envelope.locator],
        text,
        contentDigest: evidence.envelope.contentDigest,
        accessPolicyId: evidence.envelope.accessPolicyId,
        label: "evidence",
        observedAt: evidence.envelope.observedAt,
        sourceIds: [evidence.envelope.sourceId],
        confidence: 0.8,
        authority: 0.4,
        freshness: freshness(evidence.envelope.observedAt, now),
        expectedValue: 0.5,
        graphNeighbors: [],
      }, `company-knowledge/sources/${segment(evidence.envelope.sourceId)}/${segment(evidence.envelope.providerObjectId)}/${segment(evidence.envelope.providerVersion)}`, evidence.envelope.contentDigest, title);
    }

    for (const row of synthesisRows) {
      const synthesisId = String(row.synthesis_id);
      const identity = `synthesis:${synthesisId}`;
      const text = String(row.content);
      const observedAt = iso(row.synthesized_at);
      add({
        identity,
        kind: "synthesis",
        title: `Synthesis · ${String(row.subject_type)} ${String(row.subject_id)}`,
        aliases: [String(row.subject_id)],
        text,
        contentDigest: String(row.content_digest),
        accessPolicyId: String(row.access_policy_id),
        label: "synthesized",
        observedAt,
        sourceIds: [],
        confidence: 0.75,
        authority: 0.5,
        freshness: freshness(observedAt, now),
        expectedValue: 0.7,
        graphNeighbors: [],
      }, `company-knowledge/syntheses/${segment(synthesisId)}`, String(row.synthesis_version_id), "Synthesis");
      const subject = identityFor(String(row.subject_type), String(row.subject_id));
      if (subject) edges.push({ from: identity, to: subject });
      for (const claimId of row.supporting_claim_ids as string[]) edges.push({ from: identity, to: `claim:${claimId}` });
    }

    for (const row of timelineRows) {
      const eventId = String(row.event_id);
      const identity = `timeline-event:${eventId}`;
      const evidence = row.evidence as Row;
      const text = optionalString(evidence?.description) ?? String(row.event_type);
      const observedAt = iso(row.observed_at);
      add({
        identity,
        kind: "timeline-event",
        pageId: String(row.subject_id),
        title: String(row.event_type),
        aliases: [],
        text,
        contentDigest: sha256({ eventId, text, evidence }),
        accessPolicyId: String(row.access_policy_id),
        label: row.provenance_class === "inferred" ? "synthesized" : "evidence",
        observedAt,
        sourceIds: row.source_id ? [String(row.source_id)] : [],
        confidence: row.provenance_class === "inferred" ? 0.65 : 0.9,
        authority: 0.45,
        freshness: freshness(observedAt, now),
        expectedValue: 0.5,
        graphNeighbors: [],
      }, `company-knowledge/timeline/${segment(eventId)}`, eventId, String(row.event_type), 1);
      edges.push({ from: identity, to: `page:${String(row.subject_id)}` });
      if (row.claim_id) edges.push({ from: identity, to: `claim:${String(row.claim_id)}` });
    }

    for (const row of edgeRows) {
      const from = identityFor(String(row.from_type), String(row.from_id));
      const to = identityFor(String(row.to_type), String(row.to_id));
      if (from && to) edges.push({ from, to });
    }
    const identities = new Set(records.map((record) => record.identity));
    const uniqueEdges = [...new Map(edges.filter((edge) => identities.has(edge.from) && identities.has(edge.to)).map((edge) => [`${edge.from}\0${edge.to}`, edge])).values()]
      .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
    const neighbors = new Map<string, Set<string>>();
    for (const edge of uniqueEdges) {
      const forward = neighbors.get(edge.from) ?? new Set<string>();
      forward.add(edge.to); neighbors.set(edge.from, forward);
      const reverse = neighbors.get(edge.to) ?? new Set<string>();
      reverse.add(edge.from); neighbors.set(edge.to, reverse);
    }
    for (const record of records) record.graphNeighbors = [...(neighbors.get(record.identity) ?? [])].sort();

    const deltas: KnowledgeDeltaV2[] = changeRows.map((row) => ({
      sequence: Number(row.sequence),
      identity: `source-object:${String(row.source_id)}:${String(row.object_id)}${row.object_version ? `:${String(row.object_version)}` : ""}`,
      changeKind: row.change_kind === "ingested" ? "created" : row.change_kind === "access-changed" ? "access-changed" : row.change_kind === "deleted" || row.change_kind === "purged" ? "deleted" : "updated",
      accessPolicyId: String(row.access_policy_id),
      contentDigest: String(row.payload_digest),
      occurredAt: iso(row.occurred_at),
    }));
    const projectionHash = sha256({
      policies: policies.map((policy) => ({ id: policy.policyId, version: policy.policyVersion, status: policy.status })),
      records: records.map((record) => ({ identity: record.identity, digest: record.contentDigest, policy: record.accessPolicyId })),
      edges: uniqueEdges,
      deltaHead: deltas.at(-1)?.sequence ?? 0,
    });
    return { projectionHash, policies, records, citations, edges: uniqueEdges, deltas };
  }
}
