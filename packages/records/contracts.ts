import type { JsonSchema, JsonValue } from "../capabilities/contracts.ts";

export type RecordDeliveryMode = "poll" | "webhook" | "hybrid";
export type RecordValueType = "string" | "number" | "boolean" | "timestamp" | "status" | "identity" | "url" | "json" | "string_list" | "identity_list" | "json_list";

export interface RecordFieldMapping {
  target: string;
  source: string;
  value_type: RecordValueType;
  required?: boolean;
  /** Required for json_list; other list types already have a fixed item type. */
  item_schema?: JsonSchema;
  /** Optional self-contained refinement for a JSON value. */
  value_schema?: JsonSchema;
  /** Resolve a qualified provider principal against the frozen reviewed roster. */
  resolve_identity?: boolean;
}

/** Literal form structure. Text never supplies identity, time or authority. */
export interface RecordTextParserDeclaration {
  kind: "sectioned-text";
  version: 1;
  source: string;
  starts_with: string;
  sections: Array<{
    id: string;
    heading: string;
    required: boolean;
    fields?: Array<{ id: string; prefixes: string[]; required: boolean }>;
    links?: {
      hosts: string[];
      path: string;
      id_field: string;
      required: boolean;
    };
  }>;
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
  parser?: RecordTextParserDeclaration;
  fields: RecordFieldMapping[];
  access: RecordAccessPolicy;
}

export interface CompanyRecordProjectionDeclaration {
  schema_version: 1;
  id: string;
  record_type: string;
  source_ids?: string[];
  selection?: Record<string, JsonValue>;
  filters?: Record<string, RecordFilterDeclaration>;
  fields: Array<{ name: string; path: string }>;
  freshness: { max_age_minutes: number };
  access: { read_groups: string[] };
  materialization: {
    mode: "database-view" | "workspace-proposal";
    target?: string;
  };
}

/** Names and paths are Workspace data; operators are generic Core behavior. */
export interface RecordFilterDeclaration {
  operator: "equals" | "in" | "after" | "missing-any";
  path: string;
  fields?: string[];
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
  /** Explicit source completeness, never inferred from a cursor or freshness. */
  synced_through?: string;
  source_digest?: string;
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
  all_pages?: boolean;
  require_synced_through?: string;
}

export interface RecordSourceProof {
  source_id: string;
  source_digest: string;
  run_id: string;
  synced_through: string;
  watermark: string;
}

export interface RecordQueryResult {
  projection_id: string;
  rows: RecordProjectionRow[];
  next_cursor?: string;
  observed_at: string;
  fresh_until: string;
  snapshot_id: string;
  source_proofs: RecordSourceProof[];
  synced_through?: string;
  access_decision: RecordAccessDecision;
}
