
Meeting content arrives from many sources: an AI notetaker (Granola and
Circleback are common examples), a phone voice memo, a video-call transcript
export, or a transcript the user pastes directly. Do NOT build per-vendor
pipelines or paraphrase this skill in ad-hoc instructions — normalize whatever
the source provides into the transcript record below, then run the shared
phases. Source-specific logic ends at normalization.

## The normalized transcript record

Before running the pipeline, reduce the input to this shape (mentally or as a
scratch file — it does not get written to the brain as-is):

```yaml
source: "<recorder name, or 'manual'>"
source_id: "<unique recording id from the source, if any>"
title: "Meeting Title"
date: YYYY-MM-DD
time: "HH:MM TZ"               # null if unknown
duration: "45m"                # null if unknown
attendees:                     # the SOURCE'S notion of who was there —
  - name: "..."                # may need correction during speaker resolution
    email: "..."               # only if the source provides it
    role: "..."                # only if known
transcript_segments:           # structured form when the source diarizes
  - speaker: "..."             # resolved name OR "UNKNOWN_N" if unresolved
    speaker_raw: "..."         # the source's raw speaker label, for traceability
    text: "..."
raw_transcript_text: "..."     # the complete transcript. NEVER truncate.
source_summary: "..."          # the recorder's AI summary if present — a CLAIM, not a FACT
source_url: "..."              # link back to the source platform, if any
```

**Invariants:**
- `raw_transcript_text` is complete and untruncated. Always.
- `attendees` is a claim by the source. People invited ≠ people present.
- `source_summary` is TWO lossy layers deep (speech-to-text, then AI
  summarization). Both layers confabulate. Verify before writing anything
  from it into the brain.

Retain the complete source transcript in Records and keep the original source reachable through the internal evidence page. The transcript is the canonical
evidence for every quote and claim check downstream.

### Phase 1: Normalize the input

Build the transcript record from whatever arrived. If the input is malformed
(empty transcript, summary-only payload with no transcript, in-progress
recording), STOP — do not create a meeting page from a summary alone. Surface
the problem to the user.

### Phase 2: Split detection — one recording is not always one meeting

A single recording is often several distinct meetings stitched together (a
recorder left running across back-to-back sessions). Detect this BEFORE page
creation, so each real meeting becomes its own page and dedupes/enriches
correctly.

**Split signals** (one is enough to investigate; two or more = split almost
certainly):
- **Roster shift** — a new person arrives mid-transcript (a greeting deep into
  the file), or the speaker set in the back half differs from the front
- **Topic hard-cut** with no continuity between the halves
- **Context reset** — "ok, next one", a fresh intro round, a restart phrase
- **The source's own title/agenda names multiple sessions**

**When a split is detected:**
1. Find the boundary segments — the exact points where roster/topic flips.
2. Partition the segments into N contiguous chunks, one per real meeting.
   Never drop or duplicate a segment; the union must equal the original, in order.
3. Run the remaining phases once per chunk → N separate meeting pages, each
   with its own corrected attendees, title, and time.
4. Cross-link the sibling pages ("same recording, session k of N") and note
   the shared `source_id` so dedup never re-merges them.

**Borderline judgment:** same people + one flowing conversation that wanders
topics = ONE meeting; don't over-split. The test is roster + hard context
break, not "the topic changed." If you genuinely cannot tell, surface the
boundary to the user rather than guessing.

### Phase 3: Dedup across recorders

Users increasingly run two recorders at once as a backup. Before creating a
page, check whether the same meeting already exists:
`recall "{title or attendee names}"`, then match by date ± 1 day +
attendee overlap ≥ 50% + similar title.

- If a page exists, MERGE into it instead of creating a duplicate: build from
  the RICHER transcript, retain both source/version references in Records and readable evidence links on the page.
- Source *priority* (which diarization to trust) is not source *completeness*
  (which transcript is fuller). One recorder may capture 20% of a session the
  other captured fully. Compare lengths; keep the fuller transcript as the
  grounding evidence.

### Phase 4: Speaker resolution — before writing the page

Recorders ship anonymous labels (`UNKNOWN_N`, `Participant 2`, `microphone`)
and sometimes confidently WRONG names. Resolve by evidence:

1. Start from the source's attendee list, corrected by any roster evidence the
   user can provide (an invite list, an event page, "it was just me and
   charlie-example").
2. **Never guess.** When uncertain, write `[Room]` or `UNKNOWN` and flag it.
   A wrong attribution is worse than no attribution.
3. Cross-reference the brain: `recall "{name}"` for each candidate;
   read their page before accepting an identification.
4. Assign each named speaker a confidence: `high` (roster-confirmed), `medium`
   (named unambiguously in the transcript), `low` (inferred from content —
   flag explicitly).
5. **Content-identity check:** for every named speaker who claims a
   role/company/product in their own words ("I founded X", "at my company Y
   we…"), verify the claim against that person's brain page. If the named
   person's established identity CONTRADICTS what the speaker says about
   themselves, the recorder substituted the wrong person — resolve by
   identity, not by name, and reattribute the whole track.
6. **Phantom-speaker check:** if the recorder reports MORE distinct speakers
   than the known attendee count, suspect over-splitting — one real voice
   diarized into two labels. Tells: two labels never address each other, or
   hand off mid-thought. Collapse phantoms into the real attendee.
7. **User ground truth overrides everything.** If the user states who was in
   the room, that beats the recorder's diarization AND the roster. Reattribute,
   fix the page, and never re-litigate a room the user has confirmed.
8. Speech-to-text garbles names constantly. Before creating a NEW person page
   from a transcript-only name, search the brain for plausible spelling
   variants of the surname; default assumption is that a near-miss IS the
   existing person with a mangled name. Update the existing page and record
   the variant as an alias rather than creating a duplicate.

