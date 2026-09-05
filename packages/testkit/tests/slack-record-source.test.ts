import assert from "node:assert/strict";
import { test } from "node:test";
import { qualifySlackRecordSource } from "../../connectors/slack/record-source-qualification.ts";
import { SlackRecordSourceConnector } from "../../connectors/slack/records-source.ts";
import type { CompanyRecordSourceDeclaration } from "../../records/contracts.ts";
import type { CompanyRecordSourceBinding } from "../../records/source-connector.ts";

const source: CompanyRecordSourceDeclaration = {
  schema_version: 1,
  id: "team-conversation",
  record_type: "communication-message",
  connection: "connections/slack.md",
  resource_binding: "team-conversation",
  delivery: "poll",
  identity: { source_field: "id" },
  fields: [
    { target: "source_id", source: "source_id", value_type: "string", required: true },
    { target: "provider", source: "provider", value_type: "string", required: true },
    { target: "message_id", source: "message_id", value_type: "string", required: true },
    { target: "conversation_id", source: "conversation_id", value_type: "string", required: true },
    { target: "thread_id", source: "thread_id", value_type: "string", required: true },
    { target: "author_id", source: "author_id", value_type: "identity", required: true },
    { target: "author_kind", source: "author_kind", value_type: "string", required: true },
    { target: "text", source: "text", value_type: "string" },
    { target: "occurred_at", source: "occurred_at", value_type: "timestamp", required: true },
    { target: "provider_payload", source: "provider_payload", value_type: "json", required: true },
  ],
  access: { read_groups: ["coordination"], write_roles: [] },
};

const jsonResponse = (value: unknown, requestId: string) => new Response(JSON.stringify(value), {
  status: 200,
  headers: {
    "content-type": "application/json",
    "x-slack-req-id": requestId,
    "x-oauth-scopes": "channels:history,channels:read",
  },
});

const fixture = (limited = false, omitReply = false) => {
  const calls: URL[] = [];
  const fetcher = async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.pathname.endsWith("/auth.test")) return jsonResponse({ ok: true, team_id: "T12345", user_id: "U99999" }, "req-auth");
    if (url.pathname.endsWith("/conversations.info")) return jsonResponse({
      ok: true,
      channel: { id: "C12345", is_private: false, is_member: true },
    }, "req-info");
    if (url.pathname.endsWith("/conversations.history")) {
      if (!url.searchParams.get("cursor")) return jsonResponse({
        ok: true,
        is_limited: limited,
        has_more: true,
        messages: [{ ts: "1893456001.000100", user: "U11111", text: "Synthetic root", reply_count: 1 }],
        response_metadata: { next_cursor: "page-2" },
      }, "req-history-1");
      return jsonResponse({
        ok: true,
        has_more: false,
        messages: [{ ts: "1893456000.000100", bot_id: "B11111", text: "Synthetic earlier" }],
        response_metadata: { next_cursor: "" },
      }, "req-history-2");
    }
    if (url.pathname.endsWith("/conversations.replies")) return jsonResponse({
      ok: true,
      has_more: false,
      messages: [
        { ts: "1893456001.000100", user: "U11111", text: "Synthetic root", reply_count: 1 },
        ...(omitReply ? [] : [{ ts: "1893456002.000200", user: "U22222", text: "Synthetic reply", thread_ts: "1893456001.000100" }]),
      ],
      response_metadata: { next_cursor: "" },
    }, "req-thread-1");
    throw new Error(`Unexpected Slack fixture request '${url.pathname}'`);
  };
  return { calls, fetcher };
};

const qualified = async (fetcher: typeof fetch) => qualifySlackRecordSource({
  token: "fixture-secret",
  teamId: "T12345",
  channelId: "C12345",
  now: () => new Date("2030-01-01T00:00:00.000Z"),
  fetcher,
});

const binding = (qualificationDigest: string): CompanyRecordSourceBinding => ({
  schema_version: 1,
  instance_id: "fixture-instance",
  source_id: source.id,
  resource_binding: source.resource_binding,
  connector: "oregano/slack-record-source",
  connector_version: "0.1.2",
  secret_ref: "env:SLACK_BOT_TOKEN",
  qualification: { receipt_ref: "instance:fixture/slack", digest: qualificationDigest },
  configuration: {
    team_id: "T12345",
    channel_id: "C12345",
    conversation_kind: "public-channel",
    oldest_at: "2030-01-01T00:00:00.000Z",
    latest_at: "2030-01-02T00:00:00.000Z",
    include_threads: true,
    page_size: 2,
    max_pages: 3,
    max_thread_pages: 2,
    max_messages: 10,
  },
});

test("Slack qualification proves one exact member conversation without retaining its token", async () => {
  const { fetcher } = fixture();
  const receipt = await qualified(fetcher as typeof fetch);
  assert.equal(receipt.evidence.discovery.team_id, "T12345");
  assert.equal(receipt.evidence.discovery.channel.id, "C12345");
  assert.equal(receipt.evidence.discovery.channel.kind, "public-channel");
  assert.equal(receipt.evidence.discovery.credentials_retained, false);
  assert.doesNotMatch(JSON.stringify(receipt), /fixture-secret/);
});

test("Slack Record Source returns a complete, ordered, threaded communication inventory", async () => {
  const { calls, fetcher } = fixture();
  const qualification = await qualified(fetcher as typeof fetch);
  const connector = new SlackRecordSourceConnector({
    resolveSecret: () => "fixture-secret",
    fetcher: fetcher as typeof fetch,
    now: () => new Date("2030-01-02T01:00:00.000Z"),
  });
  const inventory = await connector.readCompleteInventory({
    source,
    binding: binding(qualification.evidence.discovery.discovery_hash),
    qualification: qualification as unknown as Record<string, unknown>,
  });
  assert.equal(inventory.complete, true);
  assert.deepEqual(inventory.objects.map((message) => message.message_id), [
    "1893456000.000100",
    "1893456001.000100",
    "1893456002.000200",
  ]);
  assert.equal(inventory.objects[2]?.thread_id, "1893456001.000100");
  assert.equal(inventory.objects[2]?.thread_reference, "slack:C12345:1893456001.000100");
  assert.equal(inventory.objects[2]?.author_id, "U22222");
  assert.equal(inventory.objects[2]?.author_principal, "slack:T12345:U22222");
  assert.equal(inventory.objects[2]?.occurred_at, "2030-01-01T00:00:02.000200Z");
  assert.equal(inventory.objects[2]?.accepted_at, "2030-01-01T00:00:02.000200Z");
  assert.equal(calls.filter((url) => url.pathname.endsWith("/conversations.history")).length, 2);
  assert.equal(calls.filter((url) => url.pathname.endsWith("/conversations.replies")).length, 1);
  assert.doesNotMatch(JSON.stringify(inventory.receipt), /Synthetic/);
  assert.match(inventory.watermark, /^slack:[a-f0-9]{64}$/);
});

test("Slack content versions retain precise edit times and distinguish bots from human authors", async () => {
  const base = fixture();
  const messages = [
    { ts: "1893456000.123456789", user: "U11111", text: "Initial", edited: { ts: "1893456002.000001", user: "U22222" } },
    { ts: "1893456001.000001", user: "U11111", bot_id: "B11111", text: "Bot with user", edited: { ts: "1893456002.000002", user: "U11111" } },
    { ts: "1893456001.000002", user: "U11111", subtype: "bot_message", text: "Bot subtype" },
    { ts: "1893456001.000003", user: "U11111", text: "Missing editor", edited: { ts: "1893456002.000003" } },
  ];
  const fetcher = async (input: string | URL | Request) => String(input).includes("conversations.history")
    ? jsonResponse({ ok: true, messages, has_more: false }, "req-versions") : base.fetcher(input);
  const qualification = await qualified(fetcher as typeof fetch);
  const connector = new SlackRecordSourceConnector({ resolveSecret: () => "fixture-secret", fetcher: fetcher as typeof fetch });
  const args = { source, binding: binding(qualification.evidence.discovery.discovery_hash), qualification: qualification as unknown as Record<string, unknown> };
  const inventory = await connector.readCompleteInventory(args);
  const [human, bot, subtypeBot, unknownEditor] = inventory.objects;
  assert.equal(human!.occurred_at, "2030-01-01T00:00:00.123456789Z");
  assert.equal(human!.accepted_at, "2030-01-01T00:00:02.000001Z");
  assert.equal(human!.author_principal, "slack:T12345:U11111");
  assert.equal(human!.editor_principal, "slack:T12345:U22222");
  assert.equal(human!.content_author_principal, "slack:T12345:U22222");
  assert.equal(bot!.author_kind, "bot");
  assert.equal(bot!.content_author_principal, "slack-bot:T12345:B11111");
  assert.equal(subtypeBot!.author_kind, "bot");
  assert.equal(unknownEditor!.content_author_principal, "slack-unknown:T12345:editor");
  assert.equal(inventory.synced_through, undefined, "precise message times are not a source coverage proof");
  messages[0]!.edited!.ts = "1893456000.123456788";
  await assert.rejects(() => connector.readCompleteInventory(args), /edit timestamp precedes/);
  messages[0]!.edited!.ts = "9999999999999999.1";
  await assert.rejects(() => connector.readCompleteInventory(args), /timestamp.*invalid/);
});

test("Slack Record Source fails closed when provider retention hides history", async () => {
  const { fetcher } = fixture(true);
  const qualification = await qualified(fetcher as typeof fetch);
  const connector = new SlackRecordSourceConnector({ resolveSecret: () => "fixture-secret", fetcher: fetcher as typeof fetch });
  await assert.rejects(() => connector.readCompleteInventory({
    source,
    binding: binding(qualification.evidence.discovery.discovery_hash),
    qualification: qualification as unknown as Record<string, unknown>,
  }), /limited by provider retention/);
});

test("Slack Record Source rejects a qualification for another exact channel", async () => {
  const { fetcher } = fixture();
  const qualification = await qualified(fetcher as typeof fetch);
  const wrong = binding(qualification.evidence.discovery.discovery_hash);
  wrong.configuration.channel_id = "C54321";
  const connector = new SlackRecordSourceConnector({ resolveSecret: () => "fixture-secret", fetcher: fetcher as typeof fetch });
  assert.throws(() => connector.validateBinding({ source, binding: wrong, qualification: qualification as unknown as Record<string, unknown> }), /exact public-channel/);
});

test("Slack Record Source refuses an incomplete thread inventory", async () => {
  const { fetcher } = fixture(false, true);
  const qualification = await qualified(fetcher as typeof fetch);
  const connector = new SlackRecordSourceConnector({ resolveSecret: () => "fixture-secret", fetcher: fetcher as typeof fetch });
  const unbounded = binding(qualification.evidence.discovery.discovery_hash);
  delete unbounded.configuration.latest_at;
  await assert.rejects(() => connector.readCompleteInventory({
    source,
    binding: unbounded,
    qualification: qualification as unknown as Record<string, unknown>,
  }), /0 of 1 declared replies/);
});

test("Slack Record Source does not count replies beyond a bounded latest timestamp as missing", async () => {
  const { fetcher } = fixture(false, true);
  const qualification = await qualified(fetcher as typeof fetch);
  const connector = new SlackRecordSourceConnector({ resolveSecret: () => "fixture-secret", fetcher: fetcher as typeof fetch });
  const inventory = await connector.readCompleteInventory({
    source,
    binding: binding(qualification.evidence.discovery.discovery_hash),
    qualification: qualification as unknown as Record<string, unknown>,
  });
  assert.equal(inventory.complete, true);
  assert.deepEqual(inventory.objects.map((message) => message.message_id), [
    "1893456000.000100",
    "1893456001.000100",
  ]);
});
