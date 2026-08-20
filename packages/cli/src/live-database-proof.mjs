#!/usr/bin/env node
import { neon } from "@neondatabase/serverless";

const nonce = String(process.argv[2] ?? "").trim();
if (!/^oregano-[0-9a-f]{12}$/.test(nonce)) {
  process.stderr.write("Invalid CompanyOS Slack verification nonce.\n");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  process.stderr.write("DATABASE_URL is not available in this Vercel environment.\n");
  process.exit(1);
}

try {
  const sql = neon(process.env.DATABASE_URL);
  const matches = await sql`with matching as (
      select key, min(sequence) as user_sequence from companyos.chat_lists
      where value->>'role' = 'user' and value->>'content' like ${`%${nonce}%`}
      group by key
    ), proof as (
      select entries.value, entries.sequence, matching.user_sequence
      from companyos.chat_lists entries
      join matching on matching.key = entries.key
      where entries.sequence >= matching.user_sequence
    )
    select
      count(*)::int as conversation_entries,
      count(*) filter (where value->>'role' = 'assistant' and sequence > user_sequence)::int as assistant_entries
    from proof`;
  const conversationEntries = Number(matches[0]?.conversation_entries ?? 0);
  const assistantEntries = Number(matches[0]?.assistant_entries ?? 0);
  process.stdout.write(`${JSON.stringify({ ok: conversationEntries >= 2 && assistantEntries >= 1, conversation_entries: conversationEntries, assistant_entries: assistantEntries })}\n`);
  if (conversationEntries < 2 || assistantEntries < 1) process.exitCode = 2;
} catch (error) {
  process.stderr.write(`CompanyOS Slack persistence proof failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}\n`);
  process.exitCode = 1;
}
