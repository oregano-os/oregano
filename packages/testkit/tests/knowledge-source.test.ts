import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitHubKnowledgeSourceConnector } from "../../connectors/github-knowledge-source.ts";
import { buildKnowledgeBundle } from "../../knowledge/okf.ts";
import { InMemoryKnowledgeSourceStore } from "../../knowledge/in-memory-source-store.ts";
import { createRuntimeObservation, proposeRuntimeObservationPromotion, runtimeObservationsToReviewCandidates } from "../../knowledge/observations.ts";
import { proposeSourcedKnowledgePromotion, syncKnowledgeSource } from "../../knowledge/source-ingestion.ts";
import type { KnowledgeSourceBinding, KnowledgeSourceRequirement } from "../../knowledge/source-contracts.ts";

const requirement: KnowledgeSourceRequirement = {
  version: 1,
  sourceId: "company-handbook-repository",
  kind: "repository-documents",
  dataOwner: "human:knowledge-steward",
  retention: { mode: "expire-after-days", days: 30 },
  legalHold: false,
  dataClass: "business",
  personalData: false,
  pathPrefix: "docs",
  includeExtensions: [".md"],
  maxObjectBytes: 64_000,
  staleAfterHours: 24,
};

const binding: KnowledgeSourceBinding = {
  version: 1,
  sourceId: requirement.sourceId,
  connector: "oregano/github-repository-source",
  connectorVersion: "1.0.0",
  secretRef: "env:TEST_GITHUB_TOKEN",
  owner: "example",
  repository: "company",
  ref: "main",
  apiBaseUrl: "https://api.example.test",
  requiredScopes: ["contents:read"],
};

const makeBundle = () => {
  const root = mkdtempSync(join(tmpdir(), "source-active-"));
  mkdirSync(join(root, "handbook"), { recursive: true });
  writeFileSync(join(root, "handbook", "index.md"), "---\ntype: index\ndescription: Index.\n---\n# Index\n\n- [Policy](policy.md)\n");
  writeFileSync(join(root, "handbook", "policy.md"), "---\ntype: concept\ndescription: Active policy.\n---\n# Policy\n\nEvery item has an owner.\n");
  const bundle = buildKnowledgeBundle({ workspaceRoot: root, workspaceCommit: "b".repeat(40) });
  rmSync(root, { recursive: true, force: true });
  return bundle;
};

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});

const sha = (character: string) => character.repeat(40);

test("repository source sync is read-only, cursor-idempotent, bounded, receipt-producing, and review-only", async () => {
  const docs = ["# Remote policy\n\nA remote claim requiring review.\n", "# Steps\n\nChecklist for a controlled renewal.\n"];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/repos/example/company")) return response({ full_name: "example/company" });
    if (url.includes("/git/trees/")) return response({ sha: sha("a"), truncated: false, tree: [
      { path: "docs/policy.md", type: "blob", sha: sha("b"), size: Buffer.byteLength(docs[0]) },
      { path: "docs/steps.md", type: "blob", sha: sha("c"), size: Buffer.byteLength(docs[1]) },
      { path: "private.txt", type: "blob", sha: sha("d"), size: 10 },
    ] });
    if (url.endsWith(`/git/blobs/${sha("b")}`)) return response({ encoding: "base64", content: Buffer.from(docs[0]).toString("base64") });
    if (url.endsWith(`/git/blobs/${sha("c")}`)) return response({ encoding: "base64", content: Buffer.from(docs[1]).toString("base64") });
    return response({ message: "not found" }, 404);
  };
  const connector = new GitHubKnowledgeSourceConnector({
    requirement,
    binding,
    resolveSecret: () => "secret-token-that-must-not-leak",
    fetch: fakeFetch,
    now: () => "2026-08-25T12:00:00.000Z",
    retryDelay: async () => {},
  });
  const store = new InMemoryKnowledgeSourceStore();
  const activeBundle = makeBundle();
  const first = await syncKnowledgeSource({ connector, store, requirement, binding, activeBundle, pageSize: 1 });
  assert.equal(first.complete, true);
  assert.equal(first.pages, 2);
  assert.equal(first.objects, 2);
  assert.equal(first.candidates.length, 2);
  assert.equal(activeBundle.documents.some((entry) => entry.body.includes("remote claim")), false);
  assert.ok(first.candidates.every((entry) => entry.status === "pending" && entry.sourceObject));
  assert.ok(calls.every((call) => call.init?.method === "GET"));
  assert.ok(calls.every((call) => (call.init?.headers as Record<string, string>).Authorization === "Bearer secret-token-that-must-not-leak"));
  assert.equal(JSON.stringify([...store.receipts.values(), ...store.envelopes.values()]).includes("secret-token-that-must-not-leak"), false);

  const second = await syncKnowledgeSource({ connector, store, requirement, binding, activeBundle, pageSize: 1, previousCandidateIds: first.candidates.map((entry) => entry.candidateId) });
  assert.equal(second.unchanged, 2);
  assert.equal(second.candidates.length, 0);
  const accepted = { ...first.candidates[0], status: "accepted" as const };
  const reference = accepted.sourceObject!;
  const envelope = await store.getEnvelope(reference.sourceId, reference.providerObjectId, reference.providerVersion);
  const proposal = proposeSourcedKnowledgePromotion({ candidate: accepted, envelope: envelope! });
  assert.ok(proposal.operations.some((entry) => entry.operation === "create"));
  assert.equal(activeBundle.documents.length, 1, "a proposal does not mutate or activate the bundle");
  assert.equal(await store.reconcileEnvelopes(requirement.sourceId, ["docs/policy.md"], "2026-09-30T12:00:00.000Z", requirement.retention), 1);
  store.sources.get(requirement.sourceId)!.requirement.legalHold = true;
  assert.equal(await store.purgeExpiredSourceContent(requirement.sourceId, "2026-11-01T12:00:00.000Z"), 0);
  store.sources.get(requirement.sourceId)!.requirement.legalHold = false;
  assert.equal(await store.purgeExpiredSourceContent(requirement.sourceId, "2026-11-01T12:00:00.000Z"), 1);
  assert.equal((await store.getEnvelope(requirement.sourceId, "docs/steps.md"))?.boundedText, undefined);
  assert.ok([...store.receipts.values()].some((entry) => entry.operation === "delete"));
});

test("repository source stops on truncated inventories and retries transient reads at most three times", async () => {
  let attempts = 0;
  const transient: typeof fetch = async (input) => {
    if (String(input).endsWith("/repos/example/company")) {
      attempts += 1;
      return response({ message: "retry" }, 503);
    }
    return response({ sha: sha("a"), truncated: true, tree: [] });
  };
  const connector = new GitHubKnowledgeSourceConnector({ requirement, binding, resolveSecret: () => "token", fetch: transient, retryDelay: async () => {} });
  await assert.rejects(() => connector.verify(), /bounded retry/);
  assert.equal(attempts, 3);

  const truncated = new GitHubKnowledgeSourceConnector({
    requirement,
    binding,
    resolveSecret: () => "token",
    fetch: async (input) => String(input).endsWith("/repos/example/company")
      ? response({ full_name: "example/company" })
      : response({ sha: sha("a"), truncated: true, tree: [] }),
  });
  await assert.rejects(() => truncated.enumerate(), /truncated/);
});

test("retain source policy keeps provider-deleted content without relying on legal hold", async () => {
  const retainedRequirement: KnowledgeSourceRequirement = {
    ...requirement,
    sourceId: "retained-company-policies",
    retention: { mode: "retain" },
  };
  const retainedBinding: KnowledgeSourceBinding = {
    ...binding,
    sourceId: retainedRequirement.sourceId,
  };
  const store = new InMemoryKnowledgeSourceStore();
  await store.registerSource(retainedRequirement, retainedBinding);
  await store.upsertEnvelope({
    sourceId: retainedRequirement.sourceId,
    providerObjectId: "docs/policy.md",
    providerVersion: sha("e"),
    observedAt: "2026-08-25T12:00:00.000Z",
    mediaType: "text/markdown",
    contentDigest: sha("f"),
    ownerOrAccount: "example/company",
    cursorOrEventId: "tree:main",
    deletionState: "present",
    receiptMetadata: {},
    boundedText: "# Policy\n\nRetain this content.\n",
  }, retainedRequirement.retention);

  assert.equal(await store.reconcileEnvelopes(
    retainedRequirement.sourceId,
    [],
    "2026-09-01T12:00:00.000Z",
    retainedRequirement.retention,
  ), 1);
  assert.equal(await store.purgeExpiredSourceContent(retainedRequirement.sourceId, "9999-12-31T23:59:59.999Z"), 0);
  assert.equal((await store.getEnvelope(retainedRequirement.sourceId, "docs/policy.md"))?.boundedText, "# Policy\n\nRetain this content.\n");
  assert.equal(store.sources.get(retainedRequirement.sourceId)?.requirement.legalHold, false);
});

test("runtime observations supersede, expire, honor legal hold, redact on deletion, and remain review-only", async () => {
  const store = new InMemoryKnowledgeSourceStore();
  const first = createRuntimeObservation({
    subject: "renewal-state", content: "Renewal review is pending.", observedAt: "2026-08-25T10:00:00Z",
    expiresAt: "2026-08-26T10:00:00Z", runId: "run-1", agentId: "agent:ops", evidence: { step: "check" }, personalData: false,
  });
  const replacement = createRuntimeObservation({
    subject: "renewal-state", content: "Renewal review completed.", observedAt: "2026-08-25T11:00:00Z",
    expiresAt: "2026-08-27T11:00:00Z", runId: "run-2", agentId: "agent:ops", evidence: { step: "complete" }, supersedes: first.observationId, personalData: false,
  });
  assert.equal(await store.recordObservation(first), true);
  assert.equal(await store.recordObservation(replacement), true);
  assert.equal(store.observations.get(first.observationId)?.status, "superseded");
  assert.deepEqual((await store.listObservationPromotionCandidates()).map((entry) => entry.observationId), [replacement.observationId]);
  const candidates = runtimeObservationsToReviewCandidates({ observations: [replacement], activeBundle: makeBundle() });
  assert.equal(candidates.length, 1);
  const proposal = proposeRuntimeObservationPromotion({ candidate: { ...candidates[0], status: "accepted" }, observation: replacement });
  assert.ok(proposal.operations.some((entry) => entry.operation === "create"));
  await store.requestObservationDeletion(replacement.observationId, "human:steward", "Retention request");
  await store.setObservationLegalHold(replacement.observationId, true, "human:legal");
  assert.equal(await store.applyObservationDeletion(replacement.observationId), "held");
  await store.setObservationLegalHold(replacement.observationId, false, "human:legal");
  assert.equal(await store.applyObservationDeletion(replacement.observationId), "deleted");
  assert.equal(store.observations.get(replacement.observationId)?.content, "");

  const expiring = createRuntimeObservation({
    subject: "temporary", content: "Temporary status.", observedAt: "2026-08-20T10:00:00Z",
    expiresAt: "2026-08-21T10:00:00Z", runId: "run-3", agentId: "agent:ops", evidence: {}, personalData: false,
  });
  await store.recordObservation(expiring);
  assert.equal(await store.expireObservations("2026-08-25T10:00:00Z"), 1);
  assert.equal(store.observations.get(expiring.observationId)?.status, "expired");
});
