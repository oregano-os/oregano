import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { engineFixture, ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";
import { sha256 } from "../../runtime/canonical.ts";
import { WorkflowRecordWorkers, parseWorkflowRecordSyncConfiguration } from "../../runtime/workflow-engine/record-workers.ts";
import { createWorkflowRecordSynchronizer, selectWorkflowRecordSource } from "../../runner-vercel/src/lib/workflow-records.ts";
import { InMemoryCompanyRecordsStore } from "../../records/memory-store.ts";
import { RecordSourceConnectorRegistry } from "../../records/source-connector.ts";
import { MondayRecordSourceConnector } from "../../connectors/monday/records-source.ts";
import type { CompanyOSArtifact } from "../../companyos-builder/types.ts";

const rehash = (artifact: CompanyOSArtifact) => {
  const { artifactHash: _, ...content } = artifact;
  artifact.artifactHash = sha256({ ...content, provenance: { ...content.provenance, builtAt: undefined } }); return artifact;
};
const open = (h: ReturnType<typeof engineFixture>) => h.engine().openOperator({ workflowId: "friday-close", principal: ENGINE_OPERATOR,
  requestId: randomUUID(), fields: { sprint_id: "test-one", next_sprint_id: "test-two" } });
const recordArtifact = (original: CompanyOSArtifact, boardId: string) => {
  const artifact = structuredClone(original); artifact.instance.environment = "preview";
  const source = { schema_version: 1, id: "fixture-items", record_type: "work-item", connection: "connections/board.md", resource_binding: "fixture-board",
    delivery: "poll", identity: { source_field: "id" }, fields: [{ target: "title", source: "name", value_type: "string", required: true }], access: { read_groups: ["team"], write_roles: [] } };
  const projection = { schema_version: 1, id: "fixture-view", record_type: "work-item", source_ids: [source.id], fields: [{ name: "title", path: "title" }],
    access: { read_groups: ["team"] }, freshness: { max_age_minutes: 60 }, materialization: { mode: "database-view" } };
  const binding = { schema_version: 1, instance_id: artifact.instance.id, source_id: source.id, resource_binding: source.resource_binding,
    connector: "oregano/monday-record-source", connector_version: "0.3.3", secret_ref: "env:TEST_PROVIDER_TOKEN", qualification: { receipt_ref: "instance:fixture/qualification", digest: "a".repeat(64) },
    configuration: { board_id: boardId, agent_id: "900001", api_version: "dev", permission: "read", group_ids: ["delivery"] } };
  const configuration = { version: 1, environment: "preview", instance_id: artifact.instance.id,
    core: { repository: "example/core", ref: artifact.provenance.coreCommit, core_version: "0.5.14", workbench_version: "0.1.0-experimental.15", clean: true },
    workspace: { repository: "example/workspace", ref: artifact.provenance.workspaceCommit }, source_confirmations: { [source.id]: "b".repeat(64) },
    sources: [source], projections: [projection], bindings: [{ source_id: source.id, binding, qualification: { kind: "monday-external-agent-qualification", phase: "complete", evidence: { discovery: {
      discovery_hash: "a".repeat(64), authentication_mode: "external-agent", credentials_retained: false, configured_agent_id: "900001", identity_mapping_status: "administrator-confirmed",
      account: { id: "300003" }, identity: { memberId: "700007", kind: "external_agent_member", externalAgentId: "900001" },
      resources: [{ scope: "board", id: boardId, permission: "read" }], boards: [{ id: boardId, groups: [{ id: "delivery", archived: false, deleted: false }], columns: [] }],
    } } } }] };
  artifact.connectors = [{ id: "fixture-records", connector: "oregano/company-records", connectorVersion: "1.0.0", configuration: { configuration_snapshot: configuration } }];
  return rehash(artifact);
};

test("source polling is disabled by default and requires bounded exact retained pairs", () => {
  assert.equal(parseWorkflowRecordSyncConfiguration(undefined), undefined);
  const valid = { intervalMinutes: 5, targets: [{ artifactHash: "a".repeat(64), sourceIds: ["fixture-items"] }] };
  assert.deepEqual(parseWorkflowRecordSyncConfiguration(valid), valid);
  for (const value of [null, {}, { ...valid, intervalMinutes: 0 }, { ...valid, extra: true }, { ...valid, targets: [] },
    { ...valid, targets: [...valid.targets, ...valid.targets] }, { ...valid, targets: [{ artifactHash: "main", sourceIds: ["fixture-items"] }] },
    { ...valid, targets: [{ artifactHash: "a".repeat(64), sourceIds: ["fixture-items", "fixture-items"] }] },
    { ...valid, targets: [{ artifactHash: "a".repeat(64), sourceIds: Array.from({ length: 101 }, (_, i) => `source-${i}`) }] }]) assert.throws(() => parseWorkflowRecordSyncConfiguration(value));
});

test("retained source selection refuses mutable references, ambiguous sources and changed Artifact provenance", () => {
  const artifact = recordArtifact(engineFixture().artifact, "200002");
  assert.equal(selectWorkflowRecordSource(artifact, "fixture-items").binding.configuration.board_id, "200002");
  const mutable = structuredClone(artifact); mutable.connectors![0]!.configuration = { configuration_ref: "env:RECORDS_CONFIG" };
  assert.throws(() => selectWorkflowRecordSource(mutable, "fixture-items"), /retained/);
  const ambiguous = structuredClone(artifact); ambiguous.connectors!.push({ ...ambiguous.connectors![0]!, id: "second-records" });
  assert.throws(() => selectWorkflowRecordSource(ambiguous, "fixture-items"), /exactly one/);
  const changed = structuredClone(artifact); changed.provenance.workspaceCommit = "f".repeat(40);
  assert.throws(() => selectWorkflowRecordSource(changed, "fixture-items"), /identity/);
  assert.throws(() => selectWorkflowRecordSource(artifact, "absent"), /exactly one/);
});

test("hosted polling uses actual source adapters and independent generations for a waiting old Artifact after redeployment", async () => {
  const h = engineFixture(); Object.assign(h.artifact, recordArtifact(h.artifact, "200002"));
  const run = await open(h); await h.engine().advance(run.runId);
  const current = recordArtifact(h.artifact, "200003"), records = new InMemoryCompanyRecordsStore(), reads: string[] = [];
  const synchronizeSource = createWorkflowRecordSynchronizer({ store: records, clock: () => new Date(h.now),
    inspectReceipt: async (instanceId, sourceId, runId) => records.syncReceipts.find((receipt) => receipt.instance_id === instanceId && receipt.source_id === sourceId && receipt.run_id === runId),
    select: (artifact, sourceId) => {
      const selected = selectWorkflowRecordSource(artifact, sourceId), boardId = String(selected.binding.configuration.board_id);
      const connector = new MondayRecordSourceConnector({ resolveSecret: () => "synthetic-credential", now: () => new Date(h.now), fetcher: async (_url, init) => {
        const request = JSON.parse(String(init?.body)); assert.doesNotMatch(request.query, /mutation/);
        if (request.query.includes("QualifyCompanyOSExternalAgent")) return Response.json({ data: { me: { id: "700007", name: "Synthetic", kind: "external_agent_member", email: "agent-900001@agent.monday.com", account: { id: "300003", name: "Synthetic" } },
          boards: [{ id: boardId, groups: [{ id: "delivery", archived: false, deleted: false }], columns: [] }] } });
        reads.push(boardId);
        return Response.json({ data: { boards: [{ id: boardId, items_page: { cursor: null, items: [{ id: "800001", name: `Board ${boardId}`, updated_at: h.now, created_at: h.now,
          board: { id: boardId }, group: { id: "delivery" }, column_values: [] }] } }] } });
      } });
      return { ...selected, connectors: new RecordSourceConnectorRegistry([connector]) };
    } });
  const recordSync = { intervalMinutes: 1, targets: [h.artifact, current].map((artifact) => ({ artifactHash: artifact.artifactHash, sourceIds: ["fixture-items"] })) };
  const worker = () => new WorkflowRecordWorkers({ artifact: current, store: h.store, timers: h.timers, recordSync, enabledWorkflowIds: ["friday-close"], synchronizeSource, clock: () => h.now });
  const first = await worker().run(); assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(first.synchronized, 2);
  assert.deepEqual(reads, ["200002", "200003"]);
  for (const [artifact, title] of [[h.artifact, "Board 200002"], [current, "Board 200003"]] as const) {
    const { registry } = selectWorkflowRecordSource(artifact, "fixture-items");
    const row = await registry.scopeStore(records).getCurrentObjectVersion(artifact.instance.id, "fixture-items", "800001");
    assert.equal(row!.values.title, title);
  }
  assert.equal(new Set(records.syncReceipts.map((receipt) => receipt.source_id)).size, 2);
  assert.ok(records.syncReceipts.every((receipt) => receipt.synced_through === undefined), "polling must not manufacture provider cutoff coverage");
  await worker().run(); assert.equal(reads.length, 2, "a reconstructed worker reuses the completed poll");
  const selected = selectWorkflowRecordSource(current, "fixture-items");
  const last = records.syncReceipts.find((receipt) => receipt.source_id === selected.registry.sourceStorageId("fixture-items"))!;
  await synchronizeSource(current, "fixture-items", last.run_id.slice("workflow-records:".length));
  assert.equal(reads.length, 2, "a completed source receipt survives a crash before timer completion");
  await h.engine().cancel(run.runId, ENGINE_OPERATOR); h.now = "2030-01-04T14:31:00.000Z";
  const afterCancel = await worker().run(); assert.equal(afterCancel.synchronized, 1); assert.equal(afterCancel.skipped, 1);
  assert.deepEqual(reads, ["200002", "200003", "200003"]);
});

test("bounded source continuations survive intervals and revocation stops historical reads", async () => {
  const h = engineFixture(), calls: string[] = [];
  const recordSync = { intervalMinutes: 1, targets: [{ artifactHash: h.artifact.artifactHash, sourceIds: Array.from({ length: 7 }, (_, i) => `source-${i}`) }] };
  const worker = (config = recordSync) => new WorkflowRecordWorkers({ artifact: h.artifact, store: h.store, timers: h.timers, recordSync: config,
    enabledWorkflowIds: ["friday-close"], clock: () => h.now, synchronizeSource: async (_artifact, sourceId) => { calls.push(sourceId); return { synthetic: true }; } });
  assert.equal((await worker().run()).continued, true); assert.equal(calls.length, 3);
  h.now = "2030-01-04T14:31:00.000Z"; assert.equal((await worker().run()).continued, true); assert.equal(calls.length, 6);
  h.now = "2030-01-04T14:32:00.000Z"; await worker().run(); assert.equal(calls.length, 7);
  assert.deepEqual(calls, recordSync.targets[0]!.sourceIds);
  const revoked = { ...recordSync, targets: [{ artifactHash: h.artifact.artifactHash, sourceIds: ["source-6"] }] };
  await worker(revoked).run(); assert.deepEqual(calls.slice(7), ["source-6"]);
  const disabled = new WorkflowRecordWorkers({ artifact: h.artifact, store: h.store, timers: h.timers, enabledWorkflowIds: [], recordSync,
    synchronizeSource: async () => { throw new Error("Must not read"); } });
  assert.equal((await disabled.run()).enabled, false);
});

test("source failures are isolated, payload-free and retried by a later qualified poll", async () => {
  const h = engineFixture(), calls: string[] = [];
  const recordSync = { intervalMinutes: 1, targets: [{ artifactHash: h.artifact.artifactHash, sourceIds: ["source-broken", "source-working"] }] };
  const worker = () => new WorkflowRecordWorkers({ artifact: h.artifact, store: h.store, timers: h.timers, recordSync, enabledWorkflowIds: ["friday-close"], clock: () => h.now,
    synchronizeSource: async (_artifact, sourceId) => { calls.push(sourceId); if (sourceId === "source-broken") throw new Error("Private provider response"); return { complete: true }; } });
  const failed = await worker().run(); assert.equal(failed.ok, false); assert.equal(failed.synchronized, 1); assert.equal(failed.errors.length, 1);
  assert.doesNotMatch(JSON.stringify(failed), /Private provider response/);
  await worker().run(); assert.equal(calls.length, 2);
  h.now = "2030-01-04T14:31:00.000Z"; await worker().run(); assert.equal(calls.length, 4);
});
