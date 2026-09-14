import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { GitHubAppRepositoryProvider } from "../../connectors/github-repository.ts";
import { InMemoryRepositoryInstallationStore } from "../adapter/in-memory-repository-installations.ts";
import { parseBrainRepositoryBinding } from "../../brain/repository-binding.ts";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const revision = "a".repeat(40), treeSha = "b".repeat(40), bytes = Buffer.from("---\ntype: topic\ntitle: Example\n---\nOrdinary knowledge.\n");
const blobSha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const binding = { instanceId: "example-test", bindingId: "workspace", repositoryId: "example/workspace", branch: "main" };
async function fixture(overrides: { entry?: Record<string, unknown>; tree?: Record<string, unknown>; blob?: Record<string, unknown>; ref?: Record<string, unknown> } = {}) {
  const requests: Array<{ url: string; method?: string; body?: unknown; signal?: AbortSignal | null }> = [];
  const installations = new InMemoryRepositoryInstallationStore();
  await installations.putVerified({ ...binding, providerId: "github-app", serviceEnvironment: "preview", installationId: "1001", providerRepositoryId: "2002",
    owner: "example", name: "workspace", defaultBranch: "main", status: "active", verifiedAt: "2030-01-01T00:00:00Z", updatedAt: "2030-01-01T00:00:00Z", providerReceipt: {} });
  const provider = new GitHubAppRepositoryProvider({ configuration: { appId: "42", privateKey: pem, serviceEnvironment: "preview", apiBaseUrl: "https://api.github.test" }, installations,
    fetch: async (input, init) => {
      const url = String(input); requests.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined, signal: init?.signal });
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
  for (const overrides of [{ tree: { truncated: true } }, { entry: { mode: "100755" } }, { entry: { mode: "120000" } },
    { entry: { type: "commit", mode: "160000" } }, { entry: { path: "brain/AGENTS.md" } }, { entry: { path: "brain/../outside.md" } },
    { blob: { content: Buffer.from("tampered").toString("base64") } }]) {
    const f = await fixture(overrides);
    await assert.rejects(f.provider.brainFiles(binding, revision));
    assert.equal(f.requests.at(-1)?.method, "DELETE");
    assert.ok(!f.requests.some(request => request.method === "PATCH" || request.method === "PUT"));
  }
});
