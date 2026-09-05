import type { JsonValue, RiskLevel } from "../capabilities/contracts.ts";
import type { ResolvedTool } from "../toolset-resolver/resolver.ts";

export type WorkflowValue = JsonValue;
export type WorkflowWeekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";
export interface WorkflowSchedule {
  schema_version: 1;
  id: string;
  activation: "blocked" | "active";
  timezone: string;
  business_days: WorkflowWeekday[];
  holiday_calendar: { missing_year_policy: "assume-no-holidays" | "block"; years: Record<string, string[]> };
  delivery_window: { opens_at: string; closes_at: string };
  triggers: Array<{ id: string; weekdays: WorkflowWeekday[]; at: string; holiday_shift?: "previous-business-day" | "next-business-day" | "none"; params?: Record<string, JsonValue> }>;
}
export interface CompiledWorkflowSchedule {
  path: string;
  digest: string;
  declaration: WorkflowSchedule;
}
export interface CompiledWorkflowTemplate {
  path: string;
  digest: string;
  content: string;
  format: "plain-text" | "provider-markdown";
}
export interface WorkflowDecisionRequirement {
  stepId: string;
  /** Path from Tool input to the exact value bound by the human decision. */
  payloadPath: string[];
}
export interface CompiledWorkflowStep {
  id: string;
  owner: string;
  kind: "compute" | "effect" | "message" | "wait" | "route" | "decision";
  tool?: ResolvedTool;
  allowedTools: string[];
  maxRisk: RiskLevel;
  input?: WorkflowValue;
  message?: { template: string; vars: Record<string, WorkflowValue>; destination: WorkflowValue; recipient?: WorkflowValue; thread?: WorkflowValue };
  wait?: { triggerId: string; schedulePath: string } | { businessDays: number; calendarPath: string };
  route?: { on: WorkflowValue; targets: Record<string, string> };
  decision?: { role: string; binds: WorkflowValue; via: WorkflowValue; timeoutBusinessDays: number; calendarPath: string; targets: { approve: string; reject: string; timeout: "end" } };
  forEach?: { over: WorkflowValue; key: string; maxItems: 10000 };
  after?: string;
  next: string[];
  allPages: boolean;
  requireSyncedThrough?: WorkflowValue;
  requiredOutputPaths: string[][];
  requiresDecisions: WorkflowDecisionRequirement[];
  /** Values are resolved with the frozen run; never supplied as guard authority. */
  bindingConstraints: Array<{ inputPath: string[]; value: WorkflowValue }>;
  conversationalTools: string[];
  evidence: string[];
  idempotency: ["instance_id", "workflow_id", "run_id", "step_id", "item_key"];
}
export interface CompiledWorkflow {
  manifestVersion: 1;
  id: string;
  version: string | number;
  agentId: string;
  executionMode: "supervised" | "unattended";
  source: { path: string; digest: string };
  provenance: { coreCommit: string; workspaceCommit: string; workbenchVersion: string; instanceId: string };
  trigger: { kind: "operator" } | { kind: "schedule"; id: string; schedulePath: string };
  instance: { key: string[]; fields: string[] };
  config?: { path: string; digest: string; value: Record<string, WorkflowValue> };
  schedules: CompiledWorkflowSchedule[];
  templates: CompiledWorkflowTemplate[];
  entry: string;
  steps: CompiledWorkflowStep[];
  reservedEffects: string[];
  manifestHash: string;
}
