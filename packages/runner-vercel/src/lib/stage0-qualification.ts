import { createHmac, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { Chat } from "chat";
import type { CompanyOSArtifact } from "../../../companyos-builder/types.ts";
import { MondayWorkItemConnector } from "../../../connectors/monday/connector.ts";
import { classifyMondayBoardEventEcho } from "../../../connectors/monday/webhook.ts";
import { resolveAgent } from "../../../runtime/agent-resolver.ts";
import { sha256 } from "../../../runtime/canonical.ts";
import type { CompanyOSRuntime } from "../../../runtime/companyos-runtime.ts";
import { createPostgresChatState } from "./postgres-chat-state.ts";
import { handleMondayAgentWebhook, StateAdapterMondayReplayStore } from "./monday-agent-webhook.ts";
import { createConfiguredRuntimeConnectors } from "./runtime-connectors.ts";

export const STAGE0_CONFIGURATION_ENV = "COMPANYOS_STAGE0_CONFIG_GZIP_BASE64";
export const STAGE0_SECRET_ENV = "COMPANYOS_STAGE0_SECRET";

type JsonObject = Record<string, unknown>;

export interface Stage0Configuration {
  readonly version: 1;
  readonly environment: "preview";
  readonly instance_id: string;
  readonly requester_principal: string;
  readonly general_agent_id: string;
  readonly sprint_agent_id: string;
  readonly monday: {
    readonly resource_binding: string;
    readonly status_field: string;
    readonly candidate_status_labels: readonly string[];
    readonly account_id: string;
    readonly callback_agent_id: string;
    readonly signing_secret_ref: string;
  };
  readonly slack: {
    readonly account_id: string;
    readonly channel_id: string;
    readonly channel_destination_binding: string;
    readonly direct_destination_binding: string;
  };
}

export type Stage0Request =
  | { readonly action: "inspect" }
  | { readonly action: "test-sprint-workers"; readonly test_id: string; readonly at: string }
  | { readonly action: "plan-monday-reversible"; readonly test_id: string; readonly work_item_id?: string }
  | { readonly action: "apply-monday-reversible"; readonly test_id: string; readonly work_item_id?: string; readonly confirmation_hash: string }
  | { readonly action: "plan-slack-delivery"; readonly test_id: string; readonly channel_content: string; readonly direct_content: string }
  | { readonly action: "apply-slack-delivery"; readonly test_id: string; readonly channel_content: string; readonly direct_content: string; readonly confirmation_hash: string }
  | { readonly action: "test-callback-security"; readonly test_id: string };

export class Stage0QualificationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "Stage0QualificationError";
    this.code = code;
    this.status = status;
  }
}

const object = (value: unknown, label: string, status = 503): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Stage0QualificationError("invalid-configuration", `${label} must be an object`, status);
  return value as JsonObject;
};
const string = (value: unknown, label: string, pattern: RegExp, status = 503): string => {
  if (typeof value !== "string" || !pattern.test(value)) throw new Stage0QualificationError("invalid-configuration", `${label} is invalid`, status);
  return value;
};
const exactKeys = (value: JsonObject, allowed: readonly string[], label: string, status = 503): void => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Stage0QualificationError("invalid-configuration", `${label} contains unsupported fields`, status);
};

export function authorizeStage0(request: Request, secret = process.env[STAGE0_SECRET_ENV]): boolean {
  if (!secret) return false;
  const provided = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function decodeStage0Configuration(encoded = process.env[STAGE0_CONFIGURATION_ENV]): Stage0Configuration {
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "preview") {
    throw new Stage0QualificationError("preview-only", "Stage-0 qualification is available only in Preview", 403);
  }
  if (!encoded) throw new Stage0QualificationError("missing-configuration", `${STAGE0_CONFIGURATION_ENV} is not configured`, 503);
  let parsed: unknown;
  try { parsed = JSON.parse(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8")); }
  catch { throw new Stage0QualificationError("invalid-configuration", `${STAGE0_CONFIGURATION_ENV} is malformed`, 503); }
  const value = object(parsed, "Stage-0 configuration");
  exactKeys(value, ["version", "environment", "instance_id", "requester_principal", "general_agent_id", "sprint_agent_id", "monday", "slack"], "Stage-0 configuration");
  if (value.version !== 1 || value.environment !== "preview") throw new Stage0QualificationError("invalid-configuration", "Stage-0 configuration must select version 1 and preview", 503);
  const monday = object(value.monday, "monday");
  exactKeys(monday, ["resource_binding", "status_field", "candidate_status_labels", "account_id", "callback_agent_id", "signing_secret_ref"], "monday");
  const slack = object(value.slack, "slack");
  exactKeys(slack, ["account_id", "channel_id", "channel_destination_binding", "direct_destination_binding"], "slack");
  if (!Array.isArray(monday.candidate_status_labels) || monday.candidate_status_labels.length < 2 || monday.candidate_status_labels.length > 10) {
    throw new Stage0QualificationError("invalid-configuration", "monday.candidate_status_labels requires between two and ten labels", 503);
  }
  return {
    version: 1,
    environment: "preview",
    instance_id: string(value.instance_id, "instance_id", /^[a-z][a-z0-9-]{1,62}$/),
    requester_principal: string(value.requester_principal, "requester_principal", /^slack:[A-Z0-9]{5,32}:[A-Z0-9]{5,32}$/),
    general_agent_id: string(value.general_agent_id, "general_agent_id", /^[a-z][a-z0-9-]{1,62}$/),
    sprint_agent_id: string(value.sprint_agent_id, "sprint_agent_id", /^[a-z][a-z0-9-]{1,62}$/),
    monday: {
      resource_binding: string(monday.resource_binding, "monday.resource_binding", /^[a-z][a-z0-9-]{1,62}$/),
      status_field: string(monday.status_field, "monday.status_field", /^[a-z][a-z0-9_-]{0,62}$/),
      candidate_status_labels: monday.candidate_status_labels.map((label, index) => string(label, `monday.candidate_status_labels[${index}]`, /^.{1,64}$/u)),
      account_id: string(monday.account_id, "monday.account_id", /^\d{1,20}$/),
      callback_agent_id: string(monday.callback_agent_id, "monday.callback_agent_id", /^\d{1,20}$/),
      signing_secret_ref: string(monday.signing_secret_ref, "monday.signing_secret_ref", /^env:[A-Z][A-Z0-9_]{0,127}$/),
    },
    slack: {
      account_id: string(slack.account_id, "slack.account_id", /^[A-Z0-9]{5,32}$/),
      channel_id: string(slack.channel_id, "slack.channel_id", /^[A-Z0-9]{5,32}$/),
      channel_destination_binding: string(slack.channel_destination_binding, "slack.channel_destination_binding", /^[a-z][a-z0-9-]{1,62}$/),
      direct_destination_binding: string(slack.direct_destination_binding, "slack.direct_destination_binding", /^[a-z][a-z0-9-]{1,62}$/),
    },
  };
}

export function parseStage0Request(value: unknown): Stage0Request {
  const input = object(value, "request", 400);
  const action = string(input.action, "request.action", /^(?:inspect|test-sprint-workers|plan-monday-reversible|apply-monday-reversible|plan-slack-delivery|apply-slack-delivery|test-callback-security)$/, 400) as Stage0Request["action"];
  const allowed = action === "inspect"
    ? ["action"]
    : action === "test-sprint-workers"
      ? ["action", "test_id", "at"]
    : action === "test-callback-security"
      ? ["action", "test_id"]
      : action.includes("monday")
        ? ["action", "test_id", "work_item_id", ...(action.startsWith("apply-") ? ["confirmation_hash"] : [])]
        : ["action", "test_id", "channel_content", "direct_content", ...(action.startsWith("apply-") ? ["confirmation_hash"] : [])];
  exactKeys(input, allowed, "request", 400);
  if (action === "inspect") return { action };
  const testId = string(input.test_id, "request.test_id", /^[a-z0-9][a-z0-9-]{7,62}$/, 400);
  if (action === "test-sprint-workers") {
    const at = string(input.at, "request.at", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 400);
    if (Number.isNaN(Date.parse(at)) || new Date(at).toISOString() !== at) {
      throw new Stage0QualificationError("invalid-configuration", "request.at must be an exact ISO timestamp", 400);
    }
    return { action, test_id: testId, at };
  }
  if (action === "test-callback-security") return { action, test_id: testId };
  const confirmationHash = action.startsWith("apply-")
    ? string(input.confirmation_hash, "request.confirmation_hash", /^[0-9a-f]{64}$/, 400)
    : undefined;
  if (action.includes("monday")) {
    const workItemId = input.work_item_id === undefined ? undefined : string(input.work_item_id, "request.work_item_id", /^\d{1,20}$/, 400);
    if (action === "plan-monday-reversible") {
      return { action, test_id: testId, ...(workItemId ? { work_item_id: workItemId } : {}) };
    }
    if (action === "apply-monday-reversible") {
      return { action, test_id: testId, ...(workItemId ? { work_item_id: workItemId } : {}), confirmation_hash: confirmationHash! };
    }
  }
  const channelContent = string(input.channel_content, "request.channel_content", /^[\s\S]{1,2000}$/, 400);
  const directContent = string(input.direct_content, "request.direct_content", /^[\s\S]{1,2000}$/, 400);
  if (action === "plan-slack-delivery") {
    return { action, test_id: testId, channel_content: channelContent, direct_content: directContent };
  }
  if (action === "apply-slack-delivery") {
    return { action, test_id: testId, channel_content: channelContent, direct_content: directContent, confirmation_hash: confirmationHash! };
  }
  throw new Stage0QualificationError("invalid-configuration", "request.action is invalid", 400);
}

interface Stage0Dependencies {
  readonly artifact: CompanyOSArtifact;
  readonly runtime: CompanyOSRuntime;
  readonly chat: Chat;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly runSprintTimerWorker?: (now: string) => Promise<unknown>;
  readonly runSprintIntentWorker?: (now: string) => Promise<unknown>;
}

function assertConfigured(config: Stage0Configuration, artifact: CompanyOSArtifact): void {
  if (artifact.instance.environment !== "preview" || artifact.instance.id !== config.instance_id) {
    throw new Stage0QualificationError("artifact-mismatch", "Stage-0 configuration does not match the deployed Preview Artifact", 409);
  }
  for (const agentId of [config.general_agent_id, config.sprint_agent_id]) {
    if (!artifact.agents.some((agent) => agent.id === agentId)) throw new Stage0QualificationError("artifact-mismatch", `Stage-0 Agent '${agentId}' is absent`, 409);
  }
}

function mondayConnector(dependencies: Stage0Dependencies): MondayWorkItemConnector {
  const connector = createConfiguredRuntimeConnectors({
    artifact: dependencies.artifact,
    environment: dependencies.environment,
    chat: () => dependencies.chat,
  }).find((candidate) => candidate.id === "oregano/monday-work-items");
  if (!(connector instanceof MondayWorkItemConnector)) throw new Stage0QualificationError("connector-unavailable", "The maintained Monday work-item Connector is unavailable", 503);
  return connector;
}

function runtimeOutput(value: unknown): Record<string, unknown> {
  const wrapper = object(value, "Runtime result");
  return object(wrapper.output, "Runtime output");
}

async function mondayPlan(
  request: Extract<Stage0Request, { action: "plan-monday-reversible" | "apply-monday-reversible" }>,
  configuration: Stage0Configuration,
  dependencies: Stage0Dependencies,
) {
  const connector = mondayConnector(dependencies);
  const binding = connector.bindings.get(configuration.monday.resource_binding);
  if (!binding || binding.permission !== "read-write") throw new Stage0QualificationError("binding-unavailable", "The exact Monday test resource is not bound read-write", 409);
  const statusColumn = binding.fields[configuration.monday.status_field];
  if (!statusColumn) throw new Stage0QualificationError("binding-unavailable", "The configured test status field is not allowlisted", 409);
  const inventory = await connector.client.readCompleteRecordInventory({
    boardId: binding.boardId,
    columnIds: Object.values(binding.fields),
    inventoryMode: "selected-items",
    pageSize: 100,
    maxPages: 10,
    maxObjects: 1_000,
  });
  const candidates = inventory.objects.filter((candidate) => candidate.object_kind === "item" && candidate.column_text[statusColumn]);
  const selected = request.work_item_id
    ? candidates.find((candidate) => candidate.provider_id === request.work_item_id)
    : candidates.sort((left, right) => left.provider_id.localeCompare(right.provider_id))[0];
  if (!selected) throw new Stage0QualificationError("test-item-unavailable", "No exact test-board item with a restorable status value is available", 409);
  const read = runtimeOutput(await dependencies.runtime.execute({
    runId: `stage0-read-${request.test_id}`,
    stepId: "read-before",
    agentId: configuration.sprint_agent_id,
    grantId: "oregano:work-items/read",
    input: { resource_binding: binding.id, work_item_id: selected.provider_id, fields: [configuration.monday.status_field] },
    subjectPrincipal: configuration.requester_principal,
  }));
  const workItem = object(read.work_item, "Monday work item");
  const beforeLabel = selected.column_text[statusColumn]!;
  const testLabel = configuration.monday.candidate_status_labels.find((label) => label !== beforeLabel);
  if (!testLabel) throw new Stage0QualificationError("test-value-unavailable", "No reversible alternate test status is configured", 409);
  const plan = {
    operation: "stage0-monday-reversible-update",
    test_id: request.test_id,
    environment: "preview",
    instance_id: configuration.instance_id,
    agent_id: configuration.sprint_agent_id,
    resource_binding: binding.id,
    board_id: binding.boardId,
    work_item_id: selected.provider_id,
    work_item_name: selected.name,
    logical_field: configuration.monday.status_field,
    provider_field: statusColumn,
    expected_version: String(workItem.providerVersion),
    before_label: beforeLabel,
    test_label: testLabel,
    restore_label: beforeLabel,
    controls: ["exact-binding", "optimistic-version", "read-after-write", "effect-idempotency", "echo-suppression", "restore-and-reread"],
    forbidden_provider_effects: ["any-other-board", "item-create", "item-delete", "comment", "production"],
  };
  return { ...plan, confirmation_hash: sha256(plan) };
}

async function applyMonday(
  request: Extract<Stage0Request, { action: "apply-monday-reversible" }>,
  configuration: Stage0Configuration,
  dependencies: Stage0Dependencies,
) {
  const plan = await mondayPlan({ ...request, action: "plan-monday-reversible" }, configuration, dependencies);
  if (plan.confirmation_hash !== request.confirmation_hash) throw new Stage0QualificationError("confirmation-mismatch", "Monday test confirmation does not match the current exact plan", 409);
  const input = {
    resource_binding: plan.resource_binding,
    work_item_id: plan.work_item_id,
    changes: { [plan.logical_field]: { label: plan.test_label } },
    expected_version: plan.expected_version,
  };
  const runId = `stage0-monday-${request.test_id}`;
  const effect = await dependencies.runtime.execute({
    runId, stepId: "reversible-update", agentId: configuration.sprint_agent_id,
    grantId: "oregano:work-items/update", input, subjectPrincipal: configuration.requester_principal,
  });
  const duplicate = await dependencies.runtime.execute({
    runId, stepId: "reversible-update", agentId: configuration.sprint_agent_id,
    grantId: "oregano:work-items/update", input, subjectPrincipal: configuration.requester_principal,
  });
  const effectOutput = runtimeOutput(effect);
  const changed = object(effectOutput.work_item, "Changed Monday work item");
  const connector = mondayConnector(dependencies);
  const echo = await classifyMondayBoardEventEcho({
    value: {
      eventId: `stage0-echo-${request.test_id}`,
      boardId: plan.board_id,
      workItemId: plan.work_item_id,
      actorId: connector.actorId,
      providerVersion: String(changed.providerVersion),
    },
    instanceId: configuration.instance_id,
    resourceBinding: plan.resource_binding,
    now: (dependencies.now ?? (() => new Date()))().toISOString(),
    echoStore: connector.echoStore,
  });
  const restoreInput = {
    resource_binding: plan.resource_binding,
    work_item_id: plan.work_item_id,
    changes: { [plan.logical_field]: { label: plan.restore_label } },
    expected_version: String(changed.providerVersion),
  };
  const restored = await dependencies.runtime.execute({
    runId: `stage0-monday-restore-${request.test_id}`, stepId: "restore", agentId: configuration.sprint_agent_id,
    grantId: "oregano:work-items/update", input: restoreInput, subjectPrincipal: configuration.requester_principal,
  });
  const finalRead = await dependencies.runtime.execute({
    runId: `stage0-read-final-${request.test_id}`, stepId: "read-final", agentId: configuration.sprint_agent_id,
    grantId: "oregano:work-items/read",
    input: { resource_binding: plan.resource_binding, work_item_id: plan.work_item_id, fields: [plan.logical_field] },
    subjectPrincipal: configuration.requester_principal,
  });
  const denied = await dependencies.runtime.execute({
    runId: `stage0-denied-${request.test_id}`, stepId: "unbound-resource", agentId: configuration.sprint_agent_id,
    grantId: "oregano:work-items/read",
    input: { resource_binding: "unconfigured-board", work_item_id: plan.work_item_id },
    subjectPrincipal: configuration.requester_principal,
  }).then(() => ({ blocked: false })).catch((error) => ({ blocked: true, error_digest: sha256(error instanceof Error ? error.message : String(error)) }));
  return {
    ok: true,
    plan,
    write: effect,
    duplicate,
    echo: { suppressed: echo.suppressed, idempotency_key: echo.receipt?.idempotencyKey ?? null },
    restore: restored,
    final_read: finalRead,
    unconfigured_board: denied,
    production_touched: false,
    credentials_retained: false,
  };
}

function slackPlan(
  request: Extract<Stage0Request, { action: "plan-slack-delivery" | "apply-slack-delivery" }>,
  configuration: Stage0Configuration,
) {
  const plan = {
    operation: "stage0-slack-delivery",
    test_id: request.test_id,
    environment: "preview",
    instance_id: configuration.instance_id,
    agent_id: configuration.sprint_agent_id,
    account_id: configuration.slack.account_id,
    channel_id: configuration.slack.channel_id,
    channel_destination_binding: configuration.slack.channel_destination_binding,
    direct_destination_binding: configuration.slack.direct_destination_binding,
    channel_content: request.channel_content,
    direct_content: request.direct_content,
    controls: ["exact-destination-binding", "effect-idempotency", "provider-receipt"],
    provider_effects: ["one-test-channel-message", "one-approved-direct-message"],
    forbidden_provider_effects: ["any-other-channel", "any-other-user", "production-destination"],
  };
  return { ...plan, confirmation_hash: sha256(plan) };
}

async function applySlack(
  request: Extract<Stage0Request, { action: "apply-slack-delivery" }>,
  configuration: Stage0Configuration,
  dependencies: Stage0Dependencies,
) {
  const plan = slackPlan({ ...request, action: "plan-slack-delivery" }, configuration);
  if (plan.confirmation_hash !== request.confirmation_hash) throw new Stage0QualificationError("confirmation-mismatch", "Slack test confirmation does not match the exact plan", 409);
  const channelInput = { destination_binding: plan.channel_destination_binding, content: plan.channel_content, format: "plain-text" };
  const channel = await dependencies.runtime.execute({
    runId: `stage0-slack-channel-${request.test_id}`, stepId: "publish-channel", agentId: configuration.sprint_agent_id,
    grantId: "oregano:communications/publish", input: channelInput, subjectPrincipal: configuration.requester_principal,
  });
  const duplicate = await dependencies.runtime.execute({
    runId: `stage0-slack-channel-${request.test_id}`, stepId: "publish-channel", agentId: configuration.sprint_agent_id,
    grantId: "oregano:communications/publish", input: channelInput, subjectPrincipal: configuration.requester_principal,
  });
  const direct = await dependencies.runtime.execute({
    runId: `stage0-slack-direct-${request.test_id}`, stepId: "publish-direct", agentId: configuration.sprint_agent_id,
    grantId: "oregano:communications/publish",
    input: { destination_binding: plan.direct_destination_binding, content: plan.direct_content, format: "plain-text" },
    subjectPrincipal: configuration.requester_principal,
  });
  return { ok: true, plan, channel, duplicate, direct, production_touched: false, credentials_retained: false };
}

async function callbackSecurity(
  request: Extract<Stage0Request, { action: "test-callback-security" }>,
  configuration: Stage0Configuration,
  dependencies: Stage0Dependencies,
) {
  const secretName = configuration.monday.signing_secret_ref.slice(4);
  const signingSecret = (dependencies.environment ?? process.env)[secretName];
  if (!signingSecret) throw new Stage0QualificationError("callback-secret-unavailable", `The Preview SecretRef '${secretName}' is unavailable`, 503);
  const connector = mondayConnector(dependencies);
  const boardId = connector.bindings.get(configuration.monday.resource_binding)?.boardId;
  if (!boardId) throw new Stage0QualificationError("binding-unavailable", "The Monday callback test board is not bound", 409);
  const now = (dependencies.now ?? (() => new Date()))().getTime();
  const rawBody = JSON.stringify({ event: "agent_triggered", triggerType: "mentioned", payload: { text: `Stage0 ${request.test_id}`, boardId }, stream: false });
  const signature = `sha256=${createHmac("sha256", signingSecret).update(`${now}.${rawBody}`).digest("hex")}`;
  const makeRequest = (supplied: string) => new Request("https://preview.example/api/webhooks/monday", {
    method: "POST",
    headers: { "content-type": "application/json", "x-monday-agent-id": configuration.monday.callback_agent_id, "x-monday-timestamp": String(now), "x-monday-signature": supplied },
    body: rawBody,
  });
  const replayStore = new StateAdapterMondayReplayStore(createPostgresChatState(), () => now);
  const dependency = { artifact: dependencies.artifact, accountId: configuration.monday.account_id, expectedAgentId: configuration.monday.callback_agent_id, signingSecret, replayStore, now: () => now };
  const valid = await handleMondayAgentWebhook(makeRequest(signature), dependency);
  const replay = await handleMondayAgentWebhook(makeRequest(signature), dependency);
  const invalid = await handleMondayAgentWebhook(makeRequest("sha256=invalid"), { ...dependency, replayStore: new StateAdapterMondayReplayStore(createPostgresChatState(), () => now) });
  return {
    ok: valid.status === 200 && replay.status === 409 && invalid.status === 401,
    valid_status: valid.status,
    replay_status: replay.status,
    invalid_signature_status: invalid.status,
    routed_board_id: boardId,
    agent_id: configuration.sprint_agent_id,
    credential_retained: false,
  };
}

export async function executeStage0(
  request: Stage0Request,
  configuration: Stage0Configuration,
  dependencies: Stage0Dependencies,
): Promise<Record<string, unknown>> {
  assertConfigured(configuration, dependencies.artifact);
  if (request.action === "inspect") {
    const monday = mondayConnector(dependencies);
    const binding = monday.bindings.get(configuration.monday.resource_binding);
    if (!binding) throw new Stage0QualificationError("binding-unavailable", "The configured Monday test resource binding is absent", 409);
    const channelRoute = resolveAgent(dependencies.artifact.agentRouting, dependencies.artifact.agents.map((agent) => agent.id), {
      surface: "slack", accountId: configuration.slack.account_id, channelId: configuration.slack.channel_id,
    });
    const dmRoute = resolveAgent(dependencies.artifact.agentRouting, dependencies.artifact.agents.map((agent) => agent.id), {
      surface: "slack", accountId: configuration.slack.account_id, channelId: "D-STAGE0",
    });
    const mondayRoute = resolveAgent(dependencies.artifact.agentRouting, dependencies.artifact.agents.map((agent) => agent.id), {
      surface: "monday", accountId: configuration.monday.account_id, channelId: `board:${binding.boardId}`,
    });
    return {
      ok: true,
      environment: dependencies.artifact.instance.environment,
      instance_id: dependencies.artifact.instance.id,
      artifact_hash: dependencies.artifact.artifactHash,
      core_commit: dependencies.artifact.provenance.coreCommit,
      workspace_commit: dependencies.artifact.provenance.workspaceCommit,
      monday: { resource_binding: binding.id, board_id: binding.boardId, permission: binding.permission, fields: Object.keys(binding.fields).sort(), route: mondayRoute },
      slack: { channel_id: configuration.slack.channel_id, channel_route: channelRoute, dm_route: dmRoute, channel_destination_binding: configuration.slack.channel_destination_binding, direct_destination_binding: configuration.slack.direct_destination_binding },
      credentials_retained: false,
      production_enabled: false,
    };
  }
  if (request.action === "test-sprint-workers") {
    if (!dependencies.runSprintTimerWorker || !dependencies.runSprintIntentWorker) {
      throw new Stage0QualificationError("worker-unavailable", "The hosted Sprint workers are unavailable", 503);
    }
    const timers = await dependencies.runSprintTimerWorker(request.at);
    const intents = await dependencies.runSprintIntentWorker(request.at);
    return {
      ok: true,
      test_id: request.test_id,
      controlled_time: request.at,
      timers,
      intents,
      environment: "preview",
      production_touched: false,
      credentials_retained: false,
    };
  }
  if (request.action === "plan-monday-reversible") return { ok: true, plan: await mondayPlan(request, configuration, dependencies) };
  if (request.action === "apply-monday-reversible") return await applyMonday(request, configuration, dependencies);
  if (request.action === "plan-slack-delivery") return { ok: true, plan: slackPlan(request, configuration) };
  if (request.action === "apply-slack-delivery") return await applySlack(request, configuration, dependencies);
  return await callbackSecurity(request, configuration, dependencies);
}
