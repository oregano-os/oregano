import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import YAML from "yaml";
import { compileWorkflows } from "../../companyos-builder/workflow-compiler.ts";
import { validateWorkflowFiles } from "../../companyos-builder/workflow-authoring.ts";
import { readWorkspaceFiles } from "../../companyos-builder/workspace-files.ts";
import { decodeWorkflowHostingConfiguration, WORKFLOW_CONFIGURATION_ENV } from "../../runner-vercel/src/lib/workflow-configuration.ts";
import type { WorkflowTriggerEvent } from "../../state-store/workflow-engine.ts";
import { engineArtifact, engineFixture, ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";

const fixture = resolve(import.meta.dirname, "../fixtures/lindenhof-studio");

const eventSource = {
  schema_version: 1, id: "sprint-board-events", activation: "blocked", provider: "monday", resource_binding: "sprint-board",
  triggers: [{ id: "sprint-card-changed", events: ["item-created", "item-moved", "item-changed"], fields: ["type"], params: { cohort: "pilot" } }],
};
const intakeWorkflow = `---
type: workflow
id: card-intake
version: 1
owner: agents/sprint
execution_mode: unattended
trigger: event:sprint-card-changed
calendar: schedules/sprint-rhythm.yaml
config: workflows/sprint/config.yaml
instance:
  key: [trigger_id, event_id]
  fields: [event_id]
steps:
  - card-records: oregano:records/query
    input:
      projection_id: $config.work_items.projection
      filters:
        work_item_ids: [$trigger.event.work_item_id]
    all_pages: true
    require_scan_started_after: $trigger.instant
  - kind-route: route
    on: $trigger.event.kind
    item-created: end
    item-moved: end
    item-changed: end
---
# Card intake

1. [sprint, R0] Read the changed card from a complete current scan. <!-- step:card-records -->
2. [sprint, R0] Route on the normalized event kind. <!-- step:kind-route -->
`;

/** A synthetic Workspace: the fictional fixture plus one event source and one event workflow. */
function eventWorkspace(change: (files: Record<string, string>) => void = () => {}): { root: string; files: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "event-trigger-fixture-"));
  cpSync(fixture, root, { recursive: true });
  mkdirSync(join(root, "events"), { recursive: true });
  writeFileSync(join(root, "events/sprint-board.yaml"), YAML.stringify(eventSource));
  writeFileSync(join(root, "workflows/card-intake.md"), intakeWorkflow);
  const files: Record<string, string> = { ...readWorkspaceFiles(root) };
  change(files);
  for (const [path, content] of Object.entries(files)) { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), content); }
  return { root, files };
}
const rewrite = (files: Record<string, string>, path: string, change: (data: any) => void) => {
  if (!files[path]!.startsWith("---")) { const data = YAML.parse(files[path]!); change(data); files[path] = YAML.stringify(data); return; }
  const [, front, body] = files[path]!.split(/^---$/m);
  const data = YAML.parse(front!); change(data);
  files[path] = `---\n${YAML.stringify(data)}---${body}`;
};
const event = (overrides: Partial<WorkflowTriggerEvent> = {}): WorkflowTriggerEvent => ({
  kind: "item-created", event_id: "b5ed2e17c530f43668de130142445cba", resource_binding: "sprint-board", work_item_id: "item-1",
  group_id: "backlog", field: "", actor_id: "9603417", occurred_at: "2030-01-04T09:07:28.210Z", ...overrides,
});
function activeFixture(change?: (files: Record<string, string>) => void) {
  const { root } = eventWorkspace((files) => { rewrite(files, "events/sprint-board.yaml", (data) => { data.activation = "active"; }); change?.(files); });
  const artifact = engineArtifact(undefined, root);
  rmSync(root, { recursive: true, force: true });
  const h = engineFixture({ artifact });
  h.now = "2030-01-04T09:08:00.000Z";
  return h;
}

test("an event source declares normalized provider events and compiles like a calendar", () => {
  const { root, files } = eventWorkspace();
  try {
    assert.deepEqual(validateWorkflowFiles(files), []);
    const artifact = engineArtifact(undefined, root);
    const compiled = artifact.workflows!.find((workflow) => workflow.id === "card-intake")!;
    assert.deepEqual(compiled.trigger, { kind: "event", id: "sprint-card-changed", eventPath: "events/sprint-board.yaml" });
    assert.deepEqual(compiled.instance, { key: ["trigger_id", "event_id"], fields: ["trigger_id", "run_date", "event_id"] });
    assert.equal(compiled.events?.length, 1);
    assert.equal(compiled.events![0]!.path, "events/sprint-board.yaml");
    assert.deepEqual(compiled.events![0]!.declaration, eventSource);
    assert.equal(compiled.schedules.length, 1, "the explicit calendar is retained for the run date");
    for (const other of artifact.workflows!.filter((workflow) => workflow.id !== "card-intake")) assert.equal(Object.hasOwn(other, "events"), false, "existing manifests keep their shape");
    const baseline = compileWorkflows({ files: { ...readWorkspaceFiles(fixture) }, agents: artifact.agents, provenance: compiled.provenance });
    for (const workflow of baseline) assert.deepEqual(artifact.workflows!.find((candidate) => candidate.id === workflow.id)!.manifestHash, workflow.manifestHash);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("event workflows default to a per-event identity and expose only declared event fields", () => {
  const { root, files } = eventWorkspace((files) => rewrite(files, "workflows/card-intake.md", (data) => { delete data.instance; }));
  try {
    assert.deepEqual(validateWorkflowFiles(files), []);
    const compiled = compileWorkflows({ files, agents: engineArtifact(undefined, root).agents, provenance: { coreCommit: "1".repeat(40), workspaceCommit: "2".repeat(40), workbenchVersion: "test", instanceId: "test" } })
      .find((workflow) => workflow.id === "card-intake")!;
    assert.deepEqual(compiled.instance, { key: ["trigger_id", "event_id"], fields: ["trigger_id", "run_date", "event_id"] });
  } finally { rmSync(root, { recursive: true, force: true }); }
  const errors = (change: (files: Record<string, string>) => void) => { const { root, files } = eventWorkspace(change); rmSync(root, { recursive: true, force: true }); return validateWorkflowFiles(files); };
  assert.match(errors((files) => rewrite(files, "workflows/card-intake.md", (data) => { data.trigger = "event:unknown-trigger"; })).join("\n"), /not declared in an event source/);
  assert.match(errors((files) => rewrite(files, "workflows/card-intake.md", (data) => { data.steps[0].input.filters.work_item_ids = ["$trigger.event.pulse_id"]; })).join("\n"), /unknown \$trigger\.event field 'pulse_id'/);
  assert.match(errors((files) => rewrite(files, "workflows/card-intake.md", (data) => { data.steps[0].input.filters = { changed_since: "$trigger.previous_instant" }; })).join("\n"), /previous_instant/);
  assert.match(errors((files) => rewrite(files, "workflows/friday-close.compact.md", (data) => { data.steps.find((step: any) => step["read-submissions-at-chase"]).input.filters = { thread_reference: "$trigger.event.work_item_id" }; })).join("\n"), /event fields require an event trigger/);
  assert.match(errors((files) => rewrite(files, "events/sprint-board.yaml", (data) => { data.triggers.push({ id: "sprint-card-changed", events: ["item-moved"] }); })).join("\n"), /declared more than once/);
  assert.match(errors((files) => rewrite(files, "events/sprint-board.yaml", (data) => { data.triggers[0].events = ["item-deleted"]; })).join("\n"), /events/);
  assert.match(errors((files) => { files["schedules/competing.yaml"] = YAML.stringify({ ...YAML.parse(files["schedules/sprint-rhythm.yaml"]!), id: "competing", triggers: [{ id: "sprint-card-changed", weekdays: ["monday"], at: "09:00" }] }); }).join("\n"), /ambiguous/);
});

test("a verified provider event opens exactly one run per event and repeats reuse it", async () => {
  const h = activeFixture();
  const open = (input: WorkflowTriggerEvent, instant = h.now) => h.engine().openEvent({ workflowId: "card-intake", principal: ENGINE_OPERATOR, event: input, instant });
  const first = await open(event());
  assert.deepEqual(first.fields, { trigger_id: "sprint-card-changed", run_date: "2030-01-04", event_id: event().event_id });
  assert.deepEqual(first.trigger, { id: "sprint-card-changed", instant: h.now, params: { cohort: "pilot" }, event: event() });
  assert.match(first.originKey, /^event:/);
  h.now = "2030-01-04T09:09:00.000Z";
  assert.deepEqual(await open(event(), first.trigger.instant), first, "redelivery of the same event reuses the run");
  await assert.rejects(open(event({ work_item_id: "item-2" }), first.trigger.instant), /conflicts with changed input/);
  const second = await open(event({ event_id: "5c28578c66653a87b00a80aa4f7a6ce3", kind: "item-moved", group_id: "planned" }));
  assert.notEqual(second.runId, first.runId);
  assert.equal((await h.store.list({ instanceId: h.artifact.instance.id, limit: 20 })).length, 2);
  const run = await h.engine().advance(second.runId, 4);
  assert.equal(run!.state.status, "done");
  const query = h.calls.find((call) => call.capability === "records.query")!;
  assert.deepEqual(query.input.filters, { work_item_ids: ["item-1"] });
  assert.equal(query.input.require_scan_started_after, second.trigger.instant);
  assert.deepEqual(run!.state.steps["kind-route"]!.output, { outcome: "item-moved" });
});

test("event openings refuse blocked sources, foreign resources, undeclared kinds, forged fields and other trigger paths", async () => {
  const blocked = (() => { const { root } = eventWorkspace(); const artifact = engineArtifact(undefined, root); rmSync(root, { recursive: true, force: true }); return engineFixture({ artifact }); })();
  await assert.rejects(blocked.engine().openEvent({ workflowId: "card-intake", principal: ENGINE_OPERATOR, event: event(), instant: blocked.now }), /activation is blocked/);
  const h = activeFixture();
  const open = (input: WorkflowTriggerEvent, overrides: Record<string, unknown> = {}) => h.engine().openEvent({ workflowId: "card-intake", principal: ENGINE_OPERATOR, event: input, instant: h.now, ...overrides });
  await assert.rejects(open(event({ resource_binding: "roles-board" })), /resource binding/);
  await assert.rejects(open(event({ kind: "item-deleted" })), /[Ee]vent kind/);
  await assert.rejects(open(event({ kind: "item-changed", field: "status" })), /[Ee]vent field/);
  await assert.rejects(open(event({ field: "Type Column" })), /'field' is invalid/);
  assert.equal((await open(event({ kind: "item-changed", field: "type", event_id: "type0000000000000000000000000001" }))).trigger.event!.field, "type");
  await assert.rejects(open(event({ event_id: "" })), /event identity/);
  await assert.rejects(open(event({ occurred_at: "yesterday" })), /instant/);
  await assert.rejects(open(event(), { fields: { event_id: "forged" } }), /trusted trigger/);
  await assert.rejects(open(event(), { workflowId: "weekday-digest" }), /no declared event trigger/);
  await assert.rejects(h.engine().openOperator({ workflowId: "card-intake", principal: ENGINE_OPERATOR, requestId: "manual", fields: {} }), /verified provider event/);
  await assert.rejects(h.engine().openScheduled({ workflowId: "card-intake", principal: ENGINE_OPERATOR, fields: {}, instant: h.now }), /no declared schedule/);
  await assert.rejects(open(event(), { principal: "slack:T10001:U99999" }), /authorized human operator/);
  assert.equal((await h.store.list({ instanceId: h.artifact.instance.id, limit: 20 })).length, 1, "only the declared field change opened a run");
});

test("hosting configuration enables event openings explicitly and keeps them apart from calendar automation", () => {
  const h = activeFixture();
  h.artifact.instance.environment = "preview";
  const base = { version: 1, instanceId: h.artifact.instance.id, artifactHash: h.artifact.artifactHash, environment: "preview",
    enabledWorkflowIds: ["card-intake", "weekday-digest"], autoOpenWorkflowIds: [], schedulePrincipal: ENGINE_OPERATOR,
    activatedAt: "2030-01-04T08:59:00.000Z", maxLatenessMinutes: 60, operators: [{ principal: ENGINE_OPERATOR, secretRef: "env:TEST_OPERATOR_SECRET" }] };
  const decode = (config: Record<string, unknown>) => decodeWorkflowHostingConfiguration(h.artifact, { VERCEL_ENV: "preview", TEST_OPERATOR_SECRET: "a".repeat(48), CRON_SECRET: "b".repeat(48),
    [WORKFLOW_CONFIGURATION_ENV]: gzipSync(JSON.stringify(config)).toString("base64") });
  assert.deepEqual(decode(base).eventOpenWorkflowIds, []);
  assert.deepEqual(decode({ ...base, eventOpenWorkflowIds: ["card-intake"] }).eventOpenWorkflowIds, ["card-intake"]);
  assert.throws(() => decode({ ...base, eventOpenWorkflowIds: ["weekday-digest"] }), /declared event trigger/);
  assert.throws(() => decode({ ...base, enabledWorkflowIds: ["weekday-digest"], eventOpenWorkflowIds: ["card-intake"] }), /absent or disabled/);
  assert.throws(() => decode({ ...base, autoOpenWorkflowIds: ["card-intake"] }), /explicit business fields/);
});
