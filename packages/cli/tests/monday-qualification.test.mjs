import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  advanceMondayQualification,
  createMondayAuthorizationSession,
  exchangeMondayAuthorizationCode,
  initializeMondayQualification,
  MONDAY_AUTHORIZATION_ENDPOINT,
  MONDAY_OAUTH_SCOPES,
  MONDAY_TOKEN_ENDPOINT,
  parseMondayAuthorizationCallback,
  planMondayQualification,
  readMondayQualificationState,
  writeMondayQualificationState,
} from "../src/monday-qualification.mjs";

const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), "companyos-monday-qualification-"));
  const company = join(root, "company");
  mkdirSync(company);
  writeFileSync(join(company, "company.md"), "---\ncompany: Example\n---\n");
  return { root, company, state: join(root, "private", "monday.json") };
};

const validPlan = () => {
  const fixture = workspace();
  const result = planMondayQualification({
    workspaceRoot: fixture.company,
    clientId: "client-fixture-1",
    appVersionId: "700001",
    redirectUri: "http://127.0.0.1:43127/callback",
    boardIds: ["100001", "100002", "100001"],
    statePath: fixture.state,
    coreIdentity: {
      repository: "https://github.com/example/oregano",
      ref: "a".repeat(40),
      core_version: "0.6.0",
      workbench_version: "0.6.0",
    },
  });
  return { ...fixture, result };
};

test("Monday qualification planning is read-only, exact, and secret-free", () => {
  const { result } = validPlan();
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.plan.scopes, ["boards:read", "me:read"]);
  assert.equal(result.plan.app_version_id, "700001");
  assert.deepEqual(result.plan.boards, ["100001", "100002"]);
  assert.match(result.plan.confirmation_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.plan.credential_handling.persisted_secrets, []);
  assert.doesNotMatch(JSON.stringify(result.plan), /client-fixture-secret|memory-access|memory-refresh/);
  assert.match(result.plan.external_changes[1], /No board, item, group, column, update, webhook, Agent/);
});

test("Monday qualification state remains mode 0600 and rejects credential material", () => {
  const { result, state } = validPlan();
  const initialized = initializeMondayQualification({ planResult: result, confirmationHash: result.plan.confirmation_hash });
  assert.equal(initialized.state.phase, "oauth-ready");
  assert.equal(statSync(state).mode & 0o777, 0o600);
  assert.equal(readMondayQualificationState(state).secret_ref, "env:MONDAY_OAUTH_CLIENT_SECRET");
  assert.throws(() => writeMondayQualificationState(`${state}.bad`, { schema_version: 1, kind: "monday-read-qualification", access_token: "not-allowed" }), /sensitive qualification state field/);
  assert.throws(() => writeMondayQualificationState(`${state}.bad2`, { schema_version: 1, kind: "monday-read-qualification", note: "access_token=credential-value" }), /credential material/);
});

test("Monday OAuth authorization uses exact read scopes, one-time state, and S256 PKCE", () => {
  let counter = 0;
  const random = (size) => Buffer.alloc(size, ++counter);
  const session = createMondayAuthorizationSession({
    clientId: "client-fixture-1",
    appVersionId: "700001",
    redirectUri: "http://127.0.0.1:43127/callback",
    random,
  });
  const url = new URL(session.authorizationUrl);
  assert.equal(url.origin + url.pathname, MONDAY_AUTHORIZATION_ENDPOINT);
  assert.equal(url.searchParams.get("app_version_id"), "700001");
  assert.equal(url.searchParams.get("scope"), [...MONDAY_OAUTH_SCOPES].sort().join(" "));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), session.challenge);
  assert.ok(session.verifier.length >= 43 && session.verifier.length <= 128);
  assert.equal(parseMondayAuthorizationCallback(`http://127.0.0.1:43127/callback?code=temporary-code&state=${session.state}`, session.state), "temporary-code");
  assert.throws(() => parseMondayAuthorizationCallback("http://127.0.0.1:43127/callback?code=x&state=wrong", session.state), /state did not match/);
  assert.throws(() => parseMondayAuthorizationCallback(`http://127.0.0.1:43127/callback?error=access_denied&state=${session.state}`, session.state), /denied or failed/);
});

test("Monday OAuth 2.1 token exchange enforces the exact read-only scopes without exposing credentials", async () => {
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ access_token: "memory-access", refresh_token: "memory-refresh", token_type: "Bearer", scope: "me:read boards:read", expires_in: 3600 }), { status: 200 });
  };
  const result = await exchangeMondayAuthorizationCode({ clientId: "client-fixture-1", clientSecret: "client-fixture-secret", redirectUri: "http://127.0.0.1:43127/callback", code: "temporary-code", verifier: "v".repeat(64), fetchImpl });
  assert.equal(request.url, MONDAY_TOKEN_ENDPOINT);
  assert.equal(request.body.client_secret, "client-fixture-secret");
  assert.equal(result.accessToken, "memory-access");
  assert.deepEqual(result.scopes, ["boards:read", "me:read"]);
  await assert.rejects(() => exchangeMondayAuthorizationCode({
    clientId: "client-fixture-1", clientSecret: "client-fixture-secret", redirectUri: "http://127.0.0.1:43127/callback", code: "temporary-code", verifier: "v".repeat(64),
    fetchImpl: async () => new Response(JSON.stringify({ access_token: "memory-access", refresh_token: "memory-refresh", scope: "boards:read boards:write me:read" }), { status: 200 }),
  }), /instead of the exact read-only/);
});

test("Monday qualification discovers only selected board metadata and retains no OAuth credential", async () => {
  const { result, state } = validPlan();
  initializeMondayQualification({ planResult: result, confirmationHash: result.plan.confirmation_hash });
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    if (String(url) === MONDAY_TOKEN_ENDPOINT) {
      return new Response(JSON.stringify({ access_token: "memory-access", refresh_token: "memory-refresh", scope: "boards:read me:read", expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: {
      me: { id: "actor-1", name: "Fixture Operator", account: { id: "account-1", name: "Fixture Company" } },
      boards: [
        { id: "100001", name: "Sprint Test", board_kind: "private", state: "active", permissions: "edit", workspace: { id: "space-1", name: "Tests" }, groups: [{ id: "ready", title: "Ready", archived: false, deleted: false }], columns: [{ id: "status", title: "Status", type: "status", archived: false, revision: "r1", settings_str: "{\\\"labels\\\":{}}" }] },
        { id: "100002", name: "Roles Test", board_kind: "private", state: "active", permissions: "view", workspace: { id: "space-1", name: "Tests" }, groups: [{ id: "hq", title: "Headquarters", archived: false, deleted: false }], columns: [{ id: "people", title: "People", type: "people", archived: false, revision: "r2", settings_str: null }] },
      ],
    } }), { status: 200, headers: { "api-version": "2026-07", "x-request-id": "request-1" } });
  };
  let authorization;
  const qualification = await advanceMondayQualification({
    statePath: state,
    clientSecret: "client-fixture-secret",
    fetchImpl,
    onAuthorization: (value) => { authorization = value; },
    waitForAuthorization: async ({ onListening }) => { onListening(); return "temporary-code"; },
  });
  assert.equal(qualification.status, "complete");
  assert.deepEqual(authorization.scopes, ["boards:read", "me:read"]);
  assert.deepEqual(requests[1].body.variables.boardIds, ["100001", "100002"]);
  assert.doesNotMatch(requests[1].body.query, /items|updates|column_values/);
  assert.equal(requests[1].headers.get("authorization"), "memory-access");
  const rawState = readFileSync(state, "utf8");
  assert.doesNotMatch(rawState, /memory-access|memory-refresh|client-fixture-secret|temporary-code/);
  const persisted = readMondayQualificationState(state);
  assert.equal(persisted.evidence.discovery.credentials_retained, false);
  assert.deepEqual(persisted.evidence.discovery.external_effects, []);
  assert.deepEqual(persisted.evidence.discovery.boards.map((board) => board.id), ["100001", "100002"]);
});

test("Monday qualification waits for secret injection without starting browser consent", async () => {
  const { result, state } = validPlan();
  initializeMondayQualification({ planResult: result, confirmationHash: result.plan.confirmation_hash });
  let started = false;
  const response = await advanceMondayQualification({ statePath: state, clientSecret: "", onAuthorization: () => { started = true; } });
  assert.equal(response.status, "waiting");
  assert.equal(response.next_action.type, "runtime-secret-entry");
  assert.equal(response.next_action.runtime_host, "instance-selected");
  assert.equal(response.next_action.secret_ref, "env:MONDAY_OAUTH_CLIENT_SECRET");
  assert.equal(started, false);
});
