import { readFileSync } from "node:fs";
import { posix } from "node:path";
import YAML from "yaml";
import { validateJsonSchemaValue } from "../capabilities/validation.ts";
import type { BusinessCalendar } from "../domains/sprint/business-time.ts";
import type { SprintDomainDeclaration, Weekday } from "../domains/sprint/contracts.ts";
import { sha256 } from "../runtime/canonical.ts";
import type {
  CompiledSprintRuntime,
  InstanceBuildConfiguration,
} from "./types.ts";
import type { LoadedWorkspace } from "./workspace-loader.ts";

const configurationSchema = JSON.parse(readFileSync(new URL("../schema/sprint-configuration-v1.schema.json", import.meta.url), "utf8"));
const scheduleSchema = JSON.parse(readFileSync(new URL("../schema/sprint-schedule-v1.schema.json", import.meta.url), "utf8"));
const configurationPath = "workflows/sprint/config.yaml";

type RawSchedule = {
  schema_version: 1;
  id: string;
  activation: "blocked" | "active";
  timezone: string;
  business_days: Weekday[];
  holiday_calendar: {
    missing_year_policy: "assume-no-holidays" | "block";
    years: Record<string, string[]>;
  };
  delivery_window: { opens_at: string; closes_at: string };
  triggers: Array<{
    id: string;
    weekdays: Weekday[];
    at: string;
    holiday_shift?: "previous-business-day" | "next-business-day" | "none";
  }>;
};

type ProjectionDeclaration = {
  id?: unknown;
  record_type?: unknown;
  fields?: Array<{ name?: unknown }>;
};

const parse = (raw: string, label: string): unknown => {
  try {
    return YAML.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
};

const validate = <T>(schema: unknown, value: unknown, label: string): T => {
  const diagnostics = validateJsonSchemaValue(schema as any, value);
  if (diagnostics.length > 0) throw new Error(`${label} violates its contract: ${diagnostics.join("; ")}`);
  return value as T;
};

const safeWorkspacePath = (value: string, prefix?: string): string => {
  const normalized = posix.normalize(value);
  if (normalized !== value || normalized.startsWith("../") || normalized.startsWith("/") || normalized === ".") {
    throw new Error(`Sprint Workspace reference '${value}' is not a safe relative path.`);
  }
  if (prefix && !normalized.startsWith(prefix)) throw new Error(`Sprint Workspace reference '${value}' must be under '${prefix}'.`);
  return normalized;
};

const file = (workspace: LoadedWorkspace, path: string): string => {
  const content = workspace.allFiles[path];
  if (content === undefined) throw new Error(`Sprint Workspace reference '${path}' does not exist.`);
  return content;
};

function compileCalendar(schedulePath: string, schedule: RawSchedule): BusinessCalendar {
  const holidays = Object.entries(schedule.holiday_calendar.years)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, dates]) => dates)
    .sort();
  if (new Set(holidays).size !== holidays.length) throw new Error("Sprint schedule contains the same holiday in more than one year.");
  const business = new Set(schedule.business_days);
  const all: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  return { id: schedulePath, holidays, weekend: all.filter((day) => !business.has(day)) };
}

function validateProjectionContract(workspace: LoadedWorkspace, projectionId: string, requiredAlternatives: string[][]): void {
  const path = `records/projections/${projectionId}.yaml`;
  const declaration = parse(file(workspace, path), path) as ProjectionDeclaration;
  if (declaration?.id !== projectionId || !Array.isArray(declaration.fields)) {
    throw new Error(`${path}: Sprint projection must declare its exact id and fields.`);
  }
  const fields = new Set(declaration.fields.flatMap((entry) => typeof entry?.name === "string" ? [entry.name] : []));
  const matched = requiredAlternatives.some((required) => required.every((name) => fields.has(name)));
  if (!matched) {
    throw new Error(`${path}: Sprint projection lacks a supported canonical field set.`);
  }
}

function validateCommunicationReplayProjection(workspace: LoadedWorkspace, projectionId: string): void {
  const path = `records/projections/${projectionId}.yaml`;
  const declaration = parse(file(workspace, path), path) as ProjectionDeclaration;
  if (declaration?.id !== projectionId || declaration.record_type !== "communication-message" || !Array.isArray(declaration.fields)) {
    throw new Error(`${path}: Sprint replay requires one communication-message projection with its exact id.`);
  }
  const fields = new Set(declaration.fields.flatMap((entry) => typeof entry?.name === "string" ? [entry.name] : []));
  for (const required of ["message_id", "team_id", "author_id", "thread_id", "text", "occurred_at"]) {
    if (!fields.has(required)) throw new Error(`${path}: Sprint replay projection lacks canonical field '${required}'.`);
  }
}

type SlackDestination = {
  kind: "channel" | "direct-message";
  accountId: string;
  channelId?: string;
  userId?: string;
};

function slackDestinations(instance: InstanceBuildConfiguration): Map<string, SlackDestination> {
  const output = new Map<string, SlackDestination>();
  for (const connector of instance.connectors ?? []) {
    if (connector.connector !== "oregano/slack-communication" || !Array.isArray(connector.configuration.destinations)) continue;
    for (const raw of connector.configuration.destinations) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const value = raw as Record<string, unknown>;
      if (typeof value.id === "string" && typeof value.account_id === "string"
        && (value.kind === "channel" || value.kind === "direct-message")) {
        if (output.has(value.id)) throw new Error(`Sprint destination binding '${value.id}' is duplicated.`);
        output.set(value.id, {
          kind: value.kind,
          accountId: value.account_id,
          ...(typeof value.channel_id === "string" ? { channelId: value.channel_id } : {}),
          ...(typeof value.user_id === "string" ? { userId: value.user_id } : {}),
        });
      }
    }
  }
  return output;
}

function mondayWorkItemResources(instance: InstanceBuildConfiguration): Map<string, { boardId: string; permission: "read" | "read-write"; fields: Set<string> }> {
  const output = new Map<string, { boardId: string; permission: "read" | "read-write"; fields: Set<string> }>();
  for (const connector of instance.connectors ?? []) {
    if (connector.connector !== "oregano/monday-work-items" || !Array.isArray(connector.configuration.resources)) continue;
    for (const raw of connector.configuration.resources) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const value = raw as Record<string, unknown>;
      if (typeof value.id !== "string" || typeof value.board_id !== "string"
        || (value.permission !== "read" && value.permission !== "read-write")) continue;
      if (output.has(value.id)) throw new Error(`Sprint work-item resource binding '${value.id}' is duplicated.`);
      const fields = value.fields && typeof value.fields === "object" && !Array.isArray(value.fields)
        ? new Set(Object.keys(value.fields))
        : new Set<string>();
      output.set(value.id, { boardId: value.board_id, permission: value.permission, fields });
    }
  }
  return output;
}

function validateTemplate(path: string, content: string, allowed: Set<string>): void {
  if (!content.trim() || content.length > 20_000) throw new Error(`Sprint template '${path}' must contain 1 to 20000 characters.`);
  for (const match of content.matchAll(/\{\{([^}]+)\}\}/g)) {
    if (!allowed.has(match[1]!)) throw new Error(`Sprint template '${path}' uses unsupported placeholder '${match[1]}'.`);
  }
}

function markdownTemplateBody(path: string, source: string): string {
  if (!source.startsWith("---")) return source;
  const match = source.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`Sprint template '${path}' has invalid Markdown frontmatter.`);
  return source.slice(match[0].length);
}

export function compileSprintRuntimes(args: {
  workspace: LoadedWorkspace;
  instance: InstanceBuildConfiguration;
  coreCommit: string;
  workspaceCommit: string;
  workbenchVersion: string;
}): CompiledSprintRuntime[] {
  if ((args.instance.sprintRuntimes?.length ?? 0) === 0) return [];
  const rawPolicy = file(args.workspace, configurationPath);
  const policy = validate<SprintDomainDeclaration>(
    configurationSchema,
    parse(rawPolicy, configurationPath),
    configurationPath,
  );
  if (!policy.rendering) throw new Error(`${configurationPath}: rendering is required when a hosted Sprint runtime is bound.`);
  if (!policy.delivery.shared_thread) throw new Error(`${configurationPath}: the hosted Friday Close requires delivery.shared_thread to be true.`);
  if (!policy.participants.roster_group) throw new Error(`${configurationPath}: participants.roster_group is required when a hosted Sprint runtime is bound.`);
  const schedulePath = safeWorkspacePath(policy.calendar.business_calendar_ref, "schedules/");
  const scheduleSource = file(args.workspace, schedulePath);
  const schedule = validate<RawSchedule>(scheduleSchema, parse(scheduleSource, schedulePath), schedulePath);
  try {
    new Intl.DateTimeFormat("en", { timeZone: schedule.timezone }).format(new Date(0));
  } catch {
    throw new Error(`${schedulePath}: timezone must be a valid IANA timezone.`);
  }
  if (schedule.timezone !== policy.calendar.timezone) throw new Error(`${schedulePath}: timezone does not match the Sprint policy.`);
  if (!(schedule.delivery_window.opens_at < schedule.delivery_window.closes_at)) {
    throw new Error(`${schedulePath}: delivery_window.opens_at must precede closes_at.`);
  }
  if (new Set(schedule.triggers.map((trigger) => trigger.id)).size !== schedule.triggers.length) {
    throw new Error(`${schedulePath}: trigger ids must be unique.`);
  }
  const outsideWindow = schedule.triggers.find((trigger) => trigger.at < schedule.delivery_window.opens_at || trigger.at > schedule.delivery_window.closes_at);
  if (outsideWindow) throw new Error(`${schedulePath}: trigger '${outsideWindow.id}' falls outside the reviewed delivery window.`);
  const triggerMoments = new Set(schedule.triggers
    .filter((trigger) => trigger.weekdays.includes(policy.close.weekday))
    .map((trigger) => `${trigger.at}:${trigger.holiday_shift ?? "none"}`));
  for (const value of [policy.close.reminder_time, policy.close.chase_time ?? policy.close.complete_by, policy.close.report_at]) {
    if (!triggerMoments.has(`${value}:${policy.calendar.holiday_shift}`)) {
      throw new Error(`${schedulePath}: missing the reviewed Sprint close trigger at '${value}' with '${policy.calendar.holiday_shift}'.`);
    }
  }
  if (policy.weekly) {
    const ids = new Set(schedule.triggers.map((trigger) => trigger.id));
    for (const id of [policy.weekly.monday_handoff_trigger, policy.weekly.weekday_digest_trigger]) {
      if (!ids.has(id)) throw new Error(`${schedulePath}: missing reviewed weekly trigger '${id}'.`);
    }
    for (const key of ["monday_handoff", "weekday_digest", "direct_question"] as const) {
      if (!policy.rendering?.[key]) throw new Error(`${configurationPath}: rendering.${key} is required when weekly Sprint coordination is configured.`);
    }
    if (!policy.work_items.planning_group || !policy.work_items.planned_status || (policy.work_items.required_fields?.length ?? 0) === 0) {
      throw new Error(`${configurationPath}: weekly Sprint readiness requires work_items planning_group, planned_status, and required_fields.`);
    }
  }
  validateProjectionContract(args.workspace, policy.participants.projection, [["participant_id", "display_name", "roles"], ["person_ids", "role"]]);
  validateProjectionContract(args.workspace, policy.work_items.projection, [["work_item_id", "title", "assignee_ids", "group", "status", "provider_version"]]);
  const destinations = slackDestinations(args.instance);
  const workItemResources = mondayWorkItemResources(args.instance);
  const calendar = compileCalendar(schedulePath, schedule);
  return args.instance.sprintRuntimes!.map((runtime) => {
    if (runtime.definitionId !== policy.id) throw new Error(`Sprint runtime '${runtime.definitionId}' has no matching Workspace declaration.`);
    if (runtime.replay) validateCommunicationReplayProjection(args.workspace, runtime.replay.messageProjection);
    const agent = args.workspace.agents.find((agent) => agent.id === runtime.agentId);
    if (!agent) {
      throw new Error(`Sprint runtime '${runtime.definitionId}' references absent Agent '${runtime.agentId}'.`);
    }
    const effectGrants = runtime.execution === "shadow-only"
      ? []
      : ["oregano:communications/publish", ...(runtime.workItem ? ["oregano:work-items/read", "oregano:work-items/update", "oregano:work-items/confirmed-update", "oregano:work-items/batch-update"] : [])];
    for (const grant of ["oregano:records/query", ...effectGrants]) {
      if (!agent.grants.includes(grant)) throw new Error(`Sprint Agent '${runtime.agentId}' lacks required Tool grant '${grant}'.`);
    }
    if (runtime.execution === "shadow-only" && runtime.workItem) {
      throw new Error(`Sprint runtime '${runtime.definitionId}' cannot bind a work-item resource when execution is shadow-only.`);
    }
    const service = args.workspace.roster.find((member) => member.principals?.includes(runtime.servicePrincipal));
    if (!service || !/^(?:active|aktiv)$/i.test(service.status) || !["agent", "service"].includes(service.type ?? "")) {
      throw new Error(`Sprint service principal '${runtime.servicePrincipal}' must identify one active Workspace agent or service.`);
    }
    if (destinations.get(policy.delivery.channel_binding)?.kind !== "channel") {
      throw new Error(`Sprint channel binding '${policy.delivery.channel_binding}' is not an exact channel destination.`);
    }
    for (const [principal, destination] of Object.entries(runtime.directDestinations)) {
      if (destinations.get(destination)?.kind !== "direct-message") {
        throw new Error(`Sprint principal '${principal}' is not bound to an exact direct-message destination.`);
      }
    }
    const expectedMembers = args.workspace.roster
      .filter((member) => /^(?:active|aktiv)$/i.test(member.status)
        && !["agent", "service"].includes(member.type ?? "human")
        && member.groups?.includes(policy.participants.roster_group!));
    const withoutSlack = expectedMembers.find((member) => !member.principals?.some((principal) => principal.startsWith("slack:")));
    if (withoutSlack) throw new Error(`Sprint participant '${withoutSlack.id ?? withoutSlack.name}' lacks a canonical Slack principal.`);
    const expectedDirect = expectedMembers
      .map((member) => member.principals!.find((principal) => principal.startsWith("slack:"))!);
    const missingDirect = expectedDirect.find((principal) => !runtime.directDestinations[principal]);
    if (missingDirect) throw new Error(`Sprint participant '${missingDirect}' lacks an exact direct-message destination binding.`);
    const directAssignments: CompiledSprintRuntime["directAssignments"] = {};
    const handoffs = args.workspace.agents.flatMap((candidate) => candidate.handoffs);
    for (const member of expectedMembers) {
      const principal = member.principals!.find((candidate) => candidate.startsWith("slack:"))!;
      const candidates = handoffs.filter((rule) => rule.toAgentId === runtime.agentId
        && rule.surfaces.includes("slack")
        && (rule.eligibleRoles.includes(member.role)
          || (member.groups ?? []).some((group) => rule.eligibleGroups.includes(group))));
      if (candidates.length !== 1) {
        throw new Error(`Sprint participant '${principal}' requires exactly one compiled Slack handoff into Agent '${runtime.agentId}'.`);
      }
      directAssignments[principal] = {
        fromAgentId: candidates[0]!.fromAgentId,
        purpose: candidates[0]!.purpose,
      };
    }
    if (runtime.workItem) {
      const resource = workItemResources.get(runtime.workItem.resourceBinding);
      if (!resource || resource.permission !== "read-write") {
        throw new Error(`Sprint work-item binding '${runtime.workItem.resourceBinding}' must resolve to one read-write Monday resource.`);
      }
      if (!resource.fields.has(runtime.workItem.rolloverField)) {
        throw new Error(`Sprint work-item binding '${runtime.workItem.resourceBinding}' does not allowlist rollover field '${runtime.workItem.rolloverField}'.`);
      }
      if (runtime.workItem.readinessField && !resource.fields.has(runtime.workItem.readinessField)) {
        throw new Error(`Sprint work-item binding '${runtime.workItem.resourceBinding}' does not allowlist readiness field '${runtime.workItem.readinessField}'.`);
      }
      if (policy.weekly && !runtime.workItem.readinessField) {
        throw new Error(`Sprint work-item binding '${runtime.workItem.resourceBinding}' requires readiness_field for weekly readiness effects.`);
      }
    }
    let testPublication: NonNullable<CompiledSprintRuntime["replay"]>["testPublication"];
    if (runtime.replay?.testPublication) {
      const publication = runtime.replay.testPublication;
      const publisher = args.workspace.agents.find((candidate) => candidate.id === publication.publisherAgentId);
      if (!publisher) throw new Error(`Sprint Replay publisher Agent '${publication.publisherAgentId}' is absent.`);
      if (args.instance.defaultAgentId === publisher.id || args.instance.agentBindings.some((binding) => binding.agentId === publisher.id)) {
        throw new Error(`Sprint Replay publisher Agent '${publisher.id}' must not be reachable from a conversational Agent binding.`);
      }
      if (args.workspace.agents.some((candidate) => candidate.handoffs.some((handoff) => handoff.toAgentId === publisher.id))) {
        throw new Error(`Sprint Replay publisher Agent '${publisher.id}' must not be reachable through an Agent handoff.`);
      }
      const requiredPublisherGrants = ["oregano:communications/publish", "oregano:work-items/comment"].sort();
      const actualPublisherGrants = [...new Set(publisher.grants)].sort();
      if (actualPublisherGrants.length !== requiredPublisherGrants.length
        || actualPublisherGrants.some((grant, index) => grant !== requiredPublisherGrants[index])) {
        throw new Error(`Sprint Replay publisher Agent '${publisher.id}' must have exactly the two test-publication Tool grants.`);
      }
      const testDestination = destinations.get(publication.communicationBinding);
      const liveDestination = destinations.get(policy.delivery.channel_binding);
      if (!testDestination || testDestination.kind !== "channel" || !testDestination.channelId) {
        throw new Error(`Sprint Replay test destination '${publication.communicationBinding}' must resolve to one exact Slack channel.`);
      }
      if (publication.communicationBinding === policy.delivery.channel_binding
        || (liveDestination?.accountId === testDestination.accountId && liveDestination.channelId === testDestination.channelId)
        || publication.forbiddenChannelIds.includes(testDestination.channelId)) {
        throw new Error("Sprint Replay test publication selects a protected Slack channel.");
      }
      const testResource = workItemResources.get(publication.workItemBinding);
      if (!testResource || testResource.permission !== "read-write") {
        throw new Error(`Sprint Replay test resource '${publication.workItemBinding}' must resolve to one read-write Monday board.`);
      }
      const liveResource = runtime.workItem ? workItemResources.get(runtime.workItem.resourceBinding) : undefined;
      if (runtime.workItem?.resourceBinding === publication.workItemBinding
        || liveResource?.boardId === testResource.boardId
        || publication.forbiddenBoardIds.includes(testResource.boardId)) {
        throw new Error("Sprint Replay test publication selects a protected Monday board.");
      }
      testPublication = {
        testOnly: true,
        publisherAgentId: publication.publisherAgentId,
        communicationBinding: publication.communicationBinding,
        workItemBinding: publication.workItemBinding,
        workItemId: publication.workItemId,
      };
    }
    const reminderPath = safeWorkspacePath(policy.rendering!.reminder);
    const chasePath = safeWorkspacePath(policy.rendering!.chase);
    const closeReportPath = safeWorkspacePath(policy.rendering!.close_report);
    const retroPath = safeWorkspacePath(policy.rendering!.retro);
    const reminderContent = markdownTemplateBody(reminderPath, file(args.workspace, reminderPath));
    const chaseContent = markdownTemplateBody(chasePath, file(args.workspace, chasePath));
    const closeReportContent = markdownTemplateBody(closeReportPath, file(args.workspace, closeReportPath));
    const retroContent = markdownTemplateBody(retroPath, file(args.workspace, retroPath));
    validateTemplate(reminderPath, reminderContent, new Set(["sprint_id", "period_start", "period_end", "due_at"]));
    validateTemplate(chasePath, chaseContent, new Set(["sprint_id", "period_start", "period_end", "due_at", "needs_reformat_names", "missing_names"]));
    validateTemplate(closeReportPath, closeReportContent, new Set(["sprint_id", "period_start", "period_end", "due_at", "complete_names", "needs_reformat_names", "missing_names"]));
    validateTemplate(retroPath, retroContent, new Set(["sprint_id", "period_start", "period_end", "due_at", "complete_names", "needs_reformat_names", "missing_names", "open_work_item_ids", "open_work_item_count", "total_effort_hours"]));
    const replayReport = testPublication ? (() => {
      const rawPath = (policy.rendering as Record<string, unknown>).replay_report;
      if (typeof rawPath !== "string") throw new Error(`${configurationPath}: rendering.replay_report is required for test publication.`);
      const path = safeWorkspacePath(rawPath);
      const content = markdownTemplateBody(path, file(args.workspace, path));
      validateTemplate(path, content, new Set([
        "replay_id", "sprint_id", "period_start", "period_end", "complete_names", "needs_reformat_names", "missing_names",
        "open_work_item_ids", "open_work_item_count", "total_effort_hours", "accepted_submission_count",
        "ignored_message_count", "limitations", "output_digest",
      ]));
      return { path, content, digest: sha256(content) };
    })() : undefined;
    const weeklyTemplates = policy.weekly ? (() => {
      const mondayPath = safeWorkspacePath(policy.rendering!.monday_handoff!);
      const digestPath = safeWorkspacePath(policy.rendering!.weekday_digest!);
      const directPath = safeWorkspacePath(policy.rendering!.direct_question!);
      const monday = markdownTemplateBody(mondayPath, file(args.workspace, mondayPath));
      const digest = markdownTemplateBody(digestPath, file(args.workspace, digestPath));
      const direct = markdownTemplateBody(directPath, file(args.workspace, directPath));
      validateTemplate(mondayPath, monday, new Set(["sprint_id", "period_start", "period_end", "due_at", "committed_work_items", "carry_forward_names", "disagreements"]));
      validateTemplate(digestPath, digest, new Set(["sprint_id", "period_start", "period_end", "due_at", "changed_work_items", "readiness_gaps"]));
      validateTemplate(directPath, direct, new Set(["sprint_id", "period_start", "period_end", "due_at", "participant_name", "work_item_title", "missing_fields"]));
      return {
        mondayHandoff: { path: mondayPath, content: monday, digest: sha256(monday) },
        weekdayDigest: { path: digestPath, content: digest, digest: sha256(digest) },
        directQuestion: { path: directPath, content: direct, digest: sha256(direct) },
      };
    })() : {};
    return {
      definitionId: runtime.definitionId,
      agentId: runtime.agentId,
      execution: runtime.execution,
      servicePrincipal: runtime.servicePrincipal,
      participantIdentityPrefix: runtime.participantIdentityPrefix,
      policy: structuredClone(policy),
      calendar,
      schedule: {
        schemaVersion: 1 as const,
        id: schedule.id,
        sourcePath: schedulePath,
        activation: schedule.activation,
        timeZone: schedule.timezone,
        businessDays: [...schedule.business_days],
        holidaysByYear: structuredClone(schedule.holiday_calendar.years),
        missingYearPolicy: schedule.holiday_calendar.missing_year_policy,
        deliveryWindow: { opensAt: schedule.delivery_window.opens_at, closesAt: schedule.delivery_window.closes_at },
        triggers: schedule.triggers.map((trigger) => ({
          id: trigger.id,
          weekdays: [...trigger.weekdays],
          at: trigger.at,
          ...(trigger.holiday_shift ? { holidayShift: trigger.holiday_shift } : {}),
        })),
        sourceDigest: sha256(scheduleSource),
        provenance: {
          instanceId: args.instance.instanceId,
          coreCommit: args.coreCommit,
          workspaceCommit: args.workspaceCommit,
          workbenchVersion: args.workbenchVersion,
        },
      },
      templates: {
        reminder: { path: reminderPath, content: reminderContent, digest: sha256(reminderContent) },
        chase: { path: chasePath, content: chaseContent, digest: sha256(chaseContent) },
        closeReport: { path: closeReportPath, content: closeReportContent, digest: sha256(closeReportContent) },
        retro: { path: retroPath, content: retroContent, digest: sha256(retroContent) },
        ...(replayReport ? { replayReport } : {}),
        ...weeklyTemplates,
      },
      directDestinations: structuredClone(runtime.directDestinations),
      directAssignments,
      ...(runtime.workItem ? { workItem: structuredClone(runtime.workItem) } : {}),
      ...(runtime.replay ? { replay: {
        messageProjection: runtime.replay.messageProjection,
        ...(testPublication ? { testPublication } : {}),
      } } : {}),
      modelTask: policy.model_task_profile ?? "sprint.coordination",
    };
  }).sort((left, right) => left.definitionId.localeCompare(right.definitionId));
}
