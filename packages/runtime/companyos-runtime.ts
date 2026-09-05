import { guardWorkflowInvocation, assertWorkflowArtifact, authorizeWorkflowDecisions, type GuardedWorkflowInvocation } from "./workflow-engine/guard.ts";
import { assertWorkflowOutput } from "./workflow-engine/references.ts";
import type { WorkflowContextReader } from "./workflow-engine/context.ts";
import { CapabilityEffectOutcomeUnknownError, RISK_ORDER, type Connector, type RiskLevel } from "../capabilities/contracts.ts";
import { validateJsonSchemaValue } from "../capabilities/validation.ts";
import type { CompanyOSArtifact, CompiledAgent, CompiledCompanyTool } from "../companyos-builder/types.ts";
import { ConnectorRegistry } from "../connectors/registry.ts";
import { sha256, jsonDigest } from "./canonical.ts";
import { executeApprovedAction } from "../state-store/action-approval.ts";
import type { StateStore } from "../state-store/interface.ts";
import { authorizePrincipalApproval, findByCanonicalPrincipal, isHumanRosterMember, type RosterMember } from "../state-store/roster.ts";
import { executeIsolatedCompanyTool } from "../tool-sdk/isolated-runner.ts";

export interface ExecuteToolRequest {
  runId: string;
  stepId: string;
  agentId: string;
  grantId: string;
  input: unknown;
  approvingPrincipal?: string;
  /** Canonical principal on whose behalf the Tool is executing. */
  subjectPrincipal?: string;
}

export type RejectApprovalResult =
  | { ok: true; denied: true; deniedBy: string }
  | { ok: false; rejected: true; reason: string }
  | { ok: false; blocked: "input-hash-mismatch"; reason: string };

export class CompanyOSRuntime {
  readonly #artifact: CompanyOSArtifact;
  readonly #state: StateStore;
  readonly #roster: RosterMember[];
  readonly #connectors: ConnectorRegistry;
  readonly #toolExecutionTimeoutMs?: number;
  readonly #workflowContext?: WorkflowContextReader;
  readonly #confirmedRequests = new WeakSet<object>();

  constructor(args: {
    artifact: CompanyOSArtifact;
    state: StateStore;
    roster?: RosterMember[];
    connectors: Connector[];
    toolExecutionTimeoutMs?: number;
    workflowContext?: WorkflowContextReader;
  }) {
    if (args.toolExecutionTimeoutMs !== undefined && (!Number.isInteger(args.toolExecutionTimeoutMs)
      || args.toolExecutionTimeoutMs < 100 || args.toolExecutionTimeoutMs > 120_000)) {
      throw new Error("Tool execution timeout must be an integer from 100 to 120000 ms.");
    }
    this.#artifact = structuredClone(args.artifact);
    if (this.#artifact.workflows?.length) assertWorkflowArtifact(this.#artifact);
    this.#workflowContext = args.workflowContext;
    this.#state = args.state;
    this.#roster = structuredClone(args.roster ?? args.artifact.roster);
    this.#toolExecutionTimeoutMs = args.toolExecutionTimeoutMs;
    this.#connectors = new ConnectorRegistry({
      contracts: this.#artifact.capabilityCatalog,
      connectors: args.connectors,
      bindings: this.#artifact.bindings,
    });
  }

  #resolve(agentId: string, grantId: string): { agent: CompiledAgent; tool: CompiledCompanyTool; risk: string } {
    const agent = this.#artifact.agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error(`Unknown agent '${agentId}'.`);
    const resolved = agent.toolSet.tools.find((tool) => tool.grantId === grantId);
    if (!resolved) throw new Error(`Tool '${grantId}' is not in agent '${agentId}' resolved ToolSet.`);
    const tool = agent.tools.find((candidate) => candidate.contract.runtimeId === resolved.runtimeId);
    if (!tool) throw new Error(`Resolved Tool '${resolved.runtimeId}' has no compiled implementation.`);
    return { agent, tool, risk: resolved.risk };
  }

  #resolveAccessSubject(principal?: string, roster = this.#roster) {
    if (!principal) return { principalId: "unresolved", principalType: "service" as const, status: "unresolved" as const, groupIds: [] };
    const member = findByCanonicalPrincipal(roster, principal);
    if (!member) return { principalId: principal, principalType: "service" as const, status: "unresolved" as const, groupIds: [] };
    const active = /^(aktiv|active)$/i.test(member.status);
    const principalType = member.type === "agent" ? "agent" as const : member.type === "service" ? "service" as const : "human" as const;
    const roleGroup = `role:${member.role.trim().toLocaleLowerCase("en").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
    return {
      principalId: principal,
      principalType,
      status: active ? "active" as const : "inactive" as const,
      groupIds: [...new Set([...(member.groups ?? []), ...(active ? ["company:active"] : []), `type:${principalType}`, roleGroup])].sort(),
    };
  }

  async #ensureRun(request: Pick<ExecuteToolRequest, "runId" | "agentId">, guard?: GuardedWorkflowInvocation): Promise<void> {
    const agent = this.#artifact.agents.find((candidate) => candidate.id === request.agentId);
    if (!agent) throw new Error(`Unknown agent '${request.agentId}'.`);
    await this.#state.ensureRun({
      runId: request.runId,
      workflow: guard?.workflow.id ?? "tool-invocation",
      workflowVersion: String(guard?.workflow.version ?? this.#artifact.provenance.coreCommit),
      companyCommit: this.#artifact.provenance.workspaceCommit,
      companySnapshotHash: this.#artifact.provenance.workspaceHash,
      agentDefinitionHash: sha256({ instructions: agent.instructions, materials: agent.materials }),
      agentAdapter: "companyos-instance-runner",
      adapterVersion: "1",
    });
  }

  async requestApproval(request: Omit<ExecuteToolRequest, "approvingPrincipal">, validity: { expiresAt: Date } | undefined = undefined): Promise<{ requestId: string; inputHash: string }> {
    request = structuredClone(request);
    const { tool, risk } = this.#resolve(request.agentId, request.grantId);
    const guard = await guardWorkflowInvocation({ artifact: this.#artifact, reader: this.#workflowContext, request, tool, risk: risk as RiskLevel });
    if (RISK_ORDER[risk as keyof typeof RISK_ORDER] < RISK_ORDER.R3) throw new Error(`Tool '${request.grantId}' does not require approval.`);
    const inputErrors = validateJsonSchemaValue(tool.contract.inputSchema, request.input);
    if (inputErrors.length > 0) throw new Error(`Invalid Tool input: ${inputErrors.join("; ")}`);
    const requester = request.subjectPrincipal ? findByCanonicalPrincipal(guard?.context.currentRoster ?? this.#roster, request.subjectPrincipal) : undefined;
    const humanRequester = requester && isHumanRosterMember(requester) && /^(active|aktiv)$/i.test(requester.status);
    if (risk === "R4" && (!humanRequester || !requester.id)) throw new Error("R4 requests require an authenticated active human requester with a stable roster id.");
    await this.#ensureRun(request, guard);
    const inputHash = jsonDigest(request.input);
    const requestId = await this.#state.createApprovalRequest({
      runId: request.runId,
      stepId: request.stepId,
      action: tool.contract.runtimeId,
      inputHash,
      expiresAt: validity?.expiresAt,
    });
    await this.#state.appendEvent({
      runId: request.runId, stepId: request.stepId,
      actor: humanRequester ? `human:${requester.role}` : "agent", subjectPrincipal: request.subjectPrincipal,
      event: "approval.requested", status: "succeeded",
      payload: { request_id: requestId, action: tool.contract.runtimeId, input_hash: inputHash, risk,
        requester_member_id: humanRequester ? requester.id ?? null : null, artifact_hash: this.#artifact.artifactHash,
        ...(guard ? { workflow: guard.evidence } : {}) },
    });
    return { requestId, inputHash };
  }

  async rejectApproval(request: ExecuteToolRequest): Promise<RejectApprovalResult> {
    request = structuredClone(request);
    const { tool, risk } = this.#resolve(request.agentId, request.grantId);
    const guard = await guardWorkflowInvocation({ artifact: this.#artifact, reader: this.#workflowContext, request, tool, risk: risk as RiskLevel });
    if (RISK_ORDER[risk as keyof typeof RISK_ORDER] < RISK_ORDER.R3) throw new Error(`Tool '${request.grantId}' does not require approval.`);
    const inputErrors = validateJsonSchemaValue(tool.contract.inputSchema, request.input);
    if (inputErrors.length > 0) throw new Error(`Invalid Tool input: ${inputErrors.join("; ")}`);
    await this.#ensureRun(request, guard);
    const inputHash = jsonDigest(request.input);
    const auth = request.approvingPrincipal
      ? authorizePrincipalApproval(guard?.context.currentRoster ?? this.#roster, request.approvingPrincipal, risk)
      : { ok: false as const, principal: "unknown", reason: "Could not identify the approver." };
    if (!auth.ok) {
      await this.#state.appendEvent({
        runId: request.runId,
        stepId: request.stepId,
        actor: "agent",
        subjectPrincipal: auth.principal,
        event: "approval.rejection-refused",
        status: "failed",
        payload: { action: tool.contract.runtimeId, reason: auth.reason },
      });
      return { ok: false, rejected: true, reason: auth.reason };
    }
    const latest = await this.#state.getLatestApprovalRequest(request.runId, request.stepId, tool.contract.runtimeId);
    if (!latest || latest.inputHash !== inputHash) {
      await this.#state.appendEvent({
        runId: request.runId,
        stepId: request.stepId,
        actor: `human:${auth.member!.role}`,
        subjectPrincipal: auth.principal,
        event: "approval.denial-blocked-input-hash-mismatch",
        status: "failed",
        payload: { action: tool.contract.runtimeId, clicked_hash: inputHash, latest_hash: latest?.inputHash ?? null },
      });
      return { ok: false, blocked: "input-hash-mismatch", reason: "The approval request is no longer current." };
    }
    await this.#state.recordDecision({
      requestId: latest.requestId,
      subjectPrincipal: auth.principal,
      role: auth.member!.role,
      decision: "rejected",
    });
    await this.#state.appendEvent({
      runId: request.runId,
      stepId: request.stepId,
      actor: `human:${auth.member!.role}`,
      subjectPrincipal: auth.principal,
      event: "approval.denied",
      status: "succeeded",
      payload: { action: tool.contract.runtimeId, level: risk, request_id: latest.requestId, input_hash: inputHash },
    });
    return { ok: true, denied: true, deniedBy: `${auth.member!.name} (${auth.member!.role})` };
  }

  async executeConfirmed(request: ExecuteToolRequest, confirmingPrincipal: string): Promise<unknown> {
    request = structuredClone(request);
    const { tool, risk } = this.#resolve(request.agentId, request.grantId);
    const guard = await guardWorkflowInvocation({ artifact: this.#artifact, reader: this.#workflowContext, request, tool, risk: risk as RiskLevel });
    if (tool.contract.confirmation !== "subject" || RISK_ORDER[risk as keyof typeof RISK_ORDER] >= RISK_ORDER.R3) {
      throw new Error(`Tool '${request.grantId}' does not use reversible subject confirmation.`);
    }
    if (!request.subjectPrincipal || request.subjectPrincipal !== confirmingPrincipal) {
      throw new Error("Tool confirmation does not match the exact requesting subject.");
    }
    const member = findByCanonicalPrincipal(guard?.context.currentRoster ?? this.#roster, confirmingPrincipal);
    if (!member || !/^(?:active|aktiv)$/i.test(member.status) || member.type === "agent" || member.type === "service") {
      throw new Error("Tool confirmation requires the exact active human subject.");
    }
    await this.#ensureRun(request, guard);
    await this.#state.appendEvent({
      runId: request.runId,
      stepId: request.stepId,
      actor: `human:${member.role}`,
      subjectPrincipal: confirmingPrincipal,
      event: "tool.subject-confirmed",
      status: "succeeded",
      payload: { tool: tool.contract.runtimeId, input_hash: jsonDigest(request.input) },
    });
    this.#confirmedRequests.add(request);
    try {
      return await this.execute(request);
    } finally {
      this.#confirmedRequests.delete(request);
    }
  }

  async execute(request: ExecuteToolRequest): Promise<unknown> {
    const confirmed = this.#confirmedRequests.has(request);
    request = structuredClone(request);
    const { tool, risk } = this.#resolve(request.agentId, request.grantId);
    const guard = await guardWorkflowInvocation({ artifact: this.#artifact, reader: this.#workflowContext, request, tool, risk: risk as RiskLevel });
    if (tool.contract.confirmation === "subject" && !confirmed) {
      throw new Error(`Tool '${request.grantId}' requires executeConfirmed with the exact active human subject.`);
    }
    const inputErrors = validateJsonSchemaValue(tool.contract.inputSchema, request.input);
    if (inputErrors.length > 0) throw new Error(`Invalid Tool input: ${inputErrors.join("; ")}`);
    await this.#ensureRun(request, guard);
    const inputHash = jsonDigest(request.input);
    const idempotencyKey = guard?.idempotencyKey ?? `${tool.contract.runtimeId}:${request.runId}:${inputHash}`;
    const checkedResult = (result: unknown): unknown => {
      if (guard?.context.mode === "engine" && !guard.step.forEach) assertWorkflowOutput(guard.step, (result as { output?: unknown })?.output);
      return result;
    };
    if (guard) {
      await this.#state.appendEvent({ runId: request.runId, stepId: request.stepId, actor: "agent", event: "workflow.tool-validated", status: "succeeded", payload: guard.evidence });
      const existing = await this.#state.getEffect(idempotencyKey);
      if (existing) {
        if ((existing.input_hash ?? existing.inputHash) !== inputHash) throw new Error("Workflow effect identity conflicts with changed input");
        if (existing.status === "succeeded" && existing.evidence !== undefined && existing.evidence !== null) return checkedResult(structuredClone(existing.evidence));
        return { ok: false, duplicate: true, status: existing.status, reason: "Workflow effect requires reconciliation or review before further dispatch." };
      }
    }
    const approvingPrincipal = guard ? authorizeWorkflowDecisions(guard, request.input, risk as RiskLevel) : request.approvingPrincipal;
    const capabilityEvidence: Record<string, unknown>[] = [];
    const unknownCapabilityEffects: unknown[] = [];
    const accessSubject = this.#resolveAccessSubject(request.subjectPrincipal, guard?.context.currentRoster ?? this.#roster);
    const invoke = async () => {
      try {
        const output = await executeIsolatedCompanyTool({
          compiledSource: tool.compiledSource,
          file: `${tool.contract.runtimeId}/execute.js`,
          input: request.input,
          context: {
            instanceId: this.#artifact.instance.id,
            runId: request.runId,
            stepId: request.stepId,
            agentId: request.agentId,
            toolId: tool.contract.runtimeId,
          },
          allowedCapabilities: tool.contract.capabilities,
          ...(this.#toolExecutionTimeoutMs === undefined ? {} : { timeoutMs: this.#toolExecutionTimeoutMs }),
          invokeCapability: async (capability, input) => {
            try {
              const result = await this.#connectors.invoke(capability, input, {
                instanceId: this.#artifact.instance.id,
                runId: request.runId,
                stepId: request.stepId,
                agentId: request.agentId,
                toolId: tool.contract.runtimeId,
                idempotencyKey,
                subject: accessSubject,
              });
              capabilityEvidence.push(result.evidence);
              return result.output;
            } catch (error) {
              if (error instanceof CapabilityEffectOutcomeUnknownError) unknownCapabilityEffects.push(error.evidence);
              throw error;
            }
          },
        });
        const outputErrors = validateJsonSchemaValue(tool.contract.outputSchema, output);
        if (outputErrors.length > 0) throw new Error(`Invalid Tool output: ${outputErrors.join("; ")}`);
        return { output, capabilityEvidence, ...(guard ? { workflow: guard.evidence } : {}) };
      } catch (error) {
        const successfulEffects = capabilityEvidence.filter((evidence) => this.#artifact.capabilityCatalog.some((contract) => contract.id === evidence.capability && contract.mode === "effect"));
        if (unknownCapabilityEffects.length > 0 || successfulEffects.length > 0) {
          throw new CapabilityEffectOutcomeUnknownError(
            "One or more provider effects may have happened, but their complete outcome could not be verified.",
            { capability_effects: structuredClone([...successfulEffects, ...unknownCapabilityEffects]), ...(guard ? { workflow: guard.evidence } : {}) },
          );
        }
        throw error;
      }
    };

    if (RISK_ORDER[risk as keyof typeof RISK_ORDER] >= RISK_ORDER.R3) {
      const result = await executeApprovedAction({
        store: this.#state,
        roster: guard?.context.currentRoster ?? this.#roster,
        runId: request.runId,
        stepId: request.stepId,
        action: tool.contract.runtimeId,
        level: risk,
        principal: approvingPrincipal,
        inputHash,
        eventName: "tool.effect-succeeded",
        ...(guard ? { idempotencyKey, dispatchFence: guard.context.dispatchFence } : {}),
        payload: { tool: tool.contract.runtimeId, ...(guard ? { workflow: guard.evidence } : {}) },
        effect: invoke,
      });
      if (!result.ok) return result;
      return checkedResult(result.evidence);
    }

    const effectful = tool.contract.capabilities.some((capability) =>
      this.#artifact.capabilityCatalog.find((contract) => contract.id === capability)?.mode === "effect");
    if (!effectful) {
      const result = await invoke();
      await this.#state.appendEvent({
        runId: request.runId,
        stepId: request.stepId,
        actor: "agent",
        event: "tool.read-succeeded",
        status: "succeeded",
        toolVersion: tool.contract.version,
        evidence: result.capabilityEvidence,
        ...(guard ? { payload: guard.evidence } : {}),
      });
      return checkedResult(result);
    }
    const claimed = await this.#state.claimEffect({ idempotencyKey, runId: request.runId, stepId: request.stepId, inputHash });
    if (!claimed) {
      const existing = await this.#state.getEffect(idempotencyKey);
      const existingInputHash = existing?.input_hash ?? existing?.inputHash;
      if (existingInputHash !== undefined && existingInputHash !== inputHash) {
        throw new Error("Effect idempotency identity conflicts with a different input hash.");
      }
      if (existing?.status === "succeeded" && existing.evidence !== undefined && existing.evidence !== null) {
        return checkedResult(structuredClone(existing.evidence));
      }
      return { ok: false, duplicate: true, status: existing?.status ?? "unknown", reason: "Effect idempotency key already exists." };
    }
    if (!await this.#state.markEffectDispatched(idempotencyKey, guard?.context.dispatchFence)) throw new Error("Effect dispatch claim is no longer eligible.");
    let result: unknown;
    try {
      result = await invoke();
    } catch (error) {
      const unknown = error instanceof CapabilityEffectOutcomeUnknownError;
      const evidence = unknown
        ? { error: error.message, partial_evidence: error.evidence }
        : { error: error instanceof Error ? error.message : String(error) };
      if (unknown) await this.#state.markEffectUnknown(idempotencyKey, evidence);
      else await this.#state.markEffectFailed(idempotencyKey, evidence);
      await this.#state.appendEvent({
        runId: request.runId,
        stepId: request.stepId,
        actor: "agent",
        event: unknown ? "tool.effect-unknown" : "tool.effect-failed",
        status: unknown ? "effect-unknown" : "failed",
        toolVersion: tool.contract.version,
        idempotencyKey,
        evidence,
      });
      throw error;
    }
    await this.#state.completeEffect(idempotencyKey, result);
    await this.#state.appendEvent({
      runId: request.runId,
      stepId: request.stepId,
      actor: "agent",
      event: "tool.effect-succeeded",
      status: "succeeded",
      toolVersion: tool.contract.version,
      idempotencyKey,
      evidence: (result as { capabilityEvidence: unknown }).capabilityEvidence,
      ...(guard ? { payload: guard.evidence } : {}),
    });
    return checkedResult(result);
  }
}
