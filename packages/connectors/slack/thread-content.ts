import { createHash } from "node:crypto";
import type { JsonValue } from "../../capabilities/contracts.ts";

const stamp = (value: unknown) => {
  if (typeof value !== "string" || !/^\d{1,16}(?:\.\d{1,9})?$/.test(value)) throw new Error("Invalid Slack thread message timestamp");
  const [seconds, fraction = ""] = value.split(".");
  return BigInt(seconds!) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
};

/** Validate a provider-returned link, without inventing or following a message URL. */
export function slackMessagePermalink(value: unknown, channelId: string): string {
  if (typeof value !== "string") throw new Error("Slack did not return a message permalink");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Slack returned an invalid permalink"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !url.hostname.endsWith(".slack.com")
    || !new RegExp("^/archives/" + channelId + "/p[0-9]+$").test(url.pathname)) throw new Error("Slack permalink does not identify the selected conversation");
  return value;
}

/** Pure ordered source content on existing root messages; no knowledge or identity inference. */
export function completeSlackThread(root: Record<string, JsonValue>, all: Array<Record<string, JsonValue>>): Record<string, JsonValue> {
  if (root.is_thread_root !== true || root.is_deleted === true) throw new Error("Complete Slack discussion requires an extant root");
  const messages = all.filter(message => message.thread_id === root.message_id);
  if (!messages.some(message => message.id === root.id)) throw new Error("Complete Slack discussion is missing its root");
  messages.sort((a, b) => stamp(a.message_id) < stamp(b.message_id) ? -1 : stamp(a.message_id) > stamp(b.message_id) ? 1 : 0);
  const seen = new Set<string>();
  const content = messages.map(message => {
    if (message.team_id !== root.team_id || message.conversation_id !== root.conversation_id || typeof message.id !== "string"
      || seen.has(message.id) || stamp(message.message_id) < stamp(root.message_id)) throw new Error("Conflicting Slack discussion identity or order");
    seen.add(message.id);
    return { id: message.id, message_id: message.message_id, author_principal: message.author_principal,
      content_author_principal: message.content_author_principal, author_kind: message.author_kind,
      text: message.text, occurred_at: message.occurred_at, edited_at: message.edited_at ?? null,
      is_deleted: message.is_deleted, permalink: slackMessagePermalink(message.permalink, String(root.conversation_id)) };
  });
  const identity = `slack:${root.team_id}:${root.conversation_id}:${root.message_id}`;
  const sourceContext = { provider: "slack", team_id: root.team_id, channel_id: root.conversation_id, thread_id: root.message_id, messages: content };
  const text = content.map(message => `[${message.occurred_at}] ${message.author_principal} (${message.permalink}): ${message.is_deleted ? "[message deleted]" : message.text}`).join("\n\n");
  const version = createHash("sha256").update(JSON.stringify({ identity, content })).digest("hex");
  return { identity, version, kind: "discussion", text, original_url: slackMessagePermalink(root.permalink, String(root.conversation_id)),
    occurred_at: root.occurred_at, complete: true, source_context: sourceContext };
}
