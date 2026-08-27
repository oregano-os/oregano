import { sha256 } from "../runtime/canonical.ts";
import { QUARANTINE_POLICY_ID } from "./access-control.ts";
import type {
  KnowledgeSourceBinding,
  KnowledgeSourceRequirement,
  SourceRetentionPolicy,
} from "./source-contracts.ts";

export const SOURCE_CONNECTOR_V2_CONTRACT_VERSION = "2.0.0" as const;
export const SOURCE_CONNECTOR_V1_CONTRACT_VERSION = "1.0.0" as const;

export const SOURCE_KINDS = [
  "repository",
  "meeting",
  "messaging",
  "email",
  "document",
  "local-file",
  "session",
] as const;
export type SourceKind = typeof SOURCE_KINDS[number];

export const SOURCE_DELIVERY_MODES = ["pull", "webhook", "hybrid"] as const;
export type SourceDeliveryMode = typeof SOURCE_DELIVERY_MODES[number];

export const SOURCE_EVENT_TYPES = ["created", "updated", "deleted", "access-changed"] as const;
export type SourceEventType = typeof SOURCE_EVENT_TYPES[number];

export const SOURCE_MEDIA_TYPES = [
  "text/markdown",
  "text/plain",
  "text/html",
  "application/json",
  "application/pdf",
  "audio/mpeg",
  "audio/mp4",
  "video/mp4",
] as const;
export type SourceMediaType = typeof SOURCE_MEDIA_TYPES[number];

export type SourceDataClass = "business" | "confidential" | "restricted" | "personal";

export type SourceProviderScope =
  | {
      kind: "repository";
      pathPrefix: string;
      includeExtensions: string[];
    }
  | {
      kind: "workspace-containers";
      workspaceId: string;
      containerIds: string[];
    }
  | {
      kind: "workspace";
      workspaceId: string;
    }
  | {
      kind: "local-input";
      access: "exact-input-only";
    }
  | {
      kind: "company-instance";
      instanceId: string;
    };

export type SourceAccessProfile =
  | {
      mode: "provider-acl";
      mappingId: string;
      rootPolicyId: string;
      unresolvedPolicyId: typeof QUARANTINE_POLICY_ID;
    }
  | {
      mode: "fixed-policy";
      rootPolicyId: string;
    }
  | {
      mode: "quarantine";
      rootPolicyId: typeof QUARANTINE_POLICY_ID;
    };

export interface SourceRequirementV2 {
  version: 2;
  type: "knowledge-source";
  contractVersion: typeof SOURCE_CONNECTOR_V2_CONTRACT_VERSION;
  sourceId: string;
  sourceKind: SourceKind;
  deliveryMode: SourceDeliveryMode;
  dataOwner: string;
  dataClass: SourceDataClass;
  personalData: boolean;
  retention: SourceRetentionPolicy;
  legalHold: boolean;
  staleAfterSeconds: number;
  content: {
    mediaTypes: SourceMediaType[];
    maxInlineBytes: number;
    maxAssetBytes: number;
  };
  access: SourceAccessProfile;
  providerScope: SourceProviderScope;
}

export type SourceProviderIdentity =
  | {
      kind: "repository";
      accountId: string;
      repositoryId: string;
      ref: string;
      apiBaseUrl?: string;
    }
  | {
      kind: "workspace";
      workspaceId: string;
      apiBaseUrl?: string;
    }
  | {
      kind: "local";
    }
  | {
      kind: "company-instance";
      instanceId: string;
    };

export type SourceBindingState = "bound" | "qualified" | "active" | "revoked";

export interface SourceBindingV2 {
  version: 2;
  contractVersion: typeof SOURCE_CONNECTOR_V2_CONTRACT_VERSION;
  sourceId: string;
  installationId: string;
  connectorId: string;
  connectorVersion: string;
  secretRefs: Record<string, string>;
  requiredScopes: string[];
  providerIdentity: SourceProviderIdentity;
  state: SourceBindingState;
  qualification?: {
    qualifiedAt: string;
    receiptId: string;
    implementationDigest: string;
  };
}

export interface SourceEventV2 {
  contractVersion: typeof SOURCE_CONNECTOR_V2_CONTRACT_VERSION;
  eventId: string;
  deliveryId: string;
  sourceId: string;
  providerTenantId: string;
  eventType: SourceEventType;
  providerObjectId: string;
  providerVersion?: string;
  occurredAt: string;
  observedAt: string;
  locator: string;
  cursor?: string;
  watermark?: string;
  accessVersion?: string;
}

export interface SourceObjectDescriptorV2 {
  sourceId: string;
  providerObjectId: string;
  providerVersion: string;
  locator: string;
  mediaType: SourceMediaType;
  size: number;
  contentDigest?: string;
  accessVersion?: string;
}

export interface RawAssetReferenceV2 {
  assetId: string;
  contentDigest: string;
  mediaType: SourceMediaType;
  size: number;
  storageKey: string;
}

export type SourceEnvelopeContentV2 =
  | { inlineText: string; rawAsset?: never }
  | { inlineText?: never; rawAsset: RawAssetReferenceV2 };

export interface SourceEnvelopeV2 {
  contractVersion: typeof SOURCE_CONNECTOR_V2_CONTRACT_VERSION;
  sourceId: string;
  providerTenantId: string;
  providerObjectId: string;
  providerVersion: string;
  eventId: string;
  observedAt: string;
  locator: string;
  mediaType: SourceMediaType;
  size: number;
  contentDigest: string;
  accessPolicyId: string;
  deletionState: "present" | "deleted";
  content: SourceEnvelopeContentV2;
}

export interface SourceAccessEntryV2 {
  effect: "allow" | "deny";
  principalType: "principal" | "group";
  externalPrincipalId: string;
  role: "reader" | "owner" | "administrator";
}

export interface SourceAccessSnapshotV2 {
  contractVersion: typeof SOURCE_CONNECTOR_V2_CONTRACT_VERSION;
  sourceId: string;
  providerObjectId: string;
  providerAccessVersion: string;
  observedAt: string;
  entries: SourceAccessEntryV2[];
  evidenceDigest: string;
}

export type SourceReceiptOperationV2 =
  | "resolve"
  | "verify"
  | "enumerate"
  | "read-changes"
  | "webhook"
  | "fetch"
  | "read-access"
  | "enqueue"
  | "reconcile"
  | "cursor"
  | "quarantine"
  | "lifecycle"
  | "health"
  | "revoke";

export interface SourceReceiptV2 {
  contractVersion: typeof SOURCE_CONNECTOR_V2_CONTRACT_VERSION;
  receiptId: string;
  sourceId: string;
  connectorId: string;
  connectorVersion: string;
  operation: SourceReceiptOperationV2;
  outcome: "succeeded" | "failed" | "deferred" | "skipped";
  observedAt: string;
  evidenceDigest: string;
  deliveryId?: string;
  providerObjectId?: string;
  providerVersion?: string;
  cursorDigest?: string;
  reasonCode?: string;
}

export interface SourceVerificationV2 {
  ok: boolean;
  sourceId: string;
  connectorId: string;
  connectorVersion: string;
  providerIdentity: SourceProviderIdentity;
  verifiedScopes: string[];
  verifiedDeliveryModes: SourceDeliveryMode[];
  aclMapping: "verified" | "quarantine-only" | "unsupported";
  receipt: SourceReceiptV2;
}

export interface SourceHealthV2 {
  ok: boolean;
  sourceId: string;
  status: "healthy" | "stale" | "revoked" | "degraded" | "error";
  checkedAt: string;
  lastSuccessfulDeliveryAt?: string;
  reasonCode?: string;
  receipt: SourceReceiptV2;
}

export interface SourceEnumerationPageV2 {
  objects: SourceObjectDescriptorV2[];
  nextCursor?: string;
  complete: boolean;
  completedWatermark?: string;
  receipt: SourceReceiptV2;
}

export interface SourceChangePageV2 {
  events: SourceEventV2[];
  nextCursor?: string;
  complete: boolean;
  completedWatermark?: string;
  receipt: SourceReceiptV2;
}

export interface SourceFetchResultV2 {
  envelope: SourceEnvelopeV2;
  access: SourceAccessSnapshotV2;
  receipt: SourceReceiptV2;
  assetPayload?: Uint8Array;
}

export interface ExactSourceInputV2 {
  providerObjectId: string;
  mediaType: SourceMediaType;
  bytes: Uint8Array;
  observedAt: string;
}

export interface SourceConnectorDescriptorV2 {
  connectorId: string;
  connectorVersion: string;
  contractVersion: typeof SOURCE_CONNECTOR_V2_CONTRACT_VERSION;
  sourceKinds: SourceKind[];
  deliveryModes: SourceDeliveryMode[];
  implementationDigest: string;
}

export interface SourceConnectorV2 {
  readonly descriptor: SourceConnectorDescriptorV2;
  readonly sourceId: string;
  verify(): Promise<SourceVerificationV2>;
  enumerate?(input: { cursor?: string; pageSize: number }): Promise<SourceEnumerationPageV2>;
  readChanges?(input: { cursor?: string; pageSize: number; overlapFrom?: string }): Promise<SourceChangePageV2>;
  acceptWebhook?(input: { rawBody: Uint8Array; headers: Readonly<Record<string, string>>; observedAt: string }): Promise<{ events: SourceEventV2[]; receipt: SourceReceiptV2 }>;
  stageExactInput?(input: ExactSourceInputV2): Promise<{ event: SourceEventV2; receipt: SourceReceiptV2 }>;
  fetch(event: SourceEventV2): Promise<SourceFetchResultV2>;
  readAccess?(event: SourceEventV2): Promise<{ access: SourceAccessSnapshotV2; receipt: SourceReceiptV2 }>;
  health(): Promise<SourceHealthV2>;
  revoke(): Promise<SourceReceiptV2>;
}

export interface SourceV1CompatibilityResult {
  requirement: SourceRequirementV2;
  binding: SourceBindingV2;
  receipt: SourceReceiptV2;
}

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,255}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SECRET_REF_PATTERN = /^(?:env|secret):[A-Z][A-Z0-9_]{0,127}$/;

const assertObject: (value: unknown, label: string) => asserts value is Record<string, unknown> = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
};

const assertExactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void => {
  for (const key of required) if (!(key in value)) throw new Error(`${label}.${key} is required.`);
  const accepted = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!accepted.has(key)) throw new Error(`${label}.${key} is not supported.`);
};

const assertId: (value: unknown, label: string) => asserts value is string = (value, label) => {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`${label} must be a bounded stable identifier.`);
};

const assertString: (value: unknown, label: string, maximum?: number) => asserts value is string = (value, label, maximum = 2_048) => {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`${label} must be a non-empty string of at most ${maximum} characters.`);
};

const assertIso: (value: unknown, label: string) => asserts value is string = (value, label) => {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp.`);
};

const assertInteger: (value: unknown, label: string, minimum: number, maximum: number) => asserts value is number = (value, label, minimum, maximum) => {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
};

const assertDigest: (value: unknown, label: string) => asserts value is string = (value, label) => {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
};

const assertStringArray: (value: unknown, label: string, maximum: number, allowEmpty?: boolean) => asserts value is string[] = (value, label, maximum, allowEmpty = false) => {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > maximum) throw new Error(`${label} must contain ${allowEmpty ? "zero to" : "one to"} ${maximum} values.`);
  for (const [index, entry] of value.entries()) assertString(entry, `${label}[${index}]`, 512);
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates.`);
};

const assertRetention: (value: unknown, label: string) => asserts value is SourceRetentionPolicy = (value, label) => {
  assertObject(value, label);
  if (value.mode === "retain") {
    assertExactKeys(value, ["mode"], [], label);
    return;
  }
  if (value.mode === "expire-after-days") {
    assertExactKeys(value, ["mode", "days"], [], label);
    assertInteger(value.days, `${label}.days`, 1, 3_650);
    return;
  }
  throw new Error(`${label}.mode is not supported.`);
};

const assertProviderScope: (value: unknown, sourceKind: SourceKind, label: string) => asserts value is SourceProviderScope = (value, sourceKind, label) => {
  assertObject(value, label);
  if (value.kind === "repository") {
    if (sourceKind !== "repository") throw new Error(`${label}.kind does not match sourceKind '${sourceKind}'.`);
    assertExactKeys(value, ["kind", "pathPrefix", "includeExtensions"], [], label);
    if (typeof value.pathPrefix !== "string" || value.pathPrefix.startsWith("/") || value.pathPrefix.split("/").includes("..")) throw new Error(`${label}.pathPrefix must stay within the repository.`);
    assertStringArray(value.includeExtensions, `${label}.includeExtensions`, 20);
    return;
  }
  if (value.kind === "workspace-containers") {
    if (!["meeting", "messaging", "email", "document"].includes(sourceKind)) throw new Error(`${label}.kind does not match sourceKind '${sourceKind}'.`);
    assertExactKeys(value, ["kind", "workspaceId", "containerIds"], [], label);
    assertId(value.workspaceId, `${label}.workspaceId`);
    assertStringArray(value.containerIds, `${label}.containerIds`, 100);
    return;
  }
  if (value.kind === "workspace") {
    if (!["meeting", "messaging", "email", "document"].includes(sourceKind)) throw new Error(`${label}.kind does not match sourceKind '${sourceKind}'.`);
    assertExactKeys(value, ["kind", "workspaceId"], [], label);
    assertId(value.workspaceId, `${label}.workspaceId`);
    return;
  }
  if (value.kind === "local-input") {
    if (sourceKind !== "local-file") throw new Error(`${label}.kind does not match sourceKind '${sourceKind}'.`);
    assertExactKeys(value, ["kind", "access"], [], label);
    if (value.access !== "exact-input-only") throw new Error(`${label}.access must be exact-input-only.`);
    return;
  }
  if (value.kind === "company-instance") {
    if (sourceKind !== "session") throw new Error(`${label}.kind does not match sourceKind '${sourceKind}'.`);
    assertExactKeys(value, ["kind", "instanceId"], [], label);
    assertId(value.instanceId, `${label}.instanceId`);
    return;
  }
  throw new Error(`${label}.kind is not supported.`);
};

const assertAccessProfile: (value: unknown, label: string) => asserts value is SourceAccessProfile = (value, label) => {
  assertObject(value, label);
  if (value.mode === "provider-acl") {
    assertExactKeys(value, ["mode", "mappingId", "rootPolicyId", "unresolvedPolicyId"], [], label);
    assertId(value.mappingId, `${label}.mappingId`);
    assertId(value.rootPolicyId, `${label}.rootPolicyId`);
    if (value.rootPolicyId === QUARANTINE_POLICY_ID) throw new Error(`${label}.rootPolicyId must identify an active Source root policy.`);
    if (value.unresolvedPolicyId !== QUARANTINE_POLICY_ID) throw new Error(`${label}.unresolvedPolicyId must be '${QUARANTINE_POLICY_ID}'.`);
    return;
  }
  if (value.mode === "fixed-policy") {
    assertExactKeys(value, ["mode", "rootPolicyId"], [], label);
    assertId(value.rootPolicyId, `${label}.rootPolicyId`);
    if (value.rootPolicyId === QUARANTINE_POLICY_ID) throw new Error(`${label}.rootPolicyId must use quarantine mode for the reserved quarantine policy.`);
    return;
  }
  if (value.mode === "quarantine") {
    assertExactKeys(value, ["mode", "rootPolicyId"], [], label);
    if (value.rootPolicyId !== QUARANTINE_POLICY_ID) throw new Error(`${label}.rootPolicyId must be '${QUARANTINE_POLICY_ID}'.`);
    return;
  }
  throw new Error(`${label}.mode is not supported.`);
};

export function validateSourceRequirementV2(value: unknown): SourceRequirementV2 {
  assertObject(value, "Source requirement");
  assertExactKeys(value, [
    "version", "type", "contractVersion", "sourceId", "sourceKind", "deliveryMode", "dataOwner", "dataClass",
    "personalData", "retention", "legalHold", "staleAfterSeconds", "content", "access", "providerScope",
  ], [], "Source requirement");
  if (value.version !== 2 || value.type !== "knowledge-source" || value.contractVersion !== SOURCE_CONNECTOR_V2_CONTRACT_VERSION) throw new Error("Unsupported Source requirement contract version.");
  assertId(value.sourceId, "Source requirement.sourceId");
  if (!SOURCE_KINDS.includes(value.sourceKind as SourceKind)) throw new Error("Source requirement.sourceKind is not supported.");
  if (!SOURCE_DELIVERY_MODES.includes(value.deliveryMode as SourceDeliveryMode)) throw new Error("Source requirement.deliveryMode is not supported.");
  assertString(value.dataOwner, "Source requirement.dataOwner", 256);
  if (!["business", "confidential", "restricted", "personal"].includes(String(value.dataClass))) throw new Error("Source requirement.dataClass is not supported.");
  if (typeof value.personalData !== "boolean") throw new Error("Source requirement.personalData must be boolean.");
  if (value.dataClass === "personal" && value.personalData !== true) throw new Error("Personal data class requires personalData true.");
  assertRetention(value.retention, "Source requirement.retention");
  if (typeof value.legalHold !== "boolean") throw new Error("Source requirement.legalHold must be boolean.");
  assertInteger(value.staleAfterSeconds, "Source requirement.staleAfterSeconds", 60, 31_536_000);
  assertObject(value.content, "Source requirement.content");
  assertExactKeys(value.content, ["mediaTypes", "maxInlineBytes", "maxAssetBytes"], [], "Source requirement.content");
  if (!Array.isArray(value.content.mediaTypes) || value.content.mediaTypes.length === 0 || value.content.mediaTypes.length > SOURCE_MEDIA_TYPES.length) throw new Error("Source requirement.content.mediaTypes must be bounded and non-empty.");
  for (const mediaType of value.content.mediaTypes) if (!SOURCE_MEDIA_TYPES.includes(mediaType as SourceMediaType)) throw new Error(`Unsupported Source media type '${String(mediaType)}'.`);
  if (new Set(value.content.mediaTypes).size !== value.content.mediaTypes.length) throw new Error("Source requirement.content.mediaTypes must not contain duplicates.");
  assertInteger(value.content.maxInlineBytes, "Source requirement.content.maxInlineBytes", 1, 1_048_576);
  assertInteger(value.content.maxAssetBytes, "Source requirement.content.maxAssetBytes", value.content.maxInlineBytes, 1_073_741_824);
  assertAccessProfile(value.access, "Source requirement.access");
  assertProviderScope(value.providerScope, value.sourceKind as SourceKind, "Source requirement.providerScope");
  return structuredClone(value) as unknown as SourceRequirementV2;
}

const assertProviderIdentity: (value: unknown, sourceKind: SourceKind, label: string) => asserts value is SourceProviderIdentity = (value, sourceKind, label) => {
  assertObject(value, label);
  if (value.kind === "repository") {
    if (sourceKind !== "repository") throw new Error(`${label}.kind does not match the requirement.`);
    assertExactKeys(value, ["kind", "accountId", "repositoryId", "ref"], ["apiBaseUrl"], label);
    assertId(value.accountId, `${label}.accountId`);
    assertId(value.repositoryId, `${label}.repositoryId`);
    assertString(value.ref, `${label}.ref`, 256);
  } else if (value.kind === "workspace") {
    if (!["meeting", "messaging", "email", "document"].includes(sourceKind)) throw new Error(`${label}.kind does not match the requirement.`);
    assertExactKeys(value, ["kind", "workspaceId"], ["apiBaseUrl"], label);
    assertId(value.workspaceId, `${label}.workspaceId`);
  } else if (value.kind === "local") {
    if (sourceKind !== "local-file") throw new Error(`${label}.kind does not match the requirement.`);
    assertExactKeys(value, ["kind"], [], label);
  } else if (value.kind === "company-instance") {
    if (sourceKind !== "session") throw new Error(`${label}.kind does not match the requirement.`);
    assertExactKeys(value, ["kind", "instanceId"], [], label);
    assertId(value.instanceId, `${label}.instanceId`);
  } else {
    throw new Error(`${label}.kind is not supported.`);
  }
  const apiBaseUrl = value.apiBaseUrl;
  if (apiBaseUrl !== undefined) {
    assertString(apiBaseUrl, `${label}.apiBaseUrl`, 2_048);
    if (new URL(apiBaseUrl).protocol !== "https:") throw new Error(`${label}.apiBaseUrl must use HTTPS.`);
  }
};

export function validateSourceBindingV2(value: unknown, requirement: SourceRequirementV2): SourceBindingV2 {
  assertObject(value, "Source binding");
  assertExactKeys(value, [
    "version", "contractVersion", "sourceId", "installationId", "connectorId", "connectorVersion", "secretRefs",
    "requiredScopes", "providerIdentity", "state",
  ], ["qualification"], "Source binding");
  if (value.version !== 2 || value.contractVersion !== SOURCE_CONNECTOR_V2_CONTRACT_VERSION) throw new Error("Unsupported Source binding contract version.");
  if (value.sourceId !== requirement.sourceId) throw new Error("Source requirement and binding identities differ.");
  assertId(value.installationId, "Source binding.installationId");
  assertId(value.connectorId, "Source binding.connectorId");
  assertString(value.connectorVersion, "Source binding.connectorVersion", 64);
  assertObject(value.secretRefs, "Source binding.secretRefs");
  if (Object.keys(value.secretRefs).length > 8) throw new Error("Source binding.secretRefs has too many entries.");
  for (const [name, reference] of Object.entries(value.secretRefs)) {
    assertId(name, `Source binding.secretRefs key '${name}'`);
    if (typeof reference !== "string" || !SECRET_REF_PATTERN.test(reference)) throw new Error(`Source binding.secretRefs.${name} must be an env:NAME or secret:NAME reference.`);
  }
  assertStringArray(value.requiredScopes, "Source binding.requiredScopes", 50, true);
  if (!["bound", "qualified", "active", "revoked"].includes(String(value.state))) throw new Error("Source binding.state is not supported.");
  assertProviderIdentity(value.providerIdentity, requirement.sourceKind, "Source binding.providerIdentity");
  if (["qualified", "active"].includes(String(value.state)) && value.qualification === undefined) {
    throw new Error(`Source binding state '${String(value.state)}' requires qualification evidence.`);
  }
  if (value.state === "bound" && value.qualification !== undefined) {
    throw new Error("Source binding state 'bound' cannot carry qualification evidence.");
  }
  if (value.qualification !== undefined) {
    assertObject(value.qualification, "Source binding.qualification");
    assertExactKeys(value.qualification, ["qualifiedAt", "receiptId", "implementationDigest"], [], "Source binding.qualification");
    assertIso(value.qualification.qualifiedAt, "Source binding.qualification.qualifiedAt");
    assertId(value.qualification.receiptId, "Source binding.qualification.receiptId");
    assertDigest(value.qualification.implementationDigest, "Source binding.qualification.implementationDigest");
  }
  return structuredClone(value) as unknown as SourceBindingV2;
}

export function createSourceEventV2(input: Omit<SourceEventV2, "contractVersion" | "eventId">): SourceEventV2 {
  const eventId = sha256({ contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION, ...input });
  return validateSourceEventV2({ contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION, eventId, ...input });
}

export function validateSourceEventV2(value: unknown): SourceEventV2 {
  assertObject(value, "Source event");
  assertExactKeys(value, [
    "contractVersion", "eventId", "deliveryId", "sourceId", "providerTenantId", "eventType", "providerObjectId",
    "occurredAt", "observedAt", "locator",
  ], ["providerVersion", "cursor", "watermark", "accessVersion"], "Source event");
  if (value.contractVersion !== SOURCE_CONNECTOR_V2_CONTRACT_VERSION) throw new Error("Unsupported Source event contract version.");
  assertDigest(value.eventId, "Source event.eventId");
  assertId(value.deliveryId, "Source event.deliveryId");
  assertId(value.sourceId, "Source event.sourceId");
  assertId(value.providerTenantId, "Source event.providerTenantId");
  if (!SOURCE_EVENT_TYPES.includes(value.eventType as SourceEventType)) throw new Error("Source event.eventType is not supported.");
  assertString(value.providerObjectId, "Source event.providerObjectId", 1_000);
  if (value.providerVersion !== undefined) assertString(value.providerVersion, "Source event.providerVersion", 512);
  // Reference-only webhook deliveries can identify the provider object before
  // its immutable provider version is known. Fetch must resolve and validate
  // the version before Raw Evidence is written.
  assertIso(value.occurredAt, "Source event.occurredAt");
  assertIso(value.observedAt, "Source event.observedAt");
  assertString(value.locator, "Source event.locator", 2_048);
  if (value.cursor !== undefined) assertString(value.cursor, "Source event.cursor", 4_096);
  if (value.watermark !== undefined) assertString(value.watermark, "Source event.watermark", 512);
  if (value.accessVersion !== undefined) assertString(value.accessVersion, "Source event.accessVersion", 512);
  const expected = sha256({
    contractVersion: value.contractVersion,
    deliveryId: value.deliveryId,
    sourceId: value.sourceId,
    providerTenantId: value.providerTenantId,
    eventType: value.eventType,
    providerObjectId: value.providerObjectId,
    ...(value.providerVersion === undefined ? {} : { providerVersion: value.providerVersion }),
    occurredAt: value.occurredAt,
    observedAt: value.observedAt,
    locator: value.locator,
    ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
    ...(value.watermark === undefined ? {} : { watermark: value.watermark }),
    ...(value.accessVersion === undefined ? {} : { accessVersion: value.accessVersion }),
  });
  if (value.eventId !== expected) throw new Error("Source event.eventId does not match its canonical content.");
  return structuredClone(value) as unknown as SourceEventV2;
}

export function validateSourceEnvelopeV2(value: unknown, requirement: SourceRequirementV2): SourceEnvelopeV2 {
  assertObject(value, "Source envelope");
  assertExactKeys(value, [
    "contractVersion", "sourceId", "providerTenantId", "providerObjectId", "providerVersion", "eventId", "observedAt",
    "locator", "mediaType", "size", "contentDigest", "accessPolicyId", "deletionState", "content",
  ], [], "Source envelope");
  if (value.contractVersion !== SOURCE_CONNECTOR_V2_CONTRACT_VERSION || value.sourceId !== requirement.sourceId) throw new Error("Source envelope contract or Source identity does not match its requirement.");
  assertId(value.providerTenantId, "Source envelope.providerTenantId");
  assertString(value.providerObjectId, "Source envelope.providerObjectId", 1_000);
  assertString(value.providerVersion, "Source envelope.providerVersion", 512);
  assertDigest(value.eventId, "Source envelope.eventId");
  assertIso(value.observedAt, "Source envelope.observedAt");
  assertString(value.locator, "Source envelope.locator", 2_048);
  if (!SOURCE_MEDIA_TYPES.includes(value.mediaType as SourceMediaType) || !requirement.content.mediaTypes.includes(value.mediaType as SourceMediaType)) throw new Error("Source envelope.mediaType is not allowed by its requirement.");
  assertInteger(value.size, "Source envelope.size", 0, requirement.content.maxAssetBytes);
  assertDigest(value.contentDigest, "Source envelope.contentDigest");
  assertId(value.accessPolicyId, "Source envelope.accessPolicyId");
  if (!['present', 'deleted'].includes(String(value.deletionState))) throw new Error("Source envelope.deletionState is not supported.");
  assertObject(value.content, "Source envelope.content");
  const hasInline = typeof value.content.inlineText === "string";
  const hasAsset = value.content.rawAsset !== undefined;
  if (hasInline === hasAsset) throw new Error("Source envelope content requires exactly one inlineText or rawAsset value.");
  if (hasInline) {
    assertExactKeys(value.content, ["inlineText"], [], "Source envelope.content");
    if (!["text/markdown", "text/plain", "text/html", "application/json"].includes(String(value.mediaType))) throw new Error("Only textual media can use inlineText.");
    const bytes = Buffer.byteLength(value.content.inlineText as string);
    if (bytes !== value.size || bytes > requirement.content.maxInlineBytes) throw new Error("Source envelope inlineText violates its declared size boundary.");
    if (sha256(value.content.inlineText) !== value.contentDigest) throw new Error("Source envelope inlineText digest mismatch.");
  } else {
    assertExactKeys(value.content, ["rawAsset"], [], "Source envelope.content");
    assertObject(value.content.rawAsset, "Source envelope.content.rawAsset");
    assertExactKeys(value.content.rawAsset, ["assetId", "contentDigest", "mediaType", "size", "storageKey"], [], "Source envelope.content.rawAsset");
    assertId(value.content.rawAsset.assetId, "Source envelope.content.rawAsset.assetId");
    assertDigest(value.content.rawAsset.contentDigest, "Source envelope.content.rawAsset.contentDigest");
    if (value.content.rawAsset.contentDigest !== value.contentDigest || value.content.rawAsset.mediaType !== value.mediaType || value.content.rawAsset.size !== value.size) throw new Error("Source envelope Raw Asset metadata mismatch.");
    assertString(value.content.rawAsset.storageKey, "Source envelope.content.rawAsset.storageKey", 1_000);
  }
  return structuredClone(value) as unknown as SourceEnvelopeV2;
}

export function validateSourceAccessSnapshotV2(value: unknown, input: { sourceId: string; providerObjectId: string }): SourceAccessSnapshotV2 {
  assertObject(value, "Source access snapshot");
  assertExactKeys(value, ["contractVersion", "sourceId", "providerObjectId", "providerAccessVersion", "observedAt", "entries", "evidenceDigest"], [], "Source access snapshot");
  if (value.contractVersion !== SOURCE_CONNECTOR_V2_CONTRACT_VERSION) throw new Error("Unsupported Source access snapshot contract version.");
  if (value.sourceId !== input.sourceId || value.providerObjectId !== input.providerObjectId) throw new Error("Source access snapshot identity does not match its object.");
  assertString(value.providerAccessVersion, "Source access snapshot.providerAccessVersion", 512);
  assertIso(value.observedAt, "Source access snapshot.observedAt");
  assertDigest(value.evidenceDigest, "Source access snapshot.evidenceDigest");
  if (!Array.isArray(value.entries) || value.entries.length > 10_000) throw new Error("Source access snapshot.entries must be a bounded array.");
  const identities = new Set<string>();
  for (const [index, entry] of value.entries.entries()) {
    assertObject(entry, `Source access snapshot.entries[${index}]`);
    assertExactKeys(entry, ["effect", "principalType", "externalPrincipalId", "role"], [], `Source access snapshot.entries[${index}]`);
    if (!["allow", "deny"].includes(String(entry.effect))) throw new Error(`Source access snapshot.entries[${index}].effect is not supported.`);
    if (!["principal", "group"].includes(String(entry.principalType))) throw new Error(`Source access snapshot.entries[${index}].principalType is not supported.`);
    assertString(entry.externalPrincipalId, `Source access snapshot.entries[${index}].externalPrincipalId`, 512);
    if (!["reader", "owner", "administrator"].includes(String(entry.role))) throw new Error(`Source access snapshot.entries[${index}].role is not supported.`);
    const key = `${String(entry.principalType)}\0${String(entry.externalPrincipalId)}\0${String(entry.role)}\0${String(entry.effect)}`;
    if (identities.has(key)) throw new Error("Source access snapshot contains an exact duplicate entry.");
    identities.add(key);
  }
  return structuredClone(value) as unknown as SourceAccessSnapshotV2;
}

export function validateSourceReceiptV2(value: unknown, input?: { sourceId?: string; connectorId?: string; connectorVersion?: string }): SourceReceiptV2 {
  assertObject(value, "Source receipt");
  assertExactKeys(value, ["contractVersion", "receiptId", "sourceId", "connectorId", "connectorVersion", "operation", "outcome", "observedAt", "evidenceDigest"], ["deliveryId", "providerObjectId", "providerVersion", "cursorDigest", "reasonCode"], "Source receipt");
  if (value.contractVersion !== SOURCE_CONNECTOR_V2_CONTRACT_VERSION) throw new Error("Unsupported Source receipt contract version.");
  assertDigest(value.receiptId, "Source receipt.receiptId");
  assertId(value.sourceId, "Source receipt.sourceId");
  assertId(value.connectorId, "Source receipt.connectorId");
  assertString(value.connectorVersion, "Source receipt.connectorVersion", 64);
  if (!["resolve", "verify", "enumerate", "read-changes", "webhook", "fetch", "read-access", "enqueue", "reconcile", "cursor", "quarantine", "lifecycle", "health", "revoke"].includes(String(value.operation))) throw new Error("Source receipt.operation is not supported.");
  if (!["succeeded", "failed", "deferred", "skipped"].includes(String(value.outcome))) throw new Error("Source receipt.outcome is not supported.");
  assertIso(value.observedAt, "Source receipt.observedAt");
  assertDigest(value.evidenceDigest, "Source receipt.evidenceDigest");
  if (input?.sourceId && value.sourceId !== input.sourceId) throw new Error("Source receipt Source identity mismatch.");
  if (input?.connectorId && value.connectorId !== input.connectorId) throw new Error("Source receipt Connector identity mismatch.");
  if (input?.connectorVersion && value.connectorVersion !== input.connectorVersion) throw new Error("Source receipt Connector version mismatch.");
  if (value.deliveryId !== undefined) assertString(value.deliveryId, "Source receipt.deliveryId", 512);
  if (value.providerObjectId !== undefined) assertString(value.providerObjectId, "Source receipt.providerObjectId", 1_000);
  if (value.providerVersion !== undefined) assertString(value.providerVersion, "Source receipt.providerVersion", 512);
  if (value.cursorDigest !== undefined) assertDigest(value.cursorDigest, "Source receipt.cursorDigest");
  if (value.reasonCode !== undefined) assertId(value.reasonCode, "Source receipt.reasonCode");
  return structuredClone(value) as unknown as SourceReceiptV2;
}

export function assertSourceConnectorSupportsV2(input: {
  descriptor: SourceConnectorDescriptorV2;
  requirement: SourceRequirementV2;
  binding: SourceBindingV2;
}): void {
  const { descriptor, requirement, binding } = input;
  if (descriptor.contractVersion !== SOURCE_CONNECTOR_V2_CONTRACT_VERSION) throw new Error(`Connector '${descriptor.connectorId}' has an incompatible Source contract version.`);
  if (descriptor.connectorId !== binding.connectorId || descriptor.connectorVersion !== binding.connectorVersion) throw new Error("Source binding does not identify the selected Connector implementation exactly.");
  if (!descriptor.sourceKinds.includes(requirement.sourceKind)) throw new Error(`Connector '${descriptor.connectorId}' does not support Source kind '${requirement.sourceKind}'.`);
  if (!descriptor.deliveryModes.includes(requirement.deliveryMode)) throw new Error(`Connector '${descriptor.connectorId}' does not support delivery mode '${requirement.deliveryMode}'.`);
  assertDigest(descriptor.implementationDigest, "Source Connector implementationDigest");
  if (binding.qualification && binding.qualification.implementationDigest !== descriptor.implementationDigest) throw new Error("Source binding qualification does not match the selected Connector implementation digest.");
}

export function adaptRepositorySourceV1(
  requirement: KnowledgeSourceRequirement,
  binding: KnowledgeSourceBinding,
  observedAt = new Date().toISOString(),
): SourceV1CompatibilityResult {
  if (requirement.version !== 1 || requirement.kind !== "repository-documents" || binding.version !== 1 || binding.connectorVersion !== SOURCE_CONNECTOR_V1_CONTRACT_VERSION) throw new Error("Unsupported Source Connector V1 compatibility input.");
  if (requirement.sourceId !== binding.sourceId) throw new Error("Source Connector V1 requirement and binding identities differ.");
  assertIso(observedAt, "Source Connector V1 compatibility observedAt");
  const normalizedRequirement = validateSourceRequirementV2({
    version: 2,
    type: "knowledge-source",
    contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
    sourceId: requirement.sourceId,
    sourceKind: "repository",
    deliveryMode: "pull",
    dataOwner: requirement.dataOwner,
    dataClass: requirement.dataClass,
    personalData: requirement.personalData,
    retention: requirement.retention,
    legalHold: requirement.legalHold,
    staleAfterSeconds: requirement.staleAfterHours * 3_600,
    content: {
      mediaTypes: ["text/markdown"],
      maxInlineBytes: requirement.maxObjectBytes,
      maxAssetBytes: requirement.maxObjectBytes,
    },
    access: { mode: "quarantine", rootPolicyId: QUARANTINE_POLICY_ID },
    providerScope: {
      kind: "repository",
      pathPrefix: requirement.pathPrefix,
      includeExtensions: [...requirement.includeExtensions],
    },
  });
  const normalizedBinding = validateSourceBindingV2({
    version: 2,
    contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
    sourceId: binding.sourceId,
    installationId: `legacy:${binding.connector}`,
    connectorId: binding.connector,
    connectorVersion: binding.connectorVersion,
    secretRefs: { primary: binding.secretRef },
    requiredScopes: [...binding.requiredScopes],
    providerIdentity: {
      kind: "repository",
      accountId: binding.owner,
      repositoryId: binding.repository,
      ref: binding.ref,
      ...(binding.apiBaseUrl === undefined ? {} : { apiBaseUrl: binding.apiBaseUrl }),
    },
    state: "bound",
  }, normalizedRequirement);
  const evidenceDigest = sha256({
    sourceId: requirement.sourceId,
    fromContractVersion: SOURCE_CONNECTOR_V1_CONTRACT_VERSION,
    toContractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
    connectorId: binding.connector,
    connectorVersion: binding.connectorVersion,
  });
  const receipt: SourceReceiptV2 = {
    contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
    receiptId: sha256({ sourceId: requirement.sourceId, operation: "verify", outcome: "succeeded", observedAt, evidenceDigest }),
    sourceId: requirement.sourceId,
    connectorId: binding.connector,
    connectorVersion: binding.connectorVersion,
    operation: "verify",
    outcome: "succeeded",
    observedAt,
    evidenceDigest,
    reasonCode: "v1-compatibility-normalized",
  };
  return { requirement: normalizedRequirement, binding: normalizedBinding, receipt };
}
