import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepositoryInstallationBinding } from "../../../../state-store/repository-installations.ts";
import { handleGitHubRepositoryOnboarding } from "./repository-onboarding.ts";

const input = {
  binding_id: "github-workspace",
  instance_id: "fixture-production",
  installation_id: "1001",
  repository_id: "acme/workspace",
  provider_repository_id: "2002",
  onboarding_principal: "companyos:user:1",
};

test("repository onboarding rejects a request before provider resolution without the exact secret", async () => {
  let providerCalled = false;
  const response = await handleGitHubRepositoryOnboarding(request("wrong"), {
    secret: "expected",
    provider: { async verifyInstallation() { providerCalled = true; return binding(); } },
  });
  assert.equal(response.status, 401);
  assert.equal(providerCalled, false);
});

test("repository onboarding validates the bounded request and returns non-secret binding evidence", async () => {
  let observed: unknown;
  const response = await handleGitHubRepositoryOnboarding(request("expected"), {
    secret: "expected",
    provider: { async verifyInstallation(value) { observed = value; return binding(); } },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(observed, {
    bindingId: input.binding_id,
    instanceId: input.instance_id,
    installationId: input.installation_id,
    repositoryId: input.repository_id,
    providerRepositoryId: input.provider_repository_id,
    onboardingPrincipal: input.onboarding_principal,
  });
  assert.deepEqual(await response.json(), {
    ok: true,
    binding: {
      bindingId: "github-workspace",
      instanceId: "fixture-production",
      providerId: "github-app",
      repositoryId: "acme/workspace",
      status: "active",
      verifiedAt: "2026-08-26T10:00:00.000Z",
    },
  });
});

function request(secret: string): Request {
  return new Request("https://companyos.invalid/api/repository/github/installations", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });
}

function binding(): RepositoryInstallationBinding {
  return {
    bindingId: "github-workspace",
    instanceId: "fixture-production",
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
    providerReceipt: {},
  };
}
