import assert from "node:assert/strict";
import { test } from "node:test";
import { BrainReads } from "../../brain/reads.ts";
import { syncBrain } from "../../brain/sync.ts";
import { synthesizeBrain } from "../../brain/synthesis.ts";
import { InMemoryBrainStore } from "../adapter/in-memory-brain.ts";
import { InMemoryCompanyRecordsStore } from "../../records/memory-store.ts";
import { brainConfig, brainFiles } from "../fixtures/brain.ts";
import { BrainError } from "../../brain/contracts.ts";

async function fixture() {
  const scope = { instance_id: "fixture-instance", repository_id: "example/brain" };
  const store = new InMemoryBrainStore(), leases = new InMemoryCompanyRecordsStore();
  let commit = "1".repeat(40), files = { ...brainFiles };
  const sync = () => syncBrain({ scope, store, leases, configuration: brainConfig, repository: {
    revision: async () => commit, read: async () => files }, now: () => new Date("2030-01-01T00:00:00Z") });
  await sync();
  return { scope, store, leases, sync, reads: new BrainReads(store, scope), change: (next: typeof files) => { files = next; commit = "2".repeat(40); } };
}

test("unchanged synchronization preserves its cursor and invalid pages preserve the old index", async () => {
  const f = await fixture(), before = await f.store.revision(f.scope);
  assert.equal((await f.sync()).status, "unchanged");
  assert.deepEqual(await f.store.revision(f.scope), before);
  f.change({ ...brainFiles, "brain/topics/expansion.md": "Broken frontmatter" });
  assert.equal((await f.sync()).status, "invalid"); assert.deepEqual(await f.store.revision(f.scope), before);
  assert.equal(f.leases.syncLeases.size, 0);
});

test("projection publication removes deleted pages/Takes and records metadata without deleted text", async () => {
  const f = await fixture(), files = { ...brainFiles };
  delete (files as Record<string, string>)["brain/topics/expansion.md"];
  f.change(files); assert.equal((await f.sync()).status, "indexed");
  assert.equal((await f.reads.entity("topics/expansion")).found, false);
  assert.equal((await f.reads.recall({ query: "branch" })).hits.filter(hit => hit.take).length, 0);
  assert.deepEqual(f.store.publications.at(-1)?.changes, [{ slug: "topics/expansion", kind: "removed" }]);
});

test("reads isolate instances, expose attributed active Takes and calculate backlinks", async () => {
  const f = await fixture();
  const entity = await f.reads.entity("Alex"); assert.equal(entity.found, true);
  if (entity.found) assert.equal(entity.outgoing[0].resolved, "companies/example");
  const hits = (await f.reads.recall({ query: "branch" })).hits;
  assert.deepEqual(hits.filter(hit => hit.take).map(hit => hit.take!.row_num).sort(), [4, 7]);
  assert.ok(hits.every(hit => !hit.excerpt.includes("Open the branch now")));
  const source = await f.reads.entity("sources/review"); assert.ok(source.found && source.backlinks.length >= 3);
  await assert.rejects(new BrainReads(f.store, { ...f.scope, instance_id: "other" }).entity("Alex"), /indexed revision/);
});

test("starting context and cursor share a stable snapshot despite a concurrent update", async () => {
  const f = await fixture();
  const original = f.store.find.bind(f.store); let changed = false;
  f.store.find = async (...args) => {
    const found = await original(...args);
    if (!changed) {
      changed = true;
      f.change({ ...brainFiles, "brain/topics/expansion.md": brainFiles["brain/topics/expansion.md"].replace("No shared decision yet.", "Updated current account.") });
      await f.sync();
    }
    return found;
  };
  const context = await f.reads.contextPack({ entities: "topics/expansion", budget_tokens: 2000 });
  assert.ok(context.text.includes("Updated current account.")); assert.ok(!context.text.includes("No shared decision yet."));
  assert.ok(!context.text.includes("Open the branch now")); assert.ok(context.text.includes('"holder":"people/sam"'));
  const cursor = JSON.parse(Buffer.from(context.change_cursor, "base64url").toString());
  assert.equal(cursor.after, context.indexed_revision.sequence); assert.equal(cursor.generation, context.indexed_revision.generation);
  assert.ok(context.text.length <= 8000); assert.ok(context.budget_used <= 2000);
  const tiny = await f.reads.contextPack({ entities: "topics/expansion", budget_tokens: 1 }); assert.ok(tiny.omissions.length > 0);
  await assert.rejects(f.reads.contextPack({ entities: "a,b,c,d,e,f,g,h,i" }), /eight/);
});

test("synchronization cannot publish after losing its lease or an expected revision", async () => {
  const f = await fixture(), before = await f.store.revision(f.scope);
  f.store.leaseValid = () => false;
  f.change({ ...brainFiles, "brain/people/alex.md": brainFiles["brain/people/alex.md"].replace("Operations lead.", "Operations contributor.") });
  await assert.rejects(f.sync(), /lease changed/); assert.deepEqual(await f.store.revision(f.scope), before);
  f.store.leaseValid = () => true;
  assert.equal(await f.store.publish({ ...f.store.publications[0], expected: undefined }), false);
});

test("synthesis makes one bounded call, preserves evidence and validates active row citations", async () => {
  const f = await fixture(); let calls = 0;
  const model = { prepare: () => async (request: { instructions: string; data: string; modelTask: string }) => {
    calls++; assert.equal(request.modelTask, "brain.synthesize");
    assert.ok(request.instructions.includes("surface BOTH")); assert.ok(request.instructions.includes("weight < 0.5"));
    const data = JSON.parse(request.data);
    assert.ok(!request.data.includes("Open the branch now"), "Inactive claims must not leak through derived link contexts either");
    assert.ok(data.pages.every((page: { takes: { active: boolean }[]; search_text: string }) => page.takes.every(take => take.active) && !page.search_text.includes("Open the branch now")));
    return { text: JSON.stringify({ answer: "Alex favors delay [topics/expansion#4]. Sam has a weak hunch supporting expansion [topics/expansion#7].", citations: [
      { page_slug: "topics/expansion", row_num: 4, citation_index: 1 }, { page_slug: "topics/expansion", row_num: 7, citation_index: 2 }], gaps: ["No shared decision is recorded."] }),
      evidence: { finish_reason: "stop", model_execution: { model: "synthetic-model", inputTokens: 100, outputTokens: 40 } } };
  } };
  const result = await synthesizeBrain(f.reads, "What are the views on branch expansion?", "analyst", model);
  assert.equal(result.synthesis_status, "ok"); assert.equal(calls, 1); assert.equal(result.sources.length, 2);
  assert.equal(f.store.publications.length, 1, "Synthesis must not publish knowledge");
  const invalid = await synthesizeBrain(f.reads, "branch", "analyst", { prepare: () => async () => ({ text: JSON.stringify({ answer: "Stale claim [topics/expansion#1].", citations: [{ page_slug: "topics/expansion", row_num: 1, citation_index: 1 }], gaps: [] }), evidence: { finish_reason: "stop" } }) });
  assert.equal(invalid.synthesis_status, "extractive_fallback"); assert.ok(!invalid.answer.includes("Open the branch now"));
});

test("missing model, empty retrieval, broken retrieval and compose failure remain distinct", async () => {
  const f = await fixture();
  await assert.rejects(synthesizeBrain(f.reads, "branch", "analyst"), /configured language model/);
  await assert.rejects(synthesizeBrain(f.reads, "branch", "analyst", { prepare: () => { throw new BrainError("model_unavailable", "Missing model configuration"); } }), /Missing model/);
  let calls = 0;
  const model = { prepare: () => async () => { calls++; throw new Error("Synthetic provider failure"); } };
  assert.equal((await synthesizeBrain(f.reads, "zzzznotpresent", "analyst", model)).synthesis_status, "insufficient_evidence"); assert.equal(calls, 0);
  assert.equal((await synthesizeBrain(f.reads, "branch", "analyst", model)).synthesis_status, "extractive_fallback"); assert.equal(calls, 1);
  f.store.search = async () => { throw new Error("Synthetic store outage"); };
  await assert.rejects(synthesizeBrain(f.reads, "branch", "analyst", model), /store outage/);
});
