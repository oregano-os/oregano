import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GITHUB_SOURCE_V2_DESCRIPTOR,
  createMaintainedSourceConnectorRegistry,
} from "../../connectors/source-registry-maintained.ts";
import { InMemorySourcePipelineStore } from "../../knowledge/in-memory-source-pipeline-store.ts";
import {
  SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
  type SourceBindingV2,
  type SourceConnectorV2,
  type SourceRequirementV2,
} from "../../knowledge/source-contracts-v2.ts";
import type { KnowledgeSourceBinding, KnowledgeSourceRequirement } from "../../knowledge/source-contracts.ts";
import { syncPullSourceV2 } from "../../knowledge/source-sync-v2.ts";
import { mapStoredSourceRawEvidence } from "../../state-postgres/source-pipeline-store.ts";

const sha = (character: string): string => character.repeat(40);
const response = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});

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
  maxObjectBytes: 64_000,
  staleAfterHours: 24,
};

const legacyBinding: KnowledgeSourceBinding = {
  version: 1,
  sourceId: legacyRequirement.sourceId,
  connector: "oregano/github-repository-source",
  connectorVersion: "1.0.0",
  secretRef: "env:TEST_GITHUB_TOKEN",
  owner: "example",
  repository: "company",
  ref: "main",
  apiBaseUrl: "https://api.example.test",
  requiredScopes: ["contents:read"],
};

test("the maintained V1 GitHub registration runs through the V2 durable pipeline without duplicate evidence", async () => {
  const policy = "# Policy\n\nEvery item has one accountable owner.\n";
  const process = "# Process\n\nRenewals use a documented checklist.\n";
  let treeSha = sha("a");
  let entries = [
    { path: "docs/policy.md", type: "blob", sha: sha("b"), size: Buffer.byteLength(policy) },
    { path: "docs/process.md", type: "blob", sha: sha("c"), size: Buffer.byteLength(process) },
  ];
  const blobs = new Map([[sha("b"), policy], [sha("c"), process]]);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/repos/example/company")) return response({ full_name: "example/company" });
    if (url.includes("/git/trees/")) return response({ sha: treeSha, truncated: false, tree: entries });
    const version = [...blobs.keys()].find((candidate) => url.endsWith(`/git/blobs/${candidate}`));
    if (version) return response({ encoding: "base64", content: Buffer.from(blobs.get(version)!).toString("base64") });
    return response({ message: "not found" }, 404);
  };
  const registry = createMaintainedSourceConnectorRegistry({
    resolveSecret: () => "credential-that-must-not-enter-evidence",
    fetch: fakeFetch,
    now: () => "2026-08-26T10:00:00.000Z",
    retryDelay: async () => {},
  });
  const resolution = registry.resolve({ requirement: legacyRequirement, binding: legacyBinding, operation: "sync" });
  assert.equal(resolution.compatibility, "repository-v1");
  assert.ok("descriptor" in resolution.connector);
  assert.equal((resolution.connector as SourceConnectorV2).descriptor.connectorVersion, "1.0.0");
  const store = new InMemorySourcePipelineStore();
  const first = await syncPullSourceV2({
    requirement: resolution.normalizedRequirement,
    binding: resolution.normalizedBinding,
    connector: resolution.connector as SourceConnectorV2,
    store,
    workerId: "test:github",
    pageSize: 1,
    now: () => "2026-08-26T10:00:00.000Z",
  });
  assert.equal(first.complete, true);
  assert.equal(first.pages, 2);
  assert.equal(first.enumerated, 2);
  assert.equal(first.results.filter((entry) => entry.outcome === "quarantined").length, 2);
  assert.equal(store.rawEvidence.size, 2);
  assert.equal(store.changes.length, 2);
  assert.equal((await store.currentRawEvidence(legacyRequirement.sourceId, "docs/policy.md"))?.retentionUntil, "9999-12-31T23:59:59.999Z");

  const second = await syncPullSourceV2({
    requirement: resolution.normalizedRequirement,
    binding: resolution.normalizedBinding,
    connector: resolution.connector as SourceConnectorV2,
    store,
    workerId: "test:github",
    pageSize: 1,
    now: () => "2026-08-26T10:00:00.000Z",
  });
  assert.equal(second.complete, true);
  assert.equal(second.unchanged, 2);
  assert.equal(store.rawEvidence.size, 2);
  assert.equal(store.changes.length, 2);

  treeSha = sha("d");
  entries = [{ path: "docs/policy.md", type: "blob", sha: sha("b"), size: Buffer.byteLength(policy) }];
  const removed = await syncPullSourceV2({
    requirement: resolution.normalizedRequirement,
    binding: resolution.normalizedBinding,
    connector: resolution.connector as SourceConnectorV2,
    store,
    workerId: "test:github",
    pageSize: 1,
    now: () => "2026-08-26T10:00:00.000Z",
  });
  assert.equal(removed.deletionEvents, 1);
  const deleted = await store.currentRawEvidence(legacyRequirement.sourceId, "docs/process.md");
  assert.equal(deleted?.envelope.deletionState, "deleted");
  assert.equal(deleted?.content && "inlineText" in deleted.content ? deleted.content.inlineText : undefined, process);

  treeSha = sha("e");
  entries.push({ path: "docs/process.md", type: "blob", sha: sha("c"), size: Buffer.byteLength(process) });
  const restored = await syncPullSourceV2({
    requirement: resolution.normalizedRequirement,
    binding: resolution.normalizedBinding,
    connector: resolution.connector as SourceConnectorV2,
    store,
    workerId: "test:github",
    pageSize: 2,
    now: () => "2026-08-26T10:00:00.000Z",
  });
  assert.equal(restored.complete, true);
  assert.equal(store.rawEvidence.size, 2, "reappearance does not rewrite immutable Raw Evidence");
  assert.equal((await store.currentRawEvidence(legacyRequirement.sourceId, "docs/process.md"))?.envelope.deletionState, "present");
  assert.ok(calls.every((entry) => entry.init?.method === "GET"));
  assert.equal(JSON.stringify([...store.receipts.values()]).includes("credential-that-must-not-enter-evidence"), false);
});

test("GitHub V2 enumeration fails closed on cursor tampering, tree drift, truncation, and unsafe paths", async () => {
  let treeSha = sha("a");
  let truncated = false;
  let tree = [
    { path: "docs/a.md", type: "blob", sha: sha("b"), size: 10 },
    { path: "docs/b.md", type: "blob", sha: sha("c"), size: 10 },
    { path: "../secret.md", type: "blob", sha: sha("d"), size: 10 },
  ];
  const registry = createMaintainedSourceConnectorRegistry({
    resolveSecret: () => "token",
    now: () => "2026-08-26T11:00:00.000Z",
    fetch: async (input) => String(input).endsWith("/repos/example/company")
      ? response({ full_name: "example/company" })
      : response({ sha: treeSha, truncated, tree }),
  });
  const resolution = registry.resolve({ requirement: legacyRequirement, binding: legacyBinding, operation: "sync" });
  const connector = resolution.connector as SourceConnectorV2;
  const first = await connector.enumerate!({ pageSize: 1 });
  assert.equal(first.objects.length, 1);
  assert.ok(first.nextCursor);
  await assert.rejects(() => connector.enumerate!({ cursor: `${first.nextCursor}x`, pageSize: 1 }), /cursor/i);
  treeSha = sha("f");
  await assert.rejects(() => connector.enumerate!({ cursor: first.nextCursor, pageSize: 1 }), /same immutable tree/i);
  treeSha = sha("a");
  truncated = true;
  await assert.rejects(() => connector.enumerate!({ pageSize: 1 }), /truncated/i);
  truncated = false;
  tree = [{ path: "../secret.md", type: "blob", sha: sha("d"), size: 10 }];
  const safe = await connector.enumerate!({ pageSize: 10 });
  assert.deepEqual(safe.objects, []);
});

test("native GitHub V2 bindings require exact active implementation qualification", () => {
  const requirement: SourceRequirementV2 = {
    version: 2,
    type: "knowledge-source",
    contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
    sourceId: "native-repository",
    sourceKind: "repository",
    deliveryMode: "pull",
    dataOwner: "human:knowledge-steward",
    dataClass: "confidential",
    personalData: true,
    retention: { mode: "retain" },
    legalHold: false,
    staleAfterSeconds: 86_400,
    content: { mediaTypes: ["text/markdown"], maxInlineBytes: 64_000, maxAssetBytes: 64_000 },
    access: { mode: "quarantine", rootPolicyId: "policy:quarantine" },
    providerScope: { kind: "repository", pathPrefix: "docs", includeExtensions: [".md"] },
  };
  const binding: SourceBindingV2 = {
    version: 2,
    contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
    sourceId: requirement.sourceId,
    installationId: "installation:github-native",
    connectorId: GITHUB_SOURCE_V2_DESCRIPTOR.connectorId,
    connectorVersion: GITHUB_SOURCE_V2_DESCRIPTOR.connectorVersion,
    secretRefs: { primary: "env:TEST_GITHUB_TOKEN" },
    requiredScopes: ["contents:read"],
    providerIdentity: { kind: "repository", accountId: "example", repositoryId: "company", ref: "main", apiBaseUrl: "https://api.example.test" },
    state: "active",
    qualification: {
      qualifiedAt: "2026-08-26T11:00:00.000Z",
      receiptId: sha("9"),
      implementationDigest: GITHUB_SOURCE_V2_DESCRIPTOR.implementationDigest,
    },
  };
  const registry = createMaintainedSourceConnectorRegistry({ resolveSecret: () => "token" });
  const resolution = registry.resolve({ requirement, binding, operation: "sync" });
  assert.equal(resolution.compatibility, "native-v2");
  assert.equal((resolution.connector as SourceConnectorV2).descriptor.connectorVersion, "2.0.0");
  assert.throws(() => registry.resolve({
    requirement,
    binding: { ...binding, qualification: { ...binding.qualification!, implementationDigest: sha("8") } },
    operation: "sync",
  }), /qualification/i);
});

test("legacy flat repository envelopes remain readable as V2 Raw Evidence without rewriting history", () => {
  const content = "# Historical policy\n\nRetain this version.\n";
  const mapped = mapStoredSourceRawEvidence({
    source_id: legacyRequirement.sourceId,
    provider_object_id: "docs/historical.md",
    provider_version: sha("7"),
    content_digest: "f".repeat(64),
    envelope: {
      sourceId: legacyRequirement.sourceId,
      providerObjectId: "docs/historical.md",
      providerVersion: sha("7"),
      observedAt: "2026-08-25T10:00:00.000Z",
      mediaType: "text/markdown",
      contentDigest: "f".repeat(64),
      ownerOrAccount: "example/company",
      cursorOrEventId: "legacy-cursor",
      deletionState: "present",
      receiptMetadata: {},
      boundedText: content,
    },
    retention_until: "9999-12-31T23:59:59.999Z",
    first_seen_at: "2026-08-25T10:00:00.000Z",
    access_policy_id: "policy:quarantine",
    provider_acl: {},
    provider_locator: "docs/historical.md",
    byte_size: Buffer.byteLength(content),
    mime_type: "text/markdown",
    model_ready: false,
    payload_state: "active",
    deletion_state: "present",
  });
  assert.equal(mapped.envelope.providerObjectId, "docs/historical.md");
  assert.equal(mapped.envelope.providerTenantId, "example/company");
  assert.equal(mapped.content && "inlineText" in mapped.content ? mapped.content.inlineText : undefined, content);
  assert.equal(mapped.modelReady, false);
  assert.equal(mapped.retentionUntil, "9999-12-31T23:59:59.999Z");
});
