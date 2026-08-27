import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPANY_KNOWLEDGE_POLICY } from "../../knowledge/access-control.ts";
import { LocalFileKnowledgeSourceConnectorV2 } from "../../connectors/local-file-knowledge-source-v2.ts";
import { LOCAL_FILE_SOURCE_V2_DESCRIPTOR } from "../../connectors/source-registry-maintained.ts";
import { InMemorySourcePipelineStore } from "../../knowledge/in-memory-source-pipeline-store.ts";
import { ingestExactSourceInputV2 } from "../../knowledge/source-ingestion-v2.ts";
import {
  SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
  validateSourceBindingV2,
  validateSourceRequirementV2,
} from "../../knowledge/source-contracts-v2.ts";
import {
  InMemorySessionCorpusStore,
  cleanupExpiredSessionCorpus,
  cleanupOrphanSessionBuffers,
  transferSessionStopBuffer,
  type SessionStopBuffer,
} from "../../knowledge/session-corpus.ts";
import { sha256 } from "../../runtime/canonical.ts";

const now = "2026-08-26T12:00:00.000Z";
const requirement = validateSourceRequirementV2({
  version: 2,
  type: "knowledge-source",
  contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
  sourceId: "local-company-evidence",
  sourceKind: "local-file",
  deliveryMode: "pull",
  dataOwner: "human:knowledge-steward",
  dataClass: "restricted",
  personalData: true,
  retention: { mode: "retain" },
  legalHold: false,
  staleAfterSeconds: 86_400,
  content: { mediaTypes: ["text/plain", "text/markdown", "application/json"], maxInlineBytes: 262_144, maxAssetBytes: 262_144 },
  access: { mode: "fixed-policy", rootPolicyId: COMPANY_KNOWLEDGE_POLICY.policyId },
  providerScope: { kind: "local-input", access: "exact-input-only" },
});
const binding = validateSourceBindingV2({
  version: 2,
  contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
  sourceId: requirement.sourceId,
  installationId: "local-input",
  connectorId: LOCAL_FILE_SOURCE_V2_DESCRIPTOR.connectorId,
  connectorVersion: LOCAL_FILE_SOURCE_V2_DESCRIPTOR.connectorVersion,
  secretRefs: {},
  requiredScopes: [],
  providerIdentity: { kind: "local" },
  state: "active",
  qualification: { qualifiedAt: now, receiptId: "receipt:local-qualified", implementationDigest: LOCAL_FILE_SOURCE_V2_DESCRIPTOR.implementationDigest },
}, requirement);

test("exact local input traverses the shared durable pipeline and retain has no automatic expiry", async () => {
  const connector = new LocalFileKnowledgeSourceConnectorV2({ requirement, binding, descriptor: LOCAL_FILE_SOURCE_V2_DESCRIPTOR, now: () => now });
  const store = new InMemorySourcePipelineStore();
  await store.putPolicy(COMPANY_KNOWLEDGE_POLICY, sha256("company-policy"));
  const bytes = Buffer.from("# Explicit archive\n\nA durable conversation record.\n", "utf8");
  const first = await ingestExactSourceInputV2({
    exactInput: { providerObjectId: "conversation-2026-08-26", mediaType: "text/markdown", bytes, observedAt: now },
    requirement, connector, store, workerId: "test",
  });
  assert.equal(first.outcome, "processed");
  const evidence = await store.currentRawEvidence(requirement.sourceId, "conversation-2026-08-26");
  assert.equal(evidence?.retentionUntil, "9999-12-31T23:59:59.999Z");
  assert.equal(evidence?.content?.inlineText, bytes.toString("utf8"));
  assert.equal(store.events.size, 1);
  assert.equal(store.changes.length, 1);

  const duplicate = await ingestExactSourceInputV2({
    exactInput: { providerObjectId: "conversation-2026-08-26", mediaType: "text/markdown", bytes, observedAt: now },
    requirement, connector, store, workerId: "retry",
  });
  assert.equal(duplicate.outcome, "duplicate");
  assert.equal(store.changes.length, 1);
});

test("local Source rejects unsupported, invalid, and over-limit inline input before a Source Event exists", async () => {
  const connector = new LocalFileKnowledgeSourceConnectorV2({ requirement, binding, descriptor: LOCAL_FILE_SOURCE_V2_DESCRIPTOR, now: () => now });
  await assert.rejects(() => connector.stageExactInput({ providerObjectId: "binary", mediaType: "audio/mpeg", bytes: new Uint8Array([1]), observedAt: now }), /media type/i);
  await assert.rejects(() => connector.stageExactInput({ providerObjectId: "invalid", mediaType: "text/plain", bytes: new Uint8Array([0xff]), observedAt: now }), /UTF-8/i);
  await assert.rejects(() => connector.stageExactInput({ providerObjectId: "large", mediaType: "text/plain", bytes: new Uint8Array(requirement.content.maxInlineBytes + 1), observedAt: now }), /inline boundary/i);
});

const buffer = (input: Partial<SessionStopBuffer> = {}): SessionStopBuffer => ({
  bufferId: "buffer:session-1",
  sessionId: "session-1",
  principalId: "human:peter",
  surface: "agent",
  content: "User decided to preserve this context temporarily.",
  normalizedFormat: "text/plain",
  accessPolicyId: COMPANY_KNOWLEDGE_POLICY.policyId,
  createdAt: now,
  ...input,
});

test("Session transfer is idempotent and removes the stop buffer only after corpus persistence", async () => {
  const store = new InMemorySessionCorpusStore();
  const item = buffer();
  store.stageBuffer(item);
  const first = await transferSessionStopBuffer({ buffer: item, corpusStore: store, stopBufferStore: store, transferredAt: now });
  assert.equal(first.write, "inserted");
  assert.equal(store.buffers.size, 0);
  assert.equal(first.corpus.expiresAt, "2026-09-25T12:00:00.000Z");

  store.stageBuffer(item);
  const retry = await transferSessionStopBuffer({ buffer: item, corpusStore: store, stopBufferStore: store, transferredAt: now });
  assert.equal(retry.write, "unchanged");
  assert.equal(store.buffers.size, 0);
  assert.equal(store.corpus.size, 1);
});

test("failed Session transfer keeps a recoverable buffer", async () => {
  const store = new InMemorySessionCorpusStore();
  const item = buffer({ bufferId: "buffer:failure", sessionId: "session-failure" });
  store.stageBuffer(item);
  const failingStore = {
    putSession: store.putSession.bind(store),
    putCorpus: async () => { throw new Error("simulated storage failure"); },
    getCorpus: store.getCorpus.bind(store),
    markSessionTransferred: store.markSessionTransferred.bind(store),
    markArchived: store.markArchived.bind(store),
    expireCorpus: store.expireCorpus.bind(store),
    putReceipt: store.putReceipt.bind(store),
  };
  await assert.rejects(() => transferSessionStopBuffer({ buffer: item, corpusStore: failingStore, stopBufferStore: store, transferredAt: now }), /storage failure/);
  assert.equal(store.buffers.has(item.bufferId), true);
});

test("orphan buffers expire after seven days and Corpus payloads after 30 days without touching durable evidence", async () => {
  const sessions = new InMemorySessionCorpusStore();
  const old = buffer({ bufferId: "buffer:old", sessionId: "session-old", createdAt: "2026-08-01T00:00:00.000Z" });
  sessions.stageBuffer(old);
  const orphan = await cleanupOrphanSessionBuffers({ stopBufferStore: sessions, corpusStore: sessions, now });
  assert.equal(orphan.removed, 1);

  const current = buffer({ bufferId: "buffer:corpus", sessionId: "session-corpus", createdAt: "2026-07-01T00:00:00.000Z" });
  sessions.stageBuffer(current);
  const transferred = await transferSessionStopBuffer({ buffer: current, corpusStore: sessions, stopBufferStore: sessions, transferredAt: "2026-07-01T00:00:00.000Z" });
  await sessions.markArchived(transferred.session.sessionId, transferred.corpus.corpusId, "durable-source-receipt");
  const cleaned = await cleanupExpiredSessionCorpus({ corpusStore: sessions, now });
  assert.equal(cleaned.expired, 1);
  const expired = await sessions.getCorpus(transferred.corpus.corpusId);
  assert.equal(expired?.content, "");
  assert.equal(expired?.lifecycleStatus, "deleted");
  assert.equal(expired?.archiveReceiptId, "durable-source-receipt");
});
