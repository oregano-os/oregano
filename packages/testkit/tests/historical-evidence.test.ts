import assert from "node:assert/strict";
import { test } from "node:test";
import { HistoricalEvidenceConnector, parseEvidenceScopes } from "../../connectors/historical-evidence.ts";
import { InMemoryWorkflowExecutionStore } from "../../runtime/workflow-engine/memory-store.ts";
import { InMemoryCompanyRecordsStore } from "../../records/memory-store.ts";
import { CompanyRecordsRegistry } from "../../records/registry.ts";
import { CompanyRecordsService } from "../../records/service.ts";
import { inspectWorkflowHealth } from "../../runtime/workflow-engine/health.ts";
import { workflowStateFixture, WORKFLOW_STATE_NOW as now } from "../workflow-state-fixture.ts";
import { workflowRunId, workflowOriginDigest } from "../../runtime/workflow-engine/state-validation.ts";
import { EVIDENCE_QUERY_OUTPUT, type EvidenceScope } from "../../capabilities/evidence.ts";
import { validateJsonSchemaValue } from "../../capabilities/validation.ts";
import type { CapabilityCallContext } from "../../capabilities/contracts.ts";

const from = "2030-01-01T00:00:00.000Z", to = "2030-01-05T12:00:00.000Z";
async function fixture() {
  const args = workflowStateFixture(), store = new InMemoryWorkflowExecutionStore();
  await store.putArtifact(args.artifact); const run = await store.create(args);
  const path = Object.keys(args.artifact.agents.find(agent => agent.id === "sprint")!.materials)[0]!;
  const scope: EvidenceScope = { agent_id: "sprint", workflow_id: "friday-close", workflow_ids: ["friday-close"],
    source_ids: [], paths: [path], read_groups: ["readers"], max_history_days: 30 };
  const connector = new HistoricalEvidenceConnector({ artifact: args.artifact, scopes: [scope], workflows: store, control: store.control, now: () => new Date(to) });
  const context: CapabilityCallContext = { instanceId: args.artifact.instance.id, runId: "current-run", stepId: "assess", agentId: "sprint", toolId: "evidence-test",
    workflow: { id: "friday-close", cutoff: to }, subject: { principalId: "test:reader", principalType: "human", status: "active", groupIds: ["readers"] } };
  const query = { kind: "workflows", references: ["friday-close"], from, to, include_linked_builds: true };
  return { args, store, run, path, scope, connector, context, query };
}

test("retained evidence has exact references and explicit missing adapter coverage", async () => {
  const f = await fixture(); const { output } = await f.connector.invoke("evidence.query", f.query, f.context);
  assert.equal(output.items[0]!.id, f.run.runId);
  assert.equal(output.items[0]!.occurred_at, now);
  assert.deepEqual(validateJsonSchemaValue(EVIDENCE_QUERY_OUTPUT, output), []);
  assert.equal(output.coverage.complete, false);
  assert.ok(output.coverage.limitations.includes("linked-builder-reader-unavailable"));
  assert.deepEqual((await f.connector.invoke("evidence.query", f.query, { ...f.context, runId: f.run.runId })).output.items, []);
});

test("scope intersects Instance, Agent, workflow, source, current group and trusted cutoff", async () => {
  const f = await fixture();
  for (const context of [{ ...f.context, instanceId: "another" }, { ...f.context, agentId: "other" },
    { ...f.context, workflow: undefined }, { ...f.context, workflow: { id: "other", cutoff: to } },
    { ...f.context, subject: { ...f.context.subject!, status: "revoked" as const } },
    { ...f.context, subject: { ...f.context.subject!, groupIds: ["formerly-authorized"] } }])
    await assert.rejects(f.connector.invoke("evidence.query", f.query, context), /denied/);
  for (const query of [{ ...f.query, references: ["other"] }, { ...f.query, to: "2030-01-06T00:00:00Z" },
    { ...f.query, from: "2029-01-01T00:00:00Z" }, { ...f.query, limit: 101 }, { ...f.query, scope: f.scope }])
    await assert.rejects(f.connector.invoke("evidence.query", query, f.context));
  assert.throws(() => parseEvidenceScopes([f.scope, f.scope]), /Ambiguous/);
});

test("selected context must exist in this Agent's frozen read materials", async () => {
  const f = await fixture();
  const result = await f.connector.invoke("evidence.query", { ...f.query, kind: "context", references: [f.path] }, f.context);
  assert.equal(result.output.items[0]!.id, f.path); assert.ok(result.output.items[0]!.digest);
  assert.throws(() => new HistoricalEvidenceConnector({ artifact: f.args.artifact, scopes: [{ ...f.scope, paths: ["outside.md"] }], workflows: f.store, control: f.store.control }), /outside compiled/);
});

test("latest run ordering uses occurrences and overflow is explicit", async () => {
  const f = await fixture();
  for (const date of ["2030-01-02T12:00:00.000Z", "2030-01-03T12:00:00.000Z"]) {
    const args = workflowStateFixture(); args.identity.trigger.instant = date; args.identity.createdAt = date;
    args.identity.runId = workflowRunId(args.identity); args.identity.originDigest = workflowOriginDigest(args.identity);
    args.meta.runId = args.identity.runId; args.state.logicalInstant = date;
    await f.store.create(args);
  }
  const output = (await f.connector.invoke("evidence.query", { ...f.query, limit: 1 }, f.context)).output;
  assert.equal(output.items[0]!.occurred_at, now); assert.ok(output.coverage.limitations.includes("result-limit"));
  assert.deepEqual(await f.store.history({ instanceId: "other", workflowIds: ["friday-close"], from, to, limit: 10 }), []);
});

test("source history keeps generation and current source access; empty scans do not prove event coverage", async () => {
  const registry = new CompanyRecordsRegistry(), store = new InMemoryCompanyRecordsStore();
  registry.registerSource({ schema_version: 1, id: "items", record_type: "item", connection: "connections/items.md", resource_binding: "items", delivery: "poll",
    identity: { source_field: "id" }, fields: [{ target: "title", source: "title", value_type: "string", required: true }], access: { read_groups: ["readers"], write_roles: [] } });
  const service = new CompanyRecordsService({ instanceId: "one", registry, store, now: () => new Date(now) });
  await service.ingest({ event: { source_id: "items", object_id: "one", event_id: "event-one", kind: "created", observed_at: now, receipt: {} }, raw: { id: "one", title: "Recorded" } });
  const request = { sourceId: "items", from, to, limit: 10, subject: { principal_id: "reader", status: "active" as const, roles: [], group_ids: ["readers"] } };
  assert.equal((await service.history(request)).length, 1);
  await assert.rejects(service.history({ ...request, subject: { ...request.subject, group_ids: [] } }), /access denied/);
  assert.deepEqual(await store.readHistory({ instanceId: "other", sourceId: "items", from, to, limit: 10 }), []);
  assert.deepEqual(await store.readHistory({ instanceId: "one", sourceId: "items", from: now, to, limit: 10 }), []);
});

test("later feedback is bounded by its provider occurrence and cannot become approval", async () => {
  const f = await fixture();
  for (const at of [now, "2030-01-06T00:00:00Z"]) await f.store.control.appendEvent({ runId: f.run.runId, stepId: "report", actor: "human:feedback", event: "workflow.feedback.received",
    evidence: { event_id: at, occurred_at: at, text: "Do not build this", authority: "feedback-only", publication_message_id: "exact-message" } });
  const run = (await f.connector.invoke("evidence.query", f.query, f.context)).output.items[0] as any;
  assert.equal(run.feedback.length, 1); assert.equal(run.feedback[0].authority, "feedback-only"); assert.deepEqual(run.decisions, {});
});

test("health reads the real calendar without invoking a model and respects disabled reviews", async () => {
  const f = await fixture(), artifact = structuredClone(f.args.artifact);
  const workflow = artifact.workflows!.find(value => value.id === "friday-close")!;
  const configuration = { enabledWorkflowIds: [workflow.id], autoOpenWorkflowIds: [workflow.id], schedulePrincipal: f.run.subjectPrincipal,
    activatedAt: from, maxLatenessMinutes: 120 };
  workflow.trigger = { kind: "schedule", id: "review", schedulePath: "calendar" };
  workflow.schedules = [{ path: "calendar", digest: "synthetic", declaration: { schema_version: 1, id: "calendar", activation: "active", timezone: "UTC",
    business_days: ["monday", "tuesday", "wednesday", "thursday", "friday"], holiday_calendar: { years: { "2030": [] }, missing_year_policy: "block" },
    delivery_window: { opens_at: "08:00", closes_at: "20:00" }, triggers: [{ id: "review", weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"], at: "12:00" }] } }];
  const args = { artifact, store: f.store, configuration, workflowId: workflow.id, now: to, graceMinutes: 120 };
  const result = await inspectWorkflowHealth(args);
  assert.equal(result.ok, false); assert.ok(result.issues.includes("successful-review-overdue")); assert.ok(result.issues.includes("repeated-unsuccessful-occurrences"));
  workflow.schedules[0]!.declaration.activation = "blocked";
  assert.equal((await inspectWorkflowHealth(args)).status, "disabled");
});

test("Builder and release evidence follows exact output references and the authenticated requester's scope", async () => {
  const f = await fixture(), original = f.store.history.bind(f.store);
  const stepId = f.args.artifact.workflows!.find(workflow => workflow.id === f.run.workflowId)!.steps[0]!.id;
  f.store.history = async args => (await original(args)).map(run => ({ ...run, state: { ...run.state,
    steps: { [stepId]: { status: "succeeded", startedAt: now, completedAt: now, output: { result: "Read-only assessment" } } } } }));
  const reference = `workflow-output:${f.run.runId}#${stepId}`;
  const job = { jobId: "exact-build", instanceId: f.run.instanceId, requesterPrincipal: f.context.subject!.principalId,
    createdAt: now, updatedAt: now, state: "queued", brief: { brief: { constraints: [reference], acceptanceCriteria: ["Measure the outcome"], proposedBehavior: "One accepted change" } } };
  const releases: string[] = [];
  const connector = new HistoricalEvidenceConnector({ artifact: f.args.artifact, scopes: [f.scope], workflows: f.store, control: f.store.control, now: () => new Date(to),
    builders: { listForRequester: async () => [job, { ...job, jobId: "foreign", instanceId: "other" }, { ...job, jobId: "another-author", requesterPrincipal: "another" },
      { ...job, jobId: "unrelated", brief: { brief: { ...job.brief.brief, constraints: ["Similar wording is not a link"] } } }] as any },
    releases: async (_instanceId, candidateId) => { releases.push(candidateId); return []; } });
  const row = (await connector.invoke("evidence.query", f.query, f.context)).output.items[0] as any;
  assert.deepEqual(row.builds.map((build: any) => build.id), [job.jobId]); assert.deepEqual(releases, [job.jobId]);
  assert.equal(row.output_refs[stepId].reference, reference); assert.equal(row.output_refs[stepId].digest.length, 64);
});

test("quiet completed reviews remain healthy across a scheduled non-working day", async () => {
  const f = await fixture(), artifact = structuredClone(f.args.artifact), workflow = artifact.workflows!.find(value => value.id === "friday-close")!;
  workflow.trigger = { kind: "schedule", id: "review", schedulePath: "calendar" };
  workflow.schedules = [{ path: "calendar", digest: "fixture", declaration: { schema_version: 1, id: "calendar", activation: "active", timezone: "UTC",
    business_days: ["monday", "tuesday", "wednesday", "thursday", "friday"], holiday_calendar: { years: { "2030": [] }, missing_year_policy: "block" },
    delivery_window: { opens_at: "08:00", closes_at: "20:00" }, triggers: [{ id: "review", weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"], at: "12:00" }] } }];
  f.store.history = async () => [{ ...f.run, state: { ...f.run.state, status: "done", cursor: null } }];
  const result = await inspectWorkflowHealth({ artifact, store: f.store, workflowId: workflow.id, now: to, graceMinutes: 120,
    configuration: { enabledWorkflowIds: [workflow.id], autoOpenWorkflowIds: [workflow.id], schedulePrincipal: f.run.subjectPrincipal, activatedAt: from, maxLatenessMinutes: 120 } });
  assert.equal(result.status, "healthy"); assert.deepEqual(result.issues, []);
});
