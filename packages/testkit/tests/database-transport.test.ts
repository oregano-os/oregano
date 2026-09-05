import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { neon } from "@neondatabase/serverless";

const enabled = process.env.RUN_DATABASE_TESTS === "1";
if (process.env.COMPANYOS_REQUIRE_DATABASE_TESTS === "1" && (!enabled || !process.env.DATABASE_URL)) throw new Error("Required database configuration is missing.");

test("the maintained HTTP driver round-trips Postgres types and transaction rollback", { skip: !enabled }, async () => {
  const sql = neon(process.env.DATABASE_URL!);
  const rows = await sql`select ${JSON.stringify({ z: 1, a: [true, null] })}::jsonb as payload,
    ${["a", "b"]}::text[] as names, true as flag, 42::int as count, null::text as absent`;
  assert.deepEqual(rows[0], { payload: { a: [true, null], z: 1 }, names: ["a", "b"], flag: true, count: 42, absent: null });
  await sql`create table if not exists public.transport_probe (id text primary key)`;
  const id = randomUUID();
  await assert.rejects(sql.transaction([sql`insert into public.transport_probe values (${id})`, sql`select 1 / 0`]),
    (error: any) => error.code === "22012");
  assert.equal((await sql`select * from public.transport_probe where id = ${id}`).length, 0);
});

test("the database bridge refuses client-selected connection targets", { skip: !enabled }, async () => {
  const response = await fetch(process.env.COMPANYOS_TEST_SQL_ENDPOINT!, { method: "POST", headers: {
    "Neon-Connection-String": "postgresql://different-user@127.0.0.1/another-database",
  }, body: JSON.stringify({ query: "select 1", params: [] }) });
  assert.equal(response.status, 403);
});
