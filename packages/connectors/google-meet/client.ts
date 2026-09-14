import { JWT } from "google-auth-library";
import { createPrivateKey } from "node:crypto";
import { sha256 } from "../../runtime/canonical.ts";

export const GOOGLE_MEET_READ_SCOPE = "https://www.googleapis.com/auth/meetings.space.readonly";
const ORIGIN = "https://meet.googleapis.com";
const id = "[A-Za-z0-9_-]{1,256}";
const conferencePattern = new RegExp(`^conferenceRecords/${id}$`);
const transcriptPattern = new RegExp(`^conferenceRecords/${id}/transcripts/${id}$`);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export interface GoogleMeetIdentity { projectId: string; serviceAccountEmail: string; clientId: string; subject: string }
export class GoogleMeetError extends Error {
  readonly code: string; readonly httpStatus: number | null; readonly retryAfterSeconds: number | null;
  constructor(code: string, status: number | null = null, retryAfterSeconds: number | null = null) {
    super(`Google Meet read failed: ${code}${status === null ? "" : ` (HTTP ${status})`}`);
    this.name = "GoogleMeetError"; this.code = code; this.httpStatus = status; this.retryAfterSeconds = retryAfterSeconds;
  }
}
export function validateGoogleMeetIdentity(value: GoogleMeetIdentity): void {
  if (!value || !/^[a-z][a-z0-9-]{4,62}$/.test(value.projectId)
    || !/^[a-z0-9][a-z0-9-]{3,62}@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(value.serviceAccountEmail)
    || !/^\d{5,30}$/.test(value.clientId)
    || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value.subject)
    || value.subject.length > 254) throw new GoogleMeetError("invalid-delegated-identity");
}

/** Instance-owned JSON is validated, then only the fixed JWT fields reach Google's SDK. No ADC or key-file lookup. */
export function createGoogleMeetTokenProvider(secret: string, identity: GoogleMeetIdentity): () => Promise<string> {
  validateGoogleMeetIdentity(identity);
  let key: Record<string, unknown>;
  try {
    if (typeof secret !== "string" || secret.length > 64_000) throw new Error();
    const value: unknown = JSON.parse(secret); if (!object(value)) throw new Error(); key = value;
    if (key.type !== "service_account" || key.project_id !== identity.projectId || key.client_email !== identity.serviceAccountEmail
      || key.client_id !== identity.clientId || typeof key.private_key !== "string"
      || key.private_key.length > 16_000 || !key.private_key.startsWith("-----BEGIN PRIVATE KEY-----\n")
      || (key.token_uri !== undefined && !["https://oauth2.googleapis.com/token", "https://accounts.google.com/o/oauth2/token"].includes(String(key.token_uri)))) throw new Error();
    if (createPrivateKey(key.private_key).asymmetricKeyType !== "rsa") throw new Error();
  } catch { throw new GoogleMeetError("credential-identity-mismatch"); }
  const auth = new JWT({ email: identity.serviceAccountEmail, key: key.private_key as string,
    subject: identity.subject, scopes: [GOOGLE_MEET_READ_SCOPE], transporterOptions: { timeout: 20_000, retry: false } });
  return async () => {
    try {
      const { token } = await auth.getAccessToken();
      if (typeof token !== "string" || !token || /[\r\n]/.test(token)) throw new Error();
      return token;
    } catch { throw new GoogleMeetError("delegated-authentication-unavailable"); }
  };
}
export interface GoogleMeetReadReceipt { pages: number; request_ids: string[]; digest: string }
export interface GoogleMeetList { items: Record<string, unknown>[]; receipt: GoogleMeetReadReceipt }
export type GoogleMeetFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const instant = (value: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new GoogleMeetError("invalid-time-bound");
  return new Date(value).toISOString();
};

/** Read-only, fixed-host Meet transport. Provider text and OAuth material never enter error messages. */
export class GoogleMeetClient {
  readonly #token: () => Promise<string>; readonly #fetch: GoogleMeetFetch;
  readonly #sleep: (ms: number) => Promise<void>; readonly #maxPages: number; readonly #maxItems: number;
  constructor(args: { token: () => Promise<string>; fetcher?: GoogleMeetFetch; sleep?: (ms: number) => Promise<void>; maxPages?: number; maxItems?: number }) {
    this.#token = args.token; this.#fetch = args.fetcher ?? fetch; this.#sleep = args.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.#maxPages = args.maxPages ?? 100; this.#maxItems = args.maxItems ?? 10_000;
    if (!Number.isSafeInteger(this.#maxPages) || this.#maxPages < 1 || this.#maxPages > 1000
      || !Number.isSafeInteger(this.#maxItems) || this.#maxItems < 1 || this.#maxItems > 100_000) throw new GoogleMeetError("invalid-read-bound");
  }
  async #read(path: string, parameters: Record<string, string>): Promise<{ data: Record<string, unknown>; requestId?: string }> {
    const url = new URL(`/v2/${path}`, ORIGIN);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = await this.#token(); if (!token || /[\r\n]/.test(token)) throw new GoogleMeetError("invalid-token");
      let response: Response;
      try { response = await this.#fetch(url, { method: "GET", headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30_000) }); }
      catch { throw new GoogleMeetError("transport-unavailable"); }
      if (!response.ok) {
        const retry = response.headers.get("retry-after");
        const delay = retry !== null && /^\d+$/.test(retry) ? Number(retry) : null;
        await response.body?.cancel();
        if ((response.status === 429 || response.status >= 500) && attempt < 2 && (delay === null || delay <= 5)) {
          await this.#sleep((delay ?? attempt + 1) * 1000); continue;
        }
        throw new GoogleMeetError(response.status === 429 ? "rate-limited" : "provider-rejected", response.status, delay);
      }
      const reader = response.body?.getReader(); if (!reader) throw new GoogleMeetError("empty-response");
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.length; if (size > 2_000_000) { await reader.cancel(); throw new GoogleMeetError("response-size-exceeded"); }
          chunks.push(next.value);
        }
      } catch (error) { if (error instanceof GoogleMeetError) throw error; throw new GoogleMeetError("response-interrupted"); }
      let data: unknown; try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new GoogleMeetError("invalid-json"); }
      if (!object(data) || data.error !== undefined) throw new GoogleMeetError("invalid-envelope");
      const requestId = response.headers.get("x-goog-request-id");
      return { data, ...(requestId && requestId.length <= 256 && !/[\x00-\x1f]/.test(requestId) ? { requestId } : {}) };
    }
    throw new GoogleMeetError("retry-bound-exceeded");
  }
  async #list(path: string, field: string, itemPattern: RegExp, parameters: Record<string, string> = {}): Promise<GoogleMeetList> {
    const items = new Map<string, Record<string, unknown>>(), cursors = new Set<string>(), requestIds = new Set<string>();
    let cursor: string | undefined, pages = 0;
    do {
      if (pages >= this.#maxPages) throw new GoogleMeetError("page-bound-exceeded");
      const result = await this.#read(path, { ...parameters, pageSize: "100", ...(cursor ? { pageToken: cursor } : {}) }); pages++;
      if (result.requestId) requestIds.add(result.requestId);
      if (Object.keys(result.data).some(key => ![field, "nextPageToken"].includes(key))) throw new GoogleMeetError("unexpected-list-envelope");
      const rows = result.data[field] === undefined ? [] : result.data[field];
      if (!Array.isArray(rows) || rows.length > 100) throw new GoogleMeetError("invalid-list");
      for (const row of rows) {
        if (!object(row) || typeof row.name !== "string" || !itemPattern.test(row.name)) throw new GoogleMeetError("resource-scope-mismatch");
        const prior = items.get(row.name); if (prior && sha256(prior) !== sha256(row)) throw new GoogleMeetError("conflicting-resource-version");
        items.set(row.name, row); if (items.size > this.#maxItems) throw new GoogleMeetError("item-bound-exceeded");
      }
      const next = result.data.nextPageToken;
      if (next !== undefined && (typeof next !== "string" || next.length > 32768)) throw new GoogleMeetError("invalid-page-token");
      cursor = typeof next === "string" && next ? next : undefined;
      if (cursor && cursors.has(cursor)) throw new GoogleMeetError("repeated-page-token");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const values = [...items.values()];
    return { items: values, receipt: { pages, request_ids: [...requestIds].sort(), digest: sha256(values) } };
  }
  conferences(bounds: { startAt?: string; endAt?: string } = {}): Promise<GoogleMeetList> {
    const start = bounds.startAt === undefined ? undefined : instant(bounds.startAt), end = bounds.endAt === undefined ? undefined : instant(bounds.endAt);
    if (start && end && start >= end) throw new GoogleMeetError("inverted-time-bounds");
    const filter = [start && `start_time>="${start}"`, end && `start_time<"${end}"`].filter(Boolean).join(" AND ");
    return this.#list("conferenceRecords", "conferenceRecords", conferencePattern, filter ? { filter } : {});
  }
  transcripts(conference: string): Promise<GoogleMeetList> {
    if (!conferencePattern.test(conference)) throw new GoogleMeetError("invalid-conference-resource");
    return this.#list(`${conference}/transcripts`, "transcripts", new RegExp(`^${conference}/transcripts/${id}$`));
  }
  participants(conference: string): Promise<GoogleMeetList> {
    if (!conferencePattern.test(conference)) throw new GoogleMeetError("invalid-conference-resource");
    return this.#list(`${conference}/participants`, "participants", new RegExp(`^${conference}/participants/${id}$`));
  }
  entries(transcript: string): Promise<GoogleMeetList> {
    if (!transcriptPattern.test(transcript)) throw new GoogleMeetError("invalid-transcript-resource");
    return this.#list(`${transcript}/entries`, "transcriptEntries", new RegExp(`^${transcript}/entries/${id}$`));
  }
}
