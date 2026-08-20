import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import type { Lock, QueueEntry, StateAdapter } from "chat";
import { ensureCompanyOSSchema } from "../../../state-postgres/migrate.ts";

export const decodePostgresJsonValue = <T>(value: unknown): T => {
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    // A JSONB string is returned by the Neon driver as the unquoted string.
    // Slack identifiers therefore must not be treated as serialized JSON.
    return value as T;
  }
};

export function createPostgresChatState(): StateAdapter {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not configured.");
  const sql = neon(databaseUrl);
  return {
    async connect() { await ensureCompanyOSSchema(); },
    async disconnect() {},
    async get<T>(key: string): Promise<T | null> {
      await ensureCompanyOSSchema();
      const rows = await sql`select value from companyos.chat_values
        where key = ${key} and (expires_at is null or expires_at > now())`;
      return rows[0] ? decodePostgresJsonValue<T>(rows[0].value) : null;
    },
    async set<T>(key: string, value: T, ttlMs?: number) {
      const expiresAt = ttlMs === undefined ? null : new Date(Date.now() + ttlMs);
      await sql`insert into companyos.chat_values (key, value, expires_at)
        values (${key}, ${JSON.stringify(value)}, ${expiresAt})
        on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at`;
    },
    async setIfNotExists(key: string, value: unknown, ttlMs?: number) {
      const expiresAt = ttlMs === undefined ? null : new Date(Date.now() + ttlMs);
      await sql`delete from companyos.chat_values where key = ${key} and expires_at <= now()`;
      const rows = await sql`insert into companyos.chat_values (key, value, expires_at)
        values (${key}, ${JSON.stringify(value)}, ${expiresAt}) on conflict (key) do nothing returning key`;
      return rows.length === 1;
    },
    async delete(key: string) { await sql`delete from companyos.chat_values where key = ${key}`; },
    async subscribe(threadId: string) {
      await sql`insert into companyos.chat_subscriptions (thread_id) values (${threadId}) on conflict do nothing`;
    },
    async unsubscribe(threadId: string) { await sql`delete from companyos.chat_subscriptions where thread_id = ${threadId}`; },
    async isSubscribed(threadId: string) {
      const rows = await sql`select 1 from companyos.chat_subscriptions where thread_id = ${threadId}`;
      return rows.length === 1;
    },
    async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
      const token = randomUUID();
      const expiresAt = new Date(Date.now() + ttlMs);
      const rows = await sql`insert into companyos.chat_locks (thread_id, token, expires_at)
        values (${threadId}, ${token}, ${expiresAt})
        on conflict (thread_id) do update set token = excluded.token, expires_at = excluded.expires_at
        where companyos.chat_locks.expires_at <= now() returning thread_id, token, expires_at`;
      return rows[0] ? { threadId, token, expiresAt: new Date(rows[0].expires_at as string).getTime() } : null;
    },
    async extendLock(lock: Lock, ttlMs: number) {
      const expiresAt = new Date(Date.now() + ttlMs);
      const rows = await sql`update companyos.chat_locks set expires_at = ${expiresAt}
        where thread_id = ${lock.threadId} and token = ${lock.token} returning thread_id`;
      return rows.length === 1;
    },
    async releaseLock(lock: Lock) {
      await sql`delete from companyos.chat_locks where thread_id = ${lock.threadId} and token = ${lock.token}`;
    },
    async forceReleaseLock(threadId: string) { await sql`delete from companyos.chat_locks where thread_id = ${threadId}`; },
    async appendToList(key: string, value: unknown, options?: { maxLength?: number; ttlMs?: number }) {
      const expiresAt = options?.ttlMs === undefined ? null : new Date(Date.now() + options.ttlMs);
      const maxLength = options?.maxLength ?? 1000;
      await sql`with refreshed as (
          update companyos.chat_lists set expires_at = ${expiresAt} where key = ${key}
        ), inserted as (
          insert into companyos.chat_lists (key, value, expires_at)
          values (${key}, ${JSON.stringify(value)}, ${expiresAt}) returning sequence
        ), ranked as (
          select sequence, row_number() over (order by sequence desc) as position
          from (
            select sequence from companyos.chat_lists where key = ${key}
            union all select sequence from inserted
          ) entries
        ), stale as (
          select sequence from ranked where position > ${maxLength}
        ) delete from companyos.chat_lists where sequence in (select sequence from stale)`;
    },
    async getList<T>(key: string): Promise<T[]> {
      await sql`delete from companyos.chat_lists where key = ${key} and expires_at <= now()`;
      const rows = await sql`select value from companyos.chat_lists where key = ${key} order by sequence`;
      return rows.map((row) => decodePostgresJsonValue<T>(row.value));
    },
    async enqueue(threadId: string, entry: QueueEntry, maxSize: number) {
      await sql`with inserted as (
          insert into companyos.chat_queue (thread_id, entry, expires_at)
          values (${threadId}, ${JSON.stringify(entry)}, ${new Date(entry.expiresAt)}) returning sequence
        ), ranked as (
          select sequence, row_number() over (order by sequence desc) as position
          from (
            select sequence from companyos.chat_queue where thread_id = ${threadId}
            union all select sequence from inserted
          ) entries
        ), stale as (
          select sequence from ranked where position > ${maxSize}
        ) delete from companyos.chat_queue where sequence in (select sequence from stale)`;
      const rows = await sql`select count(*) as count from companyos.chat_queue
        where thread_id = ${threadId} and expires_at > now()`;
      return Number(rows[0]?.count ?? 0);
    },
    async dequeue(threadId: string): Promise<QueueEntry | null> {
      const rows = await sql`with next as (
          select sequence from companyos.chat_queue where thread_id = ${threadId} and expires_at > now()
          order by sequence limit 1 for update skip locked
        ) delete from companyos.chat_queue q using next
          where q.sequence = next.sequence returning q.entry`;
      return rows[0] ? decodePostgresJsonValue<QueueEntry>(rows[0].entry) : null;
    },
    async queueDepth(threadId: string) {
      await sql`delete from companyos.chat_queue where thread_id = ${threadId} and expires_at <= now()`;
      const rows = await sql`select count(*) as count from companyos.chat_queue where thread_id = ${threadId}`;
      return Number(rows[0]?.count ?? 0);
    },
  };
}
