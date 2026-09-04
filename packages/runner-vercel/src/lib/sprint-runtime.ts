import { randomUUID, timingSafeEqual } from "node:crypto";
import type { CompanyOSArtifact, CompiledSprintRuntime } from "../../../companyos-builder/types.ts";
import type { RecordProjectionRow, RecordQueryResult } from "../../../records/contracts.ts";
import { sha256 } from "../../../runtime/canonical.ts";
import { DurableTimerService } from "../../../runtime/durable-timers.ts";
import {
  HostedSprintRuntime,
  createCompanyOSSprintDispatcher,
  type SprintRuntimeMode,
  type SprintSnapshot,
} from "../../../runtime/sprint-host.ts";
import { createPostgresDurableTimerStore } from "../../../state-postgres/durable-timer-store.ts";
import { createPostgresSprintOrchestrationStore } from "../../../state-postgres/sprint-orchestration-store.ts";
import { normalizeSprintSnapshot } from "../../../runtime/sprint-snapshot.ts";
import { loadArtifact } from "./artifact.ts";
import { getCompanyOSRuntime } from "./bot.ts";

const MAX_REQUEST_BYTES = 16_384;
const PAGE_LIMIT = 200;
const MAX_PAGES = 250;
const LEASE_MS = 4 * 60_000;

const text = (value: unknown, label: string, maximum = 255): string => {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) throw new Error(`${label} is invalid`);
  return value;
};

const exactIso = (value: unknown, label: string): string => {
  const result = text(value, label);
  if (Number.isNaN(Date.parse(result)) || new Date(result).toISOString() !== result) throw new Error(`${label} must be an exact ISO timestamp`);
  return result;
};

const exactDate = (value: unknown, label: string): string => {
  const result = text(value, label, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || new Date(`${result}T00:00:00.000Z`).toISOString().slice(0, 10) !== result) {
    throw new Error(`${label} must be an exact calendar date`);
  }
  return result;
};

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};

const exactKeys = (value: Record<string, unknown>, allowed: readonly string[], label: string): void => {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) throw new Error(`${label} contains unsupported field '${extra}'`);
};

const stringArray = (value: unknown, label: string, maximum = 10_000): string[] => {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${label} must be a bounded string list`);
  }
  return [...new Set(value as string[])];
};

export function currentSprintRuntimeMode(environment: NodeJS.ProcessEnv = process.env): SprintRuntimeMode {
  const value = environment.COMPANYOS_SPRINT_RUNTIME_MODE ?? "disabled";
  if (!(["disabled", "shadow", "active"] as const).includes(value as SprintRuntimeMode)) {
    throw new Error("COMPANYOS_SPRINT_RUNTIME_MODE must be disabled, shadow, or active");
  }
  return value as SprintRuntimeMode;
}

function selectedSprintRuntime(artifact: CompanyOSArtifact, definitionId?: string): CompiledSprintRuntime {
  const available = artifact.sprints ?? [];
  const selected = definitionId
    ? available.find((candidate) => candidate.definitionId === definitionId)
    : available.length === 1 ? available[0] : undefined;
  if (!selected) throw new Error(definitionId
    ? `Compiled Sprint runtime '${definitionId}' is unavailable`
    : "Exactly one compiled Sprint runtime is required when no definition is selected");
  return selected;
}

export function assertSprintRuntimeModeCompatible(compiled: CompiledSprintRuntime, mode: SprintRuntimeMode): void {
  if (mode === "active" && compiled.execution === "shadow-only") {
    throw new Error(`Compiled Sprint runtime '${compiled.definitionId}' is shadow-only and cannot start in active mode`);
  }
}

export function createHostedSprintRuntime(definitionId?: string): HostedSprintRuntime {
  const artifact = loadArtifact();
  const compiled = selectedSprintRuntime(artifact, definitionId ?? process.env.COMPANYOS_SPRINT_DEFINITION_ID);
  const mode = currentSprintRuntimeMode();
  assertSprintRuntimeModeCompatible(compiled, mode);
  const store = createPostgresSprintOrchestrationStore();
  const timers = new DurableTimerService({ store: createPostgresDurableTimerStore(), instanceId: artifact.instance.id });
  const companyRuntime = mode === "active" ? getCompanyOSRuntime() : undefined;
  return new HostedSprintRuntime({
    instanceId: artifact.instance.id,
    compiled,
    mode,
    store,
    timers,
    ...(companyRuntime ? { activeDispatcher: createCompanyOSSprintDispatcher({ compiled, runtime: companyRuntime }) } : {}),
  });
}

function bearer(request: Request): string | undefined {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : undefined;
}

function matchesSecret(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function authorizeSprintOperator(request: Request, environment: NodeJS.ProcessEnv = process.env): boolean {
  return matchesSecret(bearer(request), environment.COMPANYOS_SPRINT_OPERATOR_SECRET);
}

export function authorizeSprintScheduler(request: Request, environment: NodeJS.ProcessEnv = process.env): boolean {
  return matchesSecret(bearer(request), environment.CRON_SECRET);
}

export type SprintOperatorRequest =
  | { action: "inspect"; definitionId?: string }
  | {
    action: "open";
    definitionId?: string;
    sprintId: string;
    periodStart: string;
    periodEnd: string;
    openedAt: string;
    nextSprintId?: string;
    excludedParticipantIds: string[];
  };

export function parseSprintOperatorRequest(raw: string): SprintOperatorRequest {
  if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) throw new Error("Sprint operator request is too large");
  const value = object(JSON.parse(raw), "Sprint operator request");
  if (value.action === "inspect") {
    exactKeys(value, ["action", "definition_id"], "Sprint inspect request");
    return {
      action: "inspect",
      ...(value.definition_id === undefined ? {} : { definitionId: text(value.definition_id, "definition_id", 63) }),
    };
  }
  if (value.action === "open") {
    exactKeys(value, ["action", "definition_id", "sprint_id", "period_start", "period_end", "opened_at", "next_sprint_id", "excluded_participant_ids"], "Sprint open request");
    return {
      action: "open",
      ...(value.definition_id === undefined ? {} : { definitionId: text(value.definition_id, "definition_id", 63) }),
      sprintId: text(value.sprint_id, "sprint_id"),
      periodStart: exactDate(value.period_start, "period_start"),
      periodEnd: exactDate(value.period_end, "period_end"),
      openedAt: exactIso(value.opened_at, "opened_at"),
      ...(value.next_sprint_id === undefined ? {} : { nextSprintId: text(value.next_sprint_id, "next_sprint_id") }),
      excludedParticipantIds: value.excluded_participant_ids === undefined
        ? []
        : stringArray(value.excluded_participant_ids, "excluded_participant_ids", 2_000),
    };
  }
  throw new Error("Sprint operator action must be inspect or open");
}

function toolResult(value: unknown, projectionId: string): RecordQueryResult {
  const envelope = object(value, "Company Records Tool result");
  const output = object(envelope.output, "Company Records Tool output") as unknown as RecordQueryResult;
  if (output.projection_id !== projectionId || !Array.isArray(output.rows)) {
    throw new Error(`Company Records Tool returned an invalid '${projectionId}' projection`);
  }
  return output;
}

async function readProjection(args: {
  compiled: CompiledSprintRuntime;
  projectionId: string;
  runId: string;
  now: string;
  pass: number;
}): Promise<{ rows: RecordProjectionRow[]; version: string; observedAt: string }> {
  const runtime = getCompanyOSRuntime();
  const rows: RecordProjectionRow[] = [];
  let cursor: string | undefined;
  let newestObservedAt = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = toolResult(await runtime.execute({
      runId: args.runId,
      stepId: `projection:${args.projectionId}:${args.pass}:${page}`,
      agentId: args.compiled.agentId,
      grantId: "oregano:records/query",
      subjectPrincipal: args.compiled.servicePrincipal,
      input: { projection_id: args.projectionId, limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    }), args.projectionId);
    if (result.fresh_until < args.now) throw new Error(`Sprint projection '${args.projectionId}' is stale`);
    newestObservedAt = newestObservedAt > result.observed_at ? newestObservedAt : result.observed_at;
    rows.push(...result.rows);
    cursor = result.next_cursor;
    if (!cursor) return {
      rows,
      observedAt: newestObservedAt || args.now,
      version: sha256(rows),
    };
  }
  throw new Error(`Sprint projection '${args.projectionId}' exceeds the supported ${MAX_PAGES * PAGE_LIMIT} rows`);
}

type ProjectionSnapshot = Awaited<ReturnType<typeof readProjection>>;

/**
 * Projection pagination is not a database snapshot transaction. Require two
 * consecutive full reads with the same canonical digest before freezing a
 * Sprint so a reconciliation running between pages cannot create a mixed
 * snapshot. One automatic retry tolerates a single concurrent refresh.
 */
export async function stabilizeSprintProjection(
  projectionId: string,
  read: (pass: number) => Promise<ProjectionSnapshot>,
): Promise<ProjectionSnapshot> {
  let previous = await read(0);
  for (let pass = 1; pass < 3; pass += 1) {
    const current = await read(pass);
    if (current.version === previous.version) return current;
    previous = current;
  }
  throw new Error(`Sprint projection '${projectionId}' changed while its frozen snapshot was being read`);
}

export async function resolveSprintSnapshot(compiled: CompiledSprintRuntime, now = new Date().toISOString()): Promise<SprintSnapshot> {
  exactIso(now, "Sprint snapshot time");
  const artifact = loadArtifact();
  const runId = `sprint-snapshot:${compiled.definitionId}:${sha256(now).slice(0, 24)}`;
  const [participantProjection, workItemProjection] = await Promise.all([
    stabilizeSprintProjection(compiled.policy.participants.projection, (pass) => readProjection({
      compiled,
      projectionId: compiled.policy.participants.projection,
      runId,
      now,
      pass,
    })),
    stabilizeSprintProjection(compiled.policy.work_items.projection, (pass) => readProjection({
      compiled,
      projectionId: compiled.policy.work_items.projection,
      runId,
      now,
      pass,
    })),
  ]);
  return normalizeSprintSnapshot({
    roster: artifact.roster,
    compiled,
    participantRows: participantProjection.rows,
    workItemRows: workItemProjection.rows,
    observedAt: participantProjection.observedAt > workItemProjection.observedAt
      ? participantProjection.observedAt
      : workItemProjection.observedAt,
    participantSourceVersion: participantProjection.version,
    workItemSourceVersion: workItemProjection.version,
  });
}

export async function executeSprintOperator(input: SprintOperatorRequest, now = new Date().toISOString()) {
  exactIso(now, "Sprint operator server time");
  if (input.action === "open" && input.openedAt > now) throw new Error("Sprint opened_at must not be in the future");
  const hosted = createHostedSprintRuntime(input.definitionId);
  if (input.action === "inspect") return { ok: true, runtime: await hosted.inspect() };
  const snapshot = await resolveSprintSnapshot(hosted.compiled, now);
  const result = await hosted.open({
    sprintId: input.sprintId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    openedAt: input.openedAt,
    snapshot,
    excludedParticipantIds: input.excludedParticipantIds,
    ...(input.nextSprintId ? { nextSprintId: input.nextSprintId } : {}),
  });
  return { ok: true, result, runtime: await hosted.inspect() };
}

const lease = (prefix: string, now: string) => ({
  now,
  owner: `${prefix}:${process.env.VERCEL_REGION ?? "unknown"}`,
  leaseToken: randomUUID(),
  leaseExpiresAt: new Date(new Date(now).getTime() + LEASE_MS).toISOString(),
});

export function scheduledSprintRuntimeDefinitions(
  artifact: CompanyOSArtifact,
  mode: SprintRuntimeMode,
  selected?: string,
): string[] {
  if (mode === "disabled") return [];
  return (artifact.sprints ?? [])
    .filter((runtime) => (mode === "shadow" || runtime.schedule.activation === "active")
      && (!selected || runtime.definitionId === selected))
    .map((runtime) => runtime.definitionId);
}

function scheduledRuntimeDefinitions(): string[] {
  return scheduledSprintRuntimeDefinitions(
    loadArtifact(),
    currentSprintRuntimeMode(),
    process.env.COMPANYOS_SPRINT_DEFINITION_ID,
  );
}

export async function runSprintTimerWorker(now = new Date().toISOString()) {
  const results = [];
  for (const definitionId of scheduledRuntimeDefinitions()) {
    const hosted = createHostedSprintRuntime(definitionId);
    const inspection = await hosted.inspect();
    if (inspection.sprintId) {
      const snapshot = await resolveSprintSnapshot(hosted.compiled, now);
      await hosted.refreshWorkItems({ snapshot, refreshedAt: now });
    }
    for (const result of await hosted.processDueTimers({ ...lease(`sprint-timer:${definitionId}`, now), limit: 100 })) {
      results.push({ definitionId, ...result });
    }
  }
  return { ok: results.every((result) => result.status !== "failed"), processed: results.length, results };
}

export async function runSprintIntentWorker(now = new Date().toISOString()) {
  const results = [];
  for (const definitionId of scheduledRuntimeDefinitions()) {
    const hosted = createHostedSprintRuntime(definitionId);
    for (const result of await hosted.dispatchIntents({ ...lease(`sprint-intent:${definitionId}`, now), limit: 50 })) {
      results.push({ definitionId, ...result });
    }
  }
  return { ok: results.every((result) => result.status !== "failed"), processed: results.length, results };
}

export async function ingestFridaySprintUpdate(args: {
  agentId: string;
  messageId: string;
  occurredAt: string;
  principal: string;
  threadReference: string;
  text: string;
}) {
  const artifact = loadArtifact();
  const candidates = (artifact.sprints ?? []).filter((runtime) => runtime.agentId === args.agentId);
  if (candidates.length === 0) return { accepted: false as const, reason: "agent-has-no-sprint-runtime" as const };
  if (candidates.length > 1) throw new Error(`Agent '${args.agentId}' has ambiguous Sprint runtime bindings`);
  return createHostedSprintRuntime(candidates[0].definitionId).ingestSlackSubmission(args);
}
