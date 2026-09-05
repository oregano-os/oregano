import assert from "node:assert/strict";
import test from "node:test";
import type { CompanyRecordSourceBinding } from "../../../records/source-connector.ts";
import { resolveRecordSourceCredential } from "./record-source-credential.ts";

const binding = (credentialProvider?: string): CompanyRecordSourceBinding => ({
  schema_version: 1,
  instance_id: "fixture-instance",
  source_id: "fixture-conversation",
  resource_binding: "fixture-channel",
  connector: "oregano/slack-record-source",
  connector_version: "0.1.0",
  secret_ref: "env:SLACK_CREDENTIAL_HANDLE",
  qualification: { receipt_ref: "qualification.json", digest: "a".repeat(64) },
  configuration: {
    ...(credentialProvider ? { credential_provider: credentialProvider } : {}),
  },
});

test("Record Source credential resolver preserves direct environment resolution", async () => {
  let exchanges = 0;
  const credential = await resolveRecordSourceCredential(
    binding(),
    { SLACK_CREDENTIAL_HANDLE: "fixture-direct-credential" },
    async () => { exchanges += 1; return "unused"; },
  );
  assert.equal(credential, "fixture-direct-credential");
  assert.equal(exchanges, 0);
});

test("Record Source credential resolver exchanges a Vercel Connect handle for one app token", async () => {
  const handles: string[] = [];
  const credential = await resolveRecordSourceCredential(
    binding("vercel-connect-app"),
    { SLACK_CREDENTIAL_HANDLE: "slack/fixture-connector" },
    async (handle) => { handles.push(handle); return "fixture-issued-credential"; },
  );
  assert.equal(credential, "fixture-issued-credential");
  assert.deepEqual(handles, ["slack/fixture-connector"]);
});

test("Record Source credential resolver fails closed for unsupported or empty resolution", async () => {
  await assert.rejects(resolveRecordSourceCredential(binding("unknown"), { SLACK_CREDENTIAL_HANDLE: "fixture" }), /Unsupported Record Source credential provider/);
  const monday = { ...binding("vercel-connect-app"), connector: "oregano/monday-record-source" };
  await assert.rejects(resolveRecordSourceCredential(monday, { SLACK_CREDENTIAL_HANDLE: "fixture" }), /supported only.*Slack/);
  await assert.rejects(resolveRecordSourceCredential(binding("vercel-connect-app"), { SLACK_CREDENTIAL_HANDLE: "fixture" }, async () => ""), /did not issue/);
  await assert.rejects(resolveRecordSourceCredential(binding(), {}), /is unavailable/);
});
