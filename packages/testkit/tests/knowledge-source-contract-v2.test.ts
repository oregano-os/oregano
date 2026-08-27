import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
  adaptRepositorySourceV1,
  assertSourceConnectorSupportsV2,
  createSourceEventV2,
  validateSourceBindingV2,
  validateSourceEnvelopeV2,
  validateSourceEventV2,
  validateSourceRequirementV2,
  type SourceBindingV2,
  type SourceRequirementV2,
} from "../../knowledge/source-contracts-v2.ts";
import { sha256 } from "../../runtime/canonical.ts";
import type { KnowledgeSourceBinding, KnowledgeSourceRequirement } from "../../knowledge/source-contracts.ts";

const digest = (value: string): string => sha256(value);

const requirement = (overrides: Partial<SourceRequirementV2> = {}): SourceRequirementV2 => validateSourceRequirementV2({
  version: 2,
  type: "knowledge-source",
  contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
  sourceId: "meetings",
  sourceKind: "meeting",
  deliveryMode: "hybrid",
  dataOwner: "human:knowledge-steward",
  dataClass: "personal",
  personalData: true,
  retention: { mode: "retain" },
  legalHold: false,
  staleAfterSeconds: 21_600,
  content: {
    mediaTypes: ["text/markdown", "text/plain", "audio/mpeg"],
    maxInlineBytes: 262_144,
    maxAssetBytes: 104_857_600,
  },
  access: {
    mode: "provider-acl",
    mappingId: "granola-workspace-members",
    rootPolicyId: "policy:company",
    unresolvedPolicyId: "policy:quarantine",
  },
  providerScope: {
    kind: "workspace-containers",
    workspaceId: "workspace-1",
    containerIds: ["space-company"],
  },
  ...overrides,
});

const binding = (target: SourceRequirementV2, overrides: Partial<SourceBindingV2> = {}): SourceBindingV2 => validateSourceBindingV2({
  version: 2,
  contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
  sourceId: target.sourceId,
  installationId: "installation:granola",
  connectorId: "oregano/granola-source",
  connectorVersion: "1.0.0",
  secretRefs: { api: "env:GRANOLA_API_KEY", webhook: "secret:GRANOLA_WEBHOOK_SECRET" },
  requiredScopes: ["notes:read", "transcripts:read"],
  providerIdentity: { kind: "workspace", workspaceId: "workspace-1", apiBaseUrl: "https://api.granola.test" },
  state: "bound",
  ...overrides,
}, target);

test("Source Connector 2.0 validates repository, meeting, local, and Session profiles", () => {
  const repository = validateSourceRequirementV2({
    ...requirement(),
    sourceId: "repository",
    sourceKind: "repository",
    deliveryMode: "pull",
    dataClass: "business",
    personalData: false,
    content: { mediaTypes: ["text/markdown"], maxInlineBytes: 262_144, maxAssetBytes: 262_144 },
    access: { mode: "fixed-policy", rootPolicyId: "policy:company" },
    providerScope: { kind: "repository", pathPrefix: "docs", includeExtensions: [".md"] },
  });
  const meeting = requirement();
  const providerWideMeeting = validateSourceRequirementV2({
    ...requirement(),
    sourceId: "all-meetings",
    providerScope: { kind: "workspace", workspaceId: "workspace-1" },
  });
  const local = validateSourceRequirementV2({
    ...requirement(),
    sourceId: "local-import",
    sourceKind: "local-file",
    deliveryMode: "pull",
    providerScope: { kind: "local-input", access: "exact-input-only" },
  });
  const session = validateSourceRequirementV2({
    ...requirement(),
    sourceId: "session-corpus",
    sourceKind: "session",
    deliveryMode: "pull",
    providerScope: { kind: "company-instance", instanceId: "acme-production" },
  });
  assert.deepEqual([repository.sourceKind, meeting.sourceKind, providerWideMeeting.providerScope.kind, local.sourceKind, session.sourceKind], ["repository", "meeting", "workspace", "local-file", "session"]);
  assert.equal(binding(meeting).secretRefs.api, "env:GRANOLA_API_KEY");
});

test("Source Connector 2.0 fails closed for unknown shapes, versions, MIME types, ACLs, and credential values", () => {
  assert.throws(() => validateSourceRequirementV2({ ...requirement(), contractVersion: "3.0.0" }), /Unsupported Source requirement/);
  assert.throws(() => validateSourceRequirementV2({ ...requirement(), sourceKind: "calendar" }), /sourceKind/);
  assert.throws(() => validateSourceRequirementV2({ ...requirement(), deliveryMode: "stream" }), /deliveryMode/);
  assert.throws(() => validateSourceRequirementV2({ ...requirement(), content: { mediaTypes: ["application/x-secret"], maxInlineBytes: 10, maxAssetBytes: 10 } }), /media type/);
  assert.throws(() => validateSourceRequirementV2({ ...requirement(), access: { mode: "provider-acl", mappingId: "mapping", rootPolicyId: "policy:company", unresolvedPolicyId: "policy:company" } }), /quarantine/);
  assert.throws(() => binding(requirement(), { secretRefs: { api: "resolved-provider-token" } }), /Secret.*reference|secretRefs/);
  assert.throws(() => validateSourceRequirementV2({ ...requirement(), providerPayload: { token: "forbidden" } }), /providerPayload/);
});

test("Source Events are deterministic, provider-payload-free, and reject changed identities", () => {
  const input = {
    deliveryId: "webhook:evt-1",
    sourceId: "meetings",
    providerTenantId: "workspace-1",
    eventType: "updated" as const,
    providerObjectId: "note-42",
    providerVersion: "update-7",
    occurredAt: "2026-08-26T10:00:00.000Z",
    observedAt: "2026-08-26T10:00:01.000Z",
    locator: "granola:note-42",
    accessVersion: "acl-3",
  };
  const first = createSourceEventV2(input);
  const second = createSourceEventV2(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first).includes("payload"), false);
  assert.throws(() => validateSourceEventV2({ ...first, providerObjectId: "note-43" }), /canonical content/);
  assert.throws(() => validateSourceEventV2({ ...first, eventType: "opened" }), /eventType/);
  const referenceOnly = createSourceEventV2({
    deliveryId: "webhook:evt-reference",
    sourceId: "meetings",
    providerTenantId: "workspace-1",
    eventType: "updated",
    providerObjectId: "note-42",
    occurredAt: "2026-08-26T10:00:00.000Z",
    observedAt: "2026-08-26T10:00:01.000Z",
    locator: "granola:note-42",
  });
  assert.equal(referenceOnly.providerVersion, undefined, "reference-only webhooks resolve provider version during fetch");
});

test("Source envelopes require exactly one verified inline value or Raw Asset reference", () => {
  const target = requirement();
  const text = "# Meeting\n\nA reviewed transcript segment.\n";
  const event = createSourceEventV2({
    deliveryId: "pull:note-42:update-7",
    sourceId: target.sourceId,
    providerTenantId: "workspace-1",
    eventType: "updated",
    providerObjectId: "note-42",
    providerVersion: "update-7",
    occurredAt: "2026-08-26T10:00:00.000Z",
    observedAt: "2026-08-26T10:05:00.000Z",
    locator: "granola:note-42",
  });
  const base = {
    contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
    sourceId: target.sourceId,
    providerTenantId: "workspace-1",
    providerObjectId: "note-42",
    providerVersion: "update-7",
    eventId: event.eventId,
    observedAt: event.observedAt,
    locator: event.locator,
    mediaType: "text/markdown",
    size: Buffer.byteLength(text),
    contentDigest: digest(text),
    accessPolicyId: "policy:meeting-note-42",
    deletionState: "present",
  } as const;
  assert.equal(validateSourceEnvelopeV2({ ...base, content: { inlineText: text } }, target).content.inlineText, text);
  assert.throws(() => validateSourceEnvelopeV2({ ...base, content: { inlineText: text, rawAsset: { assetId: "asset-1" } } }, target), /exactly one/);
  assert.throws(() => validateSourceEnvelopeV2({ ...base, contentDigest: digest("different"), content: { inlineText: text } }, target), /digest mismatch/);

  const binaryTarget = requirement({ content: { mediaTypes: ["audio/mpeg"], maxInlineBytes: 1024, maxAssetBytes: 1_000_000 } });
  const binary = validateSourceEnvelopeV2({
    ...base,
    mediaType: "audio/mpeg",
    size: 500_000,
    contentDigest: digest("binary-placeholder"),
    content: { rawAsset: { assetId: "asset:note-42-audio", contentDigest: digest("binary-placeholder"), mediaType: "audio/mpeg", size: 500_000, storageKey: "knowledge-assets/note-42/audio" } },
  }, binaryTarget);
  assert.equal(binary.content.rawAsset?.size, 500_000);
});

test("the V1 repository adapter preserves stable identities without resolving a secret", () => {
  const legacyRequirement: KnowledgeSourceRequirement = {
    version: 1,
    sourceId: "company-handbook-repository",
    kind: "repository-documents",
    dataOwner: "human:knowledge-steward",
    retention: { mode: "retain" },
    legalHold: false,
    dataClass: "business",
    personalData: false,
    pathPrefix: "docs",
    includeExtensions: [".md"],
    maxObjectBytes: 262_144,
    staleAfterHours: 24,
  };
  const legacyBinding: KnowledgeSourceBinding = {
    version: 1,
    sourceId: legacyRequirement.sourceId,
    connector: "oregano/github-repository-source",
    connectorVersion: "1.0.0",
    secretRef: "env:COMPANY_KNOWLEDGE_GITHUB_TOKEN",
    owner: "example",
    repository: "company",
    ref: "main",
    requiredScopes: ["contents:read"],
  };
  const normalized = adaptRepositorySourceV1(legacyRequirement, legacyBinding, "2026-08-26T12:00:00.000Z");
  assert.equal(normalized.requirement.sourceId, legacyRequirement.sourceId);
  assert.equal(normalized.binding.sourceId, legacyBinding.sourceId);
  assert.equal(normalized.binding.connectorId, legacyBinding.connector);
  assert.equal(normalized.binding.connectorVersion, legacyBinding.connectorVersion);
  assert.equal(normalized.binding.secretRefs.primary, legacyBinding.secretRef);
  assert.equal(normalized.receipt.reasonCode, "v1-compatibility-normalized");
  assert.equal(JSON.stringify(normalized).includes("resolved-provider-token"), false);
});

test("Connector compatibility uses exact contract, implementation, kind, delivery, and qualification identity", () => {
  const target = requirement();
  const implementationDigest = digest("granola-connector-implementation");
  const qualified = binding(target, {
    state: "qualified",
    qualification: { qualifiedAt: "2026-08-26T12:00:00Z", receiptId: "receipt:granola-qualified", implementationDigest },
  });
  const descriptor = {
    connectorId: qualified.connectorId,
    connectorVersion: qualified.connectorVersion,
    contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
    sourceKinds: ["meeting" as const],
    deliveryModes: ["hybrid" as const],
    implementationDigest,
  };
  assert.doesNotThrow(() => assertSourceConnectorSupportsV2({ descriptor, requirement: target, binding: qualified }));
  assert.throws(() => assertSourceConnectorSupportsV2({ descriptor: { ...descriptor, implementationDigest: digest("changed") }, requirement: target, binding: qualified }), /qualification/);
});
