import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  GITHUB_SOURCE_V1_DESCRIPTOR,
  createMaintainedSourceConnectorRegistry,
} from "../../connectors/source-registry-maintained.ts";
import {
  SourceConnectorRegistry,
  sourceConnectorDescriptor,
  type SourceConnectorRegistration,
} from "../../connectors/source-registry.ts";
import {
  SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
  createSourceEventV2,
  validateSourceBindingV2,
  validateSourceRequirementV2,
  type SourceConnectorV2,
  type SourceReceiptV2,
} from "../../knowledge/source-contracts-v2.ts";
import type { KnowledgeSourceBinding, KnowledgeSourceRequirement } from "../../knowledge/source-contracts.ts";
import { sha256 } from "../../runtime/canonical.ts";
import { loadKnowledgeSourceBinding, loadKnowledgeSourceRequirement } from "../../knowledge/source-config.ts";

const observedAt = "2026-08-26T12:00:00.000Z";

const receipt = (sourceId: string, connectorId: string, connectorVersion: string, operation: SourceReceiptV2["operation"]): SourceReceiptV2 => {
  const evidenceDigest = sha256({ sourceId, connectorId, connectorVersion, operation });
  return {
    contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
    receiptId: sha256({ sourceId, connectorId, connectorVersion, operation, observedAt, evidenceDigest }),
    sourceId,
    connectorId,
    connectorVersion,
    operation,
    outcome: "succeeded",
    observedAt,
    evidenceDigest,
  };
};

const makeV2Registration = (factoryCalled: { value: number }): SourceConnectorRegistration => {
  const descriptor = sourceConnectorDescriptor({
    connectorId: "oregano/test-meeting-source",
    connectorVersion: "2.3.0",
    sourceKinds: ["meeting"],
    deliveryModes: ["hybrid"],
    acceptedInputContractVersions: [SOURCE_CONNECTOR_V2_CONTRACT_VERSION],
    implementationIdentity: "test-meeting-source",
  });
  return {
    descriptor,
    create: ({ normalizedRequirement }): SourceConnectorV2 => {
      factoryCalled.value += 1;
      return {
        descriptor,
        sourceId: normalizedRequirement.sourceId,
        verify: async () => ({
          ok: true,
          sourceId: normalizedRequirement.sourceId,
          connectorId: descriptor.connectorId,
          connectorVersion: descriptor.connectorVersion,
          providerIdentity: { kind: "workspace", workspaceId: "workspace-1" },
          verifiedScopes: ["notes:read"],
          verifiedDeliveryModes: ["hybrid"],
          aclMapping: "verified",
          receipt: receipt(normalizedRequirement.sourceId, descriptor.connectorId, descriptor.connectorVersion, "verify"),
        }),
        enumerate: async () => ({ objects: [], complete: true, receipt: receipt(normalizedRequirement.sourceId, descriptor.connectorId, descriptor.connectorVersion, "enumerate") }),
        readChanges: async () => ({ events: [], complete: true, receipt: receipt(normalizedRequirement.sourceId, descriptor.connectorId, descriptor.connectorVersion, "read-changes") }),
        acceptWebhook: async () => ({ events: [createSourceEventV2({
          deliveryId: "webhook:test",
          sourceId: normalizedRequirement.sourceId,
          providerTenantId: "workspace-1",
          eventType: "deleted",
          providerObjectId: "note-1",
          occurredAt: observedAt,
          observedAt,
          locator: "test:note-1",
        })], receipt: receipt(normalizedRequirement.sourceId, descriptor.connectorId, descriptor.connectorVersion, "webhook") }),
        fetch: async () => { throw new Error("not used"); },
        health: async () => ({ ok: true, sourceId: normalizedRequirement.sourceId, status: "healthy", checkedAt: observedAt, receipt: receipt(normalizedRequirement.sourceId, descriptor.connectorId, descriptor.connectorVersion, "health") }),
        revoke: async () => receipt(normalizedRequirement.sourceId, descriptor.connectorId, descriptor.connectorVersion, "revoke"),
      };
    },
  };
};

const meetingRequirement = () => validateSourceRequirementV2({
  version: 2,
  type: "knowledge-source",
  contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
  sourceId: "meeting-source",
  sourceKind: "meeting",
  deliveryMode: "hybrid",
  dataOwner: "human:knowledge-steward",
  dataClass: "restricted",
  personalData: true,
  retention: { mode: "retain" },
  legalHold: false,
  staleAfterSeconds: 21_600,
  content: { mediaTypes: ["text/plain"], maxInlineBytes: 262_144, maxAssetBytes: 10_485_760 },
  access: { mode: "provider-acl", mappingId: "meeting-members", rootPolicyId: "policy:company", unresolvedPolicyId: "policy:quarantine" },
  providerScope: { kind: "workspace-containers", workspaceId: "workspace-1", containerIds: ["company"] },
});

test("V2 registry rejects inactive ingestion before factory construction and resolves bound verification", () => {
  const calls = { value: 0 };
  const registration = makeV2Registration(calls);
  const registry = new SourceConnectorRegistry({ registrations: [registration], environment: { resolveSecret: () => "never-used", now: () => observedAt } });
  const requirement = meetingRequirement();
  const bound = validateSourceBindingV2({
    version: 2,
    contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
    sourceId: requirement.sourceId,
    installationId: "installation:test-meeting",
    connectorId: registration.descriptor.connectorId,
    connectorVersion: registration.descriptor.connectorVersion,
    secretRefs: { api: "env:TEST_MEETING_KEY" },
    requiredScopes: ["notes:read"],
    providerIdentity: { kind: "workspace", workspaceId: "workspace-1" },
    state: "bound",
  }, requirement);
  assert.throws(() => registry.resolve({ requirement, binding: bound, operation: "sync", observedAt }), /not active/);
  assert.equal(calls.value, 0, "factory must not run for an inactive binding");
  const verified = registry.resolve({ requirement, binding: bound, operation: "verify", observedAt });
  assert.equal(calls.value, 1);
  assert.equal(verified.compatibility, "native-v2");
  assert.equal(verified.receipt.reasonCode, "native-v2-exact-binding");
  assert.equal(JSON.stringify(verified.receipt).includes("TEST_MEETING_KEY"), false);
});

test("V2 registry requires exact implementation qualification for active ingestion", () => {
  const calls = { value: 0 };
  const registration = makeV2Registration(calls);
  const registry = new SourceConnectorRegistry({ registrations: [registration], environment: { resolveSecret: () => "never-used" } });
  const requirement = meetingRequirement();
  const active = validateSourceBindingV2({
    version: 2,
    contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
    sourceId: requirement.sourceId,
    installationId: "installation:test-meeting",
    connectorId: registration.descriptor.connectorId,
    connectorVersion: registration.descriptor.connectorVersion,
    secretRefs: { api: "env:TEST_MEETING_KEY" },
    requiredScopes: ["notes:read"],
    providerIdentity: { kind: "workspace", workspaceId: "workspace-1" },
    state: "active",
    qualification: { qualifiedAt: observedAt, receiptId: "receipt:test-qualified", implementationDigest: registration.descriptor.implementationDigest },
  }, requirement);
  const resolved = registry.resolve({ requirement, binding: active, operation: "sync", observedAt });
  assert.equal(resolved.descriptor.implementationDigest, active.qualification?.implementationDigest);
  assert.equal(calls.value, 1);

  const changedRegistration = { ...registration, descriptor: { ...registration.descriptor, implementationDigest: sha256("changed-implementation") } };
  const changed = new SourceConnectorRegistry({ registrations: [changedRegistration], environment: { resolveSecret: () => "never-used" } });
  assert.throws(() => changed.resolve({ requirement, binding: active, operation: "sync", observedAt }), /qualification/);
  assert.equal(calls.value, 1, "mismatched qualification must fail before factory construction");
});

test("missing, duplicate, incompatible, and revoked registry state fails closed", () => {
  const calls = { value: 0 };
  const registration = makeV2Registration(calls);
  assert.throws(() => new SourceConnectorRegistry({ registrations: [registration, registration], environment: { resolveSecret: () => "never-used" } }), /Duplicate/);
  const requirement = meetingRequirement();
  const unavailable = validateSourceBindingV2({
    version: 2,
    contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
    sourceId: requirement.sourceId,
    installationId: "installation:missing",
    connectorId: "oregano/missing",
    connectorVersion: "1.0.0",
    secretRefs: {},
    requiredScopes: [],
    providerIdentity: { kind: "workspace", workspaceId: "workspace-1" },
    state: "bound",
  }, requirement);
  const registry = new SourceConnectorRegistry({ registrations: [registration], environment: { resolveSecret: () => "never-used" } });
  assert.throws(() => registry.resolve({ requirement, binding: unavailable, operation: "verify" }), /unavailable/);

  const revoked = validateSourceBindingV2({
    version: 2,
    contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
    sourceId: requirement.sourceId,
    installationId: "installation:test-meeting",
    connectorId: registration.descriptor.connectorId,
    connectorVersion: registration.descriptor.connectorVersion,
    secretRefs: { api: "env:TEST_MEETING_KEY" },
    requiredScopes: ["notes:read"],
    providerIdentity: { kind: "workspace", workspaceId: "workspace-1" },
    state: "revoked",
    qualification: { qualifiedAt: observedAt, receiptId: "receipt:test-qualified", implementationDigest: registration.descriptor.implementationDigest },
  }, requirement);
  assert.throws(() => registry.resolve({ requirement, binding: revoked, operation: "health" }), /revoked/);
  assert.equal(calls.value, 0);
});

test("the maintained registry resolves repository V1 only through explicit compatibility", () => {
  const requirement: KnowledgeSourceRequirement = {
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
  const binding: KnowledgeSourceBinding = {
    version: 1,
    sourceId: requirement.sourceId,
    connector: GITHUB_SOURCE_V1_DESCRIPTOR.connectorId as KnowledgeSourceBinding["connector"],
    connectorVersion: "1.0.0",
    secretRef: "env:TEST_GITHUB_TOKEN",
    owner: "example",
    repository: "company",
    ref: "main",
    requiredScopes: ["contents:read"],
  };
  const registry = createMaintainedSourceConnectorRegistry({ resolveSecret: () => "not-resolved-during-registry", now: () => observedAt });
  const resolved = registry.resolve({ requirement, binding, operation: "sync", observedAt });
  assert.equal(resolved.compatibility, "repository-v1");
  assert.equal(resolved.receipt.reasonCode, "repository-v1-compatibility");
  assert.equal(resolved.connector.sourceId, requirement.sourceId);
  assert.equal(JSON.stringify(resolved.receipt).includes(binding.secretRef), false);
});

test("generic source CLI imports only the maintained registry boundary", () => {
  const source = readFileSync(new URL("../../cli/src/cli.mjs", import.meta.url), "utf8");
  assert.match(source, /source-registry-maintained\.ts/);
  assert.doesNotMatch(source, /connectors\/github-knowledge-source\.ts/);
  assert.doesNotMatch(source, /new GitHubKnowledgeSourceConnector/);
});

test("V2 requirement and binding YAML load through strict normalized validators", () => {
  const root = mkdtempSync(join(tmpdir(), "source-registry-config-"));
  const requirementPath = join(root, "meetings.md");
  const bindingPath = join(root, "meetings.yaml");
  writeFileSync(requirementPath, `---
version: 2
type: knowledge-source
contract_version: 2.0.0
source_id: meeting-source
source_kind: meeting
delivery_mode: hybrid
data_owner: human:knowledge-steward
data_class: restricted
personal_data: true
retention: retain
legal_hold: false
stale_after_seconds: 21600
content:
  media_types: [text/plain]
  max_inline_bytes: 262144
  max_asset_bytes: 10485760
access:
  mode: provider-acl
  mapping_id: meeting-members
  root_policy_id: policy:company
  unresolved_policy_id: policy:quarantine
provider_scope:
  kind: workspace-containers
  workspace_id: workspace-1
  container_ids: [company]
---
`);
  const implementationDigest = sourceConnectorDescriptor({
    connectorId: "oregano/test-meeting-source",
    connectorVersion: "2.3.0",
    sourceKinds: ["meeting"],
    deliveryModes: ["hybrid"],
    acceptedInputContractVersions: [SOURCE_CONNECTOR_V2_CONTRACT_VERSION],
    implementationIdentity: "test-meeting-source",
  }).implementationDigest;
  writeFileSync(bindingPath, `version: 2
contract_version: 2.0.0
source_id: meeting-source
installation_id: installation:test-meeting
connector_id: oregano/test-meeting-source
connector_version: 2.3.0
secret_refs:
  api: env:TEST_MEETING_KEY
required_scopes: [notes:read]
provider_identity:
  kind: workspace
  workspace_id: workspace-1
state: active
qualification:
  qualified_at: ${observedAt}
  receipt_id: receipt:test-qualified
  implementation_digest: ${implementationDigest}
`);
  try {
    const requirement = loadKnowledgeSourceRequirement(requirementPath);
    const binding = loadKnowledgeSourceBinding(bindingPath, requirement);
    assert.equal(requirement.version, 2);
    assert.equal(binding.version, 2);
    assert.equal(binding.sourceId, requirement.sourceId);
    assert.equal(binding.state, "active");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
