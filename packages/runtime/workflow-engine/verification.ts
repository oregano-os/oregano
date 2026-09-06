import type { JsonValue } from "../../capabilities/contracts.ts";
import type { CompanyOSArtifact } from "../../companyos-builder/types.ts";
import type { StateStore } from "../../state-store/interface.ts";
import type { WorkflowRun } from "../../state-store/workflow-engine.ts";
import { compareRecordInstants } from "../../records/instant.ts";
import { jsonDigest, sha256 } from "../canonical.ts";
import { assertWorkflowArtifact, workflowEffectKey, workflowExecutionStepId, workflowToolInput } from "./guard.ts";
import { renderWorkflowDecisionNotice } from "./decision-notice.ts";
import { workflowContext } from "./readers.ts";
import { resolveWorkflowValue, workflowItems, valueAt } from "./references.ts";

const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const field = (value: Record<string, any>, camel: string, snake: string) => value[camel] ?? value[snake];
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Read-only verification of retained execution evidence, never a new execution. */
export async function verifyCompletedWorkflow(args: { artifact: CompanyOSArtifact; run: WorkflowRun; control: StateStore }) {
  const { artifact, run, control } = args;
  const checks: Array<{ code: string; passed: boolean; stepId?: string }> = [];
  const receipts: Array<{ stepId: string; effectKey: string; inputDigest: string; outputDigest: string; approvalId?: string }> = [];
  const sourceProofs: Array<{ stepId: string; digest: string; requiredThrough: string; snapshotId: string;
    sources: Array<{ sourceId: string; sourceDigest: string; syncRunId: string; syncedThrough: string; watermarkDigest: string }> }> = [];
  const approvingPrincipals = new Set<string>();
  let waits = 0, decisions = 0, batches = 0, syntheticEvidence = false;
  const check = (code: string, passed: boolean, stepId?: string) => { checks.push({ code, passed, ...(stepId ? { stepId } : {}) }); return passed; };
  const result = () => {
    const proof = { schemaVersion: 1, scope: "workflow-run-evidence", instanceId: run.instanceId, workflowId: run.workflowId, runId: run.runId,
      artifactHash: run.artifactHash, manifestHash: run.manifestHash, coreCommit: artifact.provenance.coreCommit,
      workspaceCommit: artifact.provenance.workspaceCommit, revision: run.revision, environment: artifact.instance.environment,
      checks, counts: { waits, decisions, batches, effects: receipts.length, sourceProofs: sourceProofs.length },
      approvingPrincipals: [...approvingPrincipals].sort(), syntheticEvidence, receipts, sourceProofs };
    return { ...proof, ok: checks.length > 0 && checks.every((entry) => entry.passed), evidenceDigest: sha256(proof) };
  };
  try { assertWorkflowArtifact(artifact); }
  catch { check("artifact-integrity", false); return result(); }
  const workflow = artifact.workflows?.find((entry) => entry.id === run.workflowId);
  if (!check("pinned-run-identity", !!workflow && artifact.artifactHash === run.artifactHash && artifact.instance.id === run.instanceId
    && workflow.manifestHash === run.manifestHash && workflow.provenance.coreCommit === artifact.provenance.coreCommit
    && workflow.provenance.workspaceCommit === artifact.provenance.workspaceCommit)) return result();
  if (!check("completed-run", run.state.status === "done" && run.state.cursor === null && !run.state.blocked && !run.state.wait)) return result();
  const events = await control.listEvents(run.runId, 10001);
  if (!check("bounded-audit", events.length <= 10000)) return result();
  const eventFor = (name: string, stepId?: string) => events.filter((event) => event.event === name && (stepId === undefined || field(event, "stepId", "step_id") === stepId));
  const opened = eventFor("workflow.opened");
  check("opening-receipt", opened.length === 1 && object(opened[0]?.payload).artifact_hash === run.artifactHash
    && object(opened[0]?.payload).manifest_hash === run.manifestHash && object(opened[0]?.payload).origin_digest === run.originDigest);
  const revisions = events.filter((event) => Number.isSafeInteger(object(event.payload).revision)).sort((left, right) => object(left.payload).revision - object(right.payload).revision);
  check("complete-state-journal", revisions.length === run.revision && revisions.every((event, index) => {
    const payload = object(event.payload);
    return payload.revision === index + 1 && payload.artifact_hash === run.artifactHash && payload.manifest_hash === run.manifestHash && hash(payload.state_digest);
  }) && object(revisions.at(-1)?.payload).state_digest === sha256(run.state));
  syntheticEvidence = events.some((event) => Array.isArray(event.evidence) && event.evidence.some((value: unknown) => object(value).synthetic === true));
  const deadline = Date.now() + 30_000;
  for (const step of workflow!.steps) {
    const stored = run.state.steps[step.id];
    if (!stored) continue; // An unselected route is not an executed step.
    if (!check("step-completed", stored.status === "succeeded", step.id)) continue;
    try {
      // Retrospective resolution uses only the frozen state; no guard or provider is invoked.
      const context = workflowContext({ ...run, state: { ...run.state, cursor: step.id } }, artifact.roster);
      if (step.wait) {
        const instant = object(stored.output).instant;
        if (check("durable-wait", text(instant) && eventFor("workflow.waiting", step.id).some((event) => object(event.evidence).due_at === instant)
          && eventFor("workflow.timer-fired", step.id).some((event) => object(event.evidence).instant === instant), step.id)) waits++;
      }
      const decision = run.state.decisions[step.id];
      if (step.decision) {
        const approved = decision?.status === "approved";
        const event = eventFor("workflow.decision-approved", step.id).find((entry) => field(entry, "subjectPrincipal", "subject_principal") === decision?.approvingPrincipal);
        const valid = approved && decision!.role === step.decision.role && jsonDigest(decision!.bound) === decision!.boundDigest
          && text(decision!.responseEventId) && text(decision!.approvingPrincipal) && text(decision!.decidedAt)
          && compareRecordInstants(decision!.decidedAt!, decision!.expiresAt) < 0
          && object(event?.evidence).response_event_id === decision!.responseEventId && object(event?.evidence).bound_digest === decision!.boundDigest;
        if (check("human-decision", !!valid, step.id)) { decisions++; approvingPrincipals.add(decision!.approvingPrincipal!); }
      }
      if (step.requireSyncedThrough) {
        const output = object(stored.output), required = resolveWorkflowValue(step.requireSyncedThrough, workflow!, context);
        const proofs = output.source_proofs;
        const valid = text(required) && text(output.synced_through) && compareRecordInstants(output.synced_through, required) >= 0
          && hash(output.snapshot_id) && Array.isArray(proofs) && proofs.length > 0 && proofs.length <= 100
          && proofs.every((entry: unknown) => { const proof = object(entry); return text(proof.source_id) && hash(proof.source_digest)
            && text(proof.run_id) && text(proof.watermark) && text(proof.synced_through) && compareRecordInstants(proof.synced_through, required) >= 0; });
        if (check("record-source-completeness", !!valid, step.id)) sourceProofs.push({ stepId: step.id, requiredThrough: required as string,
          snapshotId: output.snapshot_id, digest: sha256({ required, snapshot: output.snapshot_id, proofs }),
          sources: proofs.map((proof: any) => ({ sourceId: proof.source_id, sourceDigest: proof.source_digest, syncRunId: proof.run_id,
            syncedThrough: proof.synced_through, watermarkDigest: sha256(proof.watermark) })) });
      }
      if (!step.tool) continue;
      const tool = artifact.agents.find((entry) => entry.id === workflow!.agentId)?.tools.find((entry) => entry.contract.runtimeId === step.tool!.runtimeId);
      if (!check("pinned-tool", !!tool, step.id)) continue;
      const effectful = tool!.contract.capabilities.some((id) => artifact.capabilityCatalog.some((capability) => capability.id === id && capability.mode === "effect"));
      if (!effectful) {
        if (!step.forEach) check("read-output-receipt", eventFor("workflow.step-completed", step.id).some((event) => object(event.evidence).output_digest === jsonDigest(stored.output)), step.id);
        continue;
      }
      const items = step.decision ? (decision?.recipients ?? []).map((key) => ({ key, value: undefined })) : step.forEach ? workflowItems(step, workflow!, context) : [{ key: undefined, value: undefined }];
      if (!check("bounded-effects", receipts.length + items.length <= 1000, step.id)) return result();
      for (const item of items) {
        if (!check("verification-budget", Date.now() < deadline, step.id)) return result();
        const itemContext = { ...context, ...(item.key === undefined ? {} : { itemKey: item.key }), ...(item.value === undefined ? {} : { item: item.value }) };
        let input: JsonValue, output: unknown;
        if (step.decision) {
          const bindingId = resolveWorkflowValue(step.decision.via, workflow!, context);
          const bindings = artifact.workflowBindings?.directRecipients.filter((entry) => entry.bindingId === bindingId && entry.memberId === item.key) ?? [];
          if (!decision || bindings.length !== 1) throw new Error("Decision binding is absent");
          input = renderWorkflowDecisionNotice({ runId: run.runId, workflowId: workflow!.id, stepId: step.id, role: decision.role,
            expiresAt: decision.expiresAt, bound: decision.bound, destinationBinding: bindings[0]!.destinationBinding });
          output = decision.deliveries[String(item.key)];
        } else {
          input = workflowToolInput(artifact, workflow!, step, itemContext);
          output = step.forEach ? stored.items?.[jsonDigest(item.key)]?.output : stored.output;
        }
        const effectKey = workflowEffectKey(artifact, itemContext), executionStepId = workflowExecutionStepId(step.id, item.key);
        const effect = object(await control.getEffect(effectKey)), evidence = object(effect.evidence), outputDigest = jsonDigest(output);
        const inputDigest = jsonDigest(input);
        syntheticEvidence ||= Array.isArray(evidence.capabilityEvidence) && evidence.capabilityEvidence.some((value: unknown) => object(value).synthetic === true);
        check("successful-effect", effect.status === "succeeded" && field(effect, "runId", "run_id") === run.runId
          && field(effect, "stepId", "step_id") === executionStepId && field(effect, "inputHash", "input_hash") === inputDigest
          && output !== undefined && jsonDigest(evidence.output) === outputDigest && Array.isArray(evidence.capabilityEvidence) && evidence.capabilityEvidence.length > 0, step.id);
        check("guard-receipt", eventFor("workflow.tool-validated", executionStepId).some((event) => {
          const value = object(event.payload); return value.run_id === run.runId && value.step_id === step.id && value.artifact_hash === run.artifactHash
            && value.manifest_hash === run.manifestHash && value.workspace_commit === artifact.provenance.workspaceCommit
            && value.instance_id === run.instanceId && jsonDigest(value.item_key ?? null) === jsonDigest(item.key ?? null);
        }), step.id);
        if (step.message || step.decision) {
          const published = object(output), submitted = object(input);
          check("publication-receipt", text(published.message_id) && text(published.thread_reference) && published.destination_binding === submitted.destination_binding
            && (submitted.thread_reference === undefined || published.thread_reference === submitted.thread_reference), step.id);
        }
        let approvalId: string | undefined;
        if (Number(step.maxRisk.slice(1)) >= 3) {
          const approval = await control.getEffectApproval(effectKey);
          approvalId = approval?.approvalId;
          const requirements = step.requiresDecisions;
          check("consumed-bound-approval", !!approval && approval.consumed && approval.decision === "approved" && approval.runId === run.runId
            && approval.stepId === executionStepId && approval.action === step.tool.runtimeId && approval.inputHash === inputDigest
            && text(approval.expiresAt) && requirements.length > 0 && requirements.every((requirement) => {
              const accepted = run.state.decisions[requirement.stepId];
              return accepted?.status === "approved" && approval.subjectPrincipal === accepted.approvingPrincipal && approval.role === accepted.role
                && jsonDigest(valueAt(input, requirement.payloadPath)) === accepted.boundDigest
                && text(accepted.decidedAt) && compareRecordInstants(approval.expiresAt!, accepted.decidedAt!) > 0
                && compareRecordInstants(approval.expiresAt!, accepted.expiresAt) <= 0;
            }), step.id);
        }
        if (tool!.contract.capabilities.includes("work-item.batch-update")) {
          const submitted = object(input), returned = object(output);
          const updates = submitted.updates, results = returned.results;
          const valid = returned.complete === true && Array.isArray(updates) && updates.length > 0 && Array.isArray(results) && results.length === updates.length
            && new Set(results.map((row: any) => row.work_item_id)).size === results.length && updates.every((update: any) => results.some((row: any) => row.work_item_id === update.work_item_id
              && row.previous_version === update.expected_version && text(row.provider_version))) && !!approvalId;
          if (check("complete-batch-receipts", valid, step.id)) batches++;
        }
        receipts.push({ stepId: executionStepId, effectKey, inputDigest, outputDigest, ...(approvalId ? { approvalId } : {}) });
      }
    } catch { check("unverifiable-step-evidence", false, step.id); }
  }
  check("required-wait", waits > 0); check("required-human-decision", decisions > 0);
  check("required-record-source-proof", sourceProofs.length > 0); check("required-approved-batch", batches > 0);
  const uniqueEffects = new Set(receipts.map((receipt) => receipt.effectKey));
  const approvals = receipts.flatMap((receipt) => receipt.approvalId ? [receipt.approvalId] : []);
  check("distinct-effect-and-approval-identities", uniqueEffects.size === receipts.length && new Set(approvals).size === approvals.length);
  return result();
}
