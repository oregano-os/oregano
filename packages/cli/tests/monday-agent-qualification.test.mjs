import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { createMondayExternalAgentQualificationEvidence } from "../../connectors/monday/external-agent-qualification.ts";

const sha256 = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

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
      core_version: "0.5.11",
      workbench_version: "0.1.0-experimental.15",
    },
  });
  return { ...fixture, result };
};

const validRemotePlan = () => {
  const fixture = workspace();
  const result = planMondayAgentQualification({
    workspaceRoot: fixture.company,
    agentId: "700001",
    boardAccesses: ["100002:read-write", "100001:read"],
    statePath: fixture.state,
    coreIdentity: {
      repository: "https://github.com/example/oregano",
      ref: "a".repeat(40),
      core_version: "0.5.11",
      workbench_version: "0.1.0-experimental.15",
    },
    runtimeProfile: "vercel-neon",
    endpoint: "https://fixture-preview.vercel.app/api/records/rehearsal",
    runtimeScope: "fixture-team",
    runtimeProject: "fixture-project",
  });
  return { ...fixture, result };
};

const discoveryResponse = ({ kind = "external_agent_member", roleAccess = "view", sprintAccess = "edit", boards } = {}) => new Response(JSON.stringify({ data: {
  me: { id: "member-1", name: "Fixture Agent", kind, email: "agent-900001@agent.monday.com", account: { id: "account-1", name: "Fixture Company" } },
  boards: boards ?? [
    { id: "100001", name: "Roles Test", board_kind: "private", state: "active", permissions: "view", access_level: roleAccess, workspace: { id: "space-1", name: "Tests" }, groups: [{ id: "hq", title: "Headquarters", archived: false, deleted: false }], columns: [{ id: "people", title: "People", type: "people", archived: false, revision: "r1", settings: null }] },
    { id: "100002", name: "Sprint Test", board_kind: "private", state: "active", permissions: "edit", access_level: sprintAccess, workspace: { id: "space-1", name: "Tests" }, groups: [{ id: "ready", title: "Ready", archived: false, deleted: false }], columns: [{ id: "status", title: "Status", type: "status", archived: false, revision: "r2", settings: { labels: [] } }] },
  ],
} }), { status: 200, headers: { "api-version": "dev", "x-request-id": "request-1" } });

const remoteDiscoveryResult = () => ({
  apiVersion: "dev",
  requestId: "request-remote",
  data: {
    identity: { memberId: "member-1", name: "Fixture Agent", kind: "external_agent_member", email: "agent-900001@agent.monday.com", externalAgentId: "900001" },
    account: { id: "account-1", name: "Fixture Company" },
    boards: [
      { id: "100001", name: "Roles Test", boardKind: "private", state: "active", permissions: "view", accessLevel: "view", workspace: { id: "space-1", name: "Tests" }, groups: [], columns: [] },
      { id: "100002", name: "Sprint Test", boardKind: "private", state: "active", permissions: "edit", accessLevel: "edit", workspace: { id: "space-1", name: "Tests" }, groups: [], columns: [] },
    ],
  },
});

const protectedPreviewPlan = (state) => {
  const body = {
    schema_version: 1,
    kind: "company-records-preview-monday-agent-qualification",
    environment: "preview",
    instance_id: "fixture-instance",
    core: { ...state.core, clean: true, core_version: state.core.version },
    workspace: "example/company@" + "b".repeat(40),
    qualification_plan_hash: state.plan_hash,
    agent_id: state.agent_id,
    boards: state.boards,
    provider_secret_ref: state.secret_ref,
    provider_access: "external-agent-identity-and-selected-board-metadata-only",
    provider_effects: [],
    database_effects: [],
    production_effects: [],
    external_changes: [],
  };
  return { ...body, confirmation_hash: sha256(body) };
};

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

test("qualification proves external Agent identity and effective access while recording administrator-attested grants", async () => {
  const { result, state } = validPlan();
  initializeMondayAgentQualification({ planResult: result, confirmationHash: result.plan.confirmation_hash });
  const requests = [];
  const discovered = await advanceMondayAgentQualification({
    statePath: state,
    agentToken: "fixture-agent-token",
    fetchImpl: async (_url, init) => {
      requests.push({ headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      return discoveryResponse();
    },
  });
  assert.equal(discovered.status, "waiting");
  assert.equal(discovered.state.phase, "identity-review");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.get("authorization"), "fixture-agent-token");
  assert.equal(requests[0].headers.get("api-version"), "dev");
  assert.deepEqual(requests[0].body.variables, { boardIds: ["100001", "100002"] });
  assert.doesNotMatch(requests[0].body.query, /agent_knowledge|items_page|column_values|mutation/);
  const reviewHash = discovered.next_action.confirmation_hash;
  assert.match(reviewHash, /^[0-9a-f]{64}$/);
  const qualification = await advanceMondayAgentQualification({ statePath: state, agentToken: "", identityConfirmationHash: reviewHash, fetchImpl: async () => { throw new Error("unexpected provider call"); } });
  assert.equal(qualification.status, "complete");
  const raw = readFileSync(state, "utf8");
  assert.doesNotMatch(raw, /fixture-agent-token/);
  const receipt = readMondayAgentQualificationState(state).evidence.discovery;
  assert.equal(receipt.configured_agent_id, "700001");
  assert.equal(receipt.identity.externalAgentId, "900001");
  assert.equal(receipt.identity.kind, "external_agent_member");
  assert.equal(receipt.identity_mapping_status, "administrator-confirmed");
  assert.equal(receipt.identity_mapping_confirmation_hash, reviewHash);
  assert.deepEqual(receipt.resources, [
    { id: "100001", scope: "board", permission: "read", evidence: "administrator-attestation-and-effective-access" },
    { id: "100002", scope: "board", permission: "read-write", evidence: "administrator-attestation-and-effective-access" },
  ]);
  assert.equal(receipt.grant_inventory.machine_listed_by_authenticated_agent, false);
  assert.equal(receipt.grant_inventory.attestation_plan_hash, result.plan.confirmation_hash);
  assert.deepEqual(receipt.effective_access.map(({ id, verified_minimum, provider_write_effect_verified }) => ({ id, verified_minimum, provider_write_effect_verified })), [
    { id: "100001", verified_minimum: "read", provider_write_effect_verified: false },
    { id: "100002", verified_minimum: "read-write-metadata", provider_write_effect_verified: false },
  ]);
  assert.equal(receipt.credentials_retained, false);
  assert.deepEqual(receipt.external_effects, []);
});

test("qualification rejects human tokens, missing boards, and effective-access drift", async () => {
  for (const response of [
    discoveryResponse({ kind: "admin" }),
    discoveryResponse({ sprintAccess: "view" }),
    discoveryResponse({ boards: [{ id: "100001", name: "Roles Test", board_kind: "private", state: "active", permissions: "view", access_level: "view", workspace: null, groups: [], columns: [] }] }),
  ]) {
    const { result, state } = validPlan();
    initializeMondayAgentQualification({ planResult: result, confirmationHash: result.plan.confirmation_hash });
    await assert.rejects(() => advanceMondayAgentQualification({ statePath: state, agentToken: "fixture-agent-token", fetchImpl: async () => response }), /external Agent|selected board|effective access/);
    assert.equal(readMondayAgentQualificationState(state).phase, "agent-ready");
  }
});

test("identity mapping review fails closed on a wrong confirmation hash without another provider call", async () => {
  const { result, state } = validPlan();
  initializeMondayAgentQualification({ planResult: result, confirmationHash: result.plan.confirmation_hash });
  const discovered = await advanceMondayAgentQualification({ statePath: state, agentToken: "fixture-agent-token", fetchImpl: async () => discoveryResponse() });
  assert.equal(discovered.state.phase, "identity-review");
  let called = false;
  await assert.rejects(() => advanceMondayAgentQualification({ statePath: state, identityConfirmationHash: "f".repeat(64), fetchImpl: async () => { called = true; throw new Error("unexpected"); } }), /does not match/);
  assert.equal(called, false);
  assert.equal(readMondayAgentQualificationState(state).phase, "identity-review");
});

test("protected Preview qualification plans before reading and accepts only the exact provider-read confirmation", async () => {
  const { result, state } = validRemotePlan();
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.plan.runtime.profile, "vercel-neon");
  initializeMondayAgentQualification({ planResult: result, confirmationHash: result.plan.confirmation_hash });
  let providerReads = 0;
  const remoteProfile = {
    id: "vercel-neon",
    async request({ body }) {
      const current = readMondayAgentQualificationState(state);
      const plan = protectedPreviewPlan(current);
      if (body.action === "plan-monday-qualification") return { ok: true, plan };
      providerReads += 1;
      const evidence = createMondayExternalAgentQualificationEvidence({
        agentId: current.agent_id,
        apiVersion: current.api_version,
        boards: current.boards,
        planHash: current.plan_hash,
        result: remoteDiscoveryResult(),
        observedAt: "2026-09-02T10:00:00.000Z",
      });
      return { ok: true, applied: true, operation: "monday-agent-qualification-read", evidence };
    },
  };
  const planned = await advanceMondayAgentQualification({ statePath: state, agentToken: "", remoteProfile });
  assert.equal(planned.state.phase, "provider-read-review");
  assert.equal(providerReads, 0);
  await assert.rejects(
    advanceMondayAgentQualification({ statePath: state, agentToken: "", providerReadConfirmationHash: "f".repeat(64), remoteProfile }),
    /does not match/,
  );
  assert.equal(providerReads, 0);
  const discovered = await advanceMondayAgentQualification({
    statePath: state,
    agentToken: "",
    providerReadConfirmationHash: planned.next_action.confirmation_hash,
    remoteProfile,
  });
  assert.equal(providerReads, 1);
  assert.equal(discovered.state.phase, "identity-review");
  assert.equal(discovered.state.evidence.discovery_pending.credentials_retained, false);
  assert.doesNotMatch(readFileSync(state, "utf8"), /fixture-agent-token/);
});
