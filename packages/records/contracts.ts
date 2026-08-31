import type { JsonValue } from "../capabilities/contracts.ts";

export type RecordDeliveryMode = "poll" | "webhook" | "hybrid";
export type RecordValueType = "string" | "number" | "boolean" | "timestamp" | "status" | "identity" | "url" | "json";

export interface RecordFieldMapping {
  target: string;
  source: string;
  value_type: RecordValueType;
  required?: boolean;
}

export interface RecordAccessPolicy {
  read_groups: string[];
  write_roles: string[];
}

/** Company-specific logical mapping. Exact provider resources are Instance bindings. */
export interface CompanyRecordSourceDeclaration {
  schema_version: 1;
  id: string;
  record_type: string;
  connection: string;
  resource_binding: string;
  delivery: RecordDeliveryMode;
  reconcile_schedule?: string;
  identity: { source_field: string };
  fields: RecordFieldMapping[];
  access: RecordAccessPolicy;
}

export interface CompanyRecordProjectionDeclaration {
  schema_version: 1;
  id: string;
  record_type: string;
  selection?: Record<string, JsonValue>;
  fields: Array<{ name: string; path: string }>;
  freshness: { max_age_minutes: number };
  access: { read_groups: string[] };
  materialization: {
    mode: "database-view" | "workspace-proposal";
    target?: string;
  };
}

export type RecordSourceEventKind = "created" | "updated" | "deleted" | "access-changed" | "reconcile";

/** Content-free, deduplicated notice from a provider or reconciliation pass. */
export interface RecordSourceEvent {
  instance_id: string;
  source_id: string;
  event_id: string;
  object_id: string;
  kind: RecordSourceEventKind;
  observed_at: string;
  cursor?: string;
  receipt: Record<string, JsonValue>;
}

/** Immutable normalized source object version. It is evidence, not Workspace authority. */
export interface RecordObjectVersion {
  instance_id: string;
  source_id: string;
  record_type: string;
  object_id: string;
  version_id: string;
  digest: string;
  observed_at: string;
  deleted: boolean;
  values: Record<string, JsonValue>;
  source_receipt: Record<string, JsonValue>;
}

export interface RecordProjectionRow {
  instance_id: string;
  projection_id: string;
  record_id: string;
  record_type: string;
  source_version_id: string;
  projected_at: string;
  values: Record<string, JsonValue>;
}

export interface RecordAccessSubject {
  principal_id: string;
  status: "active" | "inactive" | "unresolved" | "revoked";
  roles: string[];
  group_ids: string[];
}

export interface RecordAccessDecision {
  allowed: boolean;
  projection_id: string;
  principal_id: string;
  policy_digest: string;
  reason: "group-allowed" | "role-allowed" | "no-matching-grant" | "inactive-subject";
  decided_at: string;
}

export interface RecordSyncReceipt {
  instance_id: string;
  source_id: string;
  run_id: string;
  started_at: string;
  completed_at: string;
  watermark?: string;
  observed: number;
  inserted: number;
  unchanged: number;
  deleted: number;
  errors: number;
}

export interface RecordReconciliationReceipt extends RecordSyncReceipt {
  missing_from_provider: number;
  repaired_projections: number;
}

export interface RecordQuery {
  projection_id: string;
  filters?: Record<string, JsonValue>;
  limit?: number;
  cursor?: string;
}

export interface RecordQueryResult {
  projection_id: string;
  rows: RecordProjectionRow[];
  next_cursor?: string;
  observed_at: string;
  fresh_until: string;
  access_decision: RecordAccessDecision;
}
