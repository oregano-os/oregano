import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256 } from "../../runtime/canonical.ts";
import { ReleaseCoordinator } from "../../runtime/release/coordinator.ts";
import type { ReleaseAuthorization, ReleaseCandidate, ReleaseExecutionAdapter, ProductionArtifactReceipt, ProductionVerification } from "../../runtime/release/contracts.ts";
import type { ReleaseRun } from "../../state-store/release-runs.ts";
import { InMemoryReleaseRunStore } from "../adapter/in-memory-release-runs.ts";

const requester = "slack:T1:U1";
const steward = "teams:tenant:user2";
const candidate = (instanceId = "acme"): ReleaseCandidate => ({
  version: 1, id: `change-${instanceId}`, instanceId, repositoryId: `${instanceId}/workspace`, targetBranch: "main",
  baseCommit: "a".repeat(40), candidateCommit: "b".repeat(40), candidateTree: "c".repeat(40), coreCommit: "d".repeat(40),
  configurationDigest: "1".repeat(64), policyDigest: "2".repeat(64), diffDigest: "3".repeat(64), checksDigest: "4".repeat(64), previousArtifactHash: "5".repeat(64),
  changeClass: "behavior", requester, sourceConversation: "slack:C1:thread", requiredChecks: ["companyos"],
});
function fixture(c = candidate(), sharedStore = new InMemoryReleaseRunStore()) {
  const rule = { mode: "requester" as const, eligible: { members: ["member", "steward"], groups: [] }, independent: false };
  let authority: ReleaseAuthorization = {
    policyDigest: c.policyDigest,
    roster: [
      { id: "member", name: "Member", role: "member", status: "active", principals: [requester], mayApprove: [] },
      { id: "steward", name: "Steward", role: "steward", status: "active", principals: [steward], mayApprove: [] },
    ],
    policy: { version: 1, acceptance: { content: rule, behavior: rule, security: { ...rule, mode: "steward", eligible: { members: ["steward"], groups: [] } } }, deployers: { members: ["member", "steward"], groups: [] } },
  };
  const artifact: ProductionArtifactReceipt = { artifactHash: "6".repeat(64), instanceId: c.instanceId, environment: "production", coreCommit: c.coreCommit, workspaceCommit: "e".repeat(40), configurationDigest: c.configurationDigest };
  let production: ProductionVerification = { ...artifact, artifactHash: c.previousArtifactHash, deploymentId: "old", ready: true };
  const inspection = { repositoryId: c.repositoryId, targetBranch: c.targetBranch, currentBase: c.baseCommit, candidateCommit: c.candidateCommit, candidateTree: c.candidateTree, diffDigest: c.diffDigest, changeClass: c.changeClass, checksDigest: c.checksDigest, checks: [{ id: "companyos", status: "passed" as "passed" | "pending" | "failed" }], protectionEnforced: true };
  const effects = new Map<string, unknown>();
  let pendingBuild = false;
  let notificationFailures = 0;
  let notifications = 0;
  const once = <T>(id: string, receipt: T): T => { if (!effects.has(id)) effects.set(id, receipt); return effects.get(id) as T; };
  const execution: ReleaseExecutionAdapter = {
    id: "testkit-release",
    async authorization() { return authority; },
    async inspect() { return inspection; },
    async currentProduction() { return production; },
    async merge({ operationId }) { return { state: "succeeded", receipt: once(operationId, { repositoryId: c.repositoryId, targetBranch: c.targetBranch, candidateCommit: c.candidateCommit, baseCommit: c.baseCommit, mergedCommit: artifact.workspaceCommit, mergedTree: c.candidateTree }) }; },
    async build({ operationId }) { return pendingBuild ? { state: "pending" } : { state: "succeeded", receipt: once(operationId, artifact) }; },
    async migrate({ operationId }) { return { state: "succeeded", receipt: once(operationId, { digest: c.migration!.digest }) }; },
    async deploy({ operationId, previousArtifactHash }) {
      if (!effects.has(operationId)) assert.equal(production.artifactHash, previousArtifactHash);
      production = once(operationId, { ...artifact, deploymentId: "new", ready: true, ...(c.migration ? { migrationDigest: c.migration.digest } : {}) });
      return { state: "succeeded", receipt: production };
    },
    async verify() { return { state: "succeeded", receipt: production }; },
    async rollback({ operationId }) { production = once(operationId, { ...artifact, artifactHash: c.previousArtifactHash, deploymentId: "restored", ready: true }); return { state: "succeeded", receipt: production }; },
  };
  const make = () => new ReleaseCoordinator({ store: sharedStore, execution, notify: async () => { if (notificationFailures-- > 0) throw new Error("notification transport failed"); notifications++; } });
  const advanceUntil = async (stage: ReleaseRun["stage"], coordinator = make()) => {
    for (let count = 0; count < 30; count++) {
      const run = await coordinator.advance(c.instanceId, "worker");
      if (run?.stage === stage) return run;
      assert.notEqual(run?.stage, "failed", run?.failure);
    }
    throw new Error(`Release did not reach ${stage}`);
  };
  return { c, store: sharedStore, execution, inspection, effects, make, advanceUntil,
    setAuthority: (value: ReleaseAuthorization) => { authority = value; }, getAuthority: () => authority,
    setProduction: (value: ProductionVerification) => { production = value; }, getProduction: () => production,
    setPendingBuild: (value: boolean) => { pendingBuild = value; }, setNotificationFailures: (value: number) => { notificationFailures = value; }, notifications: () => notifications,
  };
}

test("one acceptance releases the exact candidate and reports live only after production verification", async () => {
  const f = fixture();
  const accepted = await f.make().accept(f.c, requester, sha256(f.c));
  assert.equal(accepted.stage, "approved");
  assert.equal(f.effects.size, 0);
  await f.advanceUntil("deployed");
  assert.equal(f.notifications(), 0);
  assert.ok(!f.store.history.some((run) => run.stage === "live"));
  const live = await f.advanceUntil("live");
  assert.equal(live.verification?.artifactHash, "6".repeat(64));
  assert.equal(live.verification?.workspaceCommit, "e".repeat(40));
  assert.equal(f.notifications(), 1);
  assert.equal(f.effects.size, 3);
  assert.equal((await f.make().accept(f.c, requester, sha256(f.c))).id, accepted.id);
  assert.equal(await f.make().advance(f.c.instanceId, "duplicate"), undefined);
});

test("members, Stewards, independent review and deployment authority are company policy", async () => {
  const f = fixture();
  await assert.rejects(f.make().accept(f.c, steward, sha256(f.c)), /required acceptor/);
  const original = f.getAuthority();
  f.setAuthority({ ...original, policy: { ...original.policy, acceptance: { ...original.policy.acceptance, behavior: { mode: "steward", eligible: { members: ["steward"], groups: [] }, independent: true } } } });
  await assert.rejects(f.make().accept(f.c, requester, sha256(f.c)), /required acceptor/);
  assert.equal((await f.make().accept(f.c, steward, sha256(f.c))).acceptedBy, steward);
  const g = fixture();
  g.setAuthority({ ...g.getAuthority(), policy: { ...g.getAuthority().policy, deployers: { members: [], groups: [] } } });
  await assert.rejects(g.make().accept(g.c, requester, sha256(g.c)), /no production release authority/);
  const h = fixture();
  h.setAuthority({ ...h.getAuthority(), roster: h.getAuthority().roster.map((member) => ({ ...member, type: "agent" })) });
  await assert.rejects(h.make().accept(h.c, requester, sha256(h.c)), /active human/);
});

test("stale candidate, base, checks, production or policy cannot be accepted", async () => {
  for (const mutation of [
    (f: ReturnType<typeof fixture>) => { f.inspection.currentBase = "f".repeat(40); },
    (f: ReturnType<typeof fixture>) => { f.inspection.checks[0].status = "failed"; },
    (f: ReturnType<typeof fixture>) => { f.inspection.protectionEnforced = false; },
    (f: ReturnType<typeof fixture>) => f.setAuthority({ ...f.getAuthority(), policyDigest: "0".repeat(64) }),
    (f: ReturnType<typeof fixture>) => f.setProduction({ ...f.getProduction(), artifactHash: "0".repeat(64) }),
  ]) {
    const f = fixture(); mutation(f);
    await assert.rejects(f.make().accept(f.c, requester, sha256(f.c)));
    assert.equal(f.effects.size, 0); assert.equal(f.store.runs.size, 0);
  }
  const f = fixture();
  await assert.rejects(f.make().accept(f.c, requester, "0".repeat(64)), /candidate changed/);
});

test("authorization is refreshed before effects but verification survives a deployed policy change", async () => {
  const f = fixture();
  await f.make().accept(f.c, requester, sha256(f.c));
  f.setAuthority({ ...f.getAuthority(), policyDigest: "0".repeat(64) });
  assert.equal((await f.make().advance(f.c.instanceId, "worker"))?.stage, "failed");
  assert.equal(f.effects.size, 0);
  const g = fixture();
  await g.make().accept(g.c, requester, sha256(g.c));
  await g.advanceUntil("deployed");
  g.setAuthority({ ...g.getAuthority(), policyDigest: "0".repeat(64) });
  assert.equal((await g.advanceUntil("live")).stage, "live");
  await g.make().rollback([...g.store.runs.keys()][0], steward);
  assert.equal((await g.advanceUntil("rolled-back")).verification?.artifactHash, g.c.previousArtifactHash);
});

test("pending operations resume after coordinator restart and concurrent workers share a single Instance lease", async () => {
  const f = fixture();
  const run = await f.make().accept(f.c, requester, sha256(f.c));
  f.setPendingBuild(true);
  await f.advanceUntil("building");
  const before = f.effects.size;
  await Promise.all([f.make().advance(f.c.instanceId, "one"), f.make().advance(f.c.instanceId, "two")]);
  assert.equal(f.effects.size, before);
  assert.equal((await f.store.get(run.id))?.stage, "building");
  f.setPendingBuild(false);
  await f.advanceUntil("live", f.make());
  assert.equal(f.effects.size, 3);
});

test("failed notification retries without rerunning a release; failed verification never claims live", async () => {
  const f = fixture(); f.setNotificationFailures(1);
  await f.make().accept(f.c, requester, sha256(f.c));
  const run = await f.advanceUntil("live");
  assert.equal(run.notificationDelivered, undefined);
  await f.make().advance(f.c.instanceId, "notification-retry");
  assert.equal(f.notifications(), 1); assert.equal(f.effects.size, 3);
  const g = fixture();
  g.execution.verify = async () => ({ state: "succeeded", receipt: { ...g.getProduction(), ready: false } });
  await g.make().accept(g.c, requester, sha256(g.c));
  await g.advanceUntil("verifying");
  assert.equal((await g.make().advance(g.c.instanceId, "verify"))?.stage, "failed");
  assert.ok(!g.store.history.some((entry) => entry.stage === "live"));
});

test("different companies have separate policy and execution queues", async () => {
  const store = new InMemoryReleaseRunStore();
  const f = fixture(candidate("acme"), store); const g = fixture(candidate("contoso"), store);
  await Promise.all([f.make().accept(f.c, requester, sha256(f.c)), g.make().accept(g.c, requester, sha256(g.c))]);
  await Promise.all([f.advanceUntil("live"), g.advanceUntil("live")]);
  assert.equal(store.runs.size, 2);
  assert.equal(f.effects.size, 3); assert.equal(g.effects.size, 3);
});

test("migration evidence is exact and application rollback cannot claim data recovery", async () => {
  const c = { ...candidate(), migration: { id: "add-column", digest: "7".repeat(64), reversible: true } };
  const f = fixture(c);
  const run = await f.make().accept(c, requester, sha256(c));
  assert.equal((await f.advanceUntil("live")).migrationDigest, c.migration.digest);
  assert.equal(f.effects.size, 4);
  await assert.rejects(f.make().rollback(run.id, requester), /recovery plan/);
  const g = fixture(c);
  g.execution.migrate = async () => ({ state: "succeeded", receipt: { digest: "0".repeat(64) } });
  await g.make().accept(c, requester, sha256(c));
  await g.advanceUntil("migrating");
  assert.equal((await g.make().advance(c.instanceId, "migration"))?.stage, "failed");
  assert.equal(g.getProduction().artifactHash, c.previousArtifactHash);
});

test("rollback cannot overwrite a newer deployment, and provider secrets are absent from failure state", async () => {
  const f = fixture(); const run = await f.make().accept(f.c, requester, sha256(f.c));
  await f.advanceUntil("live");
  f.setProduction({ ...f.getProduction(), artifactHash: "0".repeat(64) });
  await assert.rejects(f.make().rollback(run.id, requester), /newer production/);
  const g = fixture();
  g.execution.merge = async () => { throw new Error("postgres://secret@host provider-token-private"); };
  await g.make().accept(g.c, requester, sha256(g.c));
  await g.advanceUntil("merging");
  const failed = await g.make().advance(g.c.instanceId, "fail");
  assert.equal(failed?.stage, "failed");
  assert.doesNotMatch(JSON.stringify(failed), /provider-token-private|postgres:\/\//);
});

test("accepted Workspace release policy compiles named membership and preserves security governance", async () => {
  const { compileWorkspaceReleasePolicy, releaseAuthorization } = await import("../../runtime/release/policy.ts");
  const f = fixture(); const authority = f.getAuthority();
  const governance = { review_mode: "steward", roles: { workspace_stewards: ["steward"] }, builder: { release: authority.policy } };
  const policy = compileWorkspaceReleasePolicy(governance, authority.roster)!;
  assert.deepEqual(policy, authority.policy);
  const before = releaseAuthorization(policy, authority.roster);
  const renamed = releaseAuthorization(policy, authority.roster.map((member) => ({ ...member, name: "Display name" })));
  assert.equal(before.policyDigest, renamed.policyDigest);
  const revoked = releaseAuthorization(policy, authority.roster.map((member) => ({ ...member, status: "inactive" })));
  assert.notEqual(before.policyDigest, revoked.policyDigest);
  assert.equal(compileWorkspaceReleasePolicy({}, authority.roster), undefined);
  assert.throws(() => compileWorkspaceReleasePolicy({ ...governance, review_mode: "independent-review" }, authority.roster), /independent-review requirements/);
  assert.throws(() => compileWorkspaceReleasePolicy({ ...governance, roles: { workspace_stewards: [] } }, authority.roster), /assigned Workspace Stewards/);
  assert.throws(() => compileWorkspaceReleasePolicy(governance, []), /unknown roster/);
});

test("production warming up remains verifying until exact readiness is proved", async () => {
  const f = fixture();
  await f.make().accept(f.c, requester, sha256(f.c));
  await f.advanceUntil("verifying");
  const verify = f.execution.verify;
  f.execution.verify = async () => ({ state: "pending" });
  assert.equal((await f.make().advance(f.c.instanceId, "warming"))?.stage, "verifying");
  assert.equal(f.notifications(), 0);
  f.execution.verify = verify;
  assert.equal((await f.advanceUntil("live")).stage, "live");
});

test("requester acceptance and independent review use the human identity across chat surfaces", async () => {
  const f = fixture();
  const alias = "teams:tenant:member";
  const original = f.getAuthority();
  f.setAuthority({ ...original, roster: original.roster.map((member) => member.id === "member" ? { ...member, principals: [requester, alias] } : member) });
  assert.equal((await f.make().accept(f.c, alias, sha256(f.c))).acceptedBy, alias);
  const g = fixture();
  const authority = g.getAuthority();
  g.setAuthority({ ...authority, roster: f.getAuthority().roster, policy: { ...authority.policy, acceptance: { ...authority.policy.acceptance, behavior: { mode: "steward", eligible: { members: ["member", "steward"], groups: [] }, independent: true } } } });
  await assert.rejects(g.make().accept(g.c, alias, sha256(g.c)), /required acceptor/);
});


test("lost promotion receipt is reconciled read-only after the release changes its own policy", async () => {
  const f = fixture();
  await f.make().accept(f.c, requester, sha256(f.c));
  await f.advanceUntil("deploying");
  const original = f.execution.deploy;
  f.execution.deploy = async (context) => {
    await original(context);
    f.setAuthority({ ...f.getAuthority(), policyDigest: "0".repeat(64) });
    return { state: "pending" };
  };
  await f.make().advance(f.c.instanceId, "promoting");
  f.execution.reconcileDeployment = async () => f.getProduction();
  f.execution.authorization = async () => { throw new Error("old policy is no longer active"); };
  assert.equal((await f.advanceUntil("live")).stage, "live");
  assert.equal(f.effects.size, 3);
});
