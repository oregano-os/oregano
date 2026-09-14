import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { GoogleMeetClient, GoogleMeetError, createGoogleMeetTokenProvider } from "../../connectors/google-meet/client.ts";
import { discoverGoogleMeetTranscripts } from "../../connectors/google-meet/discovery.ts";

const identity = { projectId: "synthetic-company", serviceAccountEmail: "reader@synthetic-company.iam.gserviceaccount.com", clientId: "1234567890", subject: "reader@example.test" };
const conference = { name: "conferenceRecords/meeting-1", startTime: "2030-04-01T10:00:00Z", endTime: "2030-04-01T11:00:00Z", expireTime: "2030-05-01T11:00:00Z", space: "spaces/synthetic" };
const transcript = { name: `${conference.name}/transcripts/transcript-1`, state: "FILE_GENERATED", startTime: conference.startTime, endTime: conference.endTime, docsDestination: { document: "synthetic-doc", exportUri: "https://docs.google.com/document/d/synthetic-doc/edit" } };
const response = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers });

test("delegated credentials must match the explicit identity before SDK construction; arbitrary credential endpoints are refused", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = { type: "service_account", project_id: identity.projectId, client_email: identity.serviceAccountEmail, client_id: identity.clientId,
    private_key: privateKey.export({ format: "pem", type: "pkcs8" }), token_uri: "https://oauth2.googleapis.com/token" };
  assert.equal(typeof createGoogleMeetTokenProvider(JSON.stringify(key), identity), "function");
  for (const change of [{ client_email: "other@synthetic-company.iam.gserviceaccount.com" }, { type: "external_account" }, { token_uri: "https://example.test/steal" }, { private_key: "sensitive-invalid-key" }]) {
    assert.throws(() => createGoogleMeetTokenProvider(JSON.stringify({ ...key, ...change }), identity), error => error instanceof GoogleMeetError && error.code === "credential-identity-mismatch" && !error.message.includes("sensitive"));
  }
  assert.throws(() => createGoogleMeetTokenProvider(JSON.stringify(key), { ...identity, subject: "invalid\r\nsubject" }));
});

test("all pages use the fixed Google host, encoded parameters and parent-scoped resource identities", async () => {
  const requests: URL[] = [];
  const client = new GoogleMeetClient({ token: async () => "synthetic-token", fetcher: async (url, options) => {
    const request = new URL(String(url)); requests.push(request);
    assert.equal(request.origin, "https://meet.googleapis.com"); assert.equal(options?.method, "GET"); assert.equal(options?.redirect, "error");
    assert.equal((options?.headers as Record<string, string>).authorization, "Bearer synthetic-token");
    return requests.length === 1 ? response({ conferenceRecords: [conference], nextPageToken: "opaque?&token" }) : response({ conferenceRecords: [{ ...conference, name: "conferenceRecords/meeting-2" }] });
  } });
  const list = await client.conferences({ startAt: "2030-04-01T00:00:00Z", endAt: "2030-04-02T00:00:00Z" });
  assert.equal(list.items.length, 2); assert.equal(list.receipt.pages, 2);
  assert.equal(requests[1].searchParams.get("pageToken"), "opaque?&token"); assert.equal(requests[0].searchParams.get("pageSize"), "100");
  assert.throws(() => client.entries("https://example.test/credentials"));
  const foreign = new GoogleMeetClient({ token: async () => "synthetic-token", fetcher: async () => response({ transcripts: [{ ...transcript, name: "conferenceRecords/foreign/transcripts/wrong" }] }) });
  await assert.rejects(foreign.transcripts(conference.name), /resource-scope-mismatch/);
});

test("permission failures never become empty inventories or expose provider bodies; throttling has a finite retry budget", async () => {
  for (const status of [401, 403, 404]) {
    let count = 0;
    const client = new GoogleMeetClient({ token: async () => "synthetic-token", fetcher: async () => { count++; return response({ error: "private-provider-detail" }, status); } });
    await assert.rejects(client.conferences(), error => error instanceof GoogleMeetError && error.httpStatus === status && !error.message.includes("private")); assert.equal(count, 1);
  }
  let count = 0; const delays: number[] = [];
  const client = new GoogleMeetClient({ token: async () => "synthetic-token", sleep: async ms => { delays.push(ms); }, fetcher: async () => { count++; return response({}, 429, { "retry-after": "1" }); } });
  await assert.rejects(client.conferences(), /rate-limited/); assert.equal(count, 3); assert.deepEqual(delays, [1000, 1000]);
  const wait = new GoogleMeetClient({ token: async () => "synthetic-token", sleep: async () => { throw new Error("Must not block a worker for a long retry"); }, fetcher: async () => response({}, 429, { "retry-after": "60" }) });
  await assert.rejects(wait.conferences(), error => error instanceof GoogleMeetError && error.retryAfterSeconds === 60);
});

test("repeated cursors, conflicting versions and exhausted bounds refuse a completeness claim", async () => {
  const create = (data: unknown, maxPages = 100) => new GoogleMeetClient({ token: async () => "synthetic", maxPages, fetcher: async () => response(data) });
  await assert.rejects(create({ conferenceRecords: [], nextPageToken: "again" }).conferences(), /repeated-page-token/);
  await assert.rejects(create({ conferenceRecords: [], nextPageToken: "again" }, 1).conferences(), /page-bound-exceeded/);
  await assert.rejects(create({ conferenceRecords: [conference, { ...conference, space: "spaces/changed" }] }).conferences(), /conflicting-resource-version/);
  await assert.rejects(create({ conferenceRecords: "not-an-array" }).conferences(), /invalid-list/);
  const large = new GoogleMeetClient({ token: async () => "synthetic", fetcher: async () => new Response("x".repeat(2_000_001)) });
  await assert.rejects(large.conferences(), /response-size-exceeded/);
});

test("metadata discovery retains separate Transcript identities, excludes unfinished artifacts, and never fetches transcript text", async () => {
  const paths: string[] = [];
  const client = new GoogleMeetClient({ token: async () => "synthetic", fetcher: async url => {
    const path = new URL(String(url)).pathname; paths.push(path);
    if (path === "/v2/conferenceRecords") return response({ conferenceRecords: [conference, { ...conference, name: "conferenceRecords/ongoing", endTime: undefined }] });
    assert.equal(path, `/v2/${conference.name}/transcripts`);
    return response({ transcripts: [transcript, { ...transcript, name: `${conference.name}/transcripts/second` }, { ...transcript, name: `${conference.name}/transcripts/pending`, state: "ENDED" }] });
  } });
  const found = await discoverGoogleMeetTranscripts({ client, identity, now: "2030-04-02T00:00:00Z" });
  assert.equal(found.candidates.length, 2); assert.equal(found.excluded.length, 2); assert.equal(paths.length, 2);
  assert.equal(found.qualification.evidence.discovery.transcript_text_read, false);
  assert.deepEqual(found.candidates[0].visible_to, [identity.subject]);
  assert.ok(!JSON.stringify(found.qualification).includes("synthetic-doc"), "Qualification retains digests/counts, not source document payloads");
});

test("entries use transcriptEntries and preserve unmodified text plus source and speaker references", async () => {
  const entry = { name: `${transcript.name}/entries/entry-1`, participant: `${conference.name}/participants/speaker-1`, text: "Unmodified\nsource text 😀", startTime: conference.startTime, endTime: conference.endTime, languageCode: "en" };
  const client = new GoogleMeetClient({ token: async () => "synthetic", fetcher: async () => response({ transcriptEntries: [entry] }) });
  assert.deepEqual((await client.entries(transcript.name)).items, [entry]);
});

import { GoogleMeetRecordSourceConnector, qualifyGoogleMeetRecordSource, GOOGLE_MEET_RECORD_SOURCE_ID } from "../../connectors/google-meet/records-source.ts";
import { sha256 } from "../../runtime/canonical.ts";
import type { CompanyRecordSourceDeclaration } from "../../records/contracts.ts";
import type { CompanyRecordSourceBinding } from "../../records/source-connector.ts";

async function sourceFixture() {
  const discoveryClient = new GoogleMeetClient({ token: async () => "synthetic", fetcher: async url => response(new URL(String(url)).pathname === "/v2/conferenceRecords" ? { conferenceRecords: [conference] } : { transcripts: [transcript] }) });
  const discovery = await discoverGoogleMeetTranscripts({ client: discoveryClient, identity, now: "2030-04-02T00:00:00Z" });
  const qualification = qualifyGoogleMeetRecordSource(discovery, [transcript.name]);
  const source = { id: "synthetic-meet", record_type: "brain-source", resource_binding: "synthetic-meet" } as CompanyRecordSourceDeclaration;
  const binding: CompanyRecordSourceBinding = { schema_version: 1, instance_id: "synthetic", source_id: source.id, resource_binding: source.resource_binding,
    connector: GOOGLE_MEET_RECORD_SOURCE_ID, connector_version: "0.1.0", secret_ref: "env:SYNTHETIC_GOOGLE_CREDENTIAL",
    qualification: { receipt_ref: "local:synthetic-receipt", digest: qualification.evidence.digest }, configuration: JSON.parse(JSON.stringify(qualification.evidence.selection)) };
  const h = { transcriptReads: 0, missing: false, empty: false, changed: false, reverse: false, secrets: 0 };
  const entries = [{ name: `${transcript.name}/entries/later`, participant: `${conference.name}/participants/person-1`, text: "later unchanged", languageCode: "en", startTime: "2030-04-01T10:00:01.000000002Z", endTime: "2030-04-01T10:00:02Z" },
    { name: `${transcript.name}/entries/earlier`, participant: `${conference.name}/participants/person-1`, text: "earlier\nunchanged 😀", languageCode: "en", startTime: "2030-04-01T10:00:01.000000001Z", endTime: "2030-04-01T10:00:02Z" }];
  const participants = [{ name: `${conference.name}/participants/person-1`, signedinUser: { displayName: "Alex", user: "users/not-an-email" } }, { name: `${conference.name}/participants/person-2`, anonymousUser: { displayName: "Guest" } }];
  const client = new GoogleMeetClient({ token: async () => "synthetic", fetcher: async url => {
    const path = new URL(String(url)).pathname;
    if (h.missing) return response({ error: "private-body" }, 403);
    if (path === `/v2/${conference.name}`) return response(conference);
    if (path === `/v2/${conference.name}/participants`) return response({ participants: h.reverse ? [...participants].reverse() : participants });
    if (path === `/v2/${transcript.name}`) { h.transcriptReads++; return response(h.changed && h.transcriptReads % 2 === 0 ? { ...transcript, endTime: "2030-04-01T11:01:00Z" } : transcript); }
    assert.equal(path, `/v2/${transcript.name}/entries`); return response({ transcriptEntries: h.empty ? [] : entries });
  } });
  const connector = new GoogleMeetRecordSourceConnector({ resolveSecret: async () => { h.secrets++; return "synthetic"; }, client: () => client, now: () => new Date("2030-04-02T00:00:00Z") });
  return { h, connector, source, binding, qualification, discovery };
}
test("qualified exact selection feeds complete Records with stable content versions and preserved sub-millisecond order", async () => {
  const f = await sourceFixture(); const first = await f.connector.readCompleteInventory(f);
  assert.equal(first.complete, true); assert.equal(first.objects.length, 1); assert.equal(first.receipt.scope, "exact-qualified-transcript-selection");
  assert.equal(first.objects[0].identity, transcript.name); assert.match(String(first.objects[0].text), /Alex: earlier\nunchanged 😀/);
  assert.ok(String(first.objects[0].text).indexOf("earlier") < String(first.objects[0].text).indexOf("later"));
  const payload = first.objects[0].provider_payload as any;
  assert.equal(payload.entries[0].text, "earlier\nunchanged 😀"); assert.equal(payload.participants[0].signedinUser.user, "users/not-an-email");
  const context = first.objects[0].source_context as any;
  assert.deepEqual(context.participants, payload.participants, "Silent participants remain source evidence");
  assert.equal(context.participants[1].anonymousUser.displayName, "Guest");
  assert.equal(context.participants[0].signedinUser.user, "users/not-an-email");
  assert.equal(context.entries, undefined, "Context does not duplicate the complete transcript text");
  assert.deepEqual(context.conference, conference);
  assert.ok(!JSON.stringify(first.receipt).includes("unchanged"));
  f.h.reverse = true; assert.equal((await f.connector.readCompleteInventory(f)).objects[0].version, first.objects[0].version);
  assert.equal(first.watermark, `google-meet:${sha256(first.objects)}`);
});
test("changed selection and forged qualification fail before secret resolution", async () => {
  const f = await sourceFixture();
  assert.throws(() => qualifyGoogleMeetRecordSource(f.discovery, [`${conference.name}/transcripts/unqualified`]), /unqualified/);
  await assert.rejects(f.connector.readCompleteInventory({ ...f, binding: { ...f.binding, configuration: { ...f.binding.configuration, transcript_names: [`${conference.name}/transcripts/unqualified`] } } }), /qualification-mismatch/);
  await assert.rejects(f.connector.readCompleteInventory({ ...f, qualification: { ...f.qualification, evidence: { ...f.qualification.evidence, credentials_retained: true } } }), /qualification-mismatch/);
  assert.equal(f.h.secrets, 0);
});
test("missing access, absent entries and a changing transcript never produce a complete source inventory", async () => {
  for (const fault of ["missing", "empty", "changed"] as const) {
    const f = await sourceFixture(); f.h[fault] = true;
    await assert.rejects(f.connector.readCompleteInventory(f), error => error instanceof GoogleMeetError && !error.message.includes("private-body"));
  }
});
test("invalid calendar bounds and unexpected list envelopes fail instead of silently losing source data", async () => {
  const client = new GoogleMeetClient({ token: async () => "synthetic", fetcher: async () => response({ entries: [] }) });
  assert.throws(() => client.conferences({ startAt: "2030-02-30T00:00:00Z" }), /invalid-time-bound/);
  await assert.rejects(client.entries(transcript.name), /unexpected-list-envelope/);
  const invalid = new GoogleMeetClient({ token: async () => "synthetic", fetcher: async () => response({ conferenceRecords: null }) });
  await assert.rejects(invalid.conferences(), /invalid-list/);
});

test("Meet source delivery is independent of Brain record types and requires the explicit delegated authentication mode", async () => {
  const f = await sourceFixture();
  assert.equal(f.binding.configuration.authentication_mode, "service-account-dwd");
  const inventory = await f.connector.readCompleteInventory({ ...f, source: { ...f.source, record_type: "meeting-transcript" } });
  assert.equal(inventory.objects.length, 1);
  const secrets = f.h.secrets;
  for (const mode of [undefined, "individual-oauth"]) {
    await assert.rejects(f.connector.readCompleteInventory({ ...f, binding: { ...f.binding,
      configuration: { ...f.binding.configuration, authentication_mode: mode as any } } }), /invalid-source-selection/);
  }
  assert.equal(f.h.secrets, secrets);
});
