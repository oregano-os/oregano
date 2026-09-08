import { timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { CompanyOSArtifact } from "../../../companyos-builder/types.ts";
import { findByCanonicalPrincipal, isHumanRosterMember } from "../../../state-store/roster.ts";
import { workflowOpeningFields } from "../../../runtime/workflow-engine/references.ts";
import { workflowInstant } from "../../../runtime/workflow-engine/state-validation.ts";
import { parseWorkflowRecordSyncConfiguration, type WorkflowRecordSyncConfiguration } from "../../../runtime/workflow-engine/record-workers.ts";

export const WORKFLOW_CONFIGURATION_ENV = "COMPANYOS_WORKFLOW_CONFIG_GZIP_BASE64";
export interface WorkflowHostingConfiguration {
  version: 1;
  instanceId: string;
  artifactHash: string;
  environment: "preview" | "production" | "development";
  enabledWorkflowIds: string[];
  autoOpenWorkflowIds: string[];
  schedulePrincipal: string;
  activatedAt: string;
  maxLatenessMinutes: number;
  operators: Array<{ principal: string; secretRef: string }>;
  recordSync?: WorkflowRecordSyncConfiguration;
}

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};
const keys = (value: Record<string, unknown>, allowed: string[], label: string): void => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} contains unsupported fields`);
};
const string = (value: unknown, label: string, pattern: RegExp): string => {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
};
const names = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== "string" || !/^[a-z][a-z0-9-]{1,62}$/.test(item)) || new Set(value).size !== value.length) throw new Error(`${label} must be a bounded unique identifier list`);
  return [...value];
};

export function workflowHostingEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const flag = environment.COMPANYOS_WORKFLOW_ENABLED ?? "false";
  if (flag !== "true" && flag !== "false") throw new Error("COMPANYOS_WORKFLOW_ENABLED must be true or false");
  return flag === "true";
}

export function decodeWorkflowHostingConfiguration(artifact: CompanyOSArtifact, environment: NodeJS.ProcessEnv = process.env): WorkflowHostingConfiguration {
  const encoded = environment[WORKFLOW_CONFIGURATION_ENV];
  if (!encoded || encoded.length > 131_072) throw new Error("A bounded workflow Instance configuration is required");
  let parsed: unknown;
  try { parsed = JSON.parse(gunzipSync(Buffer.from(encoded, "base64"), { maxOutputLength: 65_536 }).toString("utf8")); }
  catch { throw new Error("Workflow Instance configuration is malformed"); }
  const value = record(parsed, "Workflow Instance configuration");
  keys(value, ["version", "instanceId", "artifactHash", "environment", "enabledWorkflowIds", "autoOpenWorkflowIds", "schedulePrincipal", "activatedAt", "maxLatenessMinutes", "operators", "recordSync"], "Workflow Instance configuration");
  if (value.version !== 1 || value.instanceId !== artifact.instance.id || value.artifactHash !== artifact.artifactHash
    || value.environment !== artifact.instance.environment || value.environment !== environment.VERCEL_ENV) throw new Error("Workflow configuration does not match the exact deployed Instance and Artifact");
  if (!["preview", "production", "development"].includes(String(value.environment))) throw new Error("Workflow deployment environment is unsupported");
  const enabledWorkflowIds = names(value.enabledWorkflowIds, "enabledWorkflowIds"), autoOpenWorkflowIds = names(value.autoOpenWorkflowIds, "autoOpenWorkflowIds");
  if (enabledWorkflowIds.some((id) => !artifact.workflows?.some((workflow) => workflow.id === id)) || autoOpenWorkflowIds.some((id) => !enabledWorkflowIds.includes(id))) throw new Error("Workflow configuration selects an absent or disabled workflow");
  for (const id of autoOpenWorkflowIds) {
    const workflow = artifact.workflows!.find((workflow) => workflow.id === id)!;
    if (workflow.trigger.kind !== "schedule" || workflowOpeningFields(workflow).some((field) => !["trigger_id", "run_date", "trigger_instant"].includes(field))) {
      throw new Error(`Automatic opening of '${id}' needs explicit business fields; prepare its scheduled occurrence through the operator instead`);
    }
  }
  const activatedAt = string(value.activatedAt, "activatedAt", /^.+$/); workflowInstant(activatedAt);
  if (!Number.isInteger(value.maxLatenessMinutes) || Number(value.maxLatenessMinutes) < 1 || Number(value.maxLatenessMinutes) > 1440) throw new Error("Schedule lateness must be between one minute and one day");
  if (!Array.isArray(value.operators) || !value.operators.length || value.operators.length > 100) throw new Error("Workflow operators must be explicitly configured");
  const operators = value.operators.map((raw) => {
    const operator = record(raw, "Workflow operator"); keys(operator, ["principal", "secretRef"], "Workflow operator");
    const principal = string(operator.principal, "Operator principal", /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/);
    const member = findByCanonicalPrincipal(artifact.roster, principal);
    if (!member?.id || !isHumanRosterMember(member) || !/^(active|aktiv)$/i.test(member.status)) throw new Error("Workflow operator must be one exact active human");
    return { principal, secretRef: string(operator.secretRef, "Operator secretRef", /^env:[A-Z][A-Z0-9_]{0,127}$/) };
  });
  if (new Set(operators.map((operator) => operator.principal)).size !== operators.length || new Set(operators.map((operator) => operator.secretRef)).size !== operators.length) throw new Error("Workflow operator identities and credentials must be unambiguous");
  const credentials = [...operators.map((operator) => environment[operator.secretRef.slice(4)]), environment.CRON_SECRET];
  if (credentials.some((secret) => !secret || secret.length < 32 || /[\r\n]/.test(secret)) || new Set(credentials).size !== credentials.length) {
    throw new Error("Workflow operator and scheduler credentials must be available, bounded-header compatible and distinct");
  }
  const schedulePrincipal = string(value.schedulePrincipal, "schedulePrincipal", /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/);
  if (!operators.some((operator) => operator.principal === schedulePrincipal)) throw new Error("The schedule must identify its authorized accountable operator");
  const recordSync = parseWorkflowRecordSyncConfiguration(value.recordSync);
  return { version: 1, instanceId: artifact.instance.id, artifactHash: artifact.artifactHash, environment: value.environment as WorkflowHostingConfiguration["environment"],
    enabledWorkflowIds, autoOpenWorkflowIds, schedulePrincipal, activatedAt, maxLatenessMinutes: Number(value.maxLatenessMinutes), operators, ...(recordSync ? { recordSync } : {}) };
}

const matches = (authorization: string, secret: string | undefined): boolean => {
  if (!secret || secret.length < 32) return false;
  const left = Buffer.from(authorization), right = Buffer.from(`Bearer ${secret}`);
  return left.length === right.length && timingSafeEqual(left, right);
};
export function authenticateWorkflowOperator(request: Request, config: WorkflowHostingConfiguration, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const matching = config.operators.filter((operator) => matches(request.headers.get("authorization") ?? "", environment[operator.secretRef.slice(4)]));
  return matching.length === 1 ? matching[0]!.principal : undefined;
}
export function authenticateWorkflowScheduler(request: Request, environment: NodeJS.ProcessEnv = process.env): boolean {
  return matches(request.headers.get("authorization") ?? "", environment.CRON_SECRET);
}
