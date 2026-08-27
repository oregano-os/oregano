export type RiskLevel = "R0" | "R1" | "R2" | "R3" | "R4";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface JsonSchema {
  [keyword: string]: unknown;
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null" | Array<"object" | "array" | "string" | "number" | "integer" | "boolean" | "null">;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: JsonValue[];
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
}

export interface CapabilityContract {
  id: string;
  version: string;
  description: string;
  mode: "read" | "effect";
  minimumRisk: RiskLevel;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  idempotency: "none" | "required";
  evidence: string[];
}

export interface CapabilityBinding {
  capability: string;
  contractVersion: string;
  connector: string;
  connectorVersion: string;
}

export interface CapabilityCallContext {
  instanceId: string;
  runId: string;
  stepId: string;
  agentId: string;
  toolId: string;
  idempotencyKey?: string;
  subject?: {
    principalId: string;
    principalType: "human" | "agent" | "service";
    status: "active" | "inactive" | "unresolved" | "revoked";
    groupIds: string[];
  };
}

export interface CapabilityResult {
  output: unknown;
  evidence: Record<string, unknown>;
}

export interface Connector {
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  invoke(capability: string, input: unknown, context: CapabilityCallContext): Promise<CapabilityResult>;
}

export const RISK_ORDER: Record<RiskLevel, number> = {
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3,
  R4: 4,
};

export function maximumRisk(...levels: RiskLevel[]): RiskLevel {
  return levels.reduce((highest, candidate) =>
    RISK_ORDER[candidate] > RISK_ORDER[highest] ? candidate : highest, "R0");
}
