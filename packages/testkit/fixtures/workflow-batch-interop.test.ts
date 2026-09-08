import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { MondayClient } from "../../connectors/monday/client.ts";
import { MondayWorkItemConnector } from "../../connectors/monday/connector.ts";
import { InMemoryMondayEchoStore } from "../../connectors/monday/echo-guard.ts";
import { engineArtifact, engineFixture, ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";
import { approveParity } from "./workflow-parity-cases.ts";

const response = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });

test("the actual provider adapter applies both reviewed readiness labels with complete preflight and no replay", async () => {
  const artifact = engineArtifact(), requests: any[] = [], versions: Record<string, string> = { one: "v1", two: "v1" };
  const applied: Record<string, any> = {};
  const monday = new MondayWorkItemConnector({ client: new MondayClient({ token: "synthetic-token", apiVersion: "dev", fetcher: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    if (String(body.query).includes("change_multiple_column_values")) {
      const id = String(body.variables.itemId); applied[id] = JSON.parse(body.variables.values); versions[id] = "v2";
      return response({ change_multiple_column_values: { id } });
    }
    const id = String(body.variables.ids[0]);
    return response({ items: [{ id, name: id, updated_at: versions[id], board: { id: "board-1" }, group: { id: "planned" }, column_values: [] }] });
  } }), instanceId: artifact.instance.id, actorId: "agent-1", bindings: [{ id: "sprint-board", boardId: "board-1", permission: "read-write", fields: { status: "status_col" } }], echoStore: new InMemoryMondayEchoStore() });
  const h = engineFixture({ artifact, batchConnector: monday }); h.now = "2030-01-09T16:30:00.000Z";
  h.planning.push({ record_id: "one", values: { work_item_id: "one", provider_version: "v1", status: "Planned", assignee_ids: ["lea-contributor"], fields: { outcome: "One", definition_of_done: "Checked", planned_effort: 0 } } },
    { record_id: "two", values: { work_item_id: "two", provider_version: "v1", status: "Ready for Sprint", assignee_ids: ["lea-contributor"], fields: {} } });
  const opened = await h.engine().openOperator({ workflowId: "weekday-digest", requestId: randomUUID(), principal: ENGINE_OPERATOR, fields: {}, params: { readiness: true } });
  let run = (await h.engine().advance(opened.runId))!;
  assert.equal(run.state.cursor, "approve-labels");
  assert.equal(requests.length, 0, "the provider is not touched before the human decision");
  assert.deepEqual(run.state.decisions["approve-labels"]!.bound, [
    { work_item_id: "one", expected_version: "v1", changes: { status: "Ready for Sprint" } },
    { work_item_id: "two", expected_version: "v1", changes: { status: "Planned" } },
  ]);
  run = await approveParity(h, run);
  assert.equal(run.state.status, "done", JSON.stringify(run.state.blocked));
  assert.deepEqual(applied, { one: { status_col: "Ready for Sprint" }, two: { status_col: "Planned" } });
  assert.deepEqual(requests.slice(0, 2).map((request) => request.variables.ids), [["one"], ["two"]]);
  assert.equal(requests.filter((request) => String(request.query).includes("change_multiple_column_values")).length, 2);
  const count = requests.length; await h.engine().advance(run.runId);
  assert.equal(requests.length, count);
});
