import { randomUUID } from "node:crypto";
import type { Connector } from "../../capabilities/contracts.ts";
import { engineFixture, ENGINE_OPERATOR, ENGINE_OWNER } from "../workflow-engine-fixture.ts";
import { workflowDecisionId } from "../../runtime/workflow-engine/decision-notice.ts";

const batch: Connector = { id: "test/verified-batch", version: "1.0.0", capabilities: ["work-item.batch-update"],
  async invoke(_capability, input) {
    const updates = (input as any).updates;
    return { output: { complete: true, results: updates.map((update: any) => ({ work_item_id: update.work_item_id,
      previous_version: update.expected_version, provider_version: "synthetic-v2", changed_fields: Object.keys(update.changes) })) },
      evidence: { synthetic: true, receipt: "fixture-batch-receipt" } };
  } };

export async function completedVerificationFixture(options: Parameters<typeof engineFixture>[0] = {}) {
  const h = engineFixture({ ...options, batchConnector: batch });
  let run = await h.engine().openOperator({ workflowId: "friday-close", requestId: randomUUID(), principal: ENGINE_OPERATOR,
    fields: { sprint_id: "verification-one", next_sprint_id: "verification-two" } });
  await h.engine().advance(run.runId);
  for (const instant of ["2030-01-04T15:20:00.000Z", "2030-01-04T16:00:00.000Z"]) {
    h.now = instant; await h.engine().timers(); run = (await h.engine().advance(run.runId))!;
  }
  const decision = run.state.decisions["approve-rollover"]!;
  await h.engine().decide({ principal: ENGINE_OWNER, conversation: h.conversation("direct-jonas-owner", decision.deliveries["jonas-owner"]!),
    eventId: randomUUID(), requestId: workflowDecisionId(run.runId, decision.stepId, decision.boundDigest), decision: "approved" });
  run = (await h.engine().advance(run.runId))!;
  return { h, run };
}
