import assert from "node:assert/strict";
import { test } from "node:test";
import { builderFunctionalFixture } from "../../../../testkit/builder-functional-fixture.ts";
import { parseInstanceBuildConfiguration } from "../../../../companyos-builder/instance-loader.ts";
import { sha256 } from "../../../../runtime/canonical.ts";
import { releaseAuthorization } from "../../../../runtime/release/policy.ts";
import { builderTestResultDigest } from "../../../../runtime/builder/functional-tests.ts";
import type { ReleaseCandidate, WorkspaceReleasePolicy } from "../../../../runtime/release/contracts.ts";
import { HostedBuilderReleaseAdapter } from "./live-release-adapter.ts";

async function fixture() {
  const f = builderFunctionalFixture();
  await f.store.create(f.session);
  await f.tests.begin(f.session.id, f.candidate.artifactHash, "slack:C20002:2.0");
  const session = await f.tests.recordResult(f.session.id, { artifactHash: f.candidate.artifactHash,
    candidateCommit: f.candidate.provenance.workspaceCommit, executionDigest: f.session.scopeDigest,
    completedAt: new Date().toISOString(), summary: "Synthetic tested result", evidence: { synthetic: true } });
  const instanceYaml = `version: 1\ninstance_id: ${f.previous.instance.id}\nenvironment: production\nbindings: []\n`;
  const configurationDigest = sha256(parseInstanceBuildConfiguration(instanceYaml));
  const rule = { mode: "requester" as const, eligible: { members: ["mara-steward"], groups: [] }, independent: false };
  const policy: WorkspaceReleasePolicy = { version: 1, acceptance: { content: rule, behavior: rule, security: { ...rule, mode: "steward" } }, deployers: rule.eligible };
  const artifact = { ...f.previous, instance: { ...f.previous.instance, environment: "production" },
    builder: { ...f.previous.builder!, repository: { repositoryId: f.job.repositoryId, sourceBinding: "source", proposalPublisherBinding: "publisher", targetBranchName: "main" } },
    builderReleasePolicy: policy, provenance: { ...f.previous.provenance, instanceConfigurationDigest: configurationDigest } };
  const candidate: ReleaseCandidate = { version: 1, id: f.job.jobId, instanceId: artifact.instance.id,
    repositoryId: f.job.repositoryId, requester: f.job.requesterPrincipal, sourceConversation: f.job.sourceConversationKey,
    targetBranch: "main", baseCommit: f.job.baseCommit, candidateCommit: f.session.candidateCommit,
    candidateTree: "f".repeat(40), coreCommit: artifact.provenance.coreCommit, configurationDigest,
    policyDigest: releaseAuthorization(policy, artifact.roster).policyDigest, diffDigest: "1".repeat(64),
    checksDigest: "2".repeat(64), previousArtifactHash: artifact.artifactHash, requiredChecks: ["validate"],
    changeClass: "behavior", functionalTestDigest: builderTestResultDigest(session) };
  const values = new Map<string, unknown>();
  values.set(`release:candidate:${sha256([artifact.instance.id, candidate.id])}`, { candidate, job: f.job, github: {}, previous: {} });
  let providerCalls = 0;
  const adapter = new HostedBuilderReleaseAdapter({ artifact, functionalTests: f.tests,
    state: { get: async <T>(key: string) => structuredClone(values.get(key)) as T,
      set: async (key: string, value: unknown) => { values.set(key, value); },
      setIfNotExists: async (key: string, value: unknown) => { if (values.has(key)) return false; values.set(key, value); return true; } },
    host: { current: async () => ({ health: { artifactHash: artifact.artifactHash, instanceId: artifact.instance.id } }) },
    github: { withReleaseClient: async () => { providerCalls++; throw new Error("synthetic-provider-reached"); } },
    compiler: {}, artifacts: {}, environment: { NODE_ENV: "test" },
  } as unknown as ConstructorParameters<typeof HostedBuilderReleaseAdapter>[0]);
  return { ...f, candidate, adapter, providerCalls: () => providerCalls };
}

test("the hosted adapter checks current human authority before freezing functional acceptance", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.adapter.acceptFunctionalTest(f.candidate, "slack:T10001:U10002", "foreign-action"), /required acceptor/);
    assert.equal((await f.store.get(f.session.id))?.stage, "reviewable");
    await assert.rejects(f.adapter.inspect(f.candidate), /no current/);
    assert.equal(f.providerCalls(), 0);
    await f.adapter.acceptFunctionalTest(f.candidate, f.session.requester, "actual-click");
    await f.adapter.acceptFunctionalTest(f.candidate, f.session.requester, "replayed-click");
    assert.equal((await f.store.get(f.session.id))?.acceptance?.actionId, "actual-click");
    await assert.rejects(f.adapter.inspect(f.candidate), /synthetic-provider-reached/);
    assert.equal(f.providerCalls(), 1, "provider inspection is reachable only after exact acceptance");
  } finally { f.cleanup(); }
});

test("a displayed live action cannot accept or dispatch a merge after changes were requested", async () => {
  const f = await fixture();
  try {
    await f.tests.requestFeedback(f.session.id, f.session.requester);
    await assert.rejects(f.adapter.acceptFunctionalTest(f.candidate, f.session.requester, "stale-click"), /no current/);
    await assert.rejects(f.adapter.merge({ candidate: f.candidate, operationId: "stale-release" }), /no current/);
    assert.equal(f.providerCalls(), 0);
    assert.equal((await f.store.get(f.session.id))?.stage, "feedback-pending");
  } finally { f.cleanup(); }
});
