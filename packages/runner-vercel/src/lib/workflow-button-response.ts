import { resolvedDecisionCard } from "./decision-cards.ts";

/** Persist authority before projecting it into a transport card. Redelivery can
 * retry the projection without treating an edit failure as a decision failure. */
export async function recordWorkflowButtonResponse(args: {
  decide: () => Promise<{ runId: string; decision: "approved" | "rejected" }>;
  replace: (card: ReturnType<typeof resolvedDecisionCard>) => Promise<unknown>;
}) {
  const recorded = await args.decide();
  try {
    await args.replace(resolvedDecisionCard(recorded.decision));
    return { ...recorded, presentation: "updated" as const };
  } catch (error) {
    return { ...recorded, presentation: "failed" as const, error };
  }
}
