import assert from "node:assert/strict";
import { test } from "node:test";
import { BrainWrites } from "../../brain/writes.ts";
import { BrainReads } from "../../brain/reads.ts";
import { BrainError } from "../../brain/contracts.ts";
import { CapabilityEffectOutcomeUnknownError, type CapabilityCallContext } from "../../capabilities/contracts.ts";
import type { BrainRepositoryCommitReceipt, BrainRepositoryMutationSource } from "../../runtime/repository/contracts.ts";
import type { BrainRememberInput } from "../../brain/mutations.ts";
import { sha256 } from "../../runtime/canonical.ts";
import { InMemoryStateStore } from "../../runtime/memory-state.ts";
import { InMemoryCompanyRecordsStore } from "../../records/memory-store.ts";
import { InMemoryBrainStore } from "../adapter/in-memory-brain.ts";
import { brainConfig, brainFiles } from "../fixtures/brain.ts";

const path = "brain/topics/expansion.md", base = "a".repeat(40);
const context: CapabilityCallContext = { instanceId: "fixture-instance", runId: "run-1", stepId: "update", agentId: "analyst", toolId: "oregano:brain/remember",
  idempotencyKey: "outer:1", subject: { principalId: "slack:reviewer", principalType: "human", status: "active", groupIds: ["company:active"] } };
const input = (): BrainRememberInput => ({ changes: { expected_revision: base, pages: [{ path, expected_content_hash: sha256(brainFiles[path]),
  markdown: brainFiles[path].replace("No shared decision yet.", "Source review remains pending.") }] },
  provenance: { source_id: "review:1", source_version: "v1", action: "update", evidence: ["sources/review"] }, operation_key: "review:1:v1:update" });

function fixture() {
  const scope = { instance_id: context.instanceId, repository_id: "example/brain" }, binding = { instanceId: scope.instance_id, repositoryId: scope.repository_id, bindingId: "repository", branch: "test-brain" };
  const store = new InMemoryBrainStore(), effects = new InMemoryStateStore(), leases = new InMemoryCompanyRecordsStore();
  const snapshots = new Map<string, Record<string, string>>([[base, structuredClone(brainFiles)]]), receipts = new Map<string, BrainRepositoryCommitReceipt>();
  const stats = { commits: 0, reconciliations: 0, head: base, loseReceipt: false, reject: false };
  const repository: BrainRepositoryMutationSource = {
    brainRevision: async () => stats.head,
    brainFiles: async (_binding, revision) => structuredClone(snapshots.get(revision)!),
    brainCommit: async request => {
      if (stats.reject || request.baseCommit !== stats.head) throw new BrainError("write_conflict", "The branch changed.");
      const files = structuredClone(snapshots.get(stats.head)!);
      for (const change of request.changes) change.markdown === null ? delete files[change.path] : files[change.path] = change.markdown;
      stats.commits++; stats.head = String(stats.commits).repeat(40);
      snapshots.set(stats.head, files);
      const receipt = { repositoryId: binding.repositoryId, branch: binding.branch, baseCommit: request.baseCommit, commit: stats.head,
        operationId: request.operationId, inputDigest: request.inputDigest };
      receipts.set(request.operationId, receipt);
      if (stats.loseReceipt) throw new CapabilityEffectOutcomeUnknownError("Provider receipt unavailable", { operation_id: request.operationId });
      return receipt;
    },
    brainFindCommit: async request => { stats.reconciliations++; return receipts.get(request.operationId); },
  };
  const options = { scope, binding, configuration: brainConfig, store, effects, leases, repository };
  return { ...options, writes: new BrainWrites(options), reads: new BrainReads(store, scope), stats, snapshots, receipts };
}

test("Brain writes atomically persist and index without a release, then replay across runs and agents", async () => {
  const f = fixture(), result = await f.writes.execute("remember", input(), context);
  assert.equal(result.status, "saved"); assert.equal(result.sync_status, "indexed"); assert.equal(result.saved_commit, f.stats.head);
  const read = await f.reads.entity("topics/expansion"); assert.ok(read.found && read.page.markdown.includes("Source review remains pending."));
  const replay = await new BrainWrites(f).execute("remember", input(), { ...context, runId: "run-2", agentId: "other-authorized-agent", idempotencyKey: "outer:2" });
  assert.deepEqual(replay, result); assert.equal(f.stats.commits, 1); assert.equal(f.effects.effects.size, 1);
  const retained = [...f.effects.effects.values()][0].evidence as any;
  assert.equal(retained.actor, context.subject!.principalId); assert.equal(retained.agent, context.agentId);
  const evidence = JSON.stringify([...f.effects.effects.values()]);
  assert.ok(!evidence.includes("Source review remains pending.")); assert.ok(!evidence.includes("No shared decision yet."));
  assert.equal(f.leases.syncLeases.size, 0);
});

test("saved Git and failed indexing resumes synchronization without repeating Git", async () => {
  const f = fixture(), publish = f.store.publish.bind(f.store);
  f.store.publish = async () => { throw new Error("Database temporarily unavailable"); };
  const first = await f.writes.execute("remember", input(), context);
  assert.equal(first.status, "saved"); assert.equal(first.sync_status, "pending"); assert.equal(first.indexed_revision, null);
  f.store.publish = publish;
  const resumed = await new BrainWrites(f).execute("remember", input(), context, { only: true });
  assert.equal(resumed.sync_status, "indexed"); assert.equal(f.stats.commits, 1);
});

test("lost commit or database receipt is reconciled from exact Git proof, never blindly resent", async () => {
  for (const failure of ["provider", "database"]) {
    const f = fixture();
    if (failure === "provider") f.stats.loseReceipt = true;
    else {
      const cas = f.effects.compareAndSetEffect.bind(f.effects); let once = true;
      f.effects.compareAndSetEffect = async args => {
        if ((args.evidence as any).phase === "saved" && once) { once = false; throw new Error("Lost database response"); }
        return cas(args);
      };
    }
    await assert.rejects(f.writes.execute("remember", input(), context), CapabilityEffectOutcomeUnknownError);
    const resumed = await new BrainWrites(f).execute("remember", input(), { ...context, runId: "retry" }, { only: true });
    assert.equal(resumed.sync_status, "indexed"); assert.equal(f.stats.commits, 1); assert.equal(f.stats.reconciliations, 1);
  }
  const f = fixture(); f.stats.loseReceipt = true;
  await assert.rejects(f.writes.execute("remember", input(), context)); f.receipts.clear();
  await assert.rejects(f.writes.execute("remember", input(), context), CapabilityEffectOutcomeUnknownError);
  assert.equal(f.stats.commits, 1);
});

test("operation identities, current subject, current target hashes and repository policy fail closed", async () => {
  const f = fixture(); await f.writes.execute("remember", input(), context);
  const changed = input(); changed.provenance.source_version = "v2";
  await assert.rejects(f.writes.execute("remember", changed, context), /different input/);
  await assert.rejects(f.writes.execute("remember", input(), { ...context, subject: { ...context.subject!, status: "revoked" } }), /active/);
  const next = input(); next.operation_key = "another-operation";
  await assert.rejects(f.writes.execute("remember", next, context), /selected page changed/);
  const denied = fixture(); denied.stats.reject = true;
  await assert.rejects(denied.writes.execute("remember", input(), context), /branch changed/);
  await assert.rejects(denied.writes.execute("remember", input(), context), /failed before/);
  assert.equal(denied.stats.commits, 0); assert.equal(f.stats.commits, 1);
});

test("two writers serialize through the durable repository lease, including manual edits", async () => {
  const f = fixture(), read = f.repository.brainFiles; let release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; }), pause = new Promise<void>(resolve => { release = resolve; });
  f.repository.brainFiles = async (...args) => { entered(); await pause; return read(...args); };
  const first = f.writes.execute("remember", input(), context); await enteredPromise;
  await assert.rejects(new BrainWrites(f).execute("remember", input(), { ...context, runId: "run-2" }), /owns the repository lease/);
  release(); await first; assert.equal(f.stats.commits, 1);
  const g = fixture(); g.stats.head = "b".repeat(40);
  g.snapshots.set(g.stats.head, { ...brainFiles, "brain/people/sam.md": brainFiles["brain/people/sam.md"].replace("Research lead.", "Research contributor.") });
  const result = await g.writes.execute("remember", input(), context);
  assert.equal(result.base_commit, "b".repeat(40));
  assert.ok(g.snapshots.get(g.stats.head)!["brain/people/sam.md"].includes("Research contributor."));
});

test("dry run and unchanged requests do not commit; recovery cannot initiate a new operation", async () => {
  const f = fixture(); assert.equal((await f.writes.execute("remember", { ...input(), dry_run: true }, context)).status, "dry_run");
  assert.equal(f.effects.effects.size, 0); assert.equal(f.stats.commits, 0);
  await assert.rejects(f.writes.execute("remember", input(), context, { only: true }), /no durable operation/);
  const unchanged = input(); unchanged.changes.pages[0].markdown = brainFiles[path];
  assert.equal((await f.writes.execute("remember", unchanged, context)).status, "unchanged");
  assert.equal(f.stats.commits, 0);
});

test("forget removes current knowledge and retains only attributable digests in effects", async () => {
  const f = fixture(), result = await f.writes.execute("forget", { target: { path, expected_revision: base, expected_content_hash: sha256(brainFiles[path]), kind: "page" },
    reason: "Private reason text must not be logged.", operation_key: "withdraw:1" }, context);
  assert.equal(result.sync_status, "indexed"); assert.equal((await f.reads.entity("topics/expansion")).found, false);
  assert.ok(!JSON.stringify([...f.effects.effects.values()]).includes("Private reason"));
  assert.ok(!JSON.stringify([...f.effects.effects.values()]).includes("Delay the branch"));
});

test("deleted and recreated pages cannot reuse retired Take numbers, including after projection rebuild", async () => {
  const f = fixture();
  await f.writes.execute("forget", { target: { path, expected_revision: base, expected_content_hash: sha256(brainFiles[path]), kind: "page" }, reason: "Source review.", operation_key: "withdraw:1" }, context);
  const recreate = input(); recreate.operation_key = "recreate:1"; recreate.changes.expected_revision = f.stats.head;
  recreate.changes.pages[0].expected_content_hash = null;
  f.store.snapshots.clear(); // The projection is disposable; identity metadata remains in durable effects.
  await assert.rejects(f.writes.execute("remember", recreate, context), /retired page/);
  const page = recreate.changes.pages[0].markdown.replaceAll("| 1 |", "| 8 |").replaceAll("| 4 |", "| 9 |").replaceAll("| 7 |", "| 10 |");
  recreate.changes.pages[0].markdown = page;
  assert.equal((await f.writes.execute("remember", recreate, context)).sync_status, "indexed");
  assert.equal(f.stats.commits, 2);
  assert.ok(!JSON.stringify([...f.effects.effects.values()]).includes("Open the branch now"));
});

test("a retained claim before dispatch can resume through an authorized invocation, never through read-only reconciliation", async () => {
  const f = fixture(), cas = f.effects.compareAndSetEffect.bind(f.effects); let once = true;
  f.effects.compareAndSetEffect = async args => { if (once) { once = false; throw new Error("Interrupted before preparation checkpoint"); } return cas(args); };
  await assert.rejects(f.writes.execute("remember", input(), context), /Interrupted/); assert.equal(f.stats.commits, 0);
  await assert.rejects(f.writes.execute("remember", input(), context, { only: true }), /no complete preparation/);
  assert.equal(f.stats.commits, 0);
  const resumed = await new BrainWrites(f).execute("remember", input(), { ...context, runId: "resume-authorized" });
  assert.equal(resumed.sync_status, "indexed"); assert.equal(f.stats.commits, 1);
});
