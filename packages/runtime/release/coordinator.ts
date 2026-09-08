import { sha256 } from "../canonical.ts";
import { assertGitCommit, assertSha256 } from "../repository/contracts.ts";
import { findByCanonicalPrincipal, type RosterMember } from "../../state-store/roster.ts";
import { releaseIsTerminal, type ReleaseRun, type ReleaseRunStore, type ReleaseStage } from "../../state-store/release-runs.ts";
import type { ReleaseAuthorization, ReleaseCandidate, ReleaseExecutionAdapter, ReleaseSelector, ProductionArtifactReceipt } from "./contracts.ts";

function matches(member: RosterMember, selector: ReleaseSelector): boolean {
  return (!!member.id && selector.members.includes(member.id)) || !!member.groups?.some((group) => selector.groups.includes(group));
}
export function authorizeRelease(candidate: ReleaseCandidate, actor: string, authority: ReleaseAuthorization, deploymentOnly = false): void {
  if (authority.policy.version !== 1 || (!deploymentOnly && authority.policyDigest !== candidate.policyDigest)) throw new Error("Release policy or membership changed; review the candidate under the current policy.");
  const member = findByCanonicalPrincipal([...authority.roster], actor);
  if (!member || !/^(active|aktiv)$/i.test(member.status) || member.type === "agent" || member.type === "service") throw new Error("Release requires an authenticated active human.");
  const rule = authority.policy.acceptance[candidate.changeClass];
  const requester = findByCanonicalPrincipal([...authority.roster], candidate.requester);
  const sameHuman = !!requester && (member.id && requester.id ? member.id === requester.id : member === requester);
  if (!deploymentOnly && (!rule || !matches(member, rule.eligible)
    || (rule.mode === "requester" && !sameHuman)
    || (rule.independent && sameHuman))) throw new Error("This human is not the required acceptor for this change.");
  if (!matches(member, authority.policy.deployers)) throw new Error("This human has no production release authority for the Instance.");
}
export function assertReleaseCandidate(candidate: ReleaseCandidate): void {
  if (candidate.version !== 1 || !candidate.id || !candidate.instanceId || !candidate.repositoryId || !candidate.targetBranch || !candidate.requester || !candidate.sourceConversation) throw new Error("Release candidate identity is incomplete.");
  for (const field of ["baseCommit", "candidateCommit", "candidateTree", "coreCommit"] as const) assertGitCommit(candidate[field], field);
  for (const field of ["configurationDigest", "policyDigest", "diffDigest", "checksDigest", "previousArtifactHash"] as const) assertSha256(candidate[field], field);
  if (!["content", "behavior", "security"].includes(candidate.changeClass)) throw new Error("Release change class is invalid.");
  if (!candidate.requiredChecks.length || new Set(candidate.requiredChecks).size !== candidate.requiredChecks.length) throw new Error("Release requires named unique checks.");
  if (JSON.stringify(candidate).length > 30000) throw new Error("Release candidate is too large.");
  if (candidate.migration) { assertSha256(candidate.migration.digest, "migration digest"); if (!candidate.migration.id) throw new Error("Migration identity is required."); }
}
function assertArtifact(candidate: ReleaseCandidate, mergedCommit: string, receipt: ProductionArtifactReceipt): void {
  assertSha256(receipt.artifactHash, "production artifact hash");
  if (receipt.environment !== "production" || receipt.instanceId !== candidate.instanceId
    || receipt.coreCommit !== candidate.coreCommit || receipt.workspaceCommit !== mergedCommit
    || receipt.configurationDigest !== candidate.configurationDigest) throw new Error("Production receipt does not match the accepted Core/Workspace/Instance pairing.");
}

/** The coding process never receives or calls this coordinator. */
export class ReleaseCoordinator {
  private readonly dependencies: {
    store: ReleaseRunStore;
    execution: ReleaseExecutionAdapter;
    notify(run: ReleaseRun): Promise<void>;
    now?: () => Date;
    leaseMs?: number;
  };
  constructor(dependencies: ReleaseCoordinator["dependencies"]) { this.dependencies = dependencies; }
  #now(): string { return (this.dependencies.now?.() ?? new Date()).toISOString(); }

  async accept(candidate: ReleaseCandidate, actor: string, expectedDigest: string): Promise<ReleaseRun> {
    assertReleaseCandidate(candidate);
    if (sha256(candidate) !== expectedDigest) throw new Error("The accepted candidate changed.");
    const id = `builder-release-${sha256({ instance: candidate.instanceId, candidate: expectedDigest }).slice(0, 40)}`;
    const authority = await this.dependencies.execution.authorization(candidate.instanceId);
    authorizeRelease(candidate, actor, authority);
    const existing = await this.dependencies.store.get(id);
    if (existing) return existing;
    await this.#inspect(candidate);
    const production = await this.dependencies.execution.currentProduction(candidate.instanceId);
    if (!production.ready || production.instanceId !== candidate.instanceId || production.environment !== "production"
      || production.artifactHash !== candidate.previousArtifactHash) throw new Error("Production changed since this candidate was prepared.");
    if (candidate.migration && !this.dependencies.execution.migrate) throw new Error("The selected release adapter cannot execute the candidate migration.");
    const now = this.#now();
    return await this.dependencies.store.create({ id, candidate, candidateDigest: expectedDigest, acceptedBy: actor, acceptedAt: now, stage: "approved", revision: 0, updatedAt: now });
  }

  async #inspect(candidate: ReleaseCandidate): Promise<void> {
    const inspected = await this.dependencies.execution.inspect(candidate);
    if (!inspected.protectionEnforced || inspected.repositoryId !== candidate.repositoryId
      || inspected.targetBranch !== candidate.targetBranch || inspected.currentBase !== candidate.baseCommit
      || inspected.candidateCommit !== candidate.candidateCommit || inspected.candidateTree !== candidate.candidateTree
      || inspected.diffDigest !== candidate.diffDigest || inspected.changeClass !== candidate.changeClass
      || inspected.checksDigest !== candidate.checksDigest
      || candidate.requiredChecks.some((id) => !inspected.checks.some((check) => check.id === id && check.status === "passed"))
      || inspected.checks.some((check) => check.status !== "passed")) {
      throw new Error("Candidate, base, protection or required checks changed; refresh and review the result.");
    }
  }

  async advance(instanceId: string, workerId: string): Promise<ReleaseRun | undefined> {
    let lease = await this.dependencies.store.claim(instanceId, workerId, this.#now(), this.dependencies.leaseMs ?? 120000);
    if (!lease) return undefined;
    let run = lease.run;
    const save = async (patch: Partial<ReleaseRun>) => {
      const next = { ...run, ...patch, revision: run.revision + 1, updatedAt: this.#now() };
      lease = await this.dependencies.store.save(lease!, next, this.#now());
      run = lease.run;
    };
    const move = async (stage: ReleaseStage) => await save({ stage });
    try {
      if (!releaseIsTerminal(run)) {
        const candidate = run.candidate;
        assertReleaseCandidate(candidate);
        if (sha256(candidate) !== run.candidateDigest) throw new Error("Stored release candidate was changed.");
        // Verification is read-only and must still run after a release changes
        // its own policy. Rollback uses current deployment authority, not the old
        // acceptance policy. Every forward mutation rechecks the accepted policy.
        if (!["deployed", "verifying"].includes(run.stage)) {
          const actor = run.stage === "rolling-back" ? run.rollbackBy! : run.acceptedBy;
          authorizeRelease(candidate, actor, await this.dependencies.execution.authorization(instanceId), run.stage === "rolling-back");
        }
        const execution = this.dependencies.execution;
        const context = { candidate, operationId: `${run.id}:${run.stage}` };
        switch (run.stage) {
          case "approved": await this.#inspect(candidate); await move("merging"); break;
          case "merging": {
            // The adapter rechecks exact head/base and protected checks atomically
            // with merge, or reconciles this same operation after an ambiguous result.
            const result = await execution.merge(context);
            if (result.state === "pending") break;
            const receipt = result.receipt;
            assertGitCommit(receipt.mergedCommit, "merged commit");
            if (receipt.repositoryId !== candidate.repositoryId || receipt.targetBranch !== candidate.targetBranch
              || receipt.candidateCommit !== candidate.candidateCommit || receipt.baseCommit !== candidate.baseCommit
              || receipt.mergedTree !== candidate.candidateTree) throw new Error("Merged content differs from the accepted candidate.");
            await save({ stage: "merged", merge: receipt }); break;
          }
          case "merged": await move("building"); break;
          case "building": {
            const result = await execution.build({ ...context, merge: run.merge! });
            if (result.state === "pending") break;
            assertArtifact(candidate, run.merge!.mergedCommit, result.receipt);
            await save({ stage: "built", artifact: result.receipt }); break;
          }
          case "built": await move(candidate.migration ? "migrating" : "deploying"); break;
          case "migrating": {
            const result = await execution.migrate!({ ...context, artifact: run.artifact! });
            if (result.state === "pending") break;
            if (result.receipt.digest !== candidate.migration!.digest) throw new Error("Migration receipt does not match the reviewed migration.");
            await save({ stage: "migrated", migrationDigest: result.receipt.digest }); break;
          }
          case "migrated": await move("deploying"); break;
          case "deploying": {
            const result = await execution.deploy({ ...context, artifact: run.artifact!, previousArtifactHash: candidate.previousArtifactHash });
            if (result.state === "pending") break;
            assertArtifact(candidate, run.merge!.mergedCommit, result.receipt);
            if (!result.receipt.deploymentId || result.receipt.artifactHash !== run.artifact!.artifactHash) throw new Error("Deployment does not identify the built production artifact.");
            await save({ stage: "deployed", deployment: result.receipt }); break;
          }
          case "deployed": await move("verifying"); break;
          case "verifying": {
            const result = await execution.verify({ ...context, deployment: run.deployment! });
            if (result.state === "pending") break;
            const verified = result.receipt;
            assertArtifact(candidate, run.merge!.mergedCommit, verified);
            if (!verified.ready || verified.deploymentId !== run.deployment!.deploymentId
              || verified.artifactHash !== run.artifact!.artifactHash
              || (candidate.migration && verified.migrationDigest !== candidate.migration.digest)) throw new Error("Production verification failed; this change is not verified live.");
            await save({ stage: "live", verification: verified }); break;
          }
          case "rolling-back": {
            if (!execution.rollback || !run.deployment || candidate.migration) throw new Error("Rollback needs an explicit state recovery plan for this release.");
            const restored = await execution.rollback({ ...context, deployment: run.deployment, previousArtifactHash: candidate.previousArtifactHash });
            if (restored.state === "pending") break;
            if (!restored.receipt.ready || restored.receipt.instanceId !== instanceId || restored.receipt.environment !== "production"
              || restored.receipt.artifactHash !== candidate.previousArtifactHash) throw new Error("Previous production artifact was not verified after rollback.");
            await save({ stage: "rolled-back", verification: restored.receipt }); break;
          }
        }
      }
      if (releaseIsTerminal(run) && !run.notificationDelivered) {
        await this.dependencies.notify(run);
        await save({ notificationDelivered: true });
      }
      return run;
    } catch (error) {
      // Notification failure must never change a successful live result or rerun it.
      if (!releaseIsTerminal(run)) {
        // Provider exceptions can contain tokens or connection strings. Retain a
        // correlation digest, never a raw provider message in company-visible state.
        await save({ stage: "failed", failure: `Release stopped during ${run.stage}. Evidence reference: ${sha256(error instanceof Error ? error.message : String(error))}` });
      }
      return run;
    } finally { await this.dependencies.store.release(lease); }
  }

  async rollback(id: string, actor: string): Promise<ReleaseRun> {
    const run = await this.dependencies.store.get(id);
    if (!run || !run.deployment || !["live", "failed"].includes(run.stage)) throw new Error("No deployed release is available to roll back.");
    if (run.candidate.migration || !this.dependencies.execution.rollback) throw new Error("This release requires a separately reviewed recovery plan.");
    authorizeRelease(run.candidate, actor, await this.dependencies.execution.authorization(run.candidate.instanceId), true);
    const active = await this.dependencies.execution.currentProduction(run.candidate.instanceId);
    if (active.instanceId !== run.candidate.instanceId || active.environment !== "production"
      || active.artifactHash !== run.deployment.artifactHash) throw new Error("A newer production version is active; do not roll it back through an older release.");
    return await this.dependencies.store.requestRollback(id, actor, run.revision, this.#now());
  }
}
