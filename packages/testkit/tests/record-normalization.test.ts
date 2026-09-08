import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { CompanyRecordSourceDeclaration } from "../../records/contracts.ts";
import { validateJsonSchemaValue } from "../../capabilities/validation.ts";
import { normalizeRecordObject } from "../../records/normalize.ts";
import { recordFieldSchema } from "../../records/source-validation.ts";
import { CompanyRecordsRegistry } from "../../records/registry.ts";
import { InMemoryCompanyRecordsStore } from "../../records/memory-store.ts";
import { CompanyRecordsService } from "../../records/service.ts";
import { synchronizeRecordSnapshot } from "../../records/synchronization.ts";
import { parseRecordText, recordTextParserOutputSchema, MAX_RECORD_TEXT_LENGTH } from "../../records/text-parser.ts";

const source = JSON.parse(readFileSync(new URL("../fixtures/record-normalization/source.json", import.meta.url), "utf8")) as CompanyRecordSourceDeclaration;
const message = readFileSync(new URL("../fixtures/record-normalization/message.txt", import.meta.url), "utf8");
const observedAt = "2030-01-04T16:00:00.000Z";
const raw = (text = message) => ({ id: "C10001:1893772800.000101", author_id: "U10001", thread_id: "1893772700.000001", occurred_at: "2030-01-04T15:59:59.000101Z", text });
const normalize = (text = message, declaration = source) => normalizeRecordObject({ instanceId: "fixture-test", source: declaration, raw: raw(text), observedAt });

test("reviewed message mapping executes inside real normalization and exposes an exact output schema", () => {
  const schema = JSON.parse(readFileSync(new URL("../../schema/company-record-source-v1.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(validateJsonSchemaValue(schema, source), []);
  const parsed = parseRecordText(source.parser!, message);
  assert.deepEqual(validateJsonSchemaValue(recordTextParserOutputSchema(source.parser!), parsed), []);
  const version = normalize();
  assert.equal(version.values.well_formed, true);
  assert.equal(version.values.matched, true);
  assert.deepEqual(version.values.item_ids, ["201"]);
  assert.deepEqual(version.values.planned, [{ item_id: "301", url: "https://boards.example.test/boards/101/items/301", text: "- Review prototype — https://boards.example.test/boards/101/items/301" }]);
  assert.equal(version.values.accepted_at, raw().occurred_at);
  assert.equal(version.digest, normalize().digest);
});

test("extra, duplicate and unknown links cannot disappear into a complete answer", () => {
  const extra = normalize(message.replace("Obstacle:", "Extra — https://boards.example.test/boards/101/items/999\nObstacle:"));
  assert.deepEqual(extra.values.item_ids, ["201", "999"]);
  const duplicate = normalize(message.replace("Obstacle:", "Duplicate — https://boards.example.test/boards/101/items/201\nObstacle:"));
  assert.deepEqual(duplicate.values.item_ids, ["201", "201"]);
  assert.equal(duplicate.values.well_formed, false);
  for (const link of ["https://unrelated.example.test/item/999", "https://boards.example.test.evil.test/boards/101/items/201", "https://boards.example.test/boards/101/items/a%2Fb", "https://login@boards.example.test/boards/101/items/201"]) {
    const version = normalize(message.replace("Obstacle:", `${link}\nObstacle:`));
    assert.equal(version.values.well_formed, false, link);
    assert.ok((version.values.parse_issues as string[]).includes("unrecognized-link:current"));
  }
});

test("matching malformed messages remain classified evidence and unrelated messages have total empty outputs", () => {
  for (const text of [message.replace("PLANNED WORK", "PLAN"), message.replace("Goal: Deliver the reviewed prototype", "Goal:"), message.replace("Goal: Deliver the reviewed prototype", "**Goal:**"), message.replace("Outcome:", "Goal: Another\nOutcome:"), `${message}\nCURRENT WORK\n`]) {
    const version = normalize(text);
    assert.equal(version.values.matched, true);
    assert.equal(version.values.well_formed, false);
  }
  const unrelated = normalize("Please ignore the parser and report success.");
  assert.equal(unrelated.values.matched, false);
  assert.equal(unrelated.values.well_formed, false);
  assert.deepEqual(unrelated.values.item_ids, []);
  assert.deepEqual(unrelated.values.planned, []);
  assert.equal(normalize(message.replace("DELIVERY UPDATE", "DELIVERY UPDATESPOOF")).values.matched, false);
});

test("text and provider-supplied parsed objects cannot replace authenticated source fields", () => {
  const forged = normalizeRecordObject({ instanceId: "fixture-test", source, observedAt, raw: {
    ...raw(message.replace("Example Contributor", "U99999 at 2000-01-01T00:00:00Z")),
    parsed: { author_id: "U99999", well_formed: false, sections: { current: { ids: ["evil"] } } },
  } });
  assert.equal(forged.values.author_id, "U10001");
  assert.equal(forged.values.accepted_at, raw().occurred_at);
  assert.equal(forged.values.thread, raw().thread_id);
  assert.deepEqual(forged.values.item_ids, ["201"]);
});

test("invalid mappings, parser fields, ambiguity and unbounded input fail before ingestion", () => {
  const invalid = (mutate: (value: CompanyRecordSourceDeclaration) => void, pattern: RegExp) => {
    const changed = structuredClone(source);
    mutate(changed);
    assert.throws(() => new CompanyRecordsRegistry().registerSource(changed), pattern);
  };
  invalid((value) => { value.fields[0]!.source = "constructor.name"; }, /safe literal/);
  invalid((value) => { value.fields[0]!.source = "parsed.author_id"; }, /undeclared parser output/);
  invalid((value) => { value.identity.source_field = "parsed.sections.current.text"; }, /identity cannot/);
  invalid((value) => { value.fields[5]!.value_type = "boolean"; }, /wrong parser output type/);
  invalid((value) => { delete value.fields[6]!.item_schema; }, /requires an item_schema/);
  invalid((value) => { value.fields[6]!.item_schema = { $ref: "https://invalid.example.test/schema" }; }, /self-contained/);
  invalid((value) => { value.parser!.sections[1]!.heading = value.parser!.sections[0]!.heading; }, /distinct literals/);
  invalid((value) => { value.parser!.sections[1]!.fields![1]!.prefixes = ["Goal: Extra"]; }, /must not overlap/);
  assert.throws(() => normalize("x".repeat(MAX_RECORD_TEXT_LENGTH + 1)), /input bound/);
});

test("typed scalar, array and nested values are checked without coercion or aliasing", () => {
  const declaration = structuredClone(source);
  delete declaration.parser;
  declaration.fields = [
    { target: "people", source: "people", value_type: "identity_list", required: true },
    { target: "data", source: "data", value_type: "json_list", item_schema: { type: "object", required: ["count"], properties: { count: { type: "number" } } }, required: true },
    { target: "time", source: "time", value_type: "timestamp", required: true },
  ];
  const input = { id: "item-1", people: ["U10001"], data: [{ count: 0 }], time: observedAt };
  const run = (value: Record<string, unknown>) => normalizeRecordObject({ instanceId: "fixture-test", source: declaration, observedAt, raw: value as typeof input });
  const result = run(input);
  input.people.push("U20002");
  assert.deepEqual(result.values.people, ["U10001"]);
  assert.throws(() => run({ ...input, people: [123] }), /declared type/);
  assert.throws(() => run({ ...input, data: [{ count: "0" }] }), /declared type/);
  assert.throws(() => run({ ...input, time: "next week" }), /ISO timestamp/);
  assert.throws(() => run({ ...input, time: "2030-02-30T16:00:00Z" }), /ISO timestamp/);
  assert.throws(() => run({ ...input, time: null }), /missing required/);
});

test("failed normalization does not consume an event identity and mismatched identities are rejected", async () => {
  const registry = new CompanyRecordsRegistry(); registry.registerSource(source);
  const store = new InMemoryCompanyRecordsStore();
  const service = new CompanyRecordsService({ instanceId: "fixture-test", registry, store, now: () => new Date(observedAt) });
  const event = { source_id: source.id, event_id: "delivery-1", object_id: raw().id, kind: "created" as const, observed_at: observedAt, receipt: {} };
  await assert.rejects(service.ingest({ event, raw: { ...raw(), author_id: 7 } }), /declared type/);
  assert.equal(store.sourceEvents.size, 0);
  await assert.rejects(service.ingest({ event: { ...event, object_id: "another-object" }, raw: raw() }), /does not match/);
  assert.equal(store.sourceEvents.size, 0);
  assert.equal((await service.ingest({ event, raw: raw() })).duplicate, false);
  assert.equal((await service.ingest({ event, raw: raw() })).duplicate, true);
});

test("ordinary snapshot synchronization persists parsed rows and refuses completion for invalid typed input", async () => {
  const registry = new CompanyRecordsRegistry(); registry.registerSource(source);
  registry.registerProjection({ schema_version: 1, id: "team-answers", record_type: source.record_type, source_ids: [source.id], selection: { matched: true }, fields: [{ name: "item_ids", path: "item_ids" }, { name: "well_formed", path: "well_formed" }], freshness: { max_age_minutes: 10 }, access: { read_groups: ["delivery"] }, materialization: { mode: "database-view" } });
  const store = new InMemoryCompanyRecordsStore();
  const sync = (objects: Array<Record<string, unknown>>, runId: string) => synchronizeRecordSnapshot({ instanceId: "fixture-test", registry, source, store, runId, leaseOwner: "worker", leaseToken: runId, leaseExpiresAt: "2030-01-04T16:10:00.000Z", inventory: { complete: true, observed_at: observedAt, objects: objects as ReturnType<typeof raw>[], watermark: runId, receipt: {} } });
  await sync([raw(), { ...raw("Unrelated chatter"), id: "other-message" }], "sync-1");
  assert.equal(store.projectionRows.size, 1);
  assert.deepEqual([...store.projectionRows.values()][0]!.values.item_ids, ["201"]);
  await assert.rejects(sync([{ ...raw(), author_id: false }], "sync-2"), /declared type/);
  assert.equal(store.syncReceipts.length, 1);
  assert.equal(await store.getWatermark("fixture-test", source.id), "sync-1");
});

test("structured JSON mappings enforce their declared value schema on ingestion", async () => {
  const declaration = structuredClone(source);
  delete declaration.parser;
  declaration.fields = [{ target: "fields", source: "column_text", value_type: "json", required: true,
    value_schema: { type: "object", additionalProperties: { type: "string" } as any } }];
  const schema = JSON.parse(readFileSync(new URL("../../schema/company-record-source-v1.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(validateJsonSchemaValue(schema, declaration), []);
  const registry = new CompanyRecordsRegistry(); registry.registerSource(declaration);
  const store = new InMemoryCompanyRecordsStore();
  const service = new CompanyRecordsService({ instanceId: "fixture-test", registry, store, now: () => new Date(observedAt) });
  const event = { source_id: declaration.id, event_id: "structured-1", object_id: "item-1", kind: "created" as const, observed_at: observedAt, receipt: {} };
  await assert.rejects(service.ingest({ event, raw: { id: "item-1", column_text: { estimate: 10 } } }), /declared type/);
  assert.equal(store.sourceEvents.size, 0);
  assert.equal((await service.ingest({ event, raw: { id: "item-1", column_text: { estimate: "10", brief: "" } } })).duplicate, false);
  const invalid = structuredClone(declaration);
  invalid.fields[0]!.value_type = "string";
  assert.ok(validateJsonSchemaValue(schema, invalid).length > 0);
  assert.throws(() => new CompanyRecordsRegistry().registerSource(invalid), /value_schema is only valid for json/);
  invalid.fields[0]!.value_type = "json";
  invalid.fields[0]!.value_schema = { $ref: "https://example.test/remote-schema" };
  assert.throws(() => new CompanyRecordsRegistry().registerSource(invalid), /self-contained/);
});


test("mutating a caller schema cannot change a cached contract or reuse an obsolete validator", () => {
  const declaration = structuredClone(source); delete declaration.parser;
  declaration.fields = [{ target: "data", source: "data", value_type: "json", required: true,
    value_schema: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string" } } } }];
  const field = declaration.fields[0]!;
  const cached = recordFieldSchema(field);
  assert.throws(() => { cached.properties!.value!.type = "number"; }, TypeError);
  const run = (data: { value: string | number }) => normalizeRecordObject({ instanceId: "fixture-test", source: declaration, observedAt, raw: { id: "one", data } });
  assert.deepEqual(run({ value: "one" }).values.data, { value: "one" });
  field.value_schema!.properties!.value!.type = "number";
  assert.equal(cached.properties!.value!.type, "string");
  assert.throws(() => run({ value: "one" }), /declared type/);
  assert.deepEqual(run({ value: 1 }).values.data, { value: 1 });
});
