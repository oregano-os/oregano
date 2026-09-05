import assert from "node:assert/strict";
import { test } from "node:test";
import { decodePostgresJsonValue } from "../../runner-vercel/src/lib/postgres-chat-state.ts";
import { durableTimerPayloadIdentity } from "../../state-postgres/durable-timer-store.ts";

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

test("the Postgres durable timer store compares JSONB payload identity canonically", () => {
  const scheduled = {
    sprint_id: "fixture-sprint",
    instant: "2030-01-04T15:30:00.000Z",
    moment: "reminder",
    schedule_version: "a".repeat(64),
  };
  const jsonbRoundTrip = JSON.parse(
    '{"moment":"reminder","instant":"2030-01-04T15:30:00.000Z","sprint_id":"fixture-sprint","schedule_version":"'
      + "a".repeat(64)
      + '"}',
  );

  assert.equal(durableTimerPayloadIdentity(jsonbRoundTrip), durableTimerPayloadIdentity(scheduled));
  assert.notEqual(
    durableTimerPayloadIdentity({ ...jsonbRoundTrip, moment: "chase" }),
    durableTimerPayloadIdentity(scheduled),
  );
});
