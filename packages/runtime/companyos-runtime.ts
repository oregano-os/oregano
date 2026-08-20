import type { Connector } from "../capabilities/contracts.ts";
import { RISK_ORDER } from "../capabilities/contracts.ts";
import { validateJsonSchemaValue } from "../capabilities/validation.ts";
import type { CompanyOSArtifact, CompiledAgent, CompiledCompanyTool } from "../companyos-builder/types.ts";
import { ConnectorRegistry } from "../connectors/registry.ts";
import { sha256 } from "./canonical.ts";
import { executeApprovedAction } from "../state-store/action-approval.ts";
import type { StateStore } from "../state-store/interface.ts";
import { authorizePrincipalApproval, type RosterMember } from "../state-store/roster.ts";
import { executeIsolatedCompanyTool } from "../tool-sdk/isolated-runner.ts";

export interface ExecuteToolRequest {
  runId: string;
  stepId: string;
  agentId: string;
  grantId: string;
  input: unknown;
  approvingPrincipal?: string;
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

  constructor(args: { artifact: CompanyOSArtifact; state: StateStore; roster?: RosterMember[]; connectors: Connector[] }) {
    this.#artifact = args.artifact;
    this.#state = args.state;
    this.#roster = args.roster ?? args.artifact.roster;
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

  async execute(request: ExecuteToolRequest): Promise<unknown> {
    const { tool, risk } = this.#resolve(request.agentId, request.grantId);
    const inputErrors = validateJsonSchemaValue(tool.contract.inputSchema, request.input);
    if (inputErrors.length > 0) throw new Error(`Invalid Tool input: ${inputErrors.join("; ")}`);
    await this.#ensureRun(request);
    const inputHash = sha256(request.input);
    const idempotencyKey = `${tool.contract.runtimeId}:${request.runId}:${inputHash}`;
    const capabilityEvidence: Record<string, unknown>[] = [];
    const invoke = async () => {
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
        invokeCapability: async (capability, input) => {
          const result = await this.#connectors.invoke(capability, input, {
            instanceId: this.#artifact.instance.id,
            runId: request.runId,
            stepId: request.stepId,
            agentId: request.agentId,
            toolId: tool.contract.runtimeId,
            idempotencyKey,
          });
          capabilityEvidence.push(result.evidence);
          return result.output;
        },
      });
      const outputErrors = validateJsonSchemaValue(tool.contract.outputSchema, output);
      if (outputErrors.length > 0) throw new Error(`Invalid Tool output: ${outputErrors.join("; ")}`);
      return { output, capabilityEvidence };
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
    if (!claimed) return { ok: false, duplicate: true, reason: "Effect idempotency key already exists." };
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
      const evidence = { error: error instanceof Error ? error.message : String(error) };
      await this.#state.markEffectFailed(idempotencyKey, evidence);
      await this.#state.appendEvent({
        runId: request.runId,
        stepId: request.stepId,
        actor: "agent",
        event: "tool.effect-failed",
        status: "failed",
        toolVersion: tool.contract.version,
        idempotencyKey,
        evidence,
      });
      throw error;
    }
  }
}
