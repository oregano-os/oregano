import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { MondayClient } from "../../connectors/monday/client.ts";
import {
  assertMondayExternalAgentQualificationEvidence,
  createMondayExternalAgentQualificationEvidence,
  MONDAY_EXTERNAL_AGENT_API_VERSION,
  MONDAY_EXTERNAL_AGENT_KINDS,
} from "../../connectors/monday/external-agent-qualification.ts";
import { diagnostic } from "./diagnostics.mjs";
import {
  VERCEL_NEON_RECORD_SOURCE_PROFILE,
  VERCEL_NEON_RECORD_SOURCE_PROFILE_ID,
  validateVercelNeonRecordSourceProfileInput,
} from "./records/profiles/vercel-neon.mjs";

export const MONDAY_AGENT_QUALIFICATION_STATE_VERSION = 1;
export const MONDAY_AGENT_API_VERSION = MONDAY_EXTERNAL_AGENT_API_VERSION;
export const MONDAY_AGENT_TOKEN_SECRET_REF = "MONDAY_API_TOKEN";
export const MONDAY_AGENT_KINDS = MONDAY_EXTERNAL_AGENT_KINDS;

const clean = (value) => String(value ?? "").normalize("NFC").trim();
const now = () => new Date().toISOString();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hasErrors = (diagnostics) => diagnostics.some((item) => item.severity === "error");
const CREDENTIAL_VALUE = /(?:eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.|(?:api|access|refresh|client)[-_]?(?:key|token|secret)[=:][^\s]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const SENSITIVE_KEY = /(?:^|_)(?:token|password|secret|authorization|private_key)(?:_|$)/i;

const stateOutsideWorkspace = (workspace, statePath) => {
  const pathFromWorkspace = relative(workspace, statePath);
  return pathFromWorkspace === ".." || pathFromWorkspace.startsWith(`..${sep}`) || isAbsolute(pathFromWorkspace);
};

const validateSafeState = (value, path = "state") => {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (CREDENTIAL_VALUE.test(value)) throw new Error(`Refusing possible credential material in ${path}.`);
    return;
  }
  if (Array.isArray(value)) return value.forEach((entry, index) => validateSafeState(entry, `${path}[${index}]`));
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key) && !(key.endsWith("_ref") && typeof entry === "string" && /^env:[A-Z][A-Z0-9_]{0,127}$/.test(entry))) {
        throw new Error(`Refusing sensitive qualification state field '${path}.${key}'.`);
      }
      validateSafeState(entry, `${path}.${key}`);
    }
  }
};

export function writeMondayAgentQualificationState(path, state) {
  validateSafeState(state);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function readMondayAgentQualificationState(path) {
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (state?.schema_version !== MONDAY_AGENT_QUALIFICATION_STATE_VERSION || state?.kind !== "monday-external-agent-qualification") {
    throw new Error(`${path}: unsupported Monday external-Agent qualification state.`);
  }
  validateSafeState(state);
  return state;
}

export function parseMondayBoardAccess(value) {
  const match = /^(\d{1,20}):(read|read-write)$/.exec(clean(value));
  if (!match) throw new Error(`Monday board access '${value}' must use <numeric-board-id>:read or <numeric-board-id>:read-write.`);
  return { id: match[1], permission: match[2] };
}

const normalizeBoardAccesses = (values, diagnostics) => {
  const byId = new Map();
  for (const value of values ?? []) {
    let access;
    try { access = typeof value === "string" ? parseMondayBoardAccess(value) : parseMondayBoardAccess(`${clean(value?.id)}:${clean(value?.permission)}`); }
    catch (error) {
      diagnostics.push(diagnostic("MON005", "error", error instanceof Error ? error.message : "Invalid Monday board access.", { field: "board_access" }));
      continue;
    }
    if (byId.has(access.id) && byId.get(access.id).permission !== access.permission) {
      diagnostics.push(diagnostic("MON006", "error", `Monday board '${access.id}' has conflicting access expectations.`, { field: "board_access" }));
      continue;
    }
    byId.set(access.id, access);
  }
  const normalized = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  if (normalized.length === 0 || normalized.length > 20) {
    diagnostics.push(diagnostic("MON007", "error", "Monday qualification requires between one and twenty exact board-access expectations.", { field: "board_access" }));
  }
  return normalized;
};

export function planMondayAgentQualification({
  workspaceRoot,
  agentId,
  boardAccesses,
  statePath,
  coreIdentity,
  runtimeProfile,
  endpoint,
  runtimeScope,
  runtimeProject,
}) {
  const diagnostics = [];
  const workspace = resolve(workspaceRoot ?? "");
  if (!existsSync(resolve(workspace, "company.md"))) diagnostics.push(diagnostic("MON001", "error", "Monday qualification requires a Company Workspace with company.md.", { file: workspace }));
  const normalizedAgentId = clean(agentId);
  if (!/^\d{1,20}$/.test(normalizedAgentId)) diagnostics.push(diagnostic("MON002", "error", "Monday external Agent ID must be an exact numeric ID.", { field: "agent_id" }));
  const boards = normalizeBoardAccesses(boardAccesses, diagnostics);
  const defaultState = resolve(dirname(workspace), ".companyos-bootstrap", `${basename(workspace)}-monday-agent-qualification.json`);
  const normalizedStatePath = resolve(statePath ?? defaultState);
  if (!stateOutsideWorkspace(workspace, normalizedStatePath)) diagnostics.push(diagnostic("MON003", "error", "Monday qualification state must stay outside Company Workspace material.", { file: normalizedStatePath }));
  if (!isAbsolute(normalizedStatePath)) diagnostics.push(diagnostic("MON004", "error", "Monday qualification state path must resolve to an absolute path.", { file: normalizedStatePath }));
  const core = {
    repository: clean(coreIdentity?.repository),
    ref: clean(coreIdentity?.ref),
    version: clean(coreIdentity?.core_version),
    workbench_version: clean(coreIdentity?.workbench_version),
  };
  if (!/^[0-9a-f]{40}$/.test(core.ref) || !core.repository || !core.version || !core.workbench_version) {
    diagnostics.push(diagnostic("MON008", "error", "Monday qualification requires one clean exact Oregano Core identity.", { field: "core" }));
  }
  const runtimeRequested = [runtimeProfile, endpoint, runtimeScope, runtimeProject].some((value) => clean(value) !== "");
  let runtime;
  if (runtimeRequested) {
    if (runtimeProfile !== VERCEL_NEON_RECORD_SOURCE_PROFILE_ID) {
      diagnostics.push(diagnostic("MON011", "error", `Unsupported Monday qualification runtime profile '${clean(runtimeProfile)}'.`, { field: "runtime_profile" }));
    } else {
      try { runtime = validateVercelNeonRecordSourceProfileInput({ endpoint, runtimeScope, runtimeProject }); }
      catch (error) { diagnostics.push(diagnostic("MON012", "error", error instanceof Error ? error.message : "Invalid Monday qualification runtime.", { field: "runtime" })); }
    }
  }

  const plan = {
    schema_version: MONDAY_AGENT_QUALIFICATION_STATE_VERSION,
    kind: "monday-external-agent-qualification",
    workspace,
    core,
    authentication_mode: "external-agent",
    agent_id: normalizedAgentId,
    api_version: MONDAY_AGENT_API_VERSION,
    boards,
    state_path: normalizedStatePath,
    secret_ref: `env:${MONDAY_AGENT_TOKEN_SECRET_REF}`,
    provider_reads: [
      "Read the authenticated Monday identity and require an external-Agent member kind.",
      "Read exact selected board metadata and effective access levels with the external-Agent token.",
    ],
    external_changes: [
      "No Monday Agent, grant, board, item, group, column, update, webhook, or provider permission is created or modified.",
      "No Company Workspace, database, deployment, schedule, Git branch, or production state is modified by qualification.",
    ],
    credential_handling: {
      agent_api_token: "instance-secret-read-only",
      persisted_by_workbench: false,
      persisted_in_receipt: false,
    },
    required_human_actions: [
      `Make the existing external Agent token available only through ${MONDAY_AGENT_TOKEN_SECRET_REF} in the selected Instance runtime.`,
      "Review the exact Agent ID and every board permission before confirming this plan.",
      "Attest that the confirmed boards are the complete administrative grant set because an external-Agent token cannot list agent_knowledge.",
      "Keep the organizational roles board read-only and grant read-write only to an explicitly reviewed operational board.",
    ],
    ...(runtime ? { runtime: { profile: runtimeProfile, ...runtime } } : {}),
  };
  plan.confirmation_hash = sha256(JSON.stringify(plan));
  return { plan, diagnostics };
}

export function initializeMondayAgentQualification({ planResult, confirmationHash }) {
  if (!planResult?.plan || hasErrors(planResult.diagnostics)) return { state: null, diagnostics: planResult?.diagnostics ?? [] };
  if (confirmationHash !== planResult.plan.confirmation_hash) {
    return { state: null, diagnostics: [...planResult.diagnostics, diagnostic("MON009", "error", "Monday qualification confirmation does not match the current plan.")] };
  }
  if (existsSync(planResult.plan.state_path)) {
    return { state: null, diagnostics: [...planResult.diagnostics, diagnostic("MON010", "error", "Monday qualification state already exists. Use --resume or select a new state path.", { file: planResult.plan.state_path })] };
  }
  const state = {
    schema_version: MONDAY_AGENT_QUALIFICATION_STATE_VERSION,
    kind: "monday-external-agent-qualification",
    plan_hash: planResult.plan.confirmation_hash,
    created_at: now(),
    updated_at: now(),
    phase: "agent-ready",
    workspace: planResult.plan.workspace,
    core: planResult.plan.core,
    authentication_mode: planResult.plan.authentication_mode,
    agent_id: planResult.plan.agent_id,
    api_version: planResult.plan.api_version,
    boards: planResult.plan.boards,
    secret_ref: planResult.plan.secret_ref,
    ...(planResult.plan.runtime ? { runtime: planResult.plan.runtime } : {}),
    evidence: {},
    history: [{ phase: "plan", status: "confirmed", at: now() }],
  };
  writeMondayAgentQualificationState(planResult.plan.state_path, state);
  return { state, statePath: planResult.plan.state_path, diagnostics: planResult.diagnostics };
}

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const assertRemoteProviderReadPlan = (response, state) => {
  const plan = response?.plan;
  if (!plan || plan.kind !== "company-records-preview-monday-agent-qualification" || !/^[0-9a-f]{64}$/.test(String(plan.confirmation_hash ?? ""))) {
    throw new Error("Protected Preview did not return a valid Monday provider-read plan.");
  }
  const { confirmation_hash: confirmationHash, ...planBody } = plan;
  if (confirmationHash !== sha256(JSON.stringify(planBody))) throw new Error("Protected Preview Monday provider-read plan has an invalid digest.");
  if (plan.environment !== "preview" || plan.core?.ref !== state.core.ref || plan.qualification_plan_hash !== state.plan_hash
    || plan.agent_id !== state.agent_id || plan.provider_secret_ref !== state.secret_ref || !same(plan.boards, state.boards)) {
    throw new Error("Protected Preview Monday provider-read plan does not match the frozen Core, Agent, board access, or qualification plan.");
  }
  return plan;
};

const qualificationEvidenceFromResult = (state, result) => createMondayExternalAgentQualificationEvidence({
  agentId: state.agent_id,
  apiVersion: state.api_version,
  boards: state.boards,
  planHash: state.plan_hash,
  result,
  observedAt: now(),
});

const persistIdentityReview = (absoluteStatePath, state, evidence) => {
  assertMondayExternalAgentQualificationEvidence({
    agentId: state.agent_id,
    apiVersion: state.api_version,
    boards: state.boards,
    planHash: state.plan_hash,
    evidence,
  });
  const pending = {
    ...state,
    phase: "identity-review",
    updated_at: now(),
    evidence: {
      ...state.evidence,
      discovery_pending: evidence.discovery,
      identity_review: evidence.identity_review,
    },
    history: [...state.history, { phase: "external-agent-discovery", status: "review-required", at: now(), receipt: evidence.discovery.discovery_hash }],
  };
  writeMondayAgentQualificationState(absoluteStatePath, pending);
  return {
    status: "waiting",
    statePath: absoluteStatePath,
    state: pending,
    message: "Monday provider identity and selected-board metadata are discovered; the administrator must confirm the exact configured-to-authenticated Agent identity mapping.",
    next_action: { type: "confirm-agent-identity-mapping", confirmation_hash: evidence.identity_review.confirmation_hash, review: evidence.identity_review.summary },
    diagnostics: [],
  };
};

export async function advanceMondayAgentQualification({
  statePath,
  agentToken = process.env[MONDAY_AGENT_TOKEN_SECRET_REF],
  providerReadConfirmationHash,
  identityConfirmationHash,
  fetchImpl = globalThis.fetch,
  remoteProfile = VERCEL_NEON_RECORD_SOURCE_PROFILE,
} = {}) {
  const absoluteStatePath = resolve(statePath);
  let state = readMondayAgentQualificationState(absoluteStatePath);
  if (state.phase === "complete") {
    return { status: "complete", statePath: absoluteStatePath, state, message: "Monday external-Agent qualification is already complete.", diagnostics: [] };
  }
  if (state.phase === "identity-review") {
    const review = state.evidence?.identity_review;
    const pending = state.evidence?.discovery_pending;
    if (!review || !pending) throw new Error("Monday identity-review state is incomplete.");
    if (!identityConfirmationHash) {
      return {
        status: "waiting",
        statePath: absoluteStatePath,
        state,
        message: "Monday provider identity and selected-board metadata are discovered; the administrator must confirm the exact configured-to-authenticated Agent identity mapping.",
        next_action: { type: "confirm-agent-identity-mapping", confirmation_hash: review.confirmation_hash, review: review.summary },
        diagnostics: [],
      };
    }
    if (identityConfirmationHash !== review.confirmation_hash) throw new Error("Monday Agent identity mapping confirmation does not match the pending review.");
    const discovery = {
      ...pending,
      identity_mapping_status: "administrator-confirmed",
      identity_mapping_confirmation_hash: review.confirmation_hash,
    };
    discovery.discovery_hash = sha256(JSON.stringify({ ...discovery, discovery_hash: undefined }));
    const completed = {
      ...state,
      phase: "complete",
      updated_at: now(),
      evidence: { discovery, identity_review: review },
      history: [...state.history, { phase: "identity-mapping-review", status: "confirmed", at: now(), receipt: review.confirmation_hash }],
    };
    writeMondayAgentQualificationState(absoluteStatePath, completed);
    return {
      status: "complete",
      statePath: absoluteStatePath,
      state: completed,
      message: "Monday external-Agent identity mapping, administrator-attested resource set, effective selected-board access, and board metadata are qualified; no credential was retained and no provider write occurred.",
      diagnostics: [],
    };
  }
  if (state.phase === "provider-read-review") {
    const plan = state.evidence?.provider_read_plan;
    if (!plan) throw new Error("Monday provider-read review state is incomplete.");
    if (!providerReadConfirmationHash) {
      return {
        status: "waiting",
        statePath: absoluteStatePath,
        state,
        message: "The protected Preview metadata read requires its exact independent confirmation.",
        next_action: { type: "confirm-provider-metadata-read", confirmation_hash: plan.confirmation_hash, plan },
        diagnostics: [],
      };
    }
    if (providerReadConfirmationHash !== plan.confirmation_hash) throw new Error("Monday provider-read confirmation does not match the pending protected Preview plan.");
    if (!state.runtime || remoteProfile.id !== state.runtime.profile) throw new Error("Monday qualification runtime profile is unavailable.");
    const response = await remoteProfile.request({
      endpoint: state.runtime.endpoint,
      runtimeScope: state.runtime.runtimeScope,
      runtimeProject: state.runtime.runtimeProject,
      body: {
        action: "apply-monday-qualification",
        agent_id: state.agent_id,
        boards: state.boards,
        qualification_plan_hash: state.plan_hash,
        confirmation_hash: providerReadConfirmationHash,
      },
    });
    if (!response?.applied || response.operation !== "monday-agent-qualification-read") throw new Error("Protected Preview did not prove the Monday metadata read.");
    return persistIdentityReview(absoluteStatePath, state, response.evidence);
  }
  if (state.phase !== "agent-ready") throw new Error(`Unknown Monday qualification phase '${state.phase}'.`);
  if (state.runtime) {
    if (remoteProfile.id !== state.runtime.profile) throw new Error(`Monday qualification requires runtime profile '${state.runtime.profile}'.`);
    const response = await remoteProfile.request({
      endpoint: state.runtime.endpoint,
      runtimeScope: state.runtime.runtimeScope,
      runtimeProject: state.runtime.runtimeProject,
      body: {
        action: "plan-monday-qualification",
        agent_id: state.agent_id,
        boards: state.boards,
        qualification_plan_hash: state.plan_hash,
      },
    });
    const plan = assertRemoteProviderReadPlan(response, state);
    state = {
      ...state,
      phase: "provider-read-review",
      updated_at: now(),
      evidence: { ...state.evidence, provider_read_plan: plan },
      history: [...state.history, { phase: "provider-read-review", status: "confirmation-required", at: now(), receipt: plan.confirmation_hash }],
    };
    writeMondayAgentQualificationState(absoluteStatePath, state);
    return {
      status: "waiting",
      statePath: absoluteStatePath,
      state,
      message: "The protected Preview has planned the exact metadata-only Monday read; no provider call has occurred.",
      next_action: { type: "confirm-provider-metadata-read", confirmation_hash: plan.confirmation_hash, plan },
      diagnostics: [],
    };
  }
  if (!agentToken) {
    return {
      status: "waiting",
      statePath: absoluteStatePath,
      state,
      message: `The external Monday Agent token is not available through ${state.secret_ref}.`,
      next_action: {
        type: "runtime-secret-entry",
        runtime_host: "instance-selected",
        secret_ref: state.secret_ref,
        instructions: "Inject the existing external Agent API token into the selected runtime process. Never put it in chat, Git, a Workspace file, a command argument, or this state file.",
      },
      diagnostics: [],
    };
  }

  const client = new MondayClient({ token: agentToken, apiVersion: state.api_version, fetcher: fetchImpl });
  const result = await client.discoverAgentResources({ agentId: state.agent_id, boardIds: state.boards.map((board) => board.id) });
  return persistIdentityReview(absoluteStatePath, state, qualificationEvidenceFromResult(state, result));
}
