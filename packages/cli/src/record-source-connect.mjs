import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { diagnostic } from "./diagnostics.mjs";
import { planRecordSourceOperation } from "./records-operations.mjs";
import {
  VERCEL_NEON_RECORD_SOURCE_PROFILE,
  VERCEL_NEON_RECORD_SOURCE_PROFILE_ID,
  validateVercelNeonRecordSourceProfileInput,
} from "./records/profiles/vercel-neon.mjs";

export const RECORD_SOURCE_CONNECT_STATE_VERSION = 1;
export const RECORD_SOURCE_CONNECT_KIND = "company-record-source-connect";

const sha256 = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const now = () => new Date().toISOString();
const hasErrors = (diagnostics) => diagnostics.some((item) => item.severity === "error");
const credentialValue = /(?:postgres(?:ql)?:\/\/[^\s]+:[^\s]+@|xox[a-z0-9](?:[.-][A-Za-z0-9-]+)+|sk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const sensitiveKey = /(?:^|_)(?:access_token|api_key|authorization|bearer|client_secret|database_url|password|private_key|refresh_token|secret|token)(?:_|$)/i;
const payloadKey = /^(?:column_values|object|objects|payload|provider_payload|record|records|values)$/i;

const assertCredentialFree = (value, path = "state") => {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (credentialValue.test(value)) throw new Error(`Refusing possible credential material in ${path}.`);
    return;
  }
  if (Array.isArray(value)) return value.forEach((entry, index) => assertCredentialFree(entry, `${path}[${index}]`));
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (!/(?:^|_)secret_ref$/i.test(key) && sensitiveKey.test(key)) throw new Error(`Refusing sensitive state field '${path}.${key}'.`);
      assertCredentialFree(entry, `${path}.${key}`);
    }
  }
};

const assertPayloadFreeEvidence = (value, path = "response") => {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) return value.forEach((entry, index) => assertPayloadFreeEvidence(entry, `${path}[${index}]`));
  for (const [key, entry] of Object.entries(value)) {
    if (payloadKey.test(key) && !(key === "objects" && typeof entry === "number")) throw new Error(`Rehearsal response '${path}.${key}' contains record payload instead of payload-free evidence.`);
    assertPayloadFreeEvidence(entry, `${path}.${key}`);
  }
};

const git = (root, ...args) => {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`Cannot inspect Git identity for '${root}'.`);
  return String(result.stdout).trim();
};

export function inspectRecordSourceWorkspaceIdentity(workspaceRoot) {
  const root = resolve(workspaceRoot);
  const ref = git(root, "rev-parse", "HEAD");
  if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error("Company Workspace must resolve to one exact Git commit.");
  if (git(root, "status", "--porcelain")) throw new Error("Company Record Source rehearsal requires a clean reviewed Company Workspace checkout.");
  let repository = git(root, "config", "--get", "remote.origin.url");
  repository = repository.replace(/\.git$/, "").replace(/^git@github\.com:/, "").replace(/^https:\/\/github\.com\//, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Company Workspace origin must identify one owner/repository pair.");
  return { repository, ref, clean: true };
}

const normalizeCoreIdentity = (identity) => ({
  repository: String(identity?.repository ?? ""),
  ref: String(identity?.ref ?? ""),
  core_version: String(identity?.core_version ?? identity?.version ?? ""),
  workbench_version: String(identity?.workbench_version ?? ""),
  clean: identity?.clean === true,
});

const validCoreIdentity = (identity) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(identity.repository)
  && /^[0-9a-f]{40}$/.test(identity.ref)
  && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(identity.core_version)
  && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(identity.workbench_version)
  && identity.clean;

const selectedProjections = (planResult) => planResult?.source
  ? planResult.projections.filter((projection) => projection.selection?.source_id === planResult.source.id)
  : [];
const inside = (root, path) => {
  const fromRoot = relative(resolve(root), resolve(path));
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
};

export function planRecordSourceConnect({
  workspaceRoot,
  sourceId,
  bindingPath,
  profile = VERCEL_NEON_RECORD_SOURCE_PROFILE_ID,
  endpoint,
  runtimeScope,
  runtimeProject,
  statePath,
  coreIdentity,
  workspaceIdentity,
  operationPlanner = planRecordSourceOperation,
} = {}) {
  const diagnostics = [];
  if (profile !== VERCEL_NEON_RECORD_SOURCE_PROFILE_ID) diagnostics.push(diagnostic("REC030", "error", `Unsupported Record Source Instance profile '${profile}'.`));
  let runtime;
  try { runtime = validateVercelNeonRecordSourceProfileInput({ endpoint, runtimeScope, runtimeProject }); }
  catch (error) { diagnostics.push(diagnostic("REC031", "error", error.message, { field: "profile" })); }
  const core = normalizeCoreIdentity(coreIdentity);
  if (!validCoreIdentity(core)) diagnostics.push(diagnostic("REC032", "error", "Record Source connect requires one clean exact Oregano Core identity."));
  let workspaceGit;
  try { workspaceGit = workspaceIdentity ?? inspectRecordSourceWorkspaceIdentity(workspaceRoot); }
  catch (error) { diagnostics.push(diagnostic("REC033", "error", error.message, { file: resolve(workspaceRoot ?? ".") })); }
  let operation;
  try {
    operation = operationPlanner({ workspaceRoot, sourceId, bindingPath, operation: "sync", coreIdentity: core });
    diagnostics.push(...operation.diagnostics);
  } catch (error) {
    diagnostics.push(diagnostic("REC034", "error", error.message));
  }
  const projections = operation ? selectedProjections(operation) : [];
  if (operation && projections.length === 0) diagnostics.push(diagnostic("REC035", "error", `Source '${sourceId}' requires at least one projection with selection.source_id '${sourceId}' before rehearsal.`));
  const effectiveStatePath = resolve(statePath ?? `.companyos-cache/records-${sourceId}-${profile}.json`);
  if (workspaceRoot && inside(workspaceRoot, effectiveStatePath)) diagnostics.push(diagnostic("REC038", "error", "Record Source connect state must stay outside the Company Workspace.", { file: effectiveStatePath }));
  const completeOperation = Boolean(operation?.source && operation?.binding && operation?.qualification);
  const sourceSelection = completeOperation ? {
    workspace: workspaceGit,
    source: operation.source,
    projections,
    binding: operation.binding,
    qualification: operation.qualification,
  } : null;
  const sourceConfirmation = sourceSelection ? sha256(sourceSelection) : null;
  const configuration = completeOperation && workspaceGit ? {
    version: 1,
    environment: "preview",
    instance_id: operation.binding.instance_id,
    core,
    workspace: { repository: workspaceGit.repository, ref: workspaceGit.ref },
    source_confirmations: { [sourceId]: sourceConfirmation },
    sources: [operation.source],
    projections,
    bindings: [{ source_id: sourceId, binding: operation.binding, qualification: operation.qualification }],
  } : null;
  const plan = {
    schema_version: 1,
    kind: RECORD_SOURCE_CONNECT_KIND,
    profile,
    state_path: effectiveStatePath,
    core,
    workspace: { root: resolve(workspaceRoot ?? "."), ...(workspaceGit ?? {}) },
    source_id: sourceId,
    binding_path: resolve(bindingPath ?? "."),
    source_confirmation: sourceConfirmation,
    configuration_digest: configuration ? sha256(configuration) : null,
    runtime: runtime ?? null,
    expected_preview_environment: configuration ? VERCEL_NEON_RECORD_SOURCE_PROFILE.required_preview_environment(configuration) : [],
    external_changes: [
      "Planning and state initialization make no external call.",
      "Preview planning calls read only the protected rehearsal endpoint and create no provider or database effect.",
      "After independent exact confirmations, apply creates the additive companyos_records schema in the isolated Preview database and performs one read-only complete provider inventory followed by idempotent database writes.",
      "The command does not create or delete runtime, database, provider, Git, Workspace, schedule, webhook, or production resources.",
    ],
    required_human_actions: [
      "Prepare one protected Preview deployment of the exact Core commit and one isolated Neon/Postgres branch.",
      "Set DATABASE_URL, the binding's provider SecretRef, the generated credential-free configuration, and one short-lived rehearsal bearer as Preview-only Sensitive variables.",
      "Inject the matching rehearsal bearer into the one local resume process; never place it in chat, Git, the state file, or a command argument.",
      "Review and confirm the independent migration and synchronization hashes before apply.",
      "Remove only the Workbench-owned Preview configuration and rehearsal bearer after evidence capture; production remains a separate plan.",
    ],
  };
  plan.confirmation_hash = sha256(plan);
  return { plan, configuration, diagnostics, operation };
}

export function writeRecordSourceConnectState(path, state) {
  assertCredentialFree(state);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function readRecordSourceConnectState(path) {
  const absolute = resolve(path);
  const state = JSON.parse(readFileSync(absolute, "utf8"));
  if (state?.schema_version !== RECORD_SOURCE_CONNECT_STATE_VERSION || state?.kind !== RECORD_SOURCE_CONNECT_KIND) throw new Error(`${absolute}: unsupported Record Source connect state.`);
  assertCredentialFree(state);
  if ((statSync(absolute).mode & 0o077) !== 0) throw new Error(`${absolute}: Record Source connect state must use mode 0600.`);
  return state;
}

export function initializeRecordSourceConnect({ planResult, confirmationHash }) {
  if (!planResult?.plan || hasErrors(planResult.diagnostics)) return { state: null, diagnostics: planResult?.diagnostics ?? [] };
  if (confirmationHash !== planResult.plan.confirmation_hash) return { state: null, diagnostics: [...planResult.diagnostics, diagnostic("REC036", "error", "Record Source connect confirmation does not match the current plan.")] };
  if (existsSync(planResult.plan.state_path)) return { state: null, diagnostics: [...planResult.diagnostics, diagnostic("REC037", "error", "Record Source connect state already exists; use --resume.", { file: planResult.plan.state_path })] };
  const state = {
    schema_version: RECORD_SOURCE_CONNECT_STATE_VERSION,
    kind: RECORD_SOURCE_CONNECT_KIND,
    profile: planResult.plan.profile,
    plan_hash: confirmationHash,
    phase: "configured",
    created_at: now(),
    updated_at: now(),
    core: planResult.plan.core,
    workspace: planResult.plan.workspace,
    source_id: planResult.plan.source_id,
    binding_path: planResult.plan.binding_path,
    runtime: planResult.plan.runtime,
    configuration: planResult.configuration,
    configuration_digest: planResult.plan.configuration_digest,
    expected_preview_environment: planResult.plan.expected_preview_environment,
    evidence: {},
    history: [{ phase: "plan", status: "confirmed", at: now(), confirmation_hash: confirmationHash }],
  };
  writeRecordSourceConnectState(planResult.plan.state_path, state);
  return { state, statePath: planResult.plan.state_path, diagnostics: planResult.diagnostics };
}

export const recordSourceConnectRuntimeConfigurationValue = (state) => gzipSync(Buffer.from(JSON.stringify(state.configuration))).toString("base64");

const assertPlanResponse = (response, kind, state) => {
  assertCredentialFree(response);
  assertPayloadFreeEvidence(response);
  const plan = response?.plan;
  if (!plan || !/^[0-9a-f]{64}$/.test(String(plan.confirmation_hash ?? ""))) throw new Error(`Preview did not return a valid ${kind} plan.`);
  const expectedWorkspace = `${state.workspace.repository}@${state.workspace.ref}`;
  if (plan.environment !== "preview" || plan.instance_id !== state.configuration.instance_id || plan.core?.ref !== state.core.ref) {
    throw new Error(`Preview ${kind} plan does not match the frozen environment, Instance, or Core identity.`);
  }
  if (kind === "migration") {
    if (plan.configuration_digest !== state.configuration_digest || plan.workspace !== expectedWorkspace) throw new Error("Preview migration plan does not match the frozen configuration or Workspace identity.");
  } else {
    const source = state.configuration.sources[0];
    const binding = state.configuration.bindings[0].binding;
    const expectedProjectionDigests = state.configuration.projections.map((projection) => ({ id: projection.id, digest: sha256(projection) }));
    if (plan.source_id !== state.source_id || plan.source_digest !== sha256(source) || plan.binding_digest !== sha256(binding)
      || JSON.stringify(plan.projection_digests) !== JSON.stringify(expectedProjectionDigests)
      || plan.rehearsal?.configuration_digest !== state.configuration_digest
      || plan.rehearsal?.workspace_ref !== state.workspace.ref
      || plan.rehearsal?.source_confirmation_hash !== state.configuration.source_confirmations[state.source_id]) {
      throw new Error("Preview synchronization plan does not match the frozen source, projections, binding, configuration, or Workspace identity.");
    }
  }
  return plan;
};

const verifyStatus = (response, state) => {
  assertCredentialFree(response);
  assertPayloadFreeEvidence(response);
  const status = response?.status;
  if (!status?.available || !status.watermark || !status.last_sync?.completed_at || Number(status.last_sync.errors) !== 0) {
    throw new Error("Preview status does not prove a complete successful source synchronization with a watermark and zero errors.");
  }
  const projections = Array.isArray(response.projections) ? response.projections : [];
  for (const projectionId of state.configuration.projections.map((projection) => projection.id)) {
    const projection = projections.find((candidate) => candidate.projection_id === projectionId);
    if (!projection?.available || !Number.isInteger(Number(projection.rows)) || Number(projection.rows) < 0) throw new Error(`Preview status does not prove projection '${projectionId}' is available.`);
  }
  const binding = state.configuration.bindings[0].binding;
  if (response.binding?.instance_id !== binding.instance_id
    || response.binding?.connector !== `${binding.connector}@${binding.connector_version}`
    || response.binding?.resource_binding !== binding.resource_binding) throw new Error("Preview status binding does not match the frozen Instance binding.");
  return { status, projections };
};

const persist = (statePath, state, history) => {
  const next = { ...state, updated_at: now(), ...(history ? { history: [...state.history, history] } : {}) };
  writeRecordSourceConnectState(statePath, next);
  return next;
};

export async function advanceRecordSourceConnect({
  statePath,
  migrationConfirmation,
  syncConfirmation,
  profile = VERCEL_NEON_RECORD_SOURCE_PROFILE,
} = {}) {
  const absolute = resolve(statePath);
  let state = readRecordSourceConnectState(absolute);
  if (profile.id !== state.profile) throw new Error(`Record Source connect state requires profile '${state.profile}'.`);
  const request = (body) => profile.request({ endpoint: state.runtime.endpoint, runtimeScope: state.runtime.runtimeScope, runtimeProject: state.runtime.runtimeProject, body });

  if (state.phase === "configured") {
    const migration = assertPlanResponse(await request({ action: "plan-migration" }), "migration", state);
    const synchronization = assertPlanResponse(await request({ action: "plan-sync", source_id: state.source_id }), "sync", state);
    state = persist(absolute, { ...state, phase: "effects-planned", evidence: { ...state.evidence, plans: { migration, synchronization } } }, { phase: "effects-planned", status: "ready", at: now() });
    return {
      status: "waiting-for-confirmation",
      state,
      message: "Review and independently confirm the frozen Preview migration and synchronization plans.",
      next_action: { migration_confirmation: migration.confirmation_hash, sync_confirmation: synchronization.confirmation_hash },
    };
  }

  if (state.phase === "effects-planned") {
    const expectedMigration = state.evidence.plans.migration.confirmation_hash;
    const expectedSync = state.evidence.plans.synchronization.confirmation_hash;
    if (!migrationConfirmation || !syncConfirmation) return { status: "waiting-for-confirmation", state, message: "Both independent confirmation hashes are required; no effect was applied.", next_action: { migration_confirmation: expectedMigration, sync_confirmation: expectedSync } };
    if (migrationConfirmation !== expectedMigration || syncConfirmation !== expectedSync) throw new Error("Record Source rehearsal confirmation does not match the frozen Preview plans; no effect was applied.");
    const applied = await request({ action: "apply-migration", confirmation_hash: migrationConfirmation });
    assertCredentialFree(applied);
    assertPayloadFreeEvidence(applied);
    if (!applied.applied || applied.operation !== "migrate") throw new Error("Preview did not prove the additive migration was applied.");
    state = persist(absolute, { ...state, phase: "migration-applied", evidence: { ...state.evidence, confirmations: { migration: migrationConfirmation, synchronization: syncConfirmation }, migration: applied } }, { phase: "migration-applied", status: "complete", at: now(), confirmation_hash: migrationConfirmation });
  }

  if (state.phase === "migration-applied") {
    const expectedSync = state.evidence.plans.synchronization.confirmation_hash;
    const confirmedSync = syncConfirmation ?? state.evidence.confirmations?.synchronization;
    if (confirmedSync !== expectedSync) throw new Error("The frozen synchronization confirmation is required to resume after migration.");
    const applied = await request({ action: "apply-sync", source_id: state.source_id, confirmation_hash: confirmedSync });
    assertCredentialFree(applied);
    assertPayloadFreeEvidence(applied);
    if (!applied.applied || applied.operation !== "sync" || applied.source_id !== state.source_id) throw new Error("Preview did not prove the selected synchronization was applied.");
    state = persist(absolute, { ...state, phase: "sync-applied", evidence: { ...state.evidence, synchronization: applied } }, { phase: "sync-applied", status: "complete", at: now(), confirmation_hash: confirmedSync });
  }

  if (state.phase === "sync-applied") {
    const response = await request({ action: "status", source_id: state.source_id });
    const verified = verifyStatus(response, state);
    state = persist(absolute, { ...state, phase: "complete", evidence: { ...state.evidence, verification: verified } }, { phase: "complete", status: "verified", at: now() });
    return {
      status: "complete",
      state,
      message: "The isolated Preview migration, read-only provider inventory, database synchronization, watermark, receipt, and declared projections are verified.",
      cleanup: {
        remove_preview_environment: ["COMPANYOS_RECORDS_REHEARSAL_CONFIG_GZIP_BASE64", "COMPANYOS_RECORDS_REHEARSAL_SECRET"],
        retain: ["DATABASE_URL", ...state.configuration.bindings.map((entry) => entry.binding.secret_ref)],
        production_activated: false,
      },
    };
  }

  return { status: "complete", state, message: "Record Source Preview rehearsal is already complete; production remains a separate reviewed Instance change." };
}
