import assert from "node:assert/strict";
import { test } from "node:test";
import { SlackRecordSourceConnector } from "../../connectors/slack/records-source.ts";
import { qualifySlackRecordSource } from "../../connectors/slack/record-source-qualification.ts";
import { slackMessagePermalink } from "../../connectors/slack/thread-content.ts";
import type { CompanyRecordSourceDeclaration } from "../../records/contracts.ts";
import type { CompanyRecordSourceBinding } from "../../records/source-connector.ts";
const source: CompanyRecordSourceDeclaration = { schema_version: 1, id: "discussion", record_type: "communication-message",
 connection: "connections/slack.md", resource_binding: "discussion", delivery: "poll", identity: { source_field: "id" },
 fields: [{ target: "text", source: "text", value_type: "string" }], access: { read_groups: ["team"], write_roles: [] } };
async function fixture(mode: "normal" | "missing" | "limited" | "changed" | "wrong-link" | "cycle" = "normal") {
 const calls: URL[] = [], root = { ts: "1893456000.000001", user: "U11111", text: "Initial proposal", reply_count: 2 };
 const replies = [
  { ts: "1893628800.000001", thread_ts: root.ts, user: "U22222", text: "Later answer", edited: { ts: "1893628801.000001", user: "U22222" } },
  { ts: "1893456000.000002", thread_ts: root.ts, bot_id: "B11111", text: "Recorded" },
 ];
 const response = (data: any) => new Response(JSON.stringify({ ok: true, ...data }), { headers: { "content-type": "application/json", "x-oauth-scopes": "channels:read,channels:history", "x-slack-req-id": "synthetic" } });
 const fetcher = async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : input); calls.push(url);
  switch (url.pathname.split("/").at(-1)) {
   case "auth.test": return response({ team_id: "T12345", user_id: "U99999" });
   case "conversations.info": return response({ channel: { id: "C12345", is_private: false, is_member: true } });
   case "conversations.history": return response({ messages: [root] });
   case "conversations.replies": return response({ is_limited: mode === "limited", messages: url.searchParams.has("cursor") ? [replies[1]] :
    [{ ...root, ...(mode === "changed" ? { text: "Changed during scan" } : {}) }, ...(mode === "missing" ? [] : [replies[0]])],
    response_metadata: { next_cursor: !url.searchParams.has("cursor") || mode === "cycle" ? "second" : "" } });
   case "chat.getPermalink": return response({ channel: "C12345", permalink: `https://synthetic.slack.com/archives/${mode === "wrong-link" ? "C54321" : "C12345"}/p${url.searchParams.get("message_ts")!.replace(".", "")}` });
   default: throw new Error("Unexpected method");
  }
 };
 const qualification = await qualifySlackRecordSource({ token: "synthetic", teamId: "T12345", channelId: "C12345", fetcher });
 const binding: CompanyRecordSourceBinding = { schema_version: 1, instance_id: "synthetic", source_id: source.id, resource_binding: source.resource_binding,
  connector: "oregano/slack-record-source", connector_version: "0.1.5", secret_ref: "env:SYNTHETIC_TOKEN",
  qualification: { receipt_ref: "instance:synthetic", digest: qualification.evidence.discovery.discovery_hash },
  configuration: { team_id: "T12345", channel_id: "C12345", conversation_kind: "public-channel", oldest_at: "2030-01-01T00:00:00.000Z",
   latest_at: "2030-01-02T00:00:00.000Z", include_threads: true, thread_content: true, max_messages: 10, max_pages: 2, max_thread_pages: 3 } };
 const connector = new SlackRecordSourceConnector({ resolveSecret: () => "synthetic", fetcher });
 return { calls, root, replies, binding, run: () => connector.readCompleteInventory({ source, binding, qualification: { ...qualification } }) };
}
test("complete discussion preserves sorted replies beyond the root window, real permalinks and content update identity", async () => {
 const f = await fixture(), first = await f.run(), root = first.objects.find(x => x.is_thread_root)!;
 const content = root.thread_content as any;
 assert.equal(content.complete, true);assert.equal(content.kind, "discussion");assert.equal(content.identity, "slack:T12345:C12345:1893456000.000001");
 assert.deepEqual(content.source_context.messages.map((x: any) => x.message_id), [f.root.ts, f.replies[1]!.ts, f.replies[0]!.ts]);
 assert.equal(content.source_context.messages[1].author_kind, "bot");assert.ok(content.text.includes("Later answer"));
 assert.ok(first.objects.filter(x => !x.is_thread_root).every(x => x.thread_content === undefined));
 assert.equal(f.calls.filter(x => x.pathname.endsWith("chat.getPermalink")).length, 3);
 for(const url of f.calls.filter(x => x.pathname.endsWith("conversations.replies")))assert.equal(url.searchParams.has("latest") || url.searchParams.has("oldest"), false);
 assert.equal((first.receipt as any).thread_scope, "complete-current-discussions-selected-by-root-date");
 const same = await f.run();assert.equal((same.objects.find(x=>x.is_thread_root)!.thread_content as any).version,content.version);
 f.replies[0]!.text = "Corrected answer";const changed = await f.run(), next = changed.objects.find(x=>x.is_thread_root)!.thread_content as any;
 assert.equal(next.identity,content.identity);assert.notEqual(next.version,content.version);assert.ok(next.text.includes("Corrected answer"));
});
test("complete discussion refuses incomplete, limited, changing, unlinked or cyclic provider results", async () => {
 for(const mode of ["missing","limited","changed","wrong-link","cycle"] as const){const f=await fixture(mode);await assert.rejects(f.run(),Error,mode);}
 const f=await fixture();(f.binding.configuration as any).max_messages=2;await assert.rejects(f.run(),/message bound/);
});
test("thread content requires its exact opt-in version and full replies; legacy payloads do not acquire links or discussion fields", async () => {
 for(const change of [{connector_version:'0.1.4'}, {configuration:{include_threads:false}}]){
  const f=await fixture();if(change.configuration)Object.assign(f.binding.configuration!,change.configuration);else f.binding.connector_version=change.connector_version!;
  await assert.rejects(f.run(),/requires Slack 0.1.5/);
 }
 const f=await fixture();delete (f.binding.configuration as any).thread_content;f.binding.connector_version='0.1.4';const inventory=await f.run();
 assert.ok(inventory.objects.every(x=>x.thread_content===undefined&&x.permalink===undefined));
 assert.equal(f.calls.some(x=>x.pathname.endsWith('chat.getPermalink')),false);
 assert.ok(f.calls.filter(x=>x.pathname.endsWith('conversations.replies')).every(x=>x.searchParams.has('latest')));
});
test("provider permalinks must identify the selected channel and cannot carry credentials or unsafe targets",()=>{
 for(const value of ['http://synthetic.slack.com/archives/C12345/p123','https://user:password@synthetic.slack.com/archives/C12345/p123',
 'https://slack.com.example.test/archives/C12345/p123','https://synthetic.slack.com/archives/C54321/p123','javascript:alert(1)'])assert.throws(()=>slackMessagePermalink(value,'C12345'));
 assert.equal(slackMessagePermalink('https://synthetic.slack.com/archives/C12345/p123?thread_ts=1.2&cid=C12345','C12345'),'https://synthetic.slack.com/archives/C12345/p123?thread_ts=1.2&cid=C12345');
});
