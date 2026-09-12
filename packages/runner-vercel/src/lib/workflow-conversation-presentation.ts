import type { WorkflowRun } from "../../../state-store/workflow-engine.ts";

/** A model's assertion is never evidence that a review was delivered. */
export function collectionReviewDelivery(run: WorkflowRun | undefined, memberId: string, threadReference: string) {
  if (!run || run.state.blocked || run.state.status !== "waiting" || !run.state.cursor) return undefined;
  const decision = run.state.decisions[run.state.cursor];
  const receipt = decision?.deliveries[memberId] as Record<string, unknown> | undefined;
  if (decision?.status !== "pending" || receipt?.thread_reference !== threadReference || typeof receipt.message_id !== "string" || !receipt.message_id) return undefined;
  return { messageId: receipt.message_id, threadReference };
}

/** Only the maintained collection Tool's verified delivery result suppresses prose. */
export function hasDeliveredCollectionReview(results: readonly { toolName: string; output?: unknown }[]): boolean {
  return results.some((result) => {
    if (result.toolName !== "companyos_collect_facts" || !result.output || typeof result.output !== "object") return false;
    const output = result.output as Record<string, any>, receipt = output.reviewDelivery;
    return output.collected === true && output.authorized === false && !!receipt
      && typeof receipt.messageId === "string" && receipt.messageId.length > 0
      && typeof receipt.threadReference === "string" && receipt.threadReference.length > 0;
  });
}
