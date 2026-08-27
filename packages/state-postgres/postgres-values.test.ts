import assert from "node:assert/strict";
import { test } from "node:test";
import { postgresTimestampToIso } from "./postgres-values.ts";

test("Postgres timestamps preserve millisecond precision for Date and string values", () => {
  const timestamp = "2026-08-27T09:15:31.487Z";
  assert.equal(postgresTimestampToIso(new Date(timestamp)), timestamp);
  assert.equal(postgresTimestampToIso(timestamp), timestamp);
  assert.throws(() => postgresTimestampToIso("not-a-timestamp"), /invalid/);
});
