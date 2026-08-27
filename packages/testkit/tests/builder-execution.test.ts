import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  BuilderAcpTimeoutError,
  createBuilderAcpPermissionPolicy,
  isPathInsideBuilderWorkspace,
  probeBuilderAcpLaunch,
  runBuilderAcp,
  type BuilderAcpLaunch,
  type BuilderAcpProgressEvidence,
} from "../../runtime/builder/acp-client.ts";
import {
  assertBuilderExecutionHandle,
  assertBuilderExecutionRequest,
  type BuilderExecutionRequest,
} from "../../runtime/builder/execution.ts";
import {
  BUILDER_ACP_PROFILES,
  assertBuilderAcpProfilePin,
  resolveBuilderAcpProfile,
} from "../../runtime/builder/profiles.ts";
import {
  InMemoryBuilderExecutionAdapter,
  createInMemoryBuilderExecutionStore,
} from "../adapter/in-memory-builder-execution.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fakeAgent = join(here, "../fixtures/acp/fake-agent.mjs");
const fakeLaunch: BuilderAcpLaunch = {
  profile: BUILDER_ACP_PROFILES.codex,
  executable: process.execPath,
  args: [fakeAgent],
};
const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

const request = (): BuilderExecutionRequest => ({
  schemaVersion: 1,
  jobId: "builder-job:test-1",
  source: {
    repository: "https://example.invalid/company-workspace.git",
    baseCommit: "a".repeat(40),
  },
  codingAgent: {
    profileId: "codex",
    implementation: "@agentclientprotocol/codex-acp",
    version: "1.6.2",
  },
  limits: { timeoutMs: 60_000 },
  networkPolicyId: "builder-model-only",
});

test("Builder execution contract validates exact immutable inputs", () => {
  assert.doesNotThrow(() => assertBuilderExecutionRequest(request()));
  assert.throws(
    () => assertBuilderExecutionRequest({ ...request(), source: { ...request().source, baseCommit: "main" } }),
    /exact 40-character base commit/,
  );
  assert.throws(
    () => assertBuilderExecutionRequest({
      ...request(),
      codingAgent: { ...request().codingAgent, version: "latest" },
    }),
    /exact semantic versions/,
  );
});

test("execution adapter fake is idempotent, fail-closed, cancellable, and disposable", async () => {
  let tick = 0;
  const adapter = new InMemoryBuilderExecutionAdapter(() => `2026-08-26T00:00:0${tick++}.000Z`);
  const first = await adapter.start(request());
  const duplicate = await adapter.start(request());
  assert.deepEqual(duplicate, first);
  await assert.rejects(adapter.collect(first), /unavailable before a terminal state/);
  await adapter.cancel(first);
  await adapter.cancel(first);
  assert.equal((await adapter.status(first)).state, "cancelled");
  assert.equal((await adapter.collect(first)).state, "cancelled");
  await adapter.dispose(first);
  await adapter.dispose(first);
  assert.equal(adapter.isDisposed(first), true);
  await assert.rejects(adapter.status(first), /disposed/);
  assert.throws(
    () => assertBuilderExecutionHandle({ id: "other", version: "1.0.0" }, first),
    /different adapter/,
  );
});

test("execution state survives coordinator replacement and duplicate delivery", async () => {
  const store = createInMemoryBuilderExecutionStore();
  const firstCoordinator = new InMemoryBuilderExecutionAdapter(() => "2026-08-26T00:00:00.000Z", store);
  const handles = await Promise.all([
    firstCoordinator.start(request()),
    firstCoordinator.start(request()),
  ]);
  assert.deepEqual(handles[1], handles[0]);
  await assert.rejects(
    firstCoordinator.start({ ...request(), limits: { timeoutMs: 90_000 } }),
    /reused with a different execution request/,
  );

  const replacementCoordinator = new InMemoryBuilderExecutionAdapter(
    () => "2026-08-26T00:00:01.000Z",
    store,
  );
  assert.equal((await replacementCoordinator.status(handles[0])).state, "running");
  await replacementCoordinator.cancel(handles[0]);
  assert.equal((await replacementCoordinator.collect(handles[0])).state, "cancelled");
  await replacementCoordinator.dispose(handles[0]);
  assert.equal(replacementCoordinator.isDisposed(handles[0]), true);
});

test("ACP profile selection is allowlisted and exactly pinned", () => {
  assert.equal(resolveBuilderAcpProfile("claude-code").version, "0.70.0");
  assert.equal(resolveBuilderAcpProfile("codex").version, "1.6.2");
  assert.equal(resolveBuilderAcpProfile("codex").sessionMode, "agent");
  assert.throws(() => resolveBuilderAcpProfile("latest-agent"), /Unsupported Builder ACP profile/);
  assert.throws(
    () => assertBuilderAcpProfilePin({ ...BUILDER_ACP_PROFILES.codex, version: "^1.6.2" }),
    /exact version/,
  );
});

test("ACP client probes the exact implementation and denies permissions by default", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "companyos-builder-acp-deny-"));
  const progress: BuilderAcpProgressEvidence[] = [];
  try {
    await writeFile(join(cwd, "fixture.txt"), "base\n", "utf8");
    assert.equal(await probeBuilderAcpLaunch(fakeLaunch, environment), "1.6.2");
    const result = await runBuilderAcp({
      launch: fakeLaunch,
      cwd,
      prompt: "try-to-write-fixture",
      timeoutMs: 5_000,
      environment,
      onProgress: (event) => { progress.push(event); },
    });
    assert.equal(result.protocolVersion, 1);
    assert.equal(result.profile.version, "1.6.2");
    assert.equal(result.profile.sessionMode, "agent");
    assert.equal(result.permissionRequests, 1);
    assert.equal(result.approvedPermissions, 0);
    assert.equal(result.deniedPermissions, 1);
    assert.equal(await readFile(join(cwd, "fixture.txt"), "utf8"), "base\n");
    assert.deepEqual(result.updateKinds, ["agent_message_chunk", "tool_call", "tool_call_update", "usage_update"]);
    assert.deepEqual(result.modelUsage, {
      attribution: "fresh-acp-session-single-job",
      model: "fake-model-v1",
      tokens: {
        total: 18,
        input: 10,
        output: 4,
        thought: 0,
        cachedRead: 4,
        cachedWrite: 0,
      },
      cost: {
        status: "reported",
        amount: 0.00042,
        currency: "USD",
        source: "acp-usage-update",
        estimated: true,
      },
    });
    assert.equal(progress[0]?.phase, "prompt_started");
    assert.equal(progress[1]?.phase, "usage_observed");
    assert.deepEqual(progress[1]?.cost, result.modelUsage.cost);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace path checks resolve provider and host symlink spellings", async () => {
  const parent = await mkdtemp(join(tmpdir(), "companyos-builder-path-"));
  const actual = join(parent, "actual");
  const alias = join(parent, "alias");
  try {
    await mkdir(actual);
    await writeFile(join(actual, "fixture.txt"), "base\n", "utf8");
    await symlink(actual, alias, "dir");
    assert.equal(isPathInsideBuilderWorkspace(alias, join(actual, "fixture.txt")), true);
    assert.equal(isPathInsideBuilderWorkspace(alias, join(parent, "outside.txt")), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("ACP client can allow one bounded change and CompanyOS reads the diff independently", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "companyos-builder-acp-diff-"));
  try {
    await writeFile(join(cwd, "fixture.txt"), "base\n", "utf8");
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["add", "fixture.txt"], { cwd });
    execFileSync("git", ["-c", "user.name=CompanyOS Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base"], { cwd });
    const result = await runBuilderAcp({
      launch: fakeLaunch,
      cwd,
      prompt: "write-fixture",
      timeoutMs: 5_000,
      environment,
      permissionPolicy: (permission) => {
        const insideWorkspace = permission.toolCall.locations?.every((location) => location.path.startsWith(`${cwd}/`));
        return insideWorkspace ? "allow-once" : undefined;
      },
    });
    assert.equal(result.approvedPermissions, 1);
    assert.equal(result.deniedPermissions, 0);
    const diff = execFileSync("git", ["diff", "--no-ext-diff", "--", "fixture.txt"], { cwd, encoding: "utf8" });
    assert.match(diff, /-base/);
    assert.match(diff, /\+changed-by-fake-acp-agent/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Codex workspace-write policy allows one generic execute request without claimed paths", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "companyos-builder-acp-codex-execute-"));
  try {
    await writeFile(join(cwd, "fixture.txt"), "base\n", "utf8");
    const result = await runBuilderAcp({
      launch: fakeLaunch,
      cwd,
      prompt: "write-fixture-generic-execute",
      timeoutMs: 5_000,
      environment,
      permissionPolicy: createBuilderAcpPermissionPolicy(BUILDER_ACP_PROFILES.codex, cwd),
    });
    assert.equal(result.approvedPermissions, 1);
    assert.equal(result.deniedPermissions, 0);
    assert.deepEqual(result.permissionEvidence, [{
      toolKind: "execute",
      locationScope: "none",
      optionKinds: ["allow_once", "reject_once"],
    }]);
    assert.equal(await readFile(join(cwd, "fixture.txt"), "utf8"), "changed-by-fake-acp-agent\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ACP client cancels a hung session at its hard timeout", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "companyos-builder-acp-timeout-"));
  try {
    await assert.rejects(
      runBuilderAcp({
        launch: fakeLaunch,
        cwd,
        prompt: "hang-until-cancelled",
        timeoutMs: 1_000,
        environment,
      }),
      BuilderAcpTimeoutError,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ACP client classifies an unexpected coding-agent process exit without waiting for the job timeout", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "companyos-builder-acp-crash-"));
  const startedAt = Date.now();
  try {
    await assert.rejects(
      runBuilderAcp({
        launch: fakeLaunch,
        cwd,
        prompt: "crash-after-prompt",
        timeoutMs: 5_000,
        environment,
      }),
      /ACP (?:process exited before the active job completed \(SIGKILL\)|connection closed)/,
    );
    assert.ok(Date.now() - startedAt < 4_000);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ACP client fails closed when an exact profile omits job-bound token usage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "companyos-builder-acp-usage-"));
  try {
    await assert.rejects(
      runBuilderAcp({
        launch: fakeLaunch,
        cwd,
        prompt: "omit-usage",
        timeoutMs: 5_000,
        environment,
      }),
      /did not report job-bound token usage/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ACP client records unavailable cost instead of inventing a price when the profile omits it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "companyos-builder-acp-cost-"));
  try {
    await writeFile(join(cwd, "fixture.txt"), "base\n", "utf8");
    const result = await runBuilderAcp({
      launch: fakeLaunch,
      cwd,
      prompt: "omit-cost",
      timeoutMs: 5_000,
      environment,
    });
    assert.deepEqual(result.modelUsage.cost, {
      status: "unavailable",
      reason: "acp-profile-did-not-report-cost",
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
