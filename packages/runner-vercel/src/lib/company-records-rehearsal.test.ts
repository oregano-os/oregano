import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import {
  authorizeCompanyRecordsRehearsal,
  CompanyRecordsRehearsalError,
  decodeCompanyRecordsRehearsalConfiguration,
  executeCompanyRecordsRehearsal,
  parseCompanyRecordsRehearsalRequest,
  planCompanyRecordsPreviewMigration,
  planCompanyRecordsPreviewMondayQualification,
  planCompanyRecordsPreviewSlackQualification,
  planCompanyRecordsPreviewSync,
  validatedCompanyRecordsSelection,
  type CompanyRecordsRehearsalConfiguration,
} from "./company-records-rehearsal.ts";
import { createMondayExternalAgentQualificationEvidence } from "../../../connectors/monday/external-agent-qualification.ts";

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
    record_type: "work-item",
    connection: "connections/provider.md",
    resource_binding: "fixture-board",
    delivery: "poll",
    reconcile_schedule: "schedules/records.md",
    identity: { source_field: "id" },
    fields: [{ target: "title", source: "name", value_type: "string", required: true }],
    access: { read_groups: ["fixture"], write_roles: [] },
  }],
  projections: [{
    schema_version: 1,
    id: "fixture-projection",
    record_type: "work-item",
    selection: { source_id: "fixture-items" },
    fields: [{ name: "title", path: "title" }],
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
      connector: "fixture/record-source",
      connector_version: "1.0.0",
      secret_ref: "env:FIXTURE_PROVIDER_TOKEN",
      qualification: { receipt_ref: "qualification.json", digest: "d".repeat(64) },
      configuration: { resource_id: "fixture" },
    },
    qualification: { schema_version: 1, kind: "fixture-qualification", phase: "complete" },
  }],
});

const environment = { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: "a".repeat(40) };

const slackConfiguration = (): CompanyRecordsRehearsalConfiguration => {
  const base = configuration();
  const sources = [{
    schema_version: 1,
    id: "fixture-conversation",
    record_type: "communication-message",
    connection: "connections/slack.md",
    resource_binding: "fixture-channel",
    delivery: "poll",
    identity: { source_field: "id" },
    fields: [
      { target: "message_id", source: "message_id", value_type: "string", required: true },
      { target: "team_id", source: "team_id", value_type: "string", required: true },
      { target: "author_id", source: "author_id", value_type: "identity", required: true },
      { target: "thread_id", source: "thread_id", value_type: "string", required: true },
      { target: "text", source: "text", value_type: "string" },
      { target: "occurred_at", source: "occurred_at", value_type: "timestamp", required: true },
    ],
    access: { read_groups: ["fixture"], write_roles: [] },
  }];
  const projections = [{
    schema_version: 1,
    id: "fixture-conversation-messages",
    record_type: "communication-message",
    selection: { source_id: "fixture-conversation" },
    fields: [
      { name: "message_id", path: "message_id" },
      { name: "team_id", path: "team_id" },
      { name: "author_id", path: "author_id" },
      { name: "thread_id", path: "thread_id" },
      { name: "text", path: "text" },
      { name: "occurred_at", path: "occurred_at" },
    ],
    freshness: { max_age_minutes: 60 },
    access: { read_groups: ["fixture"] },
    materialization: { mode: "database-view" },
  }];
  const bindings = [{
    source_id: "fixture-conversation",
    binding: {
      schema_version: 1,
      instance_id: "fixture-records-rehearsal",
      source_id: "fixture-conversation",
      resource_binding: "fixture-channel",
      connector: "oregano/slack-record-source",
      connector_version: "0.1.0",
      secret_ref: "env:SLACK_BOT_TOKEN",
      qualification: { receipt_ref: "qualification.json", digest: "d".repeat(64) },
      configuration: {
        team_id: "T12345",
        channel_id: "C12345",
        conversation_kind: "public-channel",
        oldest_at: "2030-01-01T00:00:00.000Z",
        include_threads: true,
        page_size: 100,
        max_pages: 10,
        max_thread_pages: 10,
        max_messages: 1000,
      },
    },
    qualification: { schema_version: 1, kind: "pending-slack-qualification" },
  }];
  return {
    ...base,
    source_confirmations: { "fixture-conversation": "c".repeat(64) },
    sources,
    projections,
    bindings,
  };
};

test("rehearsal authorization is constant-shape and request parsing is strict", () => {
  assert.equal(authorizeCompanyRecordsRehearsal(new Request("https://example.test", { headers: { authorization: "Bearer fixture-secret" } }), "fixture-secret"), true);
  assert.equal(authorizeCompanyRecordsRehearsal(new Request("https://example.test", { headers: { authorization: "Bearer wrong" } }), "fixture-secret"), false);
  assert.deepEqual(parseCompanyRecordsRehearsalRequest({ action: "plan-sync", source_id: "fixture-items" }), { action: "plan-sync", source_id: "fixture-items" });
  assert.deepEqual(parseCompanyRecordsRehearsalRequest({ action: "inspect-identities", source_id: "fixture-items" }), { action: "inspect-identities", source_id: "fixture-items" });
  assert.throws(() => parseCompanyRecordsRehearsalRequest({ action: "plan-sync", source_id: "fixture-items", token: "forbidden" }), CompanyRecordsRehearsalError);
  assert.throws(() => parseCompanyRecordsRehearsalRequest({ action: "apply-migration", source_id: "fixture-items", confirmation_hash: "0".repeat(64) }), CompanyRecordsRehearsalError);
});

test("rehearsal configuration is gzip-bound and rejects unconfirmed sources", () => {
  const encoded = gzipSync(Buffer.from(JSON.stringify(configuration()))).toString("base64");
  assert.equal(decodeCompanyRecordsRehearsalConfiguration(encoded).instance_id, "fixture-records-rehearsal");
  const invalid = structuredClone(configuration()) as any;
  invalid.source_confirmations = {};
  const invalidEncoded = gzipSync(Buffer.from(JSON.stringify(invalid))).toString("base64");
  assert.throws(() => decodeCompanyRecordsRehearsalConfiguration(invalidEncoded), /no confirmation evidence/);
  const credential = structuredClone(configuration()) as any;
  credential.bindings[0].qualification.note = ["xoxb", "1234567890", "abcdefghijklmnop"].join("-");
  const credentialEncoded = gzipSync(Buffer.from(JSON.stringify(credential))).toString("base64");
  assert.throws(() => decodeCompanyRecordsRehearsalConfiguration(credentialEncoded), /SecretRefs, never resolved credentials/);
});

test("hosted Records freezes roster evidence and selects projections by explicit source IDs", () => {
  const value = structuredClone(slackConfiguration()) as any;
  value.roster_markdown = "---\nmembers:\n  - id: member-1\n    name: Example Person\n    role: contributor\n    identities:\n      slack:\n        principal: slack:T12345:U12345\n---\n";
  value.sources[0].fields.find((field: any) => field.target === "author_id").resolve_identity = true;
  delete value.projections[0].selection;
  value.projections[0].source_ids = ["fixture-conversation"];
  value.bindings[0].qualification = { kind: "slack-record-source-qualification", phase: "complete", evidence: { discovery: {
    discovery_hash: "d".repeat(64), authentication_mode: "bot-token", credentials_retained: false,
    team_id: "T12345", channel: { id: "C12345", kind: "public-channel", is_member: true }, scopes: ["channels:history", "channels:read"],
  } } };
  const decoded = decodeCompanyRecordsRehearsalConfiguration(gzipSync(Buffer.from(JSON.stringify(value))).toString("base64"));
  assert.equal(decoded.roster_markdown, value.roster_markdown);
  const selected = validatedCompanyRecordsSelection(decoded, "fixture-conversation");
  assert.equal(selected.projections.length, 1);
  assert.equal(selected.registry.identities!.resolve("slack:T12345:U12345"), "member-1");
  const plan = planCompanyRecordsPreviewSync(decoded, "fixture-conversation").plan;
  const changed = { ...decoded, roster_markdown: value.roster_markdown.replace("member-1", "member-2") };
  assert.notEqual(plan.confirmation_hash, planCompanyRecordsPreviewSync(changed, "fixture-conversation").plan.confirmation_hash);
  assert.throws(() => validatedCompanyRecordsSelection({ ...decoded, roster_markdown: undefined }, "fixture-conversation"), /frozen roster/);
});

test("preview migration requires its exact independent confirmation", async () => {
  const selected = configuration();
  let migrations = 0;
  const dependencies: any = {
    ensureSchema: async () => {
      migrations += 1;
      return { operation: "upgrade", qualification: { manifestVersion: "1.9.0" } };
    },
    planOperation: () => { throw new Error("not reached"); },
    runOperation: () => { throw new Error("not reached"); },
    inspectStatus: () => { throw new Error("not reached"); },
  };
  const planned: any = await executeCompanyRecordsRehearsal({ action: "plan-migration" }, selected, environment, dependencies);
  assert.deepEqual(planned.plan.provider_effects, []);
  await assert.rejects(
    executeCompanyRecordsRehearsal({ action: "apply-migration", confirmation_hash: "0".repeat(64) }, selected, environment, dependencies),
    /confirmation does not match/,
  );
  assert.equal(migrations, 0);
  const applied: any = await executeCompanyRecordsRehearsal({ action: "apply-migration", confirmation_hash: planCompanyRecordsPreviewMigration(selected).confirmation_hash }, selected, environment, dependencies);
  assert.equal(migrations, 1);
  assert.equal(applied.schema_manifest.operation, "upgrade");
  assert.equal(applied.schema_manifest.qualification.manifestVersion, "1.9.0");
});

test("preview sync plans stably, blocks wrong confirmation, and returns payload-free evidence", async () => {
  const selected = configuration();
  let providerReads = 0;
  const dependencies: any = {
    ensureSchema: async () => {},
    planOperation: () => ({
      plan: {
        schema_version: 1,
        kind: "company-record-source-operation",
        operation: "sync",
        source_id: "fixture-items",
        source_digest: "e".repeat(64),
        binding_digest: "f".repeat(64),
        rehearsal: { source_confirmation_hash: "c".repeat(64) },
        confirmation_hash: "discarded",
      },
      diagnostics: [],
    }),
    runOperation: async () => {
      providerReads += 1;
      return {
        applied: true,
        receipt: { observed: 2, inserted: 2, unchanged: 0, deleted: 0, errors: 0 },
        provider_evidence: { connector: "fixture/record-source", objects: 2, complete: true, credentials_retained: false },
        credentials_retained: false,
      };
    },
    inspectStatus: async () => ({ diagnostics: [], status: { current_objects: 2 }, binding: { connector: "fixture/record-source@1.0.0" } }),
  };
  const first: any = await executeCompanyRecordsRehearsal({ action: "plan-sync", source_id: "fixture-items" }, selected, environment, dependencies);
  const second: any = await executeCompanyRecordsRehearsal({ action: "plan-sync", source_id: "fixture-items" }, selected, environment, dependencies);
  assert.equal(first.plan.confirmation_hash, second.plan.confirmation_hash);
  assert.equal(first.plan.rehearsal.source_confirmation_hash, "c".repeat(64));
  await assert.rejects(
    executeCompanyRecordsRehearsal({ action: "apply-sync", source_id: "fixture-items", confirmation_hash: "0".repeat(64) }, selected, environment, dependencies),
    /confirmation does not match/,
  );
  assert.equal(providerReads, 0);
  const applied: any = await executeCompanyRecordsRehearsal({ action: "apply-sync", source_id: "fixture-items", confirmation_hash: first.plan.confirmation_hash }, selected, environment, dependencies);
  assert.equal(providerReads, 1);
  assert.equal(applied.receipt.observed, 2);
  assert.equal(JSON.stringify(applied).includes("First"), false);
  const status: any = await executeCompanyRecordsRehearsal({ action: "status", source_id: "fixture-items" }, selected, environment, dependencies);
  assert.equal(status.status.current_objects, 2);
});

test("protected Preview identity inspection returns only bounded review candidates without effects", async () => {
  const selected = configuration();
  (selected.sources[0] as any).fields.push({ target: "person_ids", source: "columns.people", value_type: "identity" });
  const dependencies: any = {
    inspectIdentities: async () => ({
      candidates: [{
        source_object_id: "item-1",
        object_kind: "item",
        object_name: "Head of Operations",
        identities: [{ target: "person_ids", provider_ids: ["member-1"], display_text: "Alex Example" }],
      }],
      provider_evidence: { connector: "fixture/record-source", complete: true, objects: 1 },
      credentials_retained: false,
      provider_effects: [],
      database_effects: [],
    }),
  };
  const result: any = await executeCompanyRecordsRehearsal({ action: "inspect-identities", source_id: "fixture-items" }, selected, environment, dependencies);
  assert.equal(result.operation, "inspect-identities");
  assert.deepEqual(result.candidates[0].identities[0].provider_ids, ["member-1"]);
  assert.deepEqual(result.provider_effects, []);
  assert.deepEqual(result.database_effects, []);
  assert.equal(result.credentials_retained, false);
});

test("production and mismatched Core deployments fail before planning", async () => {
  const selected = configuration();
  let planned = false;
  const dependencies: any = {
    ensureSchema: async () => {},
    planOperation: () => { planned = true; return { plan: {}, diagnostics: [] }; },
    runOperation: async () => ({ applied: true }),
    inspectStatus: async () => ({ diagnostics: [] }),
  };
  await assert.rejects(executeCompanyRecordsRehearsal({ action: "plan-sync", source_id: "fixture-items" }, selected, { ...environment, VERCEL_ENV: "production" }, dependencies), /only in a Vercel Preview/);
  await assert.rejects(executeCompanyRecordsRehearsal({ action: "plan-sync", source_id: "fixture-items" }, selected, { ...environment, VERCEL_GIT_COMMIT_SHA: "9".repeat(40) }, dependencies), /does not match/);
  assert.equal(planned, false);
});

test("protected Preview Monday qualification requires an exact metadata-read confirmation", async () => {
  const selected = configuration();
  const request = parseCompanyRecordsRehearsalRequest({
    action: "plan-monday-qualification",
    agent_id: "700001",
    boards: [{ id: "100002", permission: "read-write" }],
    qualification_plan_hash: "7".repeat(64),
  });
  if (request.action !== "plan-monday-qualification") throw new Error("fixture request did not parse as Monday qualification");
  let providerReads = 0;
  const dependencies: any = {
    ensureSchema: async () => {},
    planOperation: () => { throw new Error("not reached"); },
    runOperation: () => { throw new Error("not reached"); },
    inspectStatus: () => { throw new Error("not reached"); },
    qualifyMonday: async () => {
      providerReads += 1;
      return createMondayExternalAgentQualificationEvidence({
        agentId: "700001",
        apiVersion: "dev",
        boards: [{ id: "100002", permission: "read-write" }],
        planHash: "7".repeat(64),
        observedAt: "2026-09-02T10:00:00.000Z",
        result: {
          apiVersion: "dev",
          requestId: "request-1",
          data: {
            identity: { memberId: "member-1", name: "Fixture Agent", kind: "external_agent_member", email: "agent-900001@agent.monday.com", externalAgentId: "900001" },
            account: { id: "account-1", name: "Fixture Company" },
            boards: [{ id: "100002", name: "Sprint Test", boardKind: "private", state: "active", permissions: "edit", accessLevel: "edit", workspace: null, groups: [], columns: [] }],
          },
        },
      });
    },
  };
  const planned: any = await executeCompanyRecordsRehearsal(request, selected, environment, dependencies);
  assert.equal(planned.plan.kind, "company-records-preview-monday-agent-qualification");
  assert.equal(planned.plan.provider_secret_ref, "env:MONDAY_API_TOKEN");
  assert.deepEqual(planned.plan.provider_effects, []);
  assert.equal(providerReads, 0);
  await assert.rejects(
    executeCompanyRecordsRehearsal({ ...request, action: "apply-monday-qualification", confirmation_hash: "0".repeat(64) }, selected, environment, dependencies),
    /confirmation does not match/,
  );
  assert.equal(providerReads, 0);
  const exact = planCompanyRecordsPreviewMondayQualification(selected, request).confirmation_hash;
  const applied: any = await executeCompanyRecordsRehearsal({ ...request, action: "apply-monday-qualification", confirmation_hash: exact }, selected, environment, dependencies);
  assert.equal(providerReads, 1);
  assert.equal(applied.operation, "monday-agent-qualification-read");
  assert.equal(applied.credentials_retained, false);
  assert.equal(applied.evidence.discovery.configured_agent_id, "700001");
  assert.deepEqual(applied.provider_effects, []);
});

test("protected Preview Slack qualification proves one exact conversation without reading messages", async () => {
  const selected = slackConfiguration();
  const request = parseCompanyRecordsRehearsalRequest({ action: "plan-slack-qualification", source_id: "fixture-conversation" });
  if (request.action !== "plan-slack-qualification") throw new Error("fixture request did not parse as Slack qualification");
  let providerReads = 0;
  const dependencies: any = {
    qualifySlack: async () => {
      providerReads += 1;
      return {
        kind: "slack-record-source-qualification",
        phase: "complete",
        evidence: {
          discovery: {
            discovery_hash: "e".repeat(64),
            observed_at: "2030-01-01T00:00:00.000Z",
            authentication_mode: "bot-token",
            credentials_retained: false,
            team_id: "T12345",
            bot_user_id: "U99999",
            channel: { id: "C12345", kind: "public-channel", is_member: true },
            scopes: ["channels:history", "channels:read"],
            request_ids: ["request-auth", "request-info"],
          },
        },
      };
    },
  };
  const planned: any = await executeCompanyRecordsRehearsal(request, selected, environment, dependencies);
  assert.equal(planned.plan.kind, "company-records-preview-slack-source-qualification");
  assert.equal(planned.plan.provider_secret_ref, "env:SLACK_BOT_TOKEN");
  assert.equal(planned.plan.channel_id, "C12345");
  assert.deepEqual(planned.plan.provider_effects, []);
  assert.equal(providerReads, 0);
  await assert.rejects(
    executeCompanyRecordsRehearsal({ action: "apply-slack-qualification", source_id: "fixture-conversation", confirmation_hash: "0".repeat(64) }, selected, environment, dependencies),
    /confirmation does not match/,
  );
  assert.equal(providerReads, 0);
  const confirmationHash = planCompanyRecordsPreviewSlackQualification(selected, "fixture-conversation").confirmation_hash;
  const applied: any = await executeCompanyRecordsRehearsal({ action: "apply-slack-qualification", source_id: "fixture-conversation", confirmation_hash: confirmationHash }, selected, environment, dependencies);
  assert.equal(providerReads, 1);
  assert.equal(applied.operation, "slack-source-qualification-read");
  assert.equal(applied.evidence.evidence.discovery.channel.id, "C12345");
  assert.equal(JSON.stringify(applied).includes("message"), false);
  assert.deepEqual(applied.provider_effects, []);
  assert.deepEqual(applied.database_effects, []);
});
