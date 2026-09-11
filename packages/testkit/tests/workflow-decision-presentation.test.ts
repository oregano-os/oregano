import { jsonDigest } from "../../runtime/canonical.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { engineArtifact, engineFixture, ENGINE_OPERATOR, ENGINE_OWNER } from "../workflow-engine-fixture.ts";
import { WorkflowConversationHost } from "../../runner-vercel/src/lib/workflow-conversations.ts";
import { WorkflowSlackTransport } from "../../connectors/slack/workflow-transport.ts";
import { renderWorkflowDecisionNotice, workflowDecisionId } from "../../runtime/workflow-engine/decision-notice.ts";
import { decisionCard } from "../../runner-vercel/src/lib/decision-cards.ts";
import { parseDecisionPresentation } from "../../capabilities/decision-presentation.ts";

test("Workspace decision templates and labels compile; unknown labels and future references fail", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "decision-presentation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(resolve(import.meta.dirname, "../fixtures/lindenhof-studio"), root, { recursive: true });
  const path = join(root, "workflows/weekday-digest.md");
  const original = readFileSync(path, "utf8");
  const edited = original;
  const marker = "    binds: $steps.readiness-view.updates";
  assert.ok(edited.includes(marker));
  const addition = `${marker}\n    message:\n      template: sprint-sop/readiness-decision.md\n      vars:\n        status: $config.work_items.ready_status\n    labels:\n      approve: Mark ready\n      reject: Keep unchanged`;
  writeFileSync(join(root, "agents/sprint/skills/sprint-sop/assets/readiness-decision.md"), "---\nformat: provider-markdown\n---\nReview the proposed change to {{status}}.\n");
  writeFileSync(path, edited.replace(marker, addition));
  const artifact = engineArtifact(undefined, root);
  const step = artifact.workflows!.find((w) => w.id === "weekday-digest")!.steps.find((s) => s.id === "approve-labels")!;
  assert.deepEqual(step.decision!.presentation!.labels, { approve: "Mark ready", reject: "Keep unchanged" });
  const h = engineFixture({ artifact }); h.now = "2030-01-09T16:30:00.000Z";
  h.planning.push({ record_id: "one", values: { work_item_id: "one", title: "A task", assignee_ids: ["lea-contributor"], status: "Planned", provider_version: "v1", fields: { outcome: "Outcome", definition_of_done: "Done", planned_effort: 1 } } });
  const opened = await h.engine().openOperator({ workflowId: "weekday-digest", requestId: "presentation", principal: ENGINE_OPERATOR, fields: {}, triggerVariant: 1 });
  const waiting = (await h.engine().advance(opened.runId))!;
  assert.equal(waiting.state.cursor, "approve-labels");
  const notice = h.calls.find((call) => call.input.decision)?.input;
  assert.ok(notice); assert.match(notice.content, /Review the proposed change to Ready for Sprint/);
  assert.equal(notice.decision.approve_label, "Mark ready");

  writeFileSync(path, edited.replace(marker, addition.replace("approve: Mark ready", "execute: Mark ready")));
  assert.throws(() => engineArtifact(undefined, root), /labels/);
  writeFileSync(path, edited.replace(marker, addition.replace("$config.work_items.ready_status", "$steps.apply-labels.results")));
  assert.throws(() => engineArtifact(undefined, root), /future|current|scalar|reference/);
});

test("historical notices retain their exact text contract; new controls bind the same complete payload", () => {
  const args = { runId: "run", workflowId: "flow", stepId: "review", role: "owner", expiresAt: "2030-01-01T00:00:00Z", bound: [{ item: "one" }], destinationBinding: "owner" };
  const old = renderWorkflowDecisionNotice(args) as any;
  assert.match(old.content, /APPROVE [a-f0-9]{64} or REJECT/); assert.equal(old.decision, undefined);
  const current = renderWorkflowDecisionNotice({ ...args, presentation: { explanation: "Review item one.", approve: "Accept", reject: "Decline" } }) as any;
  assert.match(current.content, /Review item one/); assert.match(current.content, /\[{"item":"one"}\]/);
  assert.equal(current.decision.request_id, workflowDecisionId("run", "review", (jsonDigest(args.bound))));
  assert.throws(() => parseDecisionPresentation({ ...current.decision, url: "https://example.test" }), /Invalid/);
});

test("shared cards retain full long explanations and encode only fixed decision actions", async () => {
  const { cardToBlockKit } = await import(new URL("../../runner-vercel/node_modules/@chat-adapter/slack/dist/index.js", import.meta.url).href);
  const content = "A".repeat(6500);
  const card = decisionCard({ title: "Review", content, value: "a".repeat(64), approve: { id: "companyos.workflow.approve", label: "Accept" }, reject: { id: "companyos.workflow.reject", label: "Decline" } });
  const blocks = cardToBlockKit(card);
  assert.equal(blocks.filter((b: any) => b.type === "section").map((b: any) => b.text.text).join(""), content);
  const actions = blocks.find((b: any) => b.type === "actions").elements;
  assert.deepEqual(actions.map((a: any) => a.action_id), ["companyos.workflow.approve", "companyos.workflow.reject"]);
  assert.ok(actions.every((a: any) => a.value === "a".repeat(64)));
});

for (const choice of ["approve", "reject"] as const) test(`verified Slack ${choice} uses the actual engine and rejects wrong message, account and person`, async () => {
  const h = engineFixture({ conversationForReceipt: async ({ destinationBinding, output }) => ({ surface: "slack", accountId: "T10001", channelId: destinationBinding.startsWith("direct") ? "D10001" : "C10001", threadId: `${(output as any).message_id.replace("message-", "")}.000001`, ...(destinationBinding.startsWith("direct") ? { subjectPrincipal: ENGINE_OWNER } : {}) }) });
  h.now = "2030-01-09T16:30:00.000Z";
  h.planning.push({ record_id: "one", values: { work_item_id: "one", title: "A task", assignee_ids: ["lea-contributor"], status: "Planned", provider_version: "v1", fields: { outcome: "Outcome", definition_of_done: "Done", planned_effort: 1 } } });
  const engine = h.engine();
  let run = await engine.openOperator({ workflowId: "weekday-digest", requestId: choice, principal: ENGINE_OPERATOR, fields: {}, triggerVariant: 1 });
  run = (await engine.advance(run.runId))!;
  assert.equal(run.state.cursor, "approve-labels", JSON.stringify(run.state));
  const decision = run.state.decisions["approve-labels"]!;
  const root = `${(decision.deliveries["jonas-owner"] as any).message_id.replace("message-", "")}.000001`;
  const scope: import("../../runner-vercel/src/lib/workflow-slack.ts").WorkflowSlackScope = async (operation) => operation(new WorkflowSlackTransport({ call: async (method, args) => method === "auth.test" ? { ok: true, team_id: "T10001" } : { ok: true, user: { id: args.user, team_id: "T10001", deleted: false, is_bot: false } } }));
  const host = new WorkflowConversationHost({ artifact: h.artifact, engine, store: h.store, control: h.control, roster: async () => h.roster, connectors: async () => [], slack: scope, enabledWorkflowIds: ["weekday-digest"], clock: () => h.now });
  const value = workflowDecisionId(run.runId, decision.stepId, decision.boundDigest), actionId = `companyos.workflow.${choice}`;
  const input = { actionId, value, threadId: `slack:D10001:${root}`, messageId: root, userId: "U10002", raw: { type: "block_actions", team: { id: "T10001" }, user: { id: "U10002" }, channel: { id: "D10001" }, message: { ts: root }, actions: [{ action_id: actionId, value, action_ts: "1894220000.000001" }] } };
  await assert.rejects(host.receiveAction({ ...input, messageId: "999.000001" }));
  await assert.rejects(host.receiveAction({ ...input, raw: { ...input.raw, team: { id: "T99999" } } }));
  await assert.rejects(host.receiveAction({ ...input, userId: "U10001", raw: { ...input.raw, user: { id: "U10001" } } }));
  assert.equal(h.calls.filter((c) => c.capability === "work-item.batch-update").length, 0);
  const wrongToken = "f".repeat(64);
  await assert.rejects(host.receiveAction({ ...input, value: wrongToken, raw: { ...input.raw, actions: [{ ...input.raw.actions[0], value: wrongToken }] } }));
  const result = await host.receiveAction(input);
  assert.deepEqual(await host.receiveAction(input), result);
  run = (await engine.advance(run.runId))!; assert.equal(run.state.status, "done");
  assert.equal(h.calls.filter((c) => c.capability === "work-item.batch-update").length, choice === "approve" ? 1 : 0);
  assert.deepEqual(await host.receiveAction(input), result);
});
