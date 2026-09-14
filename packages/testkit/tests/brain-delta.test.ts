import assert from "node:assert/strict";
import { test } from "node:test";
import { BrainReads } from "../../brain/reads.ts";
import { syncBrain } from "../../brain/sync.ts";
import { sha256 } from "../../runtime/canonical.ts";
import { InMemoryBrainStore } from "../adapter/in-memory-brain.ts";
import { InMemoryCompanyRecordsStore } from "../../records/memory-store.ts";
import { brainConfig, brainFiles, brainFixturePage as page } from "../fixtures/brain.ts";

async function fixture() {
  const scope = { instance_id: "fixture", repository_id: "example/brain" }, store = new InMemoryBrainStore(), leases = new InMemoryCompanyRecordsStore();
  let files: Record<string, string> = structuredClone(brainFiles), n = 1;
  const sync = () => syncBrain({ scope, store, leases, configuration: brainConfig,
    repository: { revision: async () => n.toString(16).padStart(40, "0"), read: async () => files }, now: () => new Date("2030-01-01T00:00:00Z") });
  await sync();
  return { scope, store, reads: new BrainReads(store, scope), update: async (next: Record<string, string>) => { files = next; n++; await sync(); } };
}
const expand = (count: number) => ({ ...brainFiles, ...Object.fromEntries(Array.from({ length: count }, (_, i) => [`brain/topics/topic-${String(i).padStart(3, "0")}.md`, page("topic", `Topic ${i}`, "Synthetic content.")])) });

test("context cursors report actual page updates and deletions, including an alias removed with its page", async () => {
  const f = await fixture();
  await f.update({ ...brainFiles, "brain/people/visitor.md": page("person", "Visitor Example", "A visitor.", "aliases: [Visitor]\n") });
  const context = await f.reads.contextPack({ entities: "Visitor,topics/expansion" });
  const next: Record<string, string> = { ...brainFiles, "brain/topics/expansion.md": brainFiles["brain/topics/expansion.md"].replace("No shared decision yet.", "Reviewed account.") };
  await f.update(next);
  const result = await f.reads.delta({ cursor: context.change_cursor }); assert.equal(result.status, "ok");
  assert.deepEqual(result.changes.map(change => [change.page_id, change.kind]), [["people/visitor", "removed"], ["topics/expansion", "updated"]]);
  assert.equal(result.changes[0].current, null); assert.ok(!JSON.stringify(result.changes).includes("Operations lead."));
  const none = await f.reads.delta({ cursor: result.next_cursor! }); assert.equal(none.status, "ok"); assert.deepEqual(none.changes, []);
});

test("equal timestamps and bounded pagination preserve every entry and freeze the upper watermark", async () => {
  const f = await fixture(), initial = await f.reads.delta({}); await f.update(expand(107));
  const first = await f.reads.delta({ cursor: initial.next_cursor!, budget_tokens: 200 });
  assert.equal(first.status, "ok"); assert.equal(first.has_more, true); assert.ok(first.changes.length > 0);
  await f.update({ ...expand(107), "brain/topics/later.md": page("topic", "Later", "Arrived during continuation.") });
  let current = first; const entries = [...first.changes];
  for (let i = 0; current.has_more && i < 200; i++) {
    const next = await f.reads.delta({ cursor: current.next_cursor!, budget_tokens: 8000 });
    assert.equal(next.status, "ok"); assert.ok(next.budget_used <= 8000);
    entries.push(...next.changes); current = next;
  }
  assert.equal(current.has_more, false); assert.equal(entries.length, 107); assert.equal(new Set(entries.map(change => change.change_id)).size, 107);
  assert.ok(!entries.some(change => change.page_id === "topics/later"));
  const subsequent = await f.reads.delta({ cursor: current.next_cursor! }); assert.deepEqual(subsequent.changes.map(change => change.page_id), ["topics/later"]);
  const replay = await f.reads.delta({ cursor: first.next_cursor!, budget_tokens: 8000 });
  assert.deepEqual(replay.changes.map(change => change.change_id), entries.slice(first.changes.length, first.changes.length + replay.changes.length).map(change => change.change_id));
});

test("a tiny budget leaves the first undelivered entry available and gives the minimum needed", async () => {
  const f = await fixture(), initial = await f.reads.delta({}); await f.update(expand(1));
  const tiny = await f.reads.delta({ cursor: initial.next_cursor!, budget_tokens: 1 });
  assert.equal(tiny.status, "ok"); assert.equal(tiny.has_more, true); assert.equal(tiny.changes.length, 0); assert.equal(tiny.budget_used, 0);
  assert.ok("minimum_budget_tokens" in tiny && tiny.minimum_budget_tokens! > 1);
  const result = await f.reads.delta({ cursor: tiny.next_cursor!, budget_tokens: 8000 }); assert.equal(result.changes.length, 1);
});

test("scope changes, foreign instances, malformed cursors and rebuilt history require refresh", async () => {
  const f = await fixture(), context = await f.reads.contextPack({ entities: "Alex" });
  const alias = await f.reads.delta({ cursor: context.change_cursor, entities: "people/alex" }); assert.equal(alias.status, "ok");
  assert.equal((await f.reads.delta({ cursor: context.change_cursor, entities: "Sam Example" })).status, "refresh_required");
  assert.equal((await f.reads.delta({ cursor: "broken" })).status, "refresh_required");
  const original = JSON.parse(Buffer.from(context.change_cursor, "base64url").toString());
  for (const mutate of [(c: any) => c.scope = sha256({ instance_id: "other", repository_id: f.scope.repository_id }),
    (c: any) => c.generation = "other", (c: any) => c.after = 999, (c: any) => c.entities.push("someone-else"), (c: any) => c.selected.push("topics/expansion")]) {
    const cursor = structuredClone(original); mutate(cursor);
    assert.equal((await f.reads.delta({ cursor: Buffer.from(JSON.stringify(cursor)).toString("base64url") })).status, "refresh_required");
  }
  f.store.snapshots.get(f.store.key(f.scope))!.revision.generation = "rebuilt";
  assert.equal((await f.reads.delta({ cursor: context.change_cursor })).status, "refresh_required");
});

test("since uses inclusive index time, unscoped reads include creates and invalid timestamps are rejected", async () => {
  const f = await fixture(); await f.update(expand(2));
  const result = await f.reads.delta({ since: "2030-01-01T00:00:00Z", budget_tokens: 8000 }); assert.equal(result.changes.length, 7);
  assert.equal((await f.reads.delta({ since: "2030-01-01T00:00:01Z" })).changes.length, 0);
  await assert.rejects(f.reads.delta({ since: "2030-01-01" }), /timezone/);
  await assert.rejects(f.reads.delta({ since: "2030-01-01T00:00:00Z", cursor: result.next_cursor! }), /not both/);
  const unknown = await f.reads.contextPack({ entities: "Missing" });
  assert.equal((await f.reads.delta({ cursor: unknown.change_cursor })).status, "refresh_required");
});

test("a concurrent synchronization during delta retries a consistent snapshot without dropping changes", async () => {
  const f = await fixture(), initial = await f.reads.delta({}); await f.update(expand(2));
  const original = f.store.changes.bind(f.store); let once = true;
  f.store.changes = async (...args) => { const rows = await original(...args); if (once) { once = false; await f.update(expand(3)); } return rows; };
  const result = await f.reads.delta({ cursor: initial.next_cursor! }); assert.equal(result.changes.length, 3);
  assert.equal(result.has_more, false);
});
