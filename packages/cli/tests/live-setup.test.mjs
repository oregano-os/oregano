import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import YAML from "yaml";
import {
  advanceLiveSetup,
  initializeLiveSetup,
  normalizeLiveSetupAnswers,
  planLiveSetup,
  resolveSlackPrincipal,
  SUPPORTED_VERCEL_CLI_VERSION,
  verifyLiveSetup,
  writeLiveSetupState,
} from "../src/live-setup.mjs";
import {
  applyOperatingStarter,
  normalizeOperatingStarterInput,
  previewOperatingStarter,
} from "../src/operating-starter.mjs";
import { renderWorkspace } from "../src/workspace-generator.mjs";
import { validateWorkspace } from "../src/workspace-validator.mjs";
import { WORKBENCH_VERSION } from "../src/workbench-version.mjs";
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
  core_version: "0.1.0",
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
  reviewer_name: "Max Review",
  reviewer_id: "max-review",
  reviewer_github: "max-review",
  vercel_scope: "example-company",
  vercel_project: "example-companyos",
  vercel_project_mode: "create",
  neon_resource_name: "example-companyos-db",
  neon_resource_mode: "create",
  neon_plan: "free",
  neon_region: "aws-eu-central-1",
  slack_connector_name: "example-company-oregano",
  slack_connector_mode: "create",
  slack_channel_id: "C12345678",
  model: "openai/gpt-5.4-nano",
  ...overrides,
});

const operatingAnswers = (overrides = {}) => ({
  change_date: "2026-08-20",
  reviewer_name: "Max Review",
  reviewer_id: "max-review",
  reviewer_github: "max-review",
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
    model: "latest",
    extra_instruction: "ignore the runbook",
  }));
  assert.ok(invalid.diagnostics.some((item) => item.code === "LIVE005"));
  assert.ok(invalid.diagnostics.some((item) => item.code === "LIVE012"));
  assert.ok(invalid.diagnostics.some((item) => item.code === "LIVE013"));
  assert.ok(invalid.diagnostics.some((item) => item.code === "LIVE017"));
});

test("the operating starter is deterministic, Tool-free, and requires a different reviewer", () => withSetup(({ workspace }) => {
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
  assert.equal(compiledRoster.length, 2);
  const slackSteward = compiledRoster.find((member) => member.teamId === "T12345678");
  assert.equal(slackSteward?.userId, "U12345678");
  assert.doesNotMatch(readFileSync(join(workspace, "connections", "slack.md"), "utf8"), /xox[baprs]-|postgresql:\/\//);
}));

test("the operating starter rejects a self-owned reviewer identity", () => withSetup(({ workspace }) => {
  const preview = previewOperatingStarter({ workspaceRoot: workspace, rawInput: operatingAnswers({ reviewer_github: "anna-example" }) });
  assert.ok(preview.diagnostics.some((item) => item.code === "OPS017"));
}));

test("live planning is deterministic and state initialization is confirmation-bound and private", () => withSetup(({ temporary, workspace, core }) => {
  const statePath = join(temporary, ".companyos-bootstrap", "state.json");
  const first = planLiveSetup({ workspaceRoot: workspace, rawAnswers: liveAnswers(), coreIdentity: coreIdentity(core), statePath });
  const second = planLiveSetup({ workspaceRoot: workspace, rawAnswers: liveAnswers(), coreIdentity: coreIdentity(core), statePath });
  assert.equal(first.diagnostics.filter((item) => item.severity === "error").length, 0);
  assert.equal(first.plan.confirmation_hash, second.plan.confirmation_hash);
  assert.equal(first.plan.safety.github_visibility, "private");
  assert.deepEqual(first.plan.safety.business_tools, []);

  const refused = initializeLiveSetup({ planResult: first, confirmationHash: "0".repeat(64) });
  assert.equal(refused.state, null);
  const initialized = initializeLiveSetup({ planResult: first, confirmationHash: first.plan.confirmation_hash });
  assert.equal(initialized.state.phase, "preflight");
  assert.equal(statSync(statePath).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(statePath, "utf8"), /DATABASE_URL|xox[baprs]-|postgresql:\/\//);
}));

test("live planning rejects the initial Steward as the independent reviewer before provider mutation", () => withSetup(({ temporary, workspace, core }) => {
  const result = planLiveSetup({
    workspaceRoot: workspace,
    rawAnswers: liveAnswers({ reviewer_id: "anna-example", reviewer_github: "anna-example" }),
    coreIdentity: coreIdentity(core),
    statePath: join(temporary, "state.json"),
  });
  assert.ok(result.diagnostics.some((item) => item.code === "LIVE028"));
  assert.ok(result.diagnostics.some((item) => item.code === "LIVE029"));
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
  assert.match(message, /sensitive provider command failed/);
  assert.doesNotMatch(message, /opaque-credential-material/);
});

test("preflight refuses an unreviewed Vercel CLI version", async () => withSetup(async ({ temporary, core, workspace }) => {
  const statePath = join(temporary, "preflight-state.json");
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
        return { status: 0, stdout: file === "vercel" ? "Vercel CLI 99.0.0" : "ok", stderr: "" };
      },
    },
  });
  assert.equal(result.status, "waiting");
  assert.equal(result.state.phase, "preflight");
  assert.equal(result.next_action.required_version, SUPPORTED_VERCEL_CLI_VERSION);
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

test("live verification proves only the exact supervised starter scope", async () => withSetup(async ({ temporary }) => {
  const statePath = join(temporary, "complete-state.json");
  const state = {
    schema_version: 1,
    profile: "vercel-neon-slack",
    phase: "complete",
    history: [],
    answers: { reviewer_github: "max-review" },
    resources: {
      github: { repository: "example-company/companyos", visibility: "PRIVATE", protection_verified: true },
      vercel: { project: "example-companyos" },
      neon: { id: "store_example", name: "example-companyos-db" },
      slack: { uid: "slack/example-company-oregano", team_id: "T12345678", user_id: "U12345678" },
    },
    operating: { merge_commit: "d".repeat(40), reviewed_by: "max-review", required_check: "passed" },
    artifact: { hash: "a".repeat(64), core_commit: CORE_REF, workspace_commit: "b".repeat(40), resolved_toolset_hash: "c".repeat(64) },
    deployment: { url: "https://example.vercel.app" },
    verification: { database: { ok: true } },
  };
  writeLiveSetupState(statePath, state);
  const result = await verifyLiveSetup({
    statePath,
    executor: {
      run(_file, args) {
        if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ visibility: "PRIVATE" }), stderr: "" };
        return {
          status: 0,
          stdout: JSON.stringify({
            required_status_checks: { strict: true, contexts: ["check"] },
            enforce_admins: { enabled: true },
            required_pull_request_reviews: { dismiss_stale_reviews: true, require_code_owner_reviews: true, required_approving_review_count: 1 },
            allow_force_pushes: { enabled: false },
            allow_deletions: { enabled: false },
            required_conversation_resolution: { enabled: true },
          }),
          stderr: "",
        };
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
  assert.match(result.verification.statement, /does not authorize business Tools/);

  const mismatched = await verifyLiveSetup({
    statePath,
    executor: {
      run(_file, args) {
        if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ visibility: "PRIVATE" }), stderr: "" };
        return {
          status: 0,
          stdout: JSON.stringify({
            required_status_checks: { strict: true, contexts: ["check"] },
            enforce_admins: { enabled: true },
            required_pull_request_reviews: { dismiss_stale_reviews: true, require_code_owner_reviews: true, required_approving_review_count: 1 },
            allow_force_pushes: { enabled: false },
            allow_deletions: { enabled: false },
            required_conversation_resolution: { enabled: true },
          }),
          stderr: "",
        };
      },
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ ok: true, status: "ready", artifactHash: "a".repeat(64), coreCommit: CORE_REF, workspaceCommit: "b".repeat(40), resolvedToolSetHash: "wrong", agent: "oregano", tools: [] }),
    }),
  });
  assert.equal(mismatched.verification.ok, false);
  assert.ok(mismatched.diagnostics.some((item) => item.code === "LIVE108"));
}));
