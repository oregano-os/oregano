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
import { diagnostic } from "./diagnostics.mjs";

export const MONDAY_AGENT_QUALIFICATION_STATE_VERSION = 1;
export const MONDAY_AGENT_API_VERSION = "dev";
export const MONDAY_AGENT_TOKEN_SECRET_REF = "MONDAY_API_TOKEN";
export const MONDAY_AGENT_KINDS = Object.freeze([
  "external_agent_detached_member",
  "external_agent_member",
]);

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

export function planMondayAgentQualification({ workspaceRoot, agentId, boardAccesses, statePath, coreIdentity }) {
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
      "Read the exact Agent knowledge grants and exact selected board metadata.",
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
      "Keep the organizational roles board read-only and grant read-write only to an explicitly reviewed operational board.",
    ],
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
    evidence: {},
    history: [{ phase: "plan", status: "confirmed", at: now() }],
  };
  writeMondayAgentQualificationState(planResult.plan.state_path, state);
  return { state, statePath: planResult.plan.state_path, diagnostics: planResult.diagnostics };
}

const normalizeProviderPermission = (value) => {
  if (value === "READ") return "read";
  if (value === "READ_WRITE") return "read-write";
  return clean(value).toLowerCase().replaceAll("_", "-");
};

const validateDiscovery = (state, result) => {
  const identity = result.data.identity;
  if (!MONDAY_AGENT_KINDS.includes(identity.kind)) {
    throw new Error(`Monday token identifies '${identity.kind || "unknown"}' instead of an external Agent.`);
  }
  if (identity.externalAgentId !== state.agent_id) {
    throw new Error(`Monday token identifies external Agent '${identity.externalAgentId || "unknown"}' instead of '${state.agent_id}'.`);
  }
  const actualResources = result.data.resources
    .map((resource) => ({
      id: String(resource.resourceId),
      scope: clean(resource.scopeType).toLowerCase(),
      permission: normalizeProviderPermission(resource.permissionType),
    }))
    .sort((left, right) => `${left.scope}:${left.id}`.localeCompare(`${right.scope}:${right.id}`));
  const expectedResources = state.boards
    .map((board) => ({ id: board.id, scope: "board", permission: board.permission }))
    .sort((left, right) => `${left.scope}:${left.id}`.localeCompare(`${right.scope}:${right.id}`));
  if (JSON.stringify(actualResources) !== JSON.stringify(expectedResources)) {
    throw new Error("Monday Agent resource grants do not exactly match the confirmed board-access plan.");
  }
  const returnedBoards = result.data.boards.map((board) => String(board.id)).sort();
  const expectedBoards = state.boards.map((board) => board.id).sort();
  if (JSON.stringify(returnedBoards) !== JSON.stringify(expectedBoards)) {
    throw new Error("Monday did not return exactly the confirmed boards for the external Agent.");
  }
  if (result.apiVersion && result.apiVersion !== state.api_version) {
    throw new Error(`Monday reported API version '${result.apiVersion}' instead of '${state.api_version}'.`);
  }
  return actualResources;
};

export async function advanceMondayAgentQualification({
  statePath,
  agentToken = process.env[MONDAY_AGENT_TOKEN_SECRET_REF],
  fetchImpl = globalThis.fetch,
} = {}) {
  const absoluteStatePath = resolve(statePath);
  const state = readMondayAgentQualificationState(absoluteStatePath);
  if (state.phase === "complete") {
    return { status: "complete", statePath: absoluteStatePath, state, message: "Monday external-Agent qualification is already complete.", diagnostics: [] };
  }
  if (state.phase !== "agent-ready") throw new Error(`Unknown Monday qualification phase '${state.phase}'.`);
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
  const resources = validateDiscovery(state, result);
  const discovery = {
    schema_version: 1,
    kind: "monday-external-agent-discovery-receipt",
    observed_at: now(),
    authentication_mode: state.authentication_mode,
    api_version_requested: state.api_version,
    api_version_reported: result.apiVersion,
    request_id: result.requestId,
    identity: result.data.identity,
    account: result.data.account,
    resources,
    boards: result.data.boards,
    external_effects: [],
    credentials_retained: false,
  };
  discovery.discovery_hash = sha256(JSON.stringify(discovery));
  const completed = {
    ...state,
    phase: "complete",
    updated_at: now(),
    evidence: { discovery },
    history: [...state.history, { phase: "external-agent-discovery", status: "complete", at: now(), receipt: discovery.discovery_hash }],
  };
  writeMondayAgentQualificationState(absoluteStatePath, completed);
  return {
    status: "complete",
    statePath: absoluteStatePath,
    state: completed,
    message: "Monday external-Agent identity, exact resource grants, and board metadata are qualified; no credential was retained and no provider write occurred.",
    diagnostics: [],
  };
}
