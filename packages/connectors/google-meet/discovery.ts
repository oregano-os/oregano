import { sha256 } from "../../runtime/canonical.ts";
import { GoogleMeetClient, GoogleMeetError, GOOGLE_MEET_READ_SCOPE, validateGoogleMeetIdentity, type GoogleMeetIdentity } from "./client.ts";

export interface GoogleMeetTranscriptCandidate {
  identity: string;
  metadata_version: string;
  conference: Record<string, unknown>;
  transcript: Record<string, unknown>;
  meeting_start_at: string;
  visible_to: string[];
}
const date = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));

/** Metadata-only discovery for one explicit delegated subject. No transcript entries, Docs or Directory reads. */
export async function discoverGoogleMeetTranscripts(args: {
  client: GoogleMeetClient; identity: GoogleMeetIdentity; now: string; startAt?: string; endAt?: string;
}) {
  validateGoogleMeetIdentity(args.identity);
  if (!date(args.now)) throw new GoogleMeetError("invalid-observation-time");
  const conferences = await args.client.conferences({ startAt: args.startAt, endAt: args.endAt });
  const candidates: GoogleMeetTranscriptCandidate[] = [], excluded: Array<{ identity: string; reason: string }> = [];
  let transcriptPages = 0;
  const requestIds = new Set(conferences.receipt.request_ids);
  for (const conference of conferences.items) {
    if (!date(conference.startTime) || (conference.endTime !== undefined && !date(conference.endTime))
      || (conference.expireTime !== undefined && !date(conference.expireTime))) throw new GoogleMeetError("invalid-conference-time");
    if (!conference.endTime) { excluded.push({ identity: String(conference.name), reason: "conference-in-progress" }); continue; }
    if (Date.parse(String(conference.endTime)) < Date.parse(conference.startTime)) throw new GoogleMeetError("inverted-conference-times");
    const transcripts = await args.client.transcripts(String(conference.name)); transcriptPages += transcripts.receipt.pages;
    for (const id of transcripts.receipt.request_ids) requestIds.add(id);
    for (const transcript of transcripts.items) {
      if (!["STATE_UNSPECIFIED", "STARTED", "ENDED", "FILE_GENERATED"].includes(String(transcript.state))) throw new GoogleMeetError("unknown-transcript-state");
      if (transcript.state !== "FILE_GENERATED") { excluded.push({ identity: String(transcript.name), reason: "transcript-not-generated" }); continue; }
      if (!date(transcript.startTime) || !date(transcript.endTime) || Date.parse(transcript.endTime) < Date.parse(transcript.startTime)) throw new GoogleMeetError("invalid-transcript-times");
      if (transcript.docsDestination !== undefined) {
        const destination = transcript.docsDestination as Record<string, unknown>;
        if (!destination || typeof destination !== "object" || Array.isArray(destination)
          || (destination.exportUri !== undefined && (typeof destination.exportUri !== "string"
            || !/^https:\/\/docs\.google\.com\/document\//.test(destination.exportUri)))) throw new GoogleMeetError("invalid-document-reference");
      }
      candidates.push({ identity: String(transcript.name), metadata_version: sha256({ conference, transcript }), conference, transcript,
        meeting_start_at: new Date(conference.startTime).toISOString(), visible_to: [args.identity.subject] });
      if (candidates.length > 20_000) throw new GoogleMeetError("discovery-bound-exceeded");
    }
  }
  candidates.sort((a, b) => b.meeting_start_at.localeCompare(a.meeting_start_at) || a.identity.localeCompare(b.identity));
  const facts = { observed_at: args.now, authentication_mode: "service-account-delegation", credentials_retained: false,
    project_id: args.identity.projectId, service_account_email: args.identity.serviceAccountEmail, client_id: args.identity.clientId,
    delegated_subject: args.identity.subject, scopes: [GOOGLE_MEET_READ_SCOPE],
    selection: { start_at: args.startAt ?? null, end_at: args.endAt ?? null },
    conference_pages: conferences.receipt.pages, transcript_pages: transcriptPages, conferences: conferences.items.length,
    finished_transcripts: candidates.length, excluded_count: excluded.length, candidate_digest: sha256(candidates),
    request_ids: [...requestIds].sort(), complete_for_subject_available_inventory: true, transcript_text_read: false,
    historical_coverage: "provider-retained-resources-only" };
  return { candidates, excluded, qualification: { kind: "google-meet-source-discovery", phase: "complete",
    evidence: { discovery: { ...facts, discovery_hash: sha256(facts) } } } };
}
