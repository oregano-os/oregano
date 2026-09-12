import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { engineArtifact, engineFixture, ENGINE_OPERATOR, ENGINE_OWNER } from "../workflow-engine-fixture.ts";
import { workflowDecisionId } from "../../runtime/workflow-engine/decision-notice.ts";
import { workflowReviewDecision } from "../../runtime/workflow-engine/review-dependency.ts";
import { sha256 } from "../../runtime/canonical.ts";

test("a failed dependent verification reports uncertainty in the approver conversation without repeating the successful write", async () => {
  const artifact = structuredClone(engineArtifact()); artifact.language = "en";
  const workflow = artifact.workflows!.find((entry) => entry.id === "friday-close")!;
  const write = workflow.steps.find((entry) => entry.id === "apply-rollover")!;
  const verify = structuredClone(workflow.steps.find((entry) => entry.id === "prepare-rollover")!);
  verify.id = "verify-result"; verify.next = ["end"];
  // The real restricted Tool requires provider versions; this synthetic write
  // receipt lacks them. The write succeeds, then verification refuses it.
  verify.input = { open_work_items: "$steps.apply-rollover.results", target_sprint_id: "$instance.next_sprint_id" };
  verify.requiredOutputPaths = []; write.next = [verify.id]; workflow.steps.push(verify);
  const { manifestHash: _, ...manifest } = workflow; workflow.manifestHash = sha256(manifest);
  const { artifactHash: __, ...content } = artifact;
  artifact.artifactHash = sha256({ ...content, provenance: { ...content.provenance, builtAt: undefined } });
  const h = engineFixture({ artifact });
  let run = await h.engine().openOperator({ workflowId: workflow.id, requestId: randomUUID(), principal: ENGINE_OPERATOR, fields: { sprint_id: "one", next_sprint_id: "two" } });
  await h.engine().advance(run.runId);
  for (const instant of ["2030-01-04T15:20:00.000Z", "2030-01-04T16:00:00.000Z"]) {
    h.now = instant; await h.engine().timers(); run = (await h.engine().advance(run.runId))!;
  }
  const decision = run.state.decisions["approve-rollover"]!;
  const receipt = decision.deliveries["jonas-owner"] as Record<string, string>;
  await h.engine().decide({ principal: ENGINE_OWNER, conversation: h.conversation("direct-jonas-owner", receipt), eventId: randomUUID(),
    requestId: workflowDecisionId(run.runId, decision.stepId, decision.boundDigest), decision: "approved" });
  run = (await h.engine().advance(run.runId))!;
  assert.equal(run.state.steps[write.id]!.status, "succeeded");
  assert.equal(run.state.blocked?.stepId, verify.id);
  assert.equal(workflowReviewDecision(workflow, verify, run.state), decision.stepId);
  for (let i = 0; i < 4; i++) run = (await h.engine().step(run.runId))!;
  assert.equal(run.state.reviewDelivery!.outputs.length, 1);
  const messages = h.calls.filter((call) => call.input.content?.startsWith("I couldn't confirm"));
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.input.thread_reference, receipt.thread_reference);
  assert.equal(messages[0]!.input.destination_binding, receipt.destination_binding);
  assert.match(messages[0]!.input.content, /don't submit them again/);
  assert.doesNotMatch(messages[0]!.input.content, /schema|provider_version|Tool|workflow:/);
  assert.equal(h.calls.filter((call) => call.capability === "work-item.batch-update").length, 1);
  assert.ok(run.state.blocked);

  const detached = { ...verify, input: { text: "unrelated" } };
  assert.equal(workflowReviewDecision(workflow, detached, run.state), undefined);
  const uncompleted = structuredClone(run.state); uncompleted.steps[write.id]!.status = "failed";
  assert.equal(workflowReviewDecision(workflow, verify, uncompleted), undefined);
  const rejected = structuredClone(run.state); rejected.decisions[decision.stepId]!.status = "rejected";
  assert.equal(workflowReviewDecision(workflow, verify, rejected), undefined);
  const ambiguous = structuredClone(workflow), second = structuredClone(ambiguous.steps.find((entry) => entry.id === write.id)!);
  second.id = "other-write"; second.requiresDecisions = [{ stepId: "other-approval", payloadPath: ["updates"] }]; ambiguous.steps.push(second);
  const state = structuredClone(run.state); state.steps[second.id] = structuredClone(state.steps[write.id]!);
  assert.equal(workflowReviewDecision(ambiguous, { ...verify, input: [verify.input!, "$steps.other-write"] }, state), undefined);
});
