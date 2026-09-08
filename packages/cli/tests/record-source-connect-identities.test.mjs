import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import YAML from "yaml";
import { planRecordSourceConnect } from "../src/record-source-connect.mjs";
import { decodeCompanyRecordsRehearsalConfiguration, validatedCompanyRecordsSelection } from "../../runner-vercel/src/lib/company-records-rehearsal.ts";
import { normalizeRecordObject } from "../../records/normalize.ts";

function fixture(t, { resolveIdentity = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "record-connect-identities-")), workspace = join(root, "workspace");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["connections", "schedules", "handbook", "records/sources", "records/projections"]) mkdirSync(join(workspace, dir), { recursive: true });
  writeFileSync(join(workspace, "company.md"), "---\nname: Example Company\n---\n");
  writeFileSync(join(workspace, "connections/provider.md"), "Example communication source.\n");
  writeFileSync(join(workspace, "schedules/daily.md"), "Example reconciliation schedule.\n");
  const rosterPath = join(workspace, "handbook/roster.md");
  const roster = (id) => `---\nmembers:\n  - id: ${id}\n    name: Example Contributor\n    role: contributor\n    status: active\n    identities:\n      slack:\n        principal: slack:T10001:U10001\n---\n`;
  if (resolveIdentity) writeFileSync(rosterPath, roster("example-contributor"));
  const source = { schema_version: 1, id: "fixture-messages", record_type: "communication-message",
    connection: "connections/provider.md", resource_binding: "fixture-channel", delivery: "poll", reconcile_schedule: "schedules/daily.md",
    identity: { source_field: "id" }, fields: [{ target: "participant_id", source: "author_principal", value_type: "identity", required: true,
      ...(resolveIdentity ? { resolve_identity: true } : {}) }], access: { read_groups: ["participants"], write_roles: [] } };
  const projection = { schema_version: 1, id: "fixture-participants", record_type: "communication-message", source_ids: [source.id],
    fields: [{ name: "participant_id", path: "participant_id" }], freshness: { max_age_minutes: 60 },
    access: { read_groups: ["participants"] }, materialization: { mode: "database-view" } };
  writeFileSync(join(workspace, "records/sources/messages.yaml"), YAML.stringify(source));
  writeFileSync(join(workspace, "records/projections/participants.yaml"), YAML.stringify(projection));
  // Synthetic provider qualification; the planner, runtime decoder, registry and
  // normalization below are actual maintained implementations. No network call.
  const qualification = { kind: "slack-record-source-qualification", phase: "complete", evidence: { discovery: {
    discovery_hash: "d".repeat(64), authentication_mode: "bot-token", credentials_retained: false,
    team_id: "T10001", bot_user_id: "U10002", channel: { id: "C10001", kind: "private-channel", is_member: true },
    scopes: ["groups:history", "groups:read"],
  } } };
  writeFileSync(join(root, "qualification.json"), JSON.stringify(qualification));
  const bindingPath = join(root, "binding.yaml");
  writeFileSync(bindingPath, YAML.stringify({ schema_version: 1, instance_id: "fixture-preview", source_id: source.id,
    resource_binding: source.resource_binding, connector: "oregano/slack-record-source", connector_version: "0.1.3",
    secret_ref: "env:FIXTURE_SLACK_TOKEN", qualification: { receipt_ref: "qualification.json", digest: "d".repeat(64) },
    configuration: { team_id: "T10001", channel_id: "C10001", conversation_kind: "private-channel", oldest_at: "2030-01-01T00:00:00.000Z" } }));
  const plan = () => planRecordSourceConnect({ workspaceRoot: workspace, sourceId: source.id, bindingPath,
    endpoint: "https://fixture-preview.vercel.app/api/records/rehearsal", runtimeScope: "fixture-team", runtimeProject: "fixture-project",
    statePath: join(root, "connect.json"), coreIdentity: { repository: "example/oregano", ref: "a".repeat(40), core_version: "0.5.14",
      workbench_version: "0.1.0-experimental.15", clean: true }, workspaceIdentity: { repository: "example/company", ref: "b".repeat(40), clean: true } });
  const select = (planned) => {
    assert.deepEqual(planned.diagnostics, []);
    return validatedCompanyRecordsSelection(decodeCompanyRecordsRehearsalConfiguration(gzipSync(JSON.stringify(planned.configuration)).toString("base64")), source.id);
  };
  const normalize = (selected, principal = "slack:T10001:U10001") => normalizeRecordObject({ instanceId: "fixture-preview", source: selected.source,
    raw: { id: "message-1", author_principal: principal }, observedAt: "2030-01-01T12:00:00.000Z", identities: selected.registry.identities });
  return { plan, select, normalize, rosterPath, roster, workspace, source, projection };
}

test("hosted source setup preserves reviewed identity resolution and freezes it across later roster changes", (t) => {
  const h = fixture(t), first = h.plan();
  assert.deepEqual(first.diagnostics, []);
  const original = h.select(first), normalized = h.normalize(original);
  assert.equal(normalized.values.participant_id, "example-contributor");
  assert.equal(normalized.source_receipt.identity_directory_digest, first.operation.plan.identity_directory_digest);
  assert.equal(h.normalize(original, "slack:T10001:U19999").values.participant_id, "unresolved:slack:T10001:U19999");
  writeFileSync(h.rosterPath, h.roster("replacement-contributor"));
  const second = h.plan(), replacement = h.select(second);
  assert.equal(h.normalize(replacement).values.participant_id, "replacement-contributor");
  assert.equal(h.normalize(h.select(first)).values.participant_id, "example-contributor");
  assert.notEqual(first.plan.source_confirmation, second.plan.source_confirmation);
  assert.notEqual(first.plan.configuration_digest, second.plan.configuration_digest);
  assert.notEqual(first.plan.confirmation_hash, second.plan.confirmation_hash);
  assert.notEqual(original.registry.sourceDigest("fixture-messages"), replacement.registry.sourceDigest("fixture-messages"));
  assert.equal(first.configuration.roster_markdown, h.roster("example-contributor"));
  assert.equal(second.configuration.roster_markdown, readFileSync(h.rosterPath, "utf8"));
});

test("hosted setup keeps sources without identity resolution compatible without a roster", (t) => {
  const h = fixture(t, { resolveIdentity: false }), planned = h.plan();
  const selected = h.select(planned);
  assert.equal(Object.hasOwn(planned.configuration, "roster_markdown"), false);
  assert.equal(h.normalize(selected).values.participant_id, "slack:T10001:U10001");
});


test("single-source setup rejects multi-source projections without silently narrowing them", (t) => {
  const h = fixture(t);
  const other = { ...h.source, id: "fixture-other-messages" };
  writeFileSync(join(h.workspace, "records/sources/other.yaml"), YAML.stringify(other));
  writeFileSync(join(h.workspace, "records/projections/participants.yaml"), YAML.stringify({ ...h.projection, source_ids: [h.source.id, other.id] }));
  const planned = h.plan();
  assert.deepEqual(planned.diagnostics.map((entry) => entry.code), ["REC035"]);
  assert.deepEqual(planned.configuration.projections, []);
});
