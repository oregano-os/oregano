import { neon } from "@neondatabase/serverless";
import type { BuilderTestSession, BuilderTestStore } from "../runtime/builder/functional-tests.ts";
import { sha256 } from "../runtime/canonical.ts";

/** Retained test evidence uses the prepared control store, with no runtime DDL or expiry. */
export function createPostgresBuilderTestStore(databaseUrl = process.env.DATABASE_URL): BuilderTestStore {
  if (!databaseUrl) throw new Error("Builder functional test persistence is not configured.");
  const sql = neon(databaseUrl);
  const key = (id: string) => `builder-functional-test:${id}`;
  const decode = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value) as BuilderTestSession;
  const store: BuilderTestStore = {
    async get(id) {
      const rows = await sql`select value from companyos.chat_values where key = ${key(id)} and expires_at is null`;
      return rows[0] ? decode(rows[0].value) : undefined;
    },
    async create(session) {
      if (session.revision !== 0 || session.stage !== "prepared") throw new Error("Only a prepared test may be created.");
      await sql`insert into companyos.chat_values(key, value, expires_at)
        values (${key(session.id)}, ${JSON.stringify(session)}::jsonb, null) on conflict (key) do nothing`;
      const existing = await store.get(session.id);
      if (!existing || sha256({ ...existing, revision: 0, stage: "prepared", artifactHash: undefined, testConversation: undefined, testUrl: undefined,
        result: undefined, feedback: undefined, acceptance: undefined, failureDigest: undefined }) !== sha256(session)) throw new Error("Test identity conflicts with a changed candidate or scope.");
      return existing;
    },
    async replace(previous, next) {
      if (previous.id !== next.id || next.revision !== previous.revision + 1) throw new Error("Invalid Builder test revision.");
      const rows = await sql`update companyos.chat_values set value = ${JSON.stringify(next)}::jsonb
        where key = ${key(previous.id)} and expires_at is null and value = ${JSON.stringify(previous)}::jsonb returning key`;
      return rows.length === 1;
    },
  };
  return store;
}
