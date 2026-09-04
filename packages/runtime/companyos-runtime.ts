import { CapabilityEffectOutcomeUnknownError, RISK_ORDER, type Connector } from "../capabilities/contracts.ts";
import { validateJsonSchemaValue } from "../capabilities/validation.ts";
import type { CompanyOSArtifact, CompiledAgent, CompiledCompanyTool } from "../companyos-builder/types.ts";
import { ConnectorRegistry } from "../connectors/registry.ts";
import { sha256 } from "./canonical.ts";
import { executeApprovedAction } from "../state-store/action-approval.ts";
import type { StateStore } from "../state-store/interface.ts";
import { authorizePrincipalApproval, findByCanonicalPrincipal, type RosterMember } from "../state-store/roster.ts";
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
  readonly #confirmedRequests = new WeakSet<object>();

  constructor(args: {
    artifact: CompanyOSArtifact;
    state: StateStore;
    roster?: RosterMember[];
    connectors: Connector[];
    toolExecutionTimeoutMs?: number;
  }) {
    if (args.toolExecutionTimeoutMs !== undefined && (!Number.isInteger(args.toolExecutionTimeoutMs)
      || args.toolExecutionTimeoutMs < 100 || args.toolExecutionTimeoutMs > 120_000)) {
      throw new Error("Tool execution timeout must be an integer from 100 to 120000 ms.");
    }
    this.#artifact = args.artifact;
    this.#state = args.state;
    this.#roster = args.roster ?? args.artifact.roster;
    this.#toolExecutionTimeoutMs = args.toolExecutionTimeoutMs;
    this.#connectors = new ConnectorRegistry({
      contracts: args.artifact.capabilityCatalog,
      connectors: args.connectors,
      bindings: args.artifact.bindings,
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

  #resolveAccessSubject(principal?: string) {
    if (!principal) return { principalId: "unresolved", principalType: "service" as const, status: "unresolved" as const, groupIds: [] };
    const member = findByCanonicalPrincipal(this.#roster, principal);
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

  async #ensureRun(request: Pick<ExecuteToolRequest, "runId" | "agentId">): Promise<void> {
    const agent = this.#artifact.agents.find((candidate) => candidate.id === request.agentId);
    if (!agent) throw new Error(`Unknown agent '${request.agentId}'.`);
    await this.#state.ensureRun({
      runId: request.runId,
      workflow: "workspace-defined",
      workflowVersion: this.#artifact.provenance.coreCommit,
      companyCommit: this.#artifact.provenance.workspaceCommit,
      companySnapshotHash: this.#artifact.provenance.workspaceHash,
      agentDefinitionHash: sha256({ instructions: agent.instructions, materials: agent.materials }),
      agentAdapter: "companyos-instance-runner",
      adapterVersion: "1",
    });
  }

  async requestApproval(request: Omit<ExecuteToolRequest, "approvingPrincipal">): Promise<{ requestId: string; inputHash: string }> {
    const { tool, risk } = this.#resolve(request.agentId, request.grantId);
    if (RISK_ORDER[risk as keyof typeof RISK_ORDER] < RISK_ORDER.R3) throw new Error(`Tool '${request.grantId}' does not require approval.`);
    const inputErrors = validateJsonSchemaValue(tool.contract.inputSchema, request.input);
    if (inputErrors.length > 0) throw new Error(`Invalid Tool input: ${inputErrors.join("; ")}`);
    await this.#ensureRun(request);
    const inputHash = sha256(request.input);
    const requestId = await this.#state.createApprovalRequest({
      runId: request.runId,
      stepId: request.stepId,
      action: tool.contract.runtimeId,
      inputHash,
    });
    return { requestId, inputHash };
  }

  async rejectApproval(request: ExecuteToolRequest): Promise<RejectApprovalResult> {
    const { tool, risk } = this.#resolve(request.agentId, request.grantId);
    if (RISK_ORDER[risk as keyof typeof RISK_ORDER] < RISK_ORDER.R3) throw new Error(`Tool '${request.grantId}' does not require approval.`);
    const inputErrors = validateJsonSchemaValue(tool.contract.inputSchema, request.input);
    if (inputErrors.length > 0) throw new Error(`Invalid Tool input: ${inputErrors.join("; ")}`);
    await this.#ensureRun(request);
    const inputHash = sha256(request.input);
    const auth = request.approvingPrincipal
      ? authorizePrincipalApproval(this.#roster, request.approvingPrincipal, risk)
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
    const { tool, risk } = this.#resolve(request.agentId, request.grantId);
    if (tool.contract.confirmation !== "subject" || RISK_ORDER[risk as keyof typeof RISK_ORDER] >= RISK_ORDER.R3) {
      throw new Error(`Tool '${request.grantId}' does not use reversible subject confirmation.`);
    }
    if (!request.subjectPrincipal || request.subjectPrincipal !== confirmingPrincipal) {
      throw new Error("Tool confirmation does not match the exact requesting subject.");
    }
    const member = findByCanonicalPrincipal(this.#roster, confirmingPrincipal);
    if (!member || !/^(?:active|aktiv)$/i.test(member.status) || member.type === "agent" || member.type === "service") {
      throw new Error("Tool confirmation requires the exact active human subject.");
    }
    await this.#ensureRun(request);
    await this.#state.appendEvent({
      runId: request.runId,
      stepId: request.stepId,
      actor: `human:${member.role}`,
      subjectPrincipal: confirmingPrincipal,
      event: "tool.subject-confirmed",
      status: "succeeded",
      payload: { tool: tool.contract.runtimeId, input_hash: sha256(request.input) },
    });
    this.#confirmedRequests.add(request);
    try {
      return await this.execute(request);
    } finally {
      this.#confirmedRequests.delete(request);
    }
  }

  async execute(request: ExecuteToolRequest): Promise<unknown> {
    const { tool, risk } = this.#resolve(request.agentId, request.grantId);
    if (tool.contract.confirmation === "subject" && !this.#confirmedRequests.has(request)) {
      throw new Error(`Tool '${request.grantId}' requires executeConfirmed with the exact active human subject.`);
    }
    const inputErrors = validateJsonSchemaValue(tool.contract.inputSchema, request.input);
    if (inputErrors.length > 0) throw new Error(`Invalid Tool input: ${inputErrors.join("; ")}`);
    await this.#ensureRun(request);
    const inputHash = sha256(request.input);
    const idempotencyKey = `${tool.contract.runtimeId}:${request.runId}:${inputHash}`;
    const capabilityEvidence: Record<string, unknown>[] = [];
    const unknownCapabilityEffects: unknown[] = [];
    const accessSubject = this.#resolveAccessSubject(request.subjectPrincipal);
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
        return { output, capabilityEvidence };
      } catch (error) {
        if (unknownCapabilityEffects.length > 0) {
          throw new CapabilityEffectOutcomeUnknownError(
            "One or more provider effects may have happened, but their complete outcome could not be verified.",
            { capability_effects: structuredClone(unknownCapabilityEffects) },
          );
        }
        throw error;
      }
    };

    if (RISK_ORDER[risk as keyof typeof RISK_ORDER] >= RISK_ORDER.R3) {
      const result = await executeApprovedAction({
        store: this.#state,
        roster: this.#roster,
        runId: request.runId,
        stepId: request.stepId,
        action: tool.contract.runtimeId,
        level: risk,
        principal: request.approvingPrincipal,
        inputHash,
        eventName: "tool.effect-succeeded",
        payload: { tool: tool.contract.runtimeId },
        effect: invoke,
      });
      if (!result.ok) return result;
      return result.evidence;
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
      });
      return result;
    }
    const claimed = await this.#state.claimEffect({ idempotencyKey, runId: request.runId, stepId: request.stepId, inputHash });
    if (!claimed) {
      const existing = await this.#state.getEffect(idempotencyKey);
      const existingInputHash = existing?.input_hash ?? existing?.inputHash;
      if (existingInputHash !== undefined && existingInputHash !== inputHash) {
        throw new Error("Effect idempotency identity conflicts with a different input hash.");
      }
      if (existing?.status === "succeeded" && existing.evidence !== undefined && existing.evidence !== null) {
        return structuredClone(existing.evidence);
      }
      return { ok: false, duplicate: true, status: existing?.status ?? "unknown", reason: "Effect idempotency key already exists." };
    }
    await this.#state.markEffectDispatched(idempotencyKey);
    try {
      const result = await invoke();
      await this.#state.completeEffect(idempotencyKey, result);
      await this.#state.appendEvent({
        runId: request.runId,
        stepId: request.stepId,
        actor: "agent",
        event: "tool.effect-succeeded",
        status: "succeeded",
        toolVersion: tool.contract.version,
        idempotencyKey,
        evidence: result.capabilityEvidence,
      });
      return result;
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
  }
}
