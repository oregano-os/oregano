import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { engineArtifact, engineFixture, ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";
import { openParityClose, wakeParity } from "./workflow-parity-cases.ts";
import { CompanyRecordsConnector } from "../../connectors/company-records.ts";
import { InMemoryCompanyRecordsStore } from "../../records/memory-store.ts";
import { CompanyRecordsRegistry } from "../../records/registry.ts";
import { CompanyRecordsService } from "../../records/service.ts";
import { RecordIdentityDirectory } from "../../records/identity-directory.ts";
import { synchronizeRecordSnapshot } from "../../records/synchronization.ts";
import { recordSourceBindingDigest, type CompanyRecordSourceBinding } from "../../records/source-connector.ts";
import { projectionRecordId } from "../../records/identity.ts";
import type { RecordQueryResult } from "../../records/contracts.ts";
import type { JsonValue } from "../../capabilities/contracts.ts";
import { sha256 } from "../../runtime/canonical.ts";

const rolesId = "monday-roles", itemsId = "monday-sprint-board", messagesId = "slack-close-submissions";
const reportAt = "2030-01-04T16:00:00.000Z";
const principal = (id: number) => `slack:T10001:U1000${id}`;
const text = (item: string) => `MY FRIDAY SPRINT UPDATE\nTHIS WEEK\nhttps://lindenhof.example.test/boards/board/pulses/${item} — Finished the draft\nBiggest blocker / learning: Clarify the brief\nNEXT WEEK\nSprint goal: Deliver the next draft\nMeasurable outcome: One reviewed draft\nhttps://lindenhof.example.test/boards/board/pulses/next-card — Next draft`;
const message = (id: string, member: number, item: string, thread: string, at = "2030-01-04T15:30:00Z") => ({
  id, thread_reference: thread, author_principal: principal(member), content_author_principal: principal(member), author_kind: "user",
  occurred_at: at, accepted_at: "2030-01-04T16:01:00Z", text: text(item),
});

/** Actual Records normalization, registry, source generations, parser, projections,
 * access control and Connector. Only complete provider inventories are synthetic.
 */
function pipeline(t: TestContext, options: { mayRead?: boolean; unknownRole?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "workflow-record-pipeline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(resolve(import.meta.dirname, "lindenhof-studio"), root, { recursive: true });
  const workflow = join(root, "workflows/friday-close.compact.md");
  writeFileSync(workflow, readFileSync(workflow, "utf8").replaceAll("require_synced_through", "require_scan_started_after"));
  const rosterPath = join(root, "handbook/roster.md");
  let roster = readFileSync(rosterPath, "utf8").replace("name: Jonas Example", "name: Shared Example").replace("name: Lea Example", "name: Shared Example");
  if (options.mayRead !== false) roster = roster.replace("id: mara-steward\n", "id: mara-steward\n    groups: [sprint-process-steward]\n");
  writeFileSync(rosterPath, roster);
  const sourcePath = join(root, "records/sources/slack-close-submissions.yaml");
  const source = YAML.parse(readFileSync(sourcePath, "utf8"));
  source.fields.find((field: any) => field.target === "accepted_at").source = "occurred_at";
  writeFileSync(sourcePath, YAML.stringify(source));
  const artifact = engineArtifact(undefined, root), identities = new RecordIdentityDirectory(artifact.roster);
  const registry = new CompanyRecordsRegistry({ identities }), store = new InMemoryCompanyRecordsStore();
  for (const file of readdirSync(join(root, "records/sources"))) registry.registerSource(YAML.parse(readFileSync(join(root, "records/sources", file), "utf8")));
  for (const file of readdirSync(join(root, "records/projections"))) registry.registerProjection(YAML.parse(readFileSync(join(root, "records/projections", file), "utf8")));
  const bindings = new Map<string, CompanyRecordSourceBinding>();
  for (const id of [rolesId, itemsId, messagesId]) {
    const binding: CompanyRecordSourceBinding = { schema_version: 1, instance_id: artifact.instance.id, source_id: id,
      resource_binding: registry.source(id).resource_binding, connector: "synthetic/inventory", connector_version: "1.0.0",
      secret_ref: "UNUSED_SYNTHETIC_SECRET", configuration: {}, qualification: { receipt_ref: "synthetic", digest: "synthetic" } };
    bindings.set(id, binding); registry.bindSource(binding, { synthetic: true });
  }
  const service = new CompanyRecordsService({ instanceId: artifact.instance.id, registry, store, now: () => new Date(h.now) });
  const h = engineFixture({ artifact, recordsConnector: new CompanyRecordsConnector(service) });
  const rows: Record<string, Record<string, JsonValue>[]> = {
    [rolesId]: [2, 3, 4].map((id) => ({ id: `role-${id}`, name: "Shared Example", people_principals: { people: [`monday:300001:${options.unknownRole && id === 2 ? "unknown" : `100${id}`}`] },
      column_text: { role: id === 2 ? "Review" : "Delivery" }, group_id: "hq", state: "active", updated_at: h.now })),
    [itemsId]: [2, 3, 4].map((id) => ({ id: `item-${id}`, provider_id: `item-${id}`, name: `Deliverable ${id}`,
      people_principals: { person: [`monday:300001:100${id}`] }, group_id: "in_sprint", column_text: { status: id === 2 ? "Done" : "Working" },
      url: `https://lindenhof.example.test/boards/board/pulses/item-${id}`, updated_at: h.now, state: "active" })),
    [messagesId]: [],
  };
  let sequence = 0;
  const sync = async (id: string, startedAt = h.now) => {
    const runId = `source-scan-${++sequence}`;
    return synchronizeRecordSnapshot({ instanceId: artifact.instance.id, source: registry.source(id), registry, store, runId,
      leaseOwner: "synthetic-inventory-worker", leaseToken: runId, leaseExpiresAt: "2030-01-05T00:00:00Z",
      inventory: { complete: true, scan_started_at: startedAt, observed_at: h.now, objects: rows[id]!, watermark: runId,
        binding_digest: recordSourceBindingDigest(bindings.get(id)!, { synthetic: true }), receipt: { inventory_digest: sha256(rows[id]!), synthetic: true } } });
  };
  return { h, registry, store, service, rows, sync, identities };
}

test("ordinary workflows join real Record identities by qualified principal and preserve source provenance despite identical names", async (t) => {
  const { h, registry, store, sync, identities } = pipeline(t);
  const receipt = await sync(rolesId);
  const run = await openParityClose(h);
  assert.equal(run.state.blocked, undefined);
  assert.equal(run.state.cursor, "await-chase");
  const roles = run.state.steps["participant-roles"]!.output as unknown as RecordQueryResult;
  const participants = run.state.steps["snapshot-participants"]!.output as any;
  assert.deepEqual(participants.rows.map((row: any) => [row.values.participant_id, row.values.display_name, row.values.roles]), [
    ["jonas-owner", "Shared Example", ["Review"]], ["lea-contributor", "Shared Example", ["Delivery"]], ["tim-contributor", "Tim Example", ["Delivery"]],
  ]);
  assert.deepEqual(participants.rows.map((row: any) => row.values.role_record_ids), [2, 3, 4].map((id) => [projectionRecordId("sprint-roles", rolesId, `role-${id}`)]));
  assert.equal(participants.directory_digest, identities.digest);
  assert.equal(roles.rows.every((row) => [...store.objectVersions.values()].some((version) => version.instance_id === row.instance_id && version.version_id === row.source_version_id && version.source_id === registry.sourceStorageId(rolesId))), true);
  assert.equal(roles.source_scan_proofs?.[0]?.source_digest, registry.sourceDigest(rolesId));
  assert.equal(roles.source_scan_proofs?.[0]?.run_id, receipt.run_id);
  assert.equal(roles.access_decision.allowed, true);
  assert.equal(roles.access_decision.principal_id, ENGINE_OPERATOR);
  assert.equal([...store.objectVersions.values()].every((version) => version.source_receipt.identity_directory_digest === identities.digest), true);
  assert.equal(h.calls.filter((call) => call.context.stepId === "open-close-thread").length, 1);
});

test("ordinary close parses current source messages and retains provenance while excluding other threads, non-updates, bots and late originals", async (t) => {
  const { h, registry, store, service, rows, sync } = pipeline(t);
  await sync(rolesId);
  let run = await openParityClose(h);
  const thread = (run.state.steps["open-close-thread"]!.output as any).thread_reference as string;
  h.now = "2030-01-04T15:20:00.000Z"; await sync(itemsId); await sync(messagesId);
  run = await wakeParity(h, run.runId, h.now);
  assert.equal(run.state.cursor, "await-report");
  rows[messagesId] = [message("lea", 3, "item-3", thread), message("jonas", 2, "item-2", thread),
    { ...message("non-update", 4, "item-4", thread), text: "A casual conversation" },
    { ...message("bot", 4, "item-4", thread), author_kind: "bot" },
    message("wrong-thread", 4, "item-4", "unrelated-thread"),
    message("late", 4, "item-4", thread, "2030-01-04T16:00:00.000000001Z"),
    { ...message("spoof", 4, "item-4", thread), content_author_principal: principal(3) },
    { ...message("unknown", 3, "item-3", thread), author_principal: "slack:T10001:UNKNOWN", content_author_principal: "slack:T10001:UNKNOWN" }];
  h.now = "2030-01-04T16:01:00.000Z";
  await sync(itemsId, reportAt); const receipt = await sync(messagesId, reportAt);
  const event = { source_id: messagesId, event_id: "duplicate-delivery", object_id: "lea", kind: "updated" as const,
    observed_at: h.now, receipt: { synthetic: true } };
  const first = await service.ingest({ event, raw: rows[messagesId]![0]! });
  const eventCount = store.sourceEvents.size, versionCount = store.objectVersions.size;
  const duplicate = await service.ingest({ event, raw: rows[messagesId]![0]! });
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.sourceEvents.size, eventCount);
  assert.equal(store.objectVersions.size, versionCount);
  run = await wakeParity(h, run.runId, h.now);
  assert.equal(run.state.blocked, undefined);
  assert.equal(run.state.cursor, "approve-rollover");
  const query = run.state.steps["read-submissions-at-report"]!.output as unknown as RecordQueryResult;
  const close = run.state.steps["close-view"]!.output as any;
  assert.deepEqual(close.states, { "jonas-owner": "complete", "lea-contributor": "complete", "tim-contributor": "needs-reformat" });
  assert.equal(Object.values(close.states).filter((state) => state === "complete").length, 2);
  assert.equal(close.cutoff, reportAt);
  assert.equal(query.rows.length, 5);
  assert.deepEqual(query.rows.map((row) => row.record_id).sort(), ["lea", "jonas", "late", "spoof", "unknown"].map((id) => projectionRecordId(query.projection_id, messagesId, id)).sort());
  const lea = query.rows.find((row) => row.values.participant_id === "lea-contributor")!;
  assert.deepEqual([lea.projection_id, lea.record_id, lea.source_version_id], ["sprint-close-submissions", projectionRecordId("sprint-close-submissions", messagesId, "lea"),
    [...store.objectVersions.values()].find((version) => version.object_id === "lea")!.version_id]);
  assert.deepEqual(lea.values.task_ids, ["item-3"]);
  assert.equal(lea.values.accepted_at, "2030-01-04T15:30:00Z");
  assert.deepEqual(lea.values.next_week, [{ work_item_id: "next-card", url: "https://lindenhof.example.test/boards/board/pulses/next-card", text: "https://lindenhof.example.test/boards/board/pulses/next-card — Next draft" }]);
  assert.equal(query.source_scan_proofs?.[0]?.run_id, receipt.run_id);
  assert.equal(query.source_scan_proofs?.[0]?.source_digest, registry.sourceDigest(messagesId));
  assert.equal(query.scan_started_at, reportAt);
  assert.equal([...store.objectVersions.values()].filter((version) => version.source_id === registry.sourceStorageId(messagesId)).length, 8);
  assert.equal(h.calls.filter((call) => call.context.stepId === "report").length, 1);
  assert.equal(h.calls.filter((call) => call.capability === "work-item.batch-update").length, 0);
  const retained = structuredClone(run.state.steps["read-submissions-at-report"]);
  rows[messagesId] = []; h.now = "2030-01-04T16:02:00.000Z"; await sync(messagesId);
  run = (await h.engine().advance(run.runId))!;
  assert.deepEqual(run.state.steps["read-submissions-at-report"], retained);
  assert.equal(h.calls.filter((call) => call.context.stepId === "report").length, 1);
});

test("ordinary workflow stops before its first message when a role cannot resolve to the exact roster identity", async (t) => {
  const { h, sync } = pipeline(t, { unknownRole: true });
  await sync(rolesId);
  const run = await openParityClose(h);
  assert.equal(run.state.blocked?.stepId, "snapshot-participants");
  assert.equal(run.state.steps["snapshot-participants"]?.status, "failed");
  const roles = run.state.steps["participant-roles"]!.output as unknown as RecordQueryResult;
  assert.equal(roles.rows.some((row) => (row.values.person_ids as string[]).includes("unresolved:monday:300001:unknown")), true);
  assert.equal(run.state.steps["open-close-thread"], undefined);
  assert.equal(h.calls.filter((call) => call.context.stepId === "open-close-thread" || call.capability === "work-item.batch-update").length, 0);
});

test("ordinary workflow cannot read Records without the invoking human's reviewed group permission", async (t) => {
  const { h, store, sync } = pipeline(t, { mayRead: false });
  await sync(rolesId);
  const run = await openParityClose(h);
  assert.equal(run.state.blocked?.stepId, "participant-roles");
  assert.equal(run.state.steps["participant-roles"]?.output, undefined);
  assert.equal(store.accessDecisions.at(-1)?.allowed, false);
  assert.equal(store.accessDecisions.at(-1)?.principal_id, ENGINE_OPERATOR);
  assert.equal(run.state.steps["open-close-thread"], undefined);
  assert.equal(h.calls.filter((call) => call.context.stepId === "open-close-thread" || call.capability === "work-item.batch-update").length, 0);
});
