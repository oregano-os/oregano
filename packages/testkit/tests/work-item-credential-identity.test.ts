import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { CapabilityEffectOutcomeUnknownError } from "../../capabilities/contracts.ts";
import { MondayClient } from "../../connectors/monday/client.ts";
import { MondayWorkItemConnector } from "../../connectors/monday/connector.ts";
import { InMemoryMondayEchoStore } from "../../connectors/monday/echo-guard.ts";
import { mondayCredentialIdentity, qualifyMondayWorkItemCredential } from "../../connectors/monday/work-item-qualification.ts";
import { createConfiguredRuntimeConnectors } from "../../runner-vercel/src/lib/runtime-connectors.ts";
import { engineArtifact } from "../workflow-engine-fixture.ts";

const expected = { account_id: "300003", member_id: "700007", kind: "external_agent_member", external_agent_id: "900001" };
const binding = { id: "delivery-board", boardId: "200002", permission: "read-write" as const, fields: { status: "status_col" } };
const context = { instanceId: "qualification-test", runId: "run", stepId: "write", agentId: "agent", toolId: "tool", idempotencyKey: "claimed" };
const fixture = () => {
  const requests: Array<{ body: any; authorization: string | null }> = [];
  const state = {
    metadata: { me: { id: expected.member_id, name: "Fixture Agent", kind: expected.kind, email: `agent-${expected.external_agent_id}@agent.monday.com`, account: { id: expected.account_id, name: "Fixture account" } },
      boards: [{ id: binding.boardId, name: "Fixture Board", board_kind: "private", state: "active", permissions: "everyone", access_level: "edit", workspace: null,
        groups: [], columns: [{ id: "status_col", title: "Status", type: "status", archived: false }] }] },
    apiVersion: "dev", version: "v1", loseMutationReceipt: false,
  };
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)); requests.push({ body, authorization: new Headers(init?.headers).get("authorization") });
    let data;
    if (body.query.includes("QualifyCompanyOSExternalAgent")) data = state.metadata;
    else if (body.query.includes("change_multiple_column_values")) {
      state.version = "v2";
      if (state.loseMutationReceipt) throw new Error("synthetic provider receipt lost");
      data = { change_multiple_column_values: { id: "800001" } };
    } else data = { items: [{ id: "800001", name: "Fixture Item", updated_at: state.version, board: { id: binding.boardId }, group: { id: "current" }, column_values: [] }] };
    return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json", "api-version": state.apiVersion, "x-request-id": `receipt-${requests.length}` } });
  };
  return { state, requests, fetcher };
};
const configuration = () => ({ token_ref: "env:TEST_MON_TOKEN", api_version: "dev", actor_id: expected.member_id, credential_identity: structuredClone(expected),
  resources: [{ id: binding.id, board_id: binding.boardId, permission: binding.permission, fields: binding.fields }] });
const hosted = (t: TestContext, h: ReturnType<typeof fixture>, config: any = configuration()) => {
  t.mock.method(globalThis, "fetch", h.fetcher);
  const artifact = engineArtifact(context.instanceId);
  artifact.connectors = [{ id: "work-items", connector: "oregano/monday-work-items", connectorVersion: "0.1.0", configuration: config }];
  return createConfiguredRuntimeConnectors({ artifact, environment: { TEST_MON_TOKEN: "synthetic-secret" }, chat: () => { throw new Error("No chat required"); } })[0]!;
};

test("hosted work-item configuration requires reviewed identity and cannot infer it from a token", (t) => {
  const h = fixture();
  for (const mutate of [
    (c: any) => { delete c.credential_identity; }, (c: any) => { c.credential_identity.kind = "person"; },
    (c: any) => { c.actor_id = "700008"; }, (c: any) => { c.credential_identity.account_id = ""; },
    (c: any) => { c.credential_identity.token = "unaccepted"; },
  ]) {
    const config = configuration(); mutate(config);
    assert.throws(() => hosted(t, h, config), /credential_identity|actor_id/);
  }
  assert.equal(h.requests.length, 0);
});

test("hosted reads requalify the same credential on every call and retain only identity metadata", async (t) => {
  const h = fixture(), connector = hosted(t, h);
  const result = await connector.invoke("work-item.read", { resource_binding: binding.id, work_item_id: "800001" }, context);
  assert.deepEqual(h.requests.map((request) => request.body.query.includes("QualifyCompanyOSExternalAgent")), [true, false]);
  assert.ok(h.requests.every((request) => request.authorization === "synthetic-secret"));
  const receipt = result.evidence.credential_qualification as any;
  assert.equal(receipt.account_id, expected.account_id); assert.equal(receipt.member_id, expected.member_id);
  assert.equal(receipt.request_id, "receipt-1"); assert.equal(receipt.provider_write_effect_verified, false);
  assert.doesNotMatch(JSON.stringify(result.evidence), /synthetic-secret|agent\.monday\.com|Fixture Agent/);
  h.state.metadata.me.account.id = "300004";
  await assert.rejects(connector.invoke("work-item.read", { resource_binding: binding.id, work_item_id: "800001" }, context), /reviewed account/);
  assert.equal(h.requests.length, 3, "a new qualification occurs and the second item read is refused");
});

test("changed provider identity, board scope or mapped columns fail before work-item access", async () => {
  for (const mutate of [
    (h: ReturnType<typeof fixture>) => { h.state.metadata.me.id = "700008"; },
    (h: ReturnType<typeof fixture>) => { h.state.metadata.me.kind = "person"; },
    (h: ReturnType<typeof fixture>) => { h.state.metadata.me.email = "agent-900002@agent.monday.com"; },
    (h: ReturnType<typeof fixture>) => { h.state.metadata.boards[0]!.state = "archived"; },
    (h: ReturnType<typeof fixture>) => { h.state.metadata.boards[0]!.access_level = "view"; },
    (h: ReturnType<typeof fixture>) => { h.state.metadata.boards[0]!.columns[0]!.archived = true; },
    (h: ReturnType<typeof fixture>) => { h.state.metadata.boards[0]!.columns.push(structuredClone(h.state.metadata.boards[0]!.columns[0]!)); },
    (h: ReturnType<typeof fixture>) => { h.state.apiVersion = "other"; },
  ]) {
    const h = fixture(); mutate(h);
    const client = new MondayClient({ token: "synthetic-secret", apiVersion: "dev", fetcher: h.fetcher });
    await assert.rejects(qualifyMondayWorkItemCredential({ client, expected, binding }), /reviewed|qualified|mapped column|API version/);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0]!.body.query.includes("QualifyCompanyOSExternalAgent"), true);
  }
});

test("provider discovery rejects duplicate and unrequested boards instead of filtering them out", async () => {
  for (const id of [binding.boardId, "200003"]) {
    const h = fixture(); h.state.metadata.boards.push({ ...structuredClone(h.state.metadata.boards[0]!), id });
    const client = new MondayClient({ token: "synthetic-secret", apiVersion: "dev", fetcher: h.fetcher });
    await assert.rejects(qualifyMondayWorkItemCredential({ client, expected, binding }), /ambiguous or unrequested/);
    assert.equal(h.requests.length, 1);
  }
});

test("ambiguous field aliases and another Instance are refused without provider requests", async (t) => {
  const h = fixture(), connector = hosted(t, h);
  await assert.rejects(connector.invoke("work-item.read", { resource_binding: binding.id, work_item_id: "800001" }, { ...context, instanceId: "other" }), /another Company Instance/);
  const client = new MondayClient({ token: "synthetic-secret", apiVersion: "dev", fetcher: h.fetcher });
  await assert.rejects(qualifyMondayWorkItemCredential({ client, expected, binding: { ...binding, fields: { one: "status_col", two: "status_col" } } }), /alias/);
  assert.equal(h.requests.length, 0);
});

test("successful and uncertain writes retain qualification without replacing per-item evidence", async () => {
  for (const uncertain of [false, true]) {
    const h = fixture(); h.state.loseMutationReceipt = uncertain;
    const client = new MondayClient({ token: "synthetic-secret", apiVersion: "dev", fetcher: h.fetcher });
    const connector = new MondayWorkItemConnector({ client, instanceId: context.instanceId, actorId: expected.member_id, bindings: [binding], echoStore: new InMemoryMondayEchoStore(),
      qualifyCredential: (resource) => qualifyMondayWorkItemCredential({ client, expected: mondayCredentialIdentity(expected, expected.member_id), binding: resource }) });
    const invoke = () => connector.invoke("work-item.batch-update", { resource_binding: binding.id, updates: [{ work_item_id: "800001", expected_version: "v1", changes: { status: "Done" } }] }, context);
    if (uncertain) {
      await assert.rejects(invoke, (error: unknown) => {
        assert.ok(error instanceof CapabilityEffectOutcomeUnknownError); const evidence = error.evidence as any;
        assert.equal(evidence.credential_qualification.member_id, expected.member_id);
        assert.deepEqual(evidence.effect_review.items, [{ item_id: "800001", status: "unknown" }]); return true;
      });
    } else {
      const result = await invoke(); assert.equal((result.output as any).complete, true);
      assert.equal((result.evidence.credential_qualification as any).member_id, expected.member_id);
    }
    assert.equal(h.requests[0]!.body.query.includes("QualifyCompanyOSExternalAgent"), true);
    assert.equal(h.requests.filter((request) => request.body.query.includes("change_multiple_column_values")).length, 1);
  }
});
