import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { parseMondayBoardWebhook, verifyMondayBoardWebhookToken, workflowEventFromMondayBoardEvent } from "../../connectors/monday/board-webhook.ts";
import { InMemoryMondayReplayStore } from "../../connectors/monday/webhook.ts";
import { handleMondayBoardWebhook, selectMondayEventWorkflows } from "../../runner-vercel/src/lib/monday-board-webhook.ts";
import type { WorkflowTriggerEvent } from "../../state-store/workflow-engine.ts";
import { sha256 } from "../../runtime/canonical.ts";
import { engineArtifact, engineFixture, ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";

const SECRET = "board-webhook-secret-0123456789abcdef0123";
const NOW = Date.parse("2030-01-04T09:10:00.000Z");
const created = {
  event: { userId: 9603417, originalTriggerUuid: null, boardId: 1771812698, pulseId: 1772099344, pulseName: "Fictional card", groupId: "topics", groupName: "Backlog",
    groupColor: "#579bfc", isTopGroup: true, columnValues: {}, app: "monday", type: "create_pulse", triggerTime: "2030-01-04T09:07:28.210Z", subscriptionId: 73759690, triggerUuid: "b5ed2e17c530f43668de130142445cba" },
};

/** The fictional fixture with one active Monday event source, a Monday connector binding and one event workflow. */
function boardFixture() {
  const root = mkdtempSync(join(tmpdir(), "monday-board-fixture-"));
  cpSync(resolve(import.meta.dirname, "../fixtures/lindenhof-studio"), root, { recursive: true });
  mkdirSync(join(root, "events"), { recursive: true });
  writeFileSync(join(root, "events/sprint-board.yaml"), YAML.stringify({ schema_version: 1, id: "sprint-board-events", activation: "active", provider: "monday", resource_binding: "sprint-board",
    triggers: [{ id: "sprint-card-changed", events: ["item-created", "item-moved"] }] }));
  writeFileSync(join(root, "workflows/card-intake.md"), `---
type: workflow
id: card-intake
version: 1
owner: agents/sprint
execution_mode: unattended
trigger: event:sprint-card-changed
config: workflows/sprint/config.yaml
steps:
  - card-records: oregano:records/query
    input:
      projection_id: $config.work_items.projection
      filters:
        work_item_ids: [$trigger.event.work_item_id]
    all_pages: true
    require_scan_started_after: $trigger.instant
    then: end
---
# Card intake

1. [sprint, R0] Read the changed card from a complete current scan. <!-- step:card-records -->
`);
  const artifact = structuredClone(engineArtifact(undefined, root));
  rmSync(root, { recursive: true, force: true });
  artifact.connectors = [{ id: "monday", connector: "oregano/monday-work-items", connectorVersion: "0.1.0", configuration: { token_ref: "env:MONDAY_API_TOKEN", api_version: "dev", actor_id: "115144288",
    credential_identity: { account_id: "1", member_id: "115144288", external_agent_id: "1", kind: "external_agent_member" },
    resources: [{ id: "sprint-board", board_id: "1771812698", permission: "read-write", fields: {} }, { id: "roles-board", board_id: "5740819791", permission: "read", fields: {} }] } }];
  const { artifactHash, ...content } = artifact;
  artifact.artifactHash = sha256({ ...content, provenance: { ...content.provenance, builtAt: undefined } });
  const h = engineFixture({ artifact });
  h.now = "2030-01-04T09:10:00.000Z";
  const calls: Array<{ workflowId: string; principal: string; event: WorkflowTriggerEvent; instant: string }> = [];
  const dependencies = { artifact, eventOpenWorkflowIds: ["card-intake"], schedulePrincipal: ENGINE_OPERATOR, secret: SECRET, replayStore: new InMemoryMondayReplayStore(), now: () => NOW,
    openEvent: async (args: { workflowId: string; principal: string; event: WorkflowTriggerEvent; instant: string }) => { calls.push(structuredClone(args)); return h.engine().openEvent(args); } };
  return { h, artifact, dependencies, calls };
}
const request = (body: unknown, args: { token?: string; method?: string } = {}) => new Request(`https://company.example/api/webhooks/monday-board?token=${args.token ?? SECRET}`,
  { method: args.method ?? "POST", headers: { "content-type": "application/json" }, ...(args.method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });

test("board webhook parsing normalizes supported provider events and ignores everything else explicitly", () => {
  const parsed = parseMondayBoardWebhook(JSON.stringify(created));
  assert.deepEqual(parsed, { event: { kind: "item-created", eventId: "b5ed2e17c530f43668de130142445cba", boardId: "1771812698", workItemId: "1772099344", groupId: "topics",
    actorId: "9603417", occurredAt: "2030-01-04T09:07:28.210Z", providerType: "create_pulse", subscriptionId: "73759690" } });
  const moved = parseMondayBoardWebhook(JSON.stringify({ event: { ...created.event, type: "move_pulse_into_group", groupId: "topics", destGroupId: "planned", triggerUuid: "5c28578c66653a87b00a80aa4f7a6ce3" } }));
  assert.equal("event" in moved && moved.event.kind, "item-moved");
  assert.equal("event" in moved && moved.event.groupId, "planned");
  assert.deepEqual(parseMondayBoardWebhook(JSON.stringify({ challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" })), { challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" });
  assert.deepEqual(parseMondayBoardWebhook(JSON.stringify({ event: { ...created.event, type: "update_column_value" } })), { ignored: "unsupported-event:update_column_value" });
  assert.deepEqual(parseMondayBoardWebhook(JSON.stringify({ event: { ...created.event, parentItemId: "1771812716" } })), { ignored: "subitem-event" });
  assert.throws(() => parseMondayBoardWebhook("not json"), /valid JSON/);
  assert.throws(() => parseMondayBoardWebhook(JSON.stringify({ event: { ...created.event, triggerUuid: "../x" } })), /triggerUuid/);
  assert.throws(() => parseMondayBoardWebhook(JSON.stringify({ event: { ...created.event, pulseId: undefined } })), /pulseId/);
  assert.throws(() => parseMondayBoardWebhook(JSON.stringify({ event: { ...created.event, triggerTime: "later" } })), /triggerTime/);
  assert.equal(verifyMondayBoardWebhookToken(`https://company.example/hook?token=${SECRET}`, SECRET), true);
  assert.equal(verifyMondayBoardWebhookToken(`https://company.example/hook?token=${SECRET}x`, SECRET), false);
  assert.equal(verifyMondayBoardWebhookToken("https://company.example/hook", SECRET), false);
  assert.equal(verifyMondayBoardWebhookToken(`https://company.example/hook?token=short`, "short"), false);
  assert.deepEqual(workflowEventFromMondayBoardEvent((parsed as { event: any }).event, "sprint-board"), { kind: "item-created", event_id: "b5ed2e17c530f43668de130142445cba",
    resource_binding: "sprint-board", work_item_id: "1772099344", group_id: "topics", actor_id: "9603417", occurred_at: "2030-01-04T09:07:28.210Z" });
});

test("a verified board event opens the declared workflow once; redeliveries and self-authored changes never open twice", async () => {
  const { h, dependencies, calls } = boardFixture();
  const first = await handleMondayBoardWebhook(request(created), dependencies);
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.accepted, true); assert.equal(body.redelivered, false); assert.equal(body.opened.length, 1); assert.equal(body.opened[0].workflowId, "card-intake");
  assert.deepEqual(calls[0], { workflowId: "card-intake", principal: ENGINE_OPERATOR, instant: "2030-01-04T09:07:28.210Z",
    event: { kind: "item-created", event_id: "b5ed2e17c530f43668de130142445cba", resource_binding: "sprint-board", work_item_id: "1772099344", group_id: "topics", actor_id: "9603417", occurred_at: "2030-01-04T09:07:28.210Z" } });
  const again = await (await handleMondayBoardWebhook(request(created), dependencies)).json();
  assert.equal(again.accepted, true); assert.equal(again.redelivered, true); assert.equal(again.opened[0].runId, body.opened[0].runId);
  assert.equal((await h.store.list({ instanceId: h.artifact.instance.id, limit: 20 })).length, 1);
  const self = await (await handleMondayBoardWebhook(request({ event: { ...created.event, userId: 115144288, triggerUuid: "self0000000000000000000000000001" } }), dependencies)).json();
  assert.deepEqual(self, { ok: true, accepted: false, reason: "self-authored" });
  const unbound = await (await handleMondayBoardWebhook(request({ event: { ...created.event, boardId: 999, triggerUuid: "other000000000000000000000000001" } }), dependencies)).json();
  assert.deepEqual(unbound, { ok: true, accepted: false, reason: "unbound-board" });
  const roles = await (await handleMondayBoardWebhook(request({ event: { ...created.event, boardId: 5740819791, triggerUuid: "roles000000000000000000000000001" } }), dependencies)).json();
  assert.deepEqual(roles, { ok: true, accepted: false, reason: "no-active-event-workflow" });
  assert.equal(calls.length, 2, "only the real event and its redelivery reached the engine");
});

test("board webhook ingress fails closed without the Instance credential, hosting opt-in or an active source", async () => {
  const { artifact, dependencies } = boardFixture();
  assert.equal((await handleMondayBoardWebhook(request(created, { token: "wrong" }), dependencies)).status, 401);
  assert.equal((await handleMondayBoardWebhook(request(created, { method: "GET" }), dependencies)).status, 405);
  assert.equal((await handleMondayBoardWebhook(request(created), { ...dependencies, secret: "short" })).status, 401);
  assert.equal((await handleMondayBoardWebhook(request("{"), dependencies)).status, 400);
  assert.deepEqual(await (await handleMondayBoardWebhook(request({ challenge: "abc123" }), dependencies)).json(), { challenge: "abc123" });
  assert.deepEqual(await (await handleMondayBoardWebhook(request(created), { ...dependencies, eventOpenWorkflowIds: [] })).json(), { ok: true, accepted: false, reason: "no-active-event-workflow" });
  const blocked = structuredClone(artifact);
  blocked.workflows!.find((workflow) => workflow.id === "card-intake")!.events![0]!.declaration.activation = "blocked";
  assert.deepEqual(selectMondayEventWorkflows(blocked, ["card-intake"], "sprint-board", (parseMondayBoardWebhook(JSON.stringify(created)) as { event: any }).event), []);
  const failing = await handleMondayBoardWebhook(request(created), { ...dependencies, openEvent: async () => { throw new Error("Synthetic engine outage"); } });
  assert.equal(failing.status, 503);
  assert.equal((await failing.json()).error, "event-opening-failed");
  const retried = await (await handleMondayBoardWebhook(request(created), dependencies)).json();
  assert.equal(retried.accepted, true); assert.equal(retried.redelivered, false, "a failed delivery leaves no replay claim behind");
});
