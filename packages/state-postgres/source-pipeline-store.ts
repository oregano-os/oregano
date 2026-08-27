import { createHash } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { canonicalJson, sha256 } from "../runtime/canonical.ts";
import type { KnowledgeAccessPolicy } from "../knowledge/contracts.ts";
import { SOURCE_CONNECTOR_V2_CONTRACT_VERSION, adaptRepositorySourceV1 } from "../knowledge/source-contracts-v2.ts";
import type {
  RawAssetReferenceV2,
  SourceAccessSnapshotV2,
  SourceBindingV2,
  SourceEventV2,
  SourceReceiptV2,
  SourceRequirementV2,
} from "../knowledge/source-contracts-v2.ts";
import type {
  SourceChangeEntryV2,
  SourceEventInsertResult,
  SourceEventRecordV2,
  SourceEvidenceWriteResult,
  SourceLifecycleRequestV2,
  SourceLifecycleTargetKind,
  SourceInventoryObjectV2,
  SourcePipelineFailureClass,
  SourcePipelineStore,
  SourceRawEvidenceV2,
  SourceWatermarkV2,
} from "../knowledge/source-pipeline-store.ts";
import { ensureCompanyKnowledgeSchema } from "./knowledge-migrate.ts";
import { postgresInlineRawAssetStorageKey } from "./raw-asset-adapter.ts";

const connection = () => {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is not set — the Source pipeline uses the existing Company Instance database.");
  return neon(value);
};

const optionalString = (value: unknown): string | undefined => value === undefined || value === null ? undefined : String(value);
const iso = (value: unknown): string => new Date(String(value)).toISOString();

export function assertPermittedSourceRebinding(input: {
  existingRequirement: SourceRequirementV2;
  existingBinding: SourceBindingV2;
  nextRequirement: SourceRequirementV2;
  nextBinding: SourceBindingV2;
}): "unchanged" | "rebind" {
  if (canonicalJson(input.existingRequirement) !== canonicalJson(input.nextRequirement)) {
    throw new Error(`Source '${input.nextRequirement.sourceId}' conflicts with an existing requirement.`);
  }
  if (canonicalJson(input.existingBinding) === canonicalJson(input.nextBinding)) return "unchanged";
  if (input.existingBinding.state === "revoked" || input.nextBinding.state !== "active" || !input.nextBinding.qualification) {
    throw new Error(`Source '${input.nextRequirement.sourceId}' requires a newly qualified active binding for rebinding.`);
  }
  const existingIdentity = {
    sourceId: input.existingBinding.sourceId,
    installationId: input.existingBinding.installationId,
    connectorId: input.existingBinding.connectorId,
    connectorVersion: input.existingBinding.connectorVersion,
    providerIdentity: input.existingBinding.providerIdentity,
  };
  const nextIdentity = {
    sourceId: input.nextBinding.sourceId,
    installationId: input.nextBinding.installationId,
    connectorId: input.nextBinding.connectorId,
    connectorVersion: input.nextBinding.connectorVersion,
    providerIdentity: input.nextBinding.providerIdentity,
  };
  if (canonicalJson(existingIdentity) !== canonicalJson(nextIdentity)) {
    throw new Error(`Source '${input.nextRequirement.sourceId}' rebinding cannot change Connector, installation, or provider identity.`);
  }
  return "rebind";
}

export const mapStoredSourceRawEvidence = (row: Record<string, unknown>): SourceRawEvidenceV2 => {
  const stored = row.envelope as Record<string, unknown>;
  if (stored && typeof stored === "object" && stored.envelope && typeof stored.envelope === "object") {
    const evidence = stored as unknown as SourceRawEvidenceV2;
    const accessPolicyId = optionalString(row.access_policy_id) ?? evidence.envelope.accessPolicyId;
    const access = row.provider_acl && typeof row.provider_acl === "object"
      ? row.provider_acl as unknown as SourceAccessSnapshotV2
      : evidence.access;
    return {
      ...evidence,
      envelope: {
        ...evidence.envelope,
        accessPolicyId,
        ...(row.deletion_state ? { deletionState: row.deletion_state as "present" | "deleted" } : {}),
      },
      access,
      modelReady: (row.model_ready ?? evidence.modelReady) === true
        && row.deletion_state !== "deleted"
        && (row.payload_state ?? evidence.payloadState) === "active"
        && accessPolicyId !== "policy:quarantine",
      payloadState: (row.payload_state ?? evidence.payloadState) as SourceRawEvidenceV2["payloadState"],
      redactedAt: row.redacted_at ? iso(row.redacted_at) : evidence.redactedAt,
    };
  }

  const sourceId = optionalString(row.source_id) ?? String(stored.sourceId);
  const providerObjectId = optionalString(row.provider_object_id) ?? String(stored.providerObjectId);
  const providerVersion = optionalString(row.provider_version) ?? String(stored.providerVersion);
  const observedAt = stored.observedAt ? iso(stored.observedAt) : iso(row.first_seen_at);
  const accessPolicyId = optionalString(row.access_policy_id) ?? "policy:quarantine";
  const providerAccessVersion = optionalString(row.provider_access_version)
    ?? sha256({ sourceId, providerObjectId, accessPolicyId, legacy: true });
  const access = row.provider_acl && typeof row.provider_acl === "object" && (row.provider_acl as Record<string, unknown>).contractVersion === "2.0.0"
    ? row.provider_acl as unknown as SourceAccessSnapshotV2
    : {
        contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
        sourceId,
        providerObjectId,
        providerAccessVersion,
        observedAt,
        entries: [],
        evidenceDigest: sha256({ sourceId, providerObjectId, providerAccessVersion, legacy: true }),
      };
  const inlineText = typeof stored.boundedText === "string" ? stored.boundedText : undefined;
  const payloadState = (row.payload_state ?? (inlineText === undefined ? "purged" : "active")) as SourceRawEvidenceV2["payloadState"];
  return {
    envelope: {
      contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
      sourceId,
      providerTenantId: optionalString(row.provider_tenant_id) ?? optionalString(stored.ownerOrAccount) ?? `legacy:${sourceId}`,
      providerObjectId,
      providerVersion,
      eventId: optionalString(row.event_id) ?? sha256({ sourceId, providerObjectId, providerVersion, legacy: true }),
      observedAt,
      locator: optionalString(row.provider_locator) ?? providerObjectId,
      mediaType: (optionalString(row.mime_type) ?? stored.mediaType ?? "text/markdown") as SourceRawEvidenceV2["envelope"]["mediaType"],
      size: Number(row.byte_size ?? (inlineText === undefined ? 0 : Buffer.byteLength(inlineText))),
      contentDigest: optionalString(row.content_digest) ?? String(stored.contentDigest),
      accessPolicyId,
      deletionState: (row.deletion_state ?? stored.deletionState ?? "present") as "present" | "deleted",
    },
    ...(inlineText === undefined ? {} : { content: { inlineText } }),
    access,
    sanityCodes: Array.isArray(row.sanity_codes) ? row.sanity_codes.map(String) : ["legacy-v1-envelope"],
    modelReady: row.model_ready === true && row.deletion_state !== "deleted" && payloadState === "active" && accessPolicyId !== "policy:quarantine",
    payloadState,
    retentionUntil: row.retention_until ? iso(row.retention_until) : "9999-12-31T23:59:59.999Z",
    recordedAt: row.first_seen_at ? iso(row.first_seen_at) : observedAt,
    ...(row.redacted_at ? { redactedAt: iso(row.redacted_at) } : {}),
  };
};

const mapEvent = (row: Record<string, unknown>): SourceEventRecordV2 => ({
  event: row.event as unknown as SourceEventV2,
  status: row.status as SourceEventRecordV2["status"],
  attempt: Number(row.attempt),
  leaseOwner: optionalString(row.lease_owner),
  leaseUntil: row.lease_until ? iso(row.lease_until) : undefined,
  failureClass: optionalString(row.failure_class) as SourcePipelineFailureClass | undefined,
  retryAfter: row.retry_after ? iso(row.retry_after) : undefined,
  completedAt: row.completed_at ? iso(row.completed_at) : undefined,
});

const mapWatermark = (row: Record<string, unknown>): SourceWatermarkV2 => ({
  sourceId: String(row.source_id),
  streamId: String(row.stream_id),
  cursor: optionalString(row.cursor_value),
  watermark: optionalString(row.watermark_value),
  completed: row.completed === true,
  stateDigest: String(row.state_digest),
  updatedAt: iso(row.updated_at),
});

const mapLifecycle = (row: Record<string, unknown>): SourceLifecycleRequestV2 => ({
  requestId: String(row.request_id),
  sourceId: String(row.source_id),
  targetKind: row.target_kind as SourceLifecycleRequestV2["targetKind"],
  targetId: String(row.target_id),
  targetVersion: optionalString(row.target_version),
  requestedBy: String(row.requested_by),
  reason: String(row.reason),
  requestedAt: iso(row.requested_at),
  purgeAfter: iso(row.purge_after),
  dependencyIds: row.dependency_ids as unknown as string[],
  accessPolicyId: String(row.access_policy_id),
  status: row.status as SourceLifecycleRequestV2["status"],
  legalHold: row.legal_hold === true,
  restoredAt: row.restored_at ? iso(row.restored_at) : undefined,
  purgedAt: row.purged_at ? iso(row.purged_at) : undefined,
  receiptId: String(row.receipt_id),
});

export class PostgresSourcePipelineStore implements SourcePipelineStore {
  async registerSource(requirement: SourceRequirementV2, binding: SourceBindingV2): Promise<void> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const existing = await sql`select connector_id, connector_version, requirement, binding, status
      from companyos_knowledge.sources where source_id = ${requirement.sourceId} limit 1`;
    if (existing[0]) {
      if (existing[0].status === "revoked") throw new Error(`Source '${requirement.sourceId}' is revoked.`);
      if (existing[0].connector_id !== binding.connectorId || existing[0].connector_version !== binding.connectorVersion) throw new Error(`Source '${requirement.sourceId}' conflicts with an existing Connector identity.`);
      let storedRequirement = existing[0].requirement as unknown;
      let storedBinding = existing[0].binding as unknown;
      if ((storedRequirement as { version?: number })?.version === 1 && (storedBinding as { version?: number })?.version === 1) {
        const adapted = adaptRepositorySourceV1(storedRequirement as Parameters<typeof adaptRepositorySourceV1>[0], storedBinding as Parameters<typeof adaptRepositorySourceV1>[1]);
        storedRequirement = adapted.requirement;
        storedBinding = adapted.binding;
      }
      const outcome = assertPermittedSourceRebinding({
        existingRequirement: storedRequirement as SourceRequirementV2,
        existingBinding: storedBinding as SourceBindingV2,
        nextRequirement: requirement,
        nextBinding: binding,
      });
      if (outcome === "rebind") {
        const rows = await sql`update companyos_knowledge.sources
          set binding = ${JSON.stringify(binding)}, updated_at = now()
          where source_id = ${requirement.sourceId} and binding = ${JSON.stringify(existing[0].binding)}::jsonb
            and status <> 'revoked'
          returning source_id`;
        if (rows.length === 0) throw new Error(`Source '${requirement.sourceId}' changed concurrently during rebinding.`);
      }
      return;
    }
    const rows = await sql`insert into companyos_knowledge.sources (
        source_id, connector_id, connector_version, requirement, binding, status, access_policy_id, provider_acl)
      values (${requirement.sourceId}, ${binding.connectorId}, ${binding.connectorVersion}, ${JSON.stringify(requirement)},
        ${JSON.stringify(binding)}, ${binding.state === "revoked" ? "revoked" : "registered"},
        ${requirement.access.mode === "provider-acl" ? requirement.access.rootPolicyId : requirement.access.rootPolicyId},
        ${JSON.stringify({ mode: requirement.access.mode })})
      returning source_id`;
    if (rows.length === 0) throw new Error(`Source '${requirement.sourceId}' conflicts with an existing registration.`);
  }

  async setSourceStatus(sourceId: string, status: "registered" | "healthy" | "stale" | "error" | "revoked"): Promise<void> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`update companyos_knowledge.sources set status = ${status}, updated_at = now()
      where source_id = ${sourceId} returning source_id`;
    if (rows.length === 0) throw new Error(`Unknown Source '${sourceId}'.`);
  }

  async putEvent(event: SourceEventV2): Promise<SourceEventInsertResult> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    try {
      const rows = await sql`insert into companyos_knowledge.source_events (
          event_id, source_id, delivery_id, provider_tenant_id, event_type, provider_object_id,
          provider_version, occurred_at, observed_at, event, status)
        values (${event.eventId}, ${event.sourceId}, ${event.deliveryId}, ${event.providerTenantId}, ${event.eventType},
          ${event.providerObjectId}, ${event.providerVersion ?? null}, ${event.occurredAt}, ${event.observedAt},
          ${JSON.stringify(event)}, 'received')
        on conflict (event_id) do update set event_id = excluded.event_id
        where companyos_knowledge.source_events.event = excluded.event
          and companyos_knowledge.source_events.delivery_id = excluded.delivery_id
        returning (xmax = 0) as inserted`;
      if (rows.length === 0) throw new Error(`Source event '${event.eventId}' was reused with different content.`);
      return rows[0]?.inserted === true ? "inserted" : "unchanged";
    } catch (error) {
      if (error instanceof Error && /source_events_source_id_delivery_id_key|duplicate key/i.test(error.message)) throw new Error(`Source delivery '${event.deliveryId}' was reused with different canonical event content.`);
      throw error;
    }
  }

  async getEvent(eventId: string): Promise<SourceEventRecordV2 | undefined> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select * from companyos_knowledge.source_events where event_id = ${eventId} limit 1`;
    return rows[0] ? mapEvent(rows[0] as Record<string, unknown>) : undefined;
  }

  async claimEvent(input: { eventId: string; workerId: string; leaseUntil: string; now: string; maxAttempts: number }): Promise<"claimed" | "complete" | "busy" | "exhausted"> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const rows = await sql`update companyos_knowledge.source_events set
        status = 'leased', attempt = attempt + 1, lease_owner = ${input.workerId}, lease_until = ${input.leaseUntil},
        failure_class = null, retry_after = null
      where event_id = ${input.eventId}
        and status not in ('processed','quarantined')
        and attempt < ${input.maxAttempts}
        and (status <> 'leased' or lease_until is null or lease_until <= ${input.now})
        and (retry_after is null or retry_after <= ${input.now})
      returning event_id`;
    if (rows.length > 0) return "claimed";
    const current = await sql`select status, attempt, lease_until, retry_after from companyos_knowledge.source_events where event_id = ${input.eventId} limit 1`;
    if (!current[0]) throw new Error(`Unknown Source event '${input.eventId}'.`);
    if (["processed", "quarantined"].includes(String(current[0].status))) return "complete";
    if (Number(current[0].attempt) >= input.maxAttempts) return "exhausted";
    return "busy";
  }

  async completeEvent(eventId: string, status: "processed" | "quarantined", completedAt: string): Promise<void> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`update companyos_knowledge.source_events set status = ${status}, completed_at = ${completedAt},
      lease_owner = null, lease_until = null where event_id = ${eventId} returning event_id`;
    if (rows.length === 0) throw new Error(`Unknown Source event '${eventId}'.`);
  }

  async failEvent(eventId: string, failureClass: SourcePipelineFailureClass, retryAfter: string): Promise<void> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`update companyos_knowledge.source_events set status = 'failed',
      failure_class = ${failureClass}, retry_after = ${retryAfter}, lease_owner = null, lease_until = null
      where event_id = ${eventId} returning event_id`;
    if (rows.length === 0) throw new Error(`Unknown Source event '${eventId}'.`);
  }

  async putPolicy(policy: KnowledgeAccessPolicy, evidenceDigest: string): Promise<SourceEvidenceWriteResult> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const result = await sql.transaction((tx) => [
      tx`insert into companyos_knowledge.acl_policies (
          policy_id, policy_version, visibility, parent_policy_id, source_root, status, definition, created_by)
        values (${policy.policyId}, ${policy.policyVersion}, ${policy.visibility}, ${policy.parentPolicyId ?? null},
          ${policy.sourceRoot}, ${policy.status}, ${JSON.stringify({ policy, evidenceDigest })}, 'system:source-pipeline')
        on conflict (policy_id) do update set policy_id = excluded.policy_id
        where companyos_knowledge.acl_policies.policy_version = excluded.policy_version
          and companyos_knowledge.acl_policies.visibility = excluded.visibility
          and companyos_knowledge.acl_policies.parent_policy_id is not distinct from excluded.parent_policy_id
          and companyos_knowledge.acl_policies.source_root = excluded.source_root
          and companyos_knowledge.acl_policies.status = excluded.status
        returning (xmax = 0) as inserted`,
      ...policy.entries.map((entry) => {
        const entryId = sha256({ policyId: policy.policyId, ...entry });
        return tx`insert into companyos_knowledge.acl_entries (
            entry_id, policy_id, subject_kind, subject_id, permission, effect, evidence)
          values (${entryId}, ${policy.policyId}, ${entry.subjectKind}, ${entry.subjectId}, ${entry.permission},
            ${entry.effect}, ${JSON.stringify({ evidence_digest: evidenceDigest })})
          on conflict (entry_id) do update set entry_id = excluded.entry_id
          where companyos_knowledge.acl_entries.policy_id = excluded.policy_id
            and companyos_knowledge.acl_entries.subject_kind = excluded.subject_kind
            and companyos_knowledge.acl_entries.subject_id = excluded.subject_id
            and companyos_knowledge.acl_entries.permission = excluded.permission
            and companyos_knowledge.acl_entries.effect = excluded.effect
          returning entry_id`;
      }),
    ], { isolationLevel: "Serializable" });
    if (result.some((rows) => rows.length === 0)) throw new Error(`Source policy '${policy.policyId}' conflicts with existing policy state.`);
    return result[0][0]?.inserted === true ? "inserted" : "unchanged";
  }

  async getPolicy(policyId: string): Promise<KnowledgeAccessPolicy | undefined> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const policies = await sql`select * from companyos_knowledge.acl_policies where policy_id = ${policyId} limit 1`;
    if (!policies[0]) return undefined;
    const entries = await sql`select subject_kind, subject_id, permission, effect from companyos_knowledge.acl_entries
      where policy_id = ${policyId} order by subject_kind, subject_id, permission, effect`;
    return {
      policyId,
      policyVersion: Number(policies[0].policy_version),
      visibility: policies[0].visibility as KnowledgeAccessPolicy["visibility"],
      parentPolicyId: optionalString(policies[0].parent_policy_id),
      sourceRoot: policies[0].source_root === true,
      status: policies[0].status as KnowledgeAccessPolicy["status"],
      entries: entries.map((entry) => ({
        subjectKind: entry.subject_kind as "principal" | "group",
        subjectId: String(entry.subject_id),
        permission: entry.permission as KnowledgeAccessPolicy["entries"][number]["permission"],
        effect: entry.effect as "allow" | "deny",
      })),
    };
  }

  async putAccessSnapshot(snapshot: SourceAccessSnapshotV2): Promise<SourceEvidenceWriteResult> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`insert into companyos_knowledge.source_acl_snapshots (
        source_id, provider_object_id, provider_access_version, observed_at, evidence_digest, snapshot)
      values (${snapshot.sourceId}, ${snapshot.providerObjectId}, ${snapshot.providerAccessVersion}, ${snapshot.observedAt},
        ${snapshot.evidenceDigest}, ${JSON.stringify(snapshot)})
      on conflict (source_id, provider_object_id, provider_access_version) do update set source_id = excluded.source_id
      where companyos_knowledge.source_acl_snapshots.snapshot = excluded.snapshot
        and companyos_knowledge.source_acl_snapshots.evidence_digest = excluded.evidence_digest
      returning (xmax = 0) as inserted`;
    if (rows.length === 0) throw new Error(`Source ACL snapshot '${snapshot.providerAccessVersion}' conflicts with existing content.`);
    return rows[0]?.inserted === true ? "inserted" : "unchanged";
  }

  async putRawEvidence(evidence: SourceRawEvidenceV2): Promise<SourceEvidenceWriteResult> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const serialized = JSON.stringify(evidence);
    const rows = await sql.transaction((tx) => [
      tx`insert into companyos_knowledge.source_object_versions (
          source_id, provider_object_id, provider_version, content_digest, envelope, retention_until,
          first_seen_at, last_seen_at, access_policy_id, provider_acl, provider_locator, byte_size,
          mime_type, encoding, event_id, provider_tenant_id, provider_access_version, sanity_codes,
          model_ready, payload_state, redacted_at)
        values (${evidence.envelope.sourceId}, ${evidence.envelope.providerObjectId}, ${evidence.envelope.providerVersion},
          ${evidence.envelope.contentDigest}, ${serialized}, ${evidence.retentionUntil}, ${evidence.recordedAt}, ${evidence.recordedAt},
          ${evidence.envelope.accessPolicyId}, ${JSON.stringify(evidence.access)}, ${evidence.envelope.locator}, ${evidence.envelope.size},
          ${evidence.envelope.mediaType}, ${"inlineText" in (evidence.content ?? {}) ? "utf-8" : null}, ${evidence.envelope.eventId},
          ${evidence.envelope.providerTenantId}, ${evidence.access.providerAccessVersion}, ${JSON.stringify(evidence.sanityCodes)},
          ${evidence.modelReady}, ${evidence.payloadState}, ${evidence.redactedAt ?? null})
        on conflict (source_id, provider_object_id, provider_version) do update set
          last_seen_at = greatest(companyos_knowledge.source_object_versions.last_seen_at, excluded.last_seen_at),
          access_policy_id = excluded.access_policy_id,
          provider_acl = excluded.provider_acl,
          provider_access_version = excluded.provider_access_version,
          sanity_codes = excluded.sanity_codes,
          model_ready = excluded.model_ready
        where companyos_knowledge.source_object_versions.content_digest = excluded.content_digest
        returning (xmax = 0) as inserted`,
      tx`insert into companyos_knowledge.source_inventory (
          source_id, provider_object_id, current_version, deletion_state, last_seen_at, deleted_at)
        values (${evidence.envelope.sourceId}, ${evidence.envelope.providerObjectId}, ${evidence.envelope.providerVersion},
          'present', ${evidence.envelope.observedAt}, null)
        on conflict (source_id, provider_object_id) do update set current_version = excluded.current_version,
          deletion_state = 'present', last_seen_at = excluded.last_seen_at, deleted_at = null
        returning provider_object_id`,
    ], { isolationLevel: "Serializable" });
    if (rows[0].length === 0) throw new Error(`Source object '${evidence.envelope.providerObjectId}' reused provider version '${evidence.envelope.providerVersion}' with different evidence.`);
    return rows[0][0]?.inserted === true ? "inserted" : "unchanged";
  }

  async getRawEvidence(sourceId: string, providerObjectId: string, providerVersion?: string): Promise<SourceRawEvidenceV2 | undefined> {
    await ensureCompanyKnowledgeSchema();
    const rows = providerVersion
      ? await connection()`select v.* from companyos_knowledge.source_object_versions v
          where v.source_id = ${sourceId} and v.provider_object_id = ${providerObjectId} and v.provider_version = ${providerVersion} limit 1`
      : await connection()`select v.*, i.deletion_state from companyos_knowledge.source_inventory i
          join companyos_knowledge.source_object_versions v on v.source_id = i.source_id
            and v.provider_object_id = i.provider_object_id and v.provider_version = i.current_version
          where i.source_id = ${sourceId} and i.provider_object_id = ${providerObjectId} limit 1`;
    return rows[0] ? mapStoredSourceRawEvidence(rows[0] as Record<string, unknown>) : undefined;
  }

  async currentRawEvidence(sourceId: string, providerObjectId: string): Promise<SourceRawEvidenceV2 | undefined> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select v.*, i.deletion_state
      from companyos_knowledge.source_inventory i
      join companyos_knowledge.source_object_versions v on v.source_id = i.source_id
        and v.provider_object_id = i.provider_object_id and v.provider_version = i.current_version
      where i.source_id = ${sourceId} and i.provider_object_id = ${providerObjectId} limit 1`;
    if (!rows[0]) return undefined;
    return mapStoredSourceRawEvidence(rows[0] as Record<string, unknown>);
  }

  async listCurrentSourceObjects(sourceId: string): Promise<SourceInventoryObjectV2[]> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select provider_object_id, current_version, deletion_state, last_seen_at
      from companyos_knowledge.source_inventory where source_id = ${sourceId} order by provider_object_id`;
    return rows.map((row) => ({
      providerObjectId: String(row.provider_object_id),
      providerVersion: String(row.current_version),
      deletionState: row.deletion_state as "present" | "deleted",
      observedAt: iso(row.last_seen_at),
    }));
  }

  async markProviderDeleted(input: { sourceId: string; providerObjectId: string; observedAt: string; eventId: string }): Promise<"deleted" | "unchanged" | "missing"> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const target = await sql`select deletion_state from companyos_knowledge.source_inventory where source_id = ${input.sourceId} and provider_object_id = ${input.providerObjectId} limit 1`;
    if (!target[0]) return "missing";
    if (target[0].deletion_state === "deleted") return "unchanged";
    await sql`update companyos_knowledge.source_inventory set deletion_state = 'deleted', deleted_at = ${input.observedAt}, last_seen_at = ${input.observedAt}
      where source_id = ${input.sourceId} and provider_object_id = ${input.providerObjectId}`;
    return "deleted";
  }

  async updateObjectAccess(input: { sourceId: string; providerObjectId: string; access: SourceAccessSnapshotV2; accessPolicyId: string; observedAt: string }): Promise<"updated" | "unchanged" | "missing"> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const target = await sql`select v.access_policy_id, v.provider_acl from companyos_knowledge.source_inventory i
      join companyos_knowledge.source_object_versions v on v.source_id = i.source_id and v.provider_object_id = i.provider_object_id and v.provider_version = i.current_version
      where i.source_id = ${input.sourceId} and i.provider_object_id = ${input.providerObjectId} limit 1`;
    if (!target[0]) return "missing";
    if (target[0].access_policy_id === input.accessPolicyId && canonicalJson(target[0].provider_acl) === canonicalJson(input.access)) return "unchanged";
    await sql`update companyos_knowledge.source_object_versions v set access_policy_id = ${input.accessPolicyId},
        provider_acl = ${JSON.stringify(input.access)}, provider_access_version = ${input.access.providerAccessVersion},
        model_ready = model_ready and ${input.accessPolicyId !== "policy:quarantine"}
      from companyos_knowledge.source_inventory i
      where i.source_id = ${input.sourceId} and i.provider_object_id = ${input.providerObjectId}
        and v.source_id = i.source_id and v.provider_object_id = i.provider_object_id and v.provider_version = i.current_version`;
    return "updated";
  }

  async putRawAsset(reference: RawAssetReferenceV2, input: { sourceId: string; providerObjectId: string; providerVersion: string; accessPolicyId: string; retentionClass: "durable" | "session-temporary" }, payload?: Uint8Array): Promise<SourceEvidenceWriteResult> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    let rows;
    if (payload) {
      if (reference.storageKey !== postgresInlineRawAssetStorageKey(reference.assetId)) throw new Error(`Raw Asset '${reference.assetId}' does not use the qualified Postgres inline storage key.`);
      const actualDigest = createHash("sha256").update(payload).digest("hex");
      if (payload.byteLength !== reference.size || actualDigest !== reference.contentDigest) throw new Error(`Raw Asset '${reference.assetId}' payload does not match its reference.`);
      const payloadHex = Buffer.from(payload).toString("hex");
      rows = await sql`insert into companyos_knowledge.raw_assets (
          asset_id, source_id, provider_object_id, provider_version, content_digest, byte_size, mime_type,
          encoding, inline_content, storage_pointer, access_policy_id, retention_class, lifecycle_status)
        values (${reference.assetId}, ${input.sourceId}, ${input.providerObjectId}, ${input.providerVersion},
          ${reference.contentDigest}, ${reference.size}, ${reference.mediaType}, 'utf-8', decode(${payloadHex}, 'hex'), null,
          ${input.accessPolicyId}, ${input.retentionClass}, 'active')
        on conflict (asset_id) do update set asset_id = excluded.asset_id
        where companyos_knowledge.raw_assets.source_id = excluded.source_id
          and companyos_knowledge.raw_assets.provider_object_id = excluded.provider_object_id
          and companyos_knowledge.raw_assets.provider_version = excluded.provider_version
          and companyos_knowledge.raw_assets.content_digest = excluded.content_digest
          and companyos_knowledge.raw_assets.byte_size = excluded.byte_size
          and companyos_knowledge.raw_assets.mime_type = excluded.mime_type
          and companyos_knowledge.raw_assets.encoding = excluded.encoding
          and companyos_knowledge.raw_assets.inline_content = excluded.inline_content
          and companyos_knowledge.raw_assets.storage_pointer is null
          and companyos_knowledge.raw_assets.access_policy_id = excluded.access_policy_id
          and companyos_knowledge.raw_assets.retention_class = excluded.retention_class
        returning (xmax = 0) as inserted`;
    } else {
      rows = await sql`insert into companyos_knowledge.raw_assets (
          asset_id, source_id, provider_object_id, provider_version, content_digest, byte_size, mime_type,
          storage_pointer, access_policy_id, retention_class, lifecycle_status)
        values (${reference.assetId}, ${input.sourceId}, ${input.providerObjectId}, ${input.providerVersion},
          ${reference.contentDigest}, ${reference.size}, ${reference.mediaType}, ${JSON.stringify({ storageKey: reference.storageKey })},
          ${input.accessPolicyId}, ${input.retentionClass}, 'active')
        on conflict (asset_id) do update set asset_id = excluded.asset_id
        where companyos_knowledge.raw_assets.source_id = excluded.source_id
          and companyos_knowledge.raw_assets.provider_object_id = excluded.provider_object_id
          and companyos_knowledge.raw_assets.provider_version = excluded.provider_version
          and companyos_knowledge.raw_assets.content_digest = excluded.content_digest
          and companyos_knowledge.raw_assets.byte_size = excluded.byte_size
          and companyos_knowledge.raw_assets.mime_type = excluded.mime_type
          and companyos_knowledge.raw_assets.storage_pointer = excluded.storage_pointer
          and companyos_knowledge.raw_assets.inline_content is null
          and companyos_knowledge.raw_assets.access_policy_id = excluded.access_policy_id
          and companyos_knowledge.raw_assets.retention_class = excluded.retention_class
        returning (xmax = 0) as inserted`;
    }
    if (rows.length === 0) throw new Error(`Raw Asset '${reference.assetId}' conflicts with existing content.`);
    return rows[0]?.inserted === true ? "inserted" : "unchanged";
  }

  async getRawAsset(assetId: string): Promise<RawAssetReferenceV2 | undefined> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select asset_id, content_digest, mime_type, byte_size, storage_pointer,
        inline_content is not null as inline_content_present, lifecycle_status
      from companyos_knowledge.raw_assets where asset_id = ${assetId} limit 1`;
    if (!rows[0] || rows[0].lifecycle_status === "deleted") return undefined;
    const pointer = rows[0].storage_pointer as unknown as { storageKey?: string } | null;
    const storageKey = rows[0].inline_content_present === true
      ? postgresInlineRawAssetStorageKey(String(rows[0].asset_id))
      : pointer?.storageKey;
    if (!storageKey) return undefined;
    return { assetId: String(rows[0].asset_id), contentDigest: String(rows[0].content_digest), mediaType: rows[0].mime_type as RawAssetReferenceV2["mediaType"], size: Number(rows[0].byte_size), storageKey };
  }

  async putReceipt(receipt: SourceReceiptV2): Promise<SourceEvidenceWriteResult> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`insert into companyos_knowledge.source_pipeline_receipts (
        receipt_id, source_id, connector_id, connector_version, operation, outcome, observed_at, evidence_digest, receipt)
      values (${receipt.receiptId}, ${receipt.sourceId}, ${receipt.connectorId}, ${receipt.connectorVersion},
        ${receipt.operation}, ${receipt.outcome}, ${receipt.observedAt}, ${receipt.evidenceDigest}, ${JSON.stringify(receipt)})
      on conflict (receipt_id) do update set receipt_id = excluded.receipt_id
      where companyos_knowledge.source_pipeline_receipts.receipt = excluded.receipt
      returning (xmax = 0) as inserted`;
    if (rows.length === 0) throw new Error(`Source receipt '${receipt.receiptId}' conflicts with existing content.`);
    return rows[0]?.inserted === true ? "inserted" : "unchanged";
  }

  async appendChange(entry: Omit<SourceChangeEntryV2, "sequence" | "previousDigest" | "chainDigest">): Promise<SourceChangeEntryV2> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const existing = await sql`select * from companyos_knowledge.knowledge_change_stream where change_id = ${entry.changeId} limit 1`;
    if (existing[0]) {
      const mapped = this.#mapChange(existing[0] as Record<string, unknown>);
      const { sequence: _sequence, previousDigest: _previousDigest, chainDigest: _chainDigest, ...comparable } = mapped;
      if (canonicalJson(comparable) !== canonicalJson(entry)) throw new Error(`Source change '${entry.changeId}' conflicts with existing content.`);
      return mapped;
    }
    const previous = await sql`select sequence, chain_digest from companyos_knowledge.knowledge_change_stream order by sequence desc limit 1`;
    const sequence = previous[0] ? Number(previous[0].sequence) + 1 : 1;
    const previousDigest = previous[0] ? String(previous[0].chain_digest) : undefined;
    const chainDigest = sha256({ sequence, previousDigest, ...entry });
    const rows = await sql`insert into companyos_knowledge.knowledge_change_stream (
        sequence, change_id, previous_digest, chain_digest, source_id, object_kind, object_id, object_version,
        change_kind, access_policy_id, payload_digest, receipt_id, occurred_at)
      overriding system value values (${sequence}, ${entry.changeId}, ${previousDigest ?? null}, ${chainDigest}, ${entry.sourceId},
        ${entry.objectKind}, ${entry.objectId}, ${entry.objectVersion ?? null}, ${entry.changeKind}, ${entry.accessPolicyId},
        ${entry.payloadDigest}, ${entry.receiptId}, ${entry.occurredAt}) returning *`;
    return this.#mapChange(rows[0] as Record<string, unknown>);
  }

  async listChanges(input: { afterSequence?: number; limit: number }): Promise<SourceChangeEntryV2[]> {
    await ensureCompanyKnowledgeSchema();
    const limit = Math.max(1, Math.min(input.limit, 1_000));
    const rows = await connection()`select * from companyos_knowledge.knowledge_change_stream
      where sequence > ${input.afterSequence ?? 0} order by sequence limit ${limit}`;
    return rows.map((row) => this.#mapChange(row as Record<string, unknown>));
  }

  async getWatermark(sourceId: string, streamId: string): Promise<SourceWatermarkV2 | undefined> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select * from companyos_knowledge.source_watermarks where source_id = ${sourceId} and stream_id = ${streamId} limit 1`;
    return rows[0] ? mapWatermark(rows[0] as Record<string, unknown>) : undefined;
  }

  async advanceWatermark(watermark: SourceWatermarkV2): Promise<"advanced" | "unchanged"> {
    await ensureCompanyKnowledgeSchema();
    const expected = sha256({ sourceId: watermark.sourceId, streamId: watermark.streamId, cursor: watermark.cursor, watermark: watermark.watermark, completed: watermark.completed, updatedAt: watermark.updatedAt });
    if (expected !== watermark.stateDigest) throw new Error(`Source watermark '${watermark.streamId}' has an invalid state digest.`);
    const rows = await connection()`insert into companyos_knowledge.source_watermarks (
        source_id, stream_id, cursor_value, watermark_value, completed, state_digest, updated_at)
      values (${watermark.sourceId}, ${watermark.streamId}, ${watermark.cursor ?? null}, ${watermark.watermark ?? null},
        ${watermark.completed}, ${watermark.stateDigest}, ${watermark.updatedAt})
      on conflict (source_id, stream_id) do update set cursor_value = excluded.cursor_value,
        watermark_value = excluded.watermark_value, completed = excluded.completed,
        state_digest = excluded.state_digest, updated_at = excluded.updated_at
      where companyos_knowledge.source_watermarks.updated_at <= excluded.updated_at
        and companyos_knowledge.source_watermarks.state_digest <> excluded.state_digest
      returning (xmax = 0) as inserted`;
    if (rows.length > 0) return "advanced";
    const current = await this.getWatermark(watermark.sourceId, watermark.streamId);
    if (current?.stateDigest === watermark.stateDigest) return "unchanged";
    throw new Error(`Source watermark '${watermark.streamId}' cannot move backward or conflict at the same time.`);
  }

  async claimSyncLease(input: { sourceId: string; streamId: string; owner: string; acquiredAt: string; leaseUntil: string }): Promise<"claimed" | "busy"> {
    await ensureCompanyKnowledgeSchema();
    if (Date.parse(input.leaseUntil) <= Date.parse(input.acquiredAt)) throw new Error("Source synchronization lease must end after it starts.");
    const rows = await connection()`insert into companyos_knowledge.source_sync_leases
        (source_id, stream_id, lease_owner, acquired_at, lease_until)
      values (${input.sourceId}, ${input.streamId}, ${input.owner}, ${input.acquiredAt}, ${input.leaseUntil})
      on conflict (source_id, stream_id) do update set
        lease_owner = excluded.lease_owner,
        acquired_at = excluded.acquired_at,
        lease_until = excluded.lease_until
      where companyos_knowledge.source_sync_leases.lease_until <= excluded.acquired_at
        or companyos_knowledge.source_sync_leases.lease_owner = excluded.lease_owner
      returning source_id`;
    return rows.length > 0 ? "claimed" : "busy";
  }

  async releaseSyncLease(input: { sourceId: string; streamId: string; owner: string }): Promise<"released" | "unchanged"> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`delete from companyos_knowledge.source_sync_leases
      where source_id = ${input.sourceId} and stream_id = ${input.streamId} and lease_owner = ${input.owner}
      returning source_id`;
    return rows.length > 0 ? "released" : "unchanged";
  }

  async previewDependencies(input: { sourceId: string; targetKind: SourceLifecycleTargetKind; targetId: string; targetVersion?: string }): Promise<string[]> {
    if (input.targetKind === "raw-asset") {
      const rows = await connection()`select source_id, provider_object_id, provider_version from companyos_knowledge.raw_assets where asset_id = ${input.targetId} limit 1`;
      return rows[0] ? [`source-object:${String(rows[0].source_id)}/${String(rows[0].provider_object_id)}@${String(rows[0].provider_version)}`] : [];
    }
    const evidence = await this.getRawEvidence(input.sourceId, input.targetId, input.targetVersion);
    if (!evidence) return [];
    const result = [`access-policy:${evidence.envelope.accessPolicyId}`];
    if (evidence.content && "rawAsset" in evidence.content && evidence.content.rawAsset) result.push(`raw-asset:${evidence.content.rawAsset.assetId}`);
    return result.sort();
  }

  async putLifecycleRequest(request: SourceLifecycleRequestV2): Promise<SourceEvidenceWriteResult> {
    await ensureCompanyKnowledgeSchema();
    const sql = connection();
    const rows = await sql.transaction((tx) => [
      tx`insert into companyos_knowledge.source_lifecycle_requests (
          request_id, source_id, target_kind, target_id, target_version, requested_by, reason, requested_at,
          purge_after, dependency_ids, access_policy_id, status, legal_hold, receipt_id)
        values (${request.requestId}, ${request.sourceId}, ${request.targetKind}, ${request.targetId}, ${request.targetVersion ?? null},
          ${request.requestedBy}, ${request.reason}, ${request.requestedAt}, ${request.purgeAfter},
          ${JSON.stringify(request.dependencyIds)}, ${request.accessPolicyId}, ${request.status}, ${request.legalHold}, ${request.receiptId})
        on conflict (request_id) do update set request_id = excluded.request_id
        where companyos_knowledge.source_lifecycle_requests.source_id = excluded.source_id
          and companyos_knowledge.source_lifecycle_requests.target_kind = excluded.target_kind
          and companyos_knowledge.source_lifecycle_requests.target_id = excluded.target_id
          and companyos_knowledge.source_lifecycle_requests.target_version is not distinct from excluded.target_version
          and companyos_knowledge.source_lifecycle_requests.requested_by = excluded.requested_by
          and companyos_knowledge.source_lifecycle_requests.reason = excluded.reason
          and companyos_knowledge.source_lifecycle_requests.requested_at = excluded.requested_at
        returning (xmax = 0) as inserted`,
      request.targetKind === "source-object"
        ? tx`update companyos_knowledge.source_object_versions set payload_state = 'deletion-requested'
            where source_id = ${request.sourceId} and provider_object_id = ${request.targetId}
              and provider_version = coalesce(${request.targetVersion ?? null}, provider_version) returning provider_object_id`
        : tx`update companyos_knowledge.raw_assets set lifecycle_status = 'deletion-requested'
            where asset_id = ${request.targetId} returning asset_id`,
    ], { isolationLevel: "Serializable" });
    if (rows[0].length === 0) throw new Error(`Source lifecycle request '${request.requestId}' conflicts with existing content.`);
    if (rows[1].length === 0) throw new Error(`Source lifecycle target '${request.targetId}' does not exist.`);
    return rows[0][0]?.inserted === true ? "inserted" : "unchanged";
  }

  async getLifecycleRequest(requestId: string): Promise<SourceLifecycleRequestV2 | undefined> {
    await ensureCompanyKnowledgeSchema();
    const rows = await connection()`select * from companyos_knowledge.source_lifecycle_requests where request_id = ${requestId} limit 1`;
    return rows[0] ? mapLifecycle(rows[0] as Record<string, unknown>) : undefined;
  }

  async restoreLifecycleRequest(requestId: string, restoredAt: string, receipt: SourceReceiptV2): Promise<"restored" | "unchanged" | "missing" | "purged"> {
    const request = await this.getLifecycleRequest(requestId);
    if (!request) return "missing";
    if (request.status === "purged") return "purged";
    if (request.status === "restored") return "unchanged";
    await this.putReceipt(receipt);
    const sql = connection();
    await sql`update companyos_knowledge.source_lifecycle_requests set status = 'restored', legal_hold = false,
      restored_at = ${restoredAt}, updated_at = ${restoredAt}, receipt_id = ${receipt.receiptId} where request_id = ${requestId}`;
    if (request.targetKind === "source-object") {
      await sql`update companyos_knowledge.source_object_versions set payload_state = 'active'
        where source_id = ${request.sourceId} and provider_object_id = ${request.targetId}
          and provider_version = coalesce(${request.targetVersion ?? null}, provider_version) and payload_state <> 'purged'`;
    } else {
      await sql`update companyos_knowledge.raw_assets set lifecycle_status = 'active' where asset_id = ${request.targetId} and lifecycle_status <> 'deleted'`;
    }
    return "restored";
  }

  async setLifecycleLegalHold(requestId: string, enabled: boolean, _actor: string, observedAt: string, receipt: SourceReceiptV2): Promise<"updated" | "unchanged" | "missing" | "purged"> {
    const request = await this.getLifecycleRequest(requestId);
    if (!request) return "missing";
    if (request.status === "purged") return "purged";
    if (request.legalHold === enabled) return "unchanged";
    await this.putReceipt(receipt);
    await connection()`update companyos_knowledge.source_lifecycle_requests set legal_hold = ${enabled},
      status = ${enabled ? "held" : "requested"}, updated_at = ${observedAt}, receipt_id = ${receipt.receiptId}
      where request_id = ${requestId}`;
    return "updated";
  }

  async purgeLifecycleRequest(requestId: string, purgedAt: string, receipt: SourceReceiptV2): Promise<"purged" | "held" | "too-early" | "unchanged" | "missing"> {
    const request = await this.getLifecycleRequest(requestId);
    if (!request) return "missing";
    if (request.status === "purged" || request.status === "restored") return "unchanged";
    if (request.legalHold || request.status === "held") return "held";
    if (Date.parse(purgedAt) < Date.parse(request.purgeAfter)) return "too-early";
    await this.putReceipt(receipt);
    const sql = connection();
    if (request.targetKind === "source-object") {
      await sql`update companyos_knowledge.source_object_versions set envelope = envelope - 'content',
          payload_state = 'purged', model_ready = false, redacted_at = ${purgedAt}
        where source_id = ${request.sourceId} and provider_object_id = ${request.targetId}
          and provider_version = coalesce(${request.targetVersion ?? null}, provider_version)`;
    } else {
      await sql`update companyos_knowledge.raw_assets set inline_content = null, encoding = null,
          storage_pointer = ${JSON.stringify({ redacted: true, requestId })},
        inline_content = null, lifecycle_status = 'deleted', deleted_at = ${purgedAt} where asset_id = ${request.targetId}`;
    }
    await sql`update companyos_knowledge.source_lifecycle_requests set status = 'purged', purged_at = ${purgedAt},
      updated_at = ${purgedAt}, receipt_id = ${receipt.receiptId} where request_id = ${requestId}`;
    return "purged";
  }

  #mapChange(row: Record<string, unknown>): SourceChangeEntryV2 {
    return {
      sequence: Number(row.sequence),
      changeId: String(row.change_id),
      previousDigest: optionalString(row.previous_digest),
      chainDigest: String(row.chain_digest),
      sourceId: String(row.source_id),
      objectKind: row.object_kind as SourceChangeEntryV2["objectKind"],
      objectId: String(row.object_id),
      objectVersion: optionalString(row.object_version),
      changeKind: row.change_kind as SourceChangeEntryV2["changeKind"],
      accessPolicyId: String(row.access_policy_id),
      payloadDigest: String(row.payload_digest),
      receiptId: String(row.receipt_id),
      occurredAt: iso(row.occurred_at),
    };
  }
}
