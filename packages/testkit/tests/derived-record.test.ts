import assert from "node:assert/strict";
import { test } from "node:test";
import { createDerivedRecord } from "../../records/derived-record.ts";

test("a Derived Record keeps generic lineage while its payload remains domain-owned", () => {
  const record = createDerivedRecord({
    domain: "sprint",
    type: "submission",
    record_id: "submission-1",
    occurred_at: "2030-01-04T15:00:00.000Z",
    subject_id: "participant-1",
    source: {
      projection_id: "conversation-messages",
      record_id: "message-1",
      source_version_id: "version-1",
    },
    references: [{ relation: "mentions", record_type: "work-item", record_id: "item-1", source_version_id: "item-version-1" }],
    payload: { complete: true, goal: "Synthetic goal" },
  });
  assert.equal(record.schema_version, 1);
  assert.equal(record.domain, "sprint");
  assert.equal(record.type, "submission");
  assert.match(record.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(record.payload, { complete: true, goal: "Synthetic goal" });
});

test("a Derived Record refuses duplicate or malformed references", () => {
  assert.throws(() => createDerivedRecord({
    domain: "sprint",
    type: "submission",
    record_id: "submission-1",
    occurred_at: "2030-01-04T15:00:00.000Z",
    source: { projection_id: "messages", record_id: "message-1", source_version_id: "version-1" },
    references: [
      { relation: "mentions", record_type: "work-item", record_id: "item-1" },
      { relation: "mentions", record_type: "work-item", record_id: "item-1" },
    ],
    payload: {},
  }), /unique/);
});
