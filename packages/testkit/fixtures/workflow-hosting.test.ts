import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { engineFixture, ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";
import { WorkflowWorkers } from "../../runtime/workflow-engine/workers.ts";
import { authenticateWorkflowOperator, authenticateWorkflowScheduler, decodeWorkflowHostingConfiguration, workflowHostingEnabled, WORKFLOW_CONFIGURATION_ENV, type WorkflowHostingConfiguration } from "../../runner-vercel/src/lib/workflow-configuration.ts";

const fixture = () => {
  const h = engineFixture();
  h.artifact.instance.environment = "preview";
  const value: WorkflowHostingConfiguration = { version: 1, instanceId: h.artifact.instance.id, artifactHash: h.artifact.artifactHash, environment: "preview",
    enabledWorkflowIds: h.artifact.workflows!.map((w) => w.id), autoOpenWorkflowIds: ["weekday-digest", "board-hygiene"], schedulePrincipal: ENGINE_OPERATOR,
    activatedAt: "2030-01-01T00:00:00.000Z", maxLatenessMinutes: 60, operators: [{ principal: ENGINE_OPERATOR, secretRef: "env:TEST_OPERATOR_SECRET" }] };
  const environment = { VERCEL_ENV: "preview", COMPANYOS_WORKFLOW_ENABLED: "true", TEST_OPERATOR_SECRET: "a".repeat(48), CRON_SECRET: "b".repeat(48),
    [WORKFLOW_CONFIGURATION_ENV]: gzipSync(JSON.stringify(value)).toString("base64") };
  return { ...h, value, environment };
};

test("workflow activation is explicit and configuration pins exact Artifact and deployment identity", () => {
  assert.equal(workflowHostingEnabled({}), false);
  assert.throws(() => workflowHostingEnabled({ COMPANYOS_WORKFLOW_ENABLED: "yes" }), /true or false/);
  const h = fixture(); assert.deepEqual(decodeWorkflowHostingConfiguration(h.artifact, h.environment), h.value);
  const change = (value: unknown) => ({ ...h.environment, [WORKFLOW_CONFIGURATION_ENV]: gzipSync(JSON.stringify(value)).toString("base64") });
  for (const patch of [{ instanceId: "another-instance" }, { artifactHash: "f".repeat(64) }, { environment: "production" }, { unknown: true }, { enabledWorkflowIds: ["absent"] }, { autoOpenWorkflowIds: ["friday-close"] }]) {
    assert.throws(() => decodeWorkflowHostingConfiguration(h.artifact, change({ ...h.value, ...patch })));
  }
  assert.throws(() => decodeWorkflowHostingConfiguration(h.artifact, { ...h.environment, VERCEL_ENV: "production" }), /deployed/);
  assert.throws(() => decodeWorkflowHostingConfiguration(h.artifact, { ...h.environment, CRON_SECRET: h.environment.TEST_OPERATOR_SECRET }), /distinct/);
  const recordSync = { intervalMinutes: 5, targets: [{ artifactHash: h.artifact.artifactHash, sourceIds: ["fixture-source"] }] };
  assert.deepEqual(decodeWorkflowHostingConfiguration(h.artifact, change({ ...h.value, recordSync })).recordSync, recordSync);
  assert.throws(() => decodeWorkflowHostingConfiguration(h.artifact, change({ ...h.value, recordSync: { ...recordSync, intervalMinutes: 0 } })), /polling interval/);
});

test("operator credentials select one configured human; a caller cannot supply another principal", () => {
  const h = fixture(), config = decodeWorkflowHostingConfiguration(h.artifact, h.environment);
  const request = (token: string) => new Request("https://example.test/api/workflows/operator", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(authenticateWorkflowOperator(request(h.environment.TEST_OPERATOR_SECRET), config, h.environment), ENGINE_OPERATOR);
  assert.equal(authenticateWorkflowOperator(request(h.environment.CRON_SECRET), config, h.environment), undefined);
  assert.equal(authenticateWorkflowScheduler(request(h.environment.TEST_OPERATOR_SECRET), h.environment), false);
  assert.equal(authenticateWorkflowScheduler(request(h.environment.CRON_SECRET), h.environment), true);
  config.operators.push({ principal: "slack:T10001:U10002", secretRef: "env:SECOND_SECRET" });
  assert.equal(authenticateWorkflowOperator(request(h.environment.TEST_OPERATOR_SECRET), config, { ...h.environment, SECOND_SECRET: h.environment.TEST_OPERATOR_SECRET }), undefined);
});

test("bounded hosted step workers execute actual workflows and duplicate ticks do not publish twice", async () => {
  const h = engineFixture(), config = { enabledWorkflowIds: h.artifact.workflows!.map((w) => w.id), autoOpenWorkflowIds: [], schedulePrincipal: ENGINE_OPERATOR, activatedAt: h.now, maxLatenessMinutes: 60 };
  const worker = () => new WorkflowWorkers({ engine: h.engine(), artifact: h.artifact, store: h.store, timers: h.timers, configuration: config, clock: () => h.now });
  const run = await h.engine().openOperator({ workflowId: "monday-handoff", requestId: randomUUID(), principal: ENGINE_OPERATOR, fields: { period_start: "2030-01-07", period_end: "2030-01-11" } });
  const first = await worker().run("steps"); assert.equal(first.ok, true, JSON.stringify(first)); assert.ok(first.processed > 0);
  assert.equal((await h.store.read(run.instanceId, run.runId))!.state.status, "done");
  await worker().run("steps"); assert.equal(h.calls.filter((c) => c.capability === "communication.message.publish").length, 1);
});

test("hosted timer workers restore waiting execution and keep the original report cutoff", async () => {
  const h = engineFixture(), config = { enabledWorkflowIds: ["friday-close"], autoOpenWorkflowIds: [], schedulePrincipal: ENGINE_OPERATOR, activatedAt: h.now, maxLatenessMinutes: 60 };
  const worker = () => new WorkflowWorkers({ engine: h.engine(), artifact: h.artifact, store: h.store, timers: h.timers, configuration: config, clock: () => h.now });
  const opened = await h.engine().openOperator({ workflowId: "friday-close", requestId: randomUUID(), principal: ENGINE_OPERATOR, fields: { sprint_id: "period-one", next_sprint_id: "period-two" } });
  await worker().run("steps"); h.now = "2030-01-04T15:23:00.000Z";
  const fired = await worker().run("timers"); assert.equal(fired.ok, true, JSON.stringify(fired));
  await worker().run("steps");
  const run = (await h.store.read(opened.instanceId, opened.runId))!;
  assert.equal(run.state.cursor, "await-report", JSON.stringify(run.state));
  assert.equal((run.state.steps["await-chase"]!.output as any).instant, "2030-01-04T15:20:00.000Z");
});

test("operator parser excludes approval impersonation, hidden schedule parameters and unbounded fields", async () => {
  const { parseWorkflowOperatorRequest } = await import("../../runner-vercel/src/lib/workflow-http.ts");
  assert.deepEqual(parseWorkflowOperatorRequest({ action: "open", workflowId: "monday-handoff", requestId: "test-request", fields: { period_start: "2030-01-07" } }),
    { action: "open", workflowId: "monday-handoff", requestId: "test-request", fields: { period_start: "2030-01-07" } });
  for (const value of [
    { action: "decide", principal: ENGINE_OPERATOR, decision: "approved" },
    { action: "open", workflowId: "monday-handoff", requestId: "test", fields: {}, principal: ENGINE_OPERATOR },
    { action: "schedule", workflowId: "weekday-digest", instant: "2030-01-07T08:00:00.000Z", fields: {}, params: { readiness: true } },
    { action: "receive-reply", threadId: "slack:D10001:100.001", messageId: "100.002", text: "APPROVE" },
  ]) assert.throws(() => parseWorkflowOperatorRequest(value));
});

test("Slack qualification checks actual account, current human and exact DM root; publication rechecks the same credential scope", async () => {
  const { WorkflowSlackTransport } = await import("../../connectors/slack/workflow-transport.ts");
  const { qualifyWorkflowMessageInputs, qualifyWorkflowSlackConnector } = await import("../../runner-vercel/src/lib/workflow-slack.ts");
  const h = engineFixture(), artifact = structuredClone(h.artifact);
  artifact.bindings = artifact.bindings.map((b) => b.capability === "communication.message.publish" ? { ...b, connector: "oregano/slack-communication", connectorVersion: "0.1.0" } : b);
  artifact.connectors = [{ id: "slack", connector: "oregano/slack-communication", connectorVersion: "0.1.0", configuration: { destinations: [
    { id: "direct-jonas-owner", account_id: "T10001", kind: "direct-message", user_id: "U10002" },
    { id: "team-channel", account_id: "T10001", kind: "channel", channel_id: "C10001" },
  ] } }];
  let account = "T10001", recipient = "U10002", scopeActive = false, published = 0;
  const api = { call: async (method: string, args: Record<string, string>) => {
    assert.equal(scopeActive, true);
    if (method === "auth.test") return { ok: true, team_id: account };
    if (method === "users.info") return { ok: true, user: { id: args.user, team_id: account, deleted: false, is_bot: false } };
    return { ok: true, channel: { id: args.channel, is_im: args.channel!.startsWith("D"), user: recipient, is_archived: false } };
  } };
  const scope: import("../../runner-vercel/src/lib/workflow-slack.ts").WorkflowSlackScope = async (operation) => {
    scopeActive = true; try { return await operation(new WorkflowSlackTransport(api)); } finally { scopeActive = false; }
  };
  const input = { destination_binding: "direct-jonas-owner", content: "Exact bound review" };
  await qualifyWorkflowMessageInputs({ scope, artifact, inputs: [input], roster: async () => h.roster });
  const wrapped = qualifyWorkflowSlackConnector({ artifact, scope, roster: async () => h.roster,
    connector: { id: "oregano/slack-communication", version: "0.1.0", capabilities: ["communication.message.publish"], invoke: async () => {
      assert.equal(scopeActive, true); published++; return { output: {}, evidence: {} };
    } } });
  const context = { instanceId: artifact.instance.id, runId: "test", stepId: "message", agentId: "sprint", toolId: "publish", idempotencyKey: "test" };
  account = "T20002";
  await assert.rejects(wrapped.invoke("communication.message.publish", input, context), /account differs/); assert.equal(published, 0);
  account = "T10001"; await wrapped.invoke("communication.message.publish", input, context); assert.equal(published, 1);
  const receipt = { destination_binding: "direct-jonas-owner", thread_reference: "slack:D10001:100.001" };
  const conversation = await scope((transport) => transport.conversation(artifact, "direct-jonas-owner", receipt, h.roster));
  assert.deepEqual(conversation, { surface: "slack", accountId: "T10001", channelId: "D10001", threadId: "100.001", subjectPrincipal: "slack:T10001:U10002" });
  recipient = "U10003"; await assert.rejects(scope((t) => t.conversation(artifact, "direct-jonas-owner", receipt, h.roster)), /exact recipient/);
  await assert.rejects(scope((t) => t.conversation(artifact, "direct-jonas-owner", { ...receipt, thread_reference: "slack:D10001:" }, h.roster)), /exact qualified/);
});

test("provider reply proof rejects edited, ambiguous, foreign and bot responses instead of trusting submitted text", async () => {
  const { WorkflowSlackTransport } = await import("../../connectors/slack/workflow-transport.ts");
  const h = engineFixture();
  let message: Record<string, unknown> = { type: "message", user: "U10002", ts: "100.002", thread_ts: "100.001", text: `APPROVE ${"a".repeat(64)}` }, more = false;
  const transport = new WorkflowSlackTransport({ call: async (method) => {
    if (method === "auth.test") return { ok: true, team_id: "T10001" };
    if (method === "users.info") return { ok: true, user: { id: "U10002", team_id: "T10001", deleted: false, is_bot: false } };
    return { ok: true, messages: [message], has_more: more };
  } });
  const input = { conversation: { surface: "slack", accountId: "T10001", channelId: "D10001", threadId: "100.001", subjectPrincipal: "slack:T10001:U10002" }, messageId: "100.002", roster: h.roster };
  assert.equal((await transport.reply(input)).principal, "slack:T10001:U10002");
  const original = { ...message };
  for (const patch of [{ edited: { ts: "100.003" } }, { bot_id: "B10001" }, { thread_ts: "100.000" }, { user: "U10001" }]) {
    message = { ...original, ...patch }; await assert.rejects(transport.reply(input));
  }
  message = original; more = true; await assert.rejects(transport.reply(input), /completely/);
  more = false; await assert.rejects(transport.reply({ ...input, conversation: { ...input.conversation, accountId: "T20002" } }), /identity/);
});

test("hosted reply routing uses actual persisted execution and the historical Artifact, with one human decision before one batch", async () => {
  const { WorkflowConversationHost } = await import("../../runner-vercel/src/lib/workflow-conversations.ts");
  const { WorkflowSlackTransport } = await import("../../connectors/slack/workflow-transport.ts");
  const { workflowDecisionId } = await import("../../runtime/workflow-engine/decision-notice.ts");
  const { ENGINE_OWNER } = await import("../workflow-engine-fixture.ts");
  // Provider identity is synthetic, but every cursor, receipt and assignment is
  // produced by the actual engine executing the compiled Friday graph.
  const h = engineFixture({ conversationForReceipt: async ({ destinationBinding, output }) => ({ surface: "slack", accountId: "T10001",
    channelId: destinationBinding.startsWith("direct") ? "D10001" : "C10001", threadId: `${(output as any).message_id.replace("message-", "")}.000001`,
    ...(destinationBinding.startsWith("direct") ? { subjectPrincipal: ENGINE_OWNER } : {}) }) });
  let run = await h.engine().openOperator({ workflowId: "friday-close", requestId: randomUUID(), principal: ENGINE_OPERATOR, fields: { sprint_id: "period-1", next_sprint_id: "period-2" } });
  run = (await h.engine().advance(run.runId))!;
  h.now = "2030-01-04T15:20:00.000Z"; await h.engine().timers(); run = (await h.engine().advance(run.runId))!;
  h.now = "2030-01-04T16:00:00.000Z"; await h.engine().timers(); run = (await h.engine().advance(run.runId))!;
  assert.equal(run.state.cursor, "approve-rollover", JSON.stringify(run.state));
  const decision = run.state.decisions[run.state.cursor!]!, root = `${(decision.deliveries["jonas-owner"] as any).message_id.replace("message-", "")}.000001`;
  let text = "Please explain this review.", user = "U10002";
  const scope: import("../../runner-vercel/src/lib/workflow-slack.ts").WorkflowSlackScope = async (operation) => operation(new WorkflowSlackTransport({ call: async (method, args) => {
    if (method === "auth.test") return { ok: true, team_id: "T10001" };
    if (method === "users.info") return { ok: true, user: { id: args.user, team_id: "T10001", deleted: false, is_bot: false } };
    return { ok: true, messages: [{ type: "message", ts: "999.000002", thread_ts: root, user, text }], has_more: false };
  } }));
  const latest = structuredClone(h.artifact); latest.agents[0]!.instructions = "Changed after opening";
  const host = new WorkflowConversationHost({ artifact: latest, engine: h.engine(), store: h.store, control: h.control, roster: async () => h.roster,
    connectors: async () => [], slack: scope, enabledWorkflowIds: ["friday-close"], clock: () => h.now });
  const input = { threadId: `slack:D10001:${root}`, messageId: "999.000002", authorId: "U10002" };
  const session = await host.receive(input); assert.equal(session.kind, "conversation");
  if (session.kind !== "conversation") throw new Error("Missing conversation session");
  assert.deepEqual(session.session.artifact, h.artifact); assert.deepEqual(session.session.allowedTools, []);
  assert.equal(h.calls.filter((call) => call.capability === "work-item.batch-update").length, 0);
  text = `APPROVE ${workflowDecisionId(run.runId, decision.stepId, decision.boundDigest)}`;
  user = "U10001"; await assert.rejects(host.receive(input), /another private recipient/);
  user = "U10002";
  const accepted = await host.receive(input); assert.equal(accepted.kind, "decision");
  assert.deepEqual(await host.receive(input), accepted);
  run = (await h.engine().advance(run.runId))!; assert.equal(run.state.status, "done");
  assert.equal(h.calls.filter((call) => call.capability === "work-item.batch-update").length, 1);
  assert.deepEqual(await host.receive(input), accepted);
});

test("automatic schedule ticks retain exact occurrences and parameters across repeated minute windows", async (t) => {
  const { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
  const { join, resolve } = await import("node:path"); const { tmpdir } = await import("node:os");
  const { engineArtifact } = await import("../workflow-engine-fixture.ts");
  const root = mkdtempSync(join(tmpdir(), "workflow-host-schedule-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(resolve(import.meta.dirname, "./lindenhof-studio"), root, { recursive: true });
  const path = join(root, "schedules/sprint-rhythm.yaml"); writeFileSync(path, readFileSync(path, "utf8").replace("activation: blocked", "activation: active"));
  const h = engineFixture({ artifact: engineArtifact(undefined, root) }); h.now = "2030-01-09T16:35:00.000Z";
  const configuration = { enabledWorkflowIds: ["weekday-digest"], autoOpenWorkflowIds: ["weekday-digest"], schedulePrincipal: ENGINE_OPERATOR, activatedAt: "2030-01-09T16:00:00.000Z", maxLatenessMinutes: 60 };
  const worker = () => new WorkflowWorkers({ artifact: h.artifact, engine: h.engine(), store: h.store, timers: h.timers, configuration, clock: () => h.now });
  assert.equal((await worker().run("timers")).ok, true);
  h.now = "2030-01-09T16:35:30.000Z"; assert.equal((await worker().run("timers")).ok, true);
  h.now = "2030-01-09T16:36:00.000Z"; assert.equal((await worker().run("timers")).ok, true);
  const runs = await h.store.list({ instanceId: h.artifact.instance.id, limit: 200 });
  assert.equal(runs.length, 1); assert.equal(runs[0]!.trigger.instant, "2030-01-09T16:30:00.000Z"); assert.equal(runs[0]!.trigger.params.readiness, true);
});

test("repair pagination survives a new worker beyond the first 200 actual executions", async () => {
  const h = engineFixture();
  for (let index = 0; index < 201; index++) await h.engine().openOperator({ workflowId: "monday-handoff", requestId: `page-${index}`, principal: ENGINE_OPERATOR,
    fields: { period_start: "2030-01-07", period_end: "2030-01-11" } });
  const cursors: Array<string | undefined> = [], list = h.store.list.bind(h.store);
  h.store.list = async (args) => { if (args.activeOnly) cursors.push(args.afterRunId); return list(args); };
  const configuration = { enabledWorkflowIds: ["monday-handoff"], autoOpenWorkflowIds: [], schedulePrincipal: ENGINE_OPERATOR, activatedAt: h.now, maxLatenessMinutes: 60 };
  const worker = () => new WorkflowWorkers({ artifact: h.artifact, engine: h.engine(), store: h.store, timers: h.timers, configuration, clock: () => h.now });
  const first = await worker().run("timers"); assert.equal(first.ok, true); assert.equal(first.continued, true);
  const next = await worker().run("timers"); assert.equal(next.ok, true); assert.equal(next.continued, false);
  assert.equal(cursors.length, 2); assert.equal(cursors[0], undefined); assert.match(cursors[1]!, /^workflow:/);
  assert.equal(h.calls.length, 0);
});
