import type { JsonSchema, RiskLevel } from "../capabilities/contracts.ts";

export interface CompanyToolContract {
  grantId: string;
  runtimeId: string;
  agentId: string;
  toolId: string;
  version: string;
  description: string;
  risk: RiskLevel;
  dataClass: string;
  idempotency: "input-hash";
  capabilities: string[];
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  evidence: string[];
  failure: string;
  /** Require the active human subject to confirm this otherwise reversible effect in its conversation. */
  confirmation?: "subject";
}

export interface ToolCapabilityClient {
  call(capability: string, input: unknown): Promise<unknown>;
}

export interface CompanyToolContext {
  readonly instanceId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly agentId: string;
  readonly toolId: string;
  readonly capabilities: ToolCapabilityClient;
}

export interface CompanyToolDefinition {
  execute(input: unknown, context: CompanyToolContext): Promise<unknown> | unknown;
}

export function defineCompanyTool<T extends CompanyToolDefinition>(definition: T): T {
  return Object.freeze(definition);
}
