import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { test } from "node:test";
import { buildCompanyOSArtifact } from "../../../companyos-builder/build.ts";
import type { CompanyRecordsRehearsalConfiguration } from "./company-records-rehearsal.ts";

const configuration = (): CompanyRecordsRehearsalConfiguration => ({
  version: 1,
  environment: "preview",
  instance_id: "fixture-records-rehearsal",
  core: {
    repository: "example/oregano",
    ref: "a".repeat(40),
    core_version: "0.5.8",
    workbench_version: "0.1.0-experimental.15",
    clean: true,
  },
  workspace: { repository: "example/company-workspace", ref: "b".repeat(40) },
  source_confirmations: { "fixture-items": "c".repeat(64) },
  sources: [{
    schema_version: 1,
    id: "fixture-items",
    record_type: "communication-message",
    connection: "connections/slack.md",
    resource_binding: "fixture-board",
    delivery: "poll",
    reconcile_schedule: "schedules/records.md",
    identity: { source_field: "id" },
    fields: [{ target: "text", source: "text", value_type: "string", required: true }],
    access: { read_groups: ["fixture"], write_roles: [] },
  }],
  projections: [{
    schema_version: 1,
    id: "fixture-projection",
    record_type: "communication-message",
    selection: {},
    fields: [{ name: "text", path: "text" }],
    freshness: { max_age_minutes: 60 },
    access: { read_groups: ["fixture"] },
    materialization: { mode: "database-view" },
  }],
  bindings: [{
    source_id: "fixture-items",
    binding: {
      schema_version: 1,
      instance_id: "fixture-records-rehearsal",
      source_id: "fixture-items",
      resource_binding: "fixture-board",
      connector: "oregano/slack-record-source",
      connector_version: "0.1.0",
      secret_ref: "env:FIXTURE_PROVIDER_TOKEN",
      qualification: { receipt_ref: "qualification.json", digest: "d".repeat(64) },
      configuration: { team_id: "T12345", channel_id: "C12345", conversation_kind: "public-channel", oldest_at: "2030-01-01T00:00:00.000Z", include_threads: true },
    },
    qualification: { kind: "slack-record-source-qualification", phase: "complete", evidence: { discovery: {
      discovery_hash: "d".repeat(64), authentication_mode: "bot-token", credentials_retained: false,
      team_id: "T12345", bot_user_id: "U99999", channel: { id: "C12345", kind: "public-channel", is_member: true }, scopes: ["channels:history", "channels:read"],
    } } },
  }],
});


test("failed chat construction never caches a handlerless instance and recovers after correcting configuration", async (t) => {
  // No database, provider, model or message side effects belong to construction.
  t.mock.method(globalThis, "fetch", async () => { assert.fail("initialization attempted a network request"); });
  const records = configuration();
  const artifact = buildCompanyOSArtifact({
    workspaceRoot: join(import.meta.dirname, "../../../testkit/fixtures/reference-company"),
    instance: { version: 1, instanceId: records.instance_id, environment: "preview", agentBindings: [],
      bindings: [
        ["artifact.publish", "oregano/artifact-sandbox"],
        ["marketing-campaign.launch", "oregano/marketing-sandbox"],
        ["marketing-campaign.read-report", "oregano/marketing-sandbox"],
        ["marketing-campaign.stop-asset", "oregano/marketing-sandbox"],
        ["conversion.record", "oregano/marketing-sandbox"],
      ].map(([capability, connector]) => ({ capability: capability!, connector: connector!, contractVersion: "1.0.0", connectorVersion: "1.0.0" })),
      connectors: [{ id: "records", connector: "oregano/company-records", connectorVersion: "0.1.0",
        configuration: { configuration_ref: "env:FIXTURE_RECORDS_CONFIG" } }],
    },
    coreVersion: "0.5.14", coreCommit: "a".repeat(40), workspaceCommit: "b".repeat(40), workbenchVersion: "0.1.0-experimental.15",
  });
  const encode = (value: unknown) => gzipSync(JSON.stringify(value)).toString("base64");
  const previous = { ...process.env };
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name]; Object.assign(process.env, previous); });
  Object.assign(process.env, { DATABASE_URL: "postgresql://fixture:fixture@localhost/fixture", SLACK_CONNECTOR: "slack/fixture",
    VERCEL_ENV: "preview", COMPANYOS_ARTIFACT_GZIP_BASE64: encode(artifact),
    FIXTURE_RECORDS_CONFIG: encode({ ...records, core: { ...records.core, ref: "c".repeat(40) } }) });
  delete process.env.COMPANYOS_ARTIFACT_BROTLI_BASE64;
  const { getBot, getCompanyOSRuntime } = await import("./bot.ts");
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.throws(() => getBot(), /does not match the immutable Artifact identity/);
    assert.throws(() => getCompanyOSRuntime(), /does not match the immutable Artifact identity/);
  }
  process.env.FIXTURE_RECORDS_CONFIG = encode(records);
  const bot = getBot();
  assert.equal(getBot(), bot);
  assert.ok(getCompanyOSRuntime());
  // Check the actual pinned SDK registrations that were absent in the regression.
  const handlers = bot as unknown as { mentionHandlers: unknown[]; subscribedMessageHandlers: unknown[]; actionHandlers: unknown[] };
  assert.equal(handlers.mentionHandlers.length, 1);
  assert.equal(handlers.subscribedMessageHandlers.length, 1);
  assert.ok(handlers.actionHandlers.length > 0);
});
