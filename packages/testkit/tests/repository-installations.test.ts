import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepositoryInstallationBinding } from "../../state-store/repository-installations.ts";
import { InMemoryRepositoryInstallationStore } from "../adapter/in-memory-repository-installations.ts";

const binding = (): RepositoryInstallationBinding => ({
  bindingId: "github-workspace",
  instanceId: "acme-production",
  providerId: "github-app",
  serviceEnvironment: "production",
  installationId: "1001",
  providerRepositoryId: "2002",
  repositoryId: "acme/workspace",
  owner: "acme",
  name: "workspace",
  defaultBranch: "main",
  status: "active",
  verifiedAt: "2026-08-26T10:00:00.000Z",
  updatedAt: "2026-08-26T10:00:00.000Z",
  providerReceipt: { account: "acme", selection: "selected" },
});

test("repository installation state stores verified non-secret identity", async () => {
  const store = new InMemoryRepositoryInstallationStore();
  await store.putVerified(binding());
  assert.equal((await store.requireActive("github-workspace", "acme/workspace")).installationId, "1001");
  await assert.rejects(
    store.putVerified({ ...binding(), installationId: "different" }),
    /conflicts with verified identity/,
  );
  await assert.rejects(
    store.putVerified({ ...binding(), providerReceipt: { access_token: "never-store-this" } }),
    /credential-like material/,
  );
});

test("repository installation suspension and revocation fail closed", async () => {
  const store = new InMemoryRepositoryInstallationStore();
  await store.putVerified(binding());
  assert.equal(await store.updateStatus({
    providerId: "github-app",
    installationId: "1001",
    status: "suspended",
    providerReceipt: { event: "installation.suspend" },
  }), 1);
  await assert.rejects(
    store.requireActive("github-workspace", "acme/workspace"),
    /inactive/,
  );
  assert.equal(await store.updateStatus({
    providerId: "github-app",
    installationId: "1001",
    status: "revoked",
    providerReceipt: { event: "installation.deleted" },
  }), 1);
  assert.equal((await store.get("github-workspace"))?.status, "revoked");
});
