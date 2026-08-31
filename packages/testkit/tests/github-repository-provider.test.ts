import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  GitHubAppRepositoryProvider,
  gitHubGitCredentialEnvironment,
  trustedGitCredentialBinding,
} from "../../connectors/github-repository.ts";
import {
  checkedProposalFromInspection,
  inspectProposalWorkspace,
  sha256,
} from "../../runtime/repository/proposal-inspection.ts";
import type { TrustedGitExecutionAdapter } from "../../runtime/repository/trusted-git-execution.ts";
import { InMemoryRepositoryInstallationStore } from "../adapter/in-memory-repository-installations.ts";

function providerFixture() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const requests: Array<{ url: string; authorization: string; body?: string }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const authorization = String(new Headers(init?.headers).get("authorization"));
    requests.push({ url, authorization, body: init?.body ? String(init.body) : undefined });
    if (url.endsWith("/app/installations/1001/access_tokens")) {
      return Response.json({ token: "short-lived-installation-token", expires_at: "2026-08-26T11:00:00.000Z" });
    }
    if (url.endsWith("/app/installations/1001")) {
      return Response.json({
        id: 1001,
        account: { login: "acme", type: "Organization" },
        repository_selection: "selected",
        suspended_at: null,
      });
    }
    if (url.endsWith("/repositories/2002")) {
      return Response.json({
        id: 2002,
        name: "workspace",
        full_name: "acme/workspace",
        default_branch: "main",
        owner: { login: "acme" },
      });
    }
    if (url.endsWith("/installation/token") && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  };
  const installations = new InMemoryRepositoryInstallationStore();
  const provider = new GitHubAppRepositoryProvider({
    configuration: {
      appId: "42",
      privateKey: pem,
      serviceEnvironment: "production",
      apiBaseUrl: "https://api.github.test",
    },
    installations,
    fetch: fakeFetch,
    now: () => new Date("2026-08-26T10:00:00.000Z"),
  });
  return { provider, installations, requests };
}

test("GitHub Git authentication uses the installation token as an HTTP Basic password", () => {
  const token = "short-lived-installation-token";
  const environment = gitHubGitCredentialEnvironment(token);
  assert.equal(environment.GIT_CONFIG_COUNT, "1");
  assert.equal(environment.GIT_CONFIG_KEY_0, "http.extraHeader");
  assert.equal(
    environment.GIT_CONFIG_VALUE_0,
    `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  );
  assert.equal(environment.GIT_CONFIG_VALUE_0?.includes(token), false);
});

test("GitHub trusted-Git binding keeps the installation token out of the Git environment", () => {
  const token = "short-lived-installation-token";
  const binding = trustedGitCredentialBinding("https://github.test", token);
  assert.equal(binding.host, "github.test");
  assert.match(binding.placeholderAuthorization, /^Basic /);
  assert.match(binding.realAuthorization, /^Basic /);
  assert.notEqual(binding.placeholderAuthorization, binding.realAuthorization);
  assert.equal(binding.placeholderAuthorization.includes(token), false);
  assert.equal(binding.realAuthorization.includes(token), false);
  assert.equal(
    Buffer.from(binding.realAuthorization.slice("Basic ".length), "base64").toString("utf8"),
    `x-access-token:${token}`,
  );
});

test("GitHub App onboarding verifies one selected repository and stores no token", async () => {
  const fixture = providerFixture();
  const binding = await fixture.provider.verifyInstallation({
    bindingId: "github-workspace",
    instanceId: "acme-production",
    installationId: "1001",
    repositoryId: "acme/workspace",
    providerRepositoryId: "2002",
    onboardingPrincipal: "companyos:user:1",
  });
  assert.equal(binding.status, "active");
  assert.equal(binding.repositoryId, "acme/workspace");
  assert.equal(JSON.stringify(binding).includes("short-lived-installation-token"), false);
  assert.match(fixture.requests[0]!.authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  assert.equal(
    fixture.requests.some((request) => request.authorization === "Bearer short-lived-installation-token"),
    true,
  );
  const tokenRequest = fixture.requests.find((request) => request.url.endsWith("/access_tokens"));
  assert.deepEqual(JSON.parse(tokenRequest?.body ?? "{}"), {
    repository_ids: [2002],
    permissions: { contents: "read" },
  });
  assert.equal(fixture.requests.at(-1)?.url.endsWith("/installation/token"), true);
});

test("GitHub installation events are signature checked and suspension fails closed", async () => {
  const fixture = providerFixture();
  await fixture.provider.verifyInstallation({
    bindingId: "github-workspace",
    instanceId: "acme-production",
    installationId: "1001",
    repositoryId: "acme/workspace",
    providerRepositoryId: "2002",
    onboardingPrincipal: "companyos:user:1",
  });
  const rawBody = JSON.stringify({ action: "suspend", installation: { id: 1001 } });
  const webhookSecret = "test-webhook-secret";
  const signature = `sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`;
  assert.equal(await fixture.provider.reconcileInstallationEvent({
    deliveryId: "delivery-1",
    event: "installation",
    rawBody,
    signature,
    webhookSecret,
  }), 1);
  await assert.rejects(
    fixture.installations.requireActive("github-workspace", "acme/workspace"),
    /inactive/,
  );
  await assert.rejects(
    fixture.provider.reconcileInstallationEvent({
      deliveryId: "delivery-2",
      event: "installation",
      rawBody,
      signature: "sha256=invalid",
      webhookSecret,
    }),
    /signature is invalid/,
  );
});

test("GitHub selected-repository removal revokes only the affected binding", async () => {
  const fixture = providerFixture();
  await fixture.provider.verifyInstallation({
    bindingId: "github-workspace",
    instanceId: "acme-production",
    installationId: "1001",
    repositoryId: "acme/workspace",
    providerRepositoryId: "2002",
    onboardingPrincipal: "companyos:user:1",
  });
  const rawBody = JSON.stringify({
    action: "removed",
    installation: { id: 1001 },
    repositories_removed: [{ id: 2002 }],
  });
  const webhookSecret = "test-webhook-secret";
  const signature = `sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`;
  assert.equal(await fixture.provider.reconcileInstallationEvent({
    deliveryId: "delivery-3",
    event: "installation_repositories",
    rawBody,
    signature,
    webhookSecret,
  }), 1);
  assert.equal((await fixture.installations.get("github-workspace"))?.status, "revoked");
});

test("GitHub publication uses a separate narrow token and one trusted outer commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "companyos-github-publisher-"));
  const source = join(root, "source");
  const remote = join(root, "acme", "workspace.git");
  const materialized = join(root, "materialized");
  execFileSync("git", ["init", "-q", source]);
  writeFileSync(join(source, "company.md"), "base\n");
  execFileSync("git", ["add", "company.md"], { cwd: source });
  execFileSync("git", [
    "-c", "user.name=Fixture",
    "-c", "user.email=fixture@example.invalid",
    "commit", "-qm", "base",
  ], { cwd: source });
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
  mkdirSync(join(root, "acme"));
  execFileSync("git", ["clone", "-q", "--bare", source, remote]);

  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const tokenRequests: Array<Record<string, unknown>> = [];
  const pullRequests: Array<Record<string, unknown>> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/app/installations/1001/access_tokens")) {
      tokenRequests.push(JSON.parse(String(init?.body)));
      return Response.json({
        token: "short-lived-installation-token",
        expires_at: "2026-08-26T11:00:00.000Z",
      });
    }
    if (url.endsWith("/app/installations/1001")) {
      return Response.json({
        id: 1001,
        account: { login: "acme", type: "Organization" },
        repository_selection: "selected",
        suspended_at: null,
      });
    }
    if (url.endsWith("/repositories/2002")) {
      return Response.json({
        id: 2002,
        name: "workspace",
        full_name: "acme/workspace",
        default_branch: "main",
        owner: { login: "acme" },
      });
    }
    if (url.includes("/repos/acme/workspace/pulls?")) return Response.json([]);
    if (url.endsWith("/repos/acme/workspace/pulls") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      pullRequests.push(body);
      const proposalCommit = execFileSync(
        "git",
        ["--git-dir", remote, "rev-parse", `refs/heads/${String(body.head)}`],
        { encoding: "utf8" },
      ).trim();
      return Response.json({
        html_url: "https://github.test/acme/workspace/pull/1",
        draft: true,
        head: { sha: proposalCommit },
        created_at: "2026-08-26T10:30:00.000Z",
      });
    }
    if (url.endsWith("/installation/token") && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  };
  const provider = new GitHubAppRepositoryProvider({
    configuration: {
      appId: "42",
      privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      serviceEnvironment: "test",
      apiBaseUrl: "https://api.github.test",
      webBaseUrl: root,
    },
    installations: new InMemoryRepositoryInstallationStore(),
    fetch: fakeFetch,
    now: () => new Date("2026-08-26T10:00:00.000Z"),
  });
  try {
    await provider.verifyInstallation({
      bindingId: "github-workspace",
      instanceId: "fixture",
      installationId: "1001",
      repositoryId: "acme/workspace",
      providerRepositoryId: "2002",
      onboardingPrincipal: "companyos:user:1",
    });
    await provider.materialize({
      schemaVersion: 1,
      requestId: "request-1",
      instanceId: "fixture",
      bindingId: "github-workspace",
      repositoryId: "acme/workspace",
      baseCommit,
      destinationPath: materialized,
    });
    writeFileSync(join(materialized, "company.md"), "changed\n");
    const inspection = await inspectProposalWorkspace(materialized, baseCommit);
    const checked = checkedProposalFromInspection(inspection, [{
      id: "workbench.fixture",
      status: "passed",
      evidenceDigest: sha256("passed"),
    }]);
    const receipt = await provider.publish({
      schemaVersion: 1,
      jobId: "builder-test",
      requestId: "request-1",
      instanceId: "fixture",
      bindingId: "github-workspace",
      repositoryId: "acme/workspace",
      baseCommit,
      workspacePath: materialized,
      branchName: "companyos/builder/builder-test",
      title: "Checked fixture proposal",
      body: "Checked evidence",
      checked,
    });
    assert.equal(receipt.proposalUrl, "https://github.test/acme/workspace/pull/1");
    assert.deepEqual(tokenRequests.at(-1), {
      repository_ids: [2002],
      permissions: { contents: "write", pull_requests: "write" },
    });
    assert.equal(pullRequests[0]?.draft, true);
    assert.equal(
      execFileSync("git", ["--git-dir", remote, "show", `${receipt.proposalCommit}:company.md`], { encoding: "utf8" }).trim(),
      "changed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub hosted flow delegates credential-free bundles to a separate trusted Git adapter", async () => {
  const root = mkdtempSync(join(tmpdir(), "companyos-github-trusted-git-"));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const tokenRequests: Array<Record<string, unknown>> = [];
  const pullRequests: Array<Record<string, unknown>> = [];
  let tokenSequence = 0;
  const credentials: string[] = [];
  const gitExecution: TrustedGitExecutionAdapter = {
    id: "trusted-git-fixture",
    version: "1.0.0",
    async materialize(request) {
      credentials.push(request.credential.realAuthorization);
      writeFileSync(request.destinationBundlePath, "credential-free-git-bundle");
      return { contentDigest: sha256("tree"), evidence: { credentialBrokered: true } };
    },
    async validate() {
      throw new Error("GitHub provider does not own trusted Workbench validation.");
    },
    async publish(request) {
      credentials.push(request.credential.realAuthorization);
      return { proposalCommit: "c".repeat(40), evidence: { credentialBrokered: true } };
    },
  };
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/app/installations/1001/access_tokens")) {
      tokenRequests.push(JSON.parse(String(init?.body)));
      return Response.json({
        token: `short-lived-token-${++tokenSequence}`,
        expires_at: "2026-08-26T11:00:00.000Z",
      });
    }
    if (url.endsWith("/app/installations/1001")) {
      return Response.json({
        id: 1001,
        account: { login: "acme", type: "Organization" },
        repository_selection: "selected",
        suspended_at: null,
      });
    }
    if (url.endsWith("/repositories/2002")) {
      return Response.json({
        id: 2002,
        name: "workspace",
        full_name: "acme/workspace",
        default_branch: "main",
        owner: { login: "acme" },
      });
    }
    if (url.endsWith("/repos/acme/workspace/git/ref/heads/codex%2Freviewed-workspace")) {
      return Response.json({
        ref: "refs/heads/codex/reviewed-workspace",
        object: { sha: "a".repeat(40) },
      });
    }
    if (url.includes("/repos/acme/workspace/pulls?")) return Response.json([]);
    if (url.endsWith("/repos/acme/workspace/pulls") && init?.method === "POST") {
      pullRequests.push(JSON.parse(String(init.body)));
      return Response.json({
        html_url: "https://github.test/acme/workspace/pull/2",
        draft: true,
        head: { sha: "c".repeat(40) },
        base: { ref: "codex/reviewed-workspace", sha: "a".repeat(40) },
        created_at: "2026-08-26T10:30:00.000Z",
      });
    }
    if (url.endsWith("/installation/token") && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  };
  const provider = new GitHubAppRepositoryProvider({
    configuration: {
      appId: "42",
      privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      serviceEnvironment: "test",
      apiBaseUrl: "https://api.github.test",
      webBaseUrl: "https://github.test",
    },
    installations: new InMemoryRepositoryInstallationStore(),
    gitExecution,
    fetch: fakeFetch,
    now: () => new Date("2026-08-26T10:00:00.000Z"),
  });
  try {
    await provider.verifyInstallation({
      bindingId: "github-workspace",
      instanceId: "fixture",
      installationId: "1001",
      repositoryId: "acme/workspace",
      providerRepositoryId: "2002",
      onboardingPrincipal: "companyos:user:1",
    });
    const source = await provider.materialize({
      schemaVersion: 1,
      requestId: "trusted-request",
      instanceId: "fixture",
      bindingId: "github-workspace",
      repositoryId: "acme/workspace",
      baseCommit: "a".repeat(40),
      destinationPath: join(root, "materialized"),
    });
    assert.equal(source.transfer?.format, "git-bundle");
    assert.match(source.transfer?.path ?? "", /repository\.bundle$/);
    const diff = "diff --git a/company.md b/company.md\n";
    const checked = {
      validationPassed: true as const,
      validatedDiffDigest: sha256(diff),
      changedPaths: ["company.md"],
      checks: [{ id: "workbench.fixture", status: "passed" as const, evidenceDigest: sha256("passed") }],
    };
    const receipt = await provider.publish({
      schemaVersion: 1,
      jobId: "trusted-builder-test",
      requestId: "trusted-request",
      instanceId: "fixture",
      bindingId: "github-workspace",
      repositoryId: "acme/workspace",
      baseCommit: "a".repeat(40),
      sourceBundlePath: source.transfer!.path,
      diff,
      branchName: "companyos/builder/trusted-builder-test",
      targetBranchName: "codex/reviewed-workspace",
      title: "Trusted fixture proposal",
      body: "Checked evidence",
      checked,
    });
    assert.equal(receipt.proposalCommit, "c".repeat(40));
    assert.equal(receipt.proposalUrl, "https://github.test/acme/workspace/pull/2");
    assert.equal(pullRequests[0]?.base, "codex/reviewed-workspace");
    assert.equal(credentials.length, 2);
    assert.notEqual(credentials[0], credentials[1]);
    assert.deepEqual(tokenRequests.at(-2), { repository_ids: [2002], permissions: { contents: "read" } });
    assert.deepEqual(tokenRequests.at(-1), {
      repository_ids: [2002],
      permissions: { contents: "write", pull_requests: "write" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
