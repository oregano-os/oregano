import { createHmac, timingSafeEqual } from "node:crypto";
import { sha256 } from "../../runtime/canonical.ts";

const WEBHOOK_EVENTS = ["note.generated", "note.edited", "note.access_granted"] as const;
const NOTE_PATTERN = /^not_[a-zA-Z0-9]{14}$/;
const FOLDER_PATTERN = /^fol_[a-zA-Z0-9]{14}$/;

interface GranolaTranscriptItem {
  speaker?: Record<string, unknown>;
  text?: unknown;
  start_time?: unknown;
  end_time?: unknown;
}

export interface GranolaConnection {
  workspaceId: string;
  apiBaseUrl?: string;
  apiKeyRef: string;
  webhookSecretRef: string;
  requiredScopes: Array<"personal" | "public" | "workspace">;
  scope: { kind: "workspace" } | { kind: "workspace-containers"; folderIds: string[] };
  maxContentBytes: number;
}

export interface GranolaClientOptions {
  connection: GranolaConnection;
  resolveSecret(reference: string): string | Promise<string>;
  fetch?: typeof globalThis.fetch;
  retryDelay?: (milliseconds: number) => Promise<void>;
}

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
};

const iso = (value: unknown, label: string): string => {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(value).toISOString();
};

const text = (value: unknown): string => typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";

/** Retained provider integration; no scheduler, database, ingestion or Agent grant. */
export class GranolaClient {
  readonly #connection: GranolaConnection & { apiBaseUrl: string };
  readonly #resolveSecret: GranolaClientOptions["resolveSecret"];
  readonly #fetch: typeof globalThis.fetch;
  readonly #retryDelay: (milliseconds: number) => Promise<void>;

  constructor(options: GranolaClientOptions) {
    const value = options.connection;
    if (!value.workspaceId || !value.apiKeyRef || !value.webhookSecretRef) throw new Error("Granola requires an explicit workspace and separate API/webhook SecretRefs.");
    if (!Number.isSafeInteger(value.maxContentBytes) || value.maxContentBytes < 1) throw new Error("Granola requires an explicit positive content bound.");
    if (value.requiredScopes.length === 0 || value.requiredScopes.some(scope => !["personal", "public", "workspace"].includes(scope))) throw new Error("Granola API scopes are invalid.");
    if (value.requiredScopes.includes("workspace") && value.requiredScopes.length !== 1) throw new Error("A Granola workspace API key uses exactly the workspace scope.");
    if (value.scope.kind !== "workspace" && value.scope.kind !== "workspace-containers") throw new Error("Granola provider scope is invalid.");
    if (value.scope.kind === "workspace-containers" && (value.scope.folderIds.length === 0 || value.scope.folderIds.some(id => !FOLDER_PATTERN.test(id)))) throw new Error("Granola folder scope requires explicit valid folder IDs.");
    const url = new URL(value.apiBaseUrl ?? "https://public-api.granola.ai");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Granola API base must be an HTTPS origin without credentials.");
    this.#connection = { ...structuredClone(value), apiBaseUrl: url.origin };
    this.#resolveSecret = options.resolveSecret;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#retryDelay = options.retryDelay ?? ((milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds)));
  }

  async verifyScope(): Promise<{ reachable: true; configuredFolderCount: number }> {
    const configured = new Set(this.#containerIds());
    const found = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    if (this.#isProviderWide()) {
      const response = await this.#request("/v1/notes?page_size=1");
      const body = object(response.body, "Granola notes response");
      if (!Array.isArray(body.notes) || typeof body.hasMore !== "boolean") throw new Error("Granola notes response is malformed.");
    } else {
      do {
        if (++pages > 1_000) throw new Error("Granola folder verification exceeded the bounded page limit.");
        const query = new URLSearchParams({ page_size: "30", ...(cursor ? { cursor } : {}) });
        const response = await this.#request(`/v1/folders?${query}`);
        const body = object(response.body, "Granola folder response");
        if (!Array.isArray(body.folders) || typeof body.hasMore !== "boolean") throw new Error("Granola folder response is malformed.");
        for (const entry of body.folders) {
          const folder = object(entry, "Granola folder");
          if (typeof folder.id === "string" && configured.has(folder.id)) found.add(folder.id);
        }
        cursor = body.hasMore === true && typeof body.cursor === "string" ? body.cursor : undefined;
        if (body.hasMore && !cursor) throw new Error("Granola folder response hasMore without a cursor.");
      } while (cursor);
    }
    if ([...configured].some(id => !found.has(id))) throw new Error("Granola configured folder scope is unavailable.");
    // Reachability does not prove the provider workspace identity or per-note ACLs.
    return { reachable: true, configuredFolderCount: configured.size };
  }

  async listNotes(input: { pageSize: number; cursor?: string; updatedAfter?: string; folderId?: string }) {
    if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 30) throw new Error("Granola note page size must be between 1 and 30.");
    if (input.folderId && (!FOLDER_PATTERN.test(input.folderId) || (!this.#isProviderWide() && !this.#containerIds().includes(input.folderId)))) throw new Error("Granola folder is outside the configured scope.");
    if (!this.#isProviderWide() && !input.folderId) throw new Error("Granola folder-scoped reads require an exact configured folder.");
    const query = new URLSearchParams({ page_size: String(input.pageSize), ...(input.cursor ? { cursor: input.cursor } : {}), ...(input.updatedAfter ? { updated_after: iso(input.updatedAfter, "Granola updatedAfter") } : {}), ...(input.folderId ? { folder_id: input.folderId } : {}) });
    const response = await this.#request(`/v1/notes?${query}`);
    const body = object(response.body, "Granola notes response");
    if (!Array.isArray(body.notes) || body.notes.length > input.pageSize || typeof body.hasMore !== "boolean") throw new Error("Granola notes response is malformed.");
    const notes = body.notes.map(entry => {
      const note = object(entry, "Granola note list item");
      if (typeof note.id !== "string" || !NOTE_PATTERN.test(note.id)) throw new Error("Granola note identity is invalid.");
      return { id: note.id, updatedAt: iso(note.updated_at, "Granola note updated_at") };
    });
    if (body.hasMore && (typeof body.cursor !== "string" || !body.cursor)) throw new Error("Granola notes response hasMore without a cursor.");
    return { notes, ...(body.hasMore ? { nextCursor: body.cursor as string } : {}) };
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
    const signingSecret = await this.#resolveSecret(this.#connection.webhookSecretRef);
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
    return { eventId: payload.event_id, eventType: payload.event_type as typeof WEBHOOK_EVENTS[number], noteId: payload.note_id, occurredAt, observedAt };
  }

  async fetchNote(input: { noteId: string; expectedUpdatedAt?: string }) {
    if (!NOTE_PATTERN.test(input.noteId)) throw new Error("Granola fetch requires a valid note identity.");
    let noteResponse = await this.#request(`/v1/notes/${encodeURIComponent(input.noteId)}?include=transcript`, [413]);
    let note: Record<string, unknown>;
    let transcript: GranolaTranscriptItem[];
    if (noteResponse.status === 413) {
      noteResponse = await this.#request(`/v1/notes/${encodeURIComponent(input.noteId)}`);
      note = object(noteResponse.body, "Granola note response");
      transcript = await this.#readTranscript(input.noteId);
    } else {
      note = object(noteResponse.body, "Granola note response");
      transcript = Array.isArray(note.transcript) ? note.transcript as GranolaTranscriptItem[] : await this.#readTranscript(input.noteId);
    }
    if (note.id !== input.noteId || note.object !== "note") throw new Error("Granola fetched note identity does not match its requested reference.");
    const providerVersion = iso(note.updated_at, "Granola note updated_at");
    if (input.expectedUpdatedAt && input.expectedUpdatedAt !== providerVersion) throw new Error("Granola fetched note update identity does not match reconciliation evidence.");
    const folders = Array.isArray(note.folder_membership) ? note.folder_membership.map((entry) => object(entry, "Granola folder membership")) : [];
    const folderIds = folders.map((entry) => String(entry.id ?? "")).filter((entry) => FOLDER_PATTERN.test(entry));
    if (!this.#isInScope(folderIds)) throw new Error("Granola note is outside the configured folder scope.");
    const inlineText = this.#formatNote(note, transcript);
    const size = Buffer.byteLength(inlineText);
    const contentDigest = sha256(inlineText);
    if (size > this.#connection.maxContentBytes) throw new Error("Granola note exceeds the configured maximum content boundary.");
    return { noteId: input.noteId, updatedAt: providerVersion, markdown: inlineText, contentDigest, size, folderIds, transcriptItems: transcript.length };
  }

  #containerIds(): string[] {
    return this.#connection.scope.kind === "workspace-containers" ? this.#connection.scope.folderIds : [];
  }

  #isProviderWide(): boolean { return this.#connection.scope.kind === "workspace"; }
  #isInScope(folderIds: string[]): boolean { return this.#isProviderWide() || this.#containerIds().some(id => folderIds.includes(id)); }

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
      if (Buffer.byteLength(result.map((entry) => text(entry.text)).join("\n")) > this.#connection.maxContentBytes) throw new Error("Granola transcript exceeds the configured maximum asset boundary.");
    } while (cursor);
    return result;
  }

  async #request(path: string, allowedStatuses: number[] = []): Promise<{ status: number; body: unknown }> {
    const token = await this.#resolveSecret(this.#connection.apiKeyRef);
    if (!token) throw new Error(`SecretRef '${this.#connection.apiKeyRef}' resolved to an empty value.`);
    let lastStatus = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await this.#fetch(`${this.#connection.apiBaseUrl}${path}`, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "oregano-granola",
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
