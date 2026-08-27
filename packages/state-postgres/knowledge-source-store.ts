import { neon } from "@neondatabase/serverless";
import { sha256 } from "../runtime/canonical.ts";
import type {
  KnowledgeSourceBinding,
  KnowledgeSourceRequirement,
  KnowledgeSourceStore,
  RuntimeObservation,
  SourceEnvelope,
  SourceHealth,
  SourceReceipt,
  SourceRetentionPolicy,
} from "../knowledge/source-contracts.ts";
import { sourceRetentionUntil } from "../knowledge/source-contracts.ts";
import { ensureCompanyKnowledgeSchema } from "./knowledge-migrate.ts";

const connection = () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — Company Knowledge uses the existing Company Instance Neon database.");
  return neon(url);
};

const mapObservation = (row: Record<string, unknown>): RuntimeObservation => ({
  observationId: String(row.observation_id),
  subject: String(row.subject),
  content: String(row.content),
  contentDigest: String(row.content_digest),
  observedAt: new Date(String(row.observed_at)).toISOString(),
  expiresAt: row.expires_at ? new Date(String(row.expires_at)).toISOString() : undefined,
  runId: String(row.run_id),
  agentId: String(row.agent_id),
  evidence: row.evidence as Record<string, unknown>,
  status: row.status as RuntimeObservation["status"],
  supersedes: row.supersedes ? String(row.supersedes) : undefined,
  personalData: false,
});

export class PostgresKnowledgeSourceStore implements KnowledgeSourceStore {
  async registerSource(requirement: KnowledgeSourceRequirement, binding: KnowledgeSourceBinding): Promise<void> {
    await ensureCompanyKnowledgeSchema();
    if (!/^env:[A-Z][A-Z0-9_]+$/.test(binding.secretRef)) throw new Error("Only a SecretRef may be persisted in a Knowledge source binding; credential values are forbidden.");
    await connection()`insert into companyos_knowledge.sources (
        source_id, connector_id, connector_version, requirement, binding, status, updated_at)
      values (${requirement.sourceId}, ${binding.connector}, ${binding.connectorVersion}, ${JSON.stringify(requirement)}, ${JSON.stringify(binding)}, 'registered', now())
      on conflict (source_id) do update set connector_id = excluded.connector_id,
        connector_version = excluded.connector_version, requirement = excluded.requirement,
        cursor = case when companyos_knowledge.sources.binding <> excluded.binding then null else companyos_knowledge.sources.cursor end,
        cursor_complete = case when companyos_knowledge.sources.binding <> excluded.binding then false else companyos_knowledge.sources.cursor_complete end,
        binding = excluded.binding, status = case when companyos_knowledge.sources.status = 'revoked' or companyos_knowledge.sources.binding <> excluded.binding then 'registered' else companyos_knowledge.sources.status end,
        updated_at = now()`;
  }

  async getCursor(sourceId: string): Promise<string | undefined> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select cursor from companyos_knowledge.sources where source_id = ${sourceId} limit 1`;
    return rows[0]?.cursor ? String(rows[0].cursor) : undefined;
  }

  async recordReceipt(receipt: SourceReceipt): Promise<boolean> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`insert into companyos_knowledge.source_receipts (
        receipt_id, source_id, operation, observed_at, receipt)
      values (${receipt.receiptId}, ${receipt.sourceId}, ${receipt.operation}, ${receipt.observedAt}, ${JSON.stringify(receipt)})
      on conflict (receipt_id) do nothing returning receipt_id`;
    return rows.length > 0;
  }

  async upsertEnvelope(envelope: SourceEnvelope, retention: SourceRetentionPolicy): Promise<"inserted" | "updated" | "unchanged"> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const existing = await sql`select current_version, deletion_state from companyos_knowledge.source_inventory
      where source_id = ${envelope.sourceId} and provider_object_id = ${envelope.providerObjectId} limit 1`;
    const versionRows = await sql`select content_digest from companyos_knowledge.source_object_versions
      where source_id = ${envelope.sourceId} and provider_object_id = ${envelope.providerObjectId} and provider_version = ${envelope.providerVersion} limit 1`;
    if (versionRows[0] && String(versionRows[0].content_digest) !== envelope.contentDigest) {
      throw new Error(`Source object '${envelope.providerObjectId}' reused provider version '${envelope.providerVersion}' with different content.`);
    }
    const unchanged = existing[0]?.current_version === envelope.providerVersion && existing[0]?.deletion_state === "present";
    const retentionUntil = sourceRetentionUntil(envelope.observedAt, retention);
    await sql`insert into companyos_knowledge.source_object_versions (
        source_id, provider_object_id, provider_version, content_digest, envelope, retention_until, first_seen_at, last_seen_at)
      values (${envelope.sourceId}, ${envelope.providerObjectId}, ${envelope.providerVersion}, ${envelope.contentDigest},
        ${JSON.stringify(envelope)}, ${retentionUntil}, ${envelope.observedAt}, ${envelope.observedAt})
      on conflict (source_id, provider_object_id, provider_version) do update
        set last_seen_at = greatest(companyos_knowledge.source_object_versions.last_seen_at, excluded.last_seen_at),
          retention_until = greatest(companyos_knowledge.source_object_versions.retention_until, excluded.retention_until)`;
    await sql`insert into companyos_knowledge.source_inventory (
        source_id, provider_object_id, current_version, deletion_state, last_seen_at, deleted_at)
      values (${envelope.sourceId}, ${envelope.providerObjectId}, ${envelope.providerVersion}, 'present', ${envelope.observedAt}, null)
      on conflict (source_id, provider_object_id) do update set current_version = excluded.current_version,
        deletion_state = 'present', last_seen_at = excluded.last_seen_at, deleted_at = null`;
    return unchanged ? "unchanged" : existing[0] ? "updated" : "inserted";
  }

  async getEnvelope(sourceId: string, providerObjectId: string, providerVersion?: string): Promise<SourceEnvelope | undefined> {
    await ensureCompanyKnowledgeSchema();
    const rows = providerVersion
      ? await connection()`select v.envelope, i.deletion_state, i.current_version from companyos_knowledge.source_object_versions v
          join companyos_knowledge.source_inventory i on i.source_id = v.source_id and i.provider_object_id = v.provider_object_id
          where v.source_id = ${sourceId} and v.provider_object_id = ${providerObjectId} and v.provider_version = ${providerVersion}
            and i.current_version = v.provider_version limit 1`
      : await connection()`select v.envelope, i.deletion_state, i.current_version from companyos_knowledge.source_inventory i
          join companyos_knowledge.source_object_versions v on v.source_id = i.source_id and v.provider_object_id = i.provider_object_id and v.provider_version = i.current_version
          where i.source_id = ${sourceId} and i.provider_object_id = ${providerObjectId} limit 1`;
    if (!rows[0]) return undefined;
    return { ...(rows[0].envelope as unknown as SourceEnvelope), deletionState: rows[0].deletion_state as SourceEnvelope["deletionState"] };
  }

  async reconcileEnvelopes(sourceId: string, presentObjectIds: readonly string[], observedAt: string, retention: SourceRetentionPolicy): Promise<number> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const present = new Set(presentObjectIds);
    const rows = await sql`select provider_object_id, current_version from companyos_knowledge.source_inventory
      where source_id = ${sourceId} and deletion_state = 'present'`;
    let changed = 0;
    const retentionUntil = sourceRetentionUntil(observedAt, retention);
    for (const row of rows) {
      const objectId = String(row.provider_object_id);
      if (present.has(objectId)) continue;
      await sql`update companyos_knowledge.source_inventory set deletion_state = 'deleted', deleted_at = ${observedAt}
        where source_id = ${sourceId} and provider_object_id = ${objectId} and deletion_state = 'present'`;
      await sql`update companyos_knowledge.source_object_versions set retention_until = greatest(retention_until, ${retentionUntil}::timestamptz)
        where source_id = ${sourceId} and provider_object_id = ${objectId} and provider_version = ${String(row.current_version)}`;
      changed += 1;
    }
    return changed;
  }

  async purgeExpiredSourceContent(sourceId: string, now: string): Promise<number> {
    await ensureCompanyKnowledgeSchema();
    if (Number.isNaN(Date.parse(now))) throw new Error("Source retention purge requires an ISO timestamp.");
    const sql = connection();
    const rows = await sql`select v.provider_object_id, v.provider_version, v.content_digest
      from companyos_knowledge.source_object_versions v
      join companyos_knowledge.source_inventory i on i.source_id = v.source_id and i.provider_object_id = v.provider_object_id
      join companyos_knowledge.sources s on s.source_id = v.source_id
      where v.source_id = ${sourceId} and i.deletion_state = 'deleted' and v.retention_until <= ${now}
        and v.envelope ? 'boundedText'
        and coalesce(s.requirement #>> '{retention,mode}', '') <> 'retain'
        and coalesce((s.requirement ->> 'legalHold')::boolean, false) = false`;
    for (const row of rows) {
      const objectId = String(row.provider_object_id);
      const objectVersion = String(row.provider_version);
      const contentDigest = String(row.content_digest);
      await sql`update companyos_knowledge.source_object_versions set envelope = envelope - 'boundedText'
        where source_id = ${sourceId} and provider_object_id = ${objectId} and provider_version = ${objectVersion}`;
      await this.recordReceipt({
        receiptId: sha256({ sourceId, operation: "delete", objectId, objectVersion, contentDigest }),
        sourceId,
        operation: "delete",
        observedAt: now,
        objectId,
        objectVersion,
        evidence: { content_redacted: true, content_digest: contentDigest },
      });
    }
    return rows.length;
  }

  async updateCursor(sourceId: string, cursor: string | undefined, completed: boolean): Promise<void> {
    await ensureCompanyKnowledgeSchema();
    await connection()`update companyos_knowledge.sources set cursor = ${cursor ?? null}, cursor_complete = ${completed}, updated_at = now()
      where source_id = ${sourceId}`;
  }

  async recordSourceHealth(health: SourceHealth): Promise<void> {
    await ensureCompanyKnowledgeSchema();
    await connection()`update companyos_knowledge.sources set status = ${health.status}, health = ${JSON.stringify(health)},
      last_successful_sync = coalesce(${health.lastSuccessfulSync ?? null}, last_successful_sync), updated_at = now() where source_id = ${health.sourceId}`;
  }

  async getSourceHealth(sourceId: string): Promise<SourceHealth | undefined> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select status, health, requirement, last_successful_sync from companyos_knowledge.sources where source_id = ${sourceId} limit 1`;
    if (!rows[0]) return undefined;
    const checkedAt = new Date().toISOString();
    if (rows[0].status === "revoked") return { ok: false, sourceId, status: "revoked", checkedAt, reason: "Source binding is revoked." };
    const requirement = rows[0].requirement as unknown as KnowledgeSourceRequirement;
    const lastSuccessfulSync = rows[0].last_successful_sync ? new Date(String(rows[0].last_successful_sync)).toISOString() : undefined;
    if (!lastSuccessfulSync) return { ok: false, sourceId, status: "error", checkedAt, reason: "Source has no successful synchronization receipt." };
    if (Date.now() - Date.parse(lastSuccessfulSync) > requirement.staleAfterHours * 3_600_000) {
      return { ok: false, sourceId, status: "stale", checkedAt, lastSuccessfulSync, reason: `Last successful synchronization exceeds ${requirement.staleAfterHours} hour(s).` };
    }
    const stored = rows[0].health as unknown as SourceHealth | undefined;
    return { ok: stored?.ok ?? true, sourceId, status: stored?.status === "error" ? "error" : "healthy", checkedAt, lastSuccessfulSync, reason: stored?.reason };
  }

  async revokeSource(sourceId: string, receipt: SourceReceipt): Promise<void> {
    await ensureCompanyKnowledgeSchema();
    await this.recordReceipt(receipt);
    await connection()`update companyos_knowledge.sources set status = 'revoked', cursor = null, cursor_complete = false,
      health = ${JSON.stringify({ ok: false, sourceId, status: "revoked", checkedAt: receipt.observedAt })}, updated_at = now()
      where source_id = ${sourceId}`;
  }

  async recordObservation(observation: RuntimeObservation): Promise<boolean> {
    await ensureCompanyKnowledgeSchema();
    if (observation.personalData !== false) throw new Error("Shared Runtime Observations require personalData: false.");
    const rows = await connection()`insert into companyos_knowledge.runtime_observations (
        observation_id, subject, content, content_digest, observed_at, expires_at, run_id, agent_id, evidence, status, supersedes, personal_data)
      values (${observation.observationId}, ${observation.subject}, ${observation.content}, ${observation.contentDigest}, ${observation.observedAt},
        ${observation.expiresAt ?? null}, ${observation.runId}, ${observation.agentId}, ${JSON.stringify(observation.evidence)}, ${observation.status},
        ${observation.supersedes ?? null}, false) on conflict (observation_id) do nothing returning observation_id`;
    if (rows.length && observation.supersedes) await this.supersedeObservation(observation.supersedes, observation.observationId);
    if (rows.length) await this.#event(observation.observationId, "recorded", observation.agentId, observation.observedAt, { run_id: observation.runId });
    return rows.length > 0;
  }

  async getObservation(observationId: string): Promise<RuntimeObservation | undefined> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select * from companyos_knowledge.runtime_observations where observation_id = ${observationId} limit 1`;
    return rows[0] ? mapObservation(rows[0] as Record<string, unknown>) : undefined;
  }

  async supersedeObservation(observationId: string, replacementId: string): Promise<boolean> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`update companyos_knowledge.runtime_observations set status = 'superseded'
      where observation_id = ${observationId} and status not in ('superseded','deleted')
        and exists (select 1 from companyos_knowledge.runtime_observations where observation_id = ${replacementId})
      returning observation_id`;
    if (rows.length) await this.#event(observationId, "superseded", "system:knowledge", new Date().toISOString(), { replacement_id: replacementId });
    return rows.length > 0;
  }

  async expireObservations(now: string): Promise<number> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`update companyos_knowledge.runtime_observations set status = 'expired'
      where status = 'active' and expires_at is not null and expires_at <= ${now} returning observation_id`;
    for (const row of rows) await this.#event(String(row.observation_id), "expired", "system:knowledge", now, {});
    return rows.length;
  }

  async requestObservationDeletion(observationId: string, requestedBy: string, reason: string): Promise<string> {
    await ensureCompanyKnowledgeSchema();
    if (!requestedBy.trim() || !reason.trim()) throw new Error("Observation deletion requires an attributable requester and reason.");
    const requestedAt = new Date().toISOString();
    const requestId = sha256({ observationId, requestedBy, reason, requestedAt });
    const sql = connection();
    const target = await sql`select observation_id from companyos_knowledge.runtime_observations where observation_id = ${observationId} limit 1`;
    if (!target[0]) throw new Error(`Unknown Runtime Observation '${observationId}'.`);
    await sql`insert into companyos_knowledge.observation_deletion_requests (request_id, observation_id, requested_by, reason, requested_at)
      values (${requestId}, ${observationId}, ${requestedBy}, ${reason}, ${requestedAt}) on conflict (request_id) do nothing`;
    await sql`update companyos_knowledge.runtime_observations set status = 'deletion-requested'
      where observation_id = ${observationId} and status <> 'legal-hold'`;
    await this.#event(observationId, "deletion-requested", requestedBy, requestedAt, { request_id: requestId, reason });
    return requestId;
  }

  async setObservationLegalHold(observationId: string, enabled: boolean, actor: string): Promise<boolean> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const target = await sql`select observation_id, status from companyos_knowledge.runtime_observations where observation_id = ${observationId} and status <> 'deleted' limit 1`;
    if (!target[0]) return false;
    const occurredAt = new Date().toISOString();
    if (enabled) {
      await sql`insert into companyos_knowledge.observation_legal_holds (observation_id, actor, enabled_at, released_at)
        values (${observationId}, ${actor}, ${occurredAt}, null)
        on conflict (observation_id) do update set actor = excluded.actor, enabled_at = excluded.enabled_at, released_at = null`;
      await sql`update companyos_knowledge.runtime_observations set status = 'legal-hold' where observation_id = ${observationId}`;
    } else {
      await sql`update companyos_knowledge.observation_legal_holds set released_at = ${occurredAt} where observation_id = ${observationId} and released_at is null`;
      await sql`update companyos_knowledge.runtime_observations set status = case
          when exists (select 1 from companyos_knowledge.observation_deletion_requests where observation_id = ${observationId} and applied_at is null)
          then 'deletion-requested' else 'active' end where observation_id = ${observationId}`;
    }
    await this.#event(observationId, enabled ? "legal-hold-enabled" : "legal-hold-released", actor, occurredAt, {});
    return true;
  }

  async applyObservationDeletion(observationId: string): Promise<"deleted" | "held" | "missing"> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const rows = await sql`select o.observation_id, o.status,
        exists (select 1 from companyos_knowledge.observation_legal_holds h where h.observation_id = o.observation_id and h.released_at is null) as held,
        exists (select 1 from companyos_knowledge.observation_deletion_requests d where d.observation_id = o.observation_id and d.applied_at is null) as requested
      from companyos_knowledge.runtime_observations o where o.observation_id = ${observationId} limit 1`;
    if (!rows[0]) return "missing";
    if (rows[0].status === "deleted") return "deleted";
    if (rows[0].held === true) return "held";
    if (rows[0].requested !== true) throw new Error(`Runtime Observation '${observationId}' has no deletion request.`);
    const occurredAt = new Date().toISOString();
    await sql`update companyos_knowledge.runtime_observations set content = '', evidence = '{}'::jsonb, status = 'deleted', deleted_at = ${occurredAt}
      where observation_id = ${observationId}`;
    await sql`update companyos_knowledge.observation_deletion_requests set applied_at = ${occurredAt}
      where observation_id = ${observationId} and applied_at is null`;
    await this.#event(observationId, "deleted", "system:knowledge", occurredAt, { content_redacted: true });
    return "deleted";
  }

  async listObservationPromotionCandidates(limit = 3): Promise<RuntimeObservation[]> {
    await ensureCompanyKnowledgeSchema();
    const bounded = Math.max(1, Math.min(limit, 3));
    const rows = await connection()`select * from companyos_knowledge.runtime_observations
      where status = 'active' order by observed_at, observation_id limit ${bounded}`;
    return rows.map((row) => mapObservation(row as Record<string, unknown>));
  }

  async #event(observationId: string, eventType: string, actor: string, occurredAt: string, evidence: Record<string, unknown>): Promise<void> {
    const eventId = sha256({ observationId, eventType, actor, occurredAt, evidence });
    await connection()`insert into companyos_knowledge.observation_events (event_id, observation_id, event_type, actor, occurred_at, evidence)
      values (${eventId}, ${observationId}, ${eventType}, ${actor}, ${occurredAt}, ${JSON.stringify(evidence)}) on conflict (event_id) do nothing`;
  }
}
