import type { BuilderJob } from "../../state-store/builder-jobs.ts";
import { checkedBuilderProposal, builderTestSessionId, type BuilderFunctionalTests } from "./functional-tests.ts";
import { builderDecisionKey, type BuilderExperienceStore } from "./experience.ts";

/** Caller holds the same build lock as publication and test execution. */
export async function discardBuilder(args: {
  job: BuilderJob; actor: string; state: BuilderExperienceStore; tests: BuilderFunctionalTests;
  closeProposal(job: BuilderJob): Promise<unknown>;
}) {
  const { job, actor, state, tests } = args;
  if (job.requesterPrincipal !== actor || job.state !== "published") throw new Error("Only the requester can discard a completed unpublished build.");
  checkedBuilderProposal(job);
  const key = builderDecisionKey(job.jobId), decision = await state.get<{ kind: string }>(key);
  if (decision?.kind === "discarded") return;
  if (decision && !["revision", "discarding"].includes(decision.kind)) throw new Error("Publication already started.");
  const session = await tests.store.get(builderTestSessionId(job));
  if (session?.stage === "accepted") throw new Error("This result was already accepted for publication.");
  // Keep publication unavailable if provider closure has an uncertain outcome.
  await state.set(key, { kind: "discarding", actor });
  const receipt = await args.closeProposal(job);
  if (session && session.stage !== "discarded") await tests.discard(session.id, actor);
  await state.set(key, { kind: "discarded", actor, receipt });
}
