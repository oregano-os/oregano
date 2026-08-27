import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  GRANOLA_SOURCE_V2_DESCRIPTOR,
  createMaintainedSourceConnectorRegistry,
} from "../../connectors/source-registry-maintained.ts";
import type { KnowledgeAccessPolicy } from "../../knowledge/contracts.ts";
import { InMemorySourcePipelineStore } from "../../knowledge/in-memory-source-pipeline-store.ts";
import { processSourceEventV2 } from "../../knowledge/source-ingestion-v2.ts";
import {
  SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
  type SourceBindingV2,
  type SourceConnectorV2,
  type SourceRequirementV2,
} from "../../knowledge/source-contracts-v2.ts";
import { acceptSourceWebhookV2, syncChangedSourceV2 } from "../../knowledge/source-sync-v2.ts";
import { createPostgresInlineRawAssetStager } from "../../state-postgres/raw-asset-adapter.ts";

const observedAt = "2026-08-26T12:00:00.000Z";
const webhookTimestamp = String(Date.parse(observedAt) / 1_000);
const folderId = "fol_4y6LduVdwSKC27";
const workspaceId = "workspace:granola-company";
const signingSecret = `whsec_${Buffer.from("bounded-test-signing-key-32-bytes!").toString("base64")}`;

const requirement = (overrides: Partial<SourceRequirementV2> = {}): SourceRequirementV2 => ({
  version: 2,
  type: "knowledge-source",
  contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
  sourceId: "company-meetings",
  sourceKind: "meeting",
  deliveryMode: "hybrid",
  dataOwner: "human:knowledge-steward",
  dataClass: "restricted",
  personalData: true,
  retention: { mode: "retain" },
  legalHold: false,
  staleAfterSeconds: 21_600,
  content: { mediaTypes: ["text/markdown"], maxInlineBytes: 128_000, maxAssetBytes: 1_000_000 },
  access: { mode: "fixed-policy", rootPolicyId: "policy:meetings" },
  providerScope: { kind: "workspace-containers", workspaceId, containerIds: [folderId] },
  ...overrides,
});

const binding = (target = requirement(), overrides: Partial<SourceBindingV2> = {}): SourceBindingV2 => ({
  version: 2,
  contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
  sourceId: target.sourceId,
  installationId: "installation:granola-company",
  connectorId: GRANOLA_SOURCE_V2_DESCRIPTOR.connectorId,
  connectorVersion: GRANOLA_SOURCE_V2_DESCRIPTOR.connectorVersion,
  secretRefs: { primary: "env:TEST_GRANOLA_API_KEY", webhook: "env:TEST_GRANOLA_WEBHOOK_SECRET" },
  requiredScopes: ["workspace"],
  providerIdentity: { kind: "workspace", workspaceId, apiBaseUrl: "https://public-api.granola.test" },
  state: "active",
  qualification: {
    qualifiedAt: observedAt,
    receiptId: "receipt:granola-qualification",
    implementationDigest: GRANOLA_SOURCE_V2_DESCRIPTOR.implementationDigest,
  },
  ...overrides,
});

const meetingPolicy: KnowledgeAccessPolicy = {
  policyId: "policy:meetings",
  policyVersion: 1,
  visibility: "restricted_group",
  sourceRoot: true,
  status: "active",
  entries: [{ subjectKind: "group", subjectId: "company:meeting-readers", permission: "read", effect: "allow" }],
};

const response = (value: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json", ...headers },
});

const note = (id: string, updatedAt = "2026-08-26T11:30:00.000Z") => ({
  id,
  object: "note",
  title: "Weekly operating review",
  owner: { name: "Alex Example", email: "alex@example.test" },
  created_at: "2026-08-26T11:00:00.000Z",
  updated_at: updatedAt,
  web_url: "https://notes.granola.test/d/example",
  calendar_event: {},
  attendees: [{ name: "Alex Example", email: "alex@example.test" }, { name: "Sam Example", email: "sam@example.test" }],
  folder_membership: [{ id: folderId, object: "folder", name: "Operations", parent_folder_id: null }],
  summary_text: "The team agreed on the next operating checkpoint.",
  summary_markdown: "## Outcome\n\nThe team agreed on the next operating checkpoint.",
  transcript: [
    { speaker: { source: "microphone", attribution: "me", name: "Alex Example" }, text: "We will review the result next Friday.", start_time: "2026-08-26T11:01:00.000Z", end_time: "2026-08-26T11:01:03.000Z" },
  ],
});

const signedWebhook = (payload: Record<string, unknown>, timestamp = webhookTimestamp) => {
  const rawText = JSON.stringify(payload);
  const rawBody = new TextEncoder().encode(rawText);
  const key = Buffer.from(signingSecret.slice("whsec_".length), "base64");
  const signature = createHmac("sha256", key).update(`${String(payload.event_id)}.${timestamp}.${rawText}`, "utf8").digest("base64");
  return {
    rawBody,
    headers: {
      "webhook-id": String(payload.event_id),
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    },
  };
};

test("signed Granola webhooks persist reference events before fetch and replay idempotently", async () => {
  const noteId = "not_1d3tmYTlCICgjy";
  const target = requirement();
  const calls: string[] = [];
  const registry = createMaintainedSourceConnectorRegistry({
    resolveSecret: (reference) => reference.includes("WEBHOOK") ? signingSecret : "granola-api-token",
    now: () => observedAt,
    fetch: async (input, init) => {
      const url = String(input);
      calls.push(url);
      assert.equal(init?.method, "GET");
      if (url.includes("/v1/folders")) return response({ folders: [{ id: folderId, object: "folder", name: "Operations", parent_folder_id: null }], hasMore: false, cursor: null });
      if (url.includes(`/v1/notes/${noteId}`)) return response(note(noteId));
      return response({ message: "not found" }, 404);
    },
  });
  const resolution = registry.resolve({ requirement: target, binding: binding(target), operation: "sync" });
  const connector = resolution.connector as SourceConnectorV2;
  const store = new InMemorySourcePipelineStore();
  await store.putPolicy(meetingPolicy, "a".repeat(64));
  const delivery = signedWebhook({
    event_id: "8f1c2a4e-6b3d-4e8f-9a2b-1c5d7e9f0a3b",
    event_type: "note.generated",
    note_id: noteId,
    occurred_at: "2026-08-26T11:30:00.000Z",
  });
  const accepted = await acceptSourceWebhookV2({ connector, store, ...delivery, observedAt });
  assert.deepEqual({ accepted: accepted.accepted, duplicate: accepted.duplicate }, { accepted: 1, duplicate: 0 });
  assert.equal(calls.length, 0, "webhook acknowledgement persists the reference without provider fetch");
  const replay = await acceptSourceWebhookV2({ connector, store, ...delivery, observedAt });
  assert.deepEqual({ accepted: replay.accepted, duplicate: replay.duplicate }, { accepted: 0, duplicate: 1 });
  const event = store.events.get(accepted.eventIds[0])!.event;
  assert.equal(event.providerVersion, undefined);
  const processed = await processSourceEventV2({ event, connector, requirement: target, store, workerId: "test:granola", now: () => observedAt });
  assert.equal(processed.outcome, "processed");
  const evidence = await store.currentRawEvidence(target.sourceId, noteId);
  assert.equal(evidence?.envelope.providerVersion, "2026-08-26T11:30:00.000Z");
  assert.match(evidence?.content && "inlineText" in evidence.content ? evidence.content.inlineText ?? "" : "", /Alex Example: We will review/);
  assert.equal(JSON.stringify([...store.receipts.values()]).includes("granola-api-token"), false);
});

test("Granola reconciliation uses bounded pagination and converges with an already ingested webhook revision", async () => {
  const target = requirement();
  const noteA = "not_1d3tmYTlCICgjy";
  const noteB = "not_2d3tmYTlCICgjz";
  const listQueries: URL[] = [];
  const registry = createMaintainedSourceConnectorRegistry({
    resolveSecret: (reference) => reference.includes("WEBHOOK") ? signingSecret : "token",
    now: () => observedAt,
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/folders") return response({ folders: [{ id: folderId }], hasMore: false, cursor: null });
      if (url.pathname === "/v1/notes") {
        listQueries.push(url);
        if (!url.searchParams.get("cursor")) return response({ notes: [{ id: noteA, updated_at: "2026-08-26T11:30:00.000Z" }], hasMore: true, cursor: "page-2" });
        return response({ notes: [{ id: noteB, updated_at: "2026-08-26T11:45:00.000Z" }], hasMore: false, cursor: null });
      }
      if (url.pathname === `/v1/notes/${noteA}`) return response(note(noteA));
      if (url.pathname === `/v1/notes/${noteB}`) return response(note(noteB, "2026-08-26T11:45:00.000Z"));
      return response({ message: "not found" }, 404);
    },
  });
  const connector = registry.resolve({ requirement: target, binding: binding(target), operation: "sync" }).connector as SourceConnectorV2;
  const store = new InMemorySourcePipelineStore();
  await store.putPolicy(meetingPolicy, "b".repeat(64));

  const webhook = signedWebhook({ event_id: "9f1c2a4e-6b3d-4e8f-9a2b-1c5d7e9f0a3b", event_type: "note.generated", note_id: noteA, occurred_at: "2026-08-26T11:30:00.000Z" });
  const accepted = await connector.acceptWebhook!({ ...webhook, observedAt });
  await processSourceEventV2({ event: accepted.events[0], connector, requirement: target, store, workerId: "test:webhook", now: () => observedAt });
  const evidenceBefore = store.rawEvidence.size;
  const result = await syncChangedSourceV2({
    connector,
    requirement: target,
    store,
    workerId: "test:reconcile",
    pageSize: 30,
    overlapFrom: "2026-08-25T12:00:00.000Z",
    now: () => observedAt,
  });
  assert.equal(result.complete, true);
  assert.equal(result.pages, 2);
  assert.equal(result.received, 2);
  assert.equal(result.unchanged, 1);
  assert.equal(store.rawEvidence.size, evidenceBefore + 1);
  assert.ok(listQueries.every((url) => Number(url.searchParams.get("page_size")) <= 30));
  assert.ok(listQueries.every((url) => url.searchParams.get("updated_after") === "2026-08-25T12:00:00.000Z"));
  assert.ok(listQueries.every((url) => url.searchParams.get("folder_id") === folderId));
  assert.equal((await store.getWatermark(target.sourceId, "hybrid-changes"))?.completed, true);
});

test("provider-wide Granola reconciliation uses personal and public scopes without a folder filter", async () => {
  const noteId = "not_7d3tmYTlCICgjw";
  const target = requirement({ providerScope: { kind: "workspace", workspaceId } });
  const listQueries: URL[] = [];
  const registry = createMaintainedSourceConnectorRegistry({
    resolveSecret: (reference) => reference.includes("WEBHOOK") ? signingSecret : "personal-token",
    now: () => observedAt,
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/notes" && url.searchParams.get("page_size") === "1") return response({ notes: [], hasMore: false, cursor: null });
      if (url.pathname === "/v1/notes") {
        listQueries.push(url);
        return response({ notes: [{ id: noteId, updated_at: "2026-08-26T11:30:00.000Z" }], hasMore: false, cursor: null });
      }
      if (url.pathname === `/v1/notes/${noteId}`) return response({ ...note(noteId), folder_membership: [] });
      return response({ message: "not found" }, 404);
    },
  });
  const connector = registry.resolve({
    requirement: target,
    binding: binding(target, { requiredScopes: ["personal", "public"] }),
    operation: "sync",
  }).connector as SourceConnectorV2;
  const verification = await connector.verify();
  assert.deepEqual(verification.verifiedScopes, ["personal", "public"]);
  const store = new InMemorySourcePipelineStore();
  await store.putPolicy(meetingPolicy, "d".repeat(64));
  const result = await syncChangedSourceV2({
    connector,
    requirement: target,
    store,
    workerId: "test:provider-wide",
    pageSize: 30,
    overlapFrom: "2026-08-25T12:00:00.000Z",
    now: () => observedAt,
  });
  assert.equal(result.complete, true);
  assert.equal(result.results.filter((entry) => entry.outcome === "processed").length, 1);
  assert.equal(listQueries.length, 1);
  assert.equal(listQueries[0].searchParams.has("folder_id"), false);
  assert.ok(await store.currentRawEvidence(target.sourceId, noteId));
});

test("Granola validates transcript pagination, scope, retry bounds, and oversized-content failure", async () => {
  const noteId = "not_3d3tmYTlCICgjq";
  let folderAttempts = 0;
  const target = requirement({ content: { mediaTypes: ["text/markdown"], maxInlineBytes: 700, maxAssetBytes: 5_000 } });
  const registry = createMaintainedSourceConnectorRegistry({
    resolveSecret: (reference) => reference.includes("WEBHOOK") ? signingSecret : "token",
    now: () => observedAt,
    retryDelay: async () => {},
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/folders") {
        folderAttempts += 1;
        if (folderAttempts < 3) return response({ message: "rate limited" }, 429, { "retry-after": "0" });
        return response({ folders: [{ id: folderId }], hasMore: false, cursor: null });
      }
      if (url.pathname === `/v1/notes/${noteId}` && url.searchParams.get("include") === "transcript") return response({ code: "TRANSCRIPT_TOO_LARGE" }, 413);
      if (url.pathname === `/v1/notes/${noteId}`) return response({ ...note(noteId), transcript: undefined });
      if (url.pathname.endsWith("/transcript")) {
        if (!url.searchParams.get("cursor")) return response({ transcript: [{ speaker: { name: "A" }, text: Array.from({ length: 80 }, (_, index) => `alpha${index}`).join(" ") }], hasMore: true, cursor: "next" });
        return response({ transcript: [{ speaker: { name: "B" }, text: Array.from({ length: 80 }, (_, index) => `beta${index}`).join(" ") }], hasMore: false, cursor: null });
      }
      return response({ message: "not found" }, 404);
    },
  });
  const connector = registry.resolve({ requirement: target, binding: binding(target), operation: "sync" }).connector as SourceConnectorV2;
  const verification = await connector.verify();
  assert.equal(verification.ok, true);
  assert.equal(folderAttempts, 3);
  const store = new InMemorySourcePipelineStore();
  await store.putPolicy(meetingPolicy, "c".repeat(64));
  const webhook = signedWebhook({ event_id: "af1c2a4e-6b3d-4e8f-9a2b-1c5d7e9f0a3b", event_type: "note.edited", note_id: noteId, occurred_at: "2026-08-26T11:30:00.000Z" });
  const accepted = await connector.acceptWebhook!({ ...webhook, observedAt });
  const result = await processSourceEventV2({ event: accepted.events[0], connector, requirement: target, store, workerId: "test:large", now: () => observedAt });
  assert.equal(result.outcome, "failed");
  assert.match(result.failureClass ?? "", /content|storage/);

  const outOfScopeConnector = createMaintainedSourceConnectorRegistry({
    resolveSecret: (reference) => reference.includes("WEBHOOK") ? signingSecret : "token",
    now: () => observedAt,
    fetch: async (input) => String(input).includes("/v1/folders")
      ? response({ folders: [{ id: folderId }], hasMore: false, cursor: null })
      : response({ ...note(noteId), folder_membership: [{ id: "fol_5y6LduVdwSKC28" }] }),
  }).resolve({ requirement: target, binding: binding(target), operation: "sync" }).connector as SourceConnectorV2;
  const outOfScopeEvent = (await outOfScopeConnector.acceptWebhook!({ ...webhook, observedAt })).events[0];
  await assert.rejects(() => outOfScopeConnector.fetch(outOfScopeEvent), /outside the configured folder scope/);
});

test("Granola preserves a complete oversized transcript through the qualified Raw Asset stager", async () => {
  const noteId = "not_8d3tmYTlCICgjx";
  const target = requirement({ content: { mediaTypes: ["text/markdown"], maxInlineBytes: 700, maxAssetBytes: 5_000 } });
  const registry = createMaintainedSourceConnectorRegistry({
    resolveSecret: (reference) => reference.includes("WEBHOOK") ? signingSecret : "token",
    rawAssetStager: createPostgresInlineRawAssetStager(),
    now: () => observedAt,
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/v1/notes/${noteId}` && url.searchParams.get("include") === "transcript") return response({ code: "TRANSCRIPT_TOO_LARGE" }, 413);
      if (url.pathname === `/v1/notes/${noteId}`) return response({ ...note(noteId), transcript: undefined });
      if (url.pathname.endsWith("/transcript")) {
        if (!url.searchParams.get("cursor")) return response({ transcript: [{ speaker: { name: "A" }, text: Array.from({ length: 80 }, (_, index) => `alpha${index}`).join(" ") }], hasMore: true, cursor: "next" });
        return response({ transcript: [{ speaker: { name: "B" }, text: Array.from({ length: 80 }, (_, index) => `beta${index}`).join(" ") }], hasMore: false, cursor: null });
      }
      return response({ message: "not found" }, 404);
    },
  });
  const connector = registry.resolve({ requirement: target, binding: binding(target), operation: "sync" }).connector as SourceConnectorV2;
  const store = new InMemorySourcePipelineStore();
  await store.putPolicy(meetingPolicy, "e".repeat(64));
  const webhook = signedWebhook({ event_id: "cf1c2a4e-6b3d-4e8f-9a2b-1c5d7e9f0a3b", event_type: "note.edited", note_id: noteId, occurred_at: "2026-08-26T11:30:00.000Z" });
  const accepted = await connector.acceptWebhook!({ ...webhook, observedAt });
  const result = await processSourceEventV2({ event: accepted.events[0], connector, requirement: target, store, workerId: "test:asset", now: () => observedAt });
  assert.equal(result.outcome, "processed");
  const evidence = await store.currentRawEvidence(target.sourceId, noteId);
  assert.ok(evidence?.content && "rawAsset" in evidence.content);
  const assetId = evidence?.content && "rawAsset" in evidence.content ? evidence.content.rawAsset?.assetId : undefined;
  assert.ok(assetId);
  const payload = store.rawAssetPayloads.get(assetId!);
  assert.ok(payload);
  const transcript = new TextDecoder().decode(payload);
  assert.match(transcript, /A: alpha0 alpha1/);
  assert.match(transcript, /B: beta0 beta1/);
});

test("Granola rejects replayed or invalid webhook signatures and unsupported provider ACL claims", async () => {
  const target = requirement();
  const registry = createMaintainedSourceConnectorRegistry({
    resolveSecret: (reference) => reference.includes("WEBHOOK") ? signingSecret : "token",
    now: () => observedAt,
    fetch: async () => response({ folders: [{ id: folderId }], hasMore: false, cursor: null }),
  });
  const connector = registry.resolve({ requirement: target, binding: binding(target), operation: "sync" }).connector as SourceConnectorV2;
  const delivery = signedWebhook({ event_id: "bf1c2a4e-6b3d-4e8f-9a2b-1c5d7e9f0a3b", event_type: "note.generated", note_id: "not_1d3tmYTlCICgjy", occurred_at: observedAt });
  await assert.rejects(() => connector.acceptWebhook!({ ...delivery, headers: { ...delivery.headers, "webhook-signature": "v1,invalid" }, observedAt }), /signature/);
  await assert.rejects(() => connector.acceptWebhook!({ ...signedWebhook(JSON.parse(new TextDecoder().decode(delivery.rawBody)), "1"), observedAt }), /replay window/);
  const providerAcl = requirement({ access: { mode: "provider-acl", mappingId: "mapping:granola", rootPolicyId: "policy:meetings", unresolvedPolicyId: "policy:quarantine" } });
  assert.throws(() => registry.resolve({ requirement: providerAcl, binding: binding(providerAcl), operation: "sync" }), /does not expose sufficient per-note principal ACL/i);
});
