import { readFileSync } from "node:fs";
import YAML from "yaml";
import type { KnowledgeSourceBinding, KnowledgeSourceRequirement } from "./source-contracts.ts";
import {
  SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
  validateSourceBindingV2,
  validateSourceRequirementV2,
  type SourceBindingV2,
  type SourceRequirementV2,
} from "./source-contracts-v2.ts";

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
};
const string = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
};
const integer = (value: unknown, label: string, minimum: number, maximum: number): number => {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  return Number(value);
};

const parseFile = (path: string): Record<string, unknown> => {
  const raw = readFileSync(path, "utf8");
  const markdown = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return object(YAML.parse(markdown?.[1] ?? raw), path);
};

const retentionFrom = (data: Record<string, unknown>, path: string) => {
  if (data.retention === "retain" && data.retention_days !== undefined) throw new Error(`${path}: use either retention: retain or retention_days, not both.`);
  if (data.retention !== undefined && data.retention !== "retain") throw new Error(`${path}: retention must be retain when declared.`);
  if (data.retention === undefined && data.retention_days === undefined) throw new Error(`${path}: declare retention: retain or retention_days.`);
  return data.retention === "retain"
    ? { mode: "retain" as const }
    : { mode: "expire-after-days" as const, days: integer(data.retention_days, `${path} retention_days`, 1, 3650) };
};

const stringArray = (value: unknown, label: string, maximum: number, allowEmpty = false): string[] => {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > maximum) throw new Error(`${label} must contain ${allowEmpty ? "zero to" : "one to"} ${maximum} values.`);
  return value.map((entry, index) => string(entry, `${label}[${index}]`));
};

export function loadKnowledgeSourceRequirement(path: string): KnowledgeSourceRequirement | SourceRequirementV2 {
  const data = parseFile(path);
  if (data.version === 2) {
    const content = object(data.content, `${path} content`);
    const access = object(data.access, `${path} access`);
    const providerScope = object(data.provider_scope, `${path} provider_scope`);
    return validateSourceRequirementV2({
      version: 2,
      type: data.type,
      contractVersion: data.contract_version,
      sourceId: data.source_id,
      sourceKind: data.source_kind,
      deliveryMode: data.delivery_mode,
      dataOwner: data.data_owner,
      dataClass: data.data_class,
      personalData: data.personal_data,
      retention: retentionFrom(data, path),
      legalHold: data.legal_hold === true,
      staleAfterSeconds: data.stale_after_seconds,
      content: {
        mediaTypes: content.media_types,
        maxInlineBytes: content.max_inline_bytes,
        maxAssetBytes: content.max_asset_bytes,
      },
      access: access.mode === "provider-acl"
        ? { mode: access.mode, mappingId: access.mapping_id, rootPolicyId: access.root_policy_id, unresolvedPolicyId: access.unresolved_policy_id }
        : { mode: access.mode, rootPolicyId: access.root_policy_id },
      providerScope: providerScope.kind === "repository"
        ? { kind: providerScope.kind, pathPrefix: providerScope.path_prefix, includeExtensions: providerScope.include_extensions }
        : providerScope.kind === "workspace-containers"
          ? { kind: providerScope.kind, workspaceId: providerScope.workspace_id, containerIds: providerScope.container_ids }
          : providerScope.kind === "workspace"
            ? { kind: providerScope.kind, workspaceId: providerScope.workspace_id }
          : providerScope.kind === "local-input"
            ? { kind: providerScope.kind, access: providerScope.access }
            : { kind: providerScope.kind, instanceId: providerScope.instance_id },
    });
  }
  if (data.version !== 1 || data.type !== "knowledge-source" || data.kind !== "repository-documents") throw new Error(`${path}: unsupported source requirement.`);
  if (data.data_class !== "business" || data.personal_data !== false) throw new Error(`${path}: phases 4 and 5 accept only shared business knowledge with personal_data: false.`);
  const extensions = data.include_extensions;
  if (!Array.isArray(extensions) || extensions.length !== 1 || extensions[0] !== ".md") throw new Error(`${path}: include_extensions must be exactly [.md].`);
  const prefix = string(data.path_prefix, `${path} path_prefix`).replace(/^\/+|\/+$/g, "");
  if (prefix.includes("..")) throw new Error(`${path}: path_prefix cannot escape its repository.`);
  return {
    version: 1,
    sourceId: string(data.source_id, `${path} source_id`),
    kind: "repository-documents",
    dataOwner: string(data.data_owner, `${path} data_owner`),
    retention: retentionFrom(data, path),
    legalHold: data.legal_hold === true,
    dataClass: "business",
    personalData: false,
    pathPrefix: prefix,
    includeExtensions: [".md"],
    maxObjectBytes: integer(data.max_object_bytes, `${path} max_object_bytes`, 1, 1_048_576),
    staleAfterHours: integer(data.stale_after_hours, `${path} stale_after_hours`, 1, 8760),
  };
}

export function loadKnowledgeSourceBinding(path: string, requirement?: KnowledgeSourceRequirement | SourceRequirementV2): KnowledgeSourceBinding | SourceBindingV2 {
  const data = parseFile(path);
  if (data.version === 2) {
    if (!requirement || requirement.version !== 2) throw new Error(`${path}: a V2 binding requires its parsed V2 Source requirement.`);
    if (data.contract_version !== SOURCE_CONNECTOR_V2_CONTRACT_VERSION) throw new Error(`${path}: unsupported Source binding contract_version.`);
    const providerIdentity = object(data.provider_identity, `${path} provider_identity`);
    const secretRefs = object(data.secret_refs ?? {}, `${path} secret_refs`);
    const qualification = data.qualification === undefined ? undefined : object(data.qualification, `${path} qualification`);
    return validateSourceBindingV2({
      version: 2,
      contractVersion: data.contract_version,
      sourceId: data.source_id,
      installationId: data.installation_id,
      connectorId: data.connector_id,
      connectorVersion: data.connector_version,
      secretRefs,
      requiredScopes: stringArray(data.required_scopes ?? [], `${path} required_scopes`, 50, true),
      providerIdentity: providerIdentity.kind === "repository"
        ? { kind: providerIdentity.kind, accountId: providerIdentity.account_id, repositoryId: providerIdentity.repository_id, ref: providerIdentity.ref, ...(providerIdentity.api_base_url === undefined ? {} : { apiBaseUrl: providerIdentity.api_base_url }) }
        : providerIdentity.kind === "workspace"
          ? { kind: providerIdentity.kind, workspaceId: providerIdentity.workspace_id, ...(providerIdentity.api_base_url === undefined ? {} : { apiBaseUrl: providerIdentity.api_base_url }) }
          : providerIdentity.kind === "company-instance"
            ? { kind: providerIdentity.kind, instanceId: providerIdentity.instance_id }
            : { kind: providerIdentity.kind },
      state: data.state,
      ...(qualification === undefined ? {} : { qualification: {
        qualifiedAt: qualification.qualified_at,
        receiptId: qualification.receipt_id,
        implementationDigest: qualification.implementation_digest,
      } }),
    }, requirement);
  }
  if (data.version !== 1 || data.connector !== "oregano/github-repository-source" || data.connector_version !== "1.0.0") throw new Error(`${path}: unsupported source Connector binding.`);
  if (!Array.isArray(data.required_scopes) || data.required_scopes.length !== 1 || data.required_scopes[0] !== "contents:read") throw new Error(`${path}: required_scopes must be exactly [contents:read].`);
  const secretRef = string(data.secret_ref, `${path} secret_ref`);
  if (!/^env:[A-Z][A-Z0-9_]+$/.test(secretRef)) throw new Error(`${path}: secret_ref must be an env:NAME reference, never a credential value.`);
  return {
    version: 1,
    sourceId: string(data.source_id, `${path} source_id`),
    connector: "oregano/github-repository-source",
    connectorVersion: "1.0.0",
    secretRef,
    owner: string(data.owner, `${path} owner`),
    repository: string(data.repository, `${path} repository`),
    ref: string(data.ref, `${path} ref`),
    apiBaseUrl: data.api_base_url === undefined ? undefined : string(data.api_base_url, `${path} api_base_url`),
    requiredScopes: ["contents:read"],
  };
}

export function resolveEnvironmentSecret(reference: string): string {
  const name = reference.replace(/^env:/, "");
  const value = process.env[name];
  if (!value) throw new Error(`SecretRef '${reference}' is not available in the Instance environment.`);
  return value;
}
