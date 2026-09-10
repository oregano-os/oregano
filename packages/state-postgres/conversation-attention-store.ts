import { neon } from "@neondatabase/serverless";
import { ensureCompanyOSSchema } from "./migrate.ts";
import { conversationReceiptKey, conversationScopeKey, type ConversationAttentionStore, type ConversationAttention, type ConversationReceipt } from "../runtime/shared-conversation.ts";
const json = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

/** Reuses the Instance KV table; attention and its routing receipt commit atomically. */
export function createPostgresConversationAttentionStore(): ConversationAttentionStore {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Conversation attention requires Instance state");
  const sql = neon(url);
  return {
    async read(scope) {
      await ensureCompanyOSSchema();
      const rows = await sql`select value from companyos.chat_values where key = ${conversationScopeKey(scope)} and expires_at > now()`;
      return rows[0] ? json<ConversationAttention>(rows[0].value) : undefined;
    },
    async receipt(scope, eventId) {
      await ensureCompanyOSSchema();
      const rows = await sql`select value from companyos.chat_values where key = ${conversationReceiptKey(scope, eventId)} and expires_at > now()`;
      return rows[0] ? json<ConversationReceipt>(rows[0].value) : undefined;
    },
    async commit(scope, revision, next, eventId, receipt) {
      await ensureCompanyOSSchema();
      const rows = await sql`with saved as (
        insert into companyos.chat_values (key, value, expires_at)
        select ${conversationScopeKey(scope)}, ${JSON.stringify(next)}::jsonb, now() + interval '30 days'
        where (${revision} = 0 or exists (select 1 from companyos.chat_values where key = ${conversationScopeKey(scope)}))
          and not exists (select 1 from companyos.chat_values where key = ${conversationReceiptKey(scope, eventId)} and expires_at > now())
        on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at
        where (companyos.chat_values.value->>'revision')::int = ${revision}
          or (companyos.chat_values.expires_at <= now() and ${revision} = 0)
        returning key
      ), receipt as (
        insert into companyos.chat_values (key, value, expires_at)
        select ${conversationReceiptKey(scope, eventId)}, ${JSON.stringify(receipt)}::jsonb, now() + interval '30 days' from saved
        on conflict (key) do nothing returning key
      ) select key from receipt`;
      return rows.length === 1;
    },
  };
}
