import { sha256 } from "../runtime/canonical.ts";
import type {
  KnowledgeSourceBinding,
  KnowledgeSourceRequirement,
  KnowledgeSourceStore,
  RuntimeObservation,
  SourceEnvelope,
  SourceHealth,
  SourceReceipt,
  SourceRetentionPolicy,
} from "./source-contracts.ts";
import { sourceRetentionUntil } from "./source-contracts.ts";

interface StoredEnvelope { envelope: SourceEnvelope; retentionUntil: string }

export class InMemoryKnowledgeSourceStore implements KnowledgeSourceStore {
  readonly sources = new Map<string, { requirement: KnowledgeSourceRequirement; binding: KnowledgeSourceBinding; cursor?: string; completed: boolean; revoked: boolean; health?: SourceHealth }>();
  readonly receipts = new Map<string, SourceReceipt>();
  readonly envelopes = new Map<string, StoredEnvelope>();
  readonly observations = new Map<string, RuntimeObservation>();
  readonly deletionRequests = new Map<string, { id: string; requestedBy: string; reason: string; requestedAt: string }>();
  readonly legalHolds = new Map<string, { actor: string; enabledAt: string }>();

  async registerSource(requirement: KnowledgeSourceRequirement, binding: KnowledgeSourceBinding): Promise<void> {
    const prior = this.sources.get(requirement.sourceId);
    const bindingChanged = prior !== undefined && JSON.stringify(prior.binding) !== JSON.stringify(binding);
    this.sources.set(requirement.sourceId, { requirement: structuredClone(requirement), binding: structuredClone(binding), cursor: bindingChanged ? undefined : prior?.cursor, completed: bindingChanged ? false : prior?.completed ?? false, revoked: false, health: prior?.health });
  }

  async getCursor(sourceId: string): Promise<string | undefined> { return this.sources.get(sourceId)?.cursor; }

  async recordReceipt(receipt: SourceReceipt): Promise<boolean> {
    if (this.receipts.has(receipt.receiptId)) return false;
    this.receipts.set(receipt.receiptId, structuredClone(receipt));
    return true;
  }

  async upsertEnvelope(envelope: SourceEnvelope, retention: SourceRetentionPolicy): Promise<"inserted" | "updated" | "unchanged"> {
    const key = `${envelope.sourceId}\0${envelope.providerObjectId}`;
    const current = this.envelopes.get(key);
    if (current?.envelope.providerVersion === envelope.providerVersion && current.envelope.contentDigest !== envelope.contentDigest) {
      throw new Error(`Source object '${envelope.providerObjectId}' reused provider version '${envelope.providerVersion}' with different content.`);
    }
    if (current?.envelope.providerVersion === envelope.providerVersion && current.envelope.contentDigest === envelope.contentDigest && current.envelope.deletionState === "present") return "unchanged";
    const retentionUntil = sourceRetentionUntil(envelope.observedAt, retention);
    this.envelopes.set(key, { envelope: structuredClone(envelope), retentionUntil });
    return current ? "updated" : "inserted";
  }

  async getEnvelope(sourceId: string, providerObjectId: string, providerVersion?: string): Promise<SourceEnvelope | undefined> {
    const entry = this.envelopes.get(`${sourceId}\0${providerObjectId}`)?.envelope;
    return entry && (!providerVersion || entry.providerVersion === providerVersion) ? structuredClone(entry) : undefined;
  }

  async reconcileEnvelopes(sourceId: string, presentObjectIds: readonly string[], observedAt: string, retention: SourceRetentionPolicy): Promise<number> {
    const present = new Set(presentObjectIds);
    let changed = 0;
    for (const [key, value] of this.envelopes) {
      if (value.envelope.sourceId !== sourceId || present.has(value.envelope.providerObjectId) || value.envelope.deletionState === "deleted") continue;
      value.envelope = { ...value.envelope, observedAt, deletionState: "deleted", cursorOrEventId: `reconcile:${observedAt}` };
      value.retentionUntil = sourceRetentionUntil(observedAt, retention);
      this.envelopes.set(key, value);
      changed += 1;
    }
    return changed;
  }

  async purgeExpiredSourceContent(sourceId: string, now: string): Promise<number> {
    const source = this.sources.get(sourceId);
    if (!source) throw new Error(`Unknown Knowledge source '${sourceId}'.`);
    if (source.requirement.retention.mode === "retain") return 0;
    if (source.requirement.legalHold) return 0;
    const timestamp = Date.parse(now);
    if (Number.isNaN(timestamp)) throw new Error("Source retention purge requires an ISO timestamp.");
    let purged = 0;
    for (const [key, value] of this.envelopes) {
      if (value.envelope.sourceId !== sourceId || value.envelope.deletionState !== "deleted" || !value.envelope.boundedText || Date.parse(value.retentionUntil) > timestamp) continue;
      value.envelope = { ...value.envelope, boundedText: undefined };
      this.envelopes.set(key, value);
      const deletionReceipt: SourceReceipt = {
        receiptId: sha256({ sourceId, operation: "delete", objectId: value.envelope.providerObjectId, objectVersion: value.envelope.providerVersion, contentDigest: value.envelope.contentDigest }),
        sourceId,
        operation: "delete",
        observedAt: now,
        objectId: value.envelope.providerObjectId,
        objectVersion: value.envelope.providerVersion,
        evidence: { content_redacted: true, content_digest: value.envelope.contentDigest },
      };
      await this.recordReceipt(deletionReceipt);
      purged += 1;
    }
    return purged;
  }

  async updateCursor(sourceId: string, cursor: string | undefined, completed: boolean): Promise<void> {
    const source = this.sources.get(sourceId);
    if (!source) throw new Error(`Unknown Knowledge source '${sourceId}'.`);
    source.cursor = cursor;
    source.completed = completed;
  }

  async recordSourceHealth(health: SourceHealth): Promise<void> {
    const source = this.sources.get(health.sourceId);
    if (!source) throw new Error(`Unknown Knowledge source '${health.sourceId}'.`);
    source.health = structuredClone(health);
  }

  async revokeSource(sourceId: string, revokeReceipt: SourceReceipt): Promise<void> {
    const source = this.sources.get(sourceId);
    if (!source) throw new Error(`Unknown Knowledge source '${sourceId}'.`);
    source.revoked = true;
    source.cursor = undefined;
    await this.recordReceipt(revokeReceipt);
  }

  async recordObservation(observation: RuntimeObservation): Promise<boolean> {
    if (this.observations.has(observation.observationId)) return false;
    this.observations.set(observation.observationId, structuredClone(observation));
    if (observation.supersedes) await this.supersedeObservation(observation.supersedes, observation.observationId);
    return true;
  }

  async getObservation(observationId: string): Promise<RuntimeObservation | undefined> {
    const observation = this.observations.get(observationId);
    return observation ? structuredClone(observation) : undefined;
  }

  async supersedeObservation(observationId: string, replacementId: string): Promise<boolean> {
    const original = this.observations.get(observationId);
    const replacement = this.observations.get(replacementId);
    if (!original || !replacement || original.status === "deleted" || original.status === "superseded") return false;
    original.status = "superseded";
    return true;
  }

  async expireObservations(now: string): Promise<number> {
    const timestamp = Date.parse(now);
    if (Number.isNaN(timestamp)) throw new Error("Observation expiration requires an ISO timestamp.");
    let count = 0;
    for (const observation of this.observations.values()) {
      if (observation.status === "active" && observation.expiresAt && Date.parse(observation.expiresAt) <= timestamp) {
        observation.status = "expired";
        count += 1;
      }
    }
    return count;
  }

  async requestObservationDeletion(observationId: string, requestedBy: string, reason: string): Promise<string> {
    const observation = this.observations.get(observationId);
    if (!observation) throw new Error(`Unknown Runtime Observation '${observationId}'.`);
    const requestedAt = new Date().toISOString();
    const id = sha256({ observationId, requestedBy, reason, requestedAt });
    this.deletionRequests.set(observationId, { id, requestedBy, reason, requestedAt });
    if (!this.legalHolds.has(observationId)) observation.status = "deletion-requested";
    return id;
  }

  async setObservationLegalHold(observationId: string, enabled: boolean, actor: string): Promise<boolean> {
    const observation = this.observations.get(observationId);
    if (!observation || observation.status === "deleted") return false;
    if (enabled) {
      this.legalHolds.set(observationId, { actor, enabledAt: new Date().toISOString() });
      observation.status = "legal-hold";
    } else {
      this.legalHolds.delete(observationId);
      observation.status = this.deletionRequests.has(observationId) ? "deletion-requested" : "active";
    }
    return true;
  }

  async applyObservationDeletion(observationId: string): Promise<"deleted" | "held" | "missing"> {
    const observation = this.observations.get(observationId);
    if (!observation) return "missing";
    if (this.legalHolds.has(observationId)) return "held";
    if (!this.deletionRequests.has(observationId)) throw new Error(`Runtime Observation '${observationId}' has no deletion request.`);
    observation.content = "";
    observation.evidence = {};
    observation.status = "deleted";
    return "deleted";
  }

  async listObservationPromotionCandidates(limit = 3): Promise<RuntimeObservation[]> {
    return [...this.observations.values()]
      .filter((entry) => entry.status === "active")
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.observationId.localeCompare(b.observationId))
      .slice(0, Math.max(1, Math.min(limit, 3)))
      .map((entry) => structuredClone(entry));
  }
}
