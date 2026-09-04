import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { JsonValue } from "../../../capabilities/contracts.ts";
import { validateJsonSchemaValue } from "../../../capabilities/validation.ts";
import {
  MONDAY_RECORD_SOURCE_CONNECTOR_ID,
  MONDAY_RECORD_SOURCE_CONNECTOR_VERSION,
  MondayRecordSourceConnector,
} from "../../../connectors/monday/records-source.ts";
import { SlackRecordSourceConnector } from "../../../connectors/slack/records-source.ts";
import {
  qualifySlackRecordSource,
  type SlackRecordSourceQualification,
} from "../../../connectors/slack/record-source-qualification.ts";
import { MondayClient } from "../../../connectors/monday/client.ts";
import {
  createMondayExternalAgentQualificationEvidence,
  MONDAY_EXTERNAL_AGENT_API_VERSION,
  type MondayAgentBoardAccessExpectation,
} from "../../../connectors/monday/external-agent-qualification.ts";
import type {
  CompanyRecordProjectionDeclaration,
  CompanyRecordSourceDeclaration,
} from "../../../records/contracts.ts";
import { CompanyRecordsRegistry } from "../../../records/registry.ts";
import type { CompanyRecordSourceBinding } from "../../../records/source-connector.ts";
import { RecordSourceConnectorRegistry } from "../../../records/source-connector.ts";
import { synchronizeRecordSnapshot } from "../../../records/synchronization.ts";
import SOURCE_SCHEMA from "../../../schema/company-record-source-v1.schema.json" with { type: "json" };
import BINDING_SCHEMA from "../../../schema/company-record-source-binding-v1.schema.json" with { type: "json" };
import PROJECTION_SCHEMA from "../../../schema/company-record-projection-v1.schema.json" with { type: "json" };
import { scanCredentialIndicators } from "../../../security/credential-scanner.ts";
import { prepareCompanyDatabase } from "../../../state-postgres/database-bootstrap.ts";
import {
  createPostgresCompanyRecordsStore,
  inspectPostgresCompanyRecordProjectionStatus,
  inspectPostgresCompanyRecordSourceStatus,
} from "../../../state-postgres/records-store.ts";

export const COMPANY_RECORDS_REHEARSAL_CONFIG_ENV = "COMPANYOS_RECORDS_REHEARSAL_CONFIG_GZIP_BASE64";
export const COMPANY_RECORDS_REHEARSAL_SECRET_ENV = "COMPANYOS_RECORDS_REHEARSAL_SECRET";

type JsonObject = Record<string, unknown>;
type RehearsalEnvironment = Readonly<Record<string, string | undefined>>;
export type CompanyRecordsRuntimeEnvironment = "preview" | "production";

export interface CompanyRecordsReconciliationSchedule {
  readonly source_id: string;
  readonly time_zone: string;
  readonly local_time: string;
  readonly weekdays: readonly number[];
  readonly max_lateness_minutes: number;
}

export interface CompanyRecordsRuntimeConfiguration<Environment extends CompanyRecordsRuntimeEnvironment = CompanyRecordsRuntimeEnvironment> {
  readonly version: 1;
  readonly environment: Environment;
  readonly instance_id: string;
  readonly core: {
    readonly repository: string;
    readonly ref: string;
    readonly core_version: string;
    readonly workbench_version: string;
    readonly clean: true;
  };
  readonly workspace: { readonly repository: string; readonly ref: string };
  readonly source_confirmations: Readonly<Record<string, string>>;
  readonly sources: readonly JsonObject[];
  readonly projections: readonly JsonObject[];
  readonly bindings: readonly {
    readonly source_id: string;
    readonly binding: JsonObject;
    readonly qualification: JsonObject;
  }[];
  readonly reconciliation?: readonly CompanyRecordsReconciliationSchedule[];
}

export type CompanyRecordsRehearsalConfiguration = CompanyRecordsRuntimeConfiguration<"preview">;

export type CompanyRecordsRehearsalRequest =
  | { readonly action: "plan-migration" }
  | { readonly action: "apply-migration"; readonly confirmation_hash: string }
  | { readonly action: "plan-sync"; readonly source_id: string }
  | { readonly action: "apply-sync"; readonly source_id: string; readonly confirmation_hash: string }
  | { readonly action: "status"; readonly source_id: string }
  | { readonly action: "inspect-identities"; readonly source_id: string }
  | {
      readonly action: "plan-monday-qualification";
      readonly agent_id: string;
      readonly boards: readonly MondayAgentBoardAccessExpectation[];
      readonly qualification_plan_hash: string;
    }
  | {
      readonly action: "apply-monday-qualification";
      readonly agent_id: string;
      readonly boards: readonly MondayAgentBoardAccessExpectation[];
      readonly qualification_plan_hash: string;
      readonly confirmation_hash: string;
    }
  | { readonly action: "plan-slack-qualification"; readonly source_id: string }
  | { readonly action: "apply-slack-qualification"; readonly source_id: string; readonly confirmation_hash: string };

export class CompanyRecordsRehearsalError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "CompanyRecordsRehearsalError";
    this.code = code;
    this.status = status;
  }
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const object = (value: unknown, label: string): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CompanyRecordsRehearsalError("invalid-configuration", `${label} must be an object`);
  return value as JsonObject;
};
const string = (value: unknown, label: string, pattern?: RegExp): string => {
  if (typeof value !== "string" || value.trim() === "" || (pattern && !pattern.test(value))) throw new CompanyRecordsRehearsalError("invalid-configuration", `${label} is invalid`);
  return value;
};
const exactKeys = (value: JsonObject, allowed: readonly string[], label: string): void => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new CompanyRecordsRehearsalError("invalid-configuration", `${label} contains unsupported fields`);
};
const credentialField = /^(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|database[_-]?url|password|passwd|private[_-]?key|secret|token)$/i;
const findCredentialField = (value: unknown, path = "configuration"): string | undefined => {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findCredentialField(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (credentialField.test(key)) return `${path}.${key}`;
    const found = findCredentialField(child, `${path}.${key}`);
    if (found) return found;
  }
  return undefined;
};

export function authorizeCompanyRecordsRehearsal(request: Request, secret = process.env[COMPANY_RECORDS_REHEARSAL_SECRET_ENV]): boolean {
  if (!secret) return false;
  const provided = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function decodeCompanyRecordsRuntimeConfiguration<Environment extends CompanyRecordsRuntimeEnvironment>(
  encoded: string | undefined,
  expectedEnvironment: Environment,
  environmentVariable: string,
): CompanyRecordsRuntimeConfiguration<Environment> {
  if (!encoded) throw new CompanyRecordsRehearsalError("missing-configuration", `${environmentVariable} is not configured`, 503);
  let parsed: unknown;
  try { parsed = JSON.parse(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8")); }
  catch { throw new CompanyRecordsRehearsalError("invalid-configuration", `${environmentVariable} is malformed`, 503); }
  const value = object(parsed, "Company Records runtime configuration");
  const credentialPath = findCredentialField(value);
  if (credentialPath || scanCredentialIndicators(JSON.stringify(value)).length > 0) {
    throw new CompanyRecordsRehearsalError("credential-in-configuration", "Company Records runtime configuration must contain SecretRefs, never resolved credentials", 503);
  }
  exactKeys(value, ["version", "environment", "instance_id", "core", "workspace", "source_confirmations", "sources", "projections", "bindings", "reconciliation"], "Company Records runtime configuration");
  if (value.version !== 1 || value.environment !== expectedEnvironment) throw new CompanyRecordsRehearsalError("invalid-configuration", `Company Records runtime configuration must select version 1 and ${expectedEnvironment}`, 503);
  const instanceId = string(value.instance_id, "instance_id", /^[a-z][a-z0-9-]{1,62}$/);
  const core = object(value.core, "core");
  exactKeys(core, ["repository", "ref", "core_version", "workbench_version", "clean"], "core");
  const workspace = object(value.workspace, "workspace");
  exactKeys(workspace, ["repository", "ref"], "workspace");
  const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
  const sha = /^[0-9a-f]{40}$/;
  const coreIdentity = {
    repository: string(core.repository, "core.repository", /^[A-Za-z0-9._/-]{3,255}$/),
    ref: string(core.ref, "core.ref", sha),
    core_version: string(core.core_version, "core.core_version", semver),
    workbench_version: string(core.workbench_version, "core.workbench_version", semver),
    clean: true as const,
  };
  if (core.clean !== true) throw new CompanyRecordsRehearsalError("invalid-configuration", "core.clean must be true", 503);
  const workspaceIdentityValue = {
    repository: string(workspace.repository, "workspace.repository", /^[A-Za-z0-9._/-]{3,255}$/),
    ref: string(workspace.ref, "workspace.ref", sha),
  };
  const confirmations = object(value.source_confirmations, "source_confirmations");
  for (const [sourceId, confirmation] of Object.entries(confirmations)) {
    string(sourceId, "source confirmation id", /^[a-z][a-z0-9-]{1,62}$/);
    string(confirmation, `source_confirmations.${sourceId}`, /^[0-9a-f]{64}$/);
  }
  if (!Array.isArray(value.sources) || value.sources.length === 0 || value.sources.length > 20) throw new CompanyRecordsRehearsalError("invalid-configuration", "sources must contain between 1 and 20 declarations", 503);
  if (!Array.isArray(value.projections) || value.projections.length === 0 || value.projections.length > 100) throw new CompanyRecordsRehearsalError("invalid-configuration", "projections must contain between 1 and 100 declarations", 503);
  if (!Array.isArray(value.bindings) || value.bindings.length === 0 || value.bindings.length > 20) throw new CompanyRecordsRehearsalError("invalid-configuration", "bindings must contain between 1 and 20 entries", 503);
  const sources = value.sources.map((entry, index) => object(entry, `sources[${index}]`));
  const projections = value.projections.map((entry, index) => object(entry, `projections[${index}]`));
  const bindings = value.bindings.map((entry, index) => {
    const candidate = object(entry, `bindings[${index}]`);
    exactKeys(candidate, ["source_id", "binding", "qualification"], `bindings[${index}]`);
    const sourceId = string(candidate.source_id, `bindings[${index}].source_id`, /^[a-z][a-z0-9-]{1,62}$/);
    return { source_id: sourceId, binding: object(candidate.binding, `bindings[${index}].binding`), qualification: object(candidate.qualification, `bindings[${index}].qualification`) };
  });
  const sourceIds = sources.map((source, index) => string(source.id, `sources[${index}].id`, /^[a-z][a-z0-9-]{1,62}$/));
  if (new Set(sourceIds).size !== sourceIds.length || new Set(bindings.map((entry) => entry.source_id)).size !== bindings.length) throw new CompanyRecordsRehearsalError("invalid-configuration", "Source and binding ids must be unique", 503);
  for (const sourceId of sourceIds) {
    if (!confirmations[sourceId]) throw new CompanyRecordsRehearsalError("invalid-configuration", `Source '${sourceId}' has no confirmation evidence`, 503);
    const bound = bindings.find((entry) => entry.source_id === sourceId);
    if (!bound || bound.binding.source_id !== sourceId) throw new CompanyRecordsRehearsalError("invalid-configuration", `Source '${sourceId}' has no exact binding`, 503);
  }
  if (expectedEnvironment === "preview" && value.reconciliation !== undefined) {
    throw new CompanyRecordsRehearsalError("invalid-configuration", "Preview rehearsal configuration cannot activate reconciliation schedules", 503);
  }
  const reconciliation = value.reconciliation === undefined
    ? undefined
    : (() => {
        if (!Array.isArray(value.reconciliation) || value.reconciliation.length > 20) {
          throw new CompanyRecordsRehearsalError("invalid-configuration", "reconciliation must contain at most twenty schedules", 503);
        }
        const schedules = value.reconciliation.map((entry, index) => {
          const candidate = object(entry, `reconciliation[${index}]`);
          exactKeys(candidate, ["source_id", "time_zone", "local_time", "weekdays", "max_lateness_minutes"], `reconciliation[${index}]`);
          const sourceId = string(candidate.source_id, `reconciliation[${index}].source_id`, /^[a-z][a-z0-9-]{1,62}$/);
          if (!sourceIds.includes(sourceId)) throw new CompanyRecordsRehearsalError("invalid-configuration", `Reconciliation schedule selects unknown source '${sourceId}'`, 503);
          const timeZone = string(candidate.time_zone, `reconciliation[${index}].time_zone`, /^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+$/);
          try { new Intl.DateTimeFormat("en", { timeZone }).format(new Date(0)); }
          catch { throw new CompanyRecordsRehearsalError("invalid-configuration", `Reconciliation schedule time zone '${timeZone}' is invalid`, 503); }
          const localTime = string(candidate.local_time, `reconciliation[${index}].local_time`, /^(?:[01]\d|2[0-3]):[0-5]\d$/);
          if (!Array.isArray(candidate.weekdays) || candidate.weekdays.length === 0 || candidate.weekdays.some((day) => !Number.isInteger(day) || Number(day) < 1 || Number(day) > 7)) {
            throw new CompanyRecordsRehearsalError("invalid-configuration", `reconciliation[${index}].weekdays must contain ISO weekdays 1 through 7`, 503);
          }
          if (!Number.isInteger(candidate.max_lateness_minutes) || Number(candidate.max_lateness_minutes) < 0 || Number(candidate.max_lateness_minutes) > 1_440) {
            throw new CompanyRecordsRehearsalError("invalid-configuration", `reconciliation[${index}].max_lateness_minutes must be between 0 and 1440`, 503);
          }
          const [hour, minute] = localTime.split(":").map(Number);
          if (hour! * 60 + minute! + Number(candidate.max_lateness_minutes) >= 1_440) {
            throw new CompanyRecordsRehearsalError("invalid-configuration", `reconciliation[${index}] may not cross a local service-day boundary`, 503);
          }
          return {
            source_id: sourceId,
            time_zone: timeZone,
            local_time: localTime,
            weekdays: [...new Set((candidate.weekdays as number[]).map(Number))].sort((left, right) => left - right),
            max_lateness_minutes: Number(candidate.max_lateness_minutes),
          };
        });
        if (new Set(schedules.map((schedule) => schedule.source_id)).size !== schedules.length) {
          throw new CompanyRecordsRehearsalError("invalid-configuration", "Each source may have at most one reconciliation schedule", 503);
        }
        return schedules;
      })();
  return {
    version: 1,
    environment: expectedEnvironment,
    instance_id: instanceId,
    core: coreIdentity,
    workspace: workspaceIdentityValue,
    source_confirmations: confirmations as Record<string, string>,
    sources,
    projections,
    bindings,
    ...(reconciliation ? { reconciliation } : {}),
  };
}

export function decodeCompanyRecordsRehearsalConfiguration(encoded = process.env[COMPANY_RECORDS_REHEARSAL_CONFIG_ENV]): CompanyRecordsRehearsalConfiguration {
  return decodeCompanyRecordsRuntimeConfiguration(encoded, "preview", COMPANY_RECORDS_REHEARSAL_CONFIG_ENV);
}

export function parseCompanyRecordsRehearsalRequest(value: unknown): CompanyRecordsRehearsalRequest {
  const input = object(value, "request");
  const action = string(input.action, "request.action");
  const migrationActions = new Set(["plan-migration", "apply-migration"]);
  const sourceActions = new Set(["plan-sync", "apply-sync", "status", "inspect-identities"]);
  const mondayQualificationActions = new Set(["plan-monday-qualification", "apply-monday-qualification"]);
  const slackQualificationActions = new Set(["plan-slack-qualification", "apply-slack-qualification"]);
  if (!migrationActions.has(action) && !sourceActions.has(action) && !mondayQualificationActions.has(action) && !slackQualificationActions.has(action)) throw new CompanyRecordsRehearsalError("invalid-request", "Unsupported rehearsal action");
  const allowedKeys = action === "plan-migration"
    ? ["action"]
    : action === "apply-migration"
      ? ["action", "confirmation_hash"]
      : action === "plan-monday-qualification"
        ? ["action", "agent_id", "boards", "qualification_plan_hash"]
      : action === "apply-monday-qualification"
          ? ["action", "agent_id", "boards", "qualification_plan_hash", "confirmation_hash"]
      : action === "apply-slack-qualification"
        ? ["action", "source_id", "confirmation_hash"]
      : action === "apply-sync"
        ? ["action", "source_id", "confirmation_hash"]
        : ["action", "source_id"];
  exactKeys(input, allowedKeys, "request");
  const confirmationHash = action.startsWith("apply-") ? string(input.confirmation_hash, "request.confirmation_hash", /^[0-9a-f]{64}$/) : undefined;
  const sourceId = sourceActions.has(action) || slackQualificationActions.has(action)
    ? string(input.source_id, "request.source_id", /^[a-z][a-z0-9-]{1,62}$/)
    : undefined;
  if (mondayQualificationActions.has(action)) {
    const agentId = string(input.agent_id, "request.agent_id", /^\d{1,20}$/);
    const qualificationPlanHash = string(input.qualification_plan_hash, "request.qualification_plan_hash", /^[0-9a-f]{64}$/);
    if (!Array.isArray(input.boards) || input.boards.length === 0 || input.boards.length > 20) {
      throw new CompanyRecordsRehearsalError("invalid-request", "request.boards must contain between one and twenty exact board-access expectations");
    }
    const seen = new Set<string>();
    const boards: MondayAgentBoardAccessExpectation[] = input.boards.map((entry, index) => {
      const board = object(entry, `request.boards[${index}]`);
      exactKeys(board, ["id", "permission"], `request.boards[${index}]`);
      const id = string(board.id, `request.boards[${index}].id`, /^\d{1,20}$/);
      const permission = string(board.permission, `request.boards[${index}].permission`);
      if (permission !== "read" && permission !== "read-write") throw new CompanyRecordsRehearsalError("invalid-request", `request.boards[${index}].permission must be read or read-write`);
      if (seen.has(id)) throw new CompanyRecordsRehearsalError("invalid-request", `request.boards contains duplicate board '${id}'`);
      seen.add(id);
      return { id, permission: permission as "read" | "read-write" };
    }).sort((left, right) => left.id.localeCompare(right.id));
    if (action === "plan-monday-qualification") return { action: "plan-monday-qualification", agent_id: agentId, boards, qualification_plan_hash: qualificationPlanHash };
    return { action: "apply-monday-qualification", agent_id: agentId, boards, qualification_plan_hash: qualificationPlanHash, confirmation_hash: confirmationHash! };
  }
  if (action === "plan-migration") return { action };
  if (action === "apply-migration") return { action, confirmation_hash: confirmationHash! };
  if (action === "plan-slack-qualification") return { action, source_id: sourceId! };
  if (action === "apply-slack-qualification") return { action, source_id: sourceId!, confirmation_hash: confirmationHash! };
  if (action === "plan-sync") return { action, source_id: sourceId! };
  if (action === "apply-sync") return { action, source_id: sourceId!, confirmation_hash: confirmationHash! };
  if (action === "inspect-identities") return { action, source_id: sourceId! };
  return { action: "status", source_id: sourceId! };
}

export const companyRecordsConfigurationDigest = (configuration: CompanyRecordsRuntimeConfiguration): string => sha256(JSON.stringify(configuration));
export const companyRecordsWorkspaceIdentity = (configuration: CompanyRecordsRuntimeConfiguration): string => `${configuration.workspace.repository}@${configuration.workspace.ref}`;

export function planCompanyRecordsPreviewMigration(configuration: CompanyRecordsRehearsalConfiguration) {
  const plan = {
    schema_version: 1,
    kind: "company-records-preview-migration",
    environment: "preview",
    instance_id: configuration.instance_id,
    core: configuration.core,
    workspace: companyRecordsWorkspaceIdentity(configuration),
    configuration_digest: companyRecordsConfigurationDigest(configuration),
    source_confirmations: configuration.source_confirmations,
    database_secret_ref: "env:DATABASE_URL",
    database_effect: "Prepare and qualify the complete additive Company Instance database manifest, including companyos_records, in the isolated preview database branch.",
    provider_effects: [],
    production_effects: [],
  };
  return { ...plan, confirmation_hash: sha256(JSON.stringify(plan)) };
}

export function planCompanyRecordsPreviewMondayQualification(
  configuration: CompanyRecordsRehearsalConfiguration,
  request: Extract<CompanyRecordsRehearsalRequest, { action: "plan-monday-qualification" | "apply-monday-qualification" }>,
) {
  const plan = {
    schema_version: 1,
    kind: "company-records-preview-monday-agent-qualification",
    environment: "preview",
    instance_id: configuration.instance_id,
    core: configuration.core,
    workspace: companyRecordsWorkspaceIdentity(configuration),
    qualification_plan_hash: request.qualification_plan_hash,
    agent_id: request.agent_id,
    boards: request.boards,
    provider_secret_ref: "env:MONDAY_API_TOKEN",
    provider_access: "external-agent-identity-and-selected-board-metadata-only",
    provider_effects: [],
    database_effects: [],
    production_effects: [],
    external_changes: [
      "Read the authenticated Monday external-Agent identity and account metadata.",
      "Read metadata and effective access for only the exact selected boards.",
      "Do not create or modify a Monday Agent, grant, board, group, column, item, update, webhook, Workspace file, database, deployment, schedule, or production state.",
    ],
  };
  return { ...plan, confirmation_hash: sha256(JSON.stringify(plan)) };
}

function selectedSlackQualificationBinding(configuration: CompanyRecordsRehearsalConfiguration, sourceId: string) {
  const sourceValue = configuration.sources.find((candidate) => candidate.id === sourceId);
  const bindingEntry = configuration.bindings.find((candidate) => candidate.source_id === sourceId);
  if (!sourceValue || !bindingEntry || !configuration.source_confirmations[sourceId]) {
    throw new CompanyRecordsRehearsalError("unknown-source", `Unknown confirmed source '${sourceId}'`, 404);
  }
  const messages = [
    ...schemaErrors(SOURCE_SCHEMA, sourceValue, `source '${sourceId}'`),
    ...schemaErrors(BINDING_SCHEMA, bindingEntry.binding, `binding '${sourceId}'`),
  ];
  if (messages.length > 0) throw new CompanyRecordsRehearsalError("invalid-declaration", messages[0]!, 503);
  const source = sourceValue as unknown as CompanyRecordSourceDeclaration;
  const binding = bindingEntry.binding as unknown as CompanyRecordSourceBinding;
  if (source.record_type !== "communication-message") throw new CompanyRecordsRehearsalError("invalid-declaration", `Slack source '${sourceId}' must use record_type 'communication-message'`, 503);
  if (binding.instance_id !== configuration.instance_id || binding.source_id !== source.id || binding.resource_binding !== source.resource_binding) {
    throw new CompanyRecordsRehearsalError("binding-mismatch", `Binding for source '${sourceId}' does not match the rehearsal Instance and declaration`, 503);
  }
  if (binding.connector !== "oregano/slack-record-source" || binding.connector_version !== "0.1.0") {
    throw new CompanyRecordsRehearsalError("invalid-declaration", `Source '${sourceId}' does not select the maintained Slack Record Source Connector`, 503);
  }
  const provider = object(binding.configuration, `binding '${sourceId}'.configuration`);
  exactKeys(provider, ["team_id", "channel_id", "conversation_kind", "oldest_at", "latest_at", "include_threads", "page_size", "max_pages", "max_thread_pages", "max_messages"], `binding '${sourceId}'.configuration`);
  const teamId = string(provider.team_id, `binding '${sourceId}'.configuration.team_id`, /^[A-Z][A-Z0-9]{4,31}$/);
  const channelId = string(provider.channel_id, `binding '${sourceId}'.configuration.channel_id`, /^[CG][A-Z0-9]{4,31}$/);
  const conversationKind = string(provider.conversation_kind, `binding '${sourceId}'.configuration.conversation_kind`);
  if (conversationKind !== "public-channel" && conversationKind !== "private-channel") {
    throw new CompanyRecordsRehearsalError("invalid-declaration", `binding '${sourceId}'.configuration.conversation_kind is invalid`, 503);
  }
  return { source, binding, teamId, channelId, conversationKind };
}

export function planCompanyRecordsPreviewSlackQualification(configuration: CompanyRecordsRehearsalConfiguration, sourceId: string) {
  const selected = selectedSlackQualificationBinding(configuration, sourceId);
  const plan = {
    schema_version: 1,
    kind: "company-records-preview-slack-source-qualification",
    environment: "preview",
    instance_id: configuration.instance_id,
    core: configuration.core,
    workspace: companyRecordsWorkspaceIdentity(configuration),
    source_id: sourceId,
    resource_binding: selected.binding.resource_binding,
    connector: `${selected.binding.connector}@${selected.binding.connector_version}`,
    provider_secret_ref: selected.binding.secret_ref,
    team_id: selected.teamId,
    channel_id: selected.channelId,
    conversation_kind: selected.conversationKind,
    provider_access: "authenticated-bot-identity-and-selected-conversation-metadata-only",
    provider_effects: [],
    database_effects: [],
    production_effects: [],
    external_changes: [
      "Read the authenticated Slack bot and team identity.",
      "Read metadata and membership for only the exact selected conversation.",
      "Do not read message history or modify Slack, permissions, Workspace files, databases, deployments, schedules, or production state.",
    ],
  };
  return { ...plan, confirmation_hash: sha256(JSON.stringify(plan)) };
}

const schemaErrors = (schema: object, value: unknown, label: string): string[] => validateJsonSchemaValue(schema as never, value).map((message) => `${label}: ${message}`);
const projectionPaths = (projection: CompanyRecordProjectionDeclaration): string[] => [...Object.keys(projection.selection ?? {}), ...projection.fields.map((field) => field.path)];

const resolveEnvironmentSecretRef = (secretRef: string): string => {
  const match = /^env:([A-Z][A-Z0-9_]{0,127})$/.exec(secretRef);
  if (!match) throw new Error(`Unsupported runtime SecretRef '${secretRef}'`);
  const value = process.env[match[1]!];
  if (!value) throw new Error(`Runtime SecretRef '${secretRef}' is unavailable`);
  return value;
};

export function validatedCompanyRecordsSelection(configuration: CompanyRecordsRuntimeConfiguration, sourceId: string) {
  const sourceValue = configuration.sources.find((candidate) => candidate.id === sourceId);
  const bindingEntry = configuration.bindings.find((candidate) => candidate.source_id === sourceId);
  if (!sourceValue || !bindingEntry || !configuration.source_confirmations[sourceId]) throw new CompanyRecordsRehearsalError("unknown-source", `Unknown confirmed source '${sourceId}'`, 404);
  const projectionValues = configuration.projections.filter((candidate) => candidate.record_type === sourceValue.record_type && (candidate.selection as JsonObject | undefined)?.source_id === sourceId);
  const messages = [
    ...schemaErrors(SOURCE_SCHEMA, sourceValue, `source '${sourceId}'`),
    ...schemaErrors(BINDING_SCHEMA, bindingEntry.binding, `binding '${sourceId}'`),
    ...projectionValues.flatMap((projection) => schemaErrors(PROJECTION_SCHEMA, projection, `projection '${String(projection.id)}'`)),
  ];
  if (messages.length > 0) throw new CompanyRecordsRehearsalError("invalid-declaration", messages[0]!, 503);
  const source = sourceValue as unknown as CompanyRecordSourceDeclaration;
  const binding = bindingEntry.binding as unknown as CompanyRecordSourceBinding;
  if (binding.instance_id !== configuration.instance_id || binding.source_id !== source.id || binding.resource_binding !== source.resource_binding) throw new CompanyRecordsRehearsalError("binding-mismatch", `Binding for source '${sourceId}' does not match the rehearsal Instance and declaration`, 503);
  const targets = new Set(source.fields.map((field) => field.target));
  const projections = projectionValues as unknown as CompanyRecordProjectionDeclaration[];
  for (const projection of projections) {
    for (const path of projectionPaths(projection)) {
      if (!targets.has(path.split(".")[0]!)) throw new CompanyRecordsRehearsalError("invalid-declaration", `Projection '${projection.id}' path '${path}' is not materialized by source '${source.id}'`, 503);
    }
  }
  const registry = new CompanyRecordsRegistry();
  for (const candidate of configuration.sources) {
    const candidateMessages = schemaErrors(SOURCE_SCHEMA, candidate, `source '${String(candidate.id)}'`);
    if (candidateMessages.length > 0) throw new CompanyRecordsRehearsalError("invalid-declaration", candidateMessages[0]!, 503);
    registry.registerSource(candidate as unknown as CompanyRecordSourceDeclaration);
  }
  for (const candidate of configuration.projections) {
    const candidateMessages = schemaErrors(PROJECTION_SCHEMA, candidate, `projection '${String(candidate.id)}'`);
    if (candidateMessages.length > 0) throw new CompanyRecordsRehearsalError("invalid-declaration", candidateMessages[0]!, 503);
    registry.registerProjection(candidate as unknown as CompanyRecordProjectionDeclaration);
  }
  const connectors = new RecordSourceConnectorRegistry([
    new MondayRecordSourceConnector({ resolveSecret: resolveEnvironmentSecretRef }),
    new SlackRecordSourceConnector({ resolveSecret: resolveEnvironmentSecretRef }),
  ]);
  connectors.validate(source, binding, bindingEntry.qualification);
  return { source, binding, qualification: bindingEntry.qualification, projections, registry, connectors };
}

export function planCompanyRecordsPreviewSync(configuration: CompanyRecordsRehearsalConfiguration, sourceId: string) {
  const selected = validatedCompanyRecordsSelection(configuration, sourceId);
  const plan = {
    schema_version: 1,
    kind: "company-record-source-operation",
    operation: "sync",
    environment: "preview",
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
    database_effect: "Append immutable observations, update current pointers and projections, and advance the watermark; do not infer provider deletion.",
    rehearsal: { configuration_digest: companyRecordsConfigurationDigest(configuration), workspace_ref: configuration.workspace.ref, source_confirmation_hash: configuration.source_confirmations[sourceId] },
    external_changes: [
      "Read the exact provider resource through the selected read-only Record Source Connector.",
      "Write idempotent Company Records observations and projections to the isolated preview database without deleting missing records.",
      "Do not modify provider objects, provider permissions, Workspace files, Git, schedules, webhooks, or production.",
    ],
  };
  return { plan: { ...plan, confirmation_hash: sha256(JSON.stringify(plan)) }, selected };
}

function assertPreviewIdentity(configuration: CompanyRecordsRehearsalConfiguration, environment: RehearsalEnvironment): void {
  if (environment.VERCEL_ENV !== "preview") throw new CompanyRecordsRehearsalError("preview-only", "Company Records rehearsal runs only in a Vercel Preview deployment", 403);
  if (!environment.VERCEL_GIT_COMMIT_SHA || environment.VERCEL_GIT_COMMIT_SHA !== configuration.core.ref) throw new CompanyRecordsRehearsalError("core-identity-mismatch", "Preview deployment does not match the configured exact Core commit", 409);
}

interface RehearsalDependencies {
  ensureSchema(): Promise<Record<string, unknown> | void>;
  planOperation(configuration: CompanyRecordsRehearsalConfiguration, sourceId: string): ReturnType<typeof planCompanyRecordsPreviewSync>;
  runOperation(configuration: CompanyRecordsRehearsalConfiguration, sourceId: string, confirmationHash: string): Promise<Record<string, unknown>>;
  inspectStatus(configuration: CompanyRecordsRehearsalConfiguration, sourceId: string): Promise<Record<string, unknown>>;
  inspectIdentities(configuration: CompanyRecordsRehearsalConfiguration, sourceId: string): Promise<Record<string, unknown>>;
  qualifyMonday(input: {
    readonly agentId: string;
    readonly boards: readonly MondayAgentBoardAccessExpectation[];
    readonly qualificationPlanHash: string;
  }): Promise<ReturnType<typeof createMondayExternalAgentQualificationEvidence>>;
  qualifySlack(input: { sourceId: string; binding: CompanyRecordSourceBinding; teamId: string; channelId: string }): Promise<SlackRecordSourceQualification>;
}

const defaultDependencies: RehearsalDependencies = {
  async ensureSchema() {
    return await prepareCompanyDatabase() as unknown as Record<string, unknown>;
  },
  planOperation: planCompanyRecordsPreviewSync,
  async runOperation(configuration, sourceId, confirmationHash) {
    const planned = planCompanyRecordsPreviewSync(configuration, sourceId);
    if (confirmationHash !== planned.plan.confirmation_hash) throw new CompanyRecordsRehearsalError("confirmation-mismatch", "Synchronization confirmation does not match the current exact plan", 409);
    const connector = planned.selected.connectors.resolve(planned.selected.binding);
    const inventory = await connector.readCompleteInventory({ source: planned.selected.source, binding: planned.selected.binding, qualification: planned.selected.qualification });
    if (inventory.complete !== true) throw new Error("Record Source Connector did not return a complete inventory");
    const runId = `sync-${sha256(`${confirmationHash}:${inventory.watermark}`).slice(0, 32)}`;
    const receipt = await synchronizeRecordSnapshot({
      instanceId: configuration.instance_id,
      source: planned.selected.source,
      inventory,
      registry: planned.selected.registry,
      store: createPostgresCompanyRecordsStore(),
      runId,
      leaseOwner: `runner-preview:${randomUUID()}`,
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    return { applied: true, receipt, provider_evidence: inventory.receipt, credentials_retained: false };
  },
  async inspectStatus(configuration, sourceId) {
    const selected = validatedCompanyRecordsSelection(configuration, sourceId);
    const [status, projections] = await Promise.all([
      inspectPostgresCompanyRecordSourceStatus(configuration.instance_id, sourceId),
      inspectPostgresCompanyRecordProjectionStatus(configuration.instance_id, selected.projections.map((projection) => projection.id)),
    ]);
    return { status, projections, binding: { instance_id: configuration.instance_id, connector: `${selected.binding.connector}@${selected.binding.connector_version}`, resource_binding: selected.binding.resource_binding } };
  },
  async inspectIdentities(configuration, sourceId) {
    const selected = validatedCompanyRecordsSelection(configuration, sourceId);
    const identityFields = selected.source.fields.filter((field) => field.value_type === "identity");
    if (identityFields.length === 0) throw new CompanyRecordsRehearsalError("no-identity-fields", `Source '${sourceId}' has no declared identity fields`, 409);
    const connector = selected.connectors.resolve(selected.binding);
    const inventory = await connector.readCompleteInventory({ source: selected.source, binding: selected.binding, qualification: selected.qualification });
    const readPath = (value: Record<string, JsonValue>, path: string): JsonValue | undefined => {
      let current: JsonValue | undefined = value;
      for (const segment of path.split(".")) {
        if (current === null || Array.isArray(current) || typeof current !== "object") return undefined;
        current = current[segment];
      }
      return current;
    };
    const candidates = inventory.objects.flatMap((raw) => {
      const identities = identityFields.flatMap((field) => {
        const value = readPath(raw, field.source);
        const providerIds = Array.isArray(value)
          ? value.filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0)
          : typeof value === "string" && value ? [value] : [];
        if (providerIds.length === 0) return [];
        const [root, providerColumnId] = field.source.split(".");
        const displayText = root === "columns" && providerColumnId
          ? readPath(raw, `column_text.${providerColumnId}`)
          : undefined;
        return [{ target: field.target, provider_ids: providerIds, display_text: typeof displayText === "string" ? displayText : "" }];
      });
      if (identities.length === 0) return [];
      return [{
        source_object_id: typeof raw.provider_id === "string" ? raw.provider_id : String(raw.id ?? ""),
        object_kind: typeof raw.object_kind === "string" ? raw.object_kind : "unknown",
        object_name: typeof raw.name === "string" ? raw.name : "",
        identities,
      }];
    });
    return {
      candidates,
      provider_evidence: inventory.receipt,
      credentials_retained: false,
      provider_effects: [],
      database_effects: [],
    };
  },
  async qualifyMonday(input) {
    const client = new MondayClient({
      token: resolveEnvironmentSecretRef("env:MONDAY_API_TOKEN"),
      apiVersion: MONDAY_EXTERNAL_AGENT_API_VERSION,
    });
    const result = await client.discoverAgentResources({
      agentId: input.agentId,
      boardIds: input.boards.map((board) => board.id),
    });
    return createMondayExternalAgentQualificationEvidence({
      agentId: input.agentId,
      apiVersion: MONDAY_EXTERNAL_AGENT_API_VERSION,
      boards: input.boards,
      planHash: input.qualificationPlanHash,
      result,
      observedAt: new Date().toISOString(),
    });
  },
  async qualifySlack(input) {
    return await qualifySlackRecordSource({
      token: resolveEnvironmentSecretRef(input.binding.secret_ref),
      teamId: input.teamId,
      channelId: input.channelId,
    });
  },
};

export async function executeCompanyRecordsRehearsal(request: CompanyRecordsRehearsalRequest, configuration: CompanyRecordsRehearsalConfiguration, environment: RehearsalEnvironment = process.env, dependencies: RehearsalDependencies = defaultDependencies) {
  assertPreviewIdentity(configuration, environment);
  if (request.action === "plan-monday-qualification") {
    return { ok: true, plan: planCompanyRecordsPreviewMondayQualification(configuration, request) };
  }
  if (request.action === "apply-monday-qualification") {
    const plan = planCompanyRecordsPreviewMondayQualification(configuration, request);
    if (request.confirmation_hash !== plan.confirmation_hash) throw new CompanyRecordsRehearsalError("confirmation-mismatch", "Monday qualification confirmation does not match the current exact provider-read plan", 409);
    const evidence = await dependencies.qualifyMonday({
      agentId: request.agent_id,
      boards: request.boards,
      qualificationPlanHash: request.qualification_plan_hash,
    });
    return {
      ok: true,
      applied: true,
      operation: "monday-agent-qualification-read",
      evidence,
      confirmation_hash: request.confirmation_hash,
      credentials_retained: false,
      provider_effects: [],
    };
  }
  if (request.action === "plan-slack-qualification") {
    return { ok: true, plan: planCompanyRecordsPreviewSlackQualification(configuration, request.source_id) };
  }
  if (request.action === "apply-slack-qualification") {
    const selected = selectedSlackQualificationBinding(configuration, request.source_id);
    const plan = planCompanyRecordsPreviewSlackQualification(configuration, request.source_id);
    if (request.confirmation_hash !== plan.confirmation_hash) throw new CompanyRecordsRehearsalError("confirmation-mismatch", "Slack qualification confirmation does not match the current exact provider-metadata-read plan", 409);
    const evidence = await dependencies.qualifySlack({
      sourceId: request.source_id,
      binding: selected.binding,
      teamId: selected.teamId,
      channelId: selected.channelId,
    });
    return {
      ok: true,
      applied: true,
      operation: "slack-source-qualification-read",
      source_id: request.source_id,
      evidence,
      confirmation_hash: request.confirmation_hash,
      credentials_retained: false,
      provider_effects: [],
      database_effects: [],
    };
  }
  if (request.action === "plan-migration") return { ok: true, plan: planCompanyRecordsPreviewMigration(configuration) };
  if (request.action === "apply-migration") {
    const plan = planCompanyRecordsPreviewMigration(configuration);
    if (request.confirmation_hash !== plan.confirmation_hash) throw new CompanyRecordsRehearsalError("confirmation-mismatch", "Migration confirmation does not match the current exact plan", 409);
    const receipt = await dependencies.ensureSchema();
    return { ok: true, applied: true, operation: "migrate", schema_manifest: receipt ?? null, confirmation_hash: request.confirmation_hash, provider_effects: [], credentials_retained: false };
  }
  if (request.action === "plan-sync") return { ok: true, plan: dependencies.planOperation(configuration, request.source_id).plan };
  if (request.action === "apply-sync") {
    const planned = dependencies.planOperation(configuration, request.source_id);
    if (request.confirmation_hash !== planned.plan.confirmation_hash) throw new CompanyRecordsRehearsalError("confirmation-mismatch", "Synchronization confirmation does not match the current exact plan", 409);
    const result = await dependencies.runOperation(configuration, request.source_id, request.confirmation_hash);
    return { ok: true, applied: true, operation: "sync", source_id: request.source_id, receipt: result.receipt, provider_evidence: result.provider_evidence, credentials_retained: false, provider_effects: [] };
  }
  if (request.action === "inspect-identities") {
    return { ok: true, operation: "inspect-identities", source_id: request.source_id, ...await dependencies.inspectIdentities(configuration, request.source_id) };
  }
  return { ok: true, operation: "status", source_id: request.source_id, ...await dependencies.inspectStatus(configuration, request.source_id) };
}

export const MAINTAINED_REHEARSAL_CONNECTOR = `${MONDAY_RECORD_SOURCE_CONNECTOR_ID}@${MONDAY_RECORD_SOURCE_CONNECTOR_VERSION}`;
