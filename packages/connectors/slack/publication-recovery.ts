import type { VerifyPublicationNotSent } from "../../runtime/workflow-engine/decision-recovery.ts";
import { STANDARD_COMMUNICATION_TOOLS } from "../../standard-tools/communication.ts";
import { workflowSlackDestination } from "./workflow-transport.ts";

/** Historical Connector guard: this exact failure occurred before openDirect or any publish call.
 * Restrict the proof to the maintained single-call Tool, not arbitrary Company Tool errors.
 * All other failures (including timeouts and missing receipts) remain unrecoverable here.
 */
export const verifySlackPublicationNotSent: VerifyPublicationNotSent = async ({ artifact, input, effect }) => {
  if (effect.status !== "failed" || !input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const evidence = effect.evidence as Record<string, unknown> | undefined;
  if (!evidence || Object.keys(evidence).length !== 1 || evidence.error !== "A direct-message destination cannot accept an unverified thread reference") return undefined;
  const tools = artifact.agents.flatMap((agent) => agent.tools).filter((tool) => tool.contract.runtimeId === "oregano:communications/publish");
  if (!tools.length || tools.some((tool) => tool.compiledSource !== STANDARD_COMMUNICATION_TOOLS[0]!.compiledSource
    || tool.sourceDigest !== STANDARD_COMMUNICATION_TOOLS[0]!.sourceDigest)) return undefined;
  if (typeof input.destination_binding !== "string" || typeof input.thread_reference !== "string" || !/^slack:D[A-Z0-9]+:\d+\.\d+$/.test(input.thread_reference)) return undefined;
  const binding = workflowSlackDestination(artifact, input.destination_binding);
  if (binding.kind !== "direct-message") return undefined;
  return { provider: "slack", reason: "legacy-direct-thread-guard-before-provider-call", destination_binding: binding.id,
    account_id: binding.accountId, tool_source_digest: STANDARD_COMMUNICATION_TOOLS[0]!.sourceDigest };
};
