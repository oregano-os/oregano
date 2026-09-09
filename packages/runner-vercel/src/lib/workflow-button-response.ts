import { feedbackDecisionCard, resolvedDecisionCard } from "./decision-cards.ts";

/** The engine calls onValidated only after exact current decision authorization.
 * Processing is transient; only durable acceptance may show a success notice. */
export async function recordWorkflowButtonResponse(args: {
  decide: (onValidated: (language?: string) => Promise<void>) => Promise<{ runId: string; decision: "approved" | "rejected" }>;
  replace: (card: ReturnType<typeof resolvedDecisionCard>) => Promise<unknown>;
  continueRun?: (runId: string) => Promise<unknown>;
  language?: string;
  observe?: (phase: "validated" | "processing" | "recorded" | "resolved", elapsedMs: number) => void;
}) {
  const start = performance.now();
  let language = args.language, processingShown = false;
  const mark = (phase: "validated" | "processing" | "recorded" | "resolved") => { try { args.observe?.(phase, Math.round(performance.now() - start)); } catch { /* Telemetry is not authority. */ } };
  let recorded;
  try {
    recorded = await args.decide(async (historicalLanguage) => {
      language = historicalLanguage ?? args.language;
      mark("validated");
      try { await args.replace(feedbackDecisionCard("processing", language)); processingShown = true; }
      catch { /* A presentation failure must not prevent the user's decision. */ }
      mark("processing");
    });
  } catch (error) {
    if (processingShown) await args.replace(feedbackDecisionCard("uncertain", language)).catch(() => undefined);
    throw error;
  }
  mark("recorded");
  let presentation: "updated" | "failed" = "updated", error: unknown;
  try {
    await args.replace(resolvedDecisionCard(recorded.decision, language));
    mark("resolved");
  } catch (failure) { presentation = "failed"; error = failure; }
  try {
    if (args.continueRun) await args.continueRun(recorded.runId);
    return { ...recorded, presentation, error, continuation: args.continueRun ? "attempted" as const : "not-requested" as const };
  } catch (continuationError) {
    // The persisted cursor remains available to the maintained steps worker.
    if (recorded.decision === "approved") {
      try { await args.replace(feedbackDecisionCard("continuation", language)); presentation = "updated"; error = undefined; }
      catch (failure) { presentation = "failed"; error = failure; }
    }
    return { ...recorded, presentation, error, continuation: "failed" as const, continuationError };
  }
}
