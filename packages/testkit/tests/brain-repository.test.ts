import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { GitHubAppRepositoryProvider } from "../../connectors/github-repository.ts";
import { InMemoryRepositoryInstallationStore } from "../adapter/in-memory-repository-installations.ts";
import { parseBrainRepositoryBinding } from "../../brain/repository-binding.ts";
import { sha256 } from "../../runtime/canonical.ts";
import type { BrainRepositoryCommitRequest } from "../../runtime/repository/contracts.ts";
import { CapabilityEffectOutcomeUnknownError } from "../../capabilities/contracts.ts";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const revision = "a".repeat(40), treeSha = "b".repeat(40), bytes = Buffer.from("---\ntype: topic\ntitle: Example\n---\nOrdinary knowledge.\n");
const blobSha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const binding = { instanceId: "example-test", bindingId: "workspace", repositoryId: "example/workspace", branch: "main" };
async function fixture(overrides: { entry?: Record<string, unknown>; tree?: Record<string, unknown>; blob?: Record<string, unknown>; ref?: Record<string, unknown>;
  response?: (url: string, body: any) => Response | undefined } = {}) {
  const requests: Array<{ url: string; method?: string; body?: unknown; signal?: AbortSignal | null }> = [];
  const installations = new InMemoryRepositoryInstallationStore();
  await installations.putVerified({ ...binding, providerId: "github-app", serviceEnvironment: "preview", installationId: "1001", providerRepositoryId: "2002",
    owner: "example", name: "workspace", defaultBranch: "main", status: "active", verifiedAt: "2030-01-01T00:00:00Z", updatedAt: "2030-01-01T00:00:00Z", providerReceipt: {} });
  const provider = new GitHubAppRepositoryProvider({ configuration: { appId: "42", privateKey: pem, serviceEnvironment: "preview", apiBaseUrl: "https://api.github.test" }, installations,
    fetch: async (input, init) => {
      const url = String(input); requests.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined, signal: init?.signal });
      const selected = overrides.response?.(url, init?.body ? JSON.parse(String(init.body)) : undefined);
      if (selected) return selected;
      if (url.endsWith("/access_tokens")) return Response.json({ token: "fixture-token", expires_at: "2030-01-01T01:00:00Z" });
      if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
      if (url.includes("/git/ref/heads/")) return Response.json({ ref: "refs/heads/main", object: { type: "commit", sha: revision }, ...overrides.ref });
      if (url.endsWith(`/git/commits/${revision}`)) return Response.json({ sha: revision, tree: { sha: treeSha } });
      if (url.includes("/git/trees/")) return Response.json({ truncated: false, tree: [{ path: "brain", mode: "040000", type: "tree", sha: treeSha },
        { path: "brain/topics/example.md", mode: "100644", type: "blob", sha: blobSha, size: bytes.length, ...overrides.entry },
        { path: "handbook/private.md", mode: "100644", type: "blob", sha: "c".repeat(40), size: 200 }], ...overrides.tree });
      if (url.endsWith(`/git/blobs/${blobSha}`)) return Response.json({ sha: blobSha, encoding: "base64", size: bytes.length, content: bytes.toString("base64"), ...overrides.blob });
      throw new Error("Unexpected repository operation");
    } });
  return { provider, requests, installations };
}

test("Brain GitHub reads use existing narrow installation authority, exact commits and ordinary Brain blobs", async () => {
  const f = await fixture();
  assert.equal(await f.provider.brainRevision(binding), revision);
  assert.deepEqual(await f.provider.brainFiles(binding, revision), { "brain/topics/example.md": bytes.toString() });
  assert.equal(f.requests.filter(request => request.url.includes("/git/blobs/")).length, 1);
  assert.ok(f.requests.every(request => request.signal instanceof AbortSignal));
  assert.ok(f.requests.filter(request => request.url.endsWith("/access_tokens")).every(request => JSON.stringify(request.body) === JSON.stringify({ repository_ids: [2002], permissions: { contents: "read" } })));
  assert.equal(f.requests.filter(request => request.method === "DELETE").length, 2, "Release short-lived tokens after each bounded operation");
});

const nextCommit = "d".repeat(40);
const commitRequest = (): BrainRepositoryCommitRequest => ({ binding, baseCommit: revision, operationId: "e".repeat(64), inputDigest: "f".repeat(64),
  changes: [{ path: "brain/topics/example.md", expectedContentHash: sha256(bytes.toString()), markdown: bytes.toString().replace("Ordinary knowledge.", "Revised sourced knowledge.") }] });
const commitMessage = (request: BrainRepositoryCommitRequest) => `Update sourced Brain knowledge\n\nCompanyOS-Brain-Operation: ${request.operationId}\nCompanyOS-Brain-Input: ${request.inputDigest}`;

test("Brain publication is one expected-head atomic API operation with only repository content-write authority", async () => {
  const request = commitRequest();
  const f = await fixture({ response: (url, body) => {
    if (!url.endsWith("/graphql")) return undefined;
    assert.ok(body.query.includes("createCommitOnBranch"));
    assert.equal(body.variables.input.expectedHeadOid, revision);
    assert.deepEqual(body.variables.input.branch, { repositoryNameWithOwner: binding.repositoryId, branchName: binding.branch });
    assert.equal(Buffer.from(body.variables.input.fileChanges.additions[0].contents, "base64").toString(), request.changes[0].markdown);
    assert.deepEqual(body.variables.input.fileChanges.deletions, []);
    return Response.json({ data: { createCommitOnBranch: { commit: { oid: nextCommit, message: commitMessage(request), parents: { nodes: [{ oid: revision }] } } } } });
  } });
  assert.deepEqual(await f.provider.brainCommit(request), { repositoryId: binding.repositoryId, branch: binding.branch, baseCommit: revision,
    commit: nextCommit, operationId: request.operationId, inputDigest: request.inputDigest });
  assert.equal(f.requests.filter(request => request.url.endsWith("/graphql")).length, 1);
  const tokens = f.requests.filter(request => request.url.endsWith("/access_tokens")).map(request => request.body as any);
  assert.equal(tokens.filter(body => body.permissions.contents === "write").length, 1);
  assert.ok(tokens.every(body => Object.keys(body.permissions).join() === "contents"));
  assert.ok(!f.requests.some(request => ["PATCH", "PUT"].includes(request.method ?? "")));
  assert.equal(f.requests.filter(request => request.url.endsWith("/installation/token")).length, tokens.length);
});

test("Brain write path and Git mode checks precede any content-write credential or mutation", async () => {
  for (const forbidden of ["company.md", "brain/../company.md", "brain/AGENTS.md", "brain/topics/SKILL.md", "brain/config.md", "brain/topics/a.ts"]) {
    const f = await fixture(), request = commitRequest();
    await assert.rejects(f.provider.brainCommit({ ...request, changes: [{ ...request.changes[0], path: forbidden }] }));
    assert.equal(f.requests.length, 0);
  }
  for (const entry of [{ mode: "120000" }, { mode: "100755" }, { mode: "160000", type: "commit" }]) {
    const f = await fixture({ entry }); await assert.rejects(f.provider.brainCommit(commitRequest()));
    assert.ok(!f.requests.some(request => (request.body as any)?.permissions?.contents === "write"));
    assert.ok(!f.requests.some(request => request.url.endsWith("/graphql")));
  }
  const f = await fixture(), request = commitRequest();
  await assert.rejects(f.provider.brainCommit({ ...request, changes: [{ ...request.changes[0], expectedContentHash: "0".repeat(64) }] }), /expected content/);
  assert.ok(!f.requests.some(request => request.url.endsWith("/graphql")));
  for (const markdown of [bytes.toString(), "Invalid UTF-8 \ud800"]) {
    await assert.rejects(f.provider.brainCommit({ ...request, changes: [{ ...request.changes[0], markdown }] }));
  }
  assert.ok(!f.requests.some(request => (request.body as any)?.permissions?.contents === "write"));
});

test("Brain push notifications require a valid signature and exact active installation, repository and branch", async () => {
  const f = await fixture(), secret = "synthetic-webhook-key";
  const event = (override: Record<string, unknown> = {}) => {
    const rawBody = JSON.stringify({ repository: { full_name: binding.repositoryId, id: 2002 }, installation: { id: 1001 }, ref: "refs/heads/main", after: revision, ...override });
    return { event: "push", deliveryId: "synthetic-delivery", rawBody, webhookSecret: secret, signature: `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}` };
  };
  assert.deepEqual(await f.provider.brainPush(binding, event()), { delivery_id: "synthetic-delivery", commit: revision });
  await assert.rejects(f.provider.brainPush(binding, { ...event(), signature: "sha256=" + "0".repeat(64) }), /signature/);
  await assert.rejects(f.provider.brainPush(binding, event({ installation: { id: 999 } })), /identity/);
  await assert.rejects(f.provider.brainPush(binding, event({ repository: { full_name: binding.repositoryId, id: 999 } })), /identity/);
  assert.equal(await f.provider.brainPush(binding, event({ ref: "refs/heads/unbound" })), undefined);
  assert.equal(await f.provider.brainPush(binding, event({ deleted: true })), undefined);
  assert.equal(await f.provider.brainPush(binding, event({ repository: { full_name: "other/workspace", id: 2002 } })), undefined);
  assert.equal(f.requests.length, 0, "A notification neither mints repository credentials nor mutates Git");
  await f.installations.updateStatus({ providerId: "github-app", installationId: "1001", status: "revoked", providerReceipt: {} });
  await assert.rejects(f.provider.brainPush(binding, event()), /active/);
});

test("repository policy and moved-head failures cannot force a branch or claim a successful commit", async () => {
  const policy = await fixture({ response: url => url.endsWith("/graphql") ? Response.json({ data: { createCommitOnBranch: null }, errors: [{ type: "FORBIDDEN" }] }) : undefined });
  await assert.rejects(policy.provider.brainCommit(commitRequest()), /governed review/);
  const ref: Record<string, unknown> = {};
  const changed = await fixture({ ref, response: url => {
    if (!url.endsWith("/graphql")) return undefined;
    ref.object = { type: "commit", sha: "9".repeat(40) };
    return Response.json({ data: { createCommitOnBranch: null }, errors: [{ type: "EXPECTED_HEAD_MISMATCH" }] });
  } });
  await assert.rejects(changed.provider.brainCommit(commitRequest()), /changed during publication/);
  const uncertain = await fixture({ response: url => url.endsWith("/graphql") ? Response.json({ data: { createCommitOnBranch: { commit: { oid: nextCommit } } } }) : undefined });
  await assert.rejects(uncertain.provider.brainCommit(commitRequest()), error => error instanceof CapabilityEffectOutcomeUnknownError);
  const transport = await fixture({ response: url => url.endsWith("/graphql") ? new Response("provider unavailable", { status: 503 }) : undefined });
  await assert.rejects(transport.provider.brainCommit(commitRequest()), error => error instanceof CapabilityEffectOutcomeUnknownError);
  for (const f of [policy, changed, uncertain, transport]) assert.equal(f.requests.filter(request => request.url.endsWith("/graphql")).length, 1);
});

test("uncertain commit reconciliation checks operation, parent, complete changed-file count and exact contents without writing", async () => {
  const request = commitRequest(), nextBytes = Buffer.from(request.changes[0].markdown!);
  const nextTree = "7".repeat(40), nextBlob = createHash("sha1").update(`blob ${nextBytes.length}\0`).update(nextBytes).digest("hex");
  const candidate = { oid: nextCommit, message: commitMessage(request), changedFilesIfAvailable: 1, parents: { nodes: [{ oid: revision }] } };
  const f = await fixture({ response: url => {
    if (url.endsWith("/graphql")) return Response.json({ data: { repository: { ref: { target: { history: { nodes: [candidate] } } } } } });
    if (url.endsWith(`/git/commits/${nextCommit}`)) return Response.json({ sha: nextCommit, tree: { sha: nextTree } });
    if (url.includes(`/git/trees/${nextTree}`)) return Response.json({ truncated: false, tree: [{ path: request.changes[0].path, mode: "100644", type: "blob", sha: nextBlob, size: nextBytes.length }] });
    if (url.endsWith(`/git/blobs/${nextBlob}`)) return Response.json({ sha: nextBlob, encoding: "base64", size: nextBytes.length, content: nextBytes.toString("base64") });
    return undefined;
  } });
  assert.equal((await f.provider.brainFindCommit(request))?.commit, nextCommit);
  assert.ok(f.requests.filter(request => request.url.endsWith("/access_tokens")).every(request => (request.body as any).permissions.contents === "read"));
  candidate.changedFilesIfAvailable = 2;
  await assert.rejects(f.provider.brainFindCommit(request), /matching bounded commit/);
  candidate.changedFilesIfAvailable = 1; candidate.parents.nodes[0].oid = "0".repeat(40);
  await assert.rejects(f.provider.brainFindCommit(request), /matching bounded commit/);
  const absent = await fixture({ response: url => url.endsWith("/graphql") ? Response.json({ data: { repository: { ref: { target: { history: { nodes: [] } } } } } }) : undefined });
  assert.equal(await absent.provider.brainFindCommit(request), undefined, "Absence remains unresolved rather than silently resending");
});

test("Brain repository authority rejects malformed, foreign, suspended and mismatched branch requests", async () => {
  const f = await fixture();
  for (const branch of ["../main", "a//b", "a/.b", "a.lock/b", "a.", "a/%2e", "a\\b"]) await assert.rejects(f.provider.brainRevision({ ...binding, branch }), /safe branch/);
  await assert.rejects(f.provider.brainRevision({ ...binding, bindingId: undefined } as any), /existing installation/);
  await assert.rejects(f.provider.brainRevision({ ...binding, instanceId: "other" }), /another Instance/);
  assert.equal(f.requests.length, 0, "Rejected authority never requests credentials");
  await f.installations.updateStatus({ providerId: "github-app", installationId: "1001", status: "suspended", providerReceipt: {} });
  await assert.rejects(f.provider.brainRevision(binding), /inactive/);
  const wrong = await fixture({ ref: { ref: "refs/heads/other" } });
  await assert.rejects(wrong.provider.brainRevision(binding), /invalid branch revision/);
  assert.equal(wrong.requests.at(-1)?.method, "DELETE");
  assert.throws(() => parseBrainRepositoryBinding({ repository_binding_id: "workspace", repository_id: "example/workspace", branch: "main", token: "forbidden" }, binding.instanceId), /Unsupported/);
});

test("incomplete inventories, executable/symlink paths and unverifiable content fail before projection publication", async () => {
  const duplicate = { path: "brain/topics/example.md", mode: "100644", type: "blob", sha: blobSha, size: bytes.length };
  for (const overrides of [{ tree: { truncated: true } }, { tree: { tree: [duplicate, duplicate] } }, { entry: { mode: "100755" } }, { entry: { mode: "120000" } },
    { entry: { type: "commit", mode: "160000" } }, { entry: { path: "brain/AGENTS.md" } }, { entry: { path: "brain/../outside.md" } },
    { blob: { content: Buffer.from("tampered").toString("base64") } }]) {
    const f = await fixture(overrides);
    await assert.rejects(f.provider.brainFiles(binding, revision));
    assert.equal(f.requests.at(-1)?.method, "DELETE");
    assert.ok(!f.requests.some(request => request.method === "PATCH" || request.method === "PUT"));
  }
});
