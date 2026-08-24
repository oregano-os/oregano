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
  initializeLiveSetup,
  LIVE_SETUP_PROVIDER_PROFILE,
  normalizeLiveSetupAnswers,
  planLiveSetup,
  resolveSlackPrincipal,
  safeProviderError,
  SlackAuthorizationRequiredError,
  SUPPORTED_VERCEL_CLI_VERSION,
  verifyLiveSetup,
  writeLiveSetupState,
} from "../src/live-setup.mjs";
import { assertSetupProviderProfile } from "../src/setup/provider-contracts.ts";
import { assertSetupModelProviderAdapter } from "../src/setup/model-provider-contracts.ts";
import { ANTHROPIC_DIRECT_MODEL_PROVIDER, VERCEL_AI_GATEWAY_MODEL_PROVIDER } from "../src/setup/model-providers.ts";
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
  core_version: "0.3.2",
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

test("live setup answers are bounded data with explicit create or adopt choices", () => {
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

test("legacy answer files without model route fields retain the Gateway behavior", () => {
  const legacy = liveAnswers();
  delete legacy.model_route;
  delete legacy.model_credential_mode;
  const normalized = normalizeLiveSetupAnswers(legacy);
  assert.deepEqual(normalized.diagnostics, []);
  assert.equal(normalized.answers.model_route, "vercel-ai-gateway");
  assert.equal(normalized.answers.model_credential_mode, "platform");
  assert.equal(normalized.answers.model, "openai/gpt-5.4-nano");
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
  assert.deepEqual(LIVE_SETUP_PROVIDER_PROFILE.runtimeHost.expectedProjectConfiguration(), {
    rootDirectory: "packages/runner-vercel",
    framework: "nextjs",
    sourceFilesOutsideRootDirectory: true,
  });
  assert.equal(LIVE_SETUP_PROVIDER_PROFILE.communication.agentDisplayName, "oregano");
  assert.equal(LIVE_SETUP_PROVIDER_PROFILE.communication.expectedConnectorUid(), "slack/oregano");
  assert.throws(() => assertSetupProviderProfile({ ...LIVE_SETUP_PROVIDER_PROFILE, communication: undefined }), /communication/);
});

test("model execution routes have typed, secret-aware setup adapters", () => {
  assert.doesNotThrow(() => assertSetupModelProviderAdapter(VERCEL_AI_GATEWAY_MODEL_PROVIDER));
  assert.doesNotThrow(() => assertSetupModelProviderAdapter(ANTHROPIC_DIRECT_MODEL_PROVIDER));
  assert.equal(VERCEL_AI_GATEWAY_MODEL_PROVIDER.credentialRef, null);
  assert.equal(ANTHROPIC_DIRECT_MODEL_PROVIDER.credentialRef, "ANTHROPIC_API_KEY");
  assert.equal(ANTHROPIC_DIRECT_MODEL_PROVIDER.secretEntrySurface, "runtime-host-dashboard");
  assert.equal(ANTHROPIC_DIRECT_MODEL_PROVIDER.supports("anthropic/claude-sonnet-4-5"), true);
  assert.equal(ANTHROPIC_DIRECT_MODEL_PROVIDER.supports("openai/gpt-5.4-nano"), false);
});

test("the operating starter is deterministic, Tool-free, and keeps one Steward", () => withSetup(({ workspace }) => {
  assert.deepEqual(normalizeOperatingStarterInput(operatingAnswers()).diagnostics, []);
  const first = previewOperatingStarter({ workspaceRoot: workspace, rawInput: operatingAnswers() });
  const second = previewOperatingStarter({ workspaceRoot: workspace, rawInput: operatingAnswers() });
  assert.equal(first.preview.confirmation_hash, second.preview.confirmation_hash);
  assert.equal(first.diagnostics.filter((item) => item.severity === "error").length, 0);
  assert.deepEqual(first.preview.tools, []);
  assert.equal(first.preview.execution_mode, "supervised");

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

test("live planning is deterministic and state initialization is confirmation-bound and private", () => withSetup(({ temporary, workspace, core }) => {
  const statePath = join(temporary, ".companyos-bootstrap", "state.json");
  const first = planLiveSetup({ workspaceRoot: workspace, rawAnswers: liveAnswers(), coreIdentity: coreIdentity(core), statePath });
  const second = planLiveSetup({ workspaceRoot: workspace, rawAnswers: liveAnswers(), coreIdentity: coreIdentity(core), statePath });
  assert.equal(first.diagnostics.filter((item) => item.severity === "error").length, 0);
  assert.equal(first.plan.confirmation_hash, second.plan.confirmation_hash);
  assert.equal(first.plan.safety.github_visibility, "private");
  assert.equal(first.plan.safety.github_protection, "automatic-best-effort");
  assert.deepEqual(first.plan.safety.business_tools, []);

  const refused = initializeLiveSetup({ planResult: first, confirmationHash: "0".repeat(64) });
  assert.equal(refused.state, null);
  const initialized = initializeLiveSetup({ planResult: first, confirmationHash: first.plan.confirmation_hash });
  assert.equal(initialized.state.phase, "preflight");
  assert.equal(statSync(statePath).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(statePath, "utf8"), /DATABASE_URL|xox[baprs]-|postgresql:\/\//);
}));

test("live planning rejects obsolete reviewer fields instead of asking for a second person", () => withSetup(({ temporary, workspace, core }) => {
  const result = planLiveSetup({
    workspaceRoot: workspace,
    rawAnswers: liveAnswers({ reviewer_github: "another-person" }),
    coreIdentity: coreIdentity(core),
    statePath: join(temporary, "state.json"),
  });
  assert.ok(result.diagnostics.some((item) => item.code === "LIVE005" && item.field === "reviewer_github"));
  assert.equal(existsSync(join(temporary, "state.json")), false);
}));

test("the solo live profile refuses to weaken an independent-review Workspace", () => withSetup(({ temporary, workspace, core }) => {
  const governancePath = join(workspace, ".companyos", "governance.yaml");
  const governance = YAML.parse(readFileSync(governancePath, "utf8"));
  governance.review_mode = "independent-review";
  governance.change_classes.security.two_person_review = true;
  governance.change_classes.security.review_model = "author-plus-one-independent-reviewer";
  writeFileSync(governancePath, YAML.stringify(governance));
  const protectionPath = join(workspace, ".companyos", "repository-protection.yaml");
  const protection = YAML.parse(readFileSync(protectionPath, "utf8"));
  protection.rules.required_approvals = 1;
  protection.rules.require_code_owner_review = true;
  writeFileSync(protectionPath, YAML.stringify(protection));
  const result = planLiveSetup({
    workspaceRoot: workspace,
    rawAnswers: liveAnswers(),
    coreIdentity: coreIdentity(core),
    statePath: join(temporary, "state.json"),
  });
  assert.ok(result.diagnostics.some((item) => item.code === "LIVE028"));
  assert.equal(existsSync(join(temporary, "state.json")), false);
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
      return { status: 0, stdout: JSON.stringify({ token: "temporary-user-credential" }), stderr: "" };
    },
  };
  const identity = await resolveSlackPrincipal("slack/example", {
    executor,
    coreRoot: "/tmp/core",
    scope: "example",
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.authorization, "Bearer temporary-user-credential");
      return { ok: true, json: async () => ({ ok: true, team_id: "T12345678", user_id: "U12345678", team: "Example", user: "anna" }) };
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

test("preflight refuses an unreviewed Vercel CLI version", async () => withSetup(async ({ temporary, core, workspace }) => {
  const statePath = join(temporary, "preflight-state.json");
  writeLiveSetupState(statePath, {
    schema_version: 2,
    profile: "vercel-neon-slack",
    plan_hash: "a".repeat(64),
    created_at: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-20T00:00:00.000Z",
    phase: "preflight",
    workspace,
    core: coreIdentity(core),
    answers: liveAnswers(),
    resources: {},
    operating: {},
    artifact: {},
    deployment: {},
    verification: {},
    history: [],
  });
  const result = await advanceLiveSetup({
    statePath,
    executor: {
      run(file) {
        if (file === "pnpm") return { status: 0, stdout: PNPM_VERSION, stderr: "" };
        return { status: 0, stdout: file === "vercel" ? "Vercel CLI 99.0.0" : "ok", stderr: "" };
      },
    },
  });
  assert.equal(result.status, "waiting");
  assert.equal(result.state.phase, "preflight");
  assert.equal(result.next_action.required_version, SUPPORTED_VERCEL_CLI_VERSION);
}));

test("preflight refuses a package manager version other than the repository pin", async () => withSetup(async ({ temporary, core, workspace }) => {
  const statePath = join(temporary, "pnpm-preflight-state.json");
  writeLiveSetupState(statePath, {
    schema_version: 1,
    profile: "vercel-neon-slack",
    plan_hash: "a".repeat(64),
    created_at: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-20T00:00:00.000Z",
    phase: "preflight",
    workspace,
    core: coreIdentity(core),
    answers: liveAnswers(),
    resources: {},
    operating: {},
    artifact: {},
    deployment: {},
    verification: {},
    history: [],
  });
  const result = await advanceLiveSetup({
    statePath,
    executor: {
      run(file) {
        return { status: 0, stdout: file === "pnpm" ? "10.26.2" : "ok", stderr: "" };
      },
    },
  });
  assert.equal(result.status, "waiting");
  assert.equal(result.state.phase, "preflight");
  assert.equal(result.next_action.required_version, PNPM_VERSION);
  assert.deepEqual(result.next_action.command.slice(0, 6), ["npm", "exec", "--yes", `--package=pnpm@${PNPM_VERSION}`, "--", "pnpm"]);
}));

test("live setup records hosted GitHub protection when the provider enforces it", async () => withSetup(async ({ temporary, core, workspace }) => {
  const statePath = join(temporary, "github-protection-enforced-state.json");
  writeLiveSetupState(statePath, {
    schema_version: 1,
    profile: "vercel-neon-slack",
    plan_hash: "a".repeat(64),
    created_at: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-20T00:00:00.000Z",
    phase: "github-protection",
    workspace,
    core: coreIdentity(core),
    answers: liveAnswers(),
    resources: { github: { repository: "example-company/companyos", visibility: "PRIVATE", authenticated_login: "anna-example" } },
    operating: {},
    artifact: {},
    deployment: {},
    verification: {},
    history: [],
  });
  let protectionReads = 0;
  let protectionWrites = 0;
  const result = await advanceLiveSetup({
    statePath,
    executor: {
      run(file, args) {
        if (file === "gh" && args.includes("--method")) {
          protectionWrites += 1;
          return { status: 0, stdout: "", stderr: "" };
        }
        if (file === "gh") {
          protectionReads += 1;
          return protectionReads === 1
            ? { status: 1, stdout: "", stderr: "not configured" }
            : { status: 0, stdout: JSON.stringify(enforcedGitHubProtection), stderr: "" };
        }
        if (file === "vercel") return { status: 1, stdout: "", stderr: "not logged in" };
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  });
  assert.equal(result.status, "waiting");
  assert.equal(result.state.phase, "vercel-auth");
  assert.equal(result.state.resources.github.protection.status, "enforced");
  assert.equal(result.state.resources.github.protection.source, "oregano");
  assert.match(result.state.resources.github.protection.checked_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(protectionReads, 2);
  assert.equal(protectionWrites, 1);
}));

test("existing stronger organization protection is accepted without being overwritten", async () => withSetup(async ({ temporary, core, workspace }) => {
  const statePath = join(temporary, "github-protection-existing-state.json");
  writeLiveSetupState(statePath, {
    schema_version: 1,
    profile: "vercel-neon-slack",
    plan_hash: "a".repeat(64),
    created_at: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-20T00:00:00.000Z",
    phase: "github-protection",
    workspace,
    core: coreIdentity(core),
    answers: liveAnswers({ github_repository_mode: "adopt" }),
    resources: { github: { repository: "example-company/companyos", visibility: "PRIVATE", authenticated_login: "anna-example" } },
    operating: {},
    artifact: {},
    deployment: {},
    verification: {},
    history: [],
  });
  let protectionWrites = 0;
  const result = await advanceLiveSetup({
    statePath,
    executor: {
      run(file, args) {
        if (file === "gh" && args.includes("--method")) protectionWrites += 1;
        if (file === "gh") return {
          status: 0,
          stdout: JSON.stringify({
            ...enforcedGitHubProtection,
            required_pull_request_reviews: {
              dismiss_stale_reviews: true,
              require_code_owner_reviews: true,
              required_approving_review_count: 1,
            },
          }),
          stderr: "",
        };
        if (file === "vercel") return { status: 1, stdout: "", stderr: "not logged in" };
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  });
  assert.equal(result.status, "waiting");
  assert.equal(result.state.resources.github.protection.status, "enforced");
  assert.equal(result.state.resources.github.protection.source, "existing");
  assert.equal(protectionWrites, 0);
}));

test("GitHub Free continues through the same setup path with advisory protection", async () => withSetup(async ({ temporary, core, workspace }) => {
  const statePath = join(temporary, "github-protection-advisory-state.json");
  writeLiveSetupState(statePath, {
    schema_version: 1,
    profile: "vercel-neon-slack",
    plan_hash: "a".repeat(64),
    created_at: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-20T00:00:00.000Z",
    phase: "github-protection",
    workspace,
    core: coreIdentity(core),
    answers: liveAnswers(),
    resources: { github: { repository: "example-company/companyos", visibility: "PRIVATE", authenticated_login: "anna-example" } },
    operating: {},
    artifact: {},
    deployment: {},
    verification: {},
    history: [],
  });
  const result = await advanceLiveSetup({
    statePath,
    executor: {
      run(file) {
        if (file === "gh") return { status: 1, stdout: "", stderr: "upgrade required" };
        if (file === "vercel") return { status: 1, stdout: "", stderr: "not logged in" };
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  });
  assert.equal(result.status, "waiting");
  assert.equal(result.state.phase, "vercel-auth");
  assert.equal(result.next_action.type, "browser-login");
  assert.equal(result.state.resources.github.protection.status, "advisory");
  assert.equal(result.state.resources.github.protection.reason, "github-did-not-accept-hosted-protection");
  assert.doesNotMatch(JSON.stringify(result), /paid|upgrade|GitHub Pro|Enterprise/i);
}));

test("the create path explicitly adds the Vercel project before linking it", async () => withSetup(async ({ temporary, core }) => {
  const statePath = join(temporary, "vercel-project-state.json");
  const state = {
    schema_version: 1,
    profile: "vercel-neon-slack",
    plan_hash: "a".repeat(64),
    created_at: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-20T00:00:00.000Z",
    phase: "vercel-project",
    workspace: join(temporary, "workspace"),
    core: coreIdentity(core),
    answers: liveAnswers(),
    resources: {},
    operating: {},
    artifact: {},
    deployment: {},
    verification: {},
    history: [],
  };
  writeLiveSetupState(statePath, state);
  const calls = [];
  let projectConfiguration = { rootDirectory: null, framework: null, sourceFilesOutsideRootDirectory: true };
  const result = await advanceLiveSetup({
    statePath,
    executor: {
      run(file, args) {
        calls.push([file, ...args]);
        if (file === "vercel" && args[0] === "project" && args[1] === "inspect") return { status: 1, stdout: "", stderr: "not found" };
        if (file === "vercel" && args[0] === "project" && args[1] === "add") return { status: 0, stdout: "created", stderr: "" };
        if (file === "vercel" && args[0] === "link") {
          mkdirSync(join(core, ".vercel"), { recursive: true });
          writeFileSync(join(core, ".vercel", "project.json"), JSON.stringify({ projectId: "prj_example" }));
          return { status: 0, stdout: "linked", stderr: "" };
        }
        if (file === "vercel" && args[0] === "api") {
          if (args.includes("PATCH")) projectConfiguration = { rootDirectory: "packages/runner-vercel", framework: "nextjs", sourceFilesOutsideRootDirectory: true };
          return { status: 0, stdout: JSON.stringify(projectConfiguration), stderr: "" };
        }
        if (file === "vercel" && args[0] === "integration") return { status: 1, stdout: "", stderr: "stop after project phase" };
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  });
  assert.equal(result.status, "blocked");
  const addIndex = calls.findIndex((args) => args[0] === "vercel" && args[1] === "project" && args[2] === "add");
  const linkIndex = calls.findIndex((args) => args[0] === "vercel" && args[1] === "link");
  assert.ok(addIndex >= 0);
  assert.ok(linkIndex > addIndex);
  assert.equal(result.state.resources.vercel.id, "prj_example");
  assert.equal(result.state.phase, "neon");
}));

test("direct Anthropic pauses for browser-only secret entry and records presence without the key", async () => withSetup(async ({ temporary, core, workspace }) => {
  const statePath = join(temporary, "anthropic-direct-state.json");
  writeLiveSetupState(statePath, {
    schema_version: 3,
    profile: "vercel-neon-slack",
    plan_hash: "a".repeat(64),
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
    phase: "model-credential",
    workspace,
    core: coreIdentity(core),
    answers: liveAnswers({
      model_route: "anthropic-direct",
      model_credential_mode: "configure",
      model: "anthropic/claude-sonnet-4-5",
    }),
    resources: { vercel: { id: "prj_synthetic", project: "example-companyos", scope: "example-company" } },
    intents: {}, operating: {}, artifact: {}, deployment: {}, verification: {}, history: [],
  });
  let credentialPresent = false;
  let credentialType = "sensitive";
  const executor = {
    run(file, args) {
      assert.equal(file, "vercel");
      if (args[0] === "env" && args[1] === "list") {
        return { status: 0, stdout: JSON.stringify(credentialPresent ? [{ key: "ANTHROPIC_API_KEY", type: credentialType }] : []), stderr: "" };
      }
      if (args[0] === "integration") return { status: 1, stdout: "", stderr: "stop after credential gate" };
      return { status: 0, stdout: "{}", stderr: "" };
    },
  };
  const waiting = await advanceLiveSetup({ statePath, executor });
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.state.phase, "model-credential");
  assert.equal(waiting.next_action.type, "browser-secret-entry");
  assert.equal(waiting.next_action.variable_name, "ANTHROPIC_API_KEY");
  assert.equal(waiting.next_action.sensitive, true);
  assert.equal(waiting.next_action.key_creation_url, "https://platform.claude.com/settings/keys");
  assert.match(waiting.next_action.url, /settings\/environment-variables$/);
  assert.doesNotMatch(readFileSync(statePath, "utf8"), /synthetic-test-value|sk-ant/);

  credentialPresent = true;
  credentialType = "encrypted";
  const unsafeVariable = await advanceLiveSetup({ statePath, executor });
  assert.equal(unsafeVariable.status, "blocked");
  assert.equal(unsafeVariable.state.phase, "model-credential");
  assert.match(unsafeVariable.message, /not classified as Sensitive/);

  credentialType = "sensitive";
  const resumed = await advanceLiveSetup({ statePath, executor });
  assert.equal(resumed.status, "blocked");
  assert.equal(resumed.state.phase, "neon");
  assert.equal(resumed.state.resources.model.route, "anthropic-direct");
  assert.equal(resumed.state.resources.model.provider, "anthropic");
  assert.equal(resumed.state.resources.model.credential_status, "present-sensitive");
  assert.equal("credential" in resumed.state.resources.model, false);
}));

test("an adopted Vercel project with a conflicting runner root is left unchanged", async () => withSetup(async ({ temporary, core, workspace }) => {
  const statePath = join(temporary, "vercel-adopt-conflict-state.json");
  writeLiveSetupState(statePath, {
    schema_version: 2,
    profile: "vercel-neon-slack",
    plan_hash: "a".repeat(64),
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
    phase: "vercel-project",
    workspace,
    core: coreIdentity(core),
    answers: liveAnswers({ vercel_project_mode: "adopt" }),
    resources: {}, intents: {}, operating: {}, artifact: {}, deployment: {}, verification: {}, history: [],
  });
  let patches = 0;
  const result = await advanceLiveSetup({
    statePath,
    executor: {
      run(file, args) {
        if (file === "vercel" && args[0] === "project" && args[1] === "inspect") return { status: 0, stdout: "exists", stderr: "" };
        if (file === "vercel" && args[0] === "link") {
          mkdirSync(join(core, ".vercel"), { recursive: true });
          writeFileSync(join(core, ".vercel", "project.json"), JSON.stringify({ projectId: "prj_adopted" }));
          return { status: 0, stdout: "linked", stderr: "" };
        }
        if (file === "vercel" && args[0] === "api") {
          if (args.includes("PATCH")) patches += 1;
          return { status: 0, stdout: JSON.stringify({ rootDirectory: null, framework: null, sourceFilesOutsideRootDirectory: true }), stderr: "" };
        }
        return { status: 0, stdout: "{}", stderr: "" };
      },
    },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.state.phase, "vercel-project");
  assert.match(result.message, /left the project unchanged/);
  assert.equal(patches, 0);
}));

test("Neon creation persists the authoritative create receipt without a name-list refresh", async () => withSetup(async ({ temporary, core, workspace }) => {
  const statePath = join(temporary, "neon-receipt-state.json");
  writeLiveSetupState(statePath, {
    schema_version: 2,
    profile: "vercel-neon-slack",
    plan_hash: "a".repeat(64),
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
    phase: "neon",
    workspace,
    core: coreIdentity(core),
    answers: liveAnswers(),
    resources: { vercel: { id: "prj_synthetic", project: "example-companyos" } },
    intents: {},
    operating: {}, artifact: {}, deployment: {}, verification: {}, history: [],
  });
  let neonLists = 0;
  let neonCreates = 0;
  const result = await advanceLiveSetup({
    statePath,
    executor: {
      run(file, args) {
        if (file === "vercel" && args[0] === "integration" && args[1] === "list") {
          neonLists += 1;
          return { status: 0, stdout: "[]", stderr: "" };
        }
        if (file === "vercel" && args[0] === "integration" && args[1] === "add") {
          neonCreates += 1;
          return { status: 0, stdout: JSON.stringify({ resource: { id: "store_synthetic", uid: "neon/store-synthetic", name: "example-companyos-db" } }), stderr: "" };
        }
        if (file === "vercel" && args[0] === "connect") return { status: 1, stdout: "", stderr: "stop after Neon" };
        return { status: 0, stdout: "{}", stderr: "" };
      },
    },
  });
  assert.equal(result.status, "blocked");
  assert.equal(neonCreates, 1);
  assert.equal(neonLists, 1);
  assert.equal(result.state.resources.neon.id, "store_synthetic");
  assert.equal(result.state.intents["neon-resource-create"].status, "completed");
}));

test("a pending Neon create intent reconciles by identity and never creates a duplicate", async () => withSetup(async ({ temporary, core, workspace }) => {
  const statePath = join(temporary, "neon-resume-state.json");
  writeLiveSetupState(statePath, {
    schema_version: 2,
    profile: "vercel-neon-slack",
    plan_hash: "a".repeat(64),
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
    phase: "neon",
    workspace,
    core: coreIdentity(core),
    answers: liveAnswers(),
    resources: { vercel: { id: "prj_synthetic", project: "example-companyos" } },
    intents: {
      "neon-resource-create": {
        status: "pending",
        target: { provider: "neon", operation: "create-state-resource", name: "example-companyos-db", plan: "free_v3", region: "fra1" },
        started_at: "2026-08-24T00:00:00.000Z",
      },
    },
    operating: {}, artifact: {}, deployment: {}, verification: {}, history: [],
  });
  let neonCreates = 0;
  const result = await advanceLiveSetup({
    statePath,
    executor: {
      run(file, args) {
        if (file === "vercel" && args[0] === "integration" && args[1] === "list") return { status: 0, stdout: JSON.stringify([{ id: "store_synthetic", uid: "neon/store-synthetic", name: "example-companyos-db" }]), stderr: "" };
        if (file === "vercel" && args[0] === "integration" && args[1] === "add") neonCreates += 1;
        if (file === "vercel" && args[0] === "connect") return { status: 1, stdout: "", stderr: "stop after Neon" };
        return { status: 0, stdout: "{}", stderr: "" };
      },
    },
  });
  assert.equal(result.status, "blocked");
  assert.equal(neonCreates, 0);
  assert.equal(result.state.resources.neon.id, "store_synthetic");
  assert.equal(result.state.intents["neon-resource-create"].status, "completed");
}));

test("Slack creation trusts its exact receipt, attaches one explicit route, and pauses for browser identity authorization", async () => withSetup(async ({ temporary, core, workspace }) => {
  const statePath = join(temporary, "slack-receipt-state.json");
  writeLiveSetupState(statePath, {
    schema_version: 2,
    profile: "vercel-neon-slack",
    plan_hash: "a".repeat(64),
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
    phase: "slack",
    workspace,
    core: coreIdentity(core),
    answers: liveAnswers(),
    resources: { vercel: { id: "prj_synthetic", project: "example-companyos" }, neon: { id: "store_synthetic" } },
    intents: {},
    operating: {}, artifact: {}, deployment: {}, verification: {}, history: [],
  });
  let connectorLists = 0;
  let createArgs;
  let attachArgs;
  const result = await advanceLiveSetup({
    statePath,
    executor: {
      run(file, args) {
        if (file !== "vercel") return { status: 0, stdout: "{}", stderr: "" };
        if (args[0] === "connect" && args[1] === "list") {
          connectorLists += 1;
          return { status: 0, stdout: "[]", stderr: "" };
        }
        if (args[0] === "connect" && args[1] === "create") {
          createArgs = args;
          return { status: 0, stdout: JSON.stringify({ connector: { id: "scl_synthetic", uid: "slack/oregano", name: "oregano" } }), stderr: "" };
        }
        if (args[0] === "connect" && args[1] === "attach") {
          attachArgs = args;
          return { status: 0, stdout: JSON.stringify({ id: "destination_synthetic", path: "/api/webhooks/slack" }), stderr: "" };
        }
        if (args[0] === "connect" && args[1] === "token") return { status: 1, stdout: "opaque", stderr: "authorization required" };
        return { status: 0, stdout: "{}", stderr: "" };
      },
    },
  });
  assert.equal(result.status, "waiting");
  assert.equal(result.state.phase, "slack-identity");
  assert.equal(result.next_action.type, "browser-authorization");
  assert.ok(result.next_action.command.includes("identity.basic"));
  assert.equal(connectorLists, 1);
  assert.equal(createArgs.includes("--triggers"), false);
  assert.equal(attachArgs[attachArgs.indexOf("--trigger-path") + 1], "/api/webhooks/slack");
  assert.equal(result.state.resources.slack.uid, "slack/oregano");
  assert.equal(result.state.resources.slack.expected_display_name, "oregano");
  assert.equal(result.state.intents["slack-connector-create"].status, "completed");
  assert.equal(result.state.intents["slack-trigger-attach"].status, "completed");
}));

test("production deployment stores a structured ready receipt before health and never parses a log URL", async () => withSetup(async ({ temporary, core, workspace }) => {
  const statePath = join(temporary, "deployment-receipt-state.json");
  writeLiveSetupState(statePath, {
    schema_version: 2,
    profile: "vercel-neon-slack",
    plan_hash: "a".repeat(64),
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
    phase: "production-deployment",
    workspace,
    core: coreIdentity(core),
    answers: { ...liveAnswers(), vercel_scope: "synthetic-scope", vercel_project: "synthetic-project" },
    resources: { vercel: { id: "prj_synthetic", project: "synthetic-project" } },
    intents: {},
    operating: {},
    artifact: { hash: "a".repeat(64), core_commit: CORE_REF, workspace_commit: "b".repeat(40), resolved_toolset_hash: "c".repeat(64) },
    deployment: {},
    verification: {},
    history: [],
  });
  let deployArgs;
  let inspectArgs;
  const result = await advanceLiveSetup({
    statePath,
    executor: {
      run(file, args) {
        if (file === "vercel" && args[0] === "deploy") {
          deployArgs = args;
          return { status: 0, stdout: JSON.stringify({ id: "dpl_synthetic", url: "synthetic-project.example.test" }), stderr: "misleading https://logs.example.test" };
        }
        if (file === "vercel" && args[0] === "inspect") {
          inspectArgs = args;
          return { status: 0, stdout: JSON.stringify({ id: "dpl_synthetic", readyState: "READY" }), stderr: "" };
        }
        if (file === "vercel" && args[0] === "env") return { status: 1, stdout: "", stderr: "verification pending" };
        return { status: 0, stdout: "{}", stderr: "" };
      },
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, status: "ready", artifactHash: "a".repeat(64), coreCommit: CORE_REF, workspaceCommit: "b".repeat(40), resolvedToolSetHash: "c".repeat(64), agent: "oregano", tools: [] }),
    }),
  });
  assert.equal(result.status, "waiting");
  assert.equal(result.state.phase, "slack-verification");
  assert.ok(deployArgs.includes("--format"));
  assert.equal(result.state.deployment.id, "dpl_synthetic");
  assert.equal(result.state.deployment.url, "https://synthetic-project.example.test");
  assert.equal(result.state.deployment.ready_state, "READY");
  assert.equal(inspectArgs[1], "dpl_synthetic");
  assert.equal(result.state.intents["vercel-production-deployment"].status, "completed");
}));

test("live verification proves only the exact supervised starter scope", async () => withSetup(async ({ temporary }) => {
  const statePath = join(temporary, "complete-state.json");
  const state = {
    schema_version: 2,
    profile: "vercel-neon-slack",
    phase: "complete",
    history: [],
    answers: {},
    resources: {
      github: { repository: "example-company/companyos", visibility: "PRIVATE", protection: { status: "enforced", checked_at: "2026-08-21T09:00:00.000Z" }, authenticated_login: "anna-example" },
      vercel: { project: "example-companyos", configuration: { root_directory: "packages/runner-vercel", framework: "nextjs", source_files_outside_root_directory: true } },
      neon: { id: "store_example", name: "example-companyos-db" },
      slack: { uid: "slack/oregano", team_id: "T12345678", user_id: "U12345678", trigger_path: "/api/webhooks/slack", expected_display_name: "oregano" },
    },
    intents: {},
    operating: { merge_commit: "d".repeat(40), merge_authorized_by: "anna-example", merge_authorized_at: "2026-08-21T10:00:00.000Z", required_check: "passed" },
    artifact: { hash: "a".repeat(64), core_commit: CORE_REF, workspace_commit: "b".repeat(40), resolved_toolset_hash: "c".repeat(64) },
    deployment: { url: "https://example.vercel.app", ready_state: "READY" },
    verification: { database: { ok: true } },
  };
  writeLiveSetupState(statePath, state);
  const result = await verifyLiveSetup({
    statePath,
    executor: {
      run(_file, args) {
        if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ visibility: "PRIVATE" }), stderr: "" };
        return { status: 0, stdout: JSON.stringify(enforcedGitHubProtection), stderr: "" };
      },
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ ok: true, status: "ready", artifactHash: "a".repeat(64), coreCommit: CORE_REF, workspaceCommit: "b".repeat(40), resolvedToolSetHash: "c".repeat(64), agent: "oregano", tools: [] }),
    }),
  });
  assert.equal(result.verification.ok, true);
  assert.equal(result.verification.scope, "live-starter-instance");
  assert.equal(result.verification.readiness, "validated");
  assert.equal(result.verification.github_protection, "enforced");
  assert.match(result.verification.statement, /does not authorize business Tools/);

  const enforcementLost = await verifyLiveSetup({
    statePath,
    executor: {
      run(_file, args) {
        if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ visibility: "PRIVATE" }), stderr: "" };
        return { status: 1, stdout: "", stderr: "not available" };
      },
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ ok: true, status: "ready", artifactHash: "a".repeat(64), coreCommit: CORE_REF, workspaceCommit: "b".repeat(40), resolvedToolSetHash: "c".repeat(64), agent: "oregano", tools: [] }),
    }),
  });
  assert.equal(enforcementLost.verification.ok, true);
  assert.equal(enforcementLost.verification.github_protection, "advisory");
  assert.ok(enforcementLost.diagnostics.some((item) => item.code === "LIVE113" && item.severity === "warning"));

  state.resources.github.protection = { status: "advisory", checked_at: "2026-08-21T09:00:00.000Z", reason: "github-did-not-accept-hosted-protection" };
  writeLiveSetupState(statePath, state);
  const freePlan = await verifyLiveSetup({
    statePath,
    executor: {
      run(_file, args) {
        if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ visibility: "PRIVATE" }), stderr: "" };
        return { status: 1, stdout: "", stderr: "not available" };
      },
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ ok: true, status: "ready", artifactHash: "a".repeat(64), coreCommit: CORE_REF, workspaceCommit: "b".repeat(40), resolvedToolSetHash: "c".repeat(64), agent: "oregano", tools: [] }),
    }),
  });
  assert.equal(freePlan.verification.ok, true);
  assert.equal(freePlan.verification.readiness, "validated");
  assert.equal(freePlan.verification.github_protection, "advisory");
  assert.ok(freePlan.diagnostics.some((item) => item.code === "LIVE113" && item.severity === "info"));

  const mismatched = await verifyLiveSetup({
    statePath,
    executor: {
      run(_file, args) {
        if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ visibility: "PRIVATE" }), stderr: "" };
        return { status: 0, stdout: JSON.stringify(enforcedGitHubProtection), stderr: "" };
      },
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ ok: true, status: "ready", artifactHash: "a".repeat(64), coreCommit: CORE_REF, workspaceCommit: "b".repeat(40), resolvedToolSetHash: "wrong", agent: "oregano", tools: [] }),
    }),
  });
  assert.equal(mismatched.verification.ok, false);
  assert.ok(mismatched.diagnostics.some((item) => item.code === "LIVE108"));

  state.intents = { "provider-create": { status: "pending", target: { provider: "synthetic" } } };
  writeLiveSetupState(statePath, state);
  const unresolvedReceipt = await verifyLiveSetup({
    statePath,
    executor: {
      run(_file, args) {
        if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ visibility: "PRIVATE" }), stderr: "" };
        return { status: 0, stdout: JSON.stringify(enforcedGitHubProtection), stderr: "" };
      },
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ ok: true, status: "ready", artifactHash: "a".repeat(64), coreCommit: CORE_REF, workspaceCommit: "b".repeat(40), resolvedToolSetHash: "c".repeat(64), agent: "oregano", tools: [] }),
    }),
  });
  assert.equal(unresolvedReceipt.verification.ok, false);
  assert.ok(unresolvedReceipt.diagnostics.some((item) => item.code === "LIVE116"));
}));

test("new live verification binds direct Anthropic route, credential presence, health, and persisted model evidence", async () => withSetup(async ({ temporary }) => {
  const statePath = join(temporary, "direct-complete-state.json");
  const state = {
    schema_version: 3,
    profile: "vercel-neon-slack",
    phase: "complete",
    history: [],
    answers: liveAnswers({
      model_route: "anthropic-direct",
      model_credential_mode: "adopt",
      model: "anthropic/claude-sonnet-4-5",
    }),
    resources: {
      github: { repository: "example-company/companyos", visibility: "PRIVATE", protection: { status: "enforced", checked_at: "2026-08-24T09:00:00.000Z" }, authenticated_login: "anna-example" },
      vercel: { project: "example-companyos", configuration: { root_directory: "packages/runner-vercel", framework: "nextjs", source_files_outside_root_directory: true } },
      neon: { id: "store_example", name: "example-companyos-db" },
      slack: { uid: "slack/oregano", team_id: "T12345678", user_id: "U12345678", trigger_path: "/api/webhooks/slack", expected_display_name: "oregano" },
      model: { route: "anthropic-direct", provider: "anthropic", model: "anthropic/claude-sonnet-4-5", credentialRef: "ANTHROPIC_API_KEY", credential_mode: "adopt", credential_status: "present-sensitive" },
    },
    intents: {},
    operating: { merge_commit: "d".repeat(40), merge_authorized_by: "anna-example", merge_authorized_at: "2026-08-24T10:00:00.000Z", required_check: "passed" },
    artifact: { hash: "a".repeat(64), core_commit: CORE_REF, workspace_commit: "b".repeat(40), resolved_toolset_hash: "c".repeat(64) },
    deployment: { url: "https://example.vercel.app", ready_state: "READY" },
    verification: { database: { ok: true, model_evidence_entries: 1 } },
  };
  writeLiveSetupState(statePath, state);
  const executor = {
    run(_file, args) {
      if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ visibility: "PRIVATE" }), stderr: "" };
      return { status: 0, stdout: JSON.stringify(enforcedGitHubProtection), stderr: "" };
    },
  };
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      ok: true, status: "ready", artifactHash: "a".repeat(64), coreCommit: CORE_REF,
      workspaceCommit: "b".repeat(40), resolvedToolSetHash: "c".repeat(64), agent: "oregano", tools: [],
      modelRoute: "anthropic-direct", model: "anthropic/claude-sonnet-4-5",
    }),
  });
  const verified = await verifyLiveSetup({ statePath, executor, fetchImpl });
  assert.equal(verified.verification.ok, true);

  state.verification.database.model_evidence_entries = 0;
  writeLiveSetupState(statePath, state);
  const missingEvidence = await verifyLiveSetup({ statePath, executor, fetchImpl });
  assert.equal(missingEvidence.verification.ok, false);
  assert.ok(missingEvidence.diagnostics.some((item) => item.code === "LIVE121"));
}));
