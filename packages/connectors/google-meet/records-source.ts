import { sha256 } from "../../runtime/canonical.ts";
import { canonicalRecordInstant, compareRecordInstants, recordInstant } from "../../records/instant.ts";
import type { JsonValue } from "../../capabilities/contracts.ts";
import type { CompanyRecordSourceDeclaration } from "../../records/contracts.ts";
import type { CompanyRecordSourceBinding, RecordSourceConnector, RecordSourceInventory } from "../../records/source-connector.ts";
import { recordSourceBindingDigest } from "../../records/source-connector.ts";
import { GoogleMeetClient, GoogleMeetError, GOOGLE_MEET_READ_SCOPE, createGoogleMeetTokenProvider, validateGoogleMeetIdentity, type GoogleMeetIdentity, type GoogleMeetFetch } from "./client.ts";
import type { discoverGoogleMeetTranscripts } from "./discovery.ts";

export const GOOGLE_MEET_RECORD_SOURCE_ID = "oregano/google-meet-record-source";
export const GOOGLE_MEET_RECORD_SOURCE_VERSION = "0.1.0";
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));
interface Selection { authentication_mode: "service-account-dwd"; identity: GoogleMeetIdentity; transcript_names: string[] }
function selection(raw: unknown): Selection {
  const value = raw as Selection;
  if (!value || Object.keys(value).some(key => !["authentication_mode", "identity", "transcript_names"].includes(key)) || value.authentication_mode !== "service-account-dwd" || !value.identity
    || Object.keys(value.identity).sort().join(",") !== "clientId,projectId,serviceAccountEmail,subject") throw new GoogleMeetError("invalid-source-selection");
  validateGoogleMeetIdentity(value.identity);
  if (!Array.isArray(value.transcript_names) || !value.transcript_names.length || value.transcript_names.length > 1000
    || value.transcript_names.some(name => typeof name !== "string" || !/^conferenceRecords\/[A-Za-z0-9_-]{1,256}\/transcripts\/[A-Za-z0-9_-]{1,256}$/.test(name))
    || new Set(value.transcript_names).size !== value.transcript_names.length) throw new GoogleMeetError("invalid-transcript-selection");
  return { authentication_mode: "service-account-dwd", identity: { ...value.identity }, transcript_names: [...value.transcript_names].sort() };
}

/** Freeze an exact subset of a successful metadata discovery; this is qualification, not import admission. */
export function qualifyGoogleMeetRecordSource(discovery: Awaited<ReturnType<typeof discoverGoogleMeetTranscripts>>, names: string[]) {
  const { discovery_hash, ...facts } = discovery.qualification.evidence.discovery;
  if (discovery.qualification.kind !== "google-meet-source-discovery" || discovery.qualification.phase !== "complete"
    || sha256(facts) !== discovery_hash || sha256(discovery.candidates) !== facts.candidate_digest
    || facts.credentials_retained !== false || facts.complete_for_subject_available_inventory !== true
    || facts.scopes.length !== 1 || facts.scopes[0] !== GOOGLE_MEET_READ_SCOPE) throw new GoogleMeetError("invalid-discovery-proof");
  const selected = selection({ authentication_mode: "service-account-dwd", identity: { projectId: facts.project_id, serviceAccountEmail: facts.service_account_email, clientId: facts.client_id, subject: facts.delegated_subject }, transcript_names: names });
  for (const name of selected.transcript_names) if (!discovery.candidates.some(candidate => candidate.identity === name
    && candidate.transcript.state === "FILE_GENERATED" && candidate.visible_to.includes(selected.identity.subject))) throw new GoogleMeetError("unqualified-transcript-selection");
  const proof = { selection: selected, observed_at: facts.observed_at, discovery_hash, scopes: [GOOGLE_MEET_READ_SCOPE], credentials_retained: false, transcript_text_read: false };
  return { kind: "google-meet-record-source-qualification", phase: "complete", evidence: { ...proof, digest: sha256(proof) } };
}
function configured(args: { source: CompanyRecordSourceDeclaration; binding: CompanyRecordSourceBinding; qualification: Record<string, unknown> }): Selection {
  if (args.binding.connector !== GOOGLE_MEET_RECORD_SOURCE_ID || args.binding.connector_version !== GOOGLE_MEET_RECORD_SOURCE_VERSION
    || args.source.id !== args.binding.source_id || args.source.resource_binding !== args.binding.resource_binding) throw new GoogleMeetError("source-binding-mismatch");
  const config = selection(args.binding.configuration);
  const q = args.qualification as unknown as ReturnType<typeof qualifyGoogleMeetRecordSource>;
  if (q?.kind !== "google-meet-record-source-qualification" || q.phase !== "complete" || !q.evidence) throw new GoogleMeetError("missing-source-qualification");
  const { digest, ...facts } = q.evidence;
  if (digest !== sha256(facts) || digest !== args.binding.qualification.digest || sha256(config) !== sha256(facts.selection)
    || facts.credentials_retained !== false || facts.scopes.length !== 1 || facts.scopes[0] !== GOOGLE_MEET_READ_SCOPE) throw new GoogleMeetError("source-qualification-mismatch");
  return config;
}
function checkTime(value: unknown): string {
  try { recordInstant(value, "Meet source time"); return String(value); } catch { throw new GoogleMeetError("invalid-source-time"); }
}

/** Provider integration behind the maintained Record Source lifecycle, never a Company Tool. */
export class GoogleMeetRecordSourceConnector implements RecordSourceConnector {
  readonly id = GOOGLE_MEET_RECORD_SOURCE_ID; readonly version = GOOGLE_MEET_RECORD_SOURCE_VERSION;
  readonly #secret: (ref: string) => string | Promise<string>; readonly #fetch?: GoogleMeetFetch; readonly #now: () => Date;
  readonly #client?: (identity: GoogleMeetIdentity, secret: string) => GoogleMeetClient;
  constructor(args: { resolveSecret: (ref: string) => string | Promise<string>; fetcher?: GoogleMeetFetch; now?: () => Date;
    /** Injected only by provider-boundary contract tests. */
    client?: (identity: GoogleMeetIdentity, secret: string) => GoogleMeetClient }) {
    this.#secret = args.resolveSecret; this.#fetch = args.fetcher; this.#now = args.now ?? (() => new Date()); this.#client = args.client;
  }
  validateBinding(args: { source: CompanyRecordSourceDeclaration; binding: CompanyRecordSourceBinding; qualification: Record<string, unknown> }): void { configured(args); }
  async readCompleteInventory(args: { source: CompanyRecordSourceDeclaration; binding: CompanyRecordSourceBinding; qualification: Record<string, unknown> }): Promise<RecordSourceInventory> {
    const config = configured(args), start = this.#now().toISOString();
    const secret = await this.#secret(args.binding.secret_ref);
    const client = this.#client?.(config.identity, secret) ?? new GoogleMeetClient({ token: createGoogleMeetTokenProvider(secret, config.identity), fetcher: this.#fetch });
    const objects: Record<string, JsonValue>[] = [], conferences = new Map<string, { conference: Record<string, unknown>; participants: Record<string, unknown>[] }>();
    let entryPages = 0, participantPages = 0;
    for (const name of config.transcript_names) {
      const conferenceName = name.split("/").slice(0, 2).join("/");
      if (!conferences.has(conferenceName)) {
        const conference = await client.conference(conferenceName), participants = await client.participants(conferenceName);
        checkTime(conference.startTime); checkTime(conference.endTime); checkTime(conference.expireTime);
        if (compareRecordInstants(String(conference.endTime), String(conference.startTime)) < 0) throw new GoogleMeetError("inverted-source-times");
        participantPages += participants.receipt.pages; conferences.set(conferenceName, { conference, participants: participants.items.sort((a, b) => String(a.name).localeCompare(String(b.name))) });
      }
      const { conference, participants } = conferences.get(conferenceName)!;
      const before = await client.transcript(name);
      if (before.state !== "FILE_GENERATED") throw new GoogleMeetError("transcript-not-generated");
      checkTime(before.startTime); checkTime(before.endTime);
      if (compareRecordInstants(String(before.endTime), String(before.startTime)) < 0) throw new GoogleMeetError("inverted-source-times");
      const list = await client.entries(name); entryPages += list.receipt.pages;
      const after = await client.transcript(name);
      if (sha256(before) !== sha256(after)) throw new GoogleMeetError("transcript-changed-during-read");
      if (!list.items.length) throw new GoogleMeetError("finished-transcript-has-no-entries");
      const entries = list.items.map(entry => {
        checkTime(entry.startTime); checkTime(entry.endTime);
        if (compareRecordInstants(String(entry.endTime), String(entry.startTime)) < 0
          || typeof entry.participant !== "string" || !new RegExp(`^${conferenceName}/participants/[A-Za-z0-9_-]{1,256}$`).test(entry.participant)
          || typeof entry.text !== "string" || typeof entry.languageCode !== "string") throw new GoogleMeetError("invalid-transcript-entry");
        return entry;
      }).sort((a, b) => compareRecordInstants(String(a.startTime), String(b.startTime)) || String(a.name).localeCompare(String(b.name)));
      const text = entries.map(entry => {
        const participant = participants.find(p => p.name === entry.participant);
        const user = (participant?.signedinUser ?? participant?.anonymousUser ?? participant?.phoneUser) as Record<string, unknown> | undefined;
        const label = typeof user?.displayName === "string" && user.displayName.trim() ? user.displayName : String(entry.participant);
        return `[${entry.startTime}] ${label}: ${entry.text}`;
      }).join("\n");
      if (!entries.some(entry => String(entry.text).trim())) throw new GoogleMeetError("finished-transcript-has-no-text");
      const destination = before.docsDestination as Record<string, unknown> | undefined;
      const sourceUrl = typeof destination?.exportUri === "string" && /^https:\/\/docs\.google\.com\/document\//.test(destination.exportUri)
        ? destination.exportUri : `https://meet.googleapis.com/v2/${name}`;
      // Receipt time, delegated reader and selection changes must not create a different content version.
      const payload = { conference, transcript: before, entries, participants };
      objects.push({ identity: name, version: sha256(payload), kind: "meeting", original_url: sourceUrl,
        occurred_at: canonicalRecordInstant(String(conference.startTime)), text, complete: true,
        provider: "google-meet", conference_name: conferenceName, transcript_name: name,
        source_context: json({ provider: "google-meet", conference, transcript: before, participants }),
        provider_payload: json(payload) });
    }
    const digest = sha256(objects);
    return { complete: true, scan_started_at: start, observed_at: this.#now().toISOString(), objects,
      watermark: `google-meet:${digest}`, binding_digest: recordSourceBindingDigest(args.binding, args.qualification),
      receipt: { connector: this.id, connector_version: this.version, delegated_subject: config.identity.subject,
        source_selection_digest: sha256(config), inventory_digest: digest, selected_transcripts: config.transcript_names.length,
        transcripts: objects.length, entry_pages: entryPages, participant_pages: participantPages,
        complete: true, scope: "exact-qualified-transcript-selection", credentials_retained: false } };
  }
}
