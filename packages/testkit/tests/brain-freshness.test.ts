import assert from "node:assert/strict";
import { test } from "node:test";
import { BrainFreshness } from "../../brain/freshness.ts";
import { parseBrainRepositoryBinding, parseBrainFreshness } from "../../brain/repository-binding.ts";
import { InMemoryDurableTimerStore } from "../../runtime/memory-durable-timers.ts";
import { DurableTimerService } from "../../runtime/durable-timers.ts";

function fixture() {
  const store = new InMemoryDurableTimerStore(), scope = { instance_id: "fixture", repository_id: "example/brain" };
  const timers = new DurableTimerService({ store, instanceId: scope.instance_id });
  let instant = new Date("2030-01-01T00:00:00Z"); const stats = { syncs: 0, fail: false };
  const options = { timers, scope, bindingDigest: "b".repeat(64), configurationDigest: "c".repeat(64), intervalSeconds: 300, now: () => instant,
    sync: async () => { stats.syncs++; if (stats.fail) throw new Error("Private source failure text"); return { status: "indexed", diagnostics: [],
      indexed_revision: { generation: "fixture", sequence: 1, configuration_digest: "c".repeat(64), git_commit: "a".repeat(40), indexed_at: instant.toISOString() } }; } };
  return { store, timers, options, stats, service: new BrainFreshness(options), advance: (seconds: number) => { instant = new Date(instant.getTime() + seconds * 1000); } };
}

test("push deliveries deduplicate across time and coalesce with the existing periodic timer", async () => {
  const f = fixture(); assert.equal(await f.service.notify("delivery-1"), true); f.advance(1);
  assert.equal(await f.service.notify("delivery-1"), false);
  await f.service.notify("delivery-2");
  const tick = await f.service.tick(); assert.equal(tick.status, "indexed"); assert.equal(tick.processed, 3); assert.equal(f.stats.syncs, 1);
  assert.equal((await f.service.tick()).status, "idle");
  f.advance(300); assert.equal((await f.service.tick()).status, "indexed"); assert.equal(f.stats.syncs, 2);
  assert.ok((await f.timers.list()).every(timer => timer.state === "completed"));
});

test("failed refresh remains visible and resumes with bounded retry without retaining provider text", async () => {
  const f = fixture(); f.stats.fail = true;
  const failed = await f.service.tick(); assert.equal(failed.status, "retry_scheduled");
  assert.ok(!JSON.stringify(await f.timers.list()).includes("Private source failure text"));
  f.advance(120); f.stats.fail = false;
  // A retry changes dueAt; scheduling the same periodic bucket must retain that timer.
  const recovered = await f.service.tick(); assert.equal(recovered.status, "indexed"); assert.equal(f.stats.syncs, 2);
});

test("binding changes retire old notifications without letting their payload select a repository", async () => {
  const f = fixture(); await f.service.notify("old-delivery");
  const next = new BrainFreshness({ ...f.options, bindingDigest: "d".repeat(64) });
  await next.tick();
  assert.equal(f.stats.syncs, 1);
  assert.ok((await f.timers.list()).some(timer => (timer.evidence as any)?.status === "obsolete_binding"));
  assert.ok((await f.timers.list()).every(timer => timer.state === "completed"));
});

test("freshness remains explicitly configured in the Instance, with no grant from enablement", () => {
  const base = { repository_binding_id: "repository", repository_id: "example/brain", branch: "main" };
  assert.equal(parseBrainFreshness(base), undefined);
  assert.doesNotThrow(() => parseBrainRepositoryBinding({ ...base, freshness: { push_events: true, reconcile_interval_seconds: 300 } }, "fixture"));
  for (const freshness of [{}, { push_events: true, reconcile_interval_seconds: 1 }, { push_events: true, reconcile_interval_seconds: 300, token: "forbidden" }]) {
    assert.throws(() => parseBrainRepositoryBinding({ ...base, freshness }, "fixture"));
  }
});
