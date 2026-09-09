import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import YAML from "yaml";
import {
  advanceLiveSetup,
  createVercelEnvironmentVariable,
  fetchHealth,
  fetchVerifiedProductionHealth,
  LIVE_SETUP_PROVIDER_PROFILE,
  normalizeLiveSetupAnswers,
  resolveSlackPrincipal,
  resolveSlackApp,
  withIsolatedVercelContext,
  safeProviderError,
  SlackAuthorizationRequiredError,
  SUPPORTED_VERCEL_CLI_VERSION,
  verifyLiveSetup,
  writeLiveSetupState,
  readLiveSetupState,
} from "../src/live-setup.mjs";
import { assertSetupProviderProfile, defineSetupProviderProfile } from "../src/setup/provider-contracts.ts";
import { assertSetupModelProviderAdapter } from "../src/setup/model-provider-contracts.ts";
import {
  ANTHROPIC_DIRECT_MODEL_PROVIDER,
  GOOGLE_DIRECT_MODEL_PROVIDER,
  GROQ_MODEL_PROVIDER,
  MISTRAL_MODEL_PROVIDER,
  NVIDIA_MODEL_PROVIDER,
  OPENAI_DIRECT_MODEL_PROVIDER,
  OPENROUTER_MODEL_PROVIDER,
  SETUP_MODEL_PROVIDERS,
  VERCEL_AI_GATEWAY_MODEL_PROVIDER,
} from "../src/setup/model-providers.ts";
import {
  applyOperatingStarter,
  normalizeOperatingStarterInput,
  previewOperatingStarter,
} from "../src/operating-starter.mjs";
import { renderWorkspace } from "../src/workspace-generator.mjs";
import { validateWorkspace } from "../src/workspace-validator.mjs";
import { WORKBENCH_VERSION } from "../src/workbench-version.mjs";
import { PNPM_VERSION } from "../src/core-version.mjs";
import { parseRoster } from "../../state-store/roster.ts";
import {
  COMPANY_DATABASE_MANIFEST,
  COMPANY_DATABASE_MANIFEST_DIGEST,
} from "../../state-postgres/database-bootstrap.ts";

const jsonResult = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
const syntheticVercelTeam = (plan = "pro") => ({ id: "team_example", slug: "example-company", billing: { plan } });

// Existing lifecycle tests supply their provider behavior after a Pro preflight.
// Prerequisite tests below call the real entrypoints with explicit plan fixtures.
const withProTeam = (executor) => ({
  run(file, args, options) {
    if (file === "vercel" && args[0] === "api" && args[1].startsWith("/v2/teams")) {
      const team = { ...syntheticVercelTeam(), slug: args[args.indexOf("--scope") + 1] };
      return jsonResult(args[1].includes("?") ? { teams: [team], pagination: { next: null } } : team);
    }
    return executor.run(file, args, options);
  },
});
const advanceWithProTeam = (options) => advanceLiveSetup({ ...options, executor: withProTeam(options.executor) });
const verifyWithProTeam = (options) => verifyLiveSetup({ ...options, executor: withProTeam(options.executor) });

const CORE_REF = "1234567890abcdef1234567890abcdef12345678";

const workspaceInput = {
  company_name: "Example Company GmbH",
  workspace_slug: "example-company",
  language: "de",
  timezone: "Europe/Berlin",
  steward_name: "Anna Example",
  steward_id: "anna-example",
  codeowner: "@anna-example",
  target_directory: "example-company-companyos",
};

const coreIdentity = (root) => ({
  root,
  repository: "oregano-os/oregano",
  ref: CORE_REF,
  core_version: "0.8.1",
  workbench_version: WORKBENCH_VERSION,
  clean: true,
});

const liveAnswers = (overrides = {}) => ({
  change_date: "2026-08-20",
  steward_email: "anna@example.com",
  github_owner: "example-company",
  github_repository: "companyos",
  github_account_type: "organization",
  github_repository_mode: "create",
  vercel_scope: "example-company",
  vercel_project: "example-companyos",
  vercel_project_mode: "create",
  neon_resource_name: "example-companyos-db",
  neon_resource_mode: "create",
  neon_plan: "free_v3",
  neon_region: "fra1",
  slack_connector_name: "oregano",
  slack_connector_mode: "create",
  slack_channel_id: "C12345678",
  model_route: "vercel-ai-gateway",
  model_credential_mode: "platform",
  model: "openai/gpt-5.4-nano",
  ...overrides,
});

const databaseQualification = (overrides = {}) => ({
  receiptVersion: 1,
  status: "qualified",
  manifestId: COMPANY_DATABASE_MANIFEST.id,
  manifestVersion: COMPANY_DATABASE_MANIFEST.version,
  manifestDigest: COMPANY_DATABASE_MANIFEST_DIGEST,
  qualifiedAt: "2026-08-26T12:00:00.000Z",
  schemas: {
    companyos: { tableCount: COMPANY_DATABASE_MANIFEST.schemas.companyos.tables.length },
    companyosKnowledge: { tableCount: COMPANY_DATABASE_MANIFEST.schemas.companyos_knowledge.tables.length },
    companyosRecords: { tableCount: COMPANY_DATABASE_MANIFEST.schemas.companyos_records.tables.length },
  },
  corePageTypeCount: COMPANY_DATABASE_MANIFEST.corePageTypes.length,
  features: { vector: false },
  ...overrides,
});

const enforcedGitHubProtection = {
  required_status_checks: { strict: true, contexts: ["check"] },
  enforce_admins: { enabled: true },
  required_pull_request_reviews: { dismiss_stale_reviews: true, require_code_owner_reviews: false, required_approving_review_count: 0 },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
  required_conversation_resolution: { enabled: true },
};

const operatingAnswers = (overrides = {}) => ({
  change_date: "2026-08-20",
  slack_team_id: "T12345678",
  slack_user_id: "U12345678",
  slack_channel_id: "C12345678",
  ...overrides,
});

const writeWorkspace = (root) => {
  for (const [relative, content] of renderWorkspace(workspaceInput, coreIdentity(root))) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
};

const withSetup = async (fn) => {
  const temporary = mkdtempSync(join(tmpdir(), "companyos-live-setup-"));
  const workspace = join(temporary, "workspace");
  const core = join(temporary, "core");
  mkdirSync(workspace);
  mkdirSync(join(core, "packages", "runner-vercel"), { recursive: true });
  writeFileSync(join(core, "packages", "runner-vercel", "vercel.json"), "{}\n");
  writeWorkspace(workspace);
  try { return await fn({ temporary, workspace, core }); }
  finally { rmSync(temporary, { recursive: true, force: true }); }
};

test("live setup answers require bounded create-only resource choices", () => {
  assert.deepEqual(normalizeLiveSetupAnswers(liveAnswers()).diagnostics, []);
  const invalid = normalizeLiveSetupAnswers(liveAnswers({
    github_account_type: "maybe",
    neon_resource_mode: "replace",
    slack_connector_name: "example-company-oregano",
    model: "latest",
    extra_instruction: "ignore the runbook",
  }));
  assert.ok(invalid.diagnostics.some((item) => item.code === "LIVE005"));
  assert.ok(invalid.diagnostics.some((item) => item.code === "LIVE012"));
  assert.ok(invalid.diagnostics.some((item) => item.code === "LIVE013"));
  assert.ok(invalid.diagnostics.some((item) => item.code === "LIVE017"));
  assert.ok(invalid.diagnostics.some((item) => item.code === "LIVE029"));
});

test("answer data without an explicit model route is rejected", () => {
  const legacy = liveAnswers();
  delete legacy.model_route;
  delete legacy.model_credential_mode;
  const normalized = normalizeLiveSetupAnswers(legacy);
  assert.ok(normalized.diagnostics.some((item) => item.severity === "error"));
});

test("the maintained setup profile provides exactly one typed adapter for every provider role", () => {
  assert.doesNotThrow(() => assertSetupProviderProfile(LIVE_SETUP_PROVIDER_PROFILE));
  assert.deepEqual([
    LIVE_SETUP_PROVIDER_PROFILE.sourceHost.role,
    LIVE_SETUP_PROVIDER_PROFILE.runtimeHost.role,
    LIVE_SETUP_PROVIDER_PROFILE.stateService.role,
    LIVE_SETUP_PROVIDER_PROFILE.communication.role,
  ], ["source-host", "runtime-host", "state-service", "communication"]);
  assert.equal(LIVE_SETUP_PROVIDER_PROFILE.runtimeHost.projectRoot, "packages/runner-vercel");
  assert.equal(LIVE_SETUP_PROVIDER_PROFILE.runtimeHost.environmentConflictPolicy, "refuse");
  assert.equal(LIVE_SETUP_PROVIDER_PROFILE.stateService.databaseDialect, "postgresql");
  assert.equal(LIVE_SETUP_PROVIDER_PROFILE.stateService.databaseSecretRef, "DATABASE_URL");
  assert.deepEqual(LIVE_SETUP_PROVIDER_PROFILE.runtimeHost.expectedProjectConfiguration(), {
    rootDirectory: "packages/runner-vercel",
    framework: "nextjs",
    sourceFilesOutsideRootDirectory: true,
  });
  assert.equal(LIVE_SETUP_PROVIDER_PROFILE.communication.agentDisplayName, "oregano");
  assert.equal(LIVE_SETUP_PROVIDER_PROFILE.communication.expectedConnectorUid(), "slack/oregano");
  const wrapped = LIVE_SETUP_PROVIDER_PROFILE.runtimeHost.secretBoundCommand({
    environment: "production",
    project: "example-companyos",
    scope: "example-company",
    cwd: "/example/core",
    command: ["node", "companyos", "database", "prepare"],
  });
  assert.equal(wrapped.executable, "vercel");
  assert.deepEqual(wrapped.args.slice(0, 2), ["env", "run"]);
  assert.deepEqual(wrapped.args.slice(-4), ["node", "companyos", "database", "prepare"]);
  assert.equal(wrapped.args.includes("pull"), false);
  assert.throws(() => assertSetupProviderProfile({ ...LIVE_SETUP_PROVIDER_PROFILE, communication: undefined }), /communication/);
});

test("an alternative runtime profile can inject the same database preparation without Vercel", () => {
  const alternative = defineSetupProviderProfile({
    ...LIVE_SETUP_PROVIDER_PROFILE,
    id: "container-postgres-console",
    runtimeHost: {
      ...LIVE_SETUP_PROVIDER_PROFILE.runtimeHost,
      provider: "container",
      cliVersion: "1.0.0",
      projectRoot: "packages/runner-container",
      framework: "node",
      secretBoundCommand(input) {
        return { executable: "company-runtime", args: ["exec", "--environment", input.environment, "--", ...input.command] };
      },
    },
    stateService: {
      ...LIVE_SETUP_PROVIDER_PROFILE.stateService,
      provider: "postgres-console",
    },
    communication: {
      ...LIVE_SETUP_PROVIDER_PROFILE.communication,
      provider: "console",
    },
  });
  const command = alternative.runtimeHost.secretBoundCommand({
    environment: "production",
    project: "ignored-by-fixture",
    scope: "ignored-by-fixture",
    cwd: "/example/core",
    command: ["node", "companyos", "database", "prepare"],
  });
  assert.equal(command.executable, "company-runtime");
  assert.equal(command.args.includes("vercel"), false);
  assert.deepEqual(command.args.slice(-4), ["node", "companyos", "database", "prepare"]);
});

test("model execution routes have typed, secret-aware setup adapters", () => {
  assert.doesNotThrow(() => assertSetupModelProviderAdapter(VERCEL_AI_GATEWAY_MODEL_PROVIDER));
  assert.doesNotThrow(() => assertSetupModelProviderAdapter(ANTHROPIC_DIRECT_MODEL_PROVIDER));
  assert.doesNotThrow(() => assertSetupModelProviderAdapter(OPENAI_DIRECT_MODEL_PROVIDER));
  assert.doesNotThrow(() => assertSetupModelProviderAdapter(GOOGLE_DIRECT_MODEL_PROVIDER));
  assert.doesNotThrow(() => assertSetupModelProviderAdapter(OPENROUTER_MODEL_PROVIDER));
  assert.doesNotThrow(() => assertSetupModelProviderAdapter(GROQ_MODEL_PROVIDER));
  assert.doesNotThrow(() => assertSetupModelProviderAdapter(MISTRAL_MODEL_PROVIDER));
  assert.doesNotThrow(() => assertSetupModelProviderAdapter(NVIDIA_MODEL_PROVIDER));
  assert.equal(VERCEL_AI_GATEWAY_MODEL_PROVIDER.credentialRef, null);
  assert.equal(ANTHROPIC_DIRECT_MODEL_PROVIDER.credentialRef, "ANTHROPIC_API_KEY");
  assert.equal(OPENAI_DIRECT_MODEL_PROVIDER.credentialRef, "OPENAI_API_KEY");
  assert.equal(GOOGLE_DIRECT_MODEL_PROVIDER.credentialRef, "GOOGLE_GENERATIVE_AI_API_KEY");
  assert.equal(OPENROUTER_MODEL_PROVIDER.credentialRef, "OPENROUTER_API_KEY");
  assert.equal(Object.keys(SETUP_MODEL_PROVIDERS).length, 13);
  assert.equal(ANTHROPIC_DIRECT_MODEL_PROVIDER.secretEntrySurface, "runtime-host-dashboard");
  assert.equal(ANTHROPIC_DIRECT_MODEL_PROVIDER.supports("anthropic/claude-sonnet-4-5"), true);
  assert.equal(ANTHROPIC_DIRECT_MODEL_PROVIDER.supports("openai/gpt-5.4-nano"), false);
});

test("maintained setup accepts matching OpenAI and Google direct recipes", () => {
  const openai = normalizeLiveSetupAnswers(liveAnswers({
    model_route: "openai-direct",
    model_credential_mode: "configure",
    model: "openai/gpt-5.4-mini",
  }));
  assert.deepEqual(openai.diagnostics.filter((item) => item.severity === "error"), []);
  const google = normalizeLiveSetupAnswers(liveAnswers({
    model_route: "google-direct",
    model_credential_mode: "adopt",
    model: "google/gemini-2.5-flash",
  }));
  assert.deepEqual(google.diagnostics.filter((item) => item.severity === "error"), []);
  const mismatch = normalizeLiveSetupAnswers(liveAnswers({
    model_route: "google-direct",
    model_credential_mode: "configure",
    model: "openai/gpt-5.4-mini",
  }));
  assert.ok(mismatch.diagnostics.some((item) => item.code === "LIVE032"));
});

test("maintained setup accepts named compatible cloud recipes", () => {
  const openrouter = normalizeLiveSetupAnswers(liveAnswers({
    model_route: "openrouter",
    model_credential_mode: "configure",
    model: "openrouter/anthropic/claude-sonnet-4.6",
  }));
  assert.deepEqual(openrouter.diagnostics.filter((item) => item.severity === "error"), []);

  const nvidia = normalizeLiveSetupAnswers(liveAnswers({
    model_route: "nvidia",
    model_credential_mode: "adopt",
    model: "nvidia/nvidia/nemotron-3-super-120b-a12b",
  }));
  assert.deepEqual(nvidia.diagnostics.filter((item) => item.severity === "error"), []);
});

test("the operating starter is deterministic, Tool-free, and keeps one Steward", () => withSetup(({ workspace }) => {
  assert.deepEqual(normalizeOperatingStarterInput(operatingAnswers()).diagnostics, []);
  const first = previewOperatingStarter({ workspaceRoot: workspace, rawInput: operatingAnswers() });
  const second = previewOperatingStarter({ workspaceRoot: workspace, rawInput: operatingAnswers() });
  assert.equal(first.preview.confirmation_hash, second.preview.confirmation_hash);
  assert.equal(first.diagnostics.filter((item) => item.severity === "error").length, 0);
  assert.deepEqual(first.preview.tools, []);
  assert.equal(first.preview.execution_mode, "supervised");
  assert.ok(first.preview.files.includes(".companyos/instance.yaml"));

  const applied = applyOperatingStarter({ workspaceRoot: workspace, rawInput: operatingAnswers(), confirmationHash: first.preview.confirmation_hash });
  assert.equal(applied.applied, true);
  assert.equal(validateWorkspace(workspace).diagnostics.filter((item) => item.severity === "error").length, 0);
  assert.match(readFileSync(join(workspace, "company.md"), "utf8"), /workspace_mode: operating/);
  assert.match(readFileSync(join(workspace, "agents", "oregano", "instructions.md"), "utf8"), /tools: \[\]/);
  assert.match(readFileSync(join(workspace, "handbook", "roster.md"), "utf8"), /team_id: T12345678/);
  const compiledRoster = parseRoster(readFileSync(join(workspace, "handbook", "roster.md"), "utf8"));
  assert.equal(compiledRoster.length, 1);
  const slackSteward = compiledRoster.find((member) => member.teamId === "T12345678");
  assert.equal(slackSteward?.userId, "U12345678");
  assert.doesNotMatch(readFileSync(join(workspace, "connections", "slack.md"), "utf8"), /xox[baprs]-|postgresql:\/\//);
  const governance = YAML.parse(readFileSync(join(workspace, ".companyos", "governance.yaml"), "utf8"));
  const protection = YAML.parse(readFileSync(join(workspace, ".companyos", "repository-protection.yaml"), "utf8"));
  assert.equal(governance.review_mode, "steward");
  assert.equal(protection.rules.required_approvals, 0);
  assert.equal(protection.rules.require_code_owner_review, false);
}));

test("generated GitHub checks keep the Company Workspace separate from pinned Core", () => withSetup(({ workspace }) => {
  const workflow = readFileSync(join(workspace, ".github", "workflows", "check.yml"), "utf8");
  assert.match(workflow, /path: company-workspace/);
  assert.match(workflow, /path: \.companyos-core/);
  assert.match(workflow, /companyos validate "\$GITHUB_WORKSPACE\/company-workspace"/);
  assert.doesNotMatch(workflow, /companyos validate "\$GITHUB_WORKSPACE"\n/);
}));

test("live setup state refuses credential-shaped fields and values", () => withSetup(({ temporary }) => {
  const path = join(temporary, "state.json");
  assert.throws(() => writeLiveSetupState(path, { schema_version: 1, profile: "vercel-neon-slack", access_token: "not-even-a-real-token" }), /sensitive state field/);
  assert.throws(() => writeLiveSetupState(path, { schema_version: 1, profile: "vercel-neon-slack", value: "postgresql:\/\/user:pass@example.test/db" }), /possible credential material/);
}));

test("Slack principal resolution discards the short-lived user credential", async () => {
  const executor = {
    run(file, args) {
      assert.equal(file, "vercel");
      assert.ok(args.includes("token"));
      assert.equal(args.includes("--subject"), false);
      assert.equal(args[args.indexOf("--scopes") + 1], "identity.basic");
      return { status: 0, stdout: JSON.stringify({ token: "temporary-user-credential" }), stderr: "" };
    },
  };
  const identity = await resolveSlackPrincipal("slack/example", {
    executor,
    coreRoot: "/tmp/core",
    scope: "example",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://slack.com/api/users.identity");
      assert.equal(options.headers.authorization, "Bearer temporary-user-credential");
      return { ok: true, json: async () => ({ ok: true, team: { id: "T12345678", name: "Example" }, user: { id: "U12345678", name: "anna" } }) };
    },
  });
  assert.deepEqual(identity, { team_id: "T12345678", user_id: "U12345678", team: "Example", user: "anna" });
  assert.equal("token" in identity, false);
});

test("Slack authorization command failures never expose provider output", async () => {
  let message = "";
  try {
    await resolveSlackPrincipal("slack/example", {
      executor: { run: () => ({ status: 1, stdout: "opaque-credential-material", stderr: "" }) },
      coreRoot: "/tmp/core",
      scope: "example",
    });
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /Slack user authorization is required/);
  assert.doesNotMatch(message, /opaque-credential-material/);
});

test("Slack authorization failures are a resumable browser gate with least privilege", async () => {
  await assert.rejects(
    resolveSlackPrincipal("slack/example", {
      executor: { run: () => ({ status: 1, stdout: "xoxe.xoxp-secret-material", stderr: "authorization required" }) },
      coreRoot: "/tmp/core",
      scope: "example",
    }),
    SlackAuthorizationRequiredError,
  );
});

test("provider diagnostics redact current Slack credential shapes and preserve the useful tail", () => {
  const diagnosticText = safeProviderError(`xoxe.xoxp-secret ${"a".repeat(2500)} root cause at packages/runner-vercel`);
  assert.doesNotMatch(diagnosticText, /xoxe|xoxp|secret/);
  assert.match(diagnosticText, /REDACTED_SLACK_CREDENTIAL/);
  assert.match(diagnosticText, /root cause at packages\/runner-vercel/);
});

test("health polling tolerates a temporary non-JSON provider response", async () => {
  let calls = 0;
  const result = await fetchHealth("https://example.test", async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 503, text: async () => "Temporarily unavailable" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, status: "ready" }) };
  }, { attempts: 2, delayMs: 0, sleep: async () => {} });
  assert.equal(calls, 2);
  assert.equal(result.status, "ready");
});

test("Vercel production variables are created without an overwrite flag", () => {
  let call;
  createVercelEnvironmentVariable({
    run(file, args, options) {
      call = { file, args, options };
      return { status: 0, stdout: "created", stderr: "" };
    },
  }, "/synthetic/core", "synthetic-scope", "synthetic-project", "SYNTHETIC_VALUE", "synthetic-value", { sensitive: true });
  assert.equal(call.file, "vercel");
  assert.ok(call.args.includes("--sensitive"));
  assert.equal(call.args.includes("--force"), false);
  assert.equal(call.options.input, "synthetic-value\n");
});

for (const identity of [
  { ok: true, team_id: "T12345678", user_id: "U12345678" },
  { ok: true, team: { id: "wrong" }, user: { id: "U12345678" } },
  { ok: true, team: { id: "T12345678" }, user: { id: "B12345678" } },
  { ok: false, error: "invalid_auth" },
]) test(`Slack identity rejects malformed or non-human identity: ${JSON.stringify(identity)}`, async () => {
  await assert.rejects(resolveSlackPrincipal("slack/example", {
    executor: { run: () => ({ status: 0, stdout: JSON.stringify({ token: "synthetic-human" }), stderr: "" }) },
    coreRoot: "/tmp/core", scope: "example",
    fetchImpl: async () => ({ ok: true, json: async () => identity }),
  }), /Slack identity verification failed/);
});

const syntheticSlackConnector = () => ({ triggers: { enabled: true }, triggerDestinations: [{ projectId: "prj_example", path: "/api/webhooks/slack" }], id: "scl_example", uid: "slack/example", service: "slack", defaultInstallationId: "T12345678", data: { appId: "A12345678", slackTeam: { id: "T12345678" }, clientSecret: "synthetic-secret" } });
for (const events of [[], ['app_mention'], 'message.im']) test(`Slack rejects unusable explicit direct-message subscriptions: ${JSON.stringify(events)}`, () => {
  assert.throws(() => resolveSlackApp({ run: () => ({ status: 0, stdout: JSON.stringify({ ...syntheticSlackConnector(), events }), stderr: '' }) }, '/tmp/core', 'example', { id: 'scl_example', uid: 'slack/example' }, 'T12345678', 'prj_example'), /message.im/);
});
test("Slack app metadata is scoped and reduced to non-secret app entry evidence", () => {
  const app = resolveSlackApp({ run(file, args, options) {
    assert.equal(file, "vercel");
    if (args.some(arg => arg.endsWith("/projects/prj_example"))) return { status: 0, stdout: JSON.stringify({ environments: ["production"] }), stderr: "" };
    assert.ok(args.includes("/v1/connect/connectors/slack%2Fexample"));
    assert.equal(options.sensitiveOutput, true);
    return { status: 0, stdout: JSON.stringify(syntheticSlackConnector()), stderr: "" };
  } }, "/tmp/core", "example", { id: "scl_example", uid: "slack/example" }, "T12345678", "prj_example");
  assert.deepEqual(app, { app_id: "A12345678", team_id: "T12345678", open_url: "slack://app?team=T12345678&id=A12345678&tab=messages" });
  assert.doesNotMatch(JSON.stringify(app), /secret/);
});
for (const change of [
  { id: "scl_other" }, { uid: "slack/other" }, { service: "other" },
  { defaultInstallationId: "T99999999" },
  { data: { appId: "A12345678", slackTeam: { id: "T99999999" } } },
  { data: { appId: "malformed", slackTeam: { id: "T12345678" } } },
]) test(`Slack app rejects mismatched connector metadata: ${JSON.stringify(change)}`, () => {
  assert.throws(() => resolveSlackApp({ run: () => ({ status: 0, stdout: JSON.stringify({ ...syntheticSlackConnector(), ...change }), stderr: "" }) }, "/tmp/core", "example", { id: "scl_example", uid: "slack/example" }, "T12345678", "prj_example"), /do not match/);
});
for (const fail of [false, true]) test(`provider scratch files are removed after ${fail ? "failure" : "success"}`, () => withSetup(({ core }) => {
  let scratch;
  const invoke = () => withIsolatedVercelContext(core, (directory) => {
    scratch = directory;
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    writeFileSync(join(directory, "skills-lock.json"), "synthetic");
    writeFileSync(join(directory, ".env.local"), "VERCEL_OIDC_TOKEN=synthetic");
    if (fail) throw new Error("synthetic provider failure");
    mkdirSync(join(directory, ".vercel"), { recursive: true });
    writeFileSync(join(directory, ".vercel", "project.json"), JSON.stringify({ orgId: "team_example", projectId: "prj_example", projectName: "example", unexpected: "discarded" }));
  }, { retainProjectLink: true });
  if (fail) assert.throws(invoke, /synthetic provider failure/); else {
    invoke();
    assert.deepEqual(JSON.parse(readFileSync(join(core, ".vercel", "project.json"))), { orgId: "team_example", projectId: "prj_example", projectName: "example" });
  }
  assert.equal(existsSync(scratch), false);
  assert.equal(existsSync(join(core, "skills-lock.json")), false);
  assert.equal(existsSync(join(core, ".env.local")), false);
}));

test("production health uses a provider-confirmed alias without following SSO redirects", async () => {
  const state = { schema_version: 5, answers: { model_route: "openai-direct", model: "openai/gpt-5.4-nano" }, verification: { database_schema: { qualification: { manifestDigest: "manifest" } } }, deployment: { id: "dpl_example" }, artifact: { hash: "a", core_commit: "c", workspace_commit: "w", resolved_toolset_hash: "t" } };
  const health = { ok: true, status: "ready", modelRoute: "openai-direct", model: "openai/gpt-5.4-nano", databaseManifestDigest: "manifest", deploymentId: "dpl_example", artifactHash: "a", coreCommit: "c", workspaceCommit: "w", resolvedToolSetHash: "t", agent: "oregano", tools: [] };
  const inspected = { id: "dpl_example", target: "production", aliases: ["protected.example.test", "public.example.test"] };
  const calls = [];
  const checked = await fetchVerifiedProductionHealth(state, inspected, async (url, options) => {
    calls.push(url); assert.equal(options.redirect, "manual");
    if (url.includes("protected")) return { ok: false, status: 302, text: async () => "private-login-html" };
    return { ok: true, status: 200, json: async () => health };
  });
  assert.equal(checked.url, "https://public.example.test"); assert.equal(calls.length, 2);
  await assert.rejects(fetchVerifiedProductionHealth(state, inspected, async () => ({ ok: true, json: async () => ({ ...health, deploymentId: "dpl_other" }) })), /exact ready deployment/);
  await assert.rejects(fetchVerifiedProductionHealth(state, { ...inspected, id: "dpl_other" }), /exact production deployment/);
  await assert.rejects(fetchVerifiedProductionHealth(state, { ...inspected, target: "preview" }), /exact production deployment/);
  await assert.rejects(fetchVerifiedProductionHealth(state, { ...inspected, aliases: ["https://untrusted.example.test/path", "localhost", "127.0.0.1"] }), /exact ready deployment/);
});
test("non-JSON health diagnostics do not expose login HTML", async () => {
  await assert.rejects(fetchHealth("https://example.test", async () => ({ ok: false, status: 302, text: async () => "private-login-html" }), { attempts: 1 }), (error) => {
    assert.match(error.message, /non-JSON.*302/); assert.doesNotMatch(error.message, /private-login-html/); return true;
  });
});

for (const change of [
  { triggers: undefined }, { triggers: { enabled: false } }, { triggerDestinations: [] },
  { triggerDestinations: [{ projectId: "prj_other", path: "/api/webhooks/slack" }] },
  { triggerDestinations: [{ projectId: "prj_example", path: "/wrong" }] },
  { triggerDestinations: [{ projectId: "prj_example", path: "/api/webhooks/slack", branch: "preview" }] },
  { triggerDestinations: [{ projectId: "prj_example", path: "/api/webhooks/slack", customEnvironmentId: "env_example" }] },
]) test(`Slack app refuses unverified incoming delivery: ${JSON.stringify(change)}`, () => {
  assert.throws(() => resolveSlackApp({ run: () => ({ status: 0, stdout: JSON.stringify({ ...syntheticSlackConnector(), ...change }), stderr: "" }) }, "/tmp/core", "example", { id: "scl_example", uid: "slack/example" }, "T12345678", "prj_example"), /trigger forwarding/);
});
test("Slack app refuses a connector attached outside production", () => {
  assert.throws(() => resolveSlackApp({ run: (_file, args) => ({ status: 0, stdout: JSON.stringify(args.some(arg => arg.endsWith("/projects/prj_example")) ? { environments: ["development"] } : syntheticSlackConnector()), stderr: "" }) }, "/tmp/core", "example", { id: "scl_example", uid: "slack/example" }, "T12345678", "prj_example"), /production environment/);
});

for (const version of [1, 2, 3, 4]) test(`retired setup state version ${version} cannot resume or trigger a provider operation`, () => withSetup(async ({ temporary }) => {
  const path = join(temporary, 'retired-state.json');
  writeLiveSetupState(path, { schema_version: version, profile: 'vercel-neon-slack', phase: 'preflight' });
  assert.throws(() => readLiveSetupState(path), /Only current fresh setup sessions/);
  let calls = 0;
  await assert.rejects(advanceLiveSetup({ statePath: path, executor: { run() { calls++; throw new Error('Provider must not be reached'); } } }), /Only current fresh setup sessions/);
  assert.equal(calls, 0);
}));
