import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
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

export const MONDAY_QUALIFICATION_STATE_VERSION = 1;
export const MONDAY_API_VERSION = "2026-07";
export const MONDAY_OAUTH_SCOPES = Object.freeze(["boards:read", "me:read"]);
export const MONDAY_OAUTH_CLIENT_SECRET_REF = "MONDAY_OAUTH_CLIENT_SECRET";
export const MONDAY_AUTHORIZATION_ENDPOINT = "https://auth.monday.com/oauth2/authorize";
export const MONDAY_TOKEN_ENDPOINT = "https://auth.monday.com/oauth_ms/oauth/token";

const clean = (value) => String(value ?? "").normalize("NFC").trim();
const now = () => new Date().toISOString();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hasErrors = (diagnostics) => diagnostics.some((item) => item.severity === "error");
const CREDENTIAL_VALUE = /(?:eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.|(?:api|access|refresh|client)[-_]?(?:key|token|secret)[=:][^\s]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const SENSITIVE_KEY = /(?:^|_)(?:token|password|secret|authorization_code|code_verifier|private_key)(?:_|$)/i;

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

export function writeMondayQualificationState(path, state) {
  validateSafeState(state);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function readMondayQualificationState(path) {
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (state?.schema_version !== MONDAY_QUALIFICATION_STATE_VERSION || state?.kind !== "monday-read-qualification") {
    throw new Error(`${path}: unsupported Monday qualification state.`);
  }
  validateSafeState(state);
  return state;
}

export function planMondayQualification({ workspaceRoot, clientId, appVersionId, redirectUri, boardIds, statePath, coreIdentity }) {
  const diagnostics = [];
  const workspace = resolve(workspaceRoot ?? "");
  if (!existsSync(resolve(workspace, "company.md"))) diagnostics.push(diagnostic("MON001", "error", "Monday qualification requires a Company Workspace with company.md.", { file: workspace }));
  const normalizedClientId = clean(clientId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(normalizedClientId)) diagnostics.push(diagnostic("MON002", "error", "Monday OAuth client ID has an invalid shape.", { field: "client_id" }));
  const normalizedAppVersionId = clean(appVersionId);
  if (!/^\d{1,20}$/.test(normalizedAppVersionId)) diagnostics.push(diagnostic("MON012", "error", "Monday app version ID must be an exact numeric ID.", { field: "app_version_id" }));

  let callback;
  try { callback = new URL(clean(redirectUri)); }
  catch { diagnostics.push(diagnostic("MON003", "error", "Monday OAuth redirect URI must be an exact URL.", { field: "redirect_uri" })); }
  if (callback) {
    const loopback = callback.protocol === "http:" && new Set(["127.0.0.1", "localhost", "[::1]"]).has(callback.hostname);
    if (!loopback || !callback.port || callback.username || callback.password || callback.search || callback.hash) {
      diagnostics.push(diagnostic("MON004", "error", "Monday qualification requires an exact loopback HTTP redirect URI with an explicit port and no credentials, query, or fragment.", { field: "redirect_uri" }));
    }
  }

  const boards = [...new Set((boardIds ?? []).map(clean))];
  if (boards.length === 0 || boards.length > 20) diagnostics.push(diagnostic("MON005", "error", "Monday qualification requires between one and twenty explicit board IDs.", { field: "boards" }));
  for (const boardId of boards) if (!/^\d{1,20}$/.test(boardId)) diagnostics.push(diagnostic("MON006", "error", `Monday board ID '${boardId}' is invalid.`, { field: "boards" }));

  const defaultState = resolve(dirname(workspace), ".companyos-bootstrap", `${basename(workspace)}-monday-qualification.json`);
  const normalizedStatePath = resolve(statePath ?? defaultState);
  if (!stateOutsideWorkspace(workspace, normalizedStatePath)) diagnostics.push(diagnostic("MON007", "error", "Monday qualification state must stay outside Company Workspace material.", { file: normalizedStatePath }));
  if (!isAbsolute(normalizedStatePath)) diagnostics.push(diagnostic("MON008", "error", "Monday qualification state path must resolve to an absolute path.", { file: normalizedStatePath }));
  const core = {
    repository: clean(coreIdentity?.repository),
    ref: clean(coreIdentity?.ref),
    version: clean(coreIdentity?.core_version),
    workbench_version: clean(coreIdentity?.workbench_version),
  };
  if (!/^[0-9a-f]{40}$/.test(core.ref) || !core.repository || !core.version || !core.workbench_version) {
    diagnostics.push(diagnostic("MON011", "error", "Monday qualification requires one clean exact Oregano Core identity.", { field: "core" }));
  }

  const plan = {
    schema_version: 1,
    kind: "monday-read-qualification",
    workspace,
    core,
    client_id: normalizedClientId,
    app_version_id: normalizedAppVersionId,
    redirect_uri: callback?.toString() ?? clean(redirectUri),
    scopes: [...MONDAY_OAUTH_SCOPES],
    api_version: MONDAY_API_VERSION,
    boards,
    state_path: normalizedStatePath,
    secret_ref: `env:${MONDAY_OAUTH_CLIENT_SECRET_REF}`,
    external_changes: [
      "The consenting Monday user authorizes the registered app for boards:read and me:read.",
      "No board, item, group, column, update, webhook, Agent, or provider permission is created or modified by discovery.",
    ],
    credential_handling: {
      authorization_code: "memory-only",
      pkce_verifier: "memory-only",
      access_token: "memory-only-discarded-after-discovery",
      refresh_token: "memory-only-discarded-after-discovery",
      persisted_secrets: [],
    },
    required_human_actions: [
      "Register the exact redirect URI and only boards:read and me:read on the bound Monday OAuth 2.1 app version.",
      `Enter the app client secret only into the runtime secret surface that injects ${MONDAY_OAUTH_CLIENT_SECRET_REF}; never enter it in chat, Git, an answers file, or a command argument.`,
      "Review the Monday consent page and approve only if the account and two scopes are correct.",
    ],
  };
  plan.confirmation_hash = sha256(JSON.stringify(plan));
  return { plan, diagnostics };
}

export function initializeMondayQualification({ planResult, confirmationHash }) {
  if (!planResult?.plan || hasErrors(planResult.diagnostics)) return { state: null, diagnostics: planResult?.diagnostics ?? [] };
  if (confirmationHash !== planResult.plan.confirmation_hash) {
    return { state: null, diagnostics: [...planResult.diagnostics, diagnostic("MON009", "error", "Monday qualification confirmation does not match the current plan.")] };
  }
  if (existsSync(planResult.plan.state_path)) {
    return { state: null, diagnostics: [...planResult.diagnostics, diagnostic("MON010", "error", "Monday qualification state already exists. Use --resume or select a new state path.", { file: planResult.plan.state_path })] };
  }
  const state = {
    schema_version: MONDAY_QUALIFICATION_STATE_VERSION,
    kind: "monday-read-qualification",
    plan_hash: planResult.plan.confirmation_hash,
    created_at: now(),
    updated_at: now(),
    phase: "oauth-ready",
    workspace: planResult.plan.workspace,
    core: planResult.plan.core,
    client_id: planResult.plan.client_id,
    app_version_id: planResult.plan.app_version_id,
    redirect_uri: planResult.plan.redirect_uri,
    scopes: planResult.plan.scopes,
    api_version: planResult.plan.api_version,
    boards: planResult.plan.boards,
    secret_ref: planResult.plan.secret_ref,
    evidence: {},
    history: [{ phase: "plan", status: "confirmed", at: now() }],
  };
  writeMondayQualificationState(planResult.plan.state_path, state);
  return { state, statePath: planResult.plan.state_path, diagnostics: planResult.diagnostics };
}

export function createMondayAuthorizationSession({ clientId, appVersionId, redirectUri, scopes = MONDAY_OAUTH_SCOPES, random = randomBytes }) {
  const state = random(32).toString("base64url");
  const verifier = random(64).toString("base64url");
  if (verifier.length < 43 || verifier.length > 128) throw new Error("Monday PKCE verifier has an invalid length.");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorization = new URL(MONDAY_AUTHORIZATION_ENDPOINT);
  authorization.searchParams.set("client_id", clientId);
  authorization.searchParams.set("app_version_id", appVersionId);
  authorization.searchParams.set("redirect_uri", redirectUri);
  authorization.searchParams.set("scope", [...scopes].sort().join(" "));
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  return { authorizationUrl: authorization.toString(), state, verifier, challenge };
}

export function parseMondayAuthorizationCallback(callbackUrl, expectedState) {
  const callback = new URL(callbackUrl);
  if (callback.searchParams.get("state") !== expectedState) throw new Error("Monday OAuth callback state did not match the active authorization.");
  if (callback.searchParams.get("error") || new Set(["denied", "error"]).has(clean(callback.searchParams.get("status")).toLowerCase())) {
    throw new Error("Monday OAuth authorization was denied or failed.");
  }
  const code = clean(callback.searchParams.get("code"));
  if (!code) throw new Error("Monday OAuth callback did not contain an authorization code.");
  return code;
}

const parseGrantedScopes = (value) => [...new Set(clean(value).split(/[\s,]+/).filter(Boolean))].sort();

export async function exchangeMondayAuthorizationCode({ clientId, clientSecret, redirectUri, code, verifier, fetchImpl = globalThis.fetch }) {
  if (!clientSecret) throw new Error(`Missing runtime secret ${MONDAY_OAUTH_CLIENT_SECRET_REF}.`);
  const response = await fetchImpl(MONDAY_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
    }),
  });
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error(`Monday OAuth token exchange failed with HTTP ${response.status}.`); }
  if (!response.ok) throw new Error(`Monday OAuth token exchange failed with HTTP ${response.status}.`);
  const accessToken = clean(payload?.access_token);
  const refreshToken = clean(payload?.refresh_token);
  if (!accessToken || !refreshToken) throw new Error("Monday OAuth 2.1 token exchange did not return the required in-memory credentials.");
  const scopes = parseGrantedScopes(payload?.scope);
  const expected = [...MONDAY_OAUTH_SCOPES].sort();
  if (JSON.stringify(scopes) !== JSON.stringify(expected)) throw new Error(`Monday granted scopes '${scopes.join(" ") || "none"}' instead of the exact read-only qualification scopes.`);
  return { accessToken, refreshToken, scopes, expiresIn: Number(payload?.expires_in) || null };
}

export async function waitForMondayAuthorization({ redirectUri, expectedState, timeoutMs = 10 * 60_000, onListening = () => {} }) {
  const target = new URL(redirectUri);
  const hostname = target.hostname === "[::1]" ? "::1" : target.hostname;
  const port = Number(target.port);
  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close(() => error ? rejectPromise(error) : resolvePromise(value));
    };
    const server = createServer((request, response) => {
      try {
        const requestUrl = new URL(request.url ?? "/", redirectUri);
        if (requestUrl.pathname !== target.pathname) {
          response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
          response.end("Not found");
          return;
        }
        const code = parseMondayAuthorizationCallback(requestUrl.toString(), expectedState);
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        response.end("Monday authorization received. You can return to CompanyOS.");
        finish(null, code);
      } catch (error) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        response.end("Monday authorization was not accepted. Return to CompanyOS for the safe diagnostic.");
        finish(error);
      }
    });
    server.on("error", (error) => finish(error));
    const timer = setTimeout(() => finish(new Error("Monday OAuth authorization timed out without retaining credentials.")), timeoutMs);
    server.listen(port, hostname, () => onListening());
  });
}

const discoveryReceipt = (result, state) => ({
  qualified_at: now(),
  actor: result.data.actor,
  account: result.data.account,
  scopes: [...state.scopes],
  api_version_requested: state.api_version,
  api_version_reported: result.apiVersion,
  request_id: result.requestId,
  boards: result.data.boards,
  discovery_hash: sha256(JSON.stringify(result.data)),
  credentials_retained: false,
  external_effects: [],
});

export async function advanceMondayQualification({
  statePath,
  clientSecret = process.env[MONDAY_OAUTH_CLIENT_SECRET_REF],
  fetchImpl = globalThis.fetch,
  onAuthorization = () => {},
  waitForAuthorization = waitForMondayAuthorization,
} = {}) {
  const absoluteStatePath = resolve(statePath);
  const state = readMondayQualificationState(absoluteStatePath);
  if (state.phase === "complete") return { status: "complete", statePath: absoluteStatePath, state, message: "Monday read-only resource qualification is complete.", diagnostics: [] };
  if (state.phase !== "oauth-ready") throw new Error(`Unknown Monday qualification phase '${state.phase}'.`);
  if (!clientSecret) {
    return {
      status: "waiting",
      statePath: absoluteStatePath,
      state,
      message: `The Monday OAuth client secret is not available through ${state.secret_ref}.`,
      next_action: { type: "runtime-secret-entry", runtime_host: "instance-selected", secret_ref: state.secret_ref, classification: "sensitive" },
      diagnostics: [],
    };
  }

  const session = createMondayAuthorizationSession({ clientId: state.client_id, appVersionId: state.app_version_id, redirectUri: state.redirect_uri, scopes: state.scopes });
  const authorizationPromise = waitForAuthorization({
    redirectUri: state.redirect_uri,
    expectedState: session.state,
    onListening: () => onAuthorization({
      type: "browser-authorization",
      provider: "monday",
      url: session.authorizationUrl,
      scopes: [...state.scopes],
      selected_boards: [...state.boards],
      credential_retention: "none",
    }),
  });
  const code = await authorizationPromise;
  let tokens;
  try {
    tokens = await exchangeMondayAuthorizationCode({
      clientId: state.client_id,
      clientSecret,
      redirectUri: state.redirect_uri,
      code,
      verifier: session.verifier,
      fetchImpl,
    });
    const client = new MondayClient({ token: tokens.accessToken, apiVersion: state.api_version, fetcher: fetchImpl });
    const discovery = await client.discoverResources(state.boards);
    state.evidence.discovery = discoveryReceipt(discovery, state);
    state.phase = "complete";
    state.updated_at = now();
    state.history.push({ phase: "complete", status: "qualified", at: state.updated_at });
    writeMondayQualificationState(absoluteStatePath, state);
  } finally {
    tokens = undefined;
  }
  return { status: "complete", statePath: absoluteStatePath, state, message: "Monday read-only resource qualification is complete; no OAuth credential was retained.", diagnostics: [] };
}
