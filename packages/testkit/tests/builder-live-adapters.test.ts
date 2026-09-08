import assert from "node:assert/strict";
import test from "node:test";
import { inspectGitHubCandidate, mergeGitHubCandidate, type GitHubCandidateInput, type GitHubReleaseClient } from "../../connectors/github-release.ts";
import { VercelProductionReleaseHost, type ReleasePrivateState } from "../../connectors/vercel-release.ts";
import type { ReleaseCandidate } from "../../runtime/release/contracts.ts";

const base = "a".repeat(40), commit = "b".repeat(40), tree = "c".repeat(40), merged = "d".repeat(40), core = "e".repeat(40);
const hash = "1".repeat(64), nextHash = "2".repeat(64), config = "3".repeat(64);
function githubFixture() {
  const input: GitHubCandidateInput = { repositoryId: "synthetic/company", targetBranch: "main", baseCommit: base, candidateCommit: commit,
    pullRequestNumber: 3, changeClass: "behavior", changedPaths: ["workflows/example.yaml"],
    workbenchChecks: ["inspect", "validate", "security"].map((name) => ({ id: `workbench.${name}`, status: "passed", evidenceDigest: hash })) };
  const pull = { number: 3, node_id: "PR_fixture", state: "open", draft: true, merged: false, merge_commit_sha: null as string | null,
    base: { ref: "main", sha: base, repo: { full_name: input.repositoryId } }, head: { sha: commit, repo: { full_name: input.repositoryId } } };
  const protection = { required_status_checks: { strict: true, checks: [{ context: "check", app_id: 15368 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false } };
  const runs = { total_count: 1, check_runs: [{ id: 12, name: "check", head_sha: commit, status: "completed", conclusion: "success", app: { id: 15368 } }] };
  let branch = base, writes = 0, ready = 0, ambiguous = false;
  let protectedBranch = true, protectionReads = 0, moveDuringMerge = false, rejectWrite = false;
  const client: GitHubReleaseClient = {
    async readyForReview() { ready++; pull.draft = false; },
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      let response: unknown;
      if (method === "PATCH") {
        assert.equal(protectedBranch, false);
        assert.equal(path, "/git/refs/heads/main"); assert.deepEqual(body, { sha: commit, force: false });
        if (moveDuringMerge) branch = "f".repeat(40);
        if (rejectWrite || branch !== base) throw new Error("Non-fast-forward or rejected reference update");
        writes++; branch = commit;
        // Deliberately leave PR metadata behind the successful reference write.
        if (ambiguous) throw new Error("connection lost after fast-forward");
        response = { object: { sha: commit } };
      } else if (method === "PUT") {
        assert.equal(path, "/pulls/3/merge"); assert.deepEqual(body, { sha: commit, merge_method: "merge" });
        writes++; pull.merged = true; pull.merge_commit_sha = merged; branch = merged;
        if (ambiguous) throw new Error("connection lost after merge");
        response = { merged: true };
      } else if (path === "/pulls/3") response = pull;
      else if (path.endsWith("/protection")) { protectionReads++; assert.equal(protectedBranch, true); response = protection; }
      else if (path.startsWith("/branches/")) response = { commit: { sha: branch }, protected: protectedBranch };
      else if (path.includes("/check-runs")) response = runs;
      else if (path.startsWith("/compare/")) response = { status: "ahead", total_commits: 1, files: [{ filename: input.changedPaths[0], sha: "f".repeat(40), status: "modified" }] };
      else if (path === `/commits/${commit}`) response = { sha: commit, commit: { tree: { sha: tree } }, parents: [{ sha: base }] };
      else if (path === `/commits/${merged}`) response = { sha: merged, commit: { tree: { sha: tree } }, parents: [{ sha: base }, { sha: commit }] };
      else throw new Error(`unexpected ${method} ${path}`);
      return structuredClone(response) as T;
    },
  };
  return { input, client, protection, runs, pull, move: () => { branch = "f".repeat(40); }, ambiguous: () => { ambiguous = true; }, counts: () => ({ writes, ready }),
    unprotected: () => { protectedBranch = false; }, protect: () => { protectedBranch = true; }, protectionReads: () => protectionReads,
    race: () => { moveDuringMerge = true; }, reject: () => { rejectWrite = true; } };
}
async function candidate(f: ReturnType<typeof githubFixture>): Promise<ReleaseCandidate> {
  const inspection = await inspectGitHubCandidate(f.client, f.input);
  return { version: 1, id: "fixture", instanceId: "synthetic-production", ...f.input,
    candidateTree: inspection.candidateTree, coreCommit: core, configurationDigest: config, policyDigest: hash,
    diffDigest: inspection.diffDigest, requester: "test:synthetic:owner", sourceConversation: "test:chat",
    requiredChecks: inspection.checks.map((check) => check.id), checksDigest: inspection.checksDigest, previousArtifactHash: hash };
}
test("GitHub release pins the check producer, full path inventory and protected exact base", async () => {
  const f = githubFixture();
  assert.equal((await inspectGitHubCandidate(f.client, f.input)).protectionEnforced, true);
  f.runs.check_runs[0]!.app.id = 999;
  assert.equal((await inspectGitHubCandidate(f.client, f.input)).checks.at(-1)?.status, "pending");
  f.protection.required_status_checks.strict = false;
  assert.equal((await inspectGitHubCandidate(f.client, f.input)).protectionEnforced, false);
  await assert.rejects(inspectGitHubCandidate(f.client, { ...f.input, changedPaths: ["policies/hidden.yaml"] }), /paths differ/);
  assert.deepEqual(f.counts(), { writes: 0, ready: 0 });
  const missing = githubFixture();
  Reflect.deleteProperty(missing.protection.required_status_checks, "checks");
  assert.equal((await inspectGitHubCandidate(missing.client, missing.input)).protectionEnforced, false,
    "observed CI is not evidence that GitHub enforces required checks");
});
test("GitHub merge reconciles a lost response without a duplicate write and refuses moved bases", async () => {
  const f = githubFixture(); const accepted = await candidate(f); f.ambiguous();
  const receipt = await mergeGitHubCandidate(f.client, f.input, accepted);
  assert.equal(receipt?.mergedCommit, merged);
  assert.deepEqual(await mergeGitHubCandidate(f.client, f.input, accepted), receipt);
  assert.deepEqual(f.counts(), { writes: 1, ready: 1 });
  const stale = githubFixture(); const old = await candidate(stale); stale.move();
  await assert.rejects(mergeGitHubCandidate(stale.client, stale.input, old), /prerequisites changed/);
  assert.deepEqual(stale.counts(), { writes: 0, ready: 0 });
});

test("unprotected repositories use exact fast-forward without querying paid protection", async () => {
  const f = githubFixture(); f.unprotected();
  const inspection = await inspectGitHubCandidate(f.client, f.input);
  assert.equal(inspection.protectionEnforced, false);
  assert.equal(inspection.mergeStrategy, "exact-fast-forward");
  const accepted = await candidate(f); f.ambiguous();
  const receipt = await mergeGitHubCandidate(f.client, f.input, accepted);
  assert.equal(receipt?.mergedCommit, commit); assert.equal(receipt?.mergedTree, tree);
  assert.equal(f.pull.merged, false, "receipt recovery does not depend on delayed PR metadata");
  assert.deepEqual(await mergeGitHubCandidate(f.client, f.input, accepted), receipt);
  assert.deepEqual(f.counts(), { writes: 1, ready: 1 }); assert.equal(f.protectionReads(), 0);
});

test("fast-forward refuses a main change at dispatch and never overwrites or incorporates it", async () => {
  const f = githubFixture(); f.unprotected(); const accepted = await candidate(f); f.race();
  await assert.rejects(mergeGitHubCandidate(f.client, f.input, accepted), /Target advanced/);
  assert.equal(f.counts().writes, 0);
  const rejected = githubFixture(); rejected.unprotected(); const next = await candidate(rejected); rejected.reject();
  assert.equal(await mergeGitHubCandidate(rejected.client, rejected.input, next), undefined);
  assert.equal(rejected.counts().writes, 0);
});

test("fast-forward requires independent checks and reapproval after hosted check or strategy changes", async () => {
  const f = githubFixture(); f.unprotected(); const accepted = await candidate(f);
  f.runs.check_runs[0]!.conclusion = "failure";
  await assert.rejects(mergeGitHubCandidate(f.client, f.input, accepted), /prerequisites changed/);
  f.runs.check_runs[0]!.conclusion = "success"; f.protect();
  await assert.rejects(mergeGitHubCandidate(f.client, f.input, accepted), /prerequisites changed/);
  assert.equal(f.counts().writes, 0);
  f.unprotected();
  await assert.rejects(inspectGitHubCandidate(f.client, { ...f.input, workbenchChecks: [] }), /evidence is incomplete/);
  f.runs.check_runs = [];
  f.runs.total_count = 0;
  const withoutOptionalCI = await inspectGitHubCandidate(f.client, f.input);
  assert.equal(withoutOptionalCI.checks.length, 3);
  assert.ok(withoutOptionalCI.checks.every((check) => check.status === "passed"));
});

test("observed check enumeration order does not invalidate the same confirmed result", async () => {
  const f = githubFixture(); f.unprotected();
  f.runs.check_runs.push({ ...f.runs.check_runs[0]!, id: 13, name: "lint" }); f.runs.total_count = 2;
  const before = await inspectGitHubCandidate(f.client, f.input);
  f.runs.check_runs.reverse();
  assert.equal((await inspectGitHubCandidate(f.client, f.input)).checksDigest, before.checksDigest);
});
function vercelFixture(reference = false) {
  const values = new Map<string, unknown>();
  const state: ReleasePrivateState = { get: async <T>(key: string) => structuredClone(values.get(key)) as T,
    set: async (key, value) => { values.set(key, structuredClone(value)); },
    setIfNotExists: async (key, value) => { if (values.has(key)) return false; values.set(key, structuredClone(value)); return true; } };
  const previous = { artifactHash: hash, instanceId: "synthetic-production", environment: "production" as const,
    coreCommit: core, workspaceCommit: base, configurationDigest: config, deploymentId: "dpl_previous" };
  const artifact = { ...previous, artifactHash: nextHash, workspaceCommit: merged };
  let active = "dpl_previous", creates = 0, promotions = 0, loseResponse = false, listVisible = true;
  let staged: any; let badHealth = false, unavailable = false;
  const fakeFetch: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url)); const path = parsed.pathname;
    let response: unknown;
    if (["synthetic.vercel.app", "staged.vercel.app"].includes(parsed.hostname)) {
      const current = parsed.hostname === "staged.vercel.app" ? { ...artifact, deploymentId: "dpl_next" }
        : active === previous.deploymentId ? previous : { ...artifact, deploymentId: active };
      if (unavailable) return Response.json({}, { status: 503 });
      response = { ok: true, status: "ready", ...current, ...(badHealth && parsed.hostname === "staged.vercel.app" ? { artifactHash: hash } : {}), sourceCoreCommit: current.coreCommit, instance: { id: current.instanceId, environment: "production" } };
    } else {
      assert.equal(parsed.hostname, "api.vercel.com"); assert.equal(parsed.searchParams.get("teamId"), "team_synthetic");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer service-secret");
      if (path === "/v9/projects/prj_synthetic") response = { id: "prj_synthetic", name: "synthetic", targets: { production: { id: active } } };
      else if (path === "/v13/deployments/dpl_previous") response = { id: previous.deploymentId, name: "synthetic", projectId: "prj_synthetic", target: "production", readyState: "READY", url: "synthetic.vercel.app" };
      else if (path === "/v6/deployments") response = { deployments: staged && listVisible ? [staged] : [] };
      else if (path === "/v13/deployments" && init?.method === "POST") {
        creates++; const body = JSON.parse(String(init.body));
        assert.equal(body.deploymentId, previous.deploymentId); assert.equal(body.withLatestCommit, false);
        assert.equal(body.target, "production"); assert.equal(body.autoAssignCustomDomains, false);
        assert.deepEqual(body.env, reference
          ? { COMPANYOS_ARTIFACT_HASH: nextHash, COMPANYOS_ARTIFACT_GZIP_BASE64: "" }
          : { COMPANYOS_ARTIFACT_HASH: "", COMPANYOS_ARTIFACT_GZIP_BASE64: "encoded-artifact" });
        assert.deepEqual(body.build.env, body.env);
        assert.equal(JSON.stringify(body).includes("service-secret"), false);
        staged = { id: "dpl_next", name: "synthetic", projectId: "prj_synthetic", target: "production", readyState: "READY", url: "staged.vercel.app", meta: body.meta };
        if (loseResponse) throw new Error("response lost after accepted deployment");
        response = staged;
      } else if (path === "/v13/deployments/dpl_next") response = staged;
      else if (path === "/v10/projects/prj_synthetic/promote/dpl_next" && init?.method === "POST") { promotions++; active = "dpl_next"; response = {}; }
      else throw new Error(`unexpected provider request ${path}`);
    }
    return Response.json(response);
  };
  const host = () => new VercelProductionReleaseHost({ binding: { projectId: "prj_synthetic", teamId: "team_synthetic", productionUrl: "https://synthetic.vercel.app" }, token: "service-secret", state, fetch: fakeFetch });
  return { host, previous, artifact, badHealth: () => { badHealth = true; }, unavailable: (value: boolean) => { unavailable = value; }, loseResponse: () => { loseResponse = true; }, hide: () => { listVisible = false; }, show: () => { listVisible = true; }, counts: () => ({ creates, promotions }) };
}
test("Vercel stages production with existing environment and reconciles uncertain creates across restart", async () => {
  const f = vercelFixture(); f.loseResponse(); f.hide();
  const args = { operationId: "release:building", previous: f.previous, artifact: f.artifact, encodedArtifact: "encoded-artifact" };
  assert.equal(await f.host().stage(args), undefined);
  assert.equal(await f.host().stage(args), undefined, "an unseen provider receipt is not permission to create again");
  assert.equal(f.counts().creates, 1);
  f.show(); assert.equal((await f.host().stage(args))?.id, "dpl_next");
  await assert.rejects(f.host().stage({ ...args, encodedArtifact: "changed" }), /different content/);
  assert.equal(f.counts().creates, 1);
});
test("Vercel promotion is separate from staging and only reports the verified current deployment", async () => {
  const f = vercelFixture(); const host = f.host();
  await host.stage({ operationId: "release:building", previous: f.previous, artifact: f.artifact, encodedArtifact: "encoded-artifact" });
  assert.equal((await host.current()).health.artifactHash, hash);
  const args = { deploymentId: "dpl_next", artifact: f.artifact, previousArtifactHash: hash };
  assert.equal(await host.promote(args), undefined);
  assert.equal((await f.host().promote(args))?.deploymentId, "dpl_next");
  assert.equal((await host.current()).health.artifactHash, nextHash);
  assert.deepEqual(f.counts(), { creates: 1, promotions: 1 });
});


test("a failed preflight can recover while a wrong staged build never reaches production", async () => {
  const f = vercelFixture();
  const args = { operationId: "release:building", previous: f.previous, artifact: f.artifact, encodedArtifact: "encoded-artifact" };
  f.unavailable(true); await assert.rejects(f.host().stage(args), /health is unavailable/);
  f.unavailable(false); assert.equal((await f.host().stage(args))?.id, "dpl_next");
  f.badHealth();
  await assert.rejects(f.host().promote({ deploymentId: "dpl_next", artifact: f.artifact, previousArtifactHash: hash }), /exact accepted/);
  assert.deepEqual(f.counts(), { creates: 1, promotions: 0 });
});


test("Vercel binds an exact retained Artifact without carrying its bytes through the environment", async () => {
  const f = vercelFixture(true); f.loseResponse();
  const args = { operationId: "reference:building", previous: f.previous, artifact: f.artifact,
    encodedArtifact: "x".repeat(100_000), retainedArtifactHash: nextHash };
  assert.equal(await f.host().stage(args), undefined);
  assert.equal((await f.host().stage(args))?.id, "dpl_next");
  await assert.rejects(f.host().stage({ ...args, retainedArtifactHash: hash }), /differs from the checked/);
  await assert.rejects(f.host().stage({ ...args, retainedArtifactHash: undefined }), /different content/);
  assert.deepEqual(f.counts(), { creates: 1, promotions: 0 });
});
