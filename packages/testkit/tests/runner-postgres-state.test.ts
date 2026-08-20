import assert from "node:assert/strict";
import { test } from "node:test";
import { decodePostgresJsonValue } from "../../runner-vercel/src/lib/postgres-chat-state.ts";

test("the Postgres Chat state decoder preserves JSONB string values", () => {
  assert.equal(decodePostgresJsonValue<string>("U0BK84UUM70"), "U0BK84UUM70");
});

test("the Postgres Chat state decoder accepts serialized JSON for driver compatibility", () => {
  assert.deepEqual(
    decodePostgresJsonValue<{ role: string; content: string }>(
      '{"role":"user","content":"hello"}',
    ),
    { role: "user", content: "hello" },
  );
});
