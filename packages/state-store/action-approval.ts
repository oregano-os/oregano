import { approvalIsUnexpired } from "./approval-validity.ts";
// Generic R-gated action orchestration. Presentation surfaces transport a
// decision, while this Core path owns identity, authorization, stale-input
// protection, atomic approval consumption, effect claiming, and evidence.
import type { StateStore, WorkflowDispatchFence } from "./interface.ts";
import { authorizeApproval, authorizePrincipalApproval, findByCanonicalPrincipal, isHumanRosterMember, type RosterMember } from "./roster.ts";
import { CapabilityEffectOutcomeUnknownError } from "../capabilities/contracts.ts";

export type ActionResult =
  | { ok: true; evidence: unknown; approvedBy: string }
  | { ok: false; rejected: true; reason: string; reRequest: true }
  | { ok: false; blocked: "input-hash-mismatch"; reason: string; reRequest: true }
  | { ok: false; duplicate: true; reason: string };

export async function executeApprovedAction(args: {
  store: StateStore;
  roster: RosterMember[];
  runId: string;
  stepId: string;
  action: string;
  level: string; // R3 | R4 | …
  principal?: string;
  /** Backward-compatible Slack surface input; new callers pass principal. */
  clicker?: { teamId: string; userId: string };
  inputHash: string;
  /** Trusted caller may provide the stable workflow run/step/item identity. */
  idempotencyKey?: string;
  dispatchFence?: WorkflowDispatchFence;
  eventName: string; // e.g. 'lp.published'
  payload?: unknown;
  /** Runs exactly once after the atomic claim; returns the evidence. */
  effect: (ctx: { approvalId: string; idempotencyKey: string; principal: string }) => Promise<unknown>;
}): Promise<ActionResult> {
  const { store, roster, runId, stepId, action, level, principal, clicker, inputHash, eventName, payload, effect } = args;

  if (!principal && !clicker) {
    await store.appendEvent({
      runId, stepId, actor: "agent", event: "approval.rejected", status: "failed",
      payload: { action, reason: "No canonical principal on the approving turn." },
    });
    return { ok: false, rejected: true, reason: "Could not identify the approver.", reRequest: true };
  }
  const auth = principal
    ? authorizePrincipalApproval(roster, principal, level)
    : authorizeApproval(roster, clicker!.teamId, clicker!.userId, level);
  if (!auth.ok) {
    const request = await store.getLatestApprovalRequest(runId, stepId, action);
    if (request) {
      await store.recordDecision({
        requestId: request.requestId,
        subjectPrincipal: auth.principal,
        role: auth.member?.role ?? "unknown",
        decision: "rejected",
      });
    }
    await store.appendEvent({
      runId, stepId, actor: "agent", subjectPrincipal: auth.principal,
      event: "approval.rejected", status: "failed",
      payload: { action, reason: auth.reason },
    });
    return { ok: false, rejected: true, reason: auth.reason, reRequest: true };
  }

  const request = await store.getLatestApprovalRequest(runId, stepId, action);
  if (!request || request.inputHash !== inputHash) {
    await store.appendEvent({
      runId, stepId, actor: "agent", subjectPrincipal: auth.principal,
      event: "approval.blocked-input-hash-mismatch", status: "failed",
      payload: { action, clicked_hash: inputHash, latest_hash: request?.inputHash ?? null },
    });
    return {
      ok: false, blocked: "input-hash-mismatch",
      reason: "The approved content is no longer the latest draft — request a fresh approval.",
      reRequest: true,
    };
  }

  if (!approvalIsUnexpired(request)) {
    await store.appendEvent({
      runId, stepId, actor: "agent", subjectPrincipal: auth.principal,
      event: "approval.expired", status: "failed", payload: { action, request_id: request.requestId },
    });
    return { ok: false, rejected: true, reason: "This approval request has expired or has no expiry — request a fresh approval.", reRequest: true };
  }

  if (level === "R4") {
    const requests = (await store.listEvents(runId)).filter((event) => {
      const evidence = event.payload as Record<string, unknown> | undefined;
      return event.event === "approval.requested" && (event.stepId ?? event.step_id) === stepId
        && typeof event.actor === "string" && event.actor.startsWith("human:") && evidence?.request_id === request.requestId
        && evidence.action === action && evidence.input_hash === inputHash && evidence.risk === "R4";
    });
    const evidence = requests[0]?.payload as Record<string, unknown> | undefined;
    const requesterPrincipal = requests[0]?.subjectPrincipal ?? requests[0]?.subject_principal;
    const requester = typeof requesterPrincipal === "string" ? findByCanonicalPrincipal(roster, requesterPrincipal) : undefined;
    const validRequester = requests.length === 1 && requester?.id && requester.id === evidence?.requester_member_id
      && isHumanRosterMember(requester) && /^(active|aktiv)$/i.test(requester.status);
    if (!validRequester || !auth.member?.id || requester!.id === auth.member.id) {
      await store.appendEvent({
        runId, stepId, actor: "agent", subjectPrincipal: auth.principal,
        event: "approval.separation-refused", status: "failed", payload: { action, request_id: request.requestId },
      });
      return { ok: false, rejected: true, reason: "R4 requires a recorded active human requester and a different active human approver with distinct stable roster identities.", reRequest: true };
    }
  }

  const approvalId = await store.recordDecision({
    requestId: request.requestId,
    subjectPrincipal: auth.principal,
    role: auth.member!.role,
    decision: "approved",
  });
  await store.appendEvent({
    runId, stepId, actor: `human:${auth.member!.role}`, subjectPrincipal: auth.principal,
    event: "approval.granted", status: "succeeded",
    payload: { action, level, approval_id: approvalId, request_id: request.requestId, input_hash: inputHash },
  });

  const idempotencyKey = args.idempotencyKey ?? `${action}:${runId}:${inputHash}`;
  const claimed = await store.consumeApprovalAndClaimEffect({
    approvalId, idempotencyKey, runId, stepId, inputHash,
  });
  if (!claimed) {
    if (!await store.getEffect(idempotencyKey)) {
      await store.appendEvent({
        runId, stepId, actor: "agent", subjectPrincipal: auth.principal,
        event: "approval.claim-refused", status: "failed", idempotencyKey,
        payload: { action, request_id: request.requestId },
      });
      return { ok: false, rejected: true, reason: "The approval is no longer valid for this effect — request a fresh approval.", reRequest: true };
    }
    await store.appendEvent({
      runId, stepId, actor: "agent", subjectPrincipal: auth.principal,
      event: "effect.duplicate-suppressed", status: "succeeded", idempotencyKey,
    });
    return { ok: false, duplicate: true, reason: "This action was already executed (idempotency key held)." };
  }

  if (!await store.markEffectDispatched(idempotencyKey, args.dispatchFence)) throw new Error("Effect dispatch claim is no longer eligible.");
  let evidence: unknown;
  try {
    evidence = await effect({ approvalId, idempotencyKey, principal: auth.principal });
  } catch (error) {
    const unknown = error instanceof CapabilityEffectOutcomeUnknownError;
    const evidence = unknown
      ? { error: error.message, partial_evidence: error.evidence }
      : { error: error instanceof Error ? error.message : String(error) };
    if (unknown) await store.markEffectUnknown(idempotencyKey, evidence);
    else await store.markEffectFailed(idempotencyKey, evidence);
    await store.appendEvent({
      runId, stepId, actor: "agent", subjectPrincipal: auth.principal,
      event: unknown ? `${eventName}.unknown` : `${eventName}.failed`,
      status: unknown ? "effect-unknown" : "failed",
      idempotencyKey, evidence, payload,
    });
    throw error;
  }
  await store.completeEffect(idempotencyKey, evidence);
  await store.appendEvent({
    runId, stepId, actor: "agent", subjectPrincipal: auth.principal,
    event: eventName, status: "succeeded", idempotencyKey, evidence, payload,
  });
  return { ok: true, evidence, approvedBy: `${auth.member!.name} (${auth.member!.role})` };

}
