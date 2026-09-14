import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryStateStore } from "../../runtime/memory-state.ts";
import { freezeTranscriptCohort, validateTranscriptSelectionPolicy, type TranscriptCandidate, type TranscriptSelectionPolicy } from "../../brain/import-policy.ts";

const policy: TranscriptSelectionPolicy = { mode: "bounded", max_transcripts: 4, meeting_date: { start_at: null, end_at: null } };
const candidate = (id: string, date = "2030-04-09T10:00:00Z"): TranscriptCandidate => ({ identity: `provider:transcript:${id}`, source_version: `version:${id}`, meeting_start_at: date, origin: "provider", finished: true });
const fixture = () => ({ store: new InMemoryStateStore(), instanceId: "example-instance", importId: "knowledge-import", runId: "initial-run", policy,
  now: "2030-04-10T10:00:00Z", candidates: [candidate("b"), candidate("a"), candidate("c"), candidate("d"), candidate("e")],
  reserved: [{ ...candidate("seed", "2029-12-01T10:00:00Z"), identity: "local:seed:sha256", origin: "local" as const }],
  inventoryComplete: true, availableFrom: "2030-03-11T00:00:00Z" });

test("one global cumulative cohort reserves prior samples then selects newest finished identities deterministically", async () => {
  const f = fixture(); f.candidates.push(candidate("latest", "2030-04-10T09:00:00Z"));
  f.candidates.push({ ...candidate("unfinished"), finished: false });
  f.candidates.push(candidate("future", "2030-04-11T00:00:00Z"));
  const cohort = await freezeTranscriptCohort(f);
  assert.deepEqual(cohort.admitted.map(x => x.identity), ["local:seed:sha256", "provider:transcript:latest", "provider:transcript:a", "provider:transcript:b"]);
  assert.equal(cohort.cumulative_count, 4); assert.equal(cohort.effective_dates.end_at, "2030-04-10T10:00:00.000Z");
  const saved = structuredClone(cohort);
  cohort.admitted.pop();
  assert.deepEqual(await freezeTranscriptCohort({ ...f, candidates: [candidate("newer", "2030-04-12T10:00:00Z")], now: "2030-04-13T00:00:00Z", runId: "timer-or-new-deployment" }), saved);
});

test("smaller frozen discovery does not refill on a timer, retry, other account or deployment", async () => {
  const f = fixture();
  const original = await freezeTranscriptCohort({ ...f, candidates: [candidate("a")] });
  assert.equal(original.cumulative_count, 2);
  for (const runId of ["timer", "retry", "another-provider-account", "new-deployment"])
    assert.deepEqual(await freezeTranscriptCohort({ ...f, runId }), original);
});

test("Workspace date and quantity expansion adds only remaining slots and preserves the first cohort", async () => {
  const f = fixture();
  const first = await freezeTranscriptCohort(f);
  const extension = { ...policy, max_transcripts: 6, meeting_date: { start_at: "2030-03-12T00:00:00Z", end_at: null } };
  const second = await freezeTranscriptCohort({ ...f, policy: extension, runId: "extension-run" });
  assert.equal(second.cumulative_count, 6);
  assert.deepEqual(second.admitted.map(x => x.identity), ["provider:transcript:d", "provider:transcript:e"]);
  assert.deepEqual(second.already_admitted_outside_range, ["local:seed:sha256"]);
  assert.deepEqual(await freezeTranscriptCohort(f), first);
  const again = await freezeTranscriptCohort({ ...f, policy: { ...extension, meeting_date: { start_at: "2030-03-11T00:00:00Z", end_at: null } }, runId: "date-only-change", candidates: [...f.candidates, candidate("older", "2030-03-11T12:00:00Z")] });
  assert.equal(again.cumulative_count, 6); assert.deepEqual(again.admitted, []);
});

test("lower ceilings, changed running policy and unavailable history never reset progress", async () => {
  const f = fixture(); const first = await freezeTranscriptCohort(f);
  await assert.rejects(freezeTranscriptCohort({ ...f, policy: { ...policy, max_transcripts: 3 }, runId: "lower" }), /already admitted/);
  await assert.rejects(freezeTranscriptCohort({ ...f, policy: { ...policy, max_transcripts: 6 } }), /running transcript cohort/);
  await assert.rejects(freezeTranscriptCohort({ ...f, policy: { ...policy, meeting_date: { start_at: "2030-01-01T00:00:00Z", end_at: null } }, runId: "old-history" }), /history/);
  assert.deepEqual(await freezeTranscriptCohort(f), first);
});

test("inclusive start, exclusive end and explicit unknown dates remain visible", async () => {
  const f = fixture();
  const cohort = await freezeTranscriptCohort({ ...f, policy: { ...policy, meeting_date: { start_at: "2030-04-01T02:00:00+02:00", end_at: "2030-04-09T10:00:00Z" } },
    candidates: [candidate("start", "2030-04-01T00:00:00Z"), candidate("before", "2030-03-31T23:59:59Z"), candidate("end"), { ...candidate("unknown"), meeting_start_at: null }] });
  assert.deepEqual(cohort.admitted.map(x => x.identity), ["local:seed:sha256", "provider:transcript:start"]);
  assert.deepEqual(cohort.excluded_unknown_date, ["provider:transcript:unknown"]);
  assert.deepEqual(cohort.already_admitted_outside_range, ["local:seed:sha256"]);
});

test("parallel invocations and a lost setup result reuse one atomic cohort", async () => {
  const f = fixture();
  const cohorts = await Promise.all(Array.from({ length: 8 }, (_, i) => freezeTranscriptCohort({ ...f, runId: `parallel-${i}` })));
  assert.equal(new Set(cohorts.map(x => x.id)).size, 1);
  assert.equal(new Set(cohorts.map(x => x.run_id)).size, 1);
  const effect = [...f.store.effects.values()][0];
  assert.equal((effect.evidence as { cohorts: unknown[] }).cohorts.length, 1);
  assert.deepEqual(await freezeTranscriptCohort(f), cohorts[0]);
});

test("discovery incompleteness and contradictory provider identity fail without admitting a source", async () => {
  const f = fixture();
  await assert.rejects(freezeTranscriptCohort({ ...f, inventoryComplete: false }), /incomplete/);
  await assert.rejects(freezeTranscriptCohort({ ...f, candidates: [candidate("a"), { ...candidate("a"), source_version: "another-version" }] }), /conflicting versions/);
  const cohort = await freezeTranscriptCohort({ ...f, candidates: [candidate("a"), candidate("a")] });
  assert.equal(cohort.cumulative_count, 2);
});

test("policy rejects implicit timezones, future windows and an overfull seed reservation", async () => {
  for (const raw of [{ ...policy, max_transcripts: 0 }, { ...policy, mode: "continuous" }, { ...policy, max_transcripts: 4.5 },
    { ...policy, meeting_date: { start_at: "2030-04-01", end_at: null } }, { ...policy, meeting_date: { start_at: "2030-04-01T10:00:00", end_at: null } },
    { ...policy, secret: "not-config" }, { ...policy, meeting_date: { start_at: "2030-04-02T00:00:00Z", end_at: "2030-04-01T00:00:00Z" } }]) assert.throws(() => validateTranscriptSelectionPolicy(raw));
  const f = fixture();
  await assert.rejects(freezeTranscriptCohort({ ...f, policy: { ...policy, max_transcripts: 1 }, reserved: [...f.reserved, { ...f.reserved[0], identity: "local:other" }] }), /samples exceed/);
  await assert.rejects(freezeTranscriptCohort({ ...f, policy: { ...policy, meeting_date: { start_at: null, end_at: "2031-01-01T00:00:00Z" } } }), /setup time/);
});

test("a previous ceiling cannot be reactivated below cumulative admissions or absorb new local samples", async () => {
  const f = fixture(); const first = await freezeTranscriptCohort(f);
  await freezeTranscriptCohort({ ...f, policy: { ...policy, max_transcripts: 6 }, runId: "extension" });
  await assert.rejects(freezeTranscriptCohort({ ...f, runId: "reactivate-old-ceiling" }), /already admitted/);
  assert.deepEqual(await freezeTranscriptCohort(f), first, "The original in-flight run keeps its own frozen policy");
  await assert.rejects(freezeTranscriptCohort({ ...f, reserved: [...f.reserved, { ...f.reserved[0], identity: "local:unplanned" }] }), /already frozen/);
  for (const value of ["2030-02-30T00:00:00Z", "2030-04-01T24:00:00Z"])
    assert.throws(() => validateTranscriptSelectionPolicy({ ...policy, meeting_date: { start_at: value, end_at: null } }));
});
