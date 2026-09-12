import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { GranolaClient, type GranolaConnection } from "../../connectors/granola/client.ts";

const noteId = "not_12345678901234";
const folderId = "fol_12345678901234";
const observedAt = "2026-09-11T12:00:00.000Z";
const signingSecret = `whsec_${Buffer.from("synthetic-signing-key-for-tests").toString("base64")}`;
const connection: GranolaConnection = {
  workspaceId: "workspace:synthetic", apiBaseUrl: "https://granola.example.test",
  apiKeyRef: "env:TEST_GRANOLA_KEY", webhookSecretRef: "env:TEST_GRANOLA_WEBHOOK",
  requiredScopes: ["workspace"], scope: { kind: "workspace-containers", folderIds: [folderId] }, maxContentBytes: 10_000,
};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const note = (folder = folderId) => ({
  id: noteId, object: "note", title: "Synthetic meeting", created_at: observedAt, updated_at: observedAt,
  folder_membership: [{ id: folder }], summary_text: "An agreed checkpoint.",
  transcript: [{ text: "Review the result on Friday.", speaker: { name: "Alex Example" } }],
});
const client = (fetch: typeof globalThis.fetch, overrides: Partial<GranolaConnection> = {}) => new GranolaClient({
  connection: { ...connection, ...overrides }, fetch, retryDelay: async () => {},
  resolveSecret: ref => ref === connection.webhookSecretRef ? signingSecret : "synthetic-api-key",
});

test("retained Granola reads enforce configured folders, pagination, note version and complete transcripts", async () => {
  const requests: string[] = [];
  const provider = client(async (url, options) => {
    requests.push(String(url));
    assert.equal(options?.redirect, "error");
    assert.equal((options?.headers as Record<string, string>).Authorization, "Bearer synthetic-api-key");
    if (String(url).includes("/v1/folders")) return response({ folders: [{ id: folderId }], hasMore: false });
    if (String(url).includes("/v1/notes?")) return response({ notes: [{ id: noteId, updated_at: observedAt }], hasMore: true, cursor: "page-2" });
    return response(note());
  });
  assert.deepEqual(await provider.verifyScope(), { reachable: true, configuredFolderCount: 1 });
  assert.deepEqual(await provider.listNotes({ pageSize: 30, folderId }), { notes: [{ id: noteId, updatedAt: observedAt }], nextCursor: "page-2" });
  const result = await provider.fetchNote({ noteId, expectedUpdatedAt: observedAt });
  assert.match(result.markdown, /Review the result on Friday/);
  assert.equal(result.transcriptItems, 1);
  await assert.rejects(provider.listNotes({ pageSize: 30 }), /exact configured folder/);
  await assert.rejects(provider.fetchNote({ noteId, expectedUpdatedAt: "2026-09-10T12:00:00.000Z" }), /update identity/);
  assert.ok(requests.some(url => url.includes("include=transcript")));
  await assert.rejects(client(async () => response(note("fol_99999999999999"))).fetchNote({ noteId }), /outside/);
});

test("retained Granola client retries bounded provider failures and paginates transcripts after HTTP 413", async () => {
  let attempts = 0;
  const provider = client(async url => {
    if (++attempts === 1) return response({}, 429);
    if (String(url).includes("include=transcript")) return response({}, 413);
    if (String(url).includes("/transcript?")) {
      const next = String(url).includes("cursor=next");
      return response({ transcript: [{ text: next ? "Second segment" : "First segment" }], hasMore: !next, ...(next ? {} : { cursor: "next" }) });
    }
    const value = note(); delete (value as Partial<typeof value>).transcript; return response(value);
  });
  const result = await provider.fetchNote({ noteId });
  assert.match(result.markdown, /First segment/);
  assert.match(result.markdown, /Second segment/);
  assert.equal(result.transcriptItems, 2);
  let failures = 0;
  await assert.rejects(client(async () => { failures++; return response({ token: "never-echo-this" }, 503); }).verifyScope(), error => {
    assert.doesNotMatch(String(error), /never-echo-this|synthetic-api-key/); return true;
  });
  assert.equal(failures, 3);
});

test("retained Granola reads fail closed for missing cursors and content limits", async () => {
  await assert.rejects(client(async () => response({ notes: [], hasMore: true })).listNotes({ pageSize: 1, folderId }), /without a cursor/);
  await assert.rejects(client(async () => response(note()), { maxContentBytes: 10 }).fetchNote({ noteId }), /maximum content/);
  assert.throws(() => client(async () => response({}), { scope: { kind: "workspace-containers", folderIds: [] } }), /explicit valid folder/);
  assert.throws(() => client(async () => response({}), { apiBaseUrl: "http://granola.example.test" }), /HTTPS/);
});

test("retained Granola webhook verification binds exact bytes, identity and replay window without storage", async () => {
  const provider = client(async () => { throw Error("Webhook verification must not fetch or persist content."); });
  const payload = { event_id: "event-synthetic", event_type: "note.generated", note_id: noteId, occurred_at: observedAt };
  const rawBody = Buffer.from(JSON.stringify(payload));
  const timestamp = String(Date.parse(observedAt) / 1000);
  const signature = createHmac("sha256", Buffer.from(signingSecret.slice(6), "base64")).update(`${payload.event_id}.${timestamp}.${rawBody}`).digest("base64");
  const headers = { "webhook-id": payload.event_id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` };
  assert.equal((await provider.acceptWebhook({ rawBody, headers, observedAt })).noteId, noteId);
  await assert.rejects(provider.acceptWebhook({ rawBody: Buffer.from(JSON.stringify({ ...payload, note_id: "not_99999999999999" })), headers, observedAt }), /signature verification/);
  await assert.rejects(provider.acceptWebhook({ rawBody, headers, observedAt: "2026-09-11T12:06:00Z" }), /replay window/);
  await assert.rejects(provider.acceptWebhook({ rawBody, headers: { ...headers, "webhook-id": "another-event" }, observedAt }), /signature verification/);
});
