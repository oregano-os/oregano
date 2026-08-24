import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import YAML from "yaml";
import { diagnostic } from "./diagnostics.mjs";
import { PNPM_VERSION } from "./core-version.mjs";
import { applyOperatingStarter, previewOperatingStarter } from "./operating-starter.mjs";
import { validateWorkspace } from "./workspace-validator.mjs";
import { VERCEL_NEON_SLACK_PROFILE } from "./setup/profiles/vercel-neon-slack.ts";
import { setupModelProvider } from "./setup/model-providers.ts";
import { legacyGatewaySelection, normalizeModelExecution } from "../../runner/model-execution.ts";

export const LIVE_SETUP_PROFILE = VERCEL_NEON_SLACK_PROFILE.id;
export const LIVE_SETUP_PROVIDER_PROFILE = VERCEL_NEON_SLACK_PROFILE;
export const LIVE_SETUP_STATE_VERSION = 3;
export const SUPPORTED_VERCEL_CLI_VERSION = VERCEL_NEON_SLACK_PROFILE.runtimeHost.cliVersion;

export const LIVE_SETUP_FIELDS = [
  "change_date",
  "steward_email",
  "github_owner",
  "github_repository",
  "github_account_type",
  "github_repository_mode",
  "vercel_scope",
  "vercel_project",
  "vercel_project_mode",
  "neon_resource_name",
  "neon_resource_mode",
  "neon_plan",
  "neon_region",
  "slack_connector_name",
  "slack_connector_mode",
  "slack_channel_id",
  "model_route",
  "model_credential_mode",
  "model",
];

const SENSITIVE_KEY = /(?:^|_)(?:token|password|secret|private_key|database_url|connection_string|artifact_gzip)(?:_|$)/i;
const CREDENTIAL_VALUE = /(?:postgres(?:ql)?:\/\/[^\s]+:[^\s]+@|xox[a-z0-9](?:[.-][A-Za-z0-9-]+)+|sk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const hasErrors = (diagnostics) => diagnostics.some((item) => item.severity === "error");
const clean = (value) => String(value ?? "").normalize("NFC").trim();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const exactPnpmCommand = (coreRoot, ...args) => ["npm", "exec", "--yes", `--package=pnpm@${PNPM_VERSION}`, "--", "pnpm", "--dir", coreRoot, ...args];

export const safeProviderError = (value) => {
  const redacted = clean(value)
  .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")
  .replace(/xox[a-z0-9](?:[.-][A-Za-z0-9-]+)+/gi, "[REDACTED_SLACK_CREDENTIAL]")
  .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED_API_KEY]");
  if (redacted.length <= 2400) return redacted;
  return `${redacted.slice(0, 1200)}\n...[safe diagnostic truncated]...\n${redacted.slice(-1200)}`;
};

const safeError = safeProviderError;

const validatePlainLine = (value, field, label, diagnostics, max = 160) => {
  if (!value) diagnostics.push(diagnostic("LIVE001", "error", `${label} is required.`, { field }));
  if (value.length > max) diagnostics.push(diagnostic("LIVE002", "error", `${label} must be at most ${max} characters.`, { field }));
  if (/[\u0000-\u001f\u007f\r\n]/.test(value)) diagnostics.push(diagnostic("LIVE003", "error", `${label} must be one line without control characters.`, { field }));
};

export function normalizeLiveSetupAnswers(raw = {}) {
  const diagnostics = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      answers: Object.fromEntries(LIVE_SETUP_FIELDS.map((field) => [field, ""])),
      diagnostics: [diagnostic("LIVE004", "error", "Live setup answers must be one YAML or JSON object.")],
    };
  }
  for (const field of Object.keys(raw)) {
    if (!LIVE_SETUP_FIELDS.includes(field)) diagnostics.push(diagnostic("LIVE005", "error", `Unknown live setup field '${field}'.`, { field }));
  }
  for (const field of LIVE_SETUP_FIELDS) {
    if (raw[field] !== undefined && typeof raw[field] !== "string") diagnostics.push(diagnostic("LIVE006", "error", `Live setup field '${field}' must be plain text.`, { field }));
  }
  const answers = Object.fromEntries(LIVE_SETUP_FIELDS.map((field) => [field, clean(raw[field])]));
  if (!answers.model_route && !answers.model_credential_mode && answers.model) {
    answers.model_route = "vercel-ai-gateway";
    answers.model_credential_mode = "platform";
  }
  for (const [field, label] of [
    ["change_date", "Change date"],
    ["steward_email", "Workspace Steward email"],
    ["github_owner", "GitHub owner"],
    ["github_repository", "GitHub repository"],
    ["github_account_type", "GitHub account type"],
    ["github_repository_mode", "GitHub repository mode"],
    ["vercel_scope", "Vercel account or team"],
    ["vercel_project", "Vercel project"],
    ["vercel_project_mode", "Vercel project mode"],
    ["neon_resource_name", "Neon resource name"],
    ["neon_resource_mode", "Neon resource mode"],
    ["neon_plan", "Neon plan"],
    ["slack_connector_name", "Slack connector name"],
    ["slack_connector_mode", "Slack connector mode"],
    ["model_route", "Model execution route"],
    ["model_credential_mode", "Model credential mode"],
    ["model", "Model"],
  ]) validatePlainLine(answers[field], field, label, diagnostics);
  if (answers.neon_region) validatePlainLine(answers.neon_region, "neon_region", "Neon region", diagnostics);
  if (answers.slack_channel_id) validatePlainLine(answers.slack_channel_id, "slack_channel_id", "Slack test channel ID", diagnostics);

  if (answers.change_date && !/^\d{4}-\d{2}-\d{2}$/.test(answers.change_date)) diagnostics.push(diagnostic("LIVE007", "error", "Change date must use YYYY-MM-DD.", { field: "change_date" }));
  if (answers.steward_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answers.steward_email)) diagnostics.push(diagnostic("LIVE008", "error", "Workspace Steward email has an invalid shape.", { field: "steward_email" }));
  for (const field of ["github_owner", "github_repository", "vercel_scope", "vercel_project", "neon_resource_name", "slack_connector_name"]) {
    if (answers[field] && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(answers[field])) diagnostics.push(diagnostic("LIVE009", "error", `${field} contains unsupported characters.`, { field }));
  }
  if (!new Set(["personal", "organization"]).has(answers.github_account_type)) diagnostics.push(diagnostic("LIVE012", "error", "GitHub account type must be 'personal' or 'organization'.", { field: "github_account_type" }));
  for (const field of ["github_repository_mode", "vercel_project_mode", "neon_resource_mode", "slack_connector_mode"]) {
    if (!new Set(["create", "adopt"]).has(answers[field])) diagnostics.push(diagnostic("LIVE013", "error", `${field} must be 'create' or 'adopt'.`, { field }));
  }
  if (answers.neon_plan && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(answers.neon_plan)) diagnostics.push(diagnostic("LIVE014", "error", "Neon plan ID has an invalid shape.", { field: "neon_plan" }));
  if (answers.neon_region && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(answers.neon_region)) diagnostics.push(diagnostic("LIVE015", "error", "Neon region has an invalid shape.", { field: "neon_region" }));
  if (answers.slack_channel_id && !/^[A-Z][A-Z0-9]{5,31}$/.test(answers.slack_channel_id)) diagnostics.push(diagnostic("LIVE016", "error", "Slack channel ID has an invalid shape.", { field: "slack_channel_id" }));
  if (answers.model && !/^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(answers.model)) diagnostics.push(diagnostic("LIVE017", "error", "Model must use provider/model syntax.", { field: "model" }));
  const modelProvider = setupModelProvider(answers.model_route);
  if (!modelProvider) diagnostics.push(diagnostic("LIVE030", "error", "Model route must be 'vercel-ai-gateway' or 'anthropic-direct'.", { field: "model_route" }));
  else {
    if (!modelProvider.allowedCredentialModes.includes(answers.model_credential_mode)) diagnostics.push(diagnostic("LIVE031", "error", `Model route '${answers.model_route}' does not allow credential mode '${answers.model_credential_mode}'.`, { field: "model_credential_mode" }));
    if (answers.model && !modelProvider.supports(answers.model)) diagnostics.push(diagnostic("LIVE032", "error", `Model '${answers.model}' is not supported by route '${answers.model_route}'.`, { field: "model" }));
  }
  if (answers.slack_connector_name && answers.slack_connector_name.toLowerCase() !== VERCEL_NEON_SLACK_PROFILE.communication.agentDisplayName) diagnostics.push(diagnostic("LIVE029", "error", `The maintained Slack profile requires connector name '${VERCEL_NEON_SLACK_PROFILE.communication.agentDisplayName}' so the installed Slack Agent has the fixed visible name oregano.`, { field: "slack_connector_name" }));
  return { answers, diagnostics };
}

export function readLiveSetupAnswers(path) {
  const raw = readFileSync(path, "utf8");
  return path.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw);
}

const workspaceFiles = (root) => {
  const output = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".git", "node_modules", ".companyos-bootstrap", ".vercel", ".companyos-cache"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) output.push(path);
    }
  };
  visit(root);
  return output;
};

export const workspaceFingerprint = (root) => sha256(JSON.stringify(workspaceFiles(root).map((path) => [
  relative(root, path).replaceAll("\\", "/"),
  sha256(readFileSync(path)),
])));

const normalizeCoreIdentity = (raw, diagnostics) => {
  const identity = {
    root: clean(raw?.root),
    repository: clean(raw?.repository),
    ref: clean(raw?.ref).toLowerCase(),
    core_version: clean(raw?.core_version),
    workbench_version: clean(raw?.workbench_version),
    clean: raw?.clean === true,
  };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(identity.repository)) diagnostics.push(diagnostic("LIVE018", "error", "Core repository identity is invalid."));
  if (!/^[0-9a-f]{40}$/.test(identity.ref)) diagnostics.push(diagnostic("LIVE019", "error", "Core ref must be one immutable 40-character Git commit."));
  for (const field of ["core_version", "workbench_version"]) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(identity[field])) diagnostics.push(diagnostic("LIVE020", "error", `${field} must be one exact semantic version.`));
  }
  if (!identity.clean) diagnostics.push(diagnostic("LIVE021", "error", "Live setup requires a clean reviewed Oregano release checkout."));
  if (!existsSync(join(identity.root, "packages", "runner-vercel", "vercel.json"))) diagnostics.push(diagnostic("LIVE022", "error", "This Oregano release does not contain the maintained Vercel Runner."));
  return identity;
};

export function planLiveSetup({ workspaceRoot, rawAnswers, coreIdentity, statePath }) {
  const diagnostics = [];
  let workspace;
  try { workspace = realpathSync(resolve(workspaceRoot)); }
  catch {
    return { plan: null, diagnostics: [diagnostic("LIVE023", "error", `Company Workspace does not exist: ${resolve(workspaceRoot)}`)] };
  }
  const workspaceResult = validateWorkspace(workspace);
  diagnostics.push(...workspaceResult.diagnostics.filter((item) => item.severity === "error"));
  if (workspaceResult.summary?.workspace_mode !== "authoring-only") diagnostics.push(diagnostic("LIVE024", "error", "The one-prompt live profile starts from the locally verified authoring-only Workspace.", { file: "company.md" }));
  if (workspaceResult.summary?.review_mode !== "steward") diagnostics.push(diagnostic("LIVE028", "error", "The one-prompt live profile requires the default steward review mode. Configure a custom independent-review installation outside this profile.", { file: ".companyos/governance.yaml" }));
  const normalized = normalizeLiveSetupAnswers(rawAnswers);
  diagnostics.push(...normalized.diagnostics);
  const core = normalizeCoreIdentity(coreIdentity, diagnostics);
  const effectiveStatePath = resolve(statePath ?? join(dirname(workspace), ".companyos-bootstrap", `${basename(workspace)}-${LIVE_SETUP_PROFILE}-state.json`));
  if (effectiveStatePath.startsWith(`${workspace}/`) && !effectiveStatePath.includes("/.companyos-bootstrap/")) diagnostics.push(diagnostic("LIVE025", "error", "Live setup state must stay outside committed Workspace material."));

  const plan = {
    schema_version: 1,
    profile: LIVE_SETUP_PROFILE,
    providers: {
      source_host: VERCEL_NEON_SLACK_PROFILE.sourceHost.provider,
      runtime_host: VERCEL_NEON_SLACK_PROFILE.runtimeHost.provider,
      state_service: VERCEL_NEON_SLACK_PROFILE.stateService.provider,
      communication: VERCEL_NEON_SLACK_PROFILE.communication.provider,
      model_execution: normalized.answers.model_route,
    },
    workspace,
    workspace_fingerprint: workspaceFingerprint(workspace),
    state_path: effectiveStatePath,
    core: {
      root: core.root,
      repository: core.repository,
      ref: core.ref,
      version: core.core_version,
      workbench_version: core.workbench_version,
    },
    answers: normalized.answers,
    outcome: "One private GitHub Company Workspace and one supervised Oregano Company Instance on Vercel with Neon/Postgres and Slack.",
    mutations: [
      `Initialize and push ${normalized.answers.github_owner}/${normalized.answers.github_repository} as a private GitHub repository.`,
      "Detect and preserve hosted protection on an adopted repository, or apply the solo-Steward protected-main baseline to a new repository when GitHub supports it; otherwise retain the same pull-request, CompanyOS-check, and Steward-confirmation process without hosted enforcement.",
      `${normalized.answers.vercel_project_mode === "create" ? "Create" : "Adopt"} Vercel project '${normalized.answers.vercel_project}' in '${normalized.answers.vercel_scope}'.`,
      `${normalized.answers.neon_resource_mode === "create" ? "Create" : "Adopt"} Neon resource '${normalized.answers.neon_resource_name}' on plan '${normalized.answers.neon_plan}'.`,
      `${normalized.answers.slack_connector_mode === "create" ? "Create" : "Adopt"} Slack connector '${normalized.answers.slack_connector_name}' and attach ${VERCEL_NEON_SLACK_PROFILE.communication.triggerPath}.`,
      "Resolve the consenting human's canonical Slack principal with a short-lived user token and discard the token.",
      "Propose one operating, supervised, Tool-free Oregano Slack assistant in a pull request.",
      `Build an immutable Artifact from Core ${core.ref} and the reviewed Workspace commit.`,
      normalized.answers.model_route === "anthropic-direct"
        ? `Use Anthropic model '${normalized.answers.model}' directly from the Vercel Runner. The human places ANTHROPIC_API_KEY only in the Vercel project Production secret UI; Oregano records neither its value nor a copy.`
        : `Configure Vercel AI Gateway model '${normalized.answers.model}' without a separate model-provider API key.`,
      "Deploy production only after a separate confirmation and prove a model-backed Slack round trip in Neon.",
    ],
    required_human_actions: [
      "Complete GitHub, Vercel, Neon, and Slack browser login or consent when prompted.",
      "Confirm provider plans and possible usage charges before resource creation.",
      "Confirm the exact operating Workspace preview, the checked pull request merge, and the exact production candidate.",
      "Send the generated Slack verification message after deployment.",
      ...(normalized.answers.model_route === "anthropic-direct" ? ["Create or select a dedicated Anthropic API key, then paste it directly into the Vercel project Production secret named ANTHROPIC_API_KEY. Never paste it into chat or a local setup file."] : []),
    ],
    safety: {
      github_visibility: "private",
      github_protection: "automatic-best-effort",
      execution_mode: "supervised",
      business_tools: [],
      credentials_in_chat_or_git: false,
      automatic_resource_deletion: false,
      independent_review_required: false,
      review_mode: "steward",
      model_route: normalized.answers.model_route,
      model_credential_in_chat_git_or_state: false,
    },
  };
  plan.confirmation_hash = sha256(JSON.stringify(plan));
  return { plan, diagnostics };
}

const assertSafeState = (value, path = "state") => {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (CREDENTIAL_VALUE.test(value)) throw new Error(`Refusing possible credential material in ${path}.`);
    return;
  }
  if (Array.isArray(value)) return value.forEach((entry, index) => assertSafeState(entry, `${path}[${index}]`));
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) throw new Error(`Refusing sensitive state field '${path}.${key}'.`);
      assertSafeState(entry, `${path}.${key}`);
    }
  }
};

export function writeLiveSetupState(path, state) {
  assertSafeState(state);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function readLiveSetupState(path) {
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (!new Set([1, 2, LIVE_SETUP_STATE_VERSION]).has(state?.schema_version) || state?.profile !== LIVE_SETUP_PROFILE) throw new Error(`${path}: unsupported live setup state.`);
  assertSafeState(state);
  return state;
}

export function initializeLiveSetup({ planResult, confirmationHash }) {
  if (!planResult?.plan || hasErrors(planResult.diagnostics)) return { state: null, diagnostics: planResult?.diagnostics ?? [] };
  if (confirmationHash !== planResult.plan.confirmation_hash) return { state: null, diagnostics: [...planResult.diagnostics, diagnostic("LIVE026", "error", "Live setup confirmation does not match the current plan.")] };
  if (existsSync(planResult.plan.state_path)) return { state: null, diagnostics: [...planResult.diagnostics, diagnostic("LIVE027", "error", "Live setup state already exists. Use --resume instead of starting a second installation.", { file: planResult.plan.state_path })] };
  const state = {
    schema_version: LIVE_SETUP_STATE_VERSION,
    profile: LIVE_SETUP_PROFILE,
    plan_hash: planResult.plan.confirmation_hash,
    created_at: now(),
    updated_at: now(),
    phase: "preflight",
    workspace: planResult.plan.workspace,
    workspace_fingerprint: planResult.plan.workspace_fingerprint,
    core: planResult.plan.core,
    answers: planResult.plan.answers,
    resources: {},
    intents: {},
    operating: {},
    artifact: {},
    deployment: {},
    verification: {},
    history: [{ phase: "plan", status: "confirmed", at: now() }],
  };
  writeLiveSetupState(planResult.plan.state_path, state);
  return { state, statePath: planResult.plan.state_path, diagnostics: planResult.diagnostics };
}

export function createCommandExecutor() {
  return {
    run(file, args, options = {}) {
      const result = spawnSync(file, args, {
        cwd: options.cwd,
        input: options.input,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        env: options.env ?? process.env,
      });
      return {
        status: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? result.error?.message ?? "",
      };
    },
  };
}

const run = (executor, file, args, options = {}) => {
  const result = executor.run(file, args, options);
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.sensitiveOutput
      ? "sensitive provider command failed; inspect the provider authorization and retry"
      : safeError(result.stderr || result.stdout);
    throw new Error(`${file} ${args[0] ?? ""} failed: ${detail}`);
  }
  return result;
};

const parseJson = (raw, label) => {
  const value = clean(raw);
  for (const start of [value.indexOf("{"), value.indexOf("[")].filter((index) => index >= 0).sort((a, b) => a - b)) {
    try { return JSON.parse(value.slice(start)); } catch {}
  }
  throw new Error(`${label} did not return machine-readable JSON.`);
};

const resourceItems = (value) => Array.isArray(value) ? value : Array.isArray(value?.resources) ? value.resources : Array.isArray(value?.connectors) ? value.connectors : Array.isArray(value?.data) ? value.data : [];
const resourceName = (value) => clean(value?.name ?? value?.displayName ?? value?.uid ?? value?.slug);
const resourceIdentity = (value) => ({
  id: clean(value?.id ?? value?.resourceId ?? value?.uid),
  uid: clean(value?.uid ?? value?.slug ?? value?.id),
  name: resourceName(value),
});

const primaryResource = (value) => {
  const items = resourceItems(value);
  if (items.length > 0) return items[0];
  return value?.resource ?? value?.connector ?? value?.data ?? value;
};

const sameResource = (candidate, receipt, expectedName) => {
  const identity = resourceIdentity(candidate);
  return Boolean(
    (receipt?.id && identity.id === receipt.id) ||
    (receipt?.uid && identity.uid === receipt.uid) ||
    (!receipt?.id && !receipt?.uid && resourceName(candidate) === expectedName),
  );
};

const beginMutation = (statePath, state, key, descriptor) => {
  state.intents ??= {};
  const existing = state.intents[key];
  if (existing) {
    if (existing.status === "completed") return existing;
    if (JSON.stringify(existing.target) !== JSON.stringify(descriptor)) {
      throw new Error(`Refusing to change pending provider mutation '${key}'.`);
    }
    return existing;
  }
  const intent = { status: "pending", target: descriptor, started_at: now() };
  state.intents[key] = intent;
  writeLiveSetupState(statePath, state);
  return intent;
};

const completeMutation = (statePath, state, key, receipt) => {
  state.intents ??= {};
  state.intents[key] = {
    ...(state.intents[key] ?? {}),
    status: "completed",
    completed_at: now(),
    receipt,
  };
  writeLiveSetupState(statePath, state);
};

const hasPendingMutation = (state, key) => state.intents?.[key]?.status === "pending";

const stateResult = (statePath, state, status, message, nextAction = null, diagnostics = []) => ({ statePath, state, status, message, next_action: nextAction, diagnostics });

const savePhase = (statePath, state, next, evidence = {}) => {
  state.phase = next;
  state.updated_at = now();
  Object.assign(state, evidence);
  state.history.push({ phase: next, status: "entered", at: state.updated_at });
  writeLiveSetupState(statePath, state);
};

const wait = (statePath, state, message, action) => stateResult(statePath, state, "waiting", message, action);

const git = (executor, workspace, ...args) => run(executor, "git", ["-C", workspace, ...args]);
const gh = (executor, args, options = {}) => run(executor, "gh", args, options);
const vercel = (executor, coreRoot, args, options = {}) => run(executor, "vercel", [...args, "--cwd", coreRoot, "--scope", options.scope], { ...options, cwd: coreRoot });

const vercelApi = (executor, coreRoot, scope, endpoint, { method = "GET", body } = {}) => {
  const args = ["api", endpoint, "--method", method, "--raw"];
  if (body !== undefined) args.push("--input", "-");
  const result = vercel(executor, coreRoot, args, { scope, input: body === undefined ? undefined : `${JSON.stringify(body)}\n` });
  return parseJson(result.stdout, `Vercel API ${method} ${endpoint}`);
};

const expectedVercelProjectConfiguration = () => ({
  ...VERCEL_NEON_SLACK_PROFILE.runtimeHost.expectedProjectConfiguration(),
});

const projectConfigurationMatches = (project, expected) =>
  clean(project?.rootDirectory) === expected.rootDirectory &&
  clean(project?.framework) === expected.framework &&
  project?.sourceFilesOutsideRootDirectory === expected.sourceFilesOutsideRootDirectory;

const ensureVercelProjectConfiguration = (executor, coreRoot, scope, project, mode) => {
  const endpoint = VERCEL_NEON_SLACK_PROFILE.runtimeHost.projectEndpoint(project);
  const expected = expectedVercelProjectConfiguration();
  let current = vercelApi(executor, coreRoot, scope, endpoint);
  if (!projectConfigurationMatches(current, expected)) {
    if (mode === "adopt") {
      throw new Error(`Adopted Vercel project '${project}' does not use the maintained runner root '${expected.rootDirectory}', framework '${expected.framework}', and outside-root source access. Oregano left the project unchanged.`);
    }
    vercelApi(executor, coreRoot, scope, endpoint, { method: "PATCH", body: expected });
    current = vercelApi(executor, coreRoot, scope, endpoint);
  }
  if (!projectConfigurationMatches(current, expected)) {
    throw new Error(`Vercel did not confirm the maintained runner configuration for project '${project}'.`);
  }
  return {
    root_directory: expected.rootDirectory,
    framework: expected.framework,
    source_files_outside_root_directory: expected.sourceFilesOutsideRootDirectory,
    checked_at: now(),
  };
};

const vercelEnvironmentVariables = (executor, coreRoot, scope, project) => {
  const payload = parseJson(vercel(executor, coreRoot, ["env", "list", "production", "--project", project, "--format", "json"], { scope }).stdout, "Vercel production environment variables");
  const items = Array.isArray(payload) ? payload : payload?.envs ?? payload?.variables ?? payload?.data ?? [];
  return items.map((item) => ({ name: clean(item?.key ?? item?.name), type: clean(item?.type).toLowerCase() })).filter((item) => item.name);
};

const vercelEnvironmentNames = (executor, coreRoot, scope, project) =>
  new Set(vercelEnvironmentVariables(executor, coreRoot, scope, project).map((item) => item.name));

const modelExecutionForState = (state) => state.answers?.model_route
  ? normalizeModelExecution(state.answers.model_route, state.answers.model)
  : legacyGatewaySelection(state.answers?.model);

const modelCredentialDashboardUrl = (state) => `https://vercel.com/${encodeURIComponent(state.answers.vercel_scope)}/${encodeURIComponent(state.answers.vercel_project)}/settings/environment-variables`;

export const createVercelEnvironmentVariable = (executor, coreRoot, scope, project, name, value, { sensitive = false } = {}) => {
  const args = ["env", "add", name, "production", "--yes", sensitive ? "--sensitive" : "--no-sensitive"];
  run(executor, "vercel", [...args, "--project", project, "--cwd", coreRoot, "--scope", scope], { cwd: coreRoot, input: `${value}\n` });
};

export class SlackAuthorizationRequiredError extends Error {
  constructor(connector) {
    super("Slack user authorization is required before Oregano can verify the consenting human principal.");
    this.name = "SlackAuthorizationRequiredError";
    this.connector = connector;
  }
}

export async function resolveSlackPrincipal(connector, { executor = createCommandExecutor(), coreRoot, scope, fetchImpl = globalThis.fetch } = {}) {
  const tokenResult = vercel(executor, coreRoot, [...VERCEL_NEON_SLACK_PROFILE.communication.userAuthorizationArguments(connector)], { scope, sensitiveOutput: true, allowFailure: true });
  if (tokenResult.status !== 0) throw new SlackAuthorizationRequiredError(connector);
  const tokenPayload = parseJson(tokenResult.stdout, "Vercel Connect user authorization");
  const credential = clean(tokenPayload.token ?? tokenPayload.accessToken ?? tokenPayload.access_token);
  if (!credential) throw new Error("Vercel Connect did not return a short-lived Slack user credential.");
  try {
    const response = await fetchImpl("https://slack.com/api/auth.test", { headers: { authorization: `Bearer ${credential}` } });
    const identity = await response.json();
    if (!response.ok || identity?.ok !== true || !identity.team_id || !identity.user_id) throw new Error(`Slack identity verification failed: ${safeError(identity?.error ?? response.status)}`);
    return { team_id: clean(identity.team_id), user_id: clean(identity.user_id), team: clean(identity.team), user: clean(identity.user) };
  } finally {
    // The short-lived credential is intentionally neither returned nor persisted.
  }
}

const ensureInitialWorkspaceCommit = (executor, state) => {
  const workspace = state.workspace;
  const inside = run(executor, "git", ["-C", workspace, "rev-parse", "--is-inside-work-tree"], { allowFailure: true });
  if (inside.status !== 0) run(executor, "git", ["-C", workspace, "init", "-b", "main"]);
  const roster = YAML.parse(readFileSync(join(workspace, "handbook", "roster.md"), "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "")?.members ?? [];
  const steward = roster.find((member) => member?.role === "workspace-steward");
  git(executor, workspace, "config", "user.name", clean(steward?.name));
  git(executor, workspace, "config", "user.email", state.answers.steward_email);
  const head = run(executor, "git", ["-C", workspace, "rev-parse", "HEAD"], { allowFailure: true });
  if (head.status !== 0) {
    git(executor, workspace, "add", "-A");
    git(executor, workspace, "commit", "-m", "chore: establish CompanyOS workspace");
  } else {
    const branch = clean(git(executor, workspace, "branch", "--show-current").stdout);
    if (branch !== "main") throw new Error(`Existing Company Workspace Git branch must be 'main', not '${branch || "detached"}'.`);
    if (clean(git(executor, workspace, "status", "--porcelain").stdout)) throw new Error("Existing Company Workspace Git checkout must be clean before hosted setup.");
  }
};

const githubRepository = (state) => VERCEL_NEON_SLACK_PROFILE.sourceHost.repositoryReference(state.answers.github_owner, state.answers.github_repository);

const assertGitHubProtectionBaseline = (protection) => {
  const contexts = new Set([
    ...(protection?.required_status_checks?.contexts ?? []),
    ...(protection?.required_status_checks?.checks ?? []).map((item) => item?.context).filter(Boolean),
  ]);
  const approvals = Number(protection?.required_pull_request_reviews?.required_approving_review_count);
  if (!contexts.has("check") || protection?.required_status_checks?.strict !== true || protection?.enforce_admins?.enabled !== true ||
      protection?.required_pull_request_reviews?.dismiss_stale_reviews !== true || !Number.isInteger(approvals) || approvals < 0 ||
      protection?.allow_force_pushes?.enabled === true ||
      protection?.allow_deletions?.enabled === true || protection?.required_conversation_resolution?.enabled !== true) {
    throw new Error("GitHub did not report the complete required protected-main baseline after applying it.");
  }
  return protection;
};

const inspectGitHubProtection = (executor, repository) => assertGitHubProtectionBaseline(
  parseJson(gh(executor, ["api", `repos/${repository}/branches/main/protection`]).stdout, "GitHub branch protection"),
);

const applyGitHubProtection = (executor, state) => {
  const repository = githubRepository(state);
  const existing = gh(executor, ["api", `repos/${repository}/branches/main/protection`], { allowFailure: true });
  if (existing.status === 0) {
    try {
      assertGitHubProtectionBaseline(parseJson(existing.stdout, "GitHub branch protection"));
      return { status: "enforced", checked_at: now(), source: "existing" };
    } catch {
      return {
        status: "advisory",
        checked_at: now(),
        reason: "existing-github-protection-left-unchanged",
      };
    }
  }
  if (state.answers.github_repository_mode === "adopt") {
    return {
      status: "advisory",
      checked_at: now(),
      reason: "adopted-repository-protection-left-unchanged",
    };
  }
  const payload = JSON.stringify({
    required_status_checks: { strict: true, contexts: ["check"] },
    enforce_admins: true,
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      required_approving_review_count: 0,
    },
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
    required_conversation_resolution: true,
  });
  const applied = gh(executor, ["api", "--method", "PUT", `repos/${repository}/branches/main/protection`, "--input", "-"], { input: payload, allowFailure: true });
  if (applied.status !== 0) {
    return {
      status: "advisory",
      checked_at: now(),
      reason: "github-did-not-accept-hosted-protection",
    };
  }
  try {
    inspectGitHubProtection(executor, repository);
    return { status: "enforced", checked_at: now(), source: "oregano" };
  } catch {
    return {
      status: "advisory",
      checked_at: now(),
      reason: "github-did-not-confirm-hosted-protection",
    };
  }
};

const createOperatingPullRequest = (executor, state) => {
  const workspace = state.workspace;
  const branch = "companyos/activate-oregano-slack";
  const branchExists = run(executor, "git", ["-C", workspace, "show-ref", "--verify", `refs/heads/${branch}`], { allowFailure: true }).status === 0;
  git(executor, workspace, "switch", ...(branchExists ? [branch] : ["-c", branch]));
  git(executor, workspace, "add", "company.md", "handbook/roster.md", ".companyos/governance.yaml", ".companyos/changes", ".github/CODEOWNERS", "agents/oregano", "workflows", "connections");
  if (run(executor, "git", ["-C", workspace, "diff", "--cached", "--quiet"], { allowFailure: true }).status !== 0) {
    git(executor, workspace, "commit", "-m", "feat: activate supervised Oregano Slack assistant");
  }
  git(executor, workspace, "push", "-u", "origin", branch);
  const existing = parseJson(gh(executor, ["pr", "list", "--repo", githubRepository(state), "--head", branch, "--state", "all", "--json", "url"]).stdout, "GitHub pull request list");
  if (Array.isArray(existing) && existing[0]?.url) return { branch, url: existing[0].url };
  const result = gh(executor, ["pr", "create", "--repo", githubRepository(state), "--base", "main", "--head", branch, "--title", "Activate the supervised Oregano Slack assistant", "--body", "Moves the Company Workspace to operating mode with one Tool-free, supervised Slack assistant. The Workspace Steward confirms the merge after the required CompanyOS check passes."]);
  const url = result.stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];
  if (!url) throw new Error("GitHub did not return the operating Workspace pull request URL.");
  return { branch, url };
};

const inspectPullRequest = (executor, state) => parseJson(gh(executor, ["pr", "view", state.operating.pull_request_url, "--repo", githubRepository(state), "--json", "state,mergeCommit,statusCheckRollup,url"]).stdout, "GitHub pull request");

const requiredCheckPassed = (pullRequest) => (pullRequest?.statusCheckRollup ?? []).some((check) =>
  clean(check?.name ?? check?.context) === "check" && new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]).has(clean(check?.conclusion ?? check?.state).toUpperCase()));

const buildAndConfigureArtifact = (executor, state, statePath, coreRoot) => {
  const coreCommit = clean(git(executor, coreRoot, "rev-parse", "HEAD").stdout);
  if (coreCommit !== state.core.ref) throw new Error("Oregano Core HEAD no longer matches the confirmed release commit.");
  if (clean(git(executor, coreRoot, "status", "--porcelain", "--untracked-files=all").stdout)) throw new Error("Oregano Core must remain clean before Artifact build.");
  git(executor, state.workspace, "switch", "main");
  git(executor, state.workspace, "pull", "--ff-only", "origin", "main");
  if (clean(git(executor, state.workspace, "status", "--porcelain").stdout)) throw new Error("Reviewed Company Workspace must be clean before Artifact build.");
  const workspaceCommit = clean(git(executor, state.workspace, "rev-parse", "HEAD").stdout);
  const instancePath = join(dirname(statePath), `${state.answers.github_repository}-production-instance.yaml`);
  const artifactPath = join(dirname(statePath), `${state.answers.github_repository}-${workspaceCommit.slice(0, 12)}-artifact.json`);
  writeFileSync(instancePath, YAML.stringify({ version: 1, instance_id: `${state.answers.github_repository}-production`, environment: "production", bindings: [] }), { encoding: "utf8", mode: 0o600 });
  if (existsSync(artifactPath)) rmSync(artifactPath, { force: true });
  run(executor, "pnpm", ["companyos", "build", state.workspace, "--instance", instancePath, "--output", artifactPath], { cwd: coreRoot });
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  if (artifact?.provenance?.coreCommit !== state.core.ref || artifact?.provenance?.workspaceCommit !== workspaceCommit || !/^[0-9a-f]{64}$/.test(artifact?.artifactHash ?? "")) throw new Error("Built Artifact provenance does not match the reviewed Core and Workspace commits.");
  const encoded = gzipSync(readFileSync(artifactPath)).toString("base64");
  const project = state.resources.vercel.project;
  const modelExecution = modelExecutionForState(state);
  const definitions = [
    { name: "COMPANYOS_ARTIFACT_GZIP_BASE64", value: encoded, sensitive: true },
    { name: "SLACK_CONNECTOR", value: state.resources.slack.uid, sensitive: false },
    { name: "COMPANYOS_AGENT_ID", value: VERCEL_NEON_SLACK_PROFILE.communication.agentId, sensitive: false },
    { name: "COMPANYOS_MODEL_ROUTE", value: modelExecution.route, sensitive: false },
    { name: "COMPANYOS_MODEL", value: state.answers.model, sensitive: false },
    { name: "BOT_USERNAME", value: VERCEL_NEON_SLACK_PROFILE.communication.agentDisplayName, sensitive: false },
  ];
  const existingNames = vercelEnvironmentNames(executor, coreRoot, state.answers.vercel_scope, project);
  state.deployment.environment_receipts ??= [];
  for (const definition of definitions) {
    const receipt = state.deployment.environment_receipts.find((item) => item.name === definition.name);
    if (receipt?.status === "created") continue;
    const intentKey = `vercel-environment-${sha256(definition.name).slice(0, 12)}`;
    if (existingNames.has(definition.name)) {
      const context = hasPendingMutation(state, intentKey) ? "after a pending create attempt" : "without an Oregano setup receipt";
      throw new Error(`Vercel production environment variable '${definition.name}' already exists ${context}. Oregano cannot verify its value and refused to overwrite or adopt it.`);
    }
    beginMutation(statePath, state, intentKey, { provider: "vercel", operation: "create-environment-variable", project, name: definition.name, environment: "production" });
    createVercelEnvironmentVariable(executor, coreRoot, state.answers.vercel_scope, project, definition.name, definition.value, { sensitive: definition.sensitive });
    state.deployment.environment_receipts.push({ name: definition.name, status: "created", created_at: now() });
    completeMutation(statePath, state, intentKey, { name: definition.name, environment: "production" });
  }
  return {
    hash: artifact.artifactHash,
    core_commit: state.core.ref,
    workspace_commit: workspaceCommit,
    workspace_version: artifact.provenance.workspaceVersion,
    resolved_toolset_hash: artifact.provenance.resolvedToolSetHash,
    local_path: artifactPath,
  };
};

const expectedHealth = (state, health) => health?.ok === true && health?.status === "ready" &&
  health?.artifactHash === state.artifact.hash && health?.coreCommit === state.artifact.core_commit &&
  health?.workspaceCommit === state.artifact.workspace_commit && health?.agent === "oregano" &&
  (state.schema_version < 3 || (health?.modelRoute === modelExecutionForState(state).route && health?.model === modelExecutionForState(state).model)) &&
  health?.resolvedToolSetHash === state.artifact.resolved_toolset_hash &&
  Array.isArray(health?.tools) && health.tools.length === 0;

export const fetchHealth = async (url, fetchImpl = globalThis.fetch, {
  attempts = 5,
  delayMs = 750,
  sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
} = {}) => {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${url.replace(/\/$/, "")}/api/health`);
      let body;
      if (typeof response.text === "function") {
        const raw = await response.text();
        try { body = JSON.parse(raw); }
        catch { throw new Error(`Company Instance health returned a temporary non-JSON response with HTTP ${response.status ?? "unknown"}: ${safeError(raw || "empty response")}`); }
      } else body = await response.json();
      if (!response.ok) throw new Error(`Company Instance health failed with HTTP ${response.status}: ${safeError(body?.error ?? "not ready")}`);
      return body;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(delayMs * attempt);
    }
  }
  throw lastError ?? new Error("Company Instance health did not become ready.");
};

export async function advanceLiveSetup({
  statePath,
  operatingConfirmation,
  mergeConfirmation,
  productionConfirmation,
  executor = createCommandExecutor(),
  fetchImpl = globalThis.fetch,
} = {}) {
  const absoluteStatePath = resolve(statePath);
  const state = readLiveSetupState(absoluteStatePath);
  const coreRoot = realpathSync(state.core.root ?? dirname(dirname(dirname(new URL(import.meta.url).pathname))));
  try {
    for (let advances = 0; advances < 24; advances += 1) {
      if (state.phase === "preflight") {
        const nodeMajor = Number(process.versions.node.split(".")[0]);
        if (!Number.isInteger(nodeMajor) || nodeMajor < 24) return wait(absoluteStatePath, state, "Oregano requires Node.js 24 or newer for this release.", { type: "install-prerequisite", command: "node", minimum_version: "24" });
        for (const command of ["git", "gh"]) {
          if (run(executor, command, ["--version"], { allowFailure: true }).status !== 0) return wait(absoluteStatePath, state, `Required command '${command}' is not installed.`, { type: "install-prerequisite", command });
        }
        const pnpmVersion = run(executor, "pnpm", ["--version"], { allowFailure: true });
        const detectedPnpmVersion = clean(pnpmVersion.stdout || pnpmVersion.stderr).match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
        if (pnpmVersion.status !== 0 || detectedPnpmVersion !== PNPM_VERSION) return wait(absoluteStatePath, state, `Oregano requires pnpm ${PNPM_VERSION}, but found '${detectedPnpmVersion ?? "unavailable"}'. Run the exact repository-local package-manager command instead of installing or replacing a global pnpm.`, { type: "repair-release-dependencies", command: exactPnpmCommand(coreRoot, "install", "--frozen-lockfile"), required_version: PNPM_VERSION });
        const vercelVersion = run(executor, "vercel", ["--version"], { allowFailure: true });
        if (vercelVersion.status !== 0) return wait(absoluteStatePath, state, "The release-bundled Vercel CLI is unavailable. Reinstall the locked Oregano dependencies.", { type: "repair-release-dependencies", command: exactPnpmCommand(coreRoot, "install", "--frozen-lockfile") });
        const detectedVercelVersion = clean(vercelVersion.stdout || vercelVersion.stderr).match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
        if (detectedVercelVersion !== SUPPORTED_VERCEL_CLI_VERSION) return wait(absoluteStatePath, state, `Oregano requires its bundled Vercel CLI ${SUPPORTED_VERCEL_CLI_VERSION}, but found '${detectedVercelVersion ?? "unknown"}'.`, { type: "repair-release-dependencies", command: exactPnpmCommand(coreRoot, "install", "--frozen-lockfile"), required_version: SUPPORTED_VERCEL_CLI_VERSION });
        savePhase(absoluteStatePath, state, "github-auth");
      } else if (state.phase === "github-auth") {
        if (gh(executor, ["auth", "status"], { allowFailure: true }).status !== 0) return wait(absoluteStatePath, state, "GitHub needs your browser login before the private Workspace repository can be created.", { type: "browser-login", command: ["gh", "auth", "login", "--web"] });
        savePhase(absoluteStatePath, state, "github-repository");
      } else if (state.phase === "github-repository") {
        if (workspaceFingerprint(state.workspace) !== state.workspace_fingerprint) throw new Error("Company Workspace content changed after the confirmed setup plan. Create and confirm a new plan before hosted mutation.");
        ensureInitialWorkspaceCommit(executor, state);
        const repository = githubRepository(state);
        const authenticatedLogin = clean(gh(executor, ["api", "user", "--jq", ".login"]).stdout);
        if (state.answers.github_account_type === "personal" && authenticatedLogin.toLowerCase() !== state.answers.github_owner.toLowerCase()) {
          throw new Error(`The selected personal GitHub owner '${state.answers.github_owner}' does not match the authenticated user '${authenticatedLogin}'.`);
        }
        if (state.answers.github_account_type === "organization") {
          const membership = clean(gh(executor, ["api", `orgs/${state.answers.github_owner}/memberships/${authenticatedLogin}`, "--jq", ".state"]).stdout);
          if (membership !== "active") throw new Error(`The authenticated GitHub user is not an active member of organization '${state.answers.github_owner}'.`);
        }
        const existing = gh(executor, ["repo", "view", repository, "--json", "nameWithOwner,url,visibility"], { allowFailure: true });
        const intentKey = "github-repository-create";
        if (state.answers.github_repository_mode === "create" && existing.status === 0 && !hasPendingMutation(state, intentKey) && !state.resources.github?.repository) throw new Error(`GitHub repository '${repository}' already exists; choose adopt explicitly or a new name.`);
        if (state.answers.github_repository_mode === "adopt" && existing.status !== 0) throw new Error(`GitHub repository '${repository}' does not exist and cannot be adopted.`);
        let repositoryData;
        if (existing.status === 0) repositoryData = parseJson(existing.stdout, "GitHub repository");
        else {
          if (state.answers.github_repository_mode === "create") beginMutation(absoluteStatePath, state, intentKey, { provider: "github", operation: "create-private-repository", repository });
          gh(executor, ["repo", "create", repository, "--private", "--source", state.workspace, "--remote", "origin", "--push"]);
          repositoryData = parseJson(gh(executor, ["repo", "view", repository, "--json", "nameWithOwner,url,visibility"]).stdout, "GitHub repository");
        }
        if (String(repositoryData.visibility).toUpperCase() !== "PRIVATE") throw new Error("GitHub repository visibility is not private.");
        if (state.answers.github_repository_mode === "adopt" || (state.answers.github_repository_mode === "create" && existing.status === 0 && hasPendingMutation(state, intentKey))) {
          const origin = run(executor, "git", ["-C", state.workspace, "remote", "get-url", "origin"], { allowFailure: true });
          const expectedRemote = `https://github.com/${repository}.git`;
          if (origin.status !== 0) git(executor, state.workspace, "remote", "add", "origin", expectedRemote);
          else if (!clean(origin.stdout).replace(/\.git$/, "").endsWith(repository)) throw new Error(`Existing Git origin does not match adopted repository '${repository}'.`);
          git(executor, state.workspace, "push", "-u", "origin", "main");
        }
        state.resources.github = { repository, url: repositoryData.url, visibility: "PRIVATE", mode: state.answers.github_repository_mode, authenticated_login: authenticatedLogin };
        if (state.answers.github_repository_mode === "create") completeMutation(absoluteStatePath, state, intentKey, { repository, url: repositoryData.url, visibility: "PRIVATE" });
        savePhase(absoluteStatePath, state, "github-protection");
      } else if (state.phase === "github-protection") {
        state.resources.github.protection = applyGitHubProtection(executor, state);
        savePhase(absoluteStatePath, state, "vercel-auth");
      } else if (state.phase === "vercel-auth") {
        if (vercel(executor, coreRoot, ["whoami"], { scope: state.answers.vercel_scope, allowFailure: true }).status !== 0) return wait(absoluteStatePath, state, "Vercel needs your browser login before the runtime project can be created.", { type: "browser-login", command: ["vercel", "login"] });
        savePhase(absoluteStatePath, state, "vercel-project");
      } else if (state.phase === "vercel-project") {
        const inspect = vercel(executor, coreRoot, ["project", "inspect", state.answers.vercel_project, "--yes"], { scope: state.answers.vercel_scope, allowFailure: true });
        const intentKey = "vercel-project-create";
        if (state.answers.vercel_project_mode === "create" && inspect.status === 0 && !hasPendingMutation(state, intentKey) && !state.resources.vercel?.id) throw new Error(`Vercel project '${state.answers.vercel_project}' already exists; choose adopt explicitly or a new name.`);
        if (state.answers.vercel_project_mode === "adopt" && inspect.status !== 0) throw new Error(`Vercel project '${state.answers.vercel_project}' does not exist and cannot be adopted.`);
        if (state.answers.vercel_project_mode === "create" && inspect.status !== 0) {
          beginMutation(absoluteStatePath, state, intentKey, { provider: "vercel", operation: "create-project", scope: state.answers.vercel_scope, project: state.answers.vercel_project });
          vercel(executor, coreRoot, ["project", "add", state.answers.vercel_project], { scope: state.answers.vercel_scope });
        }
        vercel(executor, coreRoot, ["link", "--project", state.answers.vercel_project, "--team", state.answers.vercel_scope, "--yes"], { scope: state.answers.vercel_scope });
        const projectMetadata = JSON.parse(readFileSync(join(coreRoot, ".vercel", "project.json"), "utf8"));
        const configuration = ensureVercelProjectConfiguration(executor, coreRoot, state.answers.vercel_scope, state.answers.vercel_project, state.answers.vercel_project_mode);
        state.resources.vercel = { id: clean(projectMetadata.projectId), project: state.answers.vercel_project, scope: state.answers.vercel_scope, mode: state.answers.vercel_project_mode, configuration };
        if (state.answers.vercel_project_mode === "create") completeMutation(absoluteStatePath, state, intentKey, { id: state.resources.vercel.id, project: state.resources.vercel.project });
        savePhase(absoluteStatePath, state, "model-credential");
      } else if (state.phase === "model-credential") {
        const selection = modelExecutionForState(state);
        const provider = setupModelProvider(selection.route);
        if (!provider) throw new Error(`Unsupported model execution route '${selection.route}'.`);
        if (!provider.credentialRef) {
          state.resources.model = { ...selection, credential_mode: "platform", credential_status: "not-required", checked_at: now() };
          savePhase(absoluteStatePath, state, "neon");
          continue;
        }
        const environmentVariables = vercelEnvironmentVariables(executor, coreRoot, state.answers.vercel_scope, state.answers.vercel_project);
        const credentialVariable = environmentVariables.find((item) => item.name === provider.credentialRef);
        const present = Boolean(credentialVariable);
        const protectedAsSensitive = credentialVariable?.type === "sensitive";
        state.resources.model ??= { ...selection, credential_mode: state.answers.model_credential_mode };
        if (state.answers.model_credential_mode === "configure") {
          if (!state.resources.model.credential_prompted_at) {
            if (present) throw new Error(`Vercel production environment variable '${provider.credentialRef}' already exists. Choose credential mode 'adopt' explicitly or use a new project; Oregano did not read or change it.`);
            state.resources.model.credential_prompted_at = now();
            writeLiveSetupState(absoluteStatePath, state);
            return wait(absoluteStatePath, state, "Create a dedicated Anthropic API key, then paste it directly into the Vercel project Production Environment Variables page as the Sensitive variable ANTHROPIC_API_KEY. Do not paste the key into chat or a local file.", {
              type: "browser-secret-entry",
              provider: "anthropic",
              key_creation_url: "https://platform.claude.com/settings/keys",
              runtime_host: "vercel",
              url: modelCredentialDashboardUrl(state),
              environment: "production",
              variable_name: provider.credentialRef,
              sensitive: true,
            });
          }
          if (!present) return wait(absoluteStatePath, state, "The Anthropic key is not present yet. Add ANTHROPIC_API_KEY directly to the Vercel project as a Sensitive Production variable, then resume.", {
            type: "browser-secret-entry",
            provider: "anthropic",
            key_creation_url: "https://platform.claude.com/settings/keys",
            runtime_host: "vercel",
            url: modelCredentialDashboardUrl(state),
            environment: "production",
            variable_name: provider.credentialRef,
            sensitive: true,
          });
        } else if (state.answers.model_credential_mode === "adopt" && !present) {
          throw new Error(`Vercel production environment variable '${provider.credentialRef}' was not found for explicit adoption. Oregano did not create or substitute a credential.`);
        }
        if (!protectedAsSensitive) {
          throw new Error(`Vercel production environment variable '${provider.credentialRef}' exists but is not classified as Sensitive. Change it in the Vercel project UI; Oregano did not read, replace, or delete it.`);
        }
        state.resources.model = {
          ...selection,
          credential_mode: state.answers.model_credential_mode,
          credential_status: "present-sensitive",
          checked_at: now(),
        };
        savePhase(absoluteStatePath, state, "neon");
      } else if (state.phase === "neon") {
        const listed = parseJson(vercel(executor, coreRoot, ["integration", "list", "--all", "--integration", "neon", "--format", "json"], { scope: state.answers.vercel_scope }).stdout, "Vercel integrations");
        const intentKey = "neon-resource-create";
        const receipt = state.resources.neon;
        const existing = resourceItems(listed).find((entry) => sameResource(entry, receipt, state.answers.neon_resource_name));
        if (state.answers.neon_resource_mode === "create" && existing && !receipt && !hasPendingMutation(state, intentKey)) throw new Error(`Neon resource '${state.answers.neon_resource_name}' already exists; choose adopt explicitly or another name.`);
        if (state.answers.neon_resource_mode === "adopt" && !existing) throw new Error(`Neon resource '${state.answers.neon_resource_name}' was not found for adoption.`);
        let resource = existing ?? receipt;
        if (!resource) {
          if (hasPendingMutation(state, intentKey)) return wait(absoluteStatePath, state, "The Neon create request was recorded but its immutable resource receipt is not available yet. Wait for provisioning, then resume; Oregano will not create a duplicate.", { type: "wait-for-provider-receipt", provider: "neon", resource_name: state.answers.neon_resource_name });
          beginMutation(absoluteStatePath, state, intentKey, { provider: "neon", operation: "create-state-resource", name: state.answers.neon_resource_name, plan: state.answers.neon_plan, region: state.answers.neon_region || null });
          const args = ["integration", "add", "neon", "--name", state.answers.neon_resource_name, "--plan", state.answers.neon_plan, "--environment", "production", "--environment", "preview", "--environment", "development", "--no-env-pull", "--format", "json"];
          if (state.answers.neon_region) args.push("--metadata", `region=${state.answers.neon_region}`);
          const identity = VERCEL_NEON_SLACK_PROFILE.stateService.normalizeCreateReceipt(parseJson(vercel(executor, coreRoot, args, { scope: state.answers.vercel_scope }).stdout, "Neon resource creation"), state.answers.neon_resource_name);
          if (!identity.id && !identity.uid && !identity.name) throw new Error("Neon resource creation did not return an immutable resource receipt.");
          resource = identity;
          state.resources.neon = { ...resource, mode: state.answers.neon_resource_mode, plan: state.answers.neon_plan, region: state.answers.neon_region || null };
          completeMutation(absoluteStatePath, state, intentKey, resourceIdentity(resource));
        } else {
          if (state.answers.neon_resource_mode === "adopt") vercel(executor, coreRoot, ["integration", "resource", "connect", resourceIdentity(resource).id || resourceIdentity(resource).name, state.answers.vercel_project, "--environment", "production", "--environment", "preview", "--environment", "development", "--format", "json", "--yes"], { scope: state.answers.vercel_scope });
          if (state.answers.neon_resource_mode === "create" && hasPendingMutation(state, intentKey)) completeMutation(absoluteStatePath, state, intentKey, resourceIdentity(resource));
        }
        state.resources.neon = { ...resourceIdentity(resource), mode: state.answers.neon_resource_mode, plan: state.answers.neon_plan, region: state.answers.neon_region || null };
        savePhase(absoluteStatePath, state, "slack");
      } else if (state.phase === "slack") {
        const listed = parseJson(vercel(executor, coreRoot, ["connect", "list", "--all-projects", "--service", "slack", "--search", state.answers.slack_connector_name, "--format", "json"], { scope: state.answers.vercel_scope }).stdout, "Vercel Connect list");
        const createIntentKey = "slack-connector-create";
        const receipt = state.resources.slack;
        const existing = resourceItems(listed).find((entry) => sameResource(entry, receipt, state.answers.slack_connector_name));
        if (state.answers.slack_connector_mode === "create" && existing && !receipt && !hasPendingMutation(state, createIntentKey)) throw new Error(`Slack connector '${state.answers.slack_connector_name}' already exists; choose adopt explicitly or another name.`);
        if (state.answers.slack_connector_mode === "adopt" && !existing) throw new Error(`Slack connector '${state.answers.slack_connector_name}' was not found for adoption.`);
        let connector = existing ?? receipt;
        if (!connector) {
          if (hasPendingMutation(state, createIntentKey)) return wait(absoluteStatePath, state, "The Slack connector create request was recorded but its immutable receipt is not available yet. Wait for installation, then resume; Oregano will not create a duplicate.", { type: "wait-for-provider-receipt", provider: "slack", connector_name: state.answers.slack_connector_name });
          beginMutation(absoluteStatePath, state, createIntentKey, { provider: "slack", operation: "create-connector", name: state.answers.slack_connector_name });
          const createdIdentity = VERCEL_NEON_SLACK_PROFILE.communication.normalizeCreateReceipt(parseJson(vercel(executor, coreRoot, ["connect", "create", "slack", "--name", state.answers.slack_connector_name, "--format", "json"], { scope: state.answers.vercel_scope }).stdout, "Slack connector creation"));
          if (!createdIdentity.id && !createdIdentity.uid) throw new Error("Slack connector creation did not return an immutable connector receipt.");
          connector = createdIdentity;
          state.resources.slack = { ...createdIdentity, mode: state.answers.slack_connector_mode, expected_display_name: VERCEL_NEON_SLACK_PROFILE.communication.agentDisplayName };
          completeMutation(absoluteStatePath, state, createIntentKey, createdIdentity);
        }
        const identity = resourceIdentity(connector);
        const expectedConnectorUid = VERCEL_NEON_SLACK_PROFILE.communication.expectedConnectorUid();
        if (identity.uid !== expectedConnectorUid) throw new Error(`Slack connector did not preserve the fixed Oregano identity '${expectedConnectorUid}'. Oregano left the connector unchanged; choose or create the connector named '${VERCEL_NEON_SLACK_PROFILE.communication.agentDisplayName}'.`);
        const connectorRef = identity.uid.startsWith("slack/") ? identity.uid : identity.id || `slack/${state.answers.slack_connector_name}`;
        const triggerIntentKey = "slack-trigger-attach";
        let triggerReceipt = state.resources.slack?.trigger_receipt;
        if (state.intents?.[triggerIntentKey]?.status !== "completed") {
          beginMutation(absoluteStatePath, state, triggerIntentKey, { provider: "vercel", operation: "attach-trigger", connector: connectorRef, project: state.answers.vercel_project, path: VERCEL_NEON_SLACK_PROFILE.communication.triggerPath });
          triggerReceipt = primaryResource(parseJson(vercel(executor, coreRoot, [...VERCEL_NEON_SLACK_PROFILE.communication.triggerAttachmentArguments(connectorRef, state.answers.vercel_project)], { scope: state.answers.vercel_scope }).stdout, "Slack trigger attachment"));
          completeMutation(absoluteStatePath, state, triggerIntentKey, { connector: connectorRef, project: state.answers.vercel_project, path: VERCEL_NEON_SLACK_PROFILE.communication.triggerPath });
        }
        state.resources.slack = { ...identity, uid: connectorRef, mode: state.answers.slack_connector_mode, trigger_path: VERCEL_NEON_SLACK_PROFILE.communication.triggerPath, trigger_receipt: triggerReceipt, expected_display_name: VERCEL_NEON_SLACK_PROFILE.communication.agentDisplayName };
        savePhase(absoluteStatePath, state, "slack-identity");
      } else if (state.phase === "slack-identity") {
        let identity;
        try { identity = await resolveSlackPrincipal(state.resources.slack.uid, { executor, coreRoot, scope: state.answers.vercel_scope, fetchImpl }); }
        catch (error) {
          if (!(error instanceof SlackAuthorizationRequiredError)) throw error;
          return wait(absoluteStatePath, state, "Slack needs one browser authorization with the minimal identity.basic scope before Oregano can record the consenting human's canonical Slack identity. No token is stored.", { type: "browser-authorization", provider: "slack", command: ["vercel", "connect", "token", state.resources.slack.uid, "--subject", "user", "--scopes", VERCEL_NEON_SLACK_PROFILE.communication.userAuthorizationScopes.join(","), "--yes"] });
        }
        state.resources.slack.team_id = identity.team_id;
        state.resources.slack.user_id = identity.user_id;
        state.resources.slack.team = identity.team;
        savePhase(absoluteStatePath, state, "operating-workspace");
      } else if (state.phase === "operating-workspace") {
        if (clean(git(executor, state.workspace, "status", "--porcelain").stdout)) throw new Error("Company Workspace has uncommitted changes before the operating-starter preview.");
        const rawInput = {
          change_date: state.answers.change_date,
          slack_team_id: state.resources.slack.team_id,
          slack_user_id: state.resources.slack.user_id,
          slack_channel_id: state.answers.slack_channel_id,
        };
        const preview = previewOperatingStarter({ workspaceRoot: state.workspace, rawInput });
        if (hasErrors(preview.diagnostics)) throw new Error(`Operating Workspace preview failed: ${preview.diagnostics.find((item) => item.severity === "error")?.message}`);
        state.operating.preview_hash = preview.preview.confirmation_hash;
        state.operating.workspace_version = preview.preview.workspace_version;
        writeLiveSetupState(absoluteStatePath, state);
        if (operatingConfirmation !== preview.preview.confirmation_hash) return wait(absoluteStatePath, state, "The exact operating Workspace is ready for human confirmation before files are changed.", { type: "confirm-operating-workspace", confirmation_hash: preview.preview.confirmation_hash, summary: { files: preview.preview.files, deletions: preview.preview.deletions, agent: "oregano", execution_mode: "supervised", tools: [] } });
        const applied = applyOperatingStarter({ workspaceRoot: state.workspace, rawInput, confirmationHash: operatingConfirmation });
        if (!applied.applied) throw new Error(`Operating Workspace apply failed: ${applied.diagnostics.find((item) => item.severity === "error")?.message}`);
        state.operating.applied = true;
        savePhase(absoluteStatePath, state, "steward-merge");
      } else if (state.phase === "steward-merge") {
        if (!state.operating.pull_request_url) {
          const pullRequest = createOperatingPullRequest(executor, state);
          state.operating.pull_request_url = pullRequest.url;
          state.operating.branch = pullRequest.branch;
          writeLiveSetupState(absoluteStatePath, state);
        }
        const pullRequest = inspectPullRequest(executor, state);
        if (pullRequest.state === "MERGED") {
          if (state.operating.merge_authorized_by !== state.resources.github.authenticated_login) throw new Error("The operating Workspace was merged without the installer's recorded Workspace Steward authorization.");
          if (!requiredCheckPassed(pullRequest)) throw new Error("The operating Workspace was merged without the required successful CompanyOS check evidence.");
          state.operating.required_check = "passed";
          state.operating.merge_commit = clean(pullRequest.mergeCommit?.oid);
          if (!/^[0-9a-f]{40}$/.test(state.operating.merge_commit)) throw new Error("GitHub did not return one immutable merge commit for the operating Workspace.");
          savePhase(absoluteStatePath, state, "artifact");
          continue;
        }
        if (!requiredCheckPassed(pullRequest)) return wait(absoluteStatePath, state, "The operating Workspace pull request is waiting for the required CompanyOS check.", { type: "wait-for-required-check", url: state.operating.pull_request_url, check: "check" });
        const candidateHash = sha256(JSON.stringify({ url: state.operating.pull_request_url, checks: pullRequest.statusCheckRollup }));
        state.operating.required_check = "passed";
        state.operating.merge_confirmation_hash = candidateHash;
        writeLiveSetupState(absoluteStatePath, state);
        if (mergeConfirmation !== candidateHash) return wait(absoluteStatePath, state, "The required check passed. The Workspace Steward must confirm this exact merge before the release candidate is built.", { type: "confirm-merge", confirmation_hash: candidateHash, url: state.operating.pull_request_url });
        state.operating.merge_authorized_by = state.resources.github.authenticated_login;
        state.operating.merge_authorized_at = now();
        writeLiveSetupState(absoluteStatePath, state);
        gh(executor, ["pr", "merge", state.operating.pull_request_url, "--repo", githubRepository(state), "--squash", "--delete-branch"]);
      } else if (state.phase === "artifact") {
        state.artifact = buildAndConfigureArtifact(executor, state, absoluteStatePath, coreRoot);
        savePhase(absoluteStatePath, state, "production-confirmation");
      } else if (state.phase === "production-confirmation") {
        const modelExecution = modelExecutionForState(state);
        const candidateHash = sha256(JSON.stringify({ artifact: state.artifact.hash, core: state.artifact.core_commit, workspace: state.artifact.workspace_commit, project: state.resources.vercel.project, model_route: modelExecution.route, model: modelExecution.model }));
        state.deployment.production_confirmation_hash = candidateHash;
        writeLiveSetupState(absoluteStatePath, state);
        if (productionConfirmation !== candidateHash) return wait(absoluteStatePath, state, "The exact production candidate is ready. Confirm deployment after reviewing provider costs and the immutable provenance.", { type: "confirm-production", confirmation_hash: candidateHash, candidate: { artifact_hash: state.artifact.hash, core_commit: state.artifact.core_commit, workspace_commit: state.artifact.workspace_commit, vercel_project: state.resources.vercel.project, model_route: modelExecution.route, model: modelExecution.model } });
        savePhase(absoluteStatePath, state, "production-deployment");
      } else if (state.phase === "production-deployment") {
        let url = state.deployment.url;
        if (!url) {
          const intentKey = "vercel-production-deployment";
          if (hasPendingMutation(state, intentKey)) return wait(absoluteStatePath, state, "The production deployment request was recorded without a deployment receipt. Inspect the Vercel project and resume with the existing deployment; Oregano will not create another production deployment automatically.", { type: "reconcile-provider-receipt", provider: "vercel", project: state.resources.vercel.project });
          beginMutation(absoluteStatePath, state, intentKey, { provider: "vercel", operation: "deploy-production", project: state.resources.vercel.project, artifact_hash: state.artifact.hash });
          const deployed = parseJson(vercel(executor, coreRoot, ["deploy", "--prod", "--yes", "--project", state.resources.vercel.project, "--format", "json"], { scope: state.answers.vercel_scope }).stdout, "Vercel production deployment");
          const rawUrl = clean(deployed?.url ?? deployed?.deployment?.url);
          url = rawUrl && !/^https?:\/\//.test(rawUrl) ? `https://${rawUrl}` : rawUrl;
          if (!url) throw new Error("Vercel production deployment did not return a URL.");
          state.deployment.id = clean(deployed?.id ?? deployed?.deployment?.id);
          state.deployment.url = url;
          completeMutation(absoluteStatePath, state, intentKey, { id: state.deployment.id || null, url });
        }
        const inspected = parseJson(vercel(executor, coreRoot, ["inspect", state.deployment.id || url, "--wait", "--timeout", "3m", "--format", "json"], { scope: state.answers.vercel_scope }).stdout, "Vercel deployment inspection");
        const readyState = clean(inspected?.readyState ?? inspected?.state ?? inspected?.status).toUpperCase();
        if (!new Set(["READY", "SUCCEEDED", "SUCCESS"]).has(readyState)) throw new Error(`Vercel deployment is not ready; provider state is '${readyState || "unknown"}'.`);
        state.deployment.ready_state = readyState;
        state.deployment.ready_at = now();
        writeLiveSetupState(absoluteStatePath, state);
        const health = await fetchHealth(url, fetchImpl);
        if (!expectedHealth(state, health)) throw new Error("Production health does not match the expected Artifact, Core, Workspace, ToolSet, and Agent provenance.");
        state.deployment.health = {
          artifact_hash: health.artifactHash,
          core_commit: health.coreCommit,
          workspace_commit: health.workspaceCommit,
          resolved_toolset_hash: health.resolvedToolSetHash,
          agent: health.agent,
          tools: health.tools,
          model_route: health.modelRoute,
          model: health.model,
          checked_at: now(),
        };
        savePhase(absoluteStatePath, state, "slack-verification");
      } else if (state.phase === "slack-verification") {
        const nonce = state.verification.slack_nonce ?? `oregano-${sha256(`${state.plan_hash}:${state.deployment.url}`).slice(0, 12)}`;
        state.verification.slack_nonce = nonce;
        writeLiveSetupState(absoluteStatePath, state);
        const modelExecution = modelExecutionForState(state);
        const proof = run(executor, "vercel", ["env", "run", "--environment", "production", "--project", state.resources.vercel.project, "--cwd", coreRoot, "--scope", state.answers.vercel_scope, "--", "node", join(coreRoot, "packages", "cli", "src", "live-database-proof.mjs"), nonce, modelExecution.route, modelExecution.model], { cwd: coreRoot, allowFailure: true });
        if (proof.status !== 0) return wait(absoluteStatePath, state, "Send the generated message to Oregano in Slack. The installer will then prove both the user message and Oregano response in Neon.", { type: "slack-round-trip", message: `@Oregano Setup-Test ${nonce}`, channel_id: state.answers.slack_channel_id || null });
        const databaseProof = parseJson(proof.stdout, "Slack database proof");
        if (databaseProof.ok !== true) return wait(absoluteStatePath, state, "The Slack message has not produced a complete persisted round trip yet.", { type: "slack-round-trip", message: `@Oregano Setup-Test ${nonce}`, channel_id: state.answers.slack_channel_id || null });
        state.verification.database = { ok: true, conversation_entries: databaseProof.conversation_entries, assistant_entries: databaseProof.assistant_entries, exact_response_entries: databaseProof.exact_response_entries, model_evidence_entries: databaseProof.model_evidence_entries, checked_at: now() };
        state.verification.scope = "live-starter-instance";
        state.verification.readiness = "validated";
        savePhase(absoluteStatePath, state, "complete");
      } else if (state.phase === "complete") {
        return stateResult(absoluteStatePath, state, "complete", "The live Oregano starter Instance is verified.", null);
      } else throw new Error(`Unknown live setup phase '${state.phase}'.`);
    }
    throw new Error("Live setup exceeded the allowed number of phase advances in one run.");
  } catch (error) {
    const message = safeError(error.message);
    state.updated_at = now();
    state.history.push({ phase: state.phase, status: "failed", at: state.updated_at, message });
    writeLiveSetupState(absoluteStatePath, state);
    return stateResult(absoluteStatePath, state, "blocked", message, { type: "resolve-diagnostic-and-resume", phase: state.phase }, [diagnostic("LIVE099", "error", message)]);
  }
}

export async function verifyLiveSetup({ statePath, executor = createCommandExecutor(), fetchImpl = globalThis.fetch } = {}) {
  const diagnostics = [];
  let state;
  try { state = readLiveSetupState(resolve(statePath)); }
  catch (error) {
    return { verification: { ok: false, scope: "live-starter-instance" }, diagnostics: [diagnostic("LIVE100", "error", safeError(error.message))] };
  }
  if (state.phase !== "complete") diagnostics.push(diagnostic("LIVE101", "error", `Live setup is not complete; current phase is '${state.phase}'.`));
  if (state.resources.github?.visibility !== "PRIVATE") diagnostics.push(diagnostic("LIVE102", "error", "GitHub repository is not recorded as private."));
  const recordedProtection = state.resources.github?.protection?.status;
  if (!new Set(["enforced", "advisory"]).has(recordedProtection)) diagnostics.push(diagnostic("LIVE103", "error", "GitHub hosted-protection attempt evidence is missing."));
  if (!state.resources.neon?.id && !state.resources.neon?.uid && !state.resources.neon?.name) diagnostics.push(diagnostic("LIVE104", "error", "Neon resource evidence is missing."));
  if (!state.resources.slack?.uid || !state.resources.slack?.team_id || !state.resources.slack?.user_id) diagnostics.push(diagnostic("LIVE105", "error", "Slack connector or canonical human principal evidence is missing."));
  if (state.schema_version >= 2) {
    const expectedProject = expectedVercelProjectConfiguration();
    const recordedProject = state.resources.vercel?.configuration;
    if (recordedProject?.root_directory !== expectedProject.rootDirectory || recordedProject?.framework !== expectedProject.framework || recordedProject?.source_files_outside_root_directory !== expectedProject.sourceFilesOutsideRootDirectory) diagnostics.push(diagnostic("LIVE114", "error", "Vercel runner-root configuration evidence is missing or mismatched."));
    const expectedSlackUid = VERCEL_NEON_SLACK_PROFILE.communication.expectedConnectorUid();
    if (state.resources.slack?.uid !== expectedSlackUid || state.resources.slack?.trigger_path !== VERCEL_NEON_SLACK_PROFILE.communication.triggerPath || state.resources.slack?.expected_display_name !== VERCEL_NEON_SLACK_PROFILE.communication.agentDisplayName) diagnostics.push(diagnostic("LIVE115", "error", "Slack fixed-name or trigger-route evidence is missing or mismatched."));
    const unresolvedIntents = Object.entries(state.intents ?? {}).filter(([, intent]) => intent?.status !== "completed").map(([key]) => key);
    if (unresolvedIntents.length > 0) diagnostics.push(diagnostic("LIVE116", "error", `Provider mutation receipts are incomplete: ${unresolvedIntents.join(", ")}.`));
    if (!new Set(["READY", "SUCCEEDED", "SUCCESS"]).has(state.deployment?.ready_state)) diagnostics.push(diagnostic("LIVE117", "error", "Structured ready deployment evidence is missing."));
  }
  if (state.schema_version >= 3) {
    let selection;
    try { selection = modelExecutionForState(state); }
    catch (error) { diagnostics.push(diagnostic("LIVE118", "error", safeError(error.message))); }
    if (selection && (state.resources.model?.route !== selection.route || state.resources.model?.model !== selection.model || state.resources.model?.provider !== selection.provider)) {
      diagnostics.push(diagnostic("LIVE119", "error", "Model execution provider evidence is missing or mismatched."));
    }
    if (selection?.credentialRef && (state.resources.model?.credentialRef !== selection.credentialRef || state.resources.model?.credential_status !== "present-sensitive")) {
      diagnostics.push(diagnostic("LIVE120", "error", "Direct model credential presence and Sensitive classification evidence is missing. The credential value was not inspected."));
    }
    if (Number(state.verification?.database?.model_evidence_entries ?? 0) < 1) diagnostics.push(diagnostic("LIVE121", "error", "Persisted model-backed Slack response evidence is missing."));
  }
  if (!/^[0-9a-f]{40}$/.test(state.operating?.merge_commit ?? "") || state.operating?.merge_authorized_by !== state.resources.github?.authenticated_login || !/^\d{4}-\d{2}-\d{2}T/.test(state.operating?.merge_authorized_at ?? "") || state.operating?.required_check !== "passed") diagnostics.push(diagnostic("LIVE106", "error", "Workspace Steward merge authorization, required check, or immutable merge evidence is missing."));
  if (state.verification?.database?.ok !== true) diagnostics.push(diagnostic("LIVE107", "error", "Persisted Slack round-trip evidence is missing."));
  if (state.deployment?.url) {
    try {
      const health = await fetchHealth(state.deployment.url, fetchImpl);
      if (!expectedHealth(state, health)) diagnostics.push(diagnostic("LIVE108", "error", "Current production health no longer matches the recorded release candidate."));
    } catch (error) { diagnostics.push(diagnostic("LIVE109", "error", safeError(error.message))); }
  } else diagnostics.push(diagnostic("LIVE110", "error", "Production deployment URL is missing."));
  const repository = state.resources.github?.repository;
  let currentProtection = recordedProtection;
  if (repository) {
    const hosted = gh(executor, ["repo", "view", repository, "--json", "visibility"], { allowFailure: true });
    if (hosted.status !== 0) diagnostics.push(diagnostic("LIVE111", "error", "GitHub repository can no longer be verified with the current login."));
    else if (String(parseJson(hosted.stdout, "GitHub repository").visibility).toUpperCase() !== "PRIVATE") diagnostics.push(diagnostic("LIVE112", "error", "GitHub reports that the Workspace repository is not private."));
    try {
      inspectGitHubProtection(executor, repository);
      currentProtection = "enforced";
    } catch {
      currentProtection = "advisory";
      diagnostics.push(diagnostic(
        "LIVE113",
        recordedProtection === "enforced" ? "warning" : "info",
        recordedProtection === "enforced"
          ? "GitHub no longer reports the previously verified protected-main controls. The supervised starter remains valid, but hosted enforcement is now advisory."
          : "GitHub does not enforce the protected-main baseline for this private repository. The supervised starter remains valid through its checked pull-request and explicit Steward merge evidence.",
      ));
    }
  }
  return {
    verification: {
      ok: !hasErrors(diagnostics),
      scope: "live-starter-instance",
      readiness: !hasErrors(diagnostics) ? "validated" : "not-validated",
      github_protection: currentProtection,
      statement: "Verification proves this exact supervised starter Instance: private GitHub Workspace, checked pull request, explicit Steward merge, immutable Core and Workspace provenance, selected model execution route, Vercel health, Neon persistence, and one authorized model-backed Slack round trip. Hosted GitHub protection is reported separately and is not required for this Tool-free supervised starter. This does not authorize business Tools, unattended workflows, or claim general enforced production readiness.",
    },
    state: {
      profile: state.profile,
      phase: state.phase,
      github: state.resources.github,
      vercel: state.resources.vercel,
      neon: state.resources.neon,
      slack: state.resources.slack,
      model: state.resources.model,
      artifact: state.artifact,
      deployment: state.deployment,
    },
    diagnostics,
  };
}
