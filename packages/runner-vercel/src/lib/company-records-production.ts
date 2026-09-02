import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { reconcileRecordSnapshot } from "../../../records/reconciliation.ts";
import { synchronizeRecordSnapshot } from "../../../records/synchronization.ts";
import { prepareCompanyDatabase } from "../../../state-postgres/database-bootstrap.ts";
import {
  createPostgresCompanyRecordsStore,
  inspectPostgresCompanyRecordProjectionStatus,
  inspectPostgresCompanyRecordSyncReceipt,
  inspectPostgresCompanyRecordSourceStatus,
  type PostgresCompanyRecordSourceStatus,
} from "../../../state-postgres/records-store.ts";
import type { RecordSourceInventory } from "../../../records/source-connector.ts";
import { loadArtifact } from "./artifact.ts";
import {
  companyRecordsConfigurationDigest,
  companyRecordsWorkspaceIdentity,
  CompanyRecordsRehearsalError,
  decodeCompanyRecordsRuntimeConfiguration,
  validatedCompanyRecordsSelection,
  type CompanyRecordsReconciliationSchedule,
  type CompanyRecordsRuntimeConfiguration,
} from "./company-records-rehearsal.ts";

export const COMPANY_RECORDS_PRODUCTION_CONFIG_ENV = "COMPANYOS_RECORDS_CONFIG_GZIP_BASE64";
export const COMPANY_RECORDS_PRODUCTION_SECRET_ENV = "COMPANYOS_RECORDS_ADMIN_SECRET";
export const COMPANY_RECORDS_ENABLED_ENV = "COMPANYOS_RECORDS_ENABLED";
export const COMPANY_RECORDS_SCHEDULER_ENABLED_ENV = "COMPANYOS_RECORDS_SCHEDULER_ENABLED";

type JsonObject = Record<string, unknown>;
type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
export type CompanyRecordsProductionConfiguration = CompanyRecordsRuntimeConfiguration<"production">;

export type CompanyRecordsProductionRequest =
  | { readonly action: "plan-migration" }
  | { readonly action: "apply-migration"; readonly confirmation_hash: string }
  | { readonly action: "plan-sync" | "plan-reconcile"; readonly source_id: string }
  | { readonly action: "apply-sync" | "apply-reconcile"; readonly source_id: string; readonly confirmation_hash: string }
  | { readonly action: "status"; readonly source_id: string };

export interface CompanyRecordsProductionIdentity {
  readonly instance_id: string;
  readonly core_ref: string;
  readonly workspace_ref: string;
}

export interface ScheduledReconciliationResult {
  readonly source_id: string;
  readonly service_date: string;
  readonly status: "completed" | "not-due" | "already-completed" | "failed";
  readonly receipt?: Record<string, unknown>;
  readonly error_digest?: string;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const object = (value: unknown, label: string): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CompanyRecordsRehearsalError("invalid-request", `${label} must be an object`);
  return value as JsonObject;
};
const string = (value: unknown, label: string, pattern?: RegExp): string => {
  if (typeof value !== "string" || value.trim() === "" || (pattern && !pattern.test(value))) throw new CompanyRecordsRehearsalError("invalid-request", `${label} is invalid`);
  return value;
};
const exactKeys = (value: JsonObject, allowed: readonly string[], label: string): void => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new CompanyRecordsRehearsalError("invalid-request", `${label} contains unsupported fields`);
};

const constantTimeBearer = (request: Request, secret: string | undefined): boolean => {
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) return false;
  const provided = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
};

export function authorizeCompanyRecordsProductionOperator(
  request: Request,
  secret = process.env[COMPANY_RECORDS_PRODUCTION_SECRET_ENV],
): boolean {
  return constantTimeBearer(request, secret);
}

export function authorizeCompanyRecordsScheduler(request: Request, secret = process.env.CRON_SECRET): boolean {
  return constantTimeBearer(request, secret);
}

export function decodeCompanyRecordsProductionConfiguration(
  encoded = process.env[COMPANY_RECORDS_PRODUCTION_CONFIG_ENV],
): CompanyRecordsProductionConfiguration {
  return decodeCompanyRecordsRuntimeConfiguration(encoded, "production", COMPANY_RECORDS_PRODUCTION_CONFIG_ENV);
}

export function parseCompanyRecordsProductionRequest(value: unknown): CompanyRecordsProductionRequest {
  const input = object(value, "request");
  const action = string(input.action, "request.action");
  const migrationActions = new Set(["plan-migration", "apply-migration"]);
  const sourceActions = new Set(["plan-sync", "apply-sync", "plan-reconcile", "apply-reconcile", "status"]);
  if (!migrationActions.has(action) && !sourceActions.has(action)) throw new CompanyRecordsRehearsalError("invalid-request", "Unsupported production action");
  const allowedKeys = action === "plan-migration"
    ? ["action"]
    : action === "apply-migration"
      ? ["action", "confirmation_hash"]
      : action.startsWith("apply-")
        ? ["action", "source_id", "confirmation_hash"]
        : ["action", "source_id"];
  exactKeys(input, allowedKeys, "request");
  const confirmationHash = action.startsWith("apply-") ? string(input.confirmation_hash, "request.confirmation_hash", /^[0-9a-f]{64}$/) : undefined;
  const sourceId = sourceActions.has(action) ? string(input.source_id, "request.source_id", /^[a-z][a-z0-9-]{1,62}$/) : undefined;
  if (action === "plan-migration") return { action };
  if (action === "apply-migration") return { action, confirmation_hash: confirmationHash! };
  if (action === "plan-sync" || action === "plan-reconcile") return { action, source_id: sourceId! };
  if (action === "apply-sync" || action === "apply-reconcile") return { action, source_id: sourceId!, confirmation_hash: confirmationHash! };
  return { action: "status", source_id: sourceId! };
}

const defaultProductionIdentity = (): CompanyRecordsProductionIdentity => {
  const artifact = loadArtifact();
  return {
    instance_id: artifact.instance.id,
    core_ref: artifact.provenance.coreCommit,
    workspace_ref: artifact.provenance.workspaceCommit,
  };
};

export function assertCompanyRecordsProductionIdentity(
  configuration: CompanyRecordsProductionConfiguration,
  environment: RuntimeEnvironment,
  identity: CompanyRecordsProductionIdentity,
): void {
  if (environment[COMPANY_RECORDS_PRODUCTION_SECRET_ENV]
    && environment.CRON_SECRET
    && environment[COMPANY_RECORDS_PRODUCTION_SECRET_ENV] === environment.CRON_SECRET) {
    throw new CompanyRecordsRehearsalError("shared-authentication-secret", "Company Records operator and scheduler must use different secrets", 503);
  }
  if (environment.VERCEL_ENV !== "production") {
    throw new CompanyRecordsRehearsalError("production-only", "Company Records production runtime runs only in a Vercel Production deployment", 403);
  }
  if (!environment.VERCEL_GIT_COMMIT_SHA || environment.VERCEL_GIT_COMMIT_SHA !== configuration.core.ref || identity.core_ref !== configuration.core.ref) {
    throw new CompanyRecordsRehearsalError("core-identity-mismatch", "Production deployment and Artifact do not match the configured exact Core commit", 409);
  }
  if (identity.instance_id !== configuration.instance_id) {
    throw new CompanyRecordsRehearsalError("instance-identity-mismatch", "Production Artifact does not match the configured Company Instance", 409);
  }
  if (identity.workspace_ref !== configuration.workspace.ref) {
    throw new CompanyRecordsRehearsalError("workspace-identity-mismatch", "Production Artifact does not match the configured exact Workspace commit", 409);
  }
}

export function planCompanyRecordsProductionMigration(configuration: CompanyRecordsProductionConfiguration) {
  const plan = {
    schema_version: 1,
    kind: "company-records-production-migration",
    environment: "production",
    instance_id: configuration.instance_id,
    core: configuration.core,
    workspace: companyRecordsWorkspaceIdentity(configuration),
    configuration_digest: companyRecordsConfigurationDigest(configuration),
    source_confirmations: configuration.source_confirmations,
    database_secret_ref: "env:DATABASE_URL",
    database_effect: "Apply the next additive Company Instance database manifest, including companyos_records tables and indexes; preserve all existing data.",
    provider_effects: [],
    production_effects: ["Add schema objects and one immutable manifest receipt to the bound production database."],
  };
  return { ...plan, confirmation_hash: sha256(JSON.stringify(plan)) };
}

export function planCompanyRecordsProductionSourceOperation(
  configuration: CompanyRecordsProductionConfiguration,
  sourceId: string,
  operation: "sync" | "reconcile",
) {
  const selected = validatedCompanyRecordsSelection(configuration, sourceId);
  const inferAbsence = operation === "reconcile";
  const plan = {
    schema_version: 1,
    kind: "company-record-source-operation",
    operation,
    environment: "production",
    workspace: companyRecordsWorkspaceIdentity(configuration),
    core: configuration.core,
    source_id: sourceId,
    source_digest: sha256(JSON.stringify(selected.source)),
    projection_digests: selected.projections.map((projection) => ({ id: projection.id, digest: sha256(JSON.stringify(projection)) })),
    binding_path: `instance:${configuration.instance_id}/records/${sourceId}/binding`,
    binding_digest: sha256(JSON.stringify(selected.binding)),
    instance_id: configuration.instance_id,
    resource_binding: selected.binding.resource_binding,
    connector: `${selected.binding.connector}@${selected.binding.connector_version}`,
    provider_secret_ref: selected.binding.secret_ref,
    qualification_ref: `instance:${configuration.instance_id}/records/${sourceId}/qualification`,
    qualification_digest: selected.binding.qualification.digest,
    database_secret_ref: "env:DATABASE_URL",
    provider_access: "read-only-complete-inventory",
    database_effect: inferAbsence
      ? "Append immutable observations, update current pointers and projections, tombstone objects absent from the complete provider inventory, and advance the watermark."
      : "Append immutable observations, update current pointers and projections, and advance the watermark without inferring provider deletion.",
    production: {
      configuration_digest: companyRecordsConfigurationDigest(configuration),
      workspace_ref: configuration.workspace.ref,
      source_confirmation_hash: configuration.source_confirmations[sourceId],
    },
    external_changes: [
      "Read the exact qualified provider resource through the selected read-only Record Source Connector.",
      inferAbsence
        ? "Write idempotent production Company Records observations, projections, watermarks, receipts, and tombstones for objects absent from the complete inventory."
        : "Write idempotent production Company Records observations, projections, watermarks, and receipts without deleting missing records.",
      "Do not modify provider objects, provider permissions, Workspace files, Git, Agent Tools, or communication surfaces.",
    ],
  };
  return { plan: { ...plan, confirmation_hash: sha256(JSON.stringify(plan)) }, selected };
}

export interface CompanyRecordsProductionDependencies {
  prepareDatabase(): Promise<Record<string, unknown>>;
  readInventory(configuration: CompanyRecordsProductionConfiguration, sourceId: string): Promise<{
    selected: ReturnType<typeof validatedCompanyRecordsSelection>;
    inventory: RecordSourceInventory;
  }>;
  inspectReceipt(instanceId: string, sourceId: string, runId: string): Promise<PostgresCompanyRecordSourceStatus["last_sync"] | undefined>;
  inspectStatus(configuration: CompanyRecordsProductionConfiguration, sourceId: string): Promise<Record<string, unknown>>;
  runSourceOperation(args: {
    configuration: CompanyRecordsProductionConfiguration;
    sourceId: string;
    operation: "sync" | "reconcile";
    runId: string;
    leaseOwner: string;
  }): Promise<Record<string, unknown>>;
}

const readProductionInventory = async (
  configuration: CompanyRecordsProductionConfiguration,
  sourceId: string,
): Promise<{ selected: ReturnType<typeof validatedCompanyRecordsSelection>; inventory: RecordSourceInventory }> => {
  const selected = validatedCompanyRecordsSelection(configuration, sourceId);
  const connector = selected.connectors.resolve(selected.binding);
  const inventory = await connector.readCompleteInventory({ source: selected.source, binding: selected.binding, qualification: selected.qualification });
  if (inventory.complete !== true) throw new Error("Record Source Connector did not return a complete inventory");
  return { selected, inventory };
};

const defaultDependencies: CompanyRecordsProductionDependencies = {
  async prepareDatabase() {
    return await prepareCompanyDatabase() as unknown as Record<string, unknown>;
  },
  readInventory: readProductionInventory,
  inspectReceipt: inspectPostgresCompanyRecordSyncReceipt,
  async runSourceOperation({ configuration, sourceId, operation, runId, leaseOwner }) {
    const { selected, inventory } = await readProductionInventory(configuration, sourceId);
    const store = createPostgresCompanyRecordsStore();
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const receipt = operation === "sync"
      ? await synchronizeRecordSnapshot({
          instanceId: configuration.instance_id,
          source: selected.source,
          inventory,
          registry: selected.registry,
          store,
          runId,
          leaseOwner,
          leaseToken,
          leaseExpiresAt,
        })
      : await reconcileRecordSnapshot({
          instanceId: configuration.instance_id,
          sourceId,
          runId,
          leaseOwner,
          leaseToken,
          observedAt: inventory.observed_at,
          leaseExpiresAt,
          objects: inventory.objects,
          watermark: inventory.watermark,
          registry: selected.registry,
          store,
        });
    return { receipt, provider_evidence: inventory.receipt, credentials_retained: false };
  },
  async inspectStatus(configuration, sourceId) {
    const selected = validatedCompanyRecordsSelection(configuration, sourceId);
    const [status, projections] = await Promise.all([
      inspectPostgresCompanyRecordSourceStatus(configuration.instance_id, sourceId),
      inspectPostgresCompanyRecordProjectionStatus(configuration.instance_id, selected.projections.map((projection) => projection.id)),
    ]);
    return {
      status,
      projections,
      binding: {
        instance_id: configuration.instance_id,
        connector: `${selected.binding.connector}@${selected.binding.connector_version}`,
        resource_binding: selected.binding.resource_binding,
      },
    };
  },
};

const productionEnabled = (environment: RuntimeEnvironment): boolean => environment[COMPANY_RECORDS_ENABLED_ENV] === "true";
const schedulerEnabled = (environment: RuntimeEnvironment): boolean => environment[COMPANY_RECORDS_SCHEDULER_ENABLED_ENV] === "true";
const requireProductionEnabled = (environment: RuntimeEnvironment): void => {
  if (!productionEnabled(environment)) throw new CompanyRecordsRehearsalError("records-disabled", "Company Records production effects are disabled", 403);
};

export async function executeCompanyRecordsProduction(
  request: CompanyRecordsProductionRequest,
  configuration: CompanyRecordsProductionConfiguration,
  environment: RuntimeEnvironment = process.env,
  identity: CompanyRecordsProductionIdentity = defaultProductionIdentity(),
  dependencies: CompanyRecordsProductionDependencies = defaultDependencies,
) {
  assertCompanyRecordsProductionIdentity(configuration, environment, identity);
  if (request.action === "plan-migration") return { ok: true, enabled: productionEnabled(environment), plan: planCompanyRecordsProductionMigration(configuration) };
  if (request.action === "apply-migration") {
    requireProductionEnabled(environment);
    const plan = planCompanyRecordsProductionMigration(configuration);
    if (request.confirmation_hash !== plan.confirmation_hash) throw new CompanyRecordsRehearsalError("confirmation-mismatch", "Migration confirmation does not match the current exact production plan", 409);
    const receipt = await dependencies.prepareDatabase();
    return { ok: true, applied: true, operation: "migrate", confirmation_hash: request.confirmation_hash, receipt, provider_effects: [], credentials_retained: false };
  }
  if (request.action === "status") {
    return {
      ok: true,
      operation: "status",
      enabled: productionEnabled(environment),
      scheduler_enabled: schedulerEnabled(environment),
      source_id: request.source_id,
      ...await dependencies.inspectStatus(configuration, request.source_id),
    };
  }
  const operation = request.action.endsWith("reconcile") ? "reconcile" : "sync";
  const planned = planCompanyRecordsProductionSourceOperation(configuration, request.source_id, operation);
  if (request.action === "plan-sync" || request.action === "plan-reconcile") {
    return { ok: true, enabled: productionEnabled(environment), plan: planned.plan };
  }
  if (!("confirmation_hash" in request)) throw new CompanyRecordsRehearsalError("invalid-request", "Apply action requires a confirmation hash");
  requireProductionEnabled(environment);
  if (request.confirmation_hash !== planned.plan.confirmation_hash) throw new CompanyRecordsRehearsalError("confirmation-mismatch", `${operation} confirmation does not match the current exact production plan`, 409);
  const runId = `${operation}-confirmed-${request.confirmation_hash.slice(0, 32)}`;
  const prior = await dependencies.inspectReceipt(configuration.instance_id, request.source_id, runId);
  if (prior) {
    return {
      ok: true,
      applied: false,
      reused: true,
      operation,
      source_id: request.source_id,
      receipt: prior,
      credentials_retained: false,
      provider_effects: [],
    };
  }
  const result = await dependencies.runSourceOperation({
    configuration,
    sourceId: request.source_id,
    operation,
    runId,
    leaseOwner: `runner-production-operator:${randomUUID()}`,
  });
  return {
    ok: true,
    applied: true,
    operation,
    source_id: request.source_id,
    receipt: result.receipt,
    provider_evidence: result.provider_evidence,
    credentials_retained: false,
    provider_effects: [],
  };
}

const weekdayNumber = new Map([
  ["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6], ["Sun", 7],
]);

function localClock(now: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: weekdayNumber.get(parts.weekday) ?? 0,
  };
}

export function companyRecordsScheduleDue(schedule: CompanyRecordsReconciliationSchedule, now: Date): { due: boolean; service_date: string } {
  const local = localClock(now, schedule.time_zone);
  const [hour, minute] = schedule.local_time.split(":").map(Number);
  const scheduledMinute = hour! * 60 + minute!;
  return {
    due: schedule.weekdays.includes(local.weekday)
      && local.minute >= scheduledMinute
      && local.minute <= scheduledMinute + schedule.max_lateness_minutes,
    service_date: local.date,
  };
}

export async function runCompanyRecordsScheduledReconciliation(args: {
  configuration: CompanyRecordsProductionConfiguration;
  environment?: RuntimeEnvironment;
  identity?: CompanyRecordsProductionIdentity;
  now?: Date;
  dependencies?: CompanyRecordsProductionDependencies;
}): Promise<{ ok: boolean; enabled: boolean; scheduler_enabled: boolean; results: ScheduledReconciliationResult[] }> {
  const environment = args.environment ?? process.env;
  const identity = args.identity ?? defaultProductionIdentity();
  const dependencies = args.dependencies ?? defaultDependencies;
  assertCompanyRecordsProductionIdentity(args.configuration, environment, identity);
  requireProductionEnabled(environment);
  if (!schedulerEnabled(environment)) throw new CompanyRecordsRehearsalError("scheduler-disabled", "Company Records scheduler is disabled", 403);
  const now = args.now ?? new Date();
  const results: ScheduledReconciliationResult[] = [];
  for (const schedule of args.configuration.reconciliation ?? []) {
    const due = companyRecordsScheduleDue(schedule, now);
    if (!due.due) {
      results.push({ source_id: schedule.source_id, service_date: due.service_date, status: "not-due" });
      continue;
    }
    const runId = `reconcile-scheduled-${schedule.source_id}-${due.service_date}-${companyRecordsConfigurationDigest(args.configuration).slice(0, 12)}`;
    const prior = await dependencies.inspectReceipt(args.configuration.instance_id, schedule.source_id, runId);
    if (prior) {
      results.push({ source_id: schedule.source_id, service_date: due.service_date, status: "already-completed" });
      continue;
    }
    try {
      const applied = await dependencies.runSourceOperation({
        configuration: args.configuration,
        sourceId: schedule.source_id,
        operation: "reconcile",
        runId,
        leaseOwner: `runner-production-scheduler:${randomUUID()}`,
      });
      results.push({ source_id: schedule.source_id, service_date: due.service_date, status: "completed", receipt: applied.receipt as Record<string, unknown> });
    } catch (error) {
      results.push({ source_id: schedule.source_id, service_date: due.service_date, status: "failed", error_digest: sha256(error instanceof Error ? error.message : String(error)) });
    }
  }
  return {
    ok: results.every((result) => result.status !== "failed"),
    enabled: true,
    scheduler_enabled: true,
    results,
  };
}
