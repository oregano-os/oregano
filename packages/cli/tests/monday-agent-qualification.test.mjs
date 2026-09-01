import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  advanceMondayAgentQualification,
  initializeMondayAgentQualification,
  planMondayAgentQualification,
  readMondayAgentQualificationState,
  writeMondayAgentQualificationState,
} from "../src/monday-agent-qualification.mjs";

const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), "companyos-monday-agent-qualification-"));
  const company = join(root, "company");
  mkdirSync(company);
  writeFileSync(join(company, "company.md"), "---\ncompany: Example\n---\n");
  return { root, company, state: join(root, "private", "monday-agent.json") };
};

const validPlan = () => {
  const fixture = workspace();
  const result = planMondayAgentQualification({
    workspaceRoot: fixture.company,
    agentId: "700001",
    boardAccesses: ["100002:read-write", "100001:read", "100001:read"],
    statePath: fixture.state,
    coreIdentity: {
      repository: "https://github.com/example/oregano",
      ref: "a".repeat(40),
      core_version: "0.5.4",
      workbench_version: "0.1.0-experimental.12",
    },
  });
  return { ...fixture, result };
};

const discoveryResponse = ({ kind = "external_agent_member", resources } = {}) => new Response(JSON.stringify({ data: {
  me: { id: "member-1", name: "Fixture Agent", kind, email: "agent-700001@agent.monday.com", account: { id: "account-1", name: "Fixture Company" } },
  agent_knowledge: { resources: resources ?? [
    { resource_id: "100001", scope_type: "BOARD", permission_type: "READ" },
    { resource_id: "100002", scope_type: "BOARD", permission_type: "READ_WRITE" },
  ] },
  boards: [
    { id: "100001", name: "Roles Test", board_kind: "private", state: "active", permissions: "view", workspace: { id: "space-1", name: "Tests" }, groups: [{ id: "hq", title: "Headquarters", archived: false, deleted: false }], columns: [{ id: "people", title: "People", type: "people", archived: false, revision: "r1", settings_str: null }] },
    { id: "100002", name: "Sprint Test", board_kind: "private", state: "active", permissions: "edit", workspace: { id: "space-1", name: "Tests" }, groups: [{ id: "ready", title: "Ready", archived: false, deleted: false }], columns: [{ id: "status", title: "Status", type: "status", archived: false, revision: "r2", settings_str: "{\\\"labels\\\":{}}" }] },
  ],
} }), { status: 200, headers: { "api-version": "dev", "x-request-id": "request-1" } });

test("Monday Agent qualification planning is exact, effect-free, and secret-free", () => {
  const { result } = validPlan();
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.plan.authentication_mode, "external-agent");
  assert.equal(result.plan.agent_id, "700001");
  assert.equal(result.plan.api_version, "dev");
  assert.deepEqual(result.plan.boards, [
    { id: "100001", permission: "read" },
    { id: "100002", permission: "read-write" },
  ]);
  assert.equal(result.plan.secret_ref, "env:MONDAY_API_TOKEN");
  assert.match(result.plan.confirmation_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.plan.external_changes.length, 2);
  assert.doesNotMatch(JSON.stringify(result.plan), /fixture-agent-token/);
});

test("Monday Agent qualification state is mode 0600 and refuses credential material", () => {
  const { result, state } = validPlan();
  const initialized = initializeMondayAgentQualification({ planResult: result, confirmationHash: result.plan.confirmation_hash });
  assert.equal(initialized.state.phase, "agent-ready");
  assert.equal(statSync(state).mode & 0o777, 0o600);
  assert.equal(readMondayAgentQualificationState(state).secret_ref, "env:MONDAY_API_TOKEN");
  assert.throws(() => writeMondayAgentQualificationState(`${state}.bad`, { schema_version: 1, kind: "monday-external-agent-qualification", access_token: "not-allowed" }), /sensitive qualification state field/);
  assert.throws(() => writeMondayAgentQualificationState(`${state}.bad2`, { schema_version: 1, kind: "monday-external-agent-qualification", note: "api_token=credential-value" }), /credential material/);
});

test("wrong confirmation and absent Instance secret perform no provider call", async () => {
  const { result, state } = validPlan();
  const rejected = initializeMondayAgentQualification({ planResult: result, confirmationHash: "wrong" });
  assert.equal(rejected.state, null);
  const initialized = initializeMondayAgentQualification({ planResult: result, confirmationHash: result.plan.confirmation_hash });
  let called = false;
  const response = await advanceMondayAgentQualification({ statePath: initialized.statePath, agentToken: "", fetchImpl: async () => { called = true; throw new Error("unexpected"); } });
  assert.equal(response.status, "waiting");
  assert.equal(response.next_action.secret_ref, "env:MONDAY_API_TOKEN");
  assert.equal(called, false);
  assert.equal(readMondayAgentQualificationState(state).phase, "agent-ready");
});

test("qualification proves the external Agent identity, exact grants, and exact boards", async () => {
  const { result, state } = validPlan();
  initializeMondayAgentQualification({ planResult: result, confirmationHash: result.plan.confirmation_hash });
  const requests = [];
  const qualification = await advanceMondayAgentQualification({
    statePath: state,
    agentToken: "fixture-agent-token",
    fetchImpl: async (_url, init) => {
      requests.push({ headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      return discoveryResponse();
    },
  });
  assert.equal(qualification.status, "complete");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.get("authorization"), "fixture-agent-token");
  assert.equal(requests[0].headers.get("api-version"), "dev");
  assert.deepEqual(requests[0].body.variables, { agentId: "700001", boardIds: ["100001", "100002"] });
  assert.doesNotMatch(requests[0].body.query, /items_page|column_values|mutation/);
  const raw = readFileSync(state, "utf8");
  assert.doesNotMatch(raw, /fixture-agent-token/);
  const receipt = readMondayAgentQualificationState(state).evidence.discovery;
  assert.equal(receipt.identity.externalAgentId, "700001");
  assert.equal(receipt.identity.kind, "external_agent_member");
  assert.deepEqual(receipt.resources, [
    { id: "100001", scope: "board", permission: "read" },
    { id: "100002", scope: "board", permission: "read-write" },
  ]);
  assert.equal(receipt.credentials_retained, false);
  assert.deepEqual(receipt.external_effects, []);
});

test("qualification rejects human tokens and any resource-grant drift", async () => {
  for (const response of [
    discoveryResponse({ kind: "admin" }),
    discoveryResponse({ resources: [{ resource_id: "100001", scope_type: "BOARD", permission_type: "READ" }] }),
    discoveryResponse({ resources: [
      { resource_id: "100001", scope_type: "BOARD", permission_type: "READ_WRITE" },
      { resource_id: "100002", scope_type: "BOARD", permission_type: "READ_WRITE" },
    ] }),
    discoveryResponse({ resources: [
      { resource_id: "100001", scope_type: "BOARD", permission_type: "READ" },
      { resource_id: "100002", scope_type: "BOARD", permission_type: "READ_WRITE" },
      { resource_id: "100003", scope_type: "BOARD", permission_type: "READ" },
    ] }),
  ]) {
    const { result, state } = validPlan();
    initializeMondayAgentQualification({ planResult: result, confirmationHash: result.plan.confirmation_hash });
    await assert.rejects(() => advanceMondayAgentQualification({ statePath: state, agentToken: "fixture-agent-token", fetchImpl: async () => response }), /external Agent|resource grants/);
    assert.equal(readMondayAgentQualificationState(state).phase, "agent-ready");
  }
});
