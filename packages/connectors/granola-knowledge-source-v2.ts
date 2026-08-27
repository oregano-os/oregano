import { createHmac, timingSafeEqual } from "node:crypto";
import { sha256 } from "../runtime/canonical.ts";
import {
  SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
  assertSourceConnectorSupportsV2,
  createSourceEventV2,
  type SourceAccessSnapshotV2,
  type SourceBindingV2,
  type SourceChangePageV2,
  type SourceConnectorDescriptorV2,
  type SourceConnectorV2,
  type SourceEventV2,
  type SourceHealthV2,
  type SourceReceiptOperationV2,
  type SourceReceiptV2,
  type SourceRequirementV2,
  type SourceVerificationV2,
} from "../knowledge/source-contracts-v2.ts";
import type { SourceRawAssetStager } from "../knowledge/source-pipeline-store.ts";

const WEBHOOK_EVENTS = ["note.generated", "note.edited", "note.access_granted"] as const;
const API_SCOPES = ["personal", "public", "workspace"] as const;
const NOTE_PATTERN = /^not_[a-zA-Z0-9]{14}$/;
const FOLDER_PATTERN = /^fol_[a-zA-Z0-9]{14}$/;

interface ReconciliationCursor {
  version: 1;
  containerIndex: number;
  providerCursor?: string;
  overlapFrom: string;
  maxUpdatedAt: string;
  checksum: string;
}

interface GranolaNoteListItem {
  id: string;
  updated_at: string;
}

interface GranolaTranscriptItem {
  speaker?: Record<string, unknown>;
  text?: unknown;
  start_time?: unknown;
  end_time?: unknown;
}

export interface GranolaKnowledgeSourceV2Options {
  requirement: SourceRequirementV2;
  binding: SourceBindingV2;
  descriptor: SourceConnectorDescriptorV2;
  resolveSecret(reference: string): string | Promise<string>;
  fetch?: typeof globalThis.fetch;
  now?: () => string;
  retryDelay?: (milliseconds: number) => Promise<void>;
  rawAssetStager?: SourceRawAssetStager;
}

const receipt = (input: {
  descriptor: SourceConnectorDescriptorV2;
  sourceId: string;
  operation: SourceReceiptOperationV2;
  outcome?: SourceReceiptV2["outcome"];
  observedAt: string;
  evidence: unknown;
  deliveryId?: string;
  providerObjectId?: string;
  providerVersion?: string;
  cursor?: string;
  reasonCode?: string;
}): SourceReceiptV2 => {
  const evidenceDigest = sha256(input.evidence);
  const value = {
    contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
    sourceId: input.sourceId,
    connectorId: input.descriptor.connectorId,
    connectorVersion: input.descriptor.connectorVersion,
    operation: input.operation,
    outcome: input.outcome ?? "succeeded",
    observedAt: input.observedAt,
    evidenceDigest,
    ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
    ...(input.providerObjectId ? { providerObjectId: input.providerObjectId } : {}),
    ...(input.providerVersion ? { providerVersion: input.providerVersion } : {}),
    ...(input.cursor ? { cursorDigest: sha256(input.cursor) } : {}),
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
  };
  return { ...value, receiptId: sha256(value) };
};

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
};

const iso = (value: unknown, label: string): string => {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(value).toISOString();
};

const encodeCursor = (sourceId: string, input: Omit<ReconciliationCursor, "version" | "checksum">): string => {
  const value: ReconciliationCursor = {
    version: 1,
    ...input,
    checksum: sha256({ sourceId, version: 1, ...input }),
  };
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
};

const decodeCursor = (sourceId: string, encoded: string): ReconciliationCursor => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Granola reconciliation cursor is malformed.");
  }
  const value = object(parsed, "Granola reconciliation cursor") as unknown as ReconciliationCursor;
  if (
    value.version !== 1
    || !Number.isSafeInteger(value.containerIndex)
    || value.containerIndex < 0
    || typeof value.overlapFrom !== "string"
    || Number.isNaN(Date.parse(value.overlapFrom))
    || typeof value.maxUpdatedAt !== "string"
    || Number.isNaN(Date.parse(value.maxUpdatedAt))
    || (value.providerCursor !== undefined && (typeof value.providerCursor !== "string" || !value.providerCursor))
  ) throw new Error("Granola reconciliation cursor is invalid.");
  const { checksum, version: _version, ...content } = value;
  if (checksum !== sha256({ sourceId, version: 1, ...content })) throw new Error("Granola reconciliation cursor failed integrity validation.");
  return value;
};

const text = (value: unknown): string => typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";

export class GranolaKnowledgeSourceConnectorV2 implements SourceConnectorV2 {
  readonly descriptor: SourceConnectorDescriptorV2;
  readonly sourceId: string;
  readonly #requirement: SourceRequirementV2;
  readonly #binding: SourceBindingV2;
  readonly #resolveSecret: GranolaKnowledgeSourceV2Options["resolveSecret"];
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => string;
  readonly #retryDelay: (milliseconds: number) => Promise<void>;
  readonly #rawAssetStager?: SourceRawAssetStager;

  constructor(options: GranolaKnowledgeSourceV2Options) {
    assertSourceConnectorSupportsV2({ descriptor: options.descriptor, requirement: options.requirement, binding: options.binding });
    if (options.requirement.sourceKind !== "meeting" || options.requirement.deliveryMode !== "hybrid") throw new Error("The Granola Connector requires a meeting/hybrid Source profile.");
    if ((options.requirement.providerScope.kind !== "workspace" && options.requirement.providerScope.kind !== "workspace-containers") || options.binding.providerIdentity.kind !== "workspace") throw new Error("The Granola Connector requires workspace or workspace-container scope and workspace provider identity.");
    if (options.requirement.providerScope.workspaceId !== options.binding.providerIdentity.workspaceId) throw new Error("Granola requirement and binding workspace identities differ.");
    if (options.requirement.access.mode === "provider-acl") throw new Error("The Granola public API does not expose sufficient per-note principal ACL evidence; use a fixed root policy or quarantine.");
    if (!options.binding.secretRefs.primary || !options.binding.secretRefs.webhook) throw new Error("The Granola Connector requires primary API and webhook signing SecretRefs.");
    if (options.binding.requiredScopes.length === 0 || options.binding.requiredScopes.some((scope) => !API_SCOPES.includes(scope as typeof API_SCOPES[number]))) throw new Error("Granola requiredScopes must use personal, public, or workspace API scopes.");
    if (options.binding.requiredScopes.includes("workspace") && options.binding.requiredScopes.length !== 1) throw new Error("A Granola workspace API key uses exactly the workspace scope.");
    if (options.requirement.providerScope.kind === "workspace-containers" && options.requirement.providerScope.containerIds.some((entry) => !FOLDER_PATTERN.test(entry))) throw new Error("Granola container scope requires exact folder IDs.");
    const apiBaseUrl = options.binding.providerIdentity.apiBaseUrl ?? "https://public-api.granola.ai";
    if (new URL(apiBaseUrl).protocol !== "https:") throw new Error("Granola apiBaseUrl must use HTTPS.");
    this.descriptor = structuredClone(options.descriptor);
    this.sourceId = options.requirement.sourceId;
    this.#requirement = structuredClone(options.requirement);
    this.#binding = structuredClone({
      ...options.binding,
      providerIdentity: { ...options.binding.providerIdentity, apiBaseUrl: apiBaseUrl.replace(/\/$/, "") },
    });
    this.#resolveSecret = options.resolveSecret;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#retryDelay = options.retryDelay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#rawAssetStager = options.rawAssetStager;
  }

  async verify(): Promise<SourceVerificationV2> {
    const configured = new Set(this.#containerIds());
    let cursor: string | undefined;
    let pages = 0;
    const found = new Set<string>();
    if (this.#isProviderWide()) {
      pages = 1;
      const response = await this.#request("/v1/notes?page_size=1");
      const body = object(response.body, "Granola notes response");
      if (!Array.isArray(body.notes) || typeof body.hasMore !== "boolean") throw new Error("Granola notes response is malformed.");
    } else {
      do {
        pages += 1;
        if (pages > 1_000) throw new Error("Granola folder verification exceeded the bounded page limit.");
        const query = new URLSearchParams({ page_size: "30", ...(cursor ? { cursor } : {}) });
        const response = await this.#request(`/v1/folders?${query.toString()}`);
        const body = object(response.body, "Granola folder response");
        if (!Array.isArray(body.folders) || typeof body.hasMore !== "boolean") throw new Error("Granola folder response is malformed.");
        for (const entry of body.folders) {
          const folder = object(entry, "Granola folder");
          if (typeof folder.id === "string" && configured.has(folder.id)) found.add(folder.id);
        }
        cursor = body.hasMore === true ? String(body.cursor ?? "") : undefined;
        if (body.hasMore === true && !cursor) throw new Error("Granola folder response hasMore without a cursor.");
      } while (cursor);
    }
    const missing = [...configured].filter((entry) => !found.has(entry));
    if (missing.length > 0) throw new Error(`Granola configured folder scope is unavailable: ${missing.join(", ")}.`);
    const observedAt = this.#now();
    const verificationReceipt = receipt({
      descriptor: this.descriptor,
      sourceId: this.sourceId,
      operation: "verify",
      observedAt,
      evidence: {
        boundWorkspaceId: this.#workspace().workspaceId,
        workspaceIdentityEvidence: "binding-and-administrator-qualification-required",
        providerScope: this.#isProviderWide() ? "workspace" : "workspace-containers",
        configuredFolderIds: [...configured].sort(),
        verifiedFolderIds: [...found].sort(),
        requiredScopes: this.#binding.requiredScopes,
        pages,
      },
      reasonCode: this.#isProviderWide() ? "provider-wide-scope-verified-admin-evidence-required" : "container-scope-verified-workspace-admin-evidence-required",
    });
    return {
      ok: true,
      sourceId: this.sourceId,
      connectorId: this.descriptor.connectorId,
      connectorVersion: this.descriptor.connectorVersion,
      providerIdentity: structuredClone(this.#workspace()),
      verifiedScopes: [...this.#binding.requiredScopes],
      verifiedDeliveryModes: ["webhook", "hybrid"],
      aclMapping: this.#requirement.access.mode === "quarantine" ? "quarantine-only" : "verified",
      receipt: verificationReceipt,
    };
  }

  async readChanges(input: { cursor?: string; pageSize: number; overlapFrom?: string }): Promise<SourceChangePageV2> {
    const partitions = this.#partitions();
    const prior = input.cursor ? decodeCursor(this.sourceId, input.cursor) : undefined;
    const overlapFrom = prior?.overlapFrom ?? iso(input.overlapFrom ?? "1970-01-01T00:00:00.000Z", "Granola overlapFrom");
    const containerIndex = prior?.containerIndex ?? 0;
    if (containerIndex >= partitions.length) throw new Error("Granola reconciliation cursor partition index is outside the configured scope.");
    const pageSize = Math.max(1, Math.min(input.pageSize, 30));
    const folderId = partitions[containerIndex];
    const query = new URLSearchParams({
      updated_after: overlapFrom,
      page_size: String(pageSize),
      ...(folderId ? { folder_id: folderId } : {}),
      ...(prior?.providerCursor ? { cursor: prior.providerCursor } : {}),
    });
    const response = await this.#request(`/v1/notes?${query.toString()}`);
    const body = object(response.body, "Granola notes response");
    if (!Array.isArray(body.notes) || typeof body.hasMore !== "boolean") throw new Error("Granola notes response is malformed.");
    const observedAt = this.#now();
    let maxUpdatedAt = prior?.maxUpdatedAt ?? overlapFrom;
    const events = body.notes.map((entry): SourceEventV2 => {
      const note = object(entry, "Granola note list item") as unknown as GranolaNoteListItem;
      if (!NOTE_PATTERN.test(note.id)) throw new Error("Granola note list returned an invalid note identity.");
      const updatedAt = iso(note.updated_at, `Granola note '${note.id}' updated_at`);
      if (Date.parse(updatedAt) > Date.parse(maxUpdatedAt)) maxUpdatedAt = updatedAt;
      return createSourceEventV2({
        deliveryId: `reconcile:${sha256({ workspaceId: this.#workspace().workspaceId, noteId: note.id, updatedAt })}`,
        sourceId: this.sourceId,
        providerTenantId: this.#workspace().workspaceId,
        eventType: "updated",
        providerObjectId: note.id,
        providerVersion: updatedAt,
        occurredAt: updatedAt,
        observedAt,
        locator: `granola:${note.id}`,
        watermark: maxUpdatedAt,
      });
    });
    let nextCursor: string | undefined;
    if (body.hasMore === true) {
      if (typeof body.cursor !== "string" || !body.cursor) throw new Error("Granola notes response hasMore without a cursor.");
      nextCursor = encodeCursor(this.sourceId, { containerIndex, providerCursor: body.cursor, overlapFrom, maxUpdatedAt });
    } else if (containerIndex + 1 < partitions.length) {
      nextCursor = encodeCursor(this.sourceId, { containerIndex: containerIndex + 1, overlapFrom, maxUpdatedAt });
    }
    const complete = nextCursor === undefined;
    const pageReceipt = receipt({
      descriptor: this.descriptor,
      sourceId: this.sourceId,
      operation: "read-changes",
      observedAt,
      cursor: input.cursor,
      evidence: {
        scope: folderId ? { kind: "folder", folderId } : { kind: "workspace" },
        containerIndex,
        overlapFrom,
        pageSize,
        returned: events.length,
        providerHasMore: body.hasMore,
        complete,
        maxUpdatedAt,
      },
    });
    return {
      events,
      ...(nextCursor ? { nextCursor } : {}),
      complete,
      completedWatermark: maxUpdatedAt,
      receipt: pageReceipt,
    };
  }

  async acceptWebhook(input: { rawBody: Uint8Array; headers: Readonly<Record<string, string>>; observedAt: string }) {
    if (input.rawBody.byteLength === 0 || input.rawBody.byteLength > 65_536) throw new Error("Granola webhook body violates the bounded reference-event size.");
    const headers = Object.fromEntries(Object.entries(input.headers).map(([key, value]) => [key.toLowerCase(), value]));
    const webhookId = headers["webhook-id"];
    const timestamp = headers["webhook-timestamp"];
    const signatures = headers["webhook-signature"];
    if (!webhookId || !timestamp || !signatures || !/^[0-9]+$/.test(timestamp)) throw new Error("Granola webhook signature headers are missing or invalid.");
    const observedAt = iso(input.observedAt, "Granola webhook observedAt");
    if (Math.abs(Date.parse(observedAt) / 1_000 - Number(timestamp)) > 300) throw new Error("Granola webhook timestamp is outside the five-minute replay window.");
    const signingSecret = await this.#resolveSecret(this.#binding.secretRefs.webhook);
    if (!signingSecret.startsWith("whsec_")) throw new Error("Granola webhook SecretRef did not resolve to a Standard Webhooks signing secret.");
    const rawText = new TextDecoder("utf-8", { fatal: true }).decode(input.rawBody);
    const expected = Buffer.from(createHmac("sha256", Buffer.from(signingSecret.slice("whsec_".length), "base64"))
      .update(`${webhookId}.${timestamp}.${rawText}`, "utf8")
      .digest("base64"));
    const valid = signatures.split(" ").some((candidate) => {
      const [version, signature = ""] = candidate.split(",");
      if (version !== "v1") return false;
      const provided = Buffer.from(signature);
      return provided.length === expected.length && timingSafeEqual(provided, expected);
    });
    if (!valid) throw new Error("Granola webhook signature verification failed.");
    const payload = object(JSON.parse(rawText), "Granola webhook payload");
    if (payload.event_id !== webhookId || typeof payload.event_id !== "string") throw new Error("Granola webhook payload and header event identities differ.");
    if (!WEBHOOK_EVENTS.includes(payload.event_type as typeof WEBHOOK_EVENTS[number])) throw new Error("Granola webhook event type is unsupported.");
    if (typeof payload.note_id !== "string" || !NOTE_PATTERN.test(payload.note_id)) throw new Error("Granola webhook note identity is invalid.");
    const occurredAt = iso(payload.occurred_at, "Granola webhook occurred_at");
    const event = createSourceEventV2({
      deliveryId: `webhook:${payload.event_id}`,
      sourceId: this.sourceId,
      providerTenantId: this.#workspace().workspaceId,
      eventType: payload.event_type === "note.generated" ? "created" : "updated",
      providerObjectId: payload.note_id,
      occurredAt,
      observedAt,
      locator: `granola:${payload.note_id}`,
    });
    const webhookReceipt = receipt({
      descriptor: this.descriptor,
      sourceId: this.sourceId,
      operation: "webhook",
      observedAt,
      deliveryId: event.deliveryId,
      providerObjectId: event.providerObjectId,
      evidence: { eventId: event.eventId, webhookId, eventType: payload.event_type, rawBodyDigest: sha256(input.rawBody) },
      reasonCode: "signature-verified-reference-enqueued",
    });
    return { events: [event], receipt: webhookReceipt };
  }

  async fetch(event: SourceEventV2) {
    if (!["created", "updated"].includes(event.eventType) || !NOTE_PATTERN.test(event.providerObjectId) || event.locator !== `granola:${event.providerObjectId}`) throw new Error("Granola fetch requires a valid note reference event.");
    let noteResponse = await this.#request(`/v1/notes/${encodeURIComponent(event.providerObjectId)}?include=transcript`, [413]);
    let note: Record<string, unknown>;
    let transcript: GranolaTranscriptItem[];
    if (noteResponse.status === 413) {
      noteResponse = await this.#request(`/v1/notes/${encodeURIComponent(event.providerObjectId)}`);
      note = object(noteResponse.body, "Granola note response");
      transcript = await this.#readTranscript(event.providerObjectId);
    } else {
      note = object(noteResponse.body, "Granola note response");
      transcript = Array.isArray(note.transcript) ? note.transcript as GranolaTranscriptItem[] : await this.#readTranscript(event.providerObjectId);
    }
    if (note.id !== event.providerObjectId || note.object !== "note") throw new Error("Granola fetched note identity does not match its Source Event.");
    const providerVersion = iso(note.updated_at, "Granola note updated_at");
    if (event.providerVersion && event.providerVersion !== providerVersion) throw new Error("Granola fetched note update identity does not match reconciliation evidence.");
    const folders = Array.isArray(note.folder_membership) ? note.folder_membership.map((entry) => object(entry, "Granola folder membership")) : [];
    const folderIds = folders.map((entry) => String(entry.id ?? "")).filter((entry) => FOLDER_PATTERN.test(entry));
    if (!this.#isInScope(folderIds)) throw new Error("Granola note is outside the configured folder scope.");
    const inlineText = this.#formatNote(note, transcript);
    const size = Buffer.byteLength(inlineText);
    const contentDigest = sha256(inlineText);
    let content: { inlineText: string } | { rawAsset: Awaited<ReturnType<SourceRawAssetStager["stage"]>>["reference"] };
    let assetPayload: Uint8Array | undefined;
    if (size > this.#requirement.content.maxInlineBytes) {
      if (!this.#rawAssetStager) throw new Error("Granola transcript exceeds the inline boundary and requires a qualified durable Raw Asset adapter.");
      const staged = await this.#rawAssetStager.stage({
        sourceId: this.sourceId,
        providerObjectId: event.providerObjectId,
        providerVersion,
        mediaType: "text/markdown",
        bytes: Buffer.from(inlineText, "utf8"),
      });
      if (staged.reference.contentDigest !== contentDigest || staged.reference.size !== size || staged.reference.mediaType !== "text/markdown") throw new Error("Granola Raw Asset staging returned mismatched transcript evidence.");
      content = { rawAsset: staged.reference };
      assetPayload = staged.payload;
    } else {
      content = { inlineText };
    }
    const access = this.#accessSnapshot(event.providerObjectId, providerVersion, folderIds, event.observedAt);
    const fetchReceipt = receipt({
      descriptor: this.descriptor,
      sourceId: this.sourceId,
      operation: "fetch",
      observedAt: event.observedAt,
      deliveryId: event.deliveryId,
      providerObjectId: event.providerObjectId,
      providerVersion,
      evidence: {
        eventId: event.eventId,
        contentDigest,
        size,
        transcriptItems: transcript.length,
        folderIds: folderIds.sort(),
        accessVersion: access.providerAccessVersion,
      },
    });
    return {
      envelope: {
        contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
        sourceId: this.sourceId,
        providerTenantId: this.#workspace().workspaceId,
        providerObjectId: event.providerObjectId,
        providerVersion,
        eventId: event.eventId,
        observedAt: event.observedAt,
        locator: event.locator,
        mediaType: "text/markdown" as const,
        size,
        contentDigest,
        accessPolicyId: this.#requirement.access.rootPolicyId,
        deletionState: "present" as const,
        content,
      },
      access,
      receipt: fetchReceipt,
      ...(assetPayload ? { assetPayload } : {}),
    };
  }

  async readAccess(event: SourceEventV2) {
    const response = await this.#request(`/v1/notes/${encodeURIComponent(event.providerObjectId)}`);
    const note = object(response.body, "Granola note response");
    if (note.id !== event.providerObjectId) throw new Error("Granola access fetch returned a mismatched note.");
    const version = iso(note.updated_at, "Granola note updated_at");
    const folders = Array.isArray(note.folder_membership) ? note.folder_membership.map((entry) => object(entry, "Granola folder membership")) : [];
    const folderIds = folders.map((entry) => String(entry.id ?? "")).filter((entry) => FOLDER_PATTERN.test(entry));
    const access = this.#accessSnapshot(event.providerObjectId, version, folderIds, event.observedAt);
    const accessReceipt = receipt({
      descriptor: this.descriptor,
      sourceId: this.sourceId,
      operation: "read-access",
      observedAt: event.observedAt,
      deliveryId: event.deliveryId,
      providerObjectId: event.providerObjectId,
      providerVersion: version,
      evidence: { providerAccessVersion: access.providerAccessVersion, folderIds: folderIds.sort() },
    });
    return { access, receipt: accessReceipt };
  }

  async health(): Promise<SourceHealthV2> {
    const checkedAt = this.#now();
    try {
      await this.verify();
      return {
        ok: true,
        sourceId: this.sourceId,
        status: "healthy",
        checkedAt,
        receipt: receipt({ descriptor: this.descriptor, sourceId: this.sourceId, operation: "health", observedAt: checkedAt, evidence: { status: "healthy" } }),
      };
    } catch (error) {
      return {
        ok: false,
        sourceId: this.sourceId,
        status: "error",
        checkedAt,
        reasonCode: "provider-error",
        receipt: receipt({ descriptor: this.descriptor, sourceId: this.sourceId, operation: "health", outcome: "failed", observedAt: checkedAt, reasonCode: "provider-error", evidence: { errorDigest: sha256(error instanceof Error ? error.message : String(error)) } }),
      };
    }
  }

  async revoke(): Promise<SourceReceiptV2> {
    const observedAt = this.#now();
    return receipt({
      descriptor: this.descriptor,
      sourceId: this.sourceId,
      operation: "revoke",
      observedAt,
      reasonCode: "local-binding-revoked",
      evidence: { installationId: this.#binding.installationId, localBindingRevoked: true },
    });
  }

  #workspace(): Extract<SourceBindingV2["providerIdentity"], { kind: "workspace" }> {
    if (this.#binding.providerIdentity.kind !== "workspace") throw new Error("Granola binding lost its workspace identity.");
    return this.#binding.providerIdentity;
  }

  #containerIds(): string[] {
    return this.#requirement.providerScope.kind === "workspace-containers" ? this.#requirement.providerScope.containerIds : [];
  }

  #isProviderWide(): boolean {
    return this.#requirement.providerScope.kind === "workspace";
  }

  #partitions(): Array<string | undefined> {
    return this.#isProviderWide() ? [undefined] : this.#containerIds();
  }

  #isInScope(folderIds: string[]): boolean {
    return this.#isProviderWide() || this.#containerIds().some((entry) => folderIds.includes(entry));
  }

  #accessSnapshot(providerObjectId: string, providerVersion: string, folderIds: string[], observedAt: string): SourceAccessSnapshotV2 {
    const inScope = this.#isInScope(folderIds);
    const providerAccessVersion = sha256({
      workspaceId: this.#workspace().workspaceId,
      providerObjectId,
      providerVersion,
      folderIds: [...folderIds].sort(),
      access: this.#requirement.access,
      providerScope: this.#requirement.providerScope,
      inScope,
    });
    return {
      contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
      sourceId: this.sourceId,
      providerObjectId,
      providerAccessVersion,
      observedAt,
      entries: [],
      evidenceDigest: sha256({ providerAccessVersion, inScope, folderIds: [...folderIds].sort() }),
    };
  }

  #formatNote(note: Record<string, unknown>, transcript: GranolaTranscriptItem[]): string {
    const title = text(note.title) || "Untitled meeting";
    const owner = note.owner && typeof note.owner === "object" ? note.owner as Record<string, unknown> : {};
    const attendees = Array.isArray(note.attendees) ? note.attendees.map((entry) => object(entry, "Granola attendee")) : [];
    const lines = [
      `# ${title}`,
      "",
      "## Meeting metadata",
      "",
      `- Note ID: ${String(note.id)}`,
      `- Created: ${iso(note.created_at, "Granola note created_at")}`,
      `- Updated: ${iso(note.updated_at, "Granola note updated_at")}`,
      `- Owner: ${text(owner.name) || "Unknown"}${text(owner.email) ? ` <${text(owner.email)}>` : ""}`,
      `- Attendees: ${attendees.map((entry) => `${text(entry.name) || "Unknown"}${text(entry.email) ? ` <${text(entry.email)}>` : ""}`).join(", ") || "None listed"}`,
      "",
      "## Summary",
      "",
      text(note.summary_markdown) || text(note.summary_text) || "No summary.",
      "",
      "## Transcript",
      "",
    ];
    for (const item of transcript) {
      const speaker = item.speaker && typeof item.speaker === "object" ? item.speaker : {};
      const speakerLabel = text(speaker.name) || text(speaker.diarization_label) || text(speaker.attribution) || text(speaker.source) || "Unknown speaker";
      const timing = text(item.start_time) ? `[${text(item.start_time)}] ` : "";
      lines.push(`${timing}${speakerLabel}: ${text(item.text)}`);
    }
    return `${lines.join("\n").trim()}\n`;
  }

  async #readTranscript(noteId: string): Promise<GranolaTranscriptItem[]> {
    const result: GranolaTranscriptItem[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      pages += 1;
      if (pages > 10_000) throw new Error("Granola transcript exceeded the bounded page limit.");
      const query = new URLSearchParams({ page_size: "100", ...(cursor ? { cursor } : {}) });
      const response = await this.#request(`/v1/notes/${encodeURIComponent(noteId)}/transcript?${query.toString()}`);
      const body = object(response.body, "Granola transcript response");
      if (!Array.isArray(body.transcript) || typeof body.hasMore !== "boolean") throw new Error("Granola transcript response is malformed.");
      result.push(...body.transcript as GranolaTranscriptItem[]);
      cursor = body.hasMore === true ? String(body.cursor ?? "") : undefined;
      if (body.hasMore === true && !cursor) throw new Error("Granola transcript response hasMore without a cursor.");
      if (Buffer.byteLength(result.map((entry) => text(entry.text)).join("\n")) > this.#requirement.content.maxAssetBytes) throw new Error("Granola transcript exceeds the configured maximum asset boundary.");
    } while (cursor);
    return result;
  }

  async #request(path: string, allowedStatuses: number[] = []): Promise<{ status: number; body: unknown }> {
    const token = await this.#resolveSecret(this.#binding.secretRefs.primary);
    if (!token) throw new Error(`SecretRef '${this.#binding.secretRefs.primary}' resolved to an empty value.`);
    let lastStatus = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await this.#fetch(`${this.#workspace().apiBaseUrl}${path}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "oregano-company-knowledge",
        },
      });
      lastStatus = response.status;
      const body = await response.json().catch(() => undefined);
      if (response.ok || allowedStatuses.includes(response.status)) return { status: response.status, body };
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 3) break;
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) ? Math.min(retryAfter * 1_000, 1_000) : Math.min(100 * (2 ** (attempt - 1)), 1_000);
      await this.#retryDelay(delay);
    }
    throw new Error(`Granola API request failed after bounded retry (HTTP ${lastStatus}).`);
  }
}
