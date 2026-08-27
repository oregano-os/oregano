import { randomUUID, timingSafeEqual } from "node:crypto";
import { createMaintainedSourceConnectorRegistry, GRANOLA_SOURCE_V2_DESCRIPTOR } from "../../../connectors/source-registry-maintained.ts";
import { processSourceEventV2 } from "../../../knowledge/source-ingestion-v2.ts";
import { acceptSourceWebhookV2, syncChangedSourceV2 } from "../../../knowledge/source-sync-v2.ts";
import {
  validateSourceBindingV2,
  validateSourceRequirementV2,
  type SourceBindingV2,
  type SourceConnectorV2,
  type SourceRequirementV2,
} from "../../../knowledge/source-contracts-v2.ts";
import type { SourcePipelineStore } from "../../../knowledge/source-pipeline-store.ts";
import { createPostgresInlineRawAssetStager } from "../../../state-postgres/raw-asset-adapter.ts";
import { PostgresSourcePipelineStore } from "../../../state-postgres/source-pipeline-store.ts";

export const GRANOLA_SOURCE_CONFIG_ENV = "COMPANYOS_GRANOLA_SOURCE_CONFIG_BASE64";
export const GRANOLA_RECONCILIATION_STREAM = "hybrid-changes";

export interface GranolaRuntimeConfiguration {
  version: 1;
  requirement: SourceRequirementV2;
  binding: SourceBindingV2;
}

export interface GranolaRuntimeStore extends SourcePipelineStore {
  registerSource(requirement: SourceRequirementV2, binding: SourceBindingV2): Promise<void>;
  setSourceStatus(sourceId: string, status: "registered" | "healthy" | "stale" | "error" | "revoked"): Promise<void>;
}

const environmentSecret = (reference: string): string => {
  if (!/^env:[A-Z][A-Z0-9_]{0,127}$/.test(reference)) throw new Error(`Runtime SecretRef '${reference}' is not an environment reference.`);
  const name = reference.slice("env:".length);
  const value = process.env[name];
  if (!value) throw new Error(`Runtime SecretRef '${reference}' is unavailable.`);
  return value;
};

export function decodeGranolaRuntimeConfiguration(encoded = process.env[GRANOLA_SOURCE_CONFIG_ENV]): GranolaRuntimeConfiguration {
  if (!encoded) throw new Error(`${GRANOLA_SOURCE_CONFIG_ENV} is not configured.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    throw new Error(`${GRANOLA_SOURCE_CONFIG_ENV} is malformed.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Granola runtime configuration must be an object.");
  const value = parsed as Record<string, unknown>;
  if (value.version !== 1 || !value.requirement || !value.binding || Object.keys(value).some((key) => !["version", "requirement", "binding"].includes(key))) throw new Error("Granola runtime configuration has an unsupported shape.");
  const requirement = validateSourceRequirementV2(value.requirement);
  const binding = validateSourceBindingV2(value.binding, requirement);
  if (requirement.sourceKind !== "meeting" || binding.connectorId !== GRANOLA_SOURCE_V2_DESCRIPTOR.connectorId || binding.connectorVersion !== GRANOLA_SOURCE_V2_DESCRIPTOR.connectorVersion) throw new Error("Granola runtime configuration selects an unsupported Source identity.");
  return { version: 1, requirement, binding };
}

export function authorizeScheduledKnowledgeRequest(request: Request, secret = process.env.CRON_SECRET): boolean {
  if (!secret) return false;
  const provided = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function classifyKnowledgeSourceRuntimeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/runtime configuration|SecretRef .* unavailable|unsupported Source identity/i.test(message)) return "runtime-configuration";
  if (/binding .* not active for ingestion/i.test(message)) return "binding-state";
  if (/Knowledge model provider call failed/i.test(message)) return "model-provider";
  if (/Knowledge model|model output|extraction .*invalid|Claim .* (?:must|invalid)|locator|structured/i.test(message)) return "model-output";
  if (/authoriz/i.test(message)) return "authorization";
  if (/Source .* (?:conflicts|rebind|revoked|registration)/i.test(message)) return "source-registration";
  if (/Granola .*?(?:response|API request|folder scope|note list|transcript)/i.test(message)) return "provider-response";
  if (/cursor|watermark/i.test(message)) return "cursor-or-watermark";
  if (/identity|immutable fields|outside the configured .*scope/i.test(message)) return "source-identity";
  if (/Raw Asset|storage|database|DATABASE_URL/i.test(message)) return "storage";
  if (/integrity|mismatched|reused|duplicate/i.test(message)) return "integrity";
  if (/lease/i.test(message)) return "lease";
  return "unclassified";
}

export function describeKnowledgeSourceRuntimeError(error: unknown): { name: string; code?: string; constraint?: string; messageTemplate: string } {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const raw = error instanceof Error ? error.message : String(error);
  const messageTemplate = raw
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/(?:sk|key|token|secret)[-_][A-Za-z0-9_-]+/gi, "<secret>")
    .replace(/'[^']*'/g, "'<value>'")
    .replace(/\b[a-f0-9]{32,}\b/gi, "<digest>")
    .replace(/\b\d{3,}\b/g, "<number>")
    .slice(0, 500);
  const bounded = (value: unknown): string | undefined => typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : undefined;
  return {
    name: error instanceof Error ? error.name : typeof error,
    ...(bounded(record.code) ? { code: bounded(record.code) } : {}),
    ...(bounded(record.constraint) ? { constraint: bounded(record.constraint) } : {}),
    messageTemplate,
  };
}

export class GranolaKnowledgeSourceRuntime {
  readonly #configuration: GranolaRuntimeConfiguration;
  readonly #store: GranolaRuntimeStore;
  readonly #registry: ReturnType<typeof createMaintainedSourceConnectorRegistry>;
  readonly #now: () => string;

  constructor(input: {
    configuration?: GranolaRuntimeConfiguration;
    store?: GranolaRuntimeStore;
    resolveSecret?: (reference: string) => string | Promise<string>;
    fetch?: typeof globalThis.fetch;
    now?: () => string;
  } = {}) {
    this.#configuration = input.configuration ?? decodeGranolaRuntimeConfiguration();
    this.#store = input.store ?? new PostgresSourcePipelineStore();
    this.#now = input.now ?? (() => new Date().toISOString());
    this.#registry = createMaintainedSourceConnectorRegistry({
      resolveSecret: input.resolveSecret ?? environmentSecret,
      fetch: input.fetch,
      now: this.#now,
      rawAssetStager: createPostgresInlineRawAssetStager(),
    });
  }

  async qualify() {
    const resolution = this.#registry.resolve({ ...this.#configuration, operation: "verify", observedAt: this.#now() });
    const connector = resolution.connector as SourceConnectorV2;
    const verification = await connector.verify();
    return {
      ok: verification.ok,
      sourceId: verification.sourceId,
      connectorId: verification.connectorId,
      connectorVersion: verification.connectorVersion,
      verifiedScopes: verification.verifiedScopes,
      verifiedDeliveryModes: verification.verifiedDeliveryModes,
      aclMapping: verification.aclMapping,
      receipt: verification.receipt,
      implementationDigest: resolution.descriptor.implementationDigest,
    };
  }

  async reconcile(input: { maxPages?: number } = {}) {
    const resolution = this.#registry.resolve({ ...this.#configuration, operation: "sync", observedAt: this.#now() });
    const connector = resolution.connector as SourceConnectorV2;
    await this.#store.registerSource(resolution.normalizedRequirement, resolution.normalizedBinding);
    await this.#store.putReceipt(resolution.receipt);
    const acquiredAt = this.#now();
    const owner = `runner:${randomUUID()}`;
    const leaseUntil = new Date(Date.parse(acquiredAt) + 15 * 60 * 1_000).toISOString();
    const lease = await this.#store.claimSyncLease({
      sourceId: resolution.normalizedRequirement.sourceId,
      streamId: GRANOLA_RECONCILIATION_STREAM,
      owner,
      acquiredAt,
      leaseUntil,
    });
    if (lease === "busy") return { ok: true, status: "busy" as const, sourceId: resolution.normalizedRequirement.sourceId };
    try {
      const result = await syncChangedSourceV2({
        connector,
        requirement: resolution.normalizedRequirement,
        store: this.#store,
        workerId: owner,
        streamId: GRANOLA_RECONCILIATION_STREAM,
        pageSize: 30,
        maxPages: Math.max(1, Math.min(input.maxPages ?? 2, 20)),
        overlapSeconds: 86_400,
        now: this.#now,
      });
      if (result.complete) await this.#store.setSourceStatus(resolution.normalizedRequirement.sourceId, "healthy");
      return { ok: result.complete, status: result.complete ? "complete" as const : "partial" as const, ...result };
    } catch (error) {
      await this.#store.setSourceStatus(resolution.normalizedRequirement.sourceId, "error");
      throw error;
    } finally {
      await this.#store.releaseSyncLease({ sourceId: resolution.normalizedRequirement.sourceId, streamId: GRANOLA_RECONCILIATION_STREAM, owner });
    }
  }

  async acceptWebhook(input: { rawBody: Uint8Array; headers: Readonly<Record<string, string>>; observedAt?: string }) {
    const resolution = this.#registry.resolve({ ...this.#configuration, operation: "sync", observedAt: input.observedAt ?? this.#now() });
    const connector = resolution.connector as SourceConnectorV2;
    await this.#store.registerSource(resolution.normalizedRequirement, resolution.normalizedBinding);
    await this.#store.putReceipt(resolution.receipt);
    const result = await acceptSourceWebhookV2({ connector, store: this.#store, rawBody: input.rawBody, headers: input.headers, observedAt: input.observedAt ?? this.#now() });
    return { ...result, requirement: resolution.normalizedRequirement, connector };
  }

  async processEvents(input: { eventIds: string[]; requirement: SourceRequirementV2; connector: SourceConnectorV2 }) {
    const results = [];
    for (const eventId of input.eventIds) {
      const record = await this.#store.getEvent(eventId);
      if (!record) continue;
      results.push(await processSourceEventV2({
        event: record.event,
        requirement: input.requirement,
        connector: input.connector,
        store: this.#store,
        workerId: `webhook:${randomUUID()}`,
        now: this.#now,
      }));
    }
    if (results.some((entry) => entry.outcome === "failed")) await this.#store.setSourceStatus(input.requirement.sourceId, "error");
    else if (results.length > 0) await this.#store.setSourceStatus(input.requirement.sourceId, "healthy");
    return results;
  }
}
